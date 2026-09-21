import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyReply} from 'fastify'
import {parsePickupCommand,parsePickupDeviceCommand,parsePickupRecoveryCommand,type PickupBoardData,type PickupCommandResult} from '../../src/shared/pickup-workflow.js'
import type {CommerceKdsApiOptions} from './commerce-kds-api.js'
import {IdempotencyConflictError,IdempotencyInProgressError,type JsonCodec,type JsonValue} from './command-executor.js'
import {authorizePickup,authorizePickupRecovery,configurePickupDevice,executePickupCommand} from './pickup-workflow-repository.js'
import {PickupWorkflowError,readPickupBoard,initializeLegacyPickupUnits} from './pickup-workflow-query.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'
import {NormalizedAuthenticationRequiredError,TrustedStoreScopeError} from './normalized-request-context.js'
import {StaffSessionNotFoundError} from './staff-session-repository.js'

export type PickupWorkflowApiOptions=Pick<CommerceKdsApiOptions,'resolveContext'|'staffAccessTransactions'|'commandExecutor'>&{enabled?:boolean}
const resultCodec:JsonCodec<PickupCommandResult>={encode:value=>value as unknown as JsonValue,decode:value=>value as unknown as PickupCommandResult}
const boardCodec:JsonCodec<PickupBoardData>={encode:value=>value as unknown as JsonValue,decode:value=>value as unknown as PickupBoardData}
export const pickupWorkflowApiPlugin:FastifyPluginAsync<PickupWorkflowApiOptions>=async(app,options)=>{
  app.get('/commerce/pickup-board',async(request,reply)=>route(reply,async()=>{
    const context=await options.resolveContext(request)
    // This bounded adoption takes the same parent locks as production. The displayed snapshot is read separately.
    await options.staffAccessTransactions.run(context.scope,tx=>initializeLegacyPickupUnits(tx,context))
    const data=await options.staffAccessTransactions.run(context.scope,tx=>readPickupBoard(tx,context,options.enabled===true),{isolation:'repeatable-read',readOnly:true})
    return reply.send({data})
  }))
  app.post('/commerce/pickup-board/commands',async(request,reply)=>route(reply,async()=>{
    const context=await options.resolveContext(request),command=parsePickupCommand(request.body),key=readKey(request.headers['idempotency-key'])
    const access=await options.staffAccessTransactions.run(context.scope,tx=>authorizePickup(tx,context))
    const execution=await options.commandExecutor.execute({scope:context.scope,operationScope:'commerce.pickup',idempotencyKey:operationKey(access.commandScope,key),requestFingerprint:JSON.stringify({scope:access.commandScope,command}),resultCodec},
      tx=>executePickupCommand(tx,context,command,key,request.id,options.enabled===true))
    return reply.send({data:{...execution.value,replayed:execution.replayed||execution.value.replayed}})
  }))
  app.post('/commerce/pickup-board/device',async(request,reply)=>route(reply,async()=>{
    const context=await options.resolveContext(request),command=parsePickupDeviceCommand(request.body),key=readKey(request.headers['idempotency-key'])
    const access=await options.staffAccessTransactions.run(context.scope,tx=>authorizePickup(tx,context,true))
    const execution=await options.commandExecutor.execute({scope:context.scope,operationScope:'commerce.pickup.device',idempotencyKey:operationKey(access.commandScope,key),requestFingerprint:JSON.stringify({scope:access.commandScope,command}),resultCodec:boardCodec},
      tx=>configurePickupDevice(tx,context,command,key,request.id,options.enabled===true))
    return reply.send({data:execution.value,replayed:execution.replayed})
  }))
  app.post('/commerce/pickup-board/recovery',async(request,reply)=>route(reply,async()=>{
    const context=await options.resolveContext(request),recovery=parsePickupRecoveryCommand(request.body)
    const originalScope=await options.staffAccessTransactions.run(context.scope,tx=>authorizePickupRecovery(tx,context,recovery))
    const key=recovery.idempotencyKey,command=recovery.request.command
    const base={scope:context.scope,idempotencyKey:operationKey(originalScope,key),requestFingerprint:JSON.stringify({scope:originalScope,command})}
    if(recovery.request.kind==='command'){
      const original=recovery.request.command
      const execution=await options.commandExecutor.execute({...base,operationScope:'commerce.pickup',resultCodec},tx=>executePickupCommand(tx,context,original,key,request.id,options.enabled===true,recovery))
      return reply.send({data:{kind:'command',data:{...execution.value,replayed:execution.replayed||execution.value.replayed}}})
    }
    const original=recovery.request.command
    const execution=await options.commandExecutor.execute({...base,operationScope:'commerce.pickup.device',resultCodec:boardCodec},tx=>configurePickupDevice(tx,context,original,key,request.id,options.enabled===true,recovery))
    return reply.send({data:{kind:'device',data:execution.value}})
  }))
}
function operationKey(scope:string,key:string){return createHash('sha256').update(`${scope}:${key}`).digest('hex')}
function readKey(value:unknown){if(typeof value!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(value))throw new TypeError('请保留原操作凭据后重试');return value}
async function route(reply:FastifyReply,operation:()=>Promise<unknown>){
  try{return await operation()}catch(error){
    if(error instanceof TypeError)return reply.code(400).send({error:{code:'PICKUP_INVALID',message:error.message,commitDisposition:'not_committed'}})
    if(error instanceof PickupWorkflowError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message,commitDisposition:error.statusCode===403?'unknown':'not_committed'}})
    if(error instanceof ItemQuantityConflict)return reply.code(error.code==='QUANTITY_INVALID'?400:409).send({error:{code:error.code==='QUANTITY_INVALID'?'PICKUP_INVALID':'PICKUP_STALE',message:error.message,commitDisposition:'not_committed'}})
    if(error instanceof NormalizedAuthenticationRequiredError||error instanceof StaffSessionNotFoundError||error instanceof TrustedStoreScopeError)return reply.code(error instanceof NormalizedAuthenticationRequiredError?401:403).send({error:{code:'PICKUP_SESSION_INVALID',message:'登录已失效，请重新登录后核对原操作',commitDisposition:'unknown'}})
    if(error instanceof IdempotencyConflictError)return reply.code(409).send({error:{code:'IDEMPOTENCY_CONFLICT',message:'原操作凭据与内容不一致，请保留原记录核对',commitDisposition:'not_committed'}})
    if(error instanceof IdempotencyInProgressError)return reply.code(409).send({error:{code:'IDEMPOTENCY_IN_PROGRESS',message:'原操作正在确认，请保留原操作稍后读取',commitDisposition:'unknown'}})
    const status=(error as {statusCode?:number})?.statusCode
    if(status===401||status===403)return reply.code(status).send({error:{code:'PICKUP_SESSION_INVALID',message:'登录权限已变化，请登录后核对原操作',commitDisposition:'unknown'}})
    // Serialization, connection failure and lost acknowledgement cannot prove a command did not commit.
    reply.log.error({err:error},'pickup workflow request failed')
    return reply.code(503).send({error:{code:'PICKUP_TEMPORARILY_UNAVAILABLE',message:'暂时无法确认结果，请保留原操作并重新读取',commitDisposition:'unknown'}})
  }
}
