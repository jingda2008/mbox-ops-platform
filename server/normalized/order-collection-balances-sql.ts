import { orderCollectionDueSql } from './order-collection-sql.js'

/**
 * Tenant/store are $1/$2. Aggregate all dates: older debt must remain visible.
 * All successful refunds form an upper bound (including compensation). Only a
 * proven zero skips the collection authority; positive candidates still use it
 * for settlement exceptions, return allocations and persistent recollection.
 * Materialize once so filtering, sorting and totals cannot repeat that work.
 */
export const orderCollectionBalancesCtesSql = `
  collection_receipts AS (
    SELECT order_id,sum(amount_minor) amount FROM mbox.order_payment_facts
    WHERE tenant_id=$1 AND store_id=$2 AND status IN('succeeded','partially_refunded','refunded') GROUP BY order_id
  ), collection_refunds AS (
    SELECT order_id,sum(amount_minor) amount FROM mbox.order_refund_facts
    WHERE tenant_id=$1 AND store_id=$2 AND status='succeeded' GROUP BY order_id
  ), collection_adjustments AS (
    SELECT order_id,sum(amount_minor) amount,count(*) adjustment_count FROM mbox.item_receivable_adjustment_facts
    WHERE tenant_id=$1 AND store_id=$2 GROUP BY order_id
  ), collection_delivered AS (
    SELECT order_id,sum(total_amount_minor) amount FROM mbox.order_items
    WHERE tenant_id=$1 AND store_id=$2 AND status='delivered' GROUP BY order_id
  ), collection_balances AS MATERIALIZED (
    SELECT o.*,o.total_amount_minor AS original_minor,COALESCE(p.amount,0)::bigint AS received_minor,
      (o.total_amount_minor-COALESCE(a.amount,0))::bigint AS effective_minor,
      COALESCE(a.adjustment_count,0)::bigint AS adjustment_count,
      CASE WHEN (CASE WHEN o.status='cancelled' THEN COALESCE(d.amount,0)
        ELSE o.total_amount_minor-COALESCE(a.amount,0) END)
        -COALESCE(p.amount,0)+COALESCE(r.amount,0)>0
        THEN ${orderCollectionDueSql('o')} ELSE 0 END AS amount
    FROM mbox.orders o
    LEFT JOIN collection_receipts p ON p.order_id=o.id
    LEFT JOIN collection_refunds r ON r.order_id=o.id
    LEFT JOIN collection_adjustments a ON a.order_id=o.id
    LEFT JOIN collection_delivered d ON d.order_id=o.id
    WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.status<>'draft'
  )`

/** The order alias must read from collection_balances, preserving its scope. */
export function bulkOrderNeedsCollectionSql(order: string): string {
  if (!/^[a-z_]+$/.test(order)) throw new TypeError('Invalid order SQL alias')
  return `(${order}.status NOT IN ('draft','cancelled') AND ${order}.amount>0)`
}

/** Every adjusted order retains its existing signal authority, including legacy views. */
export function bulkOrderFinancialAttentionSql(order: string): string {
  if (!/^[a-z_]+$/.test(order)) throw new TypeError('Invalid order SQL alias')
  return `(CASE WHEN ${order}.adjustment_count>0 OR ${order}.received_minor>CASE WHEN ${order}.status='cancelled' THEN 0 ELSE ${order}.original_minor END
    THEN EXISTS(SELECT 1 FROM mbox.payment_financial_monitoring_signals signal
      WHERE signal.tenant_id=${order}.tenant_id AND signal.store_id=${order}.store_id AND signal.subject_id=${order}.id
        AND signal.signal IN ('order_overcollected','cancelled_order_captured')) ELSE false END)`
}
