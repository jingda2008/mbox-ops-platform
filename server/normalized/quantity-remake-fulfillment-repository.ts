import {synchronizeQuantityItem} from './item-quantity-projection.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {lockQuantityOrder} from './item-quantity-lock.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'
import {QuantityRemakeRepository} from './quantity-remake-repository.js'

/** Physical-batch fulfillment foundation. Normal KDS authentication, command
 * replay and delivery slip integration must wrap it before exposing an entry. */
export class QuantityRemakeFulfillmentRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}
  async act(input:{taskId:string;employeeId:string;action:'start'|'complete'|'deliver';quantity:number;eventKey:string}){
    if(!input.eventKey.trim()||input.eventKey.length>160)throw new ItemQuantityConflict('QUANTITY_INVALID','原操作编号无效')
    const target=(await this.tx.query<{id:string;order_item_id:string}>('SELECT id,order_item_id FROM mbox.quantity_remake_batches WHERE tenant_id=$1 AND store_id=$2 AND kds_task_id=$3',[...this.scope,input.taskId])).rows[0]
    if(!target)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','没有找到该出品的逐份重做批次')
    await lockQuantityOrder(this.tx,{kind:'item',id:target.order_item_id})
    const task=(await this.tx.query<{status:string;assigned_employee_id:string|null}>('SELECT status,assigned_employee_id FROM mbox.kds_tasks WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,input.taskId])).rows[0]!
    const previous=(await this.tx.query<{actor_employee_id:string;metadata:{action:string;quantity:number;remakeUnitIds:string[];originalUnitIds:string[]}}>('SELECT actor_employee_id,metadata FROM mbox.kds_task_events WHERE tenant_id=$1 AND store_id=$2 AND kds_task_id=$3 AND idempotency_key=$4',[...this.scope,input.taskId,input.eventKey])).rows[0]
    if(previous){
      if(previous.actor_employee_id!==input.employeeId||previous.metadata.action!==input.action||previous.metadata.quantity!==input.quantity)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','同一重做操作不能变更动作或份数')
      return {batchId:target.id,taskId:input.taskId,quantity:input.quantity,remakeUnitIds:previous.metadata.remakeUnitIds,originalUnitIds:previous.metadata.originalUnitIds,replayed:true}
    }
    if(!['pending','accepted','preparing','ready'].includes(task.status))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','本批任务已结束，请保留原处理结果')
    if(input.action!=='deliver'&&task.assigned_employee_id&&task.assigned_employee_id!==input.employeeId)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','本批已由另一位员工接手，请核对原任务')
    const repository=new QuantityRemakeRepository(this.tx),current=await repository.read(target.id)
    const eligible=current.units.filter(unit=>!unit.cancelled_at&&!unit.held&&!unit.stopped&&(input.action==='deliver'?unit.production_state==='ready':input.action==='start'?unit.production_state==='unmade':['unmade','started'].includes(unit.production_state)))
    if(!Number.isSafeInteger(input.quantity)||input.quantity<1||input.quantity>eligible.length)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE',`本批当前可处理 ${eligible.length} 份，请读回实际重做进度`)
    const selected=eligible.slice(0,input.quantity),remakeUnitIds=selected.map(unit=>unit.id),originalUnitIds=selected.map(unit=>unit.unit_id)
    if(input.action!=='deliver')await repository.consume({batchId:target.id,employeeId:input.employeeId,unitIds:remakeUnitIds})
    if(input.action!=='start')await this.tx.query('UPDATE mbox.quantity_remake_units SET production_state=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])',[...this.scope,remakeUnitIds,input.action==='complete'?'ready':'delivered'])
    const after=await repository.read(target.id),alive=after.units.filter(unit=>!unit.cancelled_at&&!unit.stopped)
    const desired=alive.length===0?'cancelled':alive.some(unit=>['unmade','started'].includes(unit.production_state))?'preparing':'ready'
    const nextStatus=task.status==='ready'&&desired==='preparing'?'ready':desired
    await this.tx.query(`UPDATE mbox.kds_tasks SET status=$4,assigned_employee_id=CASE WHEN $5::boolean THEN COALESCE(assigned_employee_id,$6::uuid) ELSE assigned_employee_id END,
      accepted_at=COALESCE(accepted_at,clock_timestamp()),ready_at=CASE WHEN $4='ready' THEN COALESCE(ready_at,clock_timestamp()) ELSE ready_at END,
      cancelled_at=CASE WHEN $4='cancelled' THEN COALESCE(cancelled_at,clock_timestamp()) ELSE cancelled_at END,
      worker_locked_by=NULL,worker_locked_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,input.taskId,nextStatus,input.action!=='deliver',input.employeeId])
    await this.tx.query(`INSERT INTO mbox.kds_task_events(tenant_id,store_id,kds_task_id,event_type,from_status,to_status,actor_employee_id,metadata,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,[...this.scope,input.taskId,`task.remake_${input.action}`,task.status,nextStatus,input.employeeId,JSON.stringify({action:input.action,quantity:input.quantity,remakeUnitIds,originalUnitIds,remakeBatchId:target.id}),input.eventKey])
    await synchronizeQuantityItem(this.tx,target.order_item_id)
    return {batchId:target.id,taskId:input.taskId,quantity:input.quantity,remakeUnitIds,originalUnitIds,replayed:false}
  }
}
