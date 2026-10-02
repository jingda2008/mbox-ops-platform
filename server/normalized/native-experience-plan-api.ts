import {nativePhysicalExecutor} from './native-physical-command.js'
import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {z} from 'zod'
import {StaffAccessRepository,StaffAccessDeniedError,StaffNotFoundError} from './staff-access-repository.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonCodec,type JsonObject} from './command-executor.js'
import {ServiceTaskRepository} from './service-task-repository.js'
import {ExperiencePlanLifecycleRepository} from './experience-plan-lifecycle-repository.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'

type Options={transactions:ScopedPostgresTransactionRunner;commands:Pick<NormalizedCommandExecutor,'execute'>;resolveContext(request:FastifyRequest):Promise<StaffCustomerExperienceContext>|StaffCustomerExperienceContext}
interface PlanRow extends Record<string,unknown>{id:string;business_date:string;table_session_id:string;session_status:string;plan_state:string;plan_version:number;activated_at:string|null}
interface CueRow extends Record<string,unknown>{id:string;status:string;trigger_kind:string;service_task_id:string|null}
interface TaskRow extends Record<string,unknown>{id:string;table_session_id:string;task_type:string;status:string}
const root='/staff/native-experience-plans',permission='customer.experience.manage'
const uuid=z.string().uuid(),date=z.iso.date(),bodySchema=z.object({action:z.enum(['pause','resume','cancel','reschedule']),expectedVersion:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().trim().min(4).max(500),cueId:uuid.optional(),offsetMinutes:z.number().int().min(0).max(240).optional()}).strict()
const codec:JsonCodec<JsonObject>={encode:value=>value,decode:value=>value as JsonObject}
const version=(row:unknown)=>createHash('sha256').update(JSON.stringify(row)).digest('hex')
const scope=(tx:ScopedTransaction)=>[tx.scope.tenantId,tx.scope.storeId]
// Native and web task completion use the same session -> plan -> cues -> tasks order.
async function readPlan(tx:ScopedTransaction,id:string,lock=false){
 if(lock){const found=(await tx.query<{table_session_id:string}>('SELECT table_session_id FROM mbox.customer_experience_plans WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope(tx),id])).rows[0];if(!found)throw new TypeError('原计划不存在');await tx.query('SELECT id FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...scope(tx),found.table_session_id])}
 const plan=(await tx.query<PlanRow>(`SELECT plan.id,plan.public_id,plan.table_session_id,plan.business_date::text,plan.plan_state,plan.plan_version,plan.promise_summary,plan.service_intensity,plan.party_size,plan.occasion,plan.activated_at::text,plan.updated_at::text,plan.order_id,session.status session_status,t.code table_code
 FROM mbox.customer_experience_plans plan JOIN mbox.table_sessions session ON (session.tenant_id,session.store_id,session.id)=(plan.tenant_id,plan.store_id,plan.table_session_id)
 JOIN mbox.tables t ON (t.tenant_id,t.store_id,t.id)=(session.tenant_id,session.store_id,session.table_id)
 WHERE plan.tenant_id=$1 AND plan.store_id=$2 AND plan.id=$3 ${lock?'FOR UPDATE OF plan':''}`,[...scope(tx),id])).rows[0]
 if(!plan)throw new TypeError('原计划不存在')
 const cues=(await tx.query<CueRow>(`SELECT id,cue_code,sequence_no,trigger_kind,trigger_offset_minutes,performance_phase,action_kind,station,action_payload,due_at::text,status,service_task_id,completed_at::text,updated_at::text FROM mbox.experience_plan_cues WHERE tenant_id=$1 AND store_id=$2 AND experience_plan_id=$3 ORDER BY id ${lock?'FOR UPDATE':''}`,[...scope(tx),id])).rows
 const tasks=(await tx.query<TaskRow>(`SELECT id,table_session_id,task_type,status,updated_at::text FROM mbox.service_tasks WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id ${lock?'FOR UPDATE':''}`,[...scope(tx),cues.map(c=>c.service_task_id).filter(Boolean)])).rows
 const snapshot={...plan,cues,tasks};return {...snapshot,expectedVersion:version(snapshot)}
}
async function authorize(tx:ScopedTransaction,employee:string,planId?:string,write=false){
 const access=await new StaffAccessRepository(tx).assertPermission(employee,permission)
 if(!access.permissions.includes('service.execute')||(write&&!access.permissions.includes('service.manage')))throw new StaffAccessDeniedError('无计划管理权限')
 if(planId){const visible=await tx.query(`SELECT plan.id FROM mbox.customer_experience_plans plan JOIN mbox.table_sessions session ON (session.tenant_id,session.store_id,session.id)=(plan.tenant_id,plan.store_id,plan.table_session_id)
 WHERE plan.tenant_id=$1 AND plan.store_id=$2 AND plan.id=$3 AND ($5::boolean OR EXISTS(SELECT 1 FROM mbox.table_assignments a WHERE a.tenant_id=session.tenant_id AND a.store_id=session.store_id AND a.table_id=session.table_id AND a.employee_id=$4 AND a.starts_at<=clock_timestamp() AND (a.ends_at IS NULL OR a.ends_at>clock_timestamp())))`,[...scope(tx),planId,employee,access.permissions.includes('table.view_all')]);if(visible.rowCount!==1)throw new StaffAccessDeniedError('原计划不在当前桌台范围')}
 return access
}
export const nativeExperiencePlanApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
 app.setErrorHandler((error,_request,reply)=>{
  if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
  if(error instanceof StaffAccessDeniedError||error instanceof StaffNotFoundError)return reply.code(403).send({error:{code:'EXPERIENCE_PLAN_FORBIDDEN',message:'当前身份或桌台范围无此操作权限'}})
  if(error instanceof NativeCommandNotCommittedError&&!(error.original instanceof IdempotencyConflictError))return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.original instanceof TypeError?error.original.message:'原计划已变化，请刷新后核对',commitDisposition:'not_committed'}})
  if(error instanceof z.ZodError||error instanceof TypeError)return reply.code(400).send({error:{code:'EXPERIENCE_PLAN_INVALID',message:error instanceof TypeError?error.message:'请核对日期、原计划与操作原因'}})
  if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError||error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'EXPERIENCE_PLAN_UNCONFIRMED',message:'原请求尚未确认，请保留原请求核对'}})
  throw error
 })
 app.get(root,async request=>{
  const q=z.object({history:z.enum(['true','false']).default('false'),from:date.optional(),to:date.optional(),beforeDate:date.optional(),beforeId:uuid.optional()}).strict().parse(request.query),ctx=await options.resolveContext(request)
  if(Boolean(q.beforeDate)!==Boolean(q.beforeId))throw new TypeError('分页位置不完整')
  if(q.history==='true'&&(!q.from||!q.to||q.from>q.to||Date.parse(q.to)-Date.parse(q.from)>60*86400000))throw new TypeError('历史查询须选择不超过60天的营业日范围')
  const data=await options.transactions.run(ctx.scope,async tx=>{const access=await authorize(tx,ctx.employeeId);const ids=(await tx.query<{id:string;business_date:string}>(`SELECT plan.id,plan.business_date::text FROM mbox.customer_experience_plans plan JOIN mbox.table_sessions session ON (session.tenant_id,session.store_id,session.id)=(plan.tenant_id,plan.store_id,plan.table_session_id)
  WHERE plan.tenant_id=$1 AND plan.store_id=$2 AND ($4::boolean OR EXISTS(SELECT 1 FROM mbox.table_assignments a WHERE a.tenant_id=session.tenant_id AND a.store_id=session.store_id AND a.table_id=session.table_id AND a.employee_id=$3 AND a.starts_at<=clock_timestamp() AND (a.ends_at IS NULL OR a.ends_at>clock_timestamp())))
  AND (CASE WHEN $5::boolean THEN plan.business_date BETWEEN $6::date AND $7::date ELSE plan.plan_state IN ('planned','active','paused') END)
  AND ($8::date IS NULL OR (plan.business_date,plan.id)<($8::date,$9::uuid)) ORDER BY plan.business_date DESC,plan.id DESC LIMIT 31`,[...scope(tx),ctx.employeeId,access.permissions.includes('table.view_all'),q.history==='true',q.from??null,q.to??null,q.beforeDate??null,q.beforeId??null])).rows
  const rows=[];for(const id of ids.slice(0,30))rows.push(await readPlan(tx,id.id));const last=rows.at(-1)
  return{employeeId:ctx.employeeId,protocol:1,durableCommands:true,canManage:access.permissions.includes('service.manage'),rows,hasMore:ids.length>30,next:ids.length>30&&last?{beforeDate:last.business_date,beforeId:last.id}:null}
  },{readOnly:true,isolation:'repeatable-read'});return{data}
 })
 app.post<{Params:{planId:string}}>(root+'/:planId',async request=>{
  const planId=uuid.parse(request.params.planId),body=bodySchema.parse(request.body),ctx=await options.resolveContext(request),key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key']);uuid.parse(key.slice(16))
  if(body.action==='reschedule'&&(!body.cueId||body.offsetMinutes===undefined)||body.action!=='reschedule'&&(body.cueId!==undefined||body.offsetMinutes!==undefined))throw new TypeError('节点调时参数不完整')
  const result=await nativePhysicalExecutor(options.commands,ctx,async tx=>{const current=await options.resolveContext(request);if(current.employeeId!==ctx.employeeId||current.scope.storeId!==ctx.scope.storeId||current.scope.tenantId!==ctx.scope.tenantId)throw new StaffAccessDeniedError('身份已变化');await authorize(tx,ctx.employeeId,planId,true)}).execute({scope:ctx.scope,operationScope:'native.experience.plan',idempotencyKey:key,requestFingerprint:version({planId,body,employeeId:ctx.employeeId}),retainReceipt:true,resultCodec:codec},async tx=>{
   let row=await readPlan(tx,planId,true);if(row.expectedVersion!==body.expectedVersion)throw new TypeError('节点、任务或原计划已变化，本次未提交，请刷新')
   if(!['open','closing'].includes(row.session_status)||!['active','paused'].includes(row.plan_state))throw new TypeError('仅能处理营业中已激活或暂停的计划；待付款与结束计划不能由此跳过原流程')
   const repo=new ServiceTaskRepository(tx)
   if(body.action==='cancel'){
    if(row.plan_state==='active'){await new ExperiencePlanLifecycleRepository(tx).reconcileLockedPlan(planId,'native-plan-stop');row=await readPlan(tx,planId,true)}
    if(row.plan_state==='completed')throw new TypeError('计划节点均已完成，请刷新核对')
    for(const task of row.tasks){if(task.table_session_id!==row.table_session_id||!String(task.task_type).startsWith('experience.'))throw new TypeError('原节点与服务任务关联不一致，请主管核对');if(task.status==='completed'&&row.cues.some(c=>c.service_task_id===task.id&&c.status!=='completed'))throw new TypeError('原完成记录尚未同步，请先恢复计划并刷新');if(['pending','acknowledged','in_progress'].includes(task.status))await repo.cancel({taskId:task.id,actor:{type:'employee',employeeId:ctx.employeeId},note:body.reason,eventIdempotencyKey:key+':'+task.id})}
    await tx.query(`UPDATE mbox.experience_plan_cues SET status='skipped',updated_at=clock_timestamp(),action_payload=action_payload||jsonb_build_object('skipReason','manager_plan_cancel','cancelReason',$4::text,'cancelledByEmployeeId',$5::text) WHERE tenant_id=$1 AND store_id=$2 AND experience_plan_id=$3 AND status<>'completed'`,[...scope(tx),planId,body.reason,ctx.employeeId])
   }else if(body.action==='pause'){
    if(row.plan_state!=='active'||row.tasks.some(t=>['pending','acknowledged','in_progress'].includes(t.status)))throw new TypeError('已有派出任务时不能暂停，请先完成任务或整体中止计划')
   }else if(body.action==='resume'){if(row.plan_state!=='paused')throw new TypeError('该计划不在暂停状态')}
   else {
    const cue=row.cues.find(c=>c.id===body.cueId);if(!cue||cue.trigger_kind!=='elapsed'||!['pending','ready'].includes(cue.status)||cue.service_task_id||!row.activated_at)throw new TypeError('只能调整未派出、按激活时间计时的节点')
    const changed=await tx.query(`UPDATE mbox.experience_plan_cues cue SET trigger_offset_minutes=$4::integer,due_at=plan.activated_at+($4::integer*interval '1 minute'),updated_at=clock_timestamp() FROM mbox.customer_experience_plans plan WHERE cue.tenant_id=$1 AND cue.store_id=$2 AND cue.id=$3 AND (plan.tenant_id,plan.store_id,plan.id)=(cue.tenant_id,cue.store_id,cue.experience_plan_id) AND plan.activated_at+($4::integer*interval '1 minute')>clock_timestamp()`,[...scope(tx),body.cueId,body.offsetMinutes]);if(changed.rowCount!==1)throw new TypeError('新的服务时间已经过去，请选择激活后0至240分钟内的未来时间')
   }
   const state=body.action==='pause'?'paused':body.action==='resume'?'active':body.action==='cancel'?'cancelled':row.plan_state
   await tx.query('UPDATE mbox.customer_experience_plans SET plan_state=$4,plan_version=plan_version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope(tx),planId,state])
   const saved=await readPlan(tx,planId),receipt:JsonObject={employeeId:ctx.employeeId,requestKey:key,planId,tableSessionId:row.table_session_id,action:body.action,state,planVersion:saved.plan_version,cueId:body.cueId??null,offsetMinutes:body.offsetMinutes??null}
   return{result:receipt,auditEvents:[{actor:{type:'employee',employeeId:ctx.employeeId},action:'customer.experience.plan.native_'+body.action,objectType:'customer_experience_plan',objectId:planId,businessDate:row.business_date,reason:body.reason,beforeData:{state:row.plan_state,version:row.plan_version},afterData:receipt}],outboxMessages:[{aggregateType:'customer_experience_plan',aggregateId:planId,aggregateVersion:saved.plan_version,eventType:'customer.experience.plan.updated.v1',payload:receipt,businessEventKey:'native-plan:'+key}]}
  })
  return{data:result.value,meta:{protocol:1,replayed:result.replayed}}
 })
}
