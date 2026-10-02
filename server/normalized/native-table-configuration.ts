import {z} from 'zod'
import type {FastifyInstance,FastifyReply} from 'fastify'
import type {TableManagementApiOptions} from './table-management-api.js'
import {TableManagementRepository,TableManagementCommandService,TableManagementConflictError,TableManagementNotFoundError} from './table-management-repository.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
import {nativeGuardedExecutor} from './native-guarded-executor.js'
import {NativeCommandNotCommittedError,IdempotencyConflictError,IdempotencyInProgressError} from './command-executor.js'
import {isStaffAuthenticationRequiredError,STAFF_AUTHENTICATION_REQUIRED_ERROR} from './staff-api-authentication.js'
const uuid=z.string().uuid(),reason=z.string().trim().min(2).max(500),stamp=z.string().min(10).max(64)
const areaFields={name:z.string().trim().min(1).max(120),areaType:z.enum(['indoor','outdoor','bar','stage','vip','other']),sortOrder:z.number().int().min(-100000).max(100000),status:z.enum(['active','paused','retired']),reason}
const tableFields={areaId:uuid,code:z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/),displayName:z.string().trim().min(1).max(120),capacity:z.number().int().min(1).max(200),minimumSpendMinor:z.number().int().min(0).max(100000000).nullable(),status:z.enum(['available','paused','retired']),reason}
const schemas={
 'area-create':z.object({...areaFields,code:z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/)}).strict(),
 'area-update':z.object({...areaFields,areaId:uuid,expectedUpdatedAt:stamp}).strict(),
 'table-create':z.object(tableFields).strict(),
 'table-update':z.object({...tableFields,tableId:uuid,expectedUpdatedAt:stamp}).strict(),
}
async function handle(reply:FastifyReply,run:()=>Promise<unknown>){try{return reply.send(await run())}catch(error){
 if(isStaffAuthenticationRequiredError(error))return reply.code(401).send({error:STAFF_AUTHENTICATION_REQUIRED_ERROR})
 if(error instanceof StaffAccessDeniedError)return reply.code(403).send({error:{code:'TABLE_CONFIGURATION_FORBIDDEN',message:'当前岗位没有桌台配置权限'}})
 if(error instanceof NativeCommandNotCommittedError)return reply.code(409).send({error:{code:'NATIVE_BUSINESS_NOT_COMMITTED',message:error.original instanceof TableManagementConflictError||error.original instanceof TableManagementNotFoundError?error.original.message:'配置变化或编号冲突，本次未提交，请刷新核对',commitDisposition:'not_committed'}})
 if(error instanceof z.ZodError||error instanceof TypeError)return reply.code(400).send({error:{code:'TABLE_CONFIGURATION_INVALID',message:'请核对名称、编号、容量、原版本和修改原因'}})
 if(error instanceof IdempotencyConflictError||error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'TABLE_CONFIGURATION_CONFLICT',message:'原请求仍在处理或内容不同，请保留原请求核对'}})
 throw error
}}
export function registerNativeTableConfiguration(app:FastifyInstance,options:TableManagementApiOptions){
 app.get('/table-management/native-configuration',async(request,reply)=>handle(reply,async()=>{
  reply.header('Cache-Control','private, no-store');const ctx=await options.resolveContext(request)
  const data=await options.transactions.run(ctx.scope,async tx=>{
   const access=await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'table.manage'),repo=new TableManagementRepository(tx)
   const areas=await repo.listAreas(access),tables=await repo.listTables(access)
   return{employeeId:ctx.employeeId,protocol:1,durableCommands:!!options.nativeCommands,areas,tables}
  },{readOnly:true,isolation:'repeatable-read'});return{data}
 }))
 app.post<{Params:{action:string}}>('/table-management/native-configuration/:action',{bodyLimit:12000},async(request,reply)=>handle(reply,async()=>{
  const action=z.enum(['area-create','area-update','table-create','table-update']).parse(request.params.action)
  const parsed=schemas[action].safeParse(request.body)
  const key=z.string().regex(/^native-business-[a-f0-9-]{36}$/).parse(request.headers['idempotency-key']),ctx=await options.resolveContext(request)
  if(!options.nativeCommands)return reply.code(503).send({error:{code:'NATIVE_CONFIGURATION_UNAVAILABLE',message:'后台尚未支持原生配置恢复'}})
  if(!parsed.success){
   // Claim the SAME domain key before classifying an invalid request. An old
   // committed request with changed content must remain a conflict, not clearable.
   const scopes={'area-create':'table.area.create','area-update':'table.area.update','table-create':'table.create','table-update':'table.update'}
   const invalid=nativeGuardedExecutor(options.nativeCommands,{fingerprint:{employeeId:ctx.employeeId,action,input:request.body},authorize:async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'table.manage')}})
   const result=await invalid.execute({scope:ctx.scope,operationScope:scopes[action],idempotencyKey:key,requestFingerprint:'invalid',resultCodec:{encode:v=>v as never,decode:v=>v}},async()=>{throw new TypeError('区域排序须在-100000至100000之间，请核对配置字段')})
   return{data:{employeeId:ctx.employeeId,requestKey:key,action,result:result.value},meta:{protocol:1,replayed:result.replayed}}
  }
  const input=parsed.data
  const service=new TableManagementCommandService(nativeGuardedExecutor(options.nativeCommands,{fingerprint:{employeeId:ctx.employeeId,action,input},authorize:async tx=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'table.manage')},guard:async tx=>{
   const args=[ctx.scope.tenantId,ctx.scope.storeId]
   // Follow existing open/transfer order: table rows before active session checks.
   if(action==='table-update'){
    const v=schemas['table-update'].parse(input)
    const row=(await tx.query<{updated_at:string}>(`SELECT updated_at::text FROM mbox.tables WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...args,v.tableId])).rows[0]
    if(!row||row.updated_at!==v.expectedUpdatedAt)throw new TableManagementConflictError('此桌配置已变化，请刷新后再改')
    const active=await tx.query(`SELECT id FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND table_id=$3 AND status IN ('open','closing')`,[...args,v.tableId])
    if(active.rowCount)throw new TableManagementConflictError('此桌正在营业，请完成原桌次后再调整桌号、区域、容量或状态')
   }
   if(action==='area-update'){
    const v=schemas['area-update'].parse(input)
    // Lock child tables first so an in-flight opening cannot race a pause.
    await tx.query(`SELECT id FROM mbox.tables WHERE tenant_id=$1 AND store_id=$2 AND area_id=$3 ORDER BY id FOR UPDATE`,[...args,v.areaId])
    const row=(await tx.query<{updated_at:string}>(`SELECT updated_at::text FROM mbox.areas WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...args,v.areaId])).rows[0]
    if(!row||row.updated_at!==v.expectedUpdatedAt)throw new TableManagementConflictError('区域配置已变化，请刷新后再改')
    if(v.status!=='active'){
     const used=await tx.query(`SELECT 1 FROM mbox.table_sessions s JOIN mbox.tables t ON t.tenant_id=s.tenant_id AND t.store_id=s.store_id AND t.id=s.table_id WHERE t.tenant_id=$1 AND t.store_id=$2 AND t.area_id=$3 AND s.status IN ('open','closing') LIMIT 1`,[...args,v.areaId])
     if(used.rowCount)throw new TableManagementConflictError('区域仍有营业中桌次，不能暂停或停用')
    }
   }
  }}))
  const base={scope:ctx.scope,actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,reason:input.reason,idempotencyKey:key,requestFingerprint:JSON.stringify(input)}
  const result=await(async()=>{
   if(action==='area-create')return service.createArea({...base,...schemas['area-create'].parse(input)})
   if(action==='area-update')return service.updateArea({...base,...schemas['area-update'].parse(input)})
   if(action==='table-create')return service.createTable({...base,...schemas['table-create'].parse(input),currency:'CNY'})
   return service.updateTable({...base,...schemas['table-update'].parse(input),currency:'CNY'})
  })()
  return{data:{employeeId:ctx.employeeId,requestKey:key,action,result:result.value},meta:{protocol:1,replayed:result.replayed}}
 }))
}
