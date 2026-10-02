import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import {nativeContactRows} from './native-contact-governance-query.js'
import {PersonalContactGovernanceService,PersonalContactGovernanceError} from './personal-contact-governance-service.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {StaffAccessRepository,StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,NormalizedCommandExecutor,type JsonObject} from './command-executor.js'
import {nativePhysicalExecutor} from './native-physical-command.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import type {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'
type Options={transactions:ScopedPostgresTransactionRunner;protection:ActivityContactProtectionKeyring;resolveContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext}
const root='/staff/native-contact-governance',kind=z.enum(['activity_registration_contact','verified_membership_phone']),reason=z.string().trim().min(2).max(500),basis=z.string().trim().min(3).max(500),version=z.string().regex(/^[a-f0-9]{64}$/),policy=z.string().regex(/^PCR[0-9A-F]{32}$/),hold=z.string().regex(/^PCH[0-9A-F]{32}$/)
const schemas={draft:z.object({resourceKind:kind,retentionDaysAfterPurposeEnd:z.number().int().min(0).max(36500),legalBasisReference:basis,reason}).strict(),approve:z.object({publicId:policy,expectedVersion:version,reason}).strict(),publish:z.object({publicId:policy,expectedVersion:version,effectiveFrom:z.string().datetime({offset:true}),reason}).strict(),hold:z.object({resourceKind:kind,resourcePublicId:z.string().min(3).max(64),expectedVersion:version,legalBasisReference:basis,reason,holdUntil:z.string().datetime({offset:true}).nullable()}).strict(),release:z.object({publicId:hold,expectedVersion:version,reason}).strict()}
const json=(v:unknown)=>JSON.parse(JSON.stringify(v)) as JsonObject
export const nativeContactGovernanceApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((e,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(e))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(e instanceof StaffAccessDeniedError||e instanceof StaffNotFoundError)return reply.code(403).send({error:{code:'CONTACT_GOVERNANCE_FORBIDDEN',message:'当前员工无此联系方式治理权限'}})
  if(e instanceof NativeCommandNotCommittedError&&!(e.original instanceof IdempotencyConflictError))return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:e.original instanceof PersonalContactGovernanceError?e.original.message:'状态、审批分工或保留依据不满足条件，请刷新核对',commitDisposition:'not_committed'}})
  if(e instanceof z.ZodError||e instanceof PersonalContactGovernanceError)return reply.code(400).send({error:{code:'CONTACT_GOVERNANCE_INVALID',message:e instanceof PersonalContactGovernanceError?e.message:'请核对保留对象、依据、期限和操作原因'}})
  if(e instanceof NativeCommandNotCommittedError||e instanceof IdempotencyConflictError||e instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'CONTACT_GOVERNANCE_UNCONFIRMED',message:'请保留原请求核对结果'}})
  throw e
 })
 app.get(root,async request=>{const q=z.object({area:z.enum(['policies','holds','dispositions','resources']),cursor:z.string().min(3).max(64).optional(),search:z.string().trim().max(80).default('')}).strict().parse(request.query),ctx=await options.resolveContext(request);return{data:await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'privacy.contact.retention.view');if(q.area==='resources')await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'privacy.contact.legal_hold');return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,area:q.area,...await nativeContactRows(tx,q.area,q.cursor??null,null,q.search)}},{readOnly:true})}})
 // Keep the original service's SERIALIZABLE policy transitions inside the same
 // transaction as the durable native receipt. No reveal/decryption is run here.
 const commands=new NormalizedCommandExecutor({run:(scope,fn)=>options.transactions.run(scope,fn,{isolation:'serializable',retryOnConflict:2})})
 for(const action of Object.keys(schemas) as Array<keyof typeof schemas>)app.post(root+'/'+action,{bodyLimit:8192},async request=>{
  const b=schemas[action].parse(request.body),ctx=await options.resolveContext(request),permission=action==='hold'||action==='release'?'privacy.contact.legal_hold':'privacy.contact.retention.'+action,key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key']);z.string().uuid().parse(key.slice(16))
  const executor=nativePhysicalExecutor(commands,ctx,async tx=>{const c=await options.resolveContext(request);if(c.employeeId!==ctx.employeeId||c.scope.storeId!==ctx.scope.storeId||c.scope.tenantId!==ctx.scope.tenantId)throw new StaffAccessDeniedError('身份变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)})
  const r=await executor.execute<JsonObject>({scope:ctx.scope,operationScope:'contact.governance.'+action,idempotencyKey:key,retainReceipt:true,requestFingerprint:createHash('sha256').update(JSON.stringify({employeeId:ctx.employeeId,b})).digest('hex'),resultCodec:{encode:v=>v,decode:v=>v as JsonObject}},async tx=>{
   const service=new PersonalContactGovernanceService({run:async(_scope,fn)=>fn(tx)},options.protection)
   if(action!=='draft'){const area=action==='hold'?'resources':action==='release'?'holds':'policies',id='resourcePublicId'in b?b.resourcePublicId:'publicId'in b?b.publicId:'';const before=(await nativeContactRows(tx,area,null,id)).rows[0];if(!before||before.nativeVersion!==('expectedVersion'in b?b.expectedVersion:''))throw new PersonalContactGovernanceError('原保留对象或策略已变化，请重新核对','NATIVE_CONTACT_STALE');if(action==='hold'&&before.resourceKind!==('resourceKind'in b?b.resourceKind:''))throw new PersonalContactGovernanceError('保留对象类型不符','NATIVE_CONTACT_WRONG_KIND')}
   let id:string
   if(action==='draft')id=String((await service.draftPolicy(ctx,schemas.draft.parse(b))).publicId)
   else if(action==='approve')id=String((await service.approvePolicy(ctx,schemas.approve.parse(b))).publicId)
   else if(action==='publish')id=String((await service.publishPolicy(ctx,schemas.publish.parse(b))).publicId)
   else if(action==='hold')id=(await service.createLegalHold(ctx,schemas.hold.parse(b))).publicId
   else id=(await service.releaseLegalHold(ctx,schemas.release.parse(b))).publicId
   const row=(await nativeContactRows(tx,action==='hold'||action==='release'?'holds':'policies',null,id)).rows[0];if(!row)throw new PersonalContactGovernanceError('无法读取提交后的保留凭证','NATIVE_CONTACT_RESULT_MISSING')
   return{result:json({employeeId:ctx.employeeId,requestKey:key,action,accepted:b,row}),auditEvents:[],outboxMessages:[]}
  });return{data:r.value,meta:{protocol:1,replayed:r.replayed}}
 })
}
