import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import {MarketingContactRepository} from './marketing-contact-repository.js'
import {MarketingDeliveryRepository} from './marketing-delivery-repository.js'
import {MarketingContactError,parseMarketingNotice,marketingChannels,marketingPurposes} from './marketing-contact-policy.js'
import {StaffAccessRepository,StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonObject} from './command-executor.js'
import {nativePhysicalExecutor} from './native-physical-command.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'
type Options={transactions:ScopedPostgresTransactionRunner;commands:Pick<NormalizedCommandExecutor,'execute'>;resolveContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext}
const root='/staff/native-marketing',uuid=z.string().uuid(),version=z.string().regex(/^[a-f0-9]{64}$/),reason=z.string().trim().min(2).max(500)
const schemas={
 save:z.object({code:z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),expectedVersion:z.number().int().min(0).max(2147483646),rule:z.record(z.string(),z.unknown()),reason}).strict(),
 decision:z.object({noticeId:uuid,expectedVersion:version,decision:z.enum(['approve','publish','stop']),reason}).strict(),
 refusal:z.object({customerId:uuid,reason}).strict(),
 queue:z.object({customerId:uuid,noticeId:uuid,expectedVersion:version,channel:z.enum(marketingChannels),purpose:z.enum(marketingPurposes),campaignKey:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/),content:z.string().trim().min(2).max(2000),expiresAt:z.string().datetime({offset:true})}).strict(),
 cancel:z.object({jobId:uuid,expectedVersion:version,reason}).strict()
}
const json=(v:unknown)=>JSON.parse(JSON.stringify(v)) as JsonObject
function stamped(v:unknown){const row=json(v);return{...row,nativeVersion:createHash('sha256').update(JSON.stringify(row)).digest('hex')}}
async function notice(tx:ScopedTransaction,id:string){const n=await new MarketingContactRepository(tx).find(id);return stamped({id:n.id,code:n.code,version:n.version,status:n.status,rule:n.rule,createdByEmployeeId:n.created_by_employee_id,reason:n.reason,createdAt:n.created_at,decisions:[...n.decisions].sort((a,b)=>a.action.localeCompare(b.action))})}
async function job(tx:ScopedTransaction,id:string){const j=await new MarketingDeliveryRepository(tx).get(id);return stamped({id:j.id,customerId:j.customer_id,noticeId:j.notice_id,channel:j.channel,purpose:j.purpose,campaignKey:j.campaign_key,content:j.content,status:j.status,blockedReason:j.blocked_reason??null,checks:j.checks,createdAt:j.created_at,expiresAt:j.expires_at,createdByEmployeeId:j.created_by_employee_id})}
async function noticeLock(tx:ScopedTransaction){const r=await tx.query<{ok:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok',[`marketing:${tx.scope.tenantId}:${tx.scope.storeId}:notices`]);if(!r.rows[0]?.ok)throw new MarketingContactError('告知正在修改，请刷新重试')}
export const nativeMarketingContactApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((e,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(e))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(e instanceof StaffAccessDeniedError||e instanceof StaffNotFoundError)return reply.code(403).send({error:{code:'MARKETING_FORBIDDEN',message:'当前员工无此营销联系权限'}})
  if(e instanceof NativeCommandNotCommittedError&&!(e.original instanceof IdempotencyConflictError))return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:e.original instanceof MarketingContactError?e.original.message:'记录或权限已变化，请刷新核对',commitDisposition:'not_committed'}})
  if(e instanceof z.ZodError||e instanceof MarketingContactError)return reply.code(400).send({error:{code:'MARKETING_INVALID',message:e instanceof MarketingContactError?e.message:'请核对完整告知、联系范围、客户和原因'}})
  if(e instanceof NativeCommandNotCommittedError||e instanceof IdempotencyConflictError||e instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'MARKETING_UNCONFIRMED',message:'请保留原请求核对结果'}})
  throw e
 })
 app.get(root+'/workspace',async request=>{const ctx=await options.resolveContext(request);return{data:await options.transactions.run(ctx.scope,async tx=>{let allowed=false;for(const permission of ['marketing.notice.view','marketing.send','marketing.refusal.record','marketing.consent.audit']){try{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission);allowed=true;break}catch(e){if(!(e instanceof StaffAccessDeniedError))throw e}}if(!allowed)throw new StaffAccessDeniedError('无营销权限');return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,rows:[],next:null}},{readOnly:true})}})
 app.get(root+'/notices',async request=>{
  const q=z.object({cursor:uuid.optional(),code:z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/).optional()}).strict().parse(request.query),ctx=await options.resolveContext(request)
  return{data:await options.transactions.run(ctx.scope,async tx=>{
   await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'marketing.notice.view');const scope=[ctx.scope.tenantId,ctx.scope.storeId]
   const ids=(await tx.query<{id:string}>(`SELECT id FROM mbox.marketing_notice_versions WHERE tenant_id=$1 AND store_id=$2 AND ($3::uuid IS NULL OR id>$3) AND ($4::text IS NULL OR code=$4) ORDER BY id LIMIT 21`,[...scope,q.cursor??null,q.code??null])).rows
   const rows=[];for(const r of ids.slice(0,20))rows.push(await notice(tx,r.id))
   const latest=q.code?Number((await tx.query<{n:number}>('SELECT COALESCE(max(version),0) n FROM mbox.marketing_notice_versions WHERE tenant_id=$1 AND store_id=$2 AND code=$3',[...scope,q.code])).rows[0]!.n):null
   return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,rows,next:ids.length>20?ids[19]!.id:null,code:q.code??null,latestVersion:latest}
  },{readOnly:true,isolation:'repeatable-read'})}
 })
 app.get(root+'/customers',async request=>{
  const q=z.object({purpose:z.enum(['send','refusal','audit']),search:z.string().trim().min(2).max(80),cursor:uuid.optional()}).strict().parse(request.query),ctx=await options.resolveContext(request),permission=q.purpose==='send'?'marketing.send':q.purpose==='refusal'?'marketing.refusal.record':'marketing.consent.audit'
  return{data:await options.transactions.run(ctx.scope,async tx=>{const r=await new MarketingContactRepository(tx).customers(ctx.employeeId,permission,q.search,q.cursor??null);return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,rows:r.items,next:r.nextCursor}},{readOnly:true})}
 })
 app.post(root+'/history',{bodyLimit:4096},async request=>{
  const b=z.object({customerId:uuid,reason,cursor:z.string().regex(/^[1-9][0-9]{0,18}$/).nullable().optional()}).strict().parse(request.body),ctx=await options.resolveContext(request)
  return{data:await options.transactions.run(ctx.scope,async tx=>{const r=await new MarketingContactRepository(tx).consentHistory({...b,employeeId:ctx.employeeId,businessDate:ctx.businessDate});return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,customerId:r.customerId,rows:r.items,next:r.nextCursor}})}
 })
 app.get(root+'/jobs',async request=>{
  const q=z.object({cursor:uuid.optional()}).strict().parse(request.query),ctx=await options.resolveContext(request)
  return{data:await options.transactions.run(ctx.scope,async tx=>{const r=await new MarketingDeliveryRepository(tx).list(ctx.employeeId,q.cursor??null);const rows=[];for(const item of r.items){rows.push({...await job(tx,String(item.id)),customerRef:item.customer_ref})};return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,rows,next:r.nextCursor}},{readOnly:true,isolation:'repeatable-read'})}
 })
 for(const action of Object.keys(schemas) as Array<keyof typeof schemas>)app.post(root+'/'+action,{bodyLimit:32768},async request=>{
  const ctx=await options.resolveContext(request),b=schemas[action].parse(request.body),permission=action==='save'?'marketing.notice.edit':action==='decision'&&'decision'in b?(b.decision==='approve'?'marketing.notice.approve':'marketing.notice.publish'):action==='refusal'?'marketing.refusal.record':'marketing.send',key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key']);uuid.parse(key.slice(16))
  const executor=nativePhysicalExecutor(options.commands,ctx,async tx=>{const c=await options.resolveContext(request);if(c.employeeId!==ctx.employeeId||c.scope.tenantId!==ctx.scope.tenantId||c.scope.storeId!==ctx.scope.storeId)throw new StaffAccessDeniedError('身份已变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)})
  const result=await executor.execute<JsonObject>({scope:ctx.scope,operationScope:'marketing.native.'+action,idempotencyKey:key,retainReceipt:true,requestFingerprint:createHash('sha256').update(JSON.stringify({employeeId:ctx.employeeId,b})).digest('hex'),resultCodec:{encode:v=>v,decode:v=>v as JsonObject}},async tx=>{
   const repo=new MarketingContactRepository(tx),delivery=new MarketingDeliveryRepository(tx),actor={employeeId:ctx.employeeId,businessDate:ctx.businessDate};let row:unknown
   if(action==='save'){const input=schemas.save.parse(b);parseMarketingNotice(input.rule);const r=await repo.save({...input,...actor,requestKey:key});row=await notice(tx,r.noticeId)}
   if(action==='decision'){const input=schemas.decision.parse(b);await noticeLock(tx);if((await notice(tx,input.noticeId)).nativeVersion!==input.expectedVersion)throw new MarketingContactError('告知已变化，请重新核对');await repo.decide({noticeId:input.noticeId,action:input.decision,reason:input.reason,...actor});row=await notice(tx,input.noticeId)}
   if(action==='refusal'){const input=schemas.refusal.parse(b);row=await repo.stopAll({...input,...actor});if((row as {customerId:string}).customerId!==input.customerId)throw new MarketingContactError('客户身份已合并，请重新选择，未记录本次拒绝')}
   if(action==='queue'){const input=schemas.queue.parse(b);await noticeLock(tx);if((await notice(tx,input.noticeId)).nativeVersion!==input.expectedVersion)throw new MarketingContactError('告知已变化，请重新核对');const r=await delivery.queue({...input,...actor});row=await job(tx,r.jobId);if((row as {customerId:string}).customerId!==input.customerId)throw new MarketingContactError('客户身份已合并，请重新选择，未排队')}
   if(action==='cancel'){const input=schemas.cancel.parse(b),before=await delivery.get(input.jobId);await repo.executionAuthority(before.customer_id,before.notice_id,before.channel,before.purpose);await tx.query('SELECT id FROM mbox.marketing_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId,input.jobId]);if((await job(tx,input.jobId)).nativeVersion!==input.expectedVersion)throw new MarketingContactError('任务状态已变化，不能撤回已交给渠道的任务');await delivery.cancel(input.jobId,ctx.employeeId,ctx.businessDate,input.reason);row=await job(tx,input.jobId)}
   return{result:json({employeeId:ctx.employeeId,requestKey:key,action,accepted:b,row}),auditEvents:[],outboxMessages:[]}
  });return{data:result.value,meta:{protocol:1,replayed:result.replayed}}
 })
}
