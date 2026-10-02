import {createHash,createHmac} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import {StaffAccessManagementService,readOverview} from './staff-access-management-service.js'
import {changeArray} from './staff-access-management-api.js'
import {StaffAccessRepository,StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {lockStaffAccessConfiguration,StaffAccessVersionConflictError} from './staff-access-version.js'
import {nativeGuardedExecutor} from './native-guarded-executor.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor} from './command-executor.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import type {StaffAuthCommandService} from './staff-auth-command-service.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction,StoreScope} from './transaction-runner.js'
const version=z.string().regex(/^[a-f0-9]{64}$/),reason=z.string().trim().min(2).max(200),uuid=z.string().uuid()
const base={expectedVersion:version,reason}
const schemas={
 create:z.object({...base,employeeCode:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),displayName:z.string().trim().min(1).max(64),pin:z.string().regex(/^\d{4}$/),roleId:uuid}).strict(),
 status:z.object({...base,employeeId:uuid,status:z.enum(['active','suspended'])}).strict(),
 pin:z.object({...base,employeeId:uuid,pin:z.string().regex(/^\d{4}$/)}).strict(),
 credential:z.object({...base,credentialVersion:version,credential:z.string().min(6).max(128),validFrom:z.iso.datetime({offset:true}),validUntil:z.iso.datetime({offset:true})}).strict(),
 deploy:z.object({...base,changes:z.array(z.unknown()).min(1).max(100)}).strict(),
}
type Context={scope:StoreScope;employeeId:string;businessDate:string}
type Options={fingerprintSecret:string;transactions:ScopedPostgresTransactionRunner;commands:Pick<NormalizedCommandExecutor,'execute'>;resolveStaffContext(request:FastifyRequest):Promise<Context>|Context;authFactory(commands:Pick<NormalizedCommandExecutor,'execute'>):Pick<StaffAuthCommandService,'setEmployeePin'|'configureDailyStoreCredential'>}
async function credentialState(tx:ScopedTransaction){
 const rows=(await tx.query(`SELECT id,business_date::text AS "businessDate",valid_from::text AS "validFrom",valid_until::text AS "validUntil",reusable_across_business_dates AS reusable FROM mbox.store_daily_credentials WHERE tenant_id=$1 AND store_id=$2 AND revoked_at IS NULL ORDER BY business_date,id`,[tx.scope.tenantId,tx.scope.storeId])).rows
 return{credentials:rows,credentialVersion:createHash('sha256').update(JSON.stringify(rows)).digest('hex')}
}
export const nativeStaffAdministrationApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 if(options.fingerprintSecret.length<32)throw new Error('Native credential fingerprint key must contain at least 32 characters')
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError||error instanceof StaffNotFoundError)return reply.code(403).send({error:{code:'STAFF_ADMIN_FORBIDDEN',message:'当前员工没有人员与权限配置权'}})
  if(error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.original instanceof TypeError||error.original instanceof StaffAccessVersionConflictError?error.original.message:'人员或配置已变化，本次未提交，请刷新核对',commitDisposition:'not_committed'}})
  if(error instanceof StaffAccessVersionConflictError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.message,commitDisposition:'not_committed'}})
  if(error instanceof z.ZodError||error instanceof TypeError)return reply.code(400).send({error:{code:'STAFF_ADMIN_INVALID',message:error instanceof TypeError?error.message:'请核对员工、岗位、原版本和必填字段'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'STAFF_ADMIN_CONFLICT',message:'原请求尚在处理或内容已变化，请保留原请求核对'}})
  throw error
 })
 app.get('/staff/native-administration',async request=>{
  const ctx=await options.resolveStaffContext(request)
  const data=await options.transactions.run(ctx.scope,async tx=>{
   await lockStaffAccessConfiguration(tx);await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'staff.access.configure')
   return{employeeId:ctx.employeeId,businessDate:ctx.businessDate,protocol:1,durableCommands:true,overview:await readOverview(tx),...await credentialState(tx)}
  });return{data}
 })
 app.post<{Params:{action:string}}>('/staff/native-administration/:action',{bodyLimit:64000},async request=>{
  const action=z.enum(['create','status','pin','credential','deploy']).parse(request.params.action),input=schemas[action].parse(request.body),key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key'])
  const ctx=await options.resolveStaffContext(request)
  // Bind low-entropy secrets with a server-keyed MAC; never store a raw PIN or unkeyed PIN digest.
  const {pin:_pin,credential:_credential,...publicInput}=input as typeof input&{pin?:string;credential?:string}
  const fingerprint={action,employeeId:ctx.employeeId,input:publicInput,secretConfigured:action==='pin'||action==='create'||action==='credential',...((_pin??_credential)===undefined?{}:{secretBinding:createHmac('sha256',options.fingerprintSecret).update(JSON.stringify(['native-staff-secret-v1',ctx.scope,ctx.employeeId,action,key,_pin??_credential])).digest('hex')})}
  const guarded=nativeGuardedExecutor(options.commands,{fingerprint,authorize:async tx=>{await lockStaffAccessConfiguration(tx);await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'staff.access.configure')},guard:async tx=>{
   if((await readOverview(tx)).configurationVersion!==input.expectedVersion)throw new StaffAccessVersionConflictError()
   if(action==='credential'){const v=schemas.credential.parse(input);if((await credentialState(tx)).credentialVersion!==v.credentialVersion)throw new StaffAccessVersionConflictError();if(Date.parse(v.validUntil)<=Date.now()||Date.parse(v.validUntil)<=Date.parse(v.validFrom))throw new TypeError('口令结束时间须晚于生效时间与当前时间')}
  }})
  const service=new StaffAccessManagementService(options.transactions,guarded),metadata={scope:ctx.scope,actorEmployeeId:ctx.employeeId,businessDate:ctx.businessDate,idempotencyKey:key,requestFingerprint:JSON.stringify(fingerprint),reason:input.reason}
  const outcome=await(async()=>{
   if(action==='create'){const v=schemas.create.parse(input);return service.createEmployee({...metadata,...v})}
   if(action==='status'){const v=schemas.status.parse(input);return service.setEmployeeStatus({...metadata,...v})}
   if(action==='pin'){const v=schemas.pin.parse(input);const result=await options.authFactory(guarded).setEmployeePin({...metadata,...v,revokeSessions:true});return{...result.value,replayed:result.replayed}}
   if(action==='credential'){const v=schemas.credential.parse(input);const result=await options.authFactory(guarded).configureDailyStoreCredential({...metadata,...v});return{...result.value,replayed:result.replayed}}
   const v=schemas.deploy.parse(input);let changes;try{changes=changeArray(v.changes)}catch{throw new TypeError('权限修改内容无效，请使用原配置目录重新填写')}
   // This original service has its own permanent receipt table, including cross-cache recovery.
   return new StaffAccessManagementService(options.transactions,options.commands).deployPermissions({...metadata,expectedVersion:v.expectedVersion,changes})
  })()
  return{data:{employeeId:ctx.employeeId,requestKey:key,action,result:outcome},meta:{protocol:1,replayed:outcome.replayed}}
 })
}
