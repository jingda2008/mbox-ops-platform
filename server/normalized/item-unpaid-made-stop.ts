import type {ScopedTransaction} from './transaction-runner.js'
import {assertEmployeeEffectivePermission} from './employee-table-access.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'

/** Stopping unpaid goods is an operating decision, never a fabricated refund.
 * Delivered goods retain the existing settlement-exception permission. */
export async function assertUnpaidMadeStopPermission(tx:ScopedTransaction,caseId:string,employeeId:string){
  const facts=(await tx.query<{made:boolean;delivered:boolean}>(`SELECT
    COALESCE(bool_or(unit.production_state<>'unmade'),false) AS made,
    COALESCE(bool_or(mbox.quantity_unit_has_delivery(unit.tenant_id,unit.store_id,unit.id)),false) AS delivered
    FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit
      ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
    WHERE selected.tenant_id=$1 AND selected.store_id=$2 AND selected.case_id=$3`,[tx.scope.tenantId,tx.scope.storeId,caseId])).rows[0]!
  await assertEmployeeEffectivePermission(tx,employeeId,facts.delivered?'order.settle_exception':'order.cancel_unpaid')
  if(!facts.made)throw new ItemQuantityConflict('QUANTITY_UNAVAILABLE','正常未制作停止无需免单确认，请继续原处理')
}
