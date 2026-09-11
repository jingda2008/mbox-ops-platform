/** Shared business-queue predicate. Unknown attempts never create work themselves. */
export function orderNeedsCollectionSql(order: string): string {
  if (!/^[a-z_]+$/.test(order)) throw new TypeError('Invalid order SQL alias')
  return `(${order}.status NOT IN ('draft','cancelled')
    AND NOT EXISTS (SELECT 1 FROM mbox.order_settlement_exception_events settled
      WHERE settled.tenant_id=${order}.tenant_id AND settled.store_id=${order}.store_id AND settled.order_id=${order}.id)
    AND (${order}.total_amount_minor > COALESCE((SELECT SUM(collected.amount_minor) FROM mbox.order_payment_facts collected
      WHERE collected.tenant_id=${order}.tenant_id AND collected.store_id=${order}.store_id AND collected.order_id=${order}.id
        AND collected.status IN ('succeeded','partially_refunded','refunded')),0)
      OR EXISTS (SELECT 1 FROM mbox.order_recollection_authorizations recollection
        WHERE recollection.tenant_id=${order}.tenant_id AND recollection.store_id=${order}.store_id
          AND recollection.order_id=${order}.id AND recollection.status='active' AND recollection.expires_at>clock_timestamp())))`
}
