import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import {StackingPricingDraftRepository,StackingDraftConflictError} from './stacking-pricing-draft-repository.js'
import {StackingPricingError,calculateStackingPrice} from './stacking-pricing.js'
import {StaffAccessRepository,StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonObject} from './command-executor.js'
import {nativePhysicalExecutor} from './native-physical-command.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import type {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'
type Options={transactions:ScopedPostgresTransactionRunner;commands:Pick<NormalizedCommandExecutor,'execute'>;resolveContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext}
const root='/staff/native-stacking-policies',reason=z.string().trim().min(2).max(500),uuid=z.string().uuid()
const saveSchema=z.object({code:z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),policy:z.record(z.string(),z.unknown()),expectedVersion:z.number().int().min(0).max(2147483646),reason}).strict()
const decisionSchema=z.object({versionId:uuid,expectedStatus:z.enum(['draft','approved','published']),action:z.enum(['approve','publish','stop_issuing']),reason}).strict()
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as JsonObject
export const nativeStackingPolicyApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError||error instanceof StaffNotFoundError)return reply.code(403).send({error:{code:'STACKING_FORBIDDEN',message:'当前员工无此叠加价格规则权限'}})
  if(error instanceof NativeCommandNotCommittedError&&!(error.original instanceof IdempotencyConflictError))return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.original instanceof StackingPricingError||error.original instanceof StackingDraftConflictError?error.original.message:'规则版本或状态已变化，请刷新',commitDisposition:'not_committed'}})
  if(error instanceof z.ZodError||error instanceof StackingPricingError||error instanceof SyntaxError)return reply.code(400).send({error:{code:'STACKING_INVALID',message:error instanceof StackingPricingError?error.message:'请核对叠加开关、计算顺序和金额限制'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError||error instanceof StackingDraftConflictError||error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'STACKING_UNCONFIRMED',message:'原请求未确认或版本已变化，请保留原请求核对'}})
  throw error
 })
 app.get(root,async request=>{
  const q=z.object({cursor:uuid.optional(),search:z.string().trim().max(40).default('')}).strict().parse(request.query),cursor=q.cursor??null,ctx=await options.resolveContext(request)
  const data=await options.transactions.run(ctx.scope,async tx=>{const access=await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'loyalty.configuration.view');const {rows,next}=await new StackingPricingDraftRepository(tx).listNative(cursor,q.search);return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,permissions:access.permissions.filter(p=>['loyalty.configuration.view','loyalty.configuration.edit','loyalty.configuration.approve','loyalty.policy.publish'].includes(p)),rows,next}},{readOnly:true,isolation:'repeatable-read'});return{data}
 })
 app.post(root+'/preview',{bodyLimit:65536},async request=>{
  const b=z.object({policy:z.record(z.string(),z.unknown()),scenario:z.record(z.string(),z.unknown())}).strict().parse(request.body),ctx=await options.resolveContext(request);await options.transactions.run(ctx.scope,tx=>new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'loyalty.configuration.preview'),{readOnly:true});return{data:{employeeId:ctx.employeeId,protocol:1,previewOnly:true,orderAuthorization:false,currency:'CNY',...calculateStackingPrice(b.policy,b.scenario)}}
 })
 for(const action of ['save','decision'] as const)app.post(root+'/'+action,{bodyLimit:65536},async request=>{
  const ctx=await options.resolveContext(request),body=action==='save'?saveSchema.parse(request.body):decisionSchema.parse(request.body),permission=action==='save'?'loyalty.configuration.edit':('action'in body&&body.action==='approve')?'loyalty.configuration.approve':'loyalty.policy.publish',key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key']);uuid.parse(key.slice(16))
  const executor=nativePhysicalExecutor(options.commands,ctx,async tx=>{const current=await options.resolveContext(request);if(current.employeeId!==ctx.employeeId||current.scope.storeId!==ctx.scope.storeId||current.scope.tenantId!==ctx.scope.tenantId)throw new StaffAccessDeniedError('身份变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission)})
  const result=await executor.execute<JsonObject>({scope:ctx.scope,operationScope:'stacking.policy.native.'+action,idempotencyKey:key,retainReceipt:true,requestFingerprint:createHash('sha256').update(JSON.stringify({employeeId:ctx.employeeId,body})).digest('hex'),resultCodec:{encode:v=>v,decode:v=>v as JsonObject}},async tx=>{
   const repo=new StackingPricingDraftRepository(tx);let row
   if(action==='save')row=await repo.save({...saveSchema.parse(body),employeeId:ctx.employeeId,businessDate:ctx.businessDate,requestKey:key})
   else{const b=decisionSchema.parse(body);const locked=await tx.query<{ok:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok',[`stacking-release:${ctx.scope.tenantId}:${ctx.scope.storeId}:${b.versionId}`]);if(!locked.rows[0]?.ok)throw new StackingDraftConflictError('规则正在处理，请刷新');const before=await repo.find(b.versionId);if(before.status!==b.expectedStatus)throw new StackingDraftConflictError('审核或发布状态已变化，本次未提交，请刷新');row=await repo.decide({...b,employeeId:ctx.employeeId,businessDate:ctx.businessDate})}
   return{result:json({employeeId:ctx.employeeId,requestKey:key,action,row}),auditEvents:[],outboxMessages:[]}
  });return{data:result.value,meta:{protocol:1,replayed:result.replayed}}
 })
}
