import type { Pool } from 'pg'

/** Settled sales used by isolated production-board fixtures. */
export async function seedProductionReceipt(pool: Pool, orderId: string) {
  await pool.query(`INSERT INTO mbox.payments(tenant_id,store_id,order_id,public_id,provider,method,
    provider_transaction_id,amount_minor,status,succeeded_at)
    SELECT tenant_id,store_id,id,'receipt-' || id,'cash','cash',id::text,total_amount_minor,'succeeded',clock_timestamp()
    FROM mbox.orders WHERE id=$1`,[orderId])
}

export async function seedGiftAuthorization(pool: Pool, orderId: string) {
  await pool.query(`INSERT INTO mbox.pricing_authorizations(tenant_id,store_id,table_session_id,order_id,source_type,
    source_id,kind,amount_minor,maximum_amount_minor,currency,authorized_by_employee_id,capability,role_approval_limit_id,status,consumed_at)
    SELECT o.tenant_id,o.store_id,o.table_session_id,o.id,'employee',o.id,'gift',o.subtotal_amount_minor,o.subtotal_amount_minor,'CNY',
      o.created_by_employee_id,'order.gift',o.id,'consumed',clock_timestamp() FROM mbox.orders o WHERE o.id=$1`,[orderId])
}
