/** Shared consumption queue. Pending attempts are never receipts or customer debt. */
export function orderNeedsCollectionSql(order: string): string {
  if (!/^[a-z_]+$/.test(order)) throw new TypeError('Invalid order SQL alias')
  return `(${order}.status NOT IN ('draft','cancelled') AND ${orderCollectionDueSql(order)}>0)`
}

/** One authoritative projection for collection, table closure, printing and reports. */
export function orderCollectionDueSql(order: string): string {
  if (!/^[a-z_]+$/.test(order)) throw new TypeError('Invalid order SQL alias')
  return `mbox.order_collection_due_amount(${order}.tenant_id,${order}.store_id,${order}.id)`
}

/** Original invoice minus immutable approved stop and repricing adjustments. */
export function orderReceivableSql(order: string): string {
  if (!/^[a-z_]+$/.test(order)) throw new TypeError('Invalid order SQL alias')
  return `(${order}.total_amount_minor - COALESCE((SELECT SUM(adjustment.amount_minor)
    FROM mbox.item_receivable_adjustment_facts adjustment WHERE adjustment.tenant_id=${order}.tenant_id
      AND adjustment.store_id=${order}.store_id AND adjustment.order_id=${order}.id),0))`
}
