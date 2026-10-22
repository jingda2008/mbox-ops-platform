import type { ScopedTransaction } from './transaction-runner.js';
export async function refreshActivityMealNumber(tx: ScopedTransaction, mealId: string) {
    await tx.query(`UPDATE mbox.activity_meals meal SET number_active=(meal.plaque_state<>'returned'
    OR EXISTS(SELECT 1 FROM mbox.activity_service_lines line WHERE (line.tenant_id,line.store_id,line.meal_id)=(meal.tenant_id,meal.store_id,meal.id) AND line.status='active' AND line.taken_quantity+line.discarded_ready_quantity+line.stopped_quantity<line.quantity)
    OR EXISTS(SELECT 1 FROM mbox.community_activity_registrations child WHERE (child.tenant_id,child.store_id,child.parent_registration_id)=(meal.tenant_id,meal.store_id,meal.registration_id) AND child.purchase_kind='single_dish' AND (child.payment_status='paid' OR (child.payment_status='not_required' AND child.fee_amount_minor=0) OR (child.payment_status='refunded' AND child.service_refund_disposition IS NOT NULL)) AND child.status IN('confirmed','checked_in') AND NOT EXISTS(SELECT 1 FROM mbox.activity_service_lines line WHERE (line.tenant_id,line.store_id,line.registration_id)=(child.tenant_id,child.store_id,child.id))))
    WHERE meal.tenant_id=$1 AND meal.store_id=$2 AND meal.id=$3`, [tx.scope.tenantId, tx.scope.storeId, mealId]);
}
