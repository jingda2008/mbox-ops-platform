import {NativeCommandNotCommittedError} from './command-executor.js'
import {nativePhysicalExecutor,isNativePhysicalKey} from './native-physical-command.js'
import {assertEmployeeEffectivePermission,assertEmployeeTableSessionAccess} from './employee-table-access.js'
import {NormalizedCommandExecutor,type JsonCodec,type JsonValue} from './command-executor.js'
import type {ScopedTransaction,StoreScope} from './transaction-runner.js'
import {QuantityRedeliveryRepository} from './quantity-redelivery-repository.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'
type Progress=Awaited<ReturnType<QuantityRedeliveryRepository['read']>>
interface Metadata {scope:Readonly<StoreScope>;employeeId:string;businessDate:string;idempotencyKey:string;reason:string;replayOnly?:boolean}
export class QuantityRedeliveryCommandService {
  constructor(private readonly commands:NormalizedCommandExecutor,private readonly acceptNewRequests=true){}
  request(input:Metadata&{orderItemId:string;quantity:number;originalGoodsAvailable:boolean}){
    return this.execute(input,'request',{orderItemId:input.orderItemId,quantity:input.quantity,originalGoodsAvailable:input.originalGoodsAvailable},async tx=>{
      if(!this.acceptNewRequests)throw new ItemQuantityConflict('QUANTITY_BATCH_NOT_ENABLED','暂不新增补送；原补送任务可继续处理或恢复')
      return new QuantityRedeliveryRepository(tx).request({...input,itemId:input.orderItemId,eventKey:`${input.idempotencyKey}:request`})
    })
  }
  complete(input:Metadata&{redeliveryId:string;quantity:number}){
    return this.execute(input,'complete',{redeliveryId:input.redeliveryId,quantity:input.quantity},tx=>new QuantityRedeliveryRepository(tx).complete({...input,eventKey:`${input.idempotencyKey}:complete`}))
  }
  cancel(input:Metadata&{redeliveryId:string}){
    return this.execute(input,'cancel',{redeliveryId:input.redeliveryId},tx=>new QuantityRedeliveryRepository(tx).cancel({...input,eventKey:`${input.idempotencyKey}:cancel`}))
  }
  private execute(input:Metadata,action:'request'|'complete'|'cancel',selection:Record<string,JsonValue>,handler:(tx:ScopedTransaction)=>Promise<Progress>){
    const commands=isNativePhysicalKey(input.idempotencyKey)?nativePhysicalExecutor(this.commands,input,
      tx=>assertEmployeeEffectivePermission(tx,input.employeeId,action==='request'?'refund.request':action==='complete'?'kds.deliver':'service.execute')):this.commands
    return commands.execute({...(!isNativePhysicalKey(input.idempotencyKey)?{replayOnly:input.replayOnly,retainReceipt:true,rejectExpiredReceipt:true,authorizeReplay:async tx=>{
      await assertEmployeeEffectivePermission(tx,input.employeeId,action==='request'?'refund.request':action==='complete'?'kds.deliver':'service.execute')
      if(action!=='request'){
        const target=(await tx.query<{table_session_id:string}>(`SELECT original.table_session_id FROM mbox.quantity_redeliveries parent
          JOIN mbox.order_items item ON (item.tenant_id,item.store_id,item.id)=(parent.tenant_id,parent.store_id,parent.order_item_id)
          JOIN mbox.orders original ON (original.tenant_id,original.store_id,original.id)=(item.tenant_id,item.store_id,item.order_id)
          WHERE parent.tenant_id=$1 AND parent.store_id=$2 AND parent.id=$3`,[input.scope.tenantId,input.scope.storeId,String(selection.redeliveryId)])).rows[0]
        if(!target)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原补送记录不可用，请核对原操作')
        await assertEmployeeTableSessionAccess(tx,{employeeId:input.employeeId,tableSessionId:target.table_session_id,allTablePermissionCodes:['fulfillment.view_all','kds.deliver'],requiredPermissionCodes:[action==='complete'?'kds.deliver':'service.execute']})
      }
    }}:{}),scope:input.scope,operationScope:`quantity.redelivery.${action}`,idempotencyKey:input.idempotencyKey,
      requestFingerprint:JSON.stringify({employeeId:input.employeeId,action,...selection,reason:input.reason.trim()}),resultCodec:codec},async tx=>{
      const result=await handler(tx)
      return {result,auditEvents:[{actor:{type:'employee' as const,employeeId:input.employeeId},action:`quantity_redelivery.${action}`,objectType:'service_task',objectId:result.taskId,businessDate:input.businessDate,reason:input.reason.trim(),metadata:{redeliveryId:result.id,orderItemId:result.itemId,...selection}}],outboxMessages:[{aggregateType:'service_task',aggregateId:result.taskId,aggregateVersion:result.selectedQuantity+result.deliveredQuantity+result.cancelledQuantity,eventType:'service_task.redelivery_progress.v1',payload:{taskId:result.taskId,redeliveryId:result.id,status:result.status,pendingQuantity:result.pendingQuantity,deliveredQuantity:result.deliveredQuantity}}]}
    }).catch(error=>{throw error instanceof NativeCommandNotCommittedError?error.original:error})
  }
}
const codec:JsonCodec<Progress>={encode:value=>value,decode:value=>{
  if(!value||typeof value!=='object'||!('id' in value)||typeof value.id!=='string'||!('taskId' in value)||typeof value.taskId!=='string'||!('units' in value)||!Array.isArray(value.units))throw new Error('Stored redelivery result is invalid')
  return value as Progress
}}
