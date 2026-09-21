import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify'
import type {OrderFinancialRecoveryDecisionInput,OrderFinancialRecoveryRequestInput} from '../../src/shared/order-financial-recovery.js'
import {IdempotencyConflictError} from './command-executor.js'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'
import {NormalizedAuthenticationRequiredError,NormalizedStoreUnavailableError,TrustedStoreScopeError} from './normalized-request-context.js'
import {StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {StaffSessionNotFoundError} from './staff-session-repository.js'
import type {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {OrderFinancialRecoveryError,OrderFinancialRecoveryService} from './order-financial-recovery-service.js'

export function registerOrderFinancialRecoveryRoutes(app:FastifyInstance,options:{transactions:Pick<ScopedPostgresTransactionRunner,'run'>;resolveStaffContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext}){
  const service=new OrderFinancialRecoveryService(options.transactions)
  app.get<{Querystring:{orderPublicId?:string;after?:string}}>('/staff/order-financial-recovery',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveStaffContext(request)
    const data=await service.list(context,request.query)
    reply.header('cache-control','private, no-store')
    return reply.send({data,meta:{scopeKey:`${context.scope.tenantId}:${context.scope.storeId}`}})
  }))
  app.post<{Params:{orderId:string}}>('/staff/order-financial-recovery/:orderId/requests',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveStaffContext(request),body=objectBody(request.body,['basisVersion','dimensions','reason'])
    const result=await service.request(context,request.params.orderId,body as unknown as OrderFinancialRecoveryRequestInput,key(request))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
  app.post<{Params:{requestId:string}}>('/staff/order-financial-recovery-requests/:requestId/decisions',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveStaffContext(request),body=objectBody(request.body,['basisVersion','decision','reason'])
    const result=await service.decide(context,request.params.requestId,body as unknown as OrderFinancialRecoveryDecisionInput,key(request))
    return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }))
}
function objectBody(value:unknown,allowed:string[]):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new OrderFinancialRecoveryError('ORDER_RECOVERY_INVALID','只提交原订单预览版本、恢复范围与核对依据；金额由系统计算')
  return value as Record<string,unknown>
}
function key(request:FastifyRequest){const value=request.headers['idempotency-key'];return typeof value==='string'?value:''}
async function handle(reply:FastifyReply,action:()=>Promise<unknown>){
  try{return await action()}catch(error){
    if(error instanceof OrderFinancialRecoveryError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message,...(error.commitDisposition?{commitDisposition:error.commitDisposition}:{})}})
    if(error instanceof IdempotencyConflictError)return reply.code(409).send({error:{code:'IDEMPOTENCY_CONFLICT',message:'原凭据已绑定另一操作，请保留并恢复原请求'}})
    if(error instanceof NormalizedAuthenticationRequiredError||error instanceof StaffSessionNotFoundError)return reply.code(401).send({error:{code:'AUTHENTICATION_REQUIRED',message:'请重新登录后恢复原操作'}})
    if(error instanceof StaffAccessDeniedError||error instanceof StaffNotFoundError||error instanceof TrustedStoreScopeError||error instanceof NormalizedStoreUnavailableError)return reply.code(403).send({error:{code:'PERMISSION_DENIED',message:'当前身份没有此门店的财务权益恢复权限'}})
    console.error('ORDER_FINANCIAL_RECOVERY_FAILED',error instanceof Error?error.stack:error)
    return reply.code(500).send({error:{code:'ORDER_FINANCIAL_RECOVERY_FAILED',message:'原恢复操作结果尚未确认，请保留原凭据后重试'}})
  }
}
