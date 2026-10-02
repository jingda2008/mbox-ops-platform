import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { TableManagementApiOptions } from './table-management-api.js'
import { NativeCommandNotCommittedError, IdempotencyConflictError, IdempotencyInProgressError, type JsonCodec, type JsonObject } from './command-executor.js'
import { StaffAccessRepository, StaffAccessDeniedError, StaffNotFoundError } from './staff-access-repository.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import type { ScopedTransaction } from './transaction-runner.js'

const permission='table.assignment.manage'
const inputSchema=z.object({kind:z.enum(['update','cancel']),id:z.uuid(),expected:z.string().regex(/^[a-f0-9]{64}$/),
  reason:z.string().trim().min(2).max(1000),
  schedule:z.object({employeeId:z.uuid(),roleId:z.uuid(),assignmentType:z.enum(['primary','backup','temporary']),
    startsAt:z.iso.datetime({offset:true}),endsAt:z.iso.datetime({offset:true}).nullable()}).strict().optional()}).strict()
const querySchema=z.object({mode:z.enum(['future','history','cancelled']).default('future'),page:z.coerce.number().int().min(0).max(10000).default(0)}).strict()
const fields=['id','tableId','employeeId','roleId','assignmentType','startsAt','endsAt','updatedAt','cancelledAt']
function fingerprint(row:JsonObject) {return createHash('sha256').update(JSON.stringify(fields.map(k=>row[k]??null))).digest('hex')}
const columns=`a.id,a.table_id AS "tableId",t.code AS "tableCode",a.employee_id AS "employeeId",e.display_name AS "employeeName",
 a.role_id AS "roleId",r.code AS "roleCode",a.assignment_type AS "assignmentType",a.starts_at::text AS "startsAt",a.ends_at::text AS "endsAt",
 a.reason,a.updated_at::text AS "updatedAt",a.cancelled_at::text AS "cancelledAt",a.cancellation_reason AS "cancellationReason"`
const joins=`FROM mbox.table_assignments a JOIN mbox.tables t ON t.tenant_id=a.tenant_id AND t.store_id=a.store_id AND t.id=a.table_id
 JOIN mbox.employees e ON e.tenant_id=a.tenant_id AND e.store_id=a.store_id AND e.id=a.employee_id
 JOIN mbox.roles r ON r.tenant_id=a.tenant_id AND r.store_id=a.store_id AND r.id=a.role_id`
