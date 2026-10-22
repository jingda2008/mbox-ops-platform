import {createHash} from 'node:crypto'
import type {FastifyInstance,FastifyReply} from 'fastify'
import type {ActivityProductionCommand,ActivityProductionResult} from '../../src/shared/activity-service.js'
import type {ActivityProductionRecovery} from '../../src/shared/activity-production-recovery.js'
import {ActivityServiceRepository,ActivityServiceError} from './activity-service-repository.js'
import {NormalizedKdsAuthorization} from './kds-authorization-policy.js'
import {authorizePickup,authorizePickupRecovery} from './pickup-workflow-repository.js'
import {PickupWorkflowError} from './pickup-workflow-query.js'
import {handleCommerceRoute,type CommerceKdsApiOptions,type CommerceKdsRequestContext} from './commerce-kds-api.js'
import {NativeCommandNotCommittedError,type JsonValue} from './command-executor.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {registerActivityServiceExceptionRoutes} from './activity-service-exception-api.js'
type Options=Pick<CommerceKdsApiOptions,'resolveContext'|'staffAccessTransactions'|'commandExecutor'>
const digest=(value:string)=>createHash('sha256').update(value).digest('hex')
export async function registerActivityProductionRoutes(app:FastifyInstance,options:Options) {
  await registerActivityServiceExceptionRoutes(app,options)
  app.get('/commerce/activity-service/board',async(request,reply)=>route(reply,async()=>{
    const context=await options.resolveContext(request),station=(request.query as {station?:string}).station??'kitchen'
    if(!['bar','kitchen','pickup'].includes(station))throw new TypeError('请选择实际岗位')
    const data=await options.staffAccessTransactions.run(context.scope,async tx=>{
      let commandScope=`activity:${context.scope.storeId}:${context.employeeId}`,recoveryMetadata={}
      if(station==='pickup'){
        const access=await authorizePickup(tx,context);commandScope=access.commandScope
        recoveryMetadata={staffSessionId:context.staffSessionId,recoveryNamespace:digest(JSON.stringify([context.scope.tenantId,context.scope.storeId,context.employeeId,access.device!.id]))}
      }else await new NormalizedKdsAuthorization().assertCanActOnTask({transaction:tx,...context,action:'start',stationCode:station,tableId:''})
      const repository=new ActivityServiceRepository(tx)
      return {commandScope,...recoveryMetadata,activityItems:await repository.lines(station==='pickup'?{pickup:true}:{station:station as 'bar'|'kitchen'}),receipts:station==='pickup'?await repository.receipts():[]}
    })
    return reply.send({data})
  }))
  async function execute(context:CommerceKdsRequestContext,command:ActivityProductionCommand,raw:string,requestId:string,recovery?:ActivityProductionRecovery) {
    let commandScope=`activity:${context.scope.storeId}:${context.employeeId}`,source:ActivityProductionResult['source']={kind:'employee',id:context.employeeId}
    const authorize=async(tx:ScopedTransaction)=>{
      if(command.action==='take'||command.action==='undo_take'){
        const access=await authorizePickup(tx,context);commandScope=access.commandScope
        if(recovery){
          // Same physical device is necessary but not sufficient: a different employee
          // must not silently adopt an unknown intent from the previous login.
          const owner=(await tx.query<{employee_id:string}>('SELECT employee_id FROM mbox.staff_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[context.scope.tenantId,context.scope.storeId,recovery.staffSessionId])).rows[0]
          if(owner?.employee_id!==context.employeeId)throw new PickupWorkflowError('PICKUP_FORBIDDEN','请由原操作员工在原取餐屏登录后核对',403)
          commandScope=await authorizePickupRecovery(tx,context,{...recovery,request:{kind:'command'}})
        }
        source={kind:'shared_pickup_device',id:access.device!.id,label:access.device!.label}
      }else{
        if(recovery)throw new TypeError('这里只恢复原取餐操作')
        const lines=await tx.query<{station_code:'bar'|'kitchen'}>('SELECT DISTINCT station_code FROM mbox.activity_service_lines WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])',[context.scope.tenantId,context.scope.storeId,command.lines.map(line=>line.lineId)])
        for(const line of lines.rows)await new NormalizedKdsAuthorization().assertCanActOnTask({transaction:tx,...context,action:'start',stationCode:line.station_code,tableId:''})
      }
    }
    // Reauthorize even a cached command, then again before a new mutation.
    await options.staffAccessTransactions.run(context.scope,authorize)
    const key=digest(`${commandScope}:${raw}`)
    return options.commandExecutor.execute({scope:context.scope,operationScope:'activity.service.production',idempotencyKey:key,requestFingerprint:JSON.stringify({commandScope,command}),retainReceipt:true,resultCodec:{encode:value=>value as unknown as JsonValue,decode:value=>value as ActivityProductionResult}},async tx=>{
      await authorize(tx)
      const result=await new ActivityServiceRepository(tx).production(command,key,command.action==='take'||command.action==='undo_take'?null:context.employeeId,source)
      return {result,auditEvents:[{actor:{type:'employee' as const,employeeId:context.employeeId},action:`activity.service.${command.action}`,objectType:'activity_service_receipt',objectId:result.receiptId,businessDate:context.businessDate,afterData:{action:command.action,pickerEmployeeId:null,...(recovery?{recoveredFromSession:recovery.staffSessionId}:{})},requestId}],outboxMessages:[]}
    })
  }
  app.post('/commerce/activity-service/commands',async(request,reply)=>route(reply,async()=>{
    const context=await options.resolveContext(request),command=parse(request.body),raw=key(request.headers['idempotency-key'])
    const result=await execute(context,command,raw,request.id)
    return reply.send({data:result.value,replayed:result.replayed})
  }))
  app.post('/commerce/activity-service/recovery',async(request,reply)=>route(reply,async()=>{
    const body=request.body as Partial<ActivityProductionRecovery>|null
    if(!body||typeof body.staffSessionId!=='string'||!/^[0-9a-f-]{36}$/i.test(body.staffSessionId)||typeof body.commandScope!=='string'||!/^[a-f0-9]{64}$/.test(body.commandScope))throw new TypeError('原取餐操作记录不完整，请保留原记录')
    const command=parse(body.command),raw=key(body.idempotencyKey)
    if(command.action!=='take'&&command.action!=='undo_take')throw new TypeError('这里只恢复原取餐操作')
    const context=await options.resolveContext(request),recovery={staffSessionId:body.staffSessionId,commandScope:body.commandScope,idempotencyKey:raw,command}
    const result=await execute(context,command,raw,request.id,recovery)
    return reply.send({data:result.value,replayed:result.replayed})
  }))
}
function key(raw:unknown){if(typeof raw!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(raw))throw new TypeError('请保留原操作凭据');return raw}
function parse(value:unknown):ActivityProductionCommand {
  if(!value||typeof value!=='object')throw new TypeError('请选择活动出品')
  const v=value as Record<string,unknown>
  if(!['start','ready','take','undo_take'].includes(String(v.action))||!Array.isArray(v.lines)||v.lines.length<1||v.lines.length>100)throw new TypeError('活动出品操作无效')
  const lines=v.lines.map(raw=>{const p=raw as Record<string,unknown>;if(!p||typeof p.lineId!=='string'||!/^[0-9a-f-]{36}$/i.test(p.lineId)||!Number.isSafeInteger(p.quantity)||Number(p.quantity)<1||!Number.isSafeInteger(p.expectedVersion)||Number(p.expectedVersion)<1)throw new TypeError('请核对原出品及实际份数');return {lineId:p.lineId,quantity:Number(p.quantity),expectedVersion:Number(p.expectedVersion)}})
  return {action:v.action as ActivityProductionCommand['action'],lines,...(typeof v.receiptId==='string'?{receiptId:v.receiptId}:{}),...(v.physicalStillAtPickupPoint===true?{physicalStillAtPickupPoint:true}:{})}
}
async function route(reply:FastifyReply,fn:()=>Promise<FastifyReply>){return handleCommerceRoute(reply,async()=>{try{return await fn()}catch(caught){const error=caught instanceof NativeCommandNotCommittedError?caught.original:caught;if(error instanceof ActivityServiceError||error instanceof PickupWorkflowError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.message,commitDisposition:error.statusCode===403?'unknown':'not_committed'}});throw error}})}
