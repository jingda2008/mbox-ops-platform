// The payment alias can be a direct receipt or a share from order_payment_facts.
export const verifiedCaptureSql = `EXISTS (
  SELECT 1 FROM mbox.verified_provider_observations v
  WHERE (v.tenant_id,v.store_id,v.payment_id)=(payment.tenant_id,payment.store_id,payment.id)
    AND v.observed_status='payment_succeeded'
)`

export const unpostedCaptureSql = `(payment.status NOT IN ('succeeded','partially_refunded','refunded')
  AND ${verifiedCaptureSql})`

// Shared by the recovery scan and the mutating repositories. "o" is the order.
export const orderHasUnpostedCaptureSql = `EXISTS (
  SELECT 1 FROM mbox.order_payment_facts payment
  WHERE (payment.tenant_id,payment.store_id,payment.order_id)=(o.tenant_id,o.store_id,o.id)
    AND ${unpostedCaptureSql}
)`

// The orders alias belongs to the locked single-order or batch projection.
export const orderHasPendingTableCreditSql = `EXISTS (
  SELECT 1 FROM mbox.table_credit_order_links link
  JOIN mbox.payments payment ON (payment.tenant_id,payment.store_id,payment.prepaid_table_session_id)
    =(link.tenant_id,link.store_id,link.table_session_id)
  WHERE (link.tenant_id,link.store_id,link.order_id)=(orders.tenant_id,orders.store_id,orders.id)
    AND (payment.status IN ('created','pending') OR ${unpostedCaptureSql})
)`
