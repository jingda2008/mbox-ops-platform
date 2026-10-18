import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { TableManagementApiOptions } from './table-management-api.js'
import { TableServiceRepository, TableServiceConflict, TableServiceNotFound } from './table-service-repository.js'
import { StaffAccessRepository, StaffAccessDeniedError, StaffNotFoundError } from './staff-access-repository.js'
import { NormalizedAuthenticationRequiredError, TrustedStoreScopeError, NormalizedStoreUnavailableError } from './normalized-request-context.js'
import { NativeCommandNotCommittedError, IdempotencyConflictError, IdempotencyInProgressError, type JsonObject, type JsonCodec } from './command-executor.js'
const page=z.coerce.number().int().min(0).max(100000).default(0)
const codec:JsonCodec<JsonObject>={encode:v=>v,decode:v=>z.record(z.string(),z.unknown()).parse(v) as JsonObject}
export function registerTableService(app:FastifyInstance,options:TableManagementApiOptions) {
 // These minimal read models are explicitly available to every active employee in
 // the authenticated store. Existing financial and mutation scopes stay intact.
 app.get('/table-service/tables',async(request,reply)=>{
  try {const c=await options.resolveContext(request)
   const data=await options.transactions.run(c.scope,async tx=>{await new StaffAccessRepository(tx).resolve(c.employeeId);return new TableServiceRepository(tx).tables()},{readOnly:true})
   return reply.header('cache-control','no-store').send({data})
  }catch(e){return failure(reply,e)}
 })
 app.get<{Params:{tableId:string}}>('/table-service/tables/:tableId/options',async(request,reply)=>{
  try {const c=await options.resolveContext(request),id=z.uuid().parse(request.params.tableId)
   const data=await options.transactions.run(c.scope,async tx=>{await new StaffAccessRepository(tx).resolve(c.employeeId);return new TableServiceRepository(tx).options(id)},{readOnly:true})
   return reply.header('cache-control','no-store').send({data})
  }catch(e){return failure(reply,e)}
 })
 app.get<{Params:{tableId:string}}>('/table-service/tables/:tableId/sessions',async(request,reply)=>{
  try {const c=await options.resolveContext(request),id=z.uuid().parse(request.params.tableId),q=z.object({page}).strict().parse(request.query)
   const data=await options.transactions.run(c.scope,async tx=>{await new StaffAccessRepository(tx).resolve(c.employeeId);return new TableServiceRepository(tx).sessions(id,q.page)},{readOnly:true})
   return reply.header('cache-control','no-store').send({data})
  }catch(e){return failure(reply,e)}
 })
 app.get<{Params:{sessionId:string}}>('/table-service/sessions/:sessionId',async(request,reply)=>{
  try {const c=await options.resolveContext(request),id=z.uuid().parse(request.params.sessionId),q=z.object({changesPage:page,activitiesPage:page}).strict().parse(request.query)
   const data=await options.transactions.run(c.scope,async tx=>{await new StaffAccessRepository(tx).resolve(c.employeeId);return new TableServiceRepository(tx).detail(id,q.changesPage,q.activitiesPage)},{readOnly:true,isolation:'repeatable-read'})
   return reply.header('cache-control','no-store').send({data})
  }catch(e){return failure(reply,e)}
 })
 app.post<{Params:{sessionId:string}}>('/table-service/sessions/:sessionId/handover',async(request,reply)=>{
  try {
   if(!options.nativeCommands)throw new Error('Command executor unavailable')
   const c=await options.resolveContext(request),id=z.uuid().parse(request.params.sessionId)
   const input=z.object({employeeId:z.uuid(),expectedRevision:z.number().int().min(0),reason:z.string().trim().min(2).max(1000)}).strict().parse(request.body)
   const key=z.string().min(8).max(128).parse(request.headers['idempotency-key'])
   const result=await options.nativeCommands.execute({scope:c.scope,operationScope:'table.service.handover',idempotencyKey:key,
    requestFingerprint:createHash('sha256').update(JSON.stringify({id,input,actor:c.employeeId})).digest('hex'),retainReceipt:true,resultCodec:codec},async tx=>{
     const value=await new TableServiceRepository(tx).handover(id,input.employeeId,c.employeeId,input.expectedRevision,input.reason)
     return {result:value,auditEvents:[{actor:{type:'employee',employeeId:c.employeeId},action:'table.service.handover',objectType:'table_session',objectId:id,businessDate:c.businessDate,reason:input.reason,afterData:value}],
      outboxMessages:[{aggregateType:'table_session_service',aggregateId:id,aggregateVersion:value.revision,eventType:'table.service.handover.v1',payload:value}]}
    },async tx=>{
     const live=await options.resolveContext(request)
     if(live.employeeId!==c.employeeId||live.scope.storeId!==c.scope.storeId||live.scope.tenantId!==c.scope.tenantId)throw new NormalizedAuthenticationRequiredError()
     await new StaffAccessRepository(tx).assertPermission(c.employeeId,'table.assignment.manage')
    })
   return reply.send({data:result.value,meta:{replayed:result.replayed}})
  }catch(e){return failure(reply,e)}
 })
}
function failure(reply:FastifyReply,e:unknown) {
 if(e instanceof NativeCommandNotCommittedError){requestError(e.original);return reply.code(409).send({error:{code:'TABLE_SERVICE_NOT_COMMITTED',message:'交接未提交：请刷新确认桌次、人员和当前负责人',commitDisposition:'not_committed'}})}
 if(e instanceof NormalizedAuthenticationRequiredError)return reply.code(401).send({error:{code:'AUTH_REQUIRED',message:'请重新登录员工账号'}})
 if(e instanceof StaffAccessDeniedError||e instanceof StaffNotFoundError||e instanceof TrustedStoreScopeError||e instanceof NormalizedStoreUnavailableError)return reply.code(403).send({error:{code:'TABLE_SERVICE_FORBIDDEN',message:'当前员工或门店不可用，或没有交接权限'}})
 if(e instanceof TableServiceNotFound)return reply.code(404).send({error:{code:'TABLE_SERVICE_NOT_FOUND',message:e.message}})
 if(e instanceof z.ZodError)return reply.code(400).send({error:{code:'TABLE_SERVICE_INVALID',message:'请核对桌次、员工、交接原因和请求参数'}})
 if(e instanceof TableServiceConflict||e instanceof IdempotencyConflictError||e instanceof IdempotencyInProgressError||(e!==null&&typeof e==='object'&&'code' in e&&['P2701','P2702','40001','23505'].includes(String(e.code))))return reply.code(409).send({error:{code:'TABLE_SERVICE_CONFLICT',message:e instanceof TableServiceConflict?e.message:'人员或交接状态已变化，请刷新核对并保留原请求'}})
 requestError(e)
 return reply.code(500).send({error:{code:'TABLE_SERVICE_UNAVAILABLE',message:'服务记录暂不可用，请重试；交接请保留原请求核对'}})
}
function requestError(e:unknown){if(process.env.NODE_ENV==='test')process.stderr.write(`table-service: ${e instanceof Error?e.message:'unknown error'}\n`)}
