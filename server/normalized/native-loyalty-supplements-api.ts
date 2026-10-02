import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import {CustomerExperienceService,type StaffCustomerExperienceContext} from './customer-experience-service.js'
import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import type {CustomerCommandService} from './customer-repository.js'
import type {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import {nativeGuardedExecutor} from './native-guarded-executor.js'
import {IdempotencyConflictError,IdempotencyInProgressError,NativeCommandNotCommittedError,type NormalizedCommandExecutor} from './command-executor.js'
type Options={transactions:Pick<ScopedPostgresTransactionRunner,'run'>;commands:Pick<NormalizedCommandExecutor,'execute'>;customers:Pick<CustomerCommandService,'updateProfile'>;resolveContext:(request:FastifyRequest)=>StaffCustomerExperienceContext|Promise<StaffCustomerExperienceContext>}
export const nativeLoyaltySupplementsApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_req,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'LOYALTY_SUPPLEMENT_FORBIDDEN',message:'当前岗位没有此项积分复核权限'}})
  if(error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.original instanceof CustomerExperienceRequestError?error.original.message:'原订单或补发状态已变化，本次未提交，请刷新核对',commitDisposition:'not_committed'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'LOYALTY_SUPPLEMENT_REQUEST_CONFLICT',message:'原请求正在处理或内容不一致，请恢复原请求'}})
  if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'LOYALTY_SUPPLEMENT_INVALID',message:'请核对原订单或补发申请及实际依据'}})
  throw error
 })
 async function context(request:FastifyRequest,permission:string){const ctx=await options.resolveContext(request);await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission),{readOnly:true});return ctx}
 app.get('/staff/native-loyalty-supplements',async request=>{
  const ctx=await context(request,'loyalty.accrual.exception.view'),q=z.object({section:z.enum(['reconciliation','requests']).default('reconciliation'),page:z.coerce.number().int().min(0).max(10000).default(0)}).strict().parse(request.query)
  const service=new CustomerExperienceService(options.transactions,options.commands,options.customers),pagination={offset:q.page*100,limit:101}
  const rows=q.section==='reconciliation'?await service.loyaltyReconciliation(ctx,pagination):await service.loyaltySupplementRequests(ctx,pagination)
  return{data:{items:rows.slice(0,100),hasMore:rows.length>100,page:q.page,section:q.section,employeeId:ctx.employeeId,durableCommands:true,protocol:1}}
 })
 app.post<{Params:{action:string}}>('/staff/native-loyalty-supplements/commands/:action',{bodyLimit:4096},async request=>{
  const action=z.enum(['request','approve','reject']).parse(request.params.action),permission=action==='request'?'loyalty.accrual.request':'loyalty.accrual.approve',ctx=await context(request,permission)
  const input=z.object({publicId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,127}$/),reason:z.string().trim().min(2).max(500)}).strict().parse(request.body)
  const key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key'])
  const commands=nativeGuardedExecutor(options.commands,{fingerprint:{employeeId:ctx.employeeId,action,input},authorize:async tx=>{const current=await options.resolveContext(request);if(current.employeeId!==ctx.employeeId||current.scope.tenantId!==ctx.scope.tenantId||current.scope.storeId!==ctx.scope.storeId)throw new StaffAccessDeniedError('员工已变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)}})
  const service=new CustomerExperienceService(options.transactions,commands,options.customers)
  const result=action==='request'?await service.requestLoyaltySupplement(ctx,{orderPublicId:input.publicId,reason:input.reason,idempotencyKey:key}):await service.decideLoyaltySupplement(ctx,{publicId:input.publicId,decision:action,reason:input.reason,idempotencyKey:key})
  return{data:{action,employeeId:ctx.employeeId,requestKey:key,sourcePublicId:input.publicId,result:result.value},meta:{protocol:1,replayed:result.replayed}}
 })
}
