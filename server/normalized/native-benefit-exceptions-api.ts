import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import type {CustomerBenefitApiOptions} from './customer-benefit-api.js'
import {listComplimentaryFulfillmentExceptions} from './customer-benefit-api.js'
import {ComplimentaryFulfillmentResolutionService,ComplimentaryFulfillmentResolutionError} from './complimentary-fulfillment-resolution-service.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {assertEmployeeTableSessionAccess,EmployeeTableAccessDeniedError} from './employee-table-access.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import {nativeGuardedExecutor} from './native-guarded-executor.js'
import {IdempotencyConflictError,IdempotencyInProgressError,NativeCommandNotCommittedError,type NormalizedCommandExecutor,type JsonObject,type JsonCodec} from './command-executor.js'
type Options=Pick<CustomerBenefitApiOptions,'transactions'|'resolveStaffContext'>&{commands:Pick<NormalizedCommandExecutor,'execute'>}
const permission='loyalty.redemption.exception',codec:JsonCodec<JsonObject>={encode:v=>v,decode:v=>v as JsonObject}
const expected=z.object({orderId:z.string().uuid(),benefitId:z.string().uuid(),tableSessionId:z.string().uuid(),updatedAt:z.string().min(10).max(64),attemptCount:z.number().int().min(0)}).strict()
const schema=z.object({intentId:z.string().uuid(),expected,reason:z.string().trim().min(2).max(500),compensationReference:z.string().trim().min(2).max(200).nullable()}).strict()
export const nativeBenefitExceptionsApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_req,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError||error instanceof EmployeeTableAccessDeniedError)return reply.code(403).send({error:{code:'BENEFIT_EXCEPTION_FORBIDDEN',message:'没有此桌礼遇异常处理权限'}})
  if(error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.original instanceof TypeError?error.original.message:'礼遇状态已变化，本次未提交，请刷新核对',commitDisposition:'not_committed'}})
  if(error instanceof ComplimentaryFulfillmentResolutionError)return reply.code(409).send({error:{code:error.code,message:error.message,...(error.code.includes('IDEMPOTENCY')?{}:{commitDisposition:'not_committed'})}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'BENEFIT_EXCEPTION_REQUEST_CONFLICT',message:'原请求正在处理或内容不一致，请恢复原请求'}})
  if(error instanceof z.ZodError||error instanceof TypeError)return reply.code(400).send({error:{code:'BENEFIT_EXCEPTION_INVALID',message:error instanceof TypeError?error.message:'请核对原礼遇与实际处理依据'}})
  throw error
 })
 async function context(request:FastifyRequest){const ctx=await options.resolveStaffContext(request);await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission),{readOnly:true});return ctx}
 app.get('/staff/native-benefit-exceptions',async request=>{
  const ctx=await context(request),{page}=z.object({page:z.coerce.number().int().min(0).max(10000).default(0)}).strict().parse(request.query)
  const rows=await options.transactions.run(ctx.scope,tx=>listComplimentaryFulfillmentExceptions(tx,ctx.employeeId,{offset:page*100,limit:101}),{readOnly:true})
  return{data:{items:rows.slice(0,100),page,hasMore:rows.length>100,employeeId:ctx.employeeId,durableCommands:true,protocol:1}}
 })
 app.post<{Params:{action:string}}>('/staff/native-benefit-exceptions/commands/:action',{bodyLimit:8192},async request=>{
  const ctx=await context(request),action=z.enum(['retry','cancel_release','external_compensation']).parse(request.params.action),input=schema.parse(request.body),key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key'])
  if((action==='external_compensation')!==(input.compensationReference!==null))throw new TypeError('只有实际线下补偿结案需要原凭证')
  let result:JsonObject,replayed:boolean
  if(action==='retry'){
   const executor=nativeGuardedExecutor(options.commands,{fingerprint:{action,input,employeeId:ctx.employeeId},authorize:async tx=>{
    const current=await options.resolveStaffContext(request);if(current.employeeId!==ctx.employeeId||current.scope.tenantId!==ctx.scope.tenantId||current.scope.storeId!==ctx.scope.storeId)throw new StaffAccessDeniedError('账号变化')
    await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)
    await assertEmployeeTableSessionAccess(tx,{employeeId:ctx.employeeId,tableSessionId:input.expected.tableSessionId,allTablePermissionCodes:['table.view_all'],lockTableSession:true})
   }})
   const reply=await executor.execute({scope:ctx.scope,operationScope:'benefit.exception.retry',idempotencyKey:key,requestFingerprint:'',resultCodec:codec},async tx=>{
    const row=(await tx.query<{order_id:string;benefit_id:string;table_session_id:string;updated_at:string;attempt_count:number;status:string}>(`SELECT intent.order_id,intent.benefit_id,intent.updated_at::text,intent.attempt_count,intent.status,ordering.table_session_id FROM mbox.complimentary_fulfillment_intents intent JOIN mbox.orders ordering ON ordering.tenant_id=intent.tenant_id AND ordering.store_id=intent.store_id AND ordering.id=intent.order_id WHERE intent.tenant_id=$1 AND intent.store_id=$2 AND intent.id=$3 FOR UPDATE OF intent`,[ctx.scope.tenantId,ctx.scope.storeId,input.intentId])).rows[0]
    if(!row||row.order_id!==input.expected.orderId||row.benefit_id!==input.expected.benefitId||row.table_session_id!==input.expected.tableSessionId||row.updated_at!==input.expected.updatedAt||row.attempt_count!==input.expected.attemptCount||!['failed','retry'].includes(row.status))throw new TypeError('原礼遇已变化或不需要重试，请刷新核对')
    await tx.query("UPDATE mbox.complimentary_fulfillment_intents SET status='pending',attempt_count=0,next_attempt_at=clock_timestamp(),dispatched_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[ctx.scope.tenantId,ctx.scope.storeId,input.intentId])
    return{result:{intentId:input.intentId,orderId:row.order_id,benefitId:row.benefit_id,status:'pending'},auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:'loyalty.complimentary-fulfillment.manual-retry',objectType:'complimentary_fulfillment_intent',objectId:input.intentId,reason:input.reason,beforeData:{status:row.status,attemptCount:row.attempt_count},afterData:{status:'pending',attemptCount:0}}],outboxMessages:[{businessEventKey:`benefit-gift-fulfillment-manual-retry:${input.intentId}:${createHash('sha256').update(key).digest('hex').slice(0,32)}`,aggregateType:'order',aggregateId:row.order_id,aggregateVersion:2,eventType:'benefit.gift.fulfillment-manual-retry.v1',payload:{intentId:input.intentId,orderId:row.order_id,benefitId:row.benefit_id,employeeId:ctx.employeeId,reason:input.reason}}]}
   });result=reply.value;replayed=reply.replayed
  }else{
   const response=await new ComplimentaryFulfillmentResolutionService(options.transactions).resolve({scope:ctx.scope,employeeId:ctx.employeeId,businessDate:ctx.businessDate,intentId:input.intentId,action,reason:input.reason,compensationReference:input.compensationReference,idempotencyKey:key,nativeExpected:input.expected})
   result=JSON.parse(JSON.stringify(response));replayed=response.replayed
  }
  return{data:{action,employeeId:ctx.employeeId,requestKey:key,result},meta:{protocol:1,replayed}}
 })
}
