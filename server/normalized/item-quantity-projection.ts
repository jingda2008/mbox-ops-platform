import type {ScopedTransaction} from './transaction-runner.js'

export async function synchronizeQuantityItem(tx:ScopedTransaction,itemId:string){
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const facts=(await tx.query<{total:number;stopped:number;held:number;delivered:number;ready:number;made:number}>(`SELECT count(*)::int AS total,
    count(*) FILTER(WHERE operationally_stopped)::int AS stopped,count(*) FILTER(WHERE held_by_case_id IS NOT NULL AND NOT operationally_stopped)::int AS held,
    count(*) FILTER(WHERE production_state<>'unmade')::int AS made,
    count(*) FILTER(WHERE NOT operationally_stopped AND mbox.quantity_unit_has_delivery(tenant_id,store_id,id))::int AS delivered,
    count(*) FILTER(WHERE NOT operationally_stopped AND production_state IN ('ready','delivered'))::int AS ready
    FROM mbox.order_item_quantity_units WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3`,[...scope,itemId])).rows[0]!
  if(!facts.total)return
  const itemStatus=facts.held?null:facts.stopped===facts.total?'cancelled':facts.stopped+facts.delivered===facts.total?'delivered':facts.stopped+facts.ready===facts.total?'ready':null
  const taskStatus=itemStatus==='cancelled'?'cancelled':itemStatus?'ready':facts.made>0?'preparing':null
  if(!taskStatus)return
  await tx.query(`UPDATE mbox.kds_tasks SET status=$4,cancelled_at=CASE WHEN $4='cancelled' THEN COALESCE(cancelled_at,clock_timestamp()) ELSE cancelled_at END,
    ready_at=CASE WHEN $4='ready' THEN COALESCE(ready_at,clock_timestamp()) ELSE ready_at END,worker_locked_by=NULL,worker_locked_at=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 AND NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_batches batch WHERE batch.tenant_id=mbox.kds_tasks.tenant_id AND batch.store_id=mbox.kds_tasks.store_id AND batch.kds_task_id=mbox.kds_tasks.id) AND status NOT IN ('cancelled','failed') AND status<>$4 AND NOT (status='ready' AND $4='preparing')`,[...scope,itemId,taskStatus])
  if(itemStatus)await tx.query(`UPDATE mbox.order_items SET status=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status NOT IN ('cancelled','delivered') AND status<>$4`,[...scope,itemId,itemStatus])
  if(itemStatus==='delivered')await tx.query('SELECT mbox.complete_annual_benefit_fulfillment_for_order(order_id) FROM mbox.order_items WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,itemId])
}

/** Only an immutable, exact pickup undo permits this current fulfillment correction.
 * Benefit redemption/grant history remains consumed; no financial or inventory writes occur. */
export async function synchronizePickupUndoItem(tx:ScopedTransaction,itemId:string,receiptId:string){
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const undo=await tx.query(`SELECT 1 FROM mbox.pickup_undos undo JOIN mbox.pickup_receipt_parts part
    ON (part.tenant_id,part.store_id,part.receipt_id)=(undo.tenant_id,undo.store_id,undo.receipt_id)
    JOIN mbox.order_item_quantity_units unit ON (unit.tenant_id,unit.store_id,unit.id)=(part.tenant_id,part.store_id,part.original_unit_id)
    WHERE undo.tenant_id=$1 AND undo.store_id=$2 AND undo.receipt_id=$3 AND unit.order_item_id=$4`,[...scope,receiptId,itemId])
  if(!undo.rowCount)throw new Error('Current fulfillment correction requires its original pickup undo')
  await tx.query(`UPDATE mbox.order_items item SET status='ready',updated_at=clock_timestamp()
    WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=$3 AND item.status='delivered'
      AND EXISTS(SELECT 1 FROM mbox.order_item_quantity_units unit WHERE (unit.tenant_id,unit.store_id,unit.order_item_id)=(item.tenant_id,item.store_id,item.id)
        AND NOT unit.operationally_stopped AND NOT mbox.quantity_unit_has_delivery(unit.tenant_id,unit.store_id,unit.id))`,[...scope,itemId])
  await synchronizeQuantityItem(tx,itemId)
}