const codec:JsonCodec<JsonObject>={encode:v=>v,decode:v=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new TypeError('排班回执无效');return v as JsonObject}}
async function one(tx:ScopedTransaction,id:string,lock=false) {
 return (await tx.query<JsonObject>(`SELECT ${columns} ${joins} WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.id=$3 ${lock?'FOR UPDATE OF a':''}`,[tx.scope.tenantId,tx.scope.storeId,id])).rows[0]
}
export async function registerNativeAssignmentSchedule(app:FastifyInstance,options:TableManagementApiOptions) {
 const commands=options.nativeCommands
 if(!commands)return
 app.get('/table-management/native-assignment-schedule',async(request,reply)=>{
  try {
   const context=await options.resolveContext(request),query=querySchema.parse(request.query)
   const data=await options.transactions.run(context.scope,async tx=>{
    await new StaffAccessRepository(tx).assertPermission(context.employeeId,permission)
    const condition=query.mode==='future'?'a.cancelled_at IS NULL AND a.starts_at>clock_timestamp()':query.mode==='history'?'a.cancelled_at IS NULL AND a.ends_at<=clock_timestamp()':'a.cancelled_at IS NOT NULL'
    const rows=(await tx.query<JsonObject>(`SELECT ${columns} ${joins} WHERE a.tenant_id=$1 AND a.store_id=$2 AND ${condition}
      ORDER BY a.starts_at ${query.mode==='future'?'ASC':'DESC'},a.id LIMIT 51 OFFSET $3`,[context.scope.tenantId,context.scope.storeId,query.page*50])).rows
    return {employeeId:context.employeeId,mode:query.mode,page:query.page,hasMore:rows.length>50,rows:rows.slice(0,50).map(row=>({...row,configurationFingerprint:fingerprint(row)}))}
   },{readOnly:true})
   return reply.header('cache-control','no-store').send({data})
  } catch(e){return failure(reply,e)}
 })
 app.post('/table-management/native-assignment-schedule/commands',async(request,reply)=>{
  try {
   const context=await options.resolveContext(request),input=inputSchema.parse(request.body)
   if((input.kind==='update')!==Boolean(input.schedule))throw new TypeError('修改排班需完整起止时间和责任人；取消不接受排班字段')
   const key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key'])
   const execution=await commands.execute({scope:context.scope,operationScope:`native.assignment.${input.kind}`,idempotencyKey:key,
    requestFingerprint:createHash('sha256').update(JSON.stringify({input,employeeId:context.employeeId})).digest('hex'),retainReceipt:true,resultCodec:codec},async tx=>{
    // Use the same table-first lock order as ordinary assignment creation.
    const candidate=await one(tx,input.id)
    if(!candidate)throw new Error('排班不存在')
    await tx.query('SELECT id FROM mbox.tables WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[context.scope.tenantId,context.scope.storeId,candidate.tableId])
    const before=await one(tx,input.id,true)
    if(!before||before.cancelledAt!==null||fingerprint(before)!==input.expected)throw new Error('排班已变化，请刷新')
    if(input.kind==='cancel') {
      const changed=await tx.query(`UPDATE mbox.table_assignments SET ends_at=starts_at,cancelled_at=clock_timestamp(),
        cancelled_by_employee_id=$4,cancellation_reason=$5 WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND starts_at>clock_timestamp() AND cancelled_at IS NULL`,
        [context.scope.tenantId,context.scope.storeId,input.id,context.employeeId,input.reason])
      if(changed.rowCount!==1)throw new Error('已生效责任只能结束，不能取消未来排班')
    } else {
      const s=input.schedule!
      if(s.endsAt!==null&&Date.parse(s.endsAt)<=Date.parse(s.startsAt))throw new Error('结束时间必须晚于开始时间')
      const valid=await tx.query(`SELECT 1 FROM mbox.employees e,mbox.roles r,mbox.tables t,mbox.areas area
        WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.id=$3 AND e.status='active'
        AND r.tenant_id=$1 AND r.store_id=$2 AND r.id=$4 AND r.status='active'
        AND t.tenant_id=$1 AND t.store_id=$2 AND t.id=$5 AND t.status='available'
        AND area.tenant_id=$1 AND area.store_id=$2 AND area.id=t.area_id AND area.status='active'`,
        [context.scope.tenantId,context.scope.storeId,s.employeeId,s.roleId,before.tableId])
      if(valid.rowCount!==1)throw new Error('桌台、区域、员工或岗位已停用')
      const changed=await tx.query(`UPDATE mbox.table_assignments SET employee_id=$4,role_id=$5,assignment_type=$6,starts_at=$7,ends_at=$8,reason=$9
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND starts_at>clock_timestamp() AND $7::timestamptz>clock_timestamp() AND cancelled_at IS NULL`,
        [context.scope.tenantId,context.scope.storeId,input.id,s.employeeId,s.roleId,s.assignmentType,s.startsAt,s.endsAt,input.reason])
      if(changed.rowCount!==1)throw new Error('排班已生效或新开始时间不是未来时间')
    }
    const row=(await one(tx,input.id))!
    const result:JsonObject={kind:input.kind,employeeId:context.employeeId,reason:input.reason,previousFingerprint:input.expected,row}
    return {result,auditEvents:[{actor:{type:'employee' as const,employeeId:context.employeeId},action:`native.assignment.${input.kind}`,
      objectType:'table_assignment',objectId:input.id,businessDate:context.businessDate,reason:input.reason,beforeData:before,afterData:result}],
      outboxMessages:[{eventId:`native-assignment:${key}`,aggregateType:'table_assignment',aggregateId:input.id,aggregateVersion:1,
        eventType:`table.assignment.${input.kind==='cancel'?'cancelled':'updated'}.v1`,payload:result}]}
   },async tx=>{
    const current=await options.resolveContext(request)
    if(current.employeeId!==context.employeeId||current.scope.storeId!==context.scope.storeId||current.scope.tenantId!==context.scope.tenantId)throw new NormalizedAuthenticationRequiredError()
    await new StaffAccessRepository(tx).assertPermission(context.employeeId,permission)
   })
   return reply.send({data:execution.value,meta:{replayed:execution.replayed}})
  }catch(e){return failure(reply,e)}
 })
}
function failure(reply:import('fastify').FastifyReply,e:unknown) {
 if(e instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:'排班未提交：可能已生效、被修改或责任时段冲突。请刷新核对',commitDisposition:'not_committed'}})
 if(e instanceof StaffAccessDeniedError||e instanceof StaffNotFoundError)return reply.code(403).send({error:{code:'ASSIGNMENT_FORBIDDEN',message:'无责任排班管理权限'}})
 if(e instanceof NormalizedAuthenticationRequiredError)return reply.code(401).send({error:{code:'AUTH_REQUIRED',message:'请重新登录'}})
 if(e instanceof z.ZodError||e instanceof TypeError)return reply.code(400).send({error:{code:'ASSIGNMENT_INVALID',message:'请核对排班时间、人员、原因和原请求'}})
 if(e instanceof IdempotencyConflictError||e instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'ASSIGNMENT_CONFLICT',message:'请保留原请求恢复结果'}})
 return reply.code(500).send({error:{code:'ASSIGNMENT_UNAVAILABLE',message:'排班服务暂不可用，请保留原请求'}})
}
