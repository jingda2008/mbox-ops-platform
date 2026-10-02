import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import {StaffAccessRepository,StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor} from './command-executor.js'
import {CustomerExperienceRepository,CustomerExperienceRequestError} from './customer-experience-repository.js'
import {CustomerExperienceService,type StaffCustomerExperienceContext} from './customer-experience-service.js'
import {CustomerCommandService} from './customer-repository.js'
import {nativeGuardedExecutor} from './native-guarded-executor.js'
import {nativePhysicalExecutor} from './native-physical-command.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'
type Options={transactions:ScopedPostgresTransactionRunner;commands:Pick<NormalizedCommandExecutor,'execute'>;resolveContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext}
const root='/staff/native-product-phases/:productId',permission='recommendation.phase.configure',uuid=z.string().uuid()
const input=z.object({expectedVersion:z.string().regex(/^[a-f0-9]{64}$/),phaseCodes:z.array(z.enum(['before_show','acoustic','band_live','intermission','after_show'])).max(5),reason:z.string().trim().min(2).max(240)}).strict()
async function read(tx:ScopedTransaction,product:string){const data=await new CustomerExperienceRepository(tx).productPerformancePhases(product);const rows=await tx.query('SELECT id,phase_code,status,created_at::text,retired_at::text FROM mbox.product_performance_phase_eligibilities WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 ORDER BY id',[tx.scope.tenantId,tx.scope.storeId,product]);return{...data,expectedVersion:createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex')}}
export const nativeProductPhaseApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError||error instanceof StaffNotFoundError)return reply.code(403).send({error:{code:'PRODUCT_PHASE_FORBIDDEN',message:'当前员工无演出阶段配置权限'}})
  if(error instanceof NativeCommandNotCommittedError&&!(error.original instanceof IdempotencyConflictError))return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.original instanceof TypeError?error.original.message:'原配置已变化，请刷新',commitDisposition:'not_committed'}})
  if(error instanceof z.ZodError||error instanceof TypeError)return reply.code(400).send({error:{code:'PRODUCT_PHASE_INVALID',message:'请核对阶段、原版本与原因'}})
  if(error instanceof CustomerExperienceRequestError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError||error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'PRODUCT_PHASE_UNCONFIRMED',message:'原请求内容不一致或尚未确认，请保留原请求'}})
  throw error
 })
 app.get<{Params:{productId:string}}>(root,async request=>{const product=uuid.parse(request.params.productId),ctx=await options.resolveContext(request);const data=await options.transactions.run(ctx.scope,async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission);return{...await read(tx,product),employeeId:ctx.employeeId,protocol:1,durableCommands:true}},{readOnly:true,isolation:'repeatable-read'});return{data}})
 app.post<{Params:{productId:string}}>(root,async request=>{
  const product=uuid.parse(request.params.productId),body=input.parse(request.body),ctx=await options.resolveContext(request),key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key']);uuid.parse(key.slice(16))
  const authorize=async(tx:ScopedTransaction)=>{const current=await options.resolveContext(request);if(current.employeeId!==ctx.employeeId||current.scope.storeId!==ctx.scope.storeId||current.scope.tenantId!==ctx.scope.tenantId)throw new StaffAccessDeniedError('身份已变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)}
  const commands=nativeGuardedExecutor(nativePhysicalExecutor(options.commands,ctx,authorize),{fingerprint:{product,body,employeeId:ctx.employeeId},authorize,guard:async tx=>{await tx.query('SELECT id FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[ctx.scope.tenantId,ctx.scope.storeId,product]);if((await read(tx,product)).expectedVersion!==body.expectedVersion)throw new TypeError('阶段配置已变化，本次未提交，请刷新后重新选择')}})
  const service=new CustomerExperienceService(options.transactions,commands,new CustomerCommandService(commands));const result=await service.configureProductPerformancePhases(ctx,{productId:product,phaseCodes:body.phaseCodes,reason:body.reason,idempotencyKey:key});return{data:{...result.value,employeeId:ctx.employeeId,requestKey:key},meta:{protocol:1,replayed:result.replayed}}
 })
}
