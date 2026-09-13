import {QuantityRemakeFulfillmentRepository} from './quantity-remake-fulfillment-repository.js'
import {QuantityRemakeRepository} from './quantity-remake-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'
import type {KdsTask} from './kds-repository.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {ItemQuantityFulfillmentRepository} from './item-quantity-fulfillment-repository.js'
import {DeliveryBatchRepository} from './delivery-batch-repository.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'

/** Called only after the normal employee/device/station authorization succeeds. */
export async function executeQuantityKdsAction(tx:ScopedTransaction,input:{task:KdsTask;action:'start'|'complete'|'deliver'|'pickupAndDeliver';employeeId:string;quantity?:number;eventKey:string}){
  const scope=[tx.scope.tenantId,tx.scope.storeId],itemId=input.task.orderItemId
  const bundle=(await tx.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM mbox.order_items WHERE tenant_id=$1 AND store_id=$2 AND parent_order_item_id=$3) AS found`,[...scope,itemId])).rows[0]?.found
  if(input.task.remakeOfTaskId&&!bundle){
    const source=(await tx.query<{id:string}>('SELECT id FROM mbox.quantity_remake_batches WHERE tenant_id=$1 AND store_id=$2 AND kds_task_id=$3',[...scope,input.task.id])).rows[0]
    if(source){
      const action=input.action==='pickupAndDeliver'?'deliver':input.action
      const previous=(await tx.query<{quantity:number}>(`SELECT (metadata->>'quantity')::integer AS quantity FROM mbox.kds_task_events WHERE tenant_id=$1 AND store_id=$2 AND kds_task_id=$3 AND idempotency_key=$4`,[...scope,input.task.id,input.eventKey])).rows[0]
      const current=await new QuantityRemakeRepository(tx).read(source.id)
      const available=current.units.filter(unit=>!unit.cancelled_at&&!unit.held&&!unit.stopped&&(action==='deliver'?unit.production_state==='ready':action==='start'?unit.production_state==='unmade':['unmade','started'].includes(unit.production_state))).length
      const fulfilled=await new QuantityRemakeFulfillmentRepository(tx).act({taskId:input.task.id,action,employeeId:input.employeeId,quantity:input.quantity??previous?.quantity??available,eventKey:input.eventKey})
      const deliveries=new DeliveryBatchRepository(tx)
      const batch=action==='complete'?(fulfilled.replayed?await deliveries.originalForUnits(input.task.id,fulfilled.remakeUnitIds,'remake'):await deliveries.create(input.employeeId,[{taskId:input.task.id,quantity:fulfilled.quantity,remakeUnitIds:fulfilled.remakeUnitIds}])):null
      const state=(await tx.query<{status:KdsTask['status'];assigned_employee_id:string|null;accepted_at:string|null;ready_at:string|null;cancelled_at:string|null}>('SELECT status,assigned_employee_id,accepted_at::text,ready_at::text,cancelled_at::text FROM mbox.kds_tasks WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,input.task.id])).rows[0]!
      const after=await new QuantityRemakeRepository(tx).read(source.id),active=after.units.filter(unit=>!unit.cancelled_at&&!unit.stopped)
      const fulfillmentStatus:'delivered'|'cancelled'|'ready'|'in_progress'=!active.length?'cancelled':active.every(unit=>unit.production_state==='delivered')?'delivered':active.every(unit=>['ready','delivered'].includes(unit.production_state))?'ready':'in_progress'
      return {task:{...input.task,status:state.status,assignedEmployeeId:state.assigned_employee_id,acceptedAt:state.accepted_at,readyAt:state.ready_at,cancelledAt:state.cancelled_at},fulfillmentStatus,quantity:fulfilled.quantity,unitIds:fulfilled.originalUnitIds,batch}
    }
  }
  if(bundle||input.task.remakeOfTaskId)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','套餐主项或重做任务仍需原批次核对，不能直接拆分数量')
  const {units}=await new ItemQuantityRepository(tx).initialize(itemId)
  const action=input.action==='pickupAndDeliver'?'deliver':input.action
  const previous=(await tx.query<{quantity:number}>(`SELECT (metadata->>'quantity')::integer AS quantity FROM mbox.kds_task_events WHERE tenant_id=$1 AND store_id=$2 AND kds_task_id=$3 AND idempotency_key=$4`,[...scope,input.task.id,input.eventKey])).rows[0]
  const remade=new Set((await tx.query<{unit_id:string}>('SELECT unit_id FROM mbox.quantity_remake_units WHERE tenant_id=$1 AND store_id=$2 AND unit_id=ANY($3::uuid[])',[...scope,units.map(unit=>unit.id)])).rows.map(row=>row.unit_id))
  const available=units.filter(unit=>!remade.has(unit.id)&&!unit.held_by_case_id&&!unit.operationally_stopped&&(action==='deliver'?unit.production_state==='ready':action==='start'?unit.production_state==='unmade':['unmade','started'].includes(unit.production_state))).length
  const quantity=input.quantity??previous?.quantity??available
  if(!Number.isSafeInteger(quantity)||quantity<1||!previous&&quantity>available)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE',`当前可${action==='deliver'?'送达':action==='start'?'开始':'完成'}${available}份，请读取当前数量`)
  const fulfilled=await new ItemQuantityFulfillmentRepository(tx)[action]({itemId,taskId:input.task.id,employeeId:input.employeeId,quantity,eventKey:input.eventKey})
  // Preparing a delivery slip is not an assertion that anything was delivered.
  const deliveries=new DeliveryBatchRepository(tx)
  const batch=action==='complete'?(fulfilled.replayed?await deliveries.originalForUnits(input.task.id,fulfilled.unitIds):await deliveries.create(input.employeeId,[{taskId:input.task.id,quantity,unitIds:fulfilled.unitIds}])):null
  const state=(await tx.query<{status:KdsTask['status'];assigned_employee_id:string|null;accepted_at:string|null;ready_at:string|null;cancelled_at:string|null;item_status:string}>(`SELECT task.status,task.assigned_employee_id,task.accepted_at::text,task.ready_at::text,task.cancelled_at::text,item.status AS item_status
    FROM mbox.kds_tasks task JOIN mbox.order_items item ON item.tenant_id=task.tenant_id AND item.store_id=task.store_id AND item.id=task.order_item_id
    WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.id=$3`,[...scope,input.task.id])).rows[0]!
  const task={...input.task,status:state.status,assignedEmployeeId:state.assigned_employee_id,acceptedAt:state.accepted_at,readyAt:state.ready_at,cancelledAt:state.cancelled_at}
  const fulfillmentStatus:'delivered'|'cancelled'|'ready'|'in_progress'=state.item_status==='delivered'?'delivered':state.item_status==='cancelled'?'cancelled':state.status==='ready'?'ready':'in_progress'
  return {task,fulfillmentStatus,quantity:fulfilled.quantity,unitIds:fulfilled.unitIds,batch}
}
