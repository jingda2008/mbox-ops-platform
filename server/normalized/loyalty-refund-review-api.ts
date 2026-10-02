import {z} from 'zod'
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify'
import type {LoyaltyRefundReviewRequestInput,LoyaltyRefundReviewDecisionInput} from '../../src/shared/loyalty-refund-review.js'
import {IdempotencyConflictError} from './command-executor.js'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'
import {LoyaltyRefundReviewError,LoyaltyRefundReviewService} from './loyalty-refund-review-service.js'
import {NormalizedAuthenticationRequiredError,NormalizedStoreUnavailableError,TrustedStoreScopeError} from './normalized-request-context.js'
import {StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {StaffSessionNotFoundError} from './staff-session-repository.js'
import type {ScopedPostgresTransactionRunner} from './transaction-runner.js'

export function registerLoyaltyRefundReviewRoutes(app:FastifyInstance,options:{
  transactions:Pick<ScopedPostgresTransactionRunner,'run'>
  resolveStaffContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext
}){
  const service=new LoyaltyRefundReviewService(options.transactions)

  // Native transport reuses permanent domain receipts and independent review.
  app.get('/staff/native-loyalty-refunds',async(request,reply)=>handle(reply,async()=>{
    const ctx=await options.resolveStaffContext(request)
    const query=z.object({page:z.coerce.number().int().min(0).max(10000).default(0)}).strict().parse(request.query)
    const rows=await service.list(ctx,{offset:query.page*100,limit:101})
    reply.header('Cache-Control','private, no-store')
    return reply.send({data:{items:rows.slice(0,100),page:query.page,hasMore:rows.length>100,employeeId:ctx.employeeId,protocol:1,durableCommands:true}})
  }))
  const allocation=z.object({orderItemId:z.string().uuid(),salesRefundAmountMinor:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict()
  const requestSchema=z.object({refundId:z.string().uuid(),basisVersion:z.string().regex(/^[a-f0-9]{64}$/),allocations:z.array(allocation).max(1000),historicalAllocations:z.array(z.object({refundId:z.string().uuid(),allocations:z.array(allocation).max(1000)}).strict()).max(1000).default([]),reason:z.string().trim().min(3).max(1000)}).strict()
  const decisionSchema=z.object({requestId:z.string().uuid(),basisVersion:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['approve','reject']),reason:z.string().trim().min(3).max(1000)}).strict()
  app.post<{Params:{action:string}}>('/staff/native-loyalty-refunds/commands/:action',{bodyLimit:262144},async(request,reply)=>handle(reply,async()=>{
    const ctx=await options.resolveStaffContext(request),action=z.enum(['request','decision']).parse(request.params.action)
    const commandKey=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(key(request))
    const result=action==='request'?await(async()=>{const input=requestSchema.parse(request.body);return service.request(ctx,input.refundId,input,commandKey)})():await(async()=>{const input=decisionSchema.parse(request.body);return service.decide(ctx,input.requestId,input,commandKey)})()
    return reply.send({data:{action,employeeId:ctx.employeeId,requestKey:commandKey,result:result.value},meta:{protocol:1,replayed:result.replayed}})
  }))

  app.get('/staff/loyalty/refund-reviews',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveStaffContext(request)
    const data=await service.list(context)
    reply.header('cache-control','private, no-store')
    return reply.send({data,meta:{scopeKey:`${context.scope.tenantId}:${context.scope.storeId}`}})
  }))
  app.post<{Params:{refundId:string}}>('/staff/loyalty/refund-reviews/:refundId/requests',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveStaffContext(request)
    const body=objectBody(request.body,['basisVersion','allocations','historicalAllocations','reason'])
    const result=await service.request(context,request.params.refundId,body as unknown as LoyaltyRefundReviewRequestInput,key(request))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{requestId:string}}>('/staff/loyalty/refund-review-requests/:requestId/decisions',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveStaffContext(request)
    const body=objectBody(request.body,['basisVersion','decision','reason'])
    const result=await service.decide(context,request.params.requestId,body as unknown as LoyaltyRefundReviewDecisionInput,key(request))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
}
function objectBody(value:unknown,allowed:string[]):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new LoyaltyRefundReviewError('LOYALTY_REVIEW_INVALID','请提交原退款商品归属及核对依据')
  return value as Record<string,unknown>
}
function key(request:FastifyRequest){const value=request.headers['idempotency-key'];return typeof value==='string'?value:''}
async function handle(reply:FastifyReply,action:()=>Promise<unknown>){
  try{return await action()}catch(error){
    // A known business rejection is emitted only after the transaction runner
    // has rolled back. Conflicts/auth/network errors cannot disprove an earlier commit.
    if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'LOYALTY_REVIEW_INVALID',message:'请核对原退款、金额及处理依据'}})
    if(error instanceof LoyaltyRefundReviewError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message,...(error.commitDisposition?{commitDisposition:error.commitDisposition}:{})}})
    if(error instanceof IdempotencyConflictError)return reply.code(409).send({error:{code:'IDEMPOTENCY_CONFLICT',message:'原请求编号已经绑定另一份内容，请先恢复原请求'}})
    if(error instanceof NormalizedAuthenticationRequiredError||error instanceof StaffSessionNotFoundError)return reply.code(401).send({error:{code:'AUTHENTICATION_REQUIRED',message:'请重新登录后恢复原请求'}})
    if(error instanceof StaffAccessDeniedError||error instanceof StaffNotFoundError||error instanceof TrustedStoreScopeError||error instanceof NormalizedStoreUnavailableError)return reply.code(403).send({error:{code:'PERMISSION_DENIED',message:'当前身份没有此门店的财务积分复核权限'}})
    console.error('LOYALTY_REFUND_REVIEW_FAILED',error instanceof Error?error.stack:error)
    return reply.code(500).send({error:{code:'LOYALTY_REFUND_REVIEW_FAILED',message:'商品归属复核结果暂未确认，请保留原请求并重试'}})
  }
}
