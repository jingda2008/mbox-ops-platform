import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import {CustomerExperienceService,type StaffCustomerExperienceContext} from './customer-experience-service.js'
import {CustomerExperienceRequestError,normalizeRecommendationDisplayConfiguration} from './customer-experience-repository.js'
import {CustomerCommandService} from './customer-repository.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {nativeGuardedExecutor} from './native-guarded-executor.js'
import {nativePhysicalExecutor} from './native-physical-command.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonObject,type IdempotentCommand,type CommandOutcome} from './command-executor.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'
const text=(min:number,max:number)=>z.string().trim().min(min).max(max),code=z.string().regex(/^[A-Z][A-Z0-9_-]{2,63}$/),hash=z.string().regex(/^[a-f0-9]{64}$/),reason=text(2,500),weight=z.number().int().min(-1000).max(1000)
const draftSchema=z.object({code,expectedLatest:z.number().int().nonnegative(),preferenceWeight:weight,sceneWeight:weight,marginWeight:weight,priorityWeight:weight,performanceWeight:weight,inventoryWeight:weight,capacityWeight:weight,minimumGrossMarginBasisPoints:z.number().int().min(0).max(9999),preferenceHalfLifeDays:z.number().int().min(7).max(730),preferenceMaxAgeDays:z.number().int().min(30).max(3650),preferenceMinEffectiveScore:z.number().int().min(1).max(10000),preferenceMinConfidenceBasisPoints:z.number().int().min(0).max(10000),explanationTemplate:text(2,500),displayConfiguration:z.record(z.string(),z.json()),reason}).strict()
const decisionSchema=z.object({publicId:text(8,128),expectedVersion:hash,reason,effectiveFrom:z.iso.datetime({offset:true}).optional()}).strict()
const rolloutSchema=z.object({rolloutState:z.enum(['disabled','shadow','pilot','enabled']),expectedVersion:hash,reason}).strict()
const permissions={create:'recommendation.rule.draft',clone:'recommendation.rule.draft',approve:'recommendation.rule.approve',publish:'recommendation.rule.publish',rollout:'recommendation.rule.publish'} as const
const fields=['preferenceWeight','sceneWeight','marginWeight','priorityWeight','performanceWeight','inventoryWeight','capacityWeight','minimumGrossMarginBasisPoints','preferenceHalfLifeDays','preferenceMaxAgeDays','preferenceMinEffectiveScore','preferenceMinConfidenceBasisPoints','explanationTemplate','displayConfiguration','draftReason','approvalReason','publicationReason','publicationMode','createdByEmployeeId','approvedByEmployeeId','publishedByEmployeeId','createdAt','approvedAt','publishedAt','effectiveFrom','effectiveUntil']
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
function rowView(row:Record<string,unknown>){const value:Record<string,unknown>={publicId:row.public_id,code:row.policy_code,version:row.version,status:row.status};for(const key of fields)value[key]=row[key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())];value.displayConfiguration=normalizeRecommendationDisplayConfiguration(row.display_configuration as JsonObject);return{...value,nativeVersion:sha(row)}}
const columns=`p.*,p.created_at::text,p.updated_at::text,p.approved_at::text,p.published_at::text,p.effective_from::text,p.effective_until::text`
async function find(tx:ScopedTransaction,id:string,lock=''){const row=(await tx.query(`SELECT ${columns} FROM mbox.recommendation_policy_versions p WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3 ${lock}`,[tx.scope.tenantId,tx.scope.storeId,id])).rows[0];return row?rowView(row):null}
async function feature(tx:ScopedTransaction,lock=false){const row=(await tx.query(`SELECT rollout_state,configuration,reason,effective_from::text,updated_at::text FROM mbox.customer_experience_features WHERE tenant_id=$1 AND store_id=$2 AND feature_code='recommendation.engine' ${lock?'FOR UPDATE':''}`,[tx.scope.tenantId,tx.scope.storeId])).rows[0]??{rollout_state:'disabled',configuration:{},reason:'尚未配置',effective_from:null,updated_at:null};return{rolloutState:row.rollout_state,configuration:row.configuration,reason:row.reason,effectiveFrom:row.effective_from,nativeVersion:sha(row)}}
type Options={transactions:ScopedPostgresTransactionRunner;commands:Pick<NormalizedCommandExecutor,'execute'>;resolveContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext}
export const nativeRecommendationPolicyApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_req,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'RECOMMENDATION_FORBIDDEN',message:'当前岗位无此推荐配置权限'}})
  if(error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.original instanceof CustomerExperienceRequestError||error.original instanceof TypeError?error.original.message:'原规则或开关已变化，开放推荐还须有当前生效的受控发布版本',commitDisposition:'not_committed'}})
  if(error instanceof z.ZodError||error instanceof CustomerExperienceRequestError||error instanceof TypeError)return reply.code(400).send({error:{code:'RECOMMENDATION_INVALID',message:error instanceof z.ZodError?'请核对规则参数、原版本和生效时间':error.message}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'RECOMMENDATION_CONFLICT',message:'原请求正在处理或内容不一致，请保留原请求核对'}})
  throw error
 })
 const root='/staff/native-recommendation-policies'
 app.get(root,async request=>{const ctx=await options.resolveContext(request),q=z.object({code:code.default('DEFAULT'),cursor:z.coerce.number().int().positive().optional()}).strict().parse(request.query);const data=await options.transactions.run(ctx.scope,async tx=>{
  await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'recommendation.rule.view');const rows=(await tx.query(`SELECT ${columns} FROM mbox.recommendation_policy_versions p WHERE tenant_id=$1 AND store_id=$2 AND policy_code=$3 AND ($4::integer IS NULL OR version<$4) ORDER BY version DESC LIMIT 21`,[ctx.scope.tenantId,ctx.scope.storeId,q.code,q.cursor??null])).rows
  const latest=(await tx.query<{version:number}>('SELECT COALESCE(max(version),0)::integer AS version FROM mbox.recommendation_policy_versions WHERE tenant_id=$1 AND store_id=$2 AND policy_code=$3',[ctx.scope.tenantId,ctx.scope.storeId,q.code])).rows[0]!.version
  return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,code:q.code,latest,defaultDisplayConfiguration:normalizeRecommendationDisplayConfiguration({}),feature:await feature(tx),rows:rows.slice(0,20).map(rowView),next:rows.length>20?String(rows[19]!.version):null}
 },{readOnly:true,isolation:'repeatable-read'});return{data}})
 app.post<{Params:{action:string}}>(root+'/:action',{bodyLimit:64000},async request=>{
  const action=z.enum(['create','clone','approve','publish','rollout']).parse(request.params.action),input=action==='create'?draftSchema.parse(request.body):action==='rollout'?rolloutSchema.parse(request.body):decisionSchema.parse(request.body),key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key']),ctx=await options.resolveContext(request)
  if(action==='publish'&&!('effectiveFrom'in input&&input.effectiveFrom))throw new TypeError('请选择明确的生效时间')
  if(action==='create'){const d=draftSchema.parse(input);if(d.preferenceMaxAgeDays<d.preferenceHalfLifeDays)throw new TypeError('最长有效期不能短于半衰期');d.displayConfiguration=normalizeRecommendationDisplayConfiguration(d.displayConfiguration as JsonObject);Object.assign(input,d)}
  const authorize=async(tx:ScopedTransaction)=>{const current=await options.resolveContext(request);if(current.employeeId!==ctx.employeeId||current.scope.tenantId!==ctx.scope.tenantId||current.scope.storeId!==ctx.scope.storeId)throw new StaffAccessDeniedError('身份变化');await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permissions[action])}
  const rolloutConfiguration:JsonObject={}
  const guarded=nativeGuardedExecutor(nativePhysicalExecutor(options.commands,ctx,authorize),{fingerprint:{employeeId:ctx.employeeId,action,input},authorize,guard:async tx=>{
   if(action==='rollout'){await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`native-recommendation-feature:${ctx.scope.tenantId}:${ctx.scope.storeId}`]);const current=await feature(tx,true);Object.assign(rolloutConfiguration,current.configuration);if(current.nativeVersion!==rolloutSchema.parse(input).expectedVersion)throw new TypeError('开放状态已变化，请重新读取');return}
   if(action==='create'){const v=draftSchema.parse(input);await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text || ':' || $3,0))",[ctx.scope.tenantId,ctx.scope.storeId,v.code]);const latest=(await tx.query<{version:number}>('SELECT COALESCE(max(version),0)::integer AS version FROM mbox.recommendation_policy_versions WHERE tenant_id=$1 AND store_id=$2 AND policy_code=$3',[ctx.scope.tenantId,ctx.scope.storeId,v.code])).rows[0]!.version;if(latest!==v.expectedLatest)throw new TypeError('已有新版本，请重新读取后起草');return}
   const v=decisionSchema.parse(input),current=await find(tx,v.publicId,action==='clone'?'FOR KEY SHARE':'FOR UPDATE');if(!current||current.nativeVersion!==v.expectedVersion)throw new TypeError('规则状态已变化，请重新读取原版本')
  }})
  // Capture the full original result inside the same durable domain command.
  const captured:Pick<NormalizedCommandExecutor,'execute'>={execute<Result>(command:Readonly<IdempotentCommand<Result>>,handler:(tx:ScopedTransaction)=>Promise<CommandOutcome<Result>>,beforeClaim?:(tx:ScopedTransaction)=>Promise<void>){return guarded.execute({...command,resultCodec:{encode:v=>v as never,decode:v=>v as Result}},async tx=>{const outcome=await handler(tx);const value=outcome.result as {publicId?:string};const full=action==='rollout'?await feature(tx):await find(tx,value.publicId!);return{...outcome,result:full as Result}},beforeClaim)}}
  const svc=new CustomerExperienceService(options.transactions,captured,new CustomerCommandService(captured)),common={reason:input.reason,idempotencyKey:key}
  const result=await(async()=>{if(action==='create'){const v=draftSchema.parse(input);return svc.createRecommendationPolicy(ctx,{...v,...common,displayConfiguration:v.displayConfiguration as JsonObject,draftReason:v.reason})}if(action==='rollout'){const v=rolloutSchema.parse(input);return svc.setFeature(ctx,{...common,featureCode:'recommendation.engine',rolloutState:v.rolloutState,configuration:rolloutConfiguration })}const v=decisionSchema.parse(input);if(action==='clone')return svc.cloneRecommendationPolicyDraft(ctx,{sourcePublicId:v.publicId,draftReason:v.reason,idempotencyKey:key});if(action==='approve')return svc.approveRecommendationPolicy(ctx,{...common,publicId:v.publicId});return svc.publishRecommendationPolicy(ctx,{...common,publicId:v.publicId,effectiveFrom:v.effectiveFrom!})})()
  return{data:{employeeId:ctx.employeeId,requestKey:key,action,accepted:input,row:result.value},meta:{protocol:1,replayed:result.replayed}}
 })
}
