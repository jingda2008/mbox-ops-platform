import type {ScopedTransaction} from './transaction-runner.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'

/** Restore the actual historical return lot, including its cost, under the
 * caller's already locked stock balances. Never treat an unknown cost as zero. */
export async function restoreQuantityInventoryBalance(tx:ScopedTransaction,input:{inventoryItemId:string;movementId:string;quantity:string}){
  const result=await tx.query(`UPDATE mbox.inventory_balances balance SET
    on_hand_quantity=balance.on_hand_quantity+movement.quantity_delta,
    weighted_unit_cost_minor=CASE
      WHEN movement.unit_cost_minor IS NOT NULL AND balance.on_hand_quantity=0 THEN movement.unit_cost_minor
      WHEN movement.unit_cost_minor IS NOT NULL AND balance.cost_status='complete' THEN round((balance.on_hand_quantity*balance.weighted_unit_cost_minor+movement.quantity_delta*movement.unit_cost_minor)/(balance.on_hand_quantity+movement.quantity_delta),6)
      ELSE NULL END,
    cost_status=CASE WHEN movement.unit_cost_minor IS NOT NULL AND (balance.on_hand_quantity=0 OR balance.cost_status='complete') THEN 'complete' ELSE 'needs_review' END,
    cost_basis=CASE WHEN movement.unit_cost_minor IS NOT NULL AND (balance.on_hand_quantity=0 OR balance.cost_status='complete') THEN 'moving_weighted_average' ELSE 'none' END,
    last_movement_id=movement.id,updated_at=clock_timestamp()
    FROM mbox.inventory_movements movement WHERE balance.tenant_id=$1 AND balance.store_id=$2 AND balance.inventory_item_id=$3
      AND movement.tenant_id=balance.tenant_id AND movement.store_id=balance.store_id AND movement.inventory_item_id=balance.inventory_item_id
      AND movement.id=$4 AND movement.movement_type='return' AND movement.quantity_delta=$5::numeric AND movement.quantity_delta>0`,[tx.scope.tenantId,tx.scope.storeId,input.inventoryItemId,input.movementId,input.quantity])
  if(result.rowCount!==1)throw new ItemQuantityConflict('QUANTITY_FACTS_CONFLICT','实际退库流水与库存余额不一致，未确认回库')
}
