import {randomUUID} from 'node:crypto'
import type {ScopedTransaction} from './transaction-runner.js'
import {assertEmployeeEffectivePermission,assertEmployeeTableSessionAccess} from './employee-table-access.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'
import {lockQuantityOrder} from './item-quantity-lock.js'
import {planOriginalGoodsRedelivery} from './quantity-redelivery-plan.js'
import {ServiceTaskRepository} from './service-task-repository.js'

/** Same physical prepared goods, no refund, repricing or inventory movement.
 * Called under the original business command's idempotent transaction. */
export class QuantityRedeliveryRepository {
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}
  async request(input:{itemId:string;employeeId:string;quantity:number;originalGoodsAvailable:boolean;reason:string;eventKey:string}){
    await assertEmployeeEffectivePermission(this.tx,input.employeeId,'refund.request')
    if(input.reason.trim().length<2||input.reason.length>1000)throw new ItemQuantityConflict('QUANTITY_INVALID','请说明实际补送原因')
    const {tableSessionId}=await lockQuantityOrder(this.tx,{kind:'item',id:input.itemId})
    const original=(await this.tx.query<{table_id:string;name:string;active:boolean}>(`SELECT visit.table_id,COALESCE(item.product_snapshot->>'name','原商品') AS name,
      visit.status IN ('open','closing') AND original.status<>'cancelled' AND original.fulfillment_state NOT IN ('awaiting_payment','released','cancelled') AND item.status<>'cancelled' AS active
      FROM mbox.order_items item JOIN mbox.orders original ON original.tenant_id=item.tenant_id AND original.store_id=item.store_id AND original.id=item.order_id
      JOIN mbox.table_sessions visit ON visit.tenant_id=original.tenant_id AND visit.store_id=original.store_id AND visit.id=original.table_session_id
      WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=$3`,[...this.scope,input.itemId])).rows[0]
    if(!original?.active)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','原商品或原桌次已结束，请核对客人当前所在桌')
    const {units}=await new ItemQuantityRepository(this.tx).initialize(input.itemId)
    const active=(await this.tx.query<{unit_id:string}>('SELECT unit_id FROM mbox.quantity_redelivery_units WHERE tenant_id=$1 AND store_id=$2 AND unit_id=ANY($3::uuid[]) AND outcome IS NULL',[...this.scope,units.map(unit=>unit.id)])).rows.map(row=>row.unit_id)
    const physical=(await this.tx.query<{id:string;unit_id:string;production_state:'unmade'|'started'|'ready'|'delivered';cancelled:boolean}>(`SELECT DISTINCT ON(unit_id) id,unit_id,production_state,cancelled_at IS NOT NULL AS cancelled
      FROM mbox.quantity_remake_units WHERE tenant_id=$1 AND store_id=$2 AND unit_id=ANY($3::uuid[]) ORDER BY unit_id,generation DESC`,[...this.scope,units.map(unit=>unit.id)])).rows
    const plan=planOriginalGoodsRedelivery({quantity:input.quantity,originalGoodsAvailable:input.originalGoodsAvailable,units:units.map(unit=>({id:unit.id,index:unit.unit_index,productionState:physical.find(value=>value.unit_id===unit.id)?.production_state??unit.production_state,held:unit.held_by_case_id!==null,stopped:unit.operationally_stopped||physical.find(value=>value.unit_id===unit.id)?.cancelled===true,hasActiveRedelivery:active.includes(unit.id)}))})
    const id=randomUUID(),task=await new ServiceTaskRepository(this.tx).create({tableId:original.table_id,tableSessionId,publicId:`redelivery-${id}`,taskType:'goods.redelivery',title:`${original.name}原实物补送（待${plan.quantity}份）`,
      detail:`${input.reason.trim()}。原实物仍在且可交付；不要重新制作或重复扣库存。`,source:'employee',createdByEmployeeId:input.employeeId,requestSnapshot:{orderItemId:input.itemId,redeliveryId:id,quantity:plan.quantity,originalGoodsAvailable:true},actor:{type:'employee',employeeId:input.employeeId},eventIdempotencyKey:input.eventKey})
    await this.tx.query(`INSERT INTO mbox.quantity_redeliveries(id,tenant_id,store_id,order_item_id,service_task_id,requested_by_employee_id,reason,original_goods_available) VALUES($1,$2,$3,$4,$5,$6,$7,true)`,[id,...this.scope,input.itemId,task.id,input.employeeId,input.reason.trim()])
    for(const unitId of plan.unitIds)await this.tx.query(`INSERT INTO mbox.quantity_redelivery_units(tenant_id,store_id,redelivery_id,unit_id,source_remake_unit_id) VALUES($1,$2,$3,$4,$5)`,[...this.scope,id,unitId,physical.find(value=>value.unit_id===unitId)?.id??null])
    return this.read(id)
  }
  /** Generic service actions use this before locking a task, preserving the
   * same order-before-service lock sequence as refund, transfer and closure. */
  async lockForTask(taskId:string){
    const target=(await this.tx.query<{id:string;order_item_id:string}>(`SELECT id,order_item_id FROM mbox.quantity_redeliveries WHERE tenant_id=$1 AND store_id=$2 AND service_task_id=$3`,[...this.scope,taskId])).rows[0]
    if(!target)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','没有找到原实物补送记录')
    const original=await lockQuantityOrder(this.tx,{kind:'item',id:target.order_item_id})
    return {...target,...original}
  }
  async complete(input:{redeliveryId:string;employeeId:string;quantity?:number;reason:string;eventKey:string}){
    const before=await this.read(input.redeliveryId)
    const original=await this.lockForTask(before.taskId)
    await assertEmployeeTableSessionAccess(this.tx,{employeeId:input.employeeId,tableSessionId:original.tableSessionId,allTablePermissionCodes:['fulfillment.view_all','kds.deliver'],requiredPermissionCodes:['kds.deliver']})
    await this.tx.query('SELECT id FROM mbox.service_tasks WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,before.taskId])
    const current=await this.read(input.redeliveryId)
    const available=current.units.filter(unit=>unit.outcome===null&&!unit.held&&!unit.stopped)
    if(input.quantity===undefined&&available.length!==current.pendingQuantity)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','部分原商品已暂停，请在原商品中选择其余实际补送份数')
    const quantity=input.quantity??available.length
    if(!['pending','acknowledged','in_progress'].includes(current.status)||!Number.isSafeInteger(quantity)||quantity<1||quantity>available.length)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE',`当前可确认原实物补送 ${available.length} 份，请读回原任务`)
    if(input.reason.trim().length<2||input.reason.length>1000)throw new ItemQuantityConflict('QUANTITY_INVALID','请说明实际补送结果')
    const ids=available.slice(0,quantity).map(unit=>unit.id)
    const updated=await this.tx.query(`UPDATE mbox.quantity_redelivery_units SET outcome='delivered',closed_at=clock_timestamp(),closed_by_employee_id=$5,close_reason=$6
      WHERE tenant_id=$1 AND store_id=$2 AND redelivery_id=$3 AND unit_id=ANY($4::uuid[]) AND outcome IS NULL`,[...this.scope,input.redeliveryId,ids,input.employeeId,input.reason.trim()])
    if(updated.rowCount!==quantity)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','补送份数刚刚变化，请读回实际结果')
    const result=await this.read(input.redeliveryId)
    await this.tx.query(`INSERT INTO mbox.service_task_events(tenant_id,store_id,service_task_id,event_type,from_status,to_status,actor_type,actor_employee_id,note,metadata,idempotency_key)
      VALUES($1,$2,$3,'task.original_goods_redelivered',$4,$5,'employee',$6,$7,$8::jsonb,$9)`,[...this.scope,result.taskId,current.status,result.status,input.employeeId,input.reason.trim(),JSON.stringify({redeliveryId:result.id,unitIds:ids,quantity}),input.eventKey])
    return result
  }
  async cancel(input:{redeliveryId:string;employeeId:string;reason:string;eventKey:string}){
    const before=await this.read(input.redeliveryId),original=await this.lockForTask(before.taskId)
    await assertEmployeeTableSessionAccess(this.tx,{employeeId:input.employeeId,tableSessionId:original.tableSessionId,allTablePermissionCodes:['fulfillment.view_all','kds.deliver'],requiredPermissionCodes:['service.execute']})
    if(input.reason.trim().length<2||input.reason.length>1000)throw new ItemQuantityConflict('QUANTITY_INVALID','请说明取消本次补送的原因')
    if(!['pending','acknowledged','in_progress'].includes(before.status))throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','该补送任务已结束，请读回原结果')
    await new ServiceTaskRepository(this.tx).cancel({taskId:before.taskId,actor:{type:'employee',employeeId:input.employeeId},note:input.reason.trim(),eventIdempotencyKey:input.eventKey})
    return this.read(before.id)
  }
  async read(id:string){
    const row=(await this.tx.query<{id:string;order_item_id:string;service_task_id:string;status:string;reason:string;created_at:string}>(`SELECT parent.id,parent.order_item_id,parent.service_task_id,task.status,parent.reason,parent.created_at::text
      FROM mbox.quantity_redeliveries parent JOIN mbox.service_tasks task ON task.tenant_id=parent.tenant_id AND task.store_id=parent.store_id AND task.id=parent.service_task_id
      WHERE parent.tenant_id=$1 AND parent.store_id=$2 AND parent.id=$3`,[...this.scope,id])).rows[0]
    if(!row)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','原实物补送记录不存在')
    const units=(await this.tx.query<{id:string;index:number;outcome:'delivered'|'cancelled'|null;held:boolean;stopped:boolean}>(`SELECT unit.id,unit.unit_index AS index,part.outcome,unit.held_by_case_id IS NOT NULL AS held,unit.operationally_stopped AS stopped
      FROM mbox.quantity_redelivery_units part JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=part.tenant_id AND unit.store_id=part.store_id AND unit.id=part.unit_id
      WHERE part.tenant_id=$1 AND part.store_id=$2 AND part.redelivery_id=$3 ORDER BY unit.unit_index`,[...this.scope,id])).rows
    return {id:row.id,itemId:row.order_item_id,taskId:row.service_task_id,status:row.status,reason:row.reason,createdAt:row.created_at,selectedQuantity:units.length,pendingQuantity:units.filter(unit=>unit.outcome===null).length,
      pausedQuantity:units.filter(unit=>unit.outcome===null&&unit.held).length,deliveredQuantity:units.filter(unit=>unit.outcome==='delivered').length,cancelledQuantity:units.filter(unit=>unit.outcome==='cancelled').length,units}
  }
}
