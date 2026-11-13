import { channelStoreLimitsSchema } from '../../src/shared/channel-distribution.js'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { ChannelApiOptions } from './channel-distribution-api.js'
import { ChannelOperationsRepository } from './channel-operations-repository.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import { assertEmployeeTableSessionAccess } from './employee-table-access.js'
import type { ScopedTransaction } from './transaction-runner.js'
import type { JsonCodec,JsonValue } from './command-executor.js'
const uuid=z.string().uuid(),reason=z.string().trim().min(2).max(500)
const inputSchema=z.discriminatedUnion('action',[
 channelStoreLimitsSchema,
 z.object({action:z.literal('campaign'),id:uuid,enabled:z.boolean(),staff:z.boolean(),self:z.boolean(),reason}).strict(),
 z.object({action:z.literal('publish'),id:uuid,enabled:z.boolean(),reason}).strict(),
 z.object({action:z.literal('promoter'),id:uuid,enabled:z.boolean(),confirm:z.boolean(),restaurantScope:z.boolean(),contactEmployeeId:uuid,reason}).strict(),
 z.object({action:z.literal('void'),id:uuid,reason}).strict(),z.object({action:z.literal('revoke'),id:uuid,reason}).strict(),
 z.object({action:z.literal('extend'),id:uuid,until:z.iso.datetime({offset:true}),reason}).strict(),
 z.object({action:z.literal('replace-gift'),id:uuid,productId:uuid,quantity:z.number().int().min(1).max(100),consent:reason,until:z.iso.datetime({offset:true}).optional(),reason}).strict(),
 z.object({action:z.literal('arrival'),tableSessionId:uuid,reason}).strict(),
 z.object({action:z.literal('continuity'),tableSessionId:uuid,previousVisitId:uuid,customerId:uuid,mode:z.enum(['new','continue']),reason}).strict(),
 z.object({action:z.literal('correct-orders'),orderIds:z.array(z.string().trim().min(1).max(128)).min(1).max(100).refine(ids=>new Set(ids).size===ids.length),batchId:uuid,reason}).strict(),
])
export function registerChannelOperationsRoutes(app:FastifyInstance,options:ChannelApiOptions){
 app.post('/staff/channel/operations',{bodyLimit:16384},async request=>{
  const ctx=await options.resolveStaffContext(request),input=inputSchema.parse(request.body)
  const permission=['void','revoke','extend','replace-gift','correct-orders','continuity'].includes(input.action)?'channel.correct':input.action==='arrival'?'channel.activate':'channel.manage'
  const authorize=async(tx:ScopedTransaction)=>{await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,permission);if(input.action==='arrival'||input.action==='continuity')await assertEmployeeTableSessionAccess(tx,{employeeId:ctx.employeeId,tableSessionId:input.tableSessionId,requiredPermissionCodes:['channel.activate']})}
  const codec:JsonCodec<unknown>={encode:v=>v as JsonValue,decode:v=>v}
  const result=await options.commands.execute({scope:ctx.scope,operationScope:'channel.operations',idempotencyKey:z.string().regex(/^channel-[a-zA-Z0-9_-]{16,100}$/).parse(request.headers['idempotency-key']),requestFingerprint:JSON.stringify({input,employeeId:ctx.employeeId}),resultCodec:codec,retainReceipt:true,rejectExpiredReceipt:true,replayOnly:request.headers['x-channel-recovery']==='1',authorizeReplay:authorize},async tx=>{
   const repo=new ChannelOperationsRepository(tx);let value:unknown
   switch(input.action){
    case'limits':value=await repo.limits(input.claimLimit,input.capacityLimit,input.costLimitMinor,ctx.employeeId,input.reason);break
    case'campaign':value=await repo.campaign(input.id,input.enabled,input.staff,input.self,ctx.employeeId,input.reason);break
    case'publish':value=await repo.publish(input.id,input.enabled,ctx.employeeId,input.reason);break
    case'promoter':value=await repo.promoter(input.id,input.enabled,input.confirm,input.restaurantScope,input.contactEmployeeId,ctx.employeeId,input.reason);break
    case'arrival':value=await repo.arrival(input.tableSessionId,ctx.employeeId,input.reason);break
    case'continuity':value=await repo.continuity(input.tableSessionId,input.previousVisitId,input.customerId,input.mode,ctx.employeeId,input.reason);break
    case'correct-orders':value=await repo.correctOrders(input.orderIds,input.batchId,ctx.employeeId,input.reason);break
    default:value=await repo.claim(input.id,input.action,ctx.employeeId,input.reason,input.action==='extend'||input.action==='replace-gift'?input:{})
   }
   return{result:value,auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},businessDate:ctx.businessDate,action:`channel.operations.${input.action}`,objectType:'channel_operation',objectId:'id'in input?input.id:ctx.scope.storeId,reason:input.reason}],outboxMessages:[]}
  },authorize);return{data:result.value,meta:{replayed:result.replayed}}
 })
}
