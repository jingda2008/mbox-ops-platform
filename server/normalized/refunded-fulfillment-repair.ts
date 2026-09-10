import type { ScopedTransaction } from './transaction-runner.js'

/** A cancelled production attempt alone is not proof that the dish was cancelled. */
export async function synchronizeRefundedCancelledItem(transaction: ScopedTransaction, itemId: string): Promise<string[]> {
  const result = await transaction.query<{ id: string; order_id: string }>(`
    UPDATE mbox.order_items item SET status='cancelled',updated_at=clock_timestamp()
    FROM mbox.orders ordering
    WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.id=$3::uuid
      AND ordering.tenant_id=item.tenant_id AND ordering.store_id=item.store_id AND ordering.id=item.order_id
      AND ordering.payment_status='refunded' AND item.status='submitted'
      AND EXISTS (SELECT 1 FROM mbox.kds_tasks task JOIN mbox.kds_task_events event
        ON event.tenant_id=task.tenant_id AND event.store_id=task.store_id AND event.kds_task_id=task.id
        WHERE task.tenant_id=item.tenant_id AND task.store_id=item.store_id AND task.order_item_id=item.id
          AND task.status='cancelled' AND event.event_type='task.cancelled'
          AND event.actor_employee_id IS NOT NULL AND event.metadata->>'source'='manager_exception_api')
      AND NOT EXISTS (SELECT 1 FROM mbox.kds_tasks task
        WHERE task.tenant_id=item.tenant_id AND task.store_id=item.store_id AND task.order_item_id=item.id
          AND task.status<>'cancelled')
    RETURNING item.id,item.order_id
  `, [transaction.scope.tenantId, transaction.scope.storeId, itemId])
  for (const item of result.rows) {
    await transaction.query(`
      UPDATE mbox.orders ordering SET fulfillment_state='cancelled',fulfillment_expires_at=NULL,
        fulfillment_activated_at=NULL,fulfillment_released_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND payment_status='refunded'
        AND fulfillment_state='active'
        AND NOT EXISTS (SELECT 1 FROM mbox.order_items item WHERE item.tenant_id=ordering.tenant_id
          AND item.store_id=ordering.store_id AND item.order_id=ordering.id AND item.status<>'cancelled')
    `, [transaction.scope.tenantId, transaction.scope.storeId, item.order_id])
    await transaction.query(`
      INSERT INTO mbox.audit_events(tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,business_date,metadata)
      SELECT $1::uuid,$2::uuid,'system','refunded-fulfillment-sync','order_item.refunded_cancellation_synchronized',
        'order_item',$3::text,((clock_timestamp() AT TIME ZONE timezone)
          -make_interval(secs=>extract(epoch FROM business_day_cutoff)))::date,
        '{"previousStatus":"submitted","status":"cancelled","financialTruth":"unchanged","inventoryTruth":"unchanged"}'::jsonb
      FROM mbox.stores WHERE tenant_id=$1::uuid AND id=$2::uuid
    `, [transaction.scope.tenantId, transaction.scope.storeId, item.id])
  }
  return result.rows.map(item => item.id)
}
