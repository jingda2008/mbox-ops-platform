import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import {SocialAccountRepository,socialAccountInputSchema} from './social-account-repository.js'
import {SocialBroadcastRepository,broadcastSchema} from './social-broadcast-repository.js'
import {BottleCustodyError} from './bottle-custody-policy.js'
import type {ActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {StaffAccessRepository,StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonObject} from './command-executor.js'
import {nativePhysicalExecutor} from './native-physical-command.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'
type Options={transactions:ScopedPostgresTransactionRunner;commands:Pick<NormalizedCommandExecutor,'execute'>;protection:ActivityContactProtectionKeyring;resolveContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext}
const root='/staff/native-social',uuid=z.string().uuid(),version=z.string().regex(/^[a-f0-9]{64}$/),reason=z.string().trim().min(2).max(500)
const schemas={account:socialAccountInputSchema.extend({expectedVersion:version.nullable(),reason}),retry:z.object({id:uuid,expectedVersion:version,reason}).strict(),broadcast:broadcastSchema.extend({reason}),transition:z.object({id:uuid,expectedVersion:version,action:z.enum(['schedule','cancel']),audienceConfirmed:z.boolean(),reason}).strict()}
const sql={accounts:`SELECT id,kind,name,app_id AS "appId",enabled,code_template_id AS "codeTemplateId",code_data_key AS "codeDataKey",reminder_template_id AS "reminderTemplateId",reminder_data_key AS "reminderDataKey",updated_at::text AS "updatedAt" FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 AND ($3::uuid IS NULL OR id>$3) AND ($4::uuid IS NULL OR id=$4) ORDER BY id LIMIT 51`,events:`SELECT e.id,e.account_id AS "accountId",a.name AS "accountName",e.event_type AS "eventType",e.status,e.error_code AS "errorCode",e.received_at::text AS "receivedAt" FROM mbox.social_callback_events e JOIN mbox.social_accounts a ON a.tenant_id=e.tenant_id AND a.store_id=e.store_id AND a.id=e.account_id WHERE e.tenant_id=$1 AND e.store_id=$2 AND ($3::uuid IS NULL OR e.id>$3) AND ($4::uuid IS NULL OR e.id=$4) ORDER BY e.id LIMIT 51`,broadcasts:`SELECT b.id,b.account_id AS "accountId",a.name AS "accountName",b.title,b.content,b.scheduled_at::text AS "scheduledAt",b.status,b.provider_reference AS "providerReference",b.error_code AS "errorCode",b.created_by_employee_id AS "createdByEmployeeId",b.created_at::text AS "createdAt" FROM mbox.social_broadcasts b JOIN mbox.social_accounts a ON a.tenant_id=b.tenant_id AND a.store_id=b.store_id AND a.id=b.account_id WHERE b.tenant_id=$1 AND b.store_id=$2 AND ($3::uuid IS NULL OR b.id>$3) AND ($4::uuid IS NULL OR b.id=$4) ORDER BY b.id LIMIT 51`}
const json=(v:unknown)=>JSON.parse(JSON.stringify(v)) as JsonObject
async function rows(tx:ScopedTransaction,area:keyof typeof sql,cursor:string|null=null,only:string|null=null){const result=await tx.query<Record<string,unknown>>(sql[area],[tx.scope.tenantId,tx.scope.storeId,cursor,only]);const records=result.rows.slice(0,50).map(r=>({...r,nativeVersion:createHash('sha256').update(JSON.stringify(r)).digest('hex')}));return{rows:records,next:result.rows.length>50?String(result.rows[49]!.id):null}}
export const nativeSocialOperationsApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((e,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(e))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(e instanceof StaffAccessDeniedError||e instanceof StaffNotFoundError)return reply.code(403).send({error:{code:'SOCIAL_FORBIDDEN',message:'当前员工无此微信运营权限'}})
  if(e instanceof NativeCommandNotCommittedError&&!(e.original instanceof IdempotencyConflictError))return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:e.original instanceof BottleCustodyError?e.original.message:'账号或任务已变化，请刷新核对',commitDisposition:'not_committed'}})
  if(e instanceof z.ZodError||e instanceof BottleCustodyError)return reply.code(400).send({error:{code:'SOCIAL_INVALID',message:e instanceof BottleCustodyError?e.message:'请核对账号、完整密钥、任务内容及时间'}})
  if(e instanceof NativeCommandNotCommittedError||e instanceof IdempotencyConflictError||e instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'SOCIAL_UNCONFIRMED',message:'请保留原请求核对结果'}})
  throw e
 })
 app.get(root,async request=>{const q=z.object({area:z.enum(['accounts','events','broadcasts']),cursor:uuid.optional()}).strict().parse(request.query),ctx=await options.resolveContext(request);return{data:await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,q.area==='broadcasts'?'community.activity.manage':'member.card.manage');return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,area:q.area,...await rows(tx,q.area,q.cursor??null)}},{readOnly:true,isolation:'repeatable-read'})}})
 app.get(root+'/account-options',async request=>{const q=z.object({cursor:uuid.optional(),search:z.string().trim().max(80).default('')}).strict().parse(request.query),ctx=await options.resolveContext(request);return{data:await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'community.activity.manage');const r=(await tx.query<{id:string;name:string;enabled:boolean}>("SELECT id,name,enabled FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 AND kind='service_account' AND ($3::uuid IS NULL OR id>$3) AND name ILIKE $4 ORDER BY id LIMIT 51",[ctx.scope.tenantId,ctx.scope.storeId,q.cursor??null,'%'+q.search.replace(/[\\%_]/g,'\\$&')+'%'])).rows;return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,rows:r.slice(0,50),next:r.length>50?r[49]!.id:null}},{readOnly:true})}})
 for(const action of Object.keys(schemas) as Array<keyof typeof schemas>)app.post(root+'/'+action,{bodyLimit:16384},async request=>{
  const b=schemas[action].parse(request.body),ctx=await options.resolveContext(request),permission=action==='account'||action==='retry'?'member.card.manage':'community.activity.manage',key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key']);uuid.parse(key.slice(16))
  const executor=nativePhysicalExecutor(options.commands,ctx,async tx=>{const c=await options.resolveContext(request);if(c.employeeId!==ctx.employeeId||c.scope.tenantId!==ctx.scope.tenantId||c.scope.storeId!==ctx.scope.storeId)throw new StaffAccessDeniedError('身份变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)})
  const r=await executor.execute<JsonObject>({scope:ctx.scope,operationScope:'social.operations.'+action,idempotencyKey:key,retainReceipt:true,requestFingerprint:createHash('sha256').update(JSON.stringify({employeeId:ctx.employeeId,b})).digest('hex'),resultCodec:{encode:v=>v,decode:v=>v as JsonObject}},async tx=>{
   const area=action==='account'?'accounts':action==='retry'?'events':'broadcasts';let id:string;const accepted={...json(b)};delete accepted.credentials
   if(action==='account'){
    const {expectedVersion,reason:_reason,...input}=schemas.account.parse(b)
    if(input.id){await tx.query('SELECT id FROM mbox.social_accounts WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId,input.id]);if((await rows(tx,'accounts',null,input.id)).rows[0]?.nativeVersion!==expectedVersion)throw new BottleCustodyError('原账号已修改，请重新读取')}
    else if(expectedVersion!==null)throw new BottleCustodyError('新账号不应携带旧版本')
    id=(await new SocialAccountRepository(tx,options.protection).save(input,ctx.employeeId)).id;accepted.credentialsChanged=!!input.credentials
   }else if(action==='broadcast'){const {reason:_reason,...input}=schemas.broadcast.parse(b);id=(await new SocialBroadcastRepository(tx).create(input,ctx.employeeId)).id}
   else{
    const input=action==='retry'?schemas.retry.parse(b):schemas.transition.parse(b);id=input.id;await tx.query(`SELECT id FROM mbox.${action==='retry'?'social_callback_events':'social_broadcasts'} WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[ctx.scope.tenantId,ctx.scope.storeId,id]);if((await rows(tx,area,null,id)).rows[0]?.nativeVersion!==input.expectedVersion)throw new BottleCustodyError('原任务状态已变化，请刷新核对')
    if(action==='retry'){const result=await tx.query("UPDATE mbox.social_callback_events SET status='pending',error_code=NULL WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='failed' RETURNING id",[ctx.scope.tenantId,ctx.scope.storeId,id]);if(!result.rows.length)throw new BottleCustodyError('只有失败回调事件可以重新处理')}
    else{const input=schemas.transition.parse(b);if(input.action==='schedule'&&!input.audienceConfirmed)throw new BottleCustodyError('请明确确认发送内容与全部关注者范围');await new SocialBroadcastRepository(tx).transition(id,input.action)}
   }
   const row=(await rows(tx,area,null,id)).rows[0];if(!row)throw new BottleCustodyError('无法读取原提交凭证')
   return{result:json({employeeId:ctx.employeeId,requestKey:key,action,accepted,row}),auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:'social.native.'+action,objectType:action==='account'?'social_account':action==='retry'?'social_callback_event':'social_broadcast',objectId:id,reason:b.reason,afterData:action==='account'?{credentialsChanged:accepted.credentialsChanged===true}:accepted}],outboxMessages:[]}
  });return{data:r.value,meta:{protocol:1,replayed:r.replayed}}
 })
}
