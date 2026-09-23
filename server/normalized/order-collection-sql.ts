/** Shared business-queue predicate. Unknown attempts never create work themselves. */
export function orderNeedsCollectionSql(order: string): string {
  if (!/^[a-z_]+$/.test(order)) throw new TypeError('Invalid order SQL alias')
  return `(${order}.status NOT IN ('draft','cancelled')
    AND NOT EXISTS (SELECT 1 FROM mbox.order_settlement_exception_events settled
      WHERE settled.tenant_id=${order}.tenant_id AND settled.store_id=${order}.store_id AND settled.order_id=${order}.id)
    AND (${orderReceivableSql(order)} > COALESCE((SELECT SUM(collected.amount_minor) FROM mbox.order_payment_facts collected
      WHERE collected.tenant_id=${order}.tenant_id AND collected.store_id=${order}.store_id AND collected.order_id=${order}.id
        AND collected.status IN ('succeeded','partially_refunded','refunded')),0)
      - CASE WHEN EXISTS(SELECT 1 FROM mbox.item_after_sales_price_resolutions price JOIN mbox.item_after_sales_cases accepted ON accepted.tenant_id=price.tenant_id AND accepted.store_id=price.store_id AND accepted.id=price.case_id WHERE price.tenant_id=${order}.tenant_id AND price.store_id=${order}.store_id AND price.order_id=${order}.id AND accepted.status IN('approved','completed'))
        THEN COALESCE((SELECT sum(refund.amount_minor) FROM mbox.order_refund_facts refund WHERE refund.tenant_id=${order}.tenant_id AND refund.store_id=${order}.store_id AND refund.order_id=${order}.id AND refund.status='succeeded'),0) ELSE 0 END
      OR EXISTS (SELECT 1 FROM mbox.order_recollection_authorizations recollection
        WHERE recollection.tenant_id=${order}.tenant_id AND recollection.store_id=${order}.store_id
          AND recollection.order_id=${order}.id AND recollection.status='active' AND recollection.expires_at>clock_timestamp())))`
}

/** Original invoice minus immutable approved stop and repricing adjustments. */
export function orderReceivableSql(order: string): string {
  if (!/^[a-z_]+$/.test(order)) throw new TypeError('Invalid order SQL alias')
  return `(${order}.total_amount_minor - COALESCE((SELECT SUM(adjustment.amount_minor)
    FROM mbox.item_receivable_adjustment_facts adjustment WHERE adjustment.tenant_id=${order}.tenant_id
      AND adjustment.store_id=${order}.store_id AND adjustment.order_id=${order}.id),0))`
}
