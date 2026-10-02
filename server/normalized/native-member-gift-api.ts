import {CheckoutCouponRefundReviewRepository} from './checkout-coupon-refund-review-repository.js'
import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import {MemberGiftCampaignRepository} from './member-gift-campaign-repository.js'
import {MemberGiftCampaignError} from './member-gift-campaign-policy.js'
import {MemberCardPolicyError} from './member-card-policy.js'
import {CouponCalendarError} from './coupon-calendar.js'
import {StackingPricingError} from './stacking-pricing.js'
import {StaffAccessRepository,StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonObject} from './command-executor.js'
import {nativePhysicalExecutor} from './native-physical-command.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'
type Options={transactions:ScopedPostgresTransactionRunner;commands:Pick<NormalizedCommandExecutor,'execute'>;resolveContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext}
const root='/staff/native-member-gifts',reason=z.string().trim().min(2).max(500),uuid=z.string().uuid(),version=z.string().regex(/^[a-f0-9]{64}$/)
const save=z.object({code:z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),name:z.string().trim().min(2).max(120),rule:z.record(z.string(),z.unknown()),expectedVersion:z.number().int().min(0).max(2147483646),reason}).strict()
const decision=z.object({versionId:uuid,expectedVersion:version,action:z.enum(['approve','publish','stop']),reason}).strict()
const target=z.object({versionId:uuid,expectedVersion:version,customerIds:z.array(uuid).min(1).max(50).refine(v=>new Set(v).size===v.length),cycleKey:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/),reason}).strict()
const control=z.object({jobId:uuid,expectedVersion:version,action:z.enum(['retry','cancel']),reason}).strict()
const refund=z.object({refundId:uuid,reservationId:uuid,expectedVersion:version,action:z.enum(['no_return','external_compensation','replacement_coupon']),reason,evidenceReference:z.string().trim().min(2).max(200),replacementBenefitId:uuid.optional()}).strict()
const refundVersion=(r:Record<string,unknown>)=>hash([r.refund_id,r.reservation_id,r.refund_amount_minor,r.currency,r.benefit_code,r.quantity,r.status,r.action,r.reason,r.evidence_reference,r.replacement_benefit_id,r.replacement_quantity])
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as JsonObject
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const campaignVersion=(r:Record<string,unknown>)=>hash([r.id,r.version,r.status,r.rule])
const jobVersion=(r:Record<string,unknown>)=>hash([r.id,r.status,r.attempts,r.next_attempt_at,r.last_error_code,r.benefit_id,r.dessert_benefit_id,r.completed_at])
async function lock(tx:ScopedTransaction,code:string){const r=await tx.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`member-gift:${tx.scope.tenantId}:${tx.scope.storeId}:${code}`]);if(!r.rows[0]?.locked)throw new MemberGiftCampaignError('活动正在处理，请刷新后再操作')}
export const nativeMemberGiftApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_r,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_r,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError||error instanceof StaffNotFoundError)return reply.code(403).send({error:{code:'GIFT_FORBIDDEN',message:'当前员工无此赠礼权限'}})
  const domain=(e:unknown)=>e instanceof MemberGiftCampaignError||e instanceof MemberCardPolicyError||e instanceof CouponCalendarError||e instanceof StackingPricingError
  if(error instanceof NativeCommandNotCommittedError&&!(error.original instanceof IdempotencyConflictError))return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:domain(error.original)?(error.original as Error).message:'活动或任务已变化，请刷新核对',commitDisposition:'not_committed'}})
  if(error instanceof z.ZodError||domain(error))return reply.code(400).send({error:{code:'GIFT_INVALID',message:domain(error)?error.message:'请核对活动、预算及客户选择'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError||error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'GIFT_UNCONFIRMED',message:'原请求尚未确认，请保留原请求核对'}})
  throw error
 })
 for(const state of ['pending','resolved']as const)app.get(root+'/refund-'+state,async request=>{
  const q=z.object({cursor:z.string().max(80).optional()}).strict().parse(request.query),ctx=await options.resolveContext(request)
  const data=await options.transactions.run(ctx.scope,async tx=>{const result=await new CheckoutCouponRefundReviewRepository(tx).list(ctx.employeeId,state,q.cursor??null);return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,rows:result.items.map(r=>({...r,id:r.refund_id+':'+r.reservation_id,nativeVersion:refundVersion(r)})),next:result.nextCursor}},{readOnly:true,isolation:'repeatable-read'});return{data}
 })
 app.get(root+'/refund-options',async request=>{
  const q=z.object({refundId:uuid,reservationId:uuid,cursor:uuid.optional()}).strict().parse(request.query),ctx=await options.resolveContext(request);const data=await options.transactions.run(ctx.scope,async tx=>{const result=await new CheckoutCouponRefundReviewRepository(tx).replacementOptions(ctx.employeeId,q.refundId,q.reservationId,q.cursor??null);return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,rows:result.items,next:result.nextCursor}},{readOnly:true,isolation:'repeatable-read'});return{data}
 })
 for(const kind of ['campaigns','jobs','options'] as const)app.get(root+'/'+kind,async request=>{
  const q=z.object({cursor:uuid.optional(),kind:z.enum(['products','projects','audience-cards','calendars','stacking','customers']).optional(),search:z.string().trim().max(80).default('')}).strict().parse(request.query),ctx=await options.resolveContext(request)
  const data=await options.transactions.run(ctx.scope,async tx=>{const access=await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'loyalty.configuration.view'),repo=new MemberGiftCampaignRepository(tx);const result=kind==='options'?await repo.options(ctx.employeeId,q.kind??'',q.search,q.cursor??null):kind==='jobs'?await repo.jobs(ctx.employeeId,q.cursor??null):await repo.list(ctx.employeeId,q.cursor??null);return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,permissions:access.permissions.filter(p=>p.startsWith('loyalty.')),next:result.nextCursor,rows:result.items.map(row=>kind==='options'?row:{...row,nativeVersion:kind==='jobs'?jobVersion(row):campaignVersion(row)})}},{readOnly:true,isolation:'repeatable-read'});return{data}
 })
 for(const action of ['save','decision','target','control','refund'] as const)app.post(root+'/'+action,{bodyLimit:65536},async request=>{
  const ctx=await options.resolveContext(request),b=({save,decision,target,control,refund}[action]).parse(request.body),permission=action==='save'?'loyalty.configuration.edit':action==='decision'&&'action'in b&&b.action==='approve'?'loyalty.configuration.approve':'loyalty.policy.publish',key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key']);uuid.parse(key.slice(16))
  const executor=nativePhysicalExecutor(options.commands,ctx,async tx=>{const current=await options.resolveContext(request);if(current.employeeId!==ctx.employeeId||current.scope.storeId!==ctx.scope.storeId||current.scope.tenantId!==ctx.scope.tenantId)throw new StaffAccessDeniedError('身份变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)})
  const result=await executor.execute<JsonObject>({scope:ctx.scope,operationScope:'member.gift.native.'+action,idempotencyKey:key,retainReceipt:true,requestFingerprint:hash({employeeId:ctx.employeeId,b}),resultCodec:{encode:v=>v,decode:v=>v as JsonObject}},async tx=>{
   const repo=new MemberGiftCampaignRepository(tx),scope=[ctx.scope.tenantId,ctx.scope.storeId],common={employeeId:ctx.employeeId,businessDate:ctx.businessDate};let row:unknown
   if(action==='refund'){
    const body=refund.parse(b),locked=await tx.query<{ok:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok',[`coupon-refund:${scope.join(':')}:${body.refundId}:${body.reservationId}`]);if(!locked.rows[0]?.ok)throw new MemberGiftCampaignError('原权益正在复核，请刷新')
    const reviews=new CheckoutCouponRefundReviewRepository(tx),before=await reviews.nativeSnapshot(body.refundId,body.reservationId);if(!before||before.action!==null||refundVersion(before)!==body.expectedVersion)throw new MemberGiftCampaignError('原退款或权益状态已变化，请刷新核对')
    await reviews.decide({...body,...common});row=await reviews.nativeSnapshot(body.refundId,body.reservationId)
   }else if(action==='save'){
    const body=save.parse(b);await lock(tx,body.code);const previous=(await tx.query<{version:number}>('SELECT version FROM mbox.member_gift_campaign_versions WHERE tenant_id=$1 AND store_id=$2 AND code=$3 ORDER BY version DESC LIMIT 1',[...scope,body.code])).rows[0]?.version??0;if(previous!==body.expectedVersion)throw new MemberGiftCampaignError('已有更新的活动版本，请重新读取后修订')
    const made=await repo.create({...body,...common,requestKey:key});row=await repo.find(made.versionId)
   }else if(action==='control'){
    const body=control.parse(b),found=(await tx.query<{campaign_code:string}>('SELECT campaign_code FROM mbox.member_gift_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,body.jobId])).rows[0];if(!found)throw new MemberGiftCampaignError('任务不存在');await lock(tx,found.campaign_code)
    const job=(await tx.query<Record<string,unknown>>('SELECT id,status,attempts,next_attempt_at::text,last_error_code,benefit_id,dessert_benefit_id,completed_at::text FROM mbox.member_gift_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...scope,body.jobId])).rows[0];if(!job||jobVersion(job)!==body.expectedVersion)throw new MemberGiftCampaignError('发券任务已被处理，请刷新核对');row=await repo.controlJob({...body,...common})
   }else{
    const body=action==='decision'?decision.parse(b):target.parse(b)
    // Match worker ordering: identity movement guard, campaign, then job.
    if(action==='target'){const guard=await tx.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS locked',[`table-customer-movement:${scope.join(':')}`]);if(!guard.rows[0]?.locked)throw new MemberGiftCampaignError('会员身份正在同步，请稍后重试')}
    const original=await repo.find(body.versionId);await lock(tx,original.code);const current=await repo.find(body.versionId);if(campaignVersion(current)!==body.expectedVersion)throw new MemberGiftCampaignError('活动状态已变化，请重新核对')
    if(action==='decision'){await repo.decide({...decision.parse(b),...common});row=await repo.find(body.versionId)}else row=await repo.target({...target.parse(b),...common})
   }
   return{result:json({employeeId:ctx.employeeId,requestKey:key,action,accepted:b,row}),auditEvents:[],outboxMessages:[]}
  });return{data:result.value,meta:{protocol:1,replayed:result.replayed}}
 })
}
