import { ExperiencePlanLifecycleRepository } from './experience-plan-lifecycle-repository.js'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { NativeCommandNotCommittedError, IdempotencyConflictError, type JsonCodec, type JsonObject } from './command-executor.js'
import { StaffAccessRepository, StaffAccessDeniedError } from './staff-access-repository.js'
import type { NormalizedOperationsApiOptions, NormalizedOperationsRequestContext } from './normalized-operations-api.js'
import type { ScopedTransaction } from './transaction-runner.js'
import type { ServiceTask } from './service-task-repository.js'
import { ServiceTaskNotFoundError } from './service-task-repository.js'

class NativeServiceInputError extends Error {}
class NativeServiceWithdrawnError extends Error {}
class NativeServiceUnknownError extends Error {}
type Withdrawal = { disposition: 'withdrawn'; originalKey: string; taskId: string; action: Action; employeeId: string; supervisorId: string; resolvedAt: string }
const isWithdrawal=(value:unknown):value is Withdrawal => !!value && typeof value==='object' && (value as Withdrawal).disposition==='withdrawn'

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const actions=['acknowledge','start','complete','cancel','assign','priority'] as const
type Action=typeof actions[number]
const codec:JsonCodec<ServiceTask>={encode:value=>JSON.parse(JSON.stringify(value)) as JsonObject,decode:value=>{if(isWithdrawal(value))throw new NativeServiceWithdrawnError();const row=object(value);if(typeof row.id!=='string'||typeof row.tableSessionId!=='string'||typeof row.status!=='string')throw new Error('Invalid service receipt');return row as unknown as ServiceTask}}
const recoveryCodec:JsonCodec<ServiceTask|Withdrawal>={encode:value=>JSON.parse(JSON.stringify(value)) as JsonObject,decode:value=>isWithdrawal(value)?value:codec.decode(value)}
function originalRequest(taskIdValue:unknown,actionValue:unknown,body:Record<string,unknown>){
 const taskId=id(taskIdValue,'任务编号'),action=text(actionValue,'任务操作',32) as Action
 if(!actions.includes(action))throw new NativeServiceInputError('任务操作无效')
 const employeeId=id(body.employeeId,'原员工'),session=id(body.tableSessionId,'原桌次'),taskType=text(body.taskType,'任务类型',64)
 const expectedStatus=text(body.expectedStatus,'任务状态',32),expectedPriority=text(body.expectedPriority,'任务优先级',16)
 const expectedAssigned=optionalID(body.expectedAssignedEmployeeId),note=text(body.note,'处理原因').trim()
 const assigned=action==='assign'?id(body.assignedEmployeeId,'接手员工'):null
 const priority=action==='priority'?text(body.priority,'新优先级',16):null
 if(priority!==null&&!['low','normal','high','urgent'].includes(priority))throw new NativeServiceInputError('优先级无效')
 return {taskId,action,employeeId,session,taskType,expectedStatus,expectedPriority,expectedAssigned,note,assigned,priority}
}
function originalKey(value:unknown){if(typeof value!=='string'||!/^native-business-[a-f0-9-]{36}$/.test(value)||!uuid.test(value.slice(16)))throw new NativeServiceInputError('原请求编号无效');return value}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new NativeServiceInputError('请求内容无效');return value as Record<string,unknown>}
function text(value:unknown,label:string,max=1000):string{if(typeof value!=='string'||value.length>max)throw new NativeServiceInputError(label+'无效');return value}
function id(value:unknown,label:string):string{const s=text(value,label,36);if(!uuid.test(s))throw new NativeServiceInputError(label+'无效');return s}
function optionalID(value:unknown):string|null{return value===null?null:id(value,'员工编号')}
function requireContext(context:NormalizedOperationsRequestContext,permission:string){if(!context.capabilities.includes(permission))throw new StaffAccessDeniedError('当前岗位无此权限')}
async function handle(reply:FastifyReply,work:()=>Promise<unknown>){
 try{reply.header('cache-control','no-store');return await work()}catch(error){
 if(error instanceof NativeServiceWithdrawnError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:'原请求已由主管封存，未执行；请刷新任务重新确认',commitDisposition:'not_committed'}})
 if(error instanceof NativeServiceUnknownError)return reply.code(409).send({error:{code:'NATIVE_SERVICE_UNCONFIRMED',message:'找到原处理事件但回执缺失，请保留记录联系管理员核对'}})
 if(error instanceof NativeCommandNotCommittedError){if(error.original instanceof NativeServiceUnknownError)return reply.code(409).send({error:{code:'NATIVE_SERVICE_UNCONFIRMED',message:'找到原处理事件但回执缺失，请保留记录联系管理员核对'}});const original=error.original;return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:original instanceof NativeServiceInputError?original.message:'任务已变化，本次未提交；请刷新后重新确认',commitDisposition:'not_committed'}})}
 if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'SERVICE_ACCESS_FORBIDDEN',message:'当前员工无此任务操作权限'}})
 if(error instanceof NativeServiceInputError)return reply.code(400).send({error:{code:'NATIVE_SERVICE_INVALID',message:error.message}})
 if(error instanceof ServiceTaskNotFoundError)return reply.code(404).send({error:{code:'NATIVE_SERVICE_NOT_FOUND',message:'任务不存在或当前员工不可见'}})
 if(error instanceof IdempotencyConflictError)return reply.code(409).send({error:{code:'NATIVE_SERVICE_RECEIPT_CONFLICT',message:'原请求编号与内容不一致，请保留原记录核对'}})
 if(error instanceof Error && ['NormalizedAuthenticationRequiredError','StaffSessionNotFoundError'].includes(error.name))return reply.code(401).send({error:{code:'AUTH_REQUIRED',message:'登录已过期，请由原员工重新登录后恢复'}})
 reply.request.log.error({errorCode:error instanceof Error?error.name:'UNKNOWN'},'native service request failed')
 return reply.code(500).send({error:{code:'NATIVE_SERVICE_UNCONFIRMED',message:'请求结果尚未确认，请保留原请求后重试'}})
 }
}
export async function registerNativeServiceRoutes(app:FastifyInstance,options:NormalizedOperationsApiOptions){
 app.get('/native-service-center',async(request,reply)=>handle(reply,async()=>{
  const context=await options.resolveContext(request)
  const readPermissions=['service.view','service.execute','service.manage','complaint.handle']
  if(!readPermissions.some(p=>context.capabilities.includes(p)))throw new StaffAccessDeniedError('当前岗位无任务查看权限')
  const view=await options.operationsQuery.getStaffView(context.scope,context.employeeId)
  if(!readPermissions.some(p=>view.actor.capabilities.includes(p)))throw new StaffAccessDeniedError('任务查看权限已撤销')
  const employees=view.actor.capabilities.includes('service.execute')&&view.actor.capabilities.includes('service.manage')&&options.operationsQuery.getNativeServiceEmployees?await options.operationsQuery.getNativeServiceEmployees(context.scope,context.employeeId):[]
  return reply.send({data:{currentEmployeeId:context.employeeId,tasks:view.tasks,employees,durableTasks:true,durableExperience:true,supervisorRecovery:true,generatedAt:new Date().toISOString()}})
 }))
 app.post<{Params:{taskId:string;action:string}}>('/native-service-tasks/:taskId/:action',async(request,reply)=>handle(reply,async()=>{
  const context=await options.resolveContext(request);requireContext(context,'service.execute')
  const body=object(request.body);if(body.employeeId!==context.employeeId)throw new NativeServiceInputError('请由原员工恢复操作')
  const payload=originalRequest(request.params.taskId,request.params.action,body)
  const {taskId,action,session,taskType,expectedStatus,expectedPriority,expectedAssigned,note,assigned,priority}=payload
  const needsManager=['assign','priority','cancel'].includes(action)||taskType==='guest.complaint'
  if(needsManager){requireContext(context,'service.manage');if(note.length<(taskType==='guest.complaint'?4:2))throw new NativeServiceInputError('主管处理须记录原因和结果，投诉至少4个字')}
  const key=originalKey(request.headers['idempotency-key'])
  const execution=await options.commandExecutor.execute({scope:context.scope,operationScope:`native.service.${action}`,idempotencyKey:key,requestFingerprint:JSON.stringify(payload),retainReceipt:true,resultCodec:codec},async tx=>{
   const repo=options.createServiceTaskRepository(tx);const current=await repo.findById(taskId)
   if(!current)throw new ServiceTaskNotFoundError(taskId)
   if(current.tableSessionId!==session||current.taskType!==taskType||current.status!==expectedStatus||current.priority!==expectedPriority||current.assignedEmployeeId!==expectedAssigned||!['pending','acknowledged','in_progress'].includes(current.status))throw new NativeServiceInputError('任务状态、负责人或优先级已变化，请刷新')
   if(taskType==='goods.redelivery')throw new NativeServiceInputError('该事项须从原商品处理，保留份数记录')
   const lifecycle=taskType.startsWith('experience.')?new ExperiencePlanLifecycleRepository(tx):null
   const cue=lifecycle?await lifecycle.lockByTask(current):null
   if(lifecycle){if(!cue)throw new NativeServiceInputError('体验任务缺少原计划节点关联，请主管核对');if(action==='cancel')throw new NativeServiceInputError('体验任务须按原计划中止，不能单独取消节点');if(note.length<2)throw new NativeServiceInputError('请记录实际处理结果');lifecycle.assertActionable(cue)}
   let result:ServiceTask
   if(action==='assign'||action==='priority'){
    if(assigned){const access=await new StaffAccessRepository(tx).assertPermission(assigned,'service.execute');if(taskType==='guest.complaint'&&!access.permissions.includes('service.manage'))throw new NativeServiceInputError('投诉须交给具有服务管理权限的员工')}
    const changed=await tx.query(`UPDATE mbox.service_tasks SET assigned_employee_id=CASE WHEN $4::boolean THEN $5::uuid ELSE assigned_employee_id END,priority=COALESCE($6,priority),updated_at=clock_timestamp() WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid RETURNING id`,[context.scope.tenantId,context.scope.storeId,taskId,action==='assign',assigned,priority])
    if(changed.rowCount!==1)throw new NativeServiceInputError('任务更新未确认')
    await tx.query(`INSERT INTO mbox.service_task_events(tenant_id,store_id,service_task_id,event_type,from_status,to_status,actor_type,actor_employee_id,note,metadata,idempotency_key) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$5,'employee',$6::uuid,$7,$8::jsonb,$9)`,[context.scope.tenantId,context.scope.storeId,taskId,`task.${action}`,current.status,context.employeeId,note,JSON.stringify({previousAssignedEmployeeId:current.assignedEmployeeId,assignedEmployeeId:assigned,previousPriority:current.priority,priority}),key])
    result=(await repo.findById(taskId))!
   }else result=await repo[action]({taskId,actor:{type:'employee',employeeId:context.employeeId},note,eventIdempotencyKey:key})
   if(cue && lifecycle && action==='complete')await lifecycle.complete(cue,{employeeId:context.employeeId,note,task:result})
   const receipt=cue?{...result,nativeExperienceCue:{cueId:cue.cue_id,planId:cue.id,tableSessionId:session,serviceTaskId:taskId,status:action==='complete'?'completed':cue.status}}:result
   return {result:receipt,auditEvents:[{actor:{type:'employee',employeeId:context.employeeId},action:`service_task.native_${action}`,objectType:'service_task',objectId:taskId,businessDate:context.businessDate,reason:note||null,afterData:codec.encode(result) as JsonObject}],outboxMessages:[{aggregateType:'native_service_command',aggregateId:key.slice(16),aggregateVersion:1,eventType:`service_task.${action}.v1`,payload:{taskId,tableSessionId:session,status:result.status,assignedEmployeeId:result.assignedEmployeeId,priority:result.priority}}]}
  },tx=>authorize(tx,context,taskId,session,taskType,needsManager))
  return reply.send({data:execution.value,meta:{replayed:execution.replayed}})
 }))
 app.post('/native-service-recovery',async(request,reply)=>handle(reply,async()=>{
  const context=await options.resolveContext(request);requireContext(context,'service.execute');requireContext(context,'service.manage')
  const body=object(request.body),original=object(body.original),payload=originalRequest(body.taskId,body.action,original)
  const {taskId,action,employeeId,session,taskType}=payload,key=originalKey(body.originalKey)
  const reason=text(body.reason,'主管核对依据').trim()
  if(reason.length<4||body.confirmed!==true||employeeId===context.employeeId)throw new NativeServiceInputError('须由另一位主管填写核对依据并确认')
  const execution=await options.commandExecutor.execute<ServiceTask|Withdrawal>({scope:context.scope,operationScope:`native.service.${action}`,idempotencyKey:key,requestFingerprint:JSON.stringify(payload),retainReceipt:true,resultCodec:recoveryCodec},async tx=>{
   // A retained domain event disproves non-commit even if an administrator removed its receipt.
   const events=await tx.query('SELECT id FROM mbox.service_task_events WHERE tenant_id=$1 AND store_id=$2 AND service_task_id=$3 AND idempotency_key=$4 LIMIT 1',[context.scope.tenantId,context.scope.storeId,taskId,key])
   if(events.rowCount)throw new NativeServiceUnknownError()
   const result:Withdrawal={disposition:'withdrawn',originalKey:key,taskId,action,employeeId,supervisorId:context.employeeId,resolvedAt:new Date().toISOString()}
   return {result,auditEvents:[{actor:{type:'employee',employeeId:context.employeeId},action:'service_task.native_request_withdrawn',objectType:'service_task',objectId:taskId,businessDate:context.businessDate,reason,afterData:recoveryCodec.encode(result) as JsonObject}],outboxMessages:[]}
  },async tx=>{
   await authorize(tx,context,taskId,session,taskType,true)
   const employee=await tx.query('SELECT id FROM mbox.employees WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[context.scope.tenantId,context.scope.storeId,employeeId])
   if(employee.rowCount!==1)throw new NativeServiceInputError('原员工不属于当前门店')
  })
  const result=execution.value
  return reply.send({data:{disposition:isWithdrawal(result)?'withdrawn':'committed',originalKey:key,taskId,action,employeeId,original:payload,receipt:isWithdrawal(result)?null:result,resolution:isWithdrawal(result)?result:null},meta:{replayed:execution.replayed}})
 }))
}
async function authorize(tx:ScopedTransaction,context:NormalizedOperationsRequestContext,taskId:string,session:string,taskType:string,manager:boolean){
 const access=await new StaffAccessRepository(tx).assertPermission(context.employeeId,'service.execute')
 if(manager&&!access.permissions.includes('service.manage'))throw new StaffAccessDeniedError('服务管理权限已撤销')
 // Experience worker locks session -> plan -> cues -> tasks. Follow the same order before locking the task.
 if(taskType.startsWith('experience.')){
  const linked=await tx.query<{id:string}>(`SELECT cue.id FROM mbox.experience_plan_cues cue JOIN mbox.customer_experience_plans plan ON (plan.tenant_id,plan.store_id,plan.id)=(cue.tenant_id,cue.store_id,cue.experience_plan_id)
    WHERE cue.tenant_id=$1 AND cue.store_id=$2 AND cue.service_task_id=$3 AND plan.table_session_id=$4 ORDER BY cue.id`,[context.scope.tenantId,context.scope.storeId,taskId,session])
  for(const row of linked.rows)await new ExperiencePlanLifecycleRepository(tx).lockByCue(row.id)
 }
 const row=await tx.query(`SELECT task.id FROM mbox.service_tasks task JOIN mbox.table_sessions session ON session.tenant_id=task.tenant_id AND session.store_id=task.store_id AND session.id=task.table_session_id
 WHERE task.tenant_id=$1::uuid AND task.store_id=$2::uuid AND task.id=$3::uuid AND task.table_session_id=$4::uuid AND task.task_type=$5
 AND ($7::boolean OR task.assigned_employee_id=$6::uuid OR task.backup_employee_id=$6::uuid OR (task.assigned_employee_id IS NULL AND task.requested_role_code=ANY($8::text[])) OR EXISTS(SELECT 1 FROM mbox.table_assignments a WHERE a.tenant_id=task.tenant_id AND a.store_id=task.store_id AND a.table_id=session.table_id AND a.employee_id=$6::uuid AND a.starts_at<=clock_timestamp() AND (a.ends_at IS NULL OR a.ends_at>clock_timestamp()))) FOR UPDATE OF task`,[context.scope.tenantId,context.scope.storeId,taskId,session,taskType,context.employeeId,access.permissions.includes('table.view_all'),access.roleCodes])
 if(row.rowCount!==1)throw new ServiceTaskNotFoundError(taskId)
}
