import { orderCollectionDueSql } from './order-collection-sql.js'

/**
 * Skip the per-order collection function only when a bulk upper bound proves
 * there can be no debt. All succeeded refunds are included in that bound, even
 * compensation that never reopens collection. Positive candidates still use
 * the authoritative function for exceptions, returns and recollection rights.
 * Do not restrict these facts to the report period: historical debt is included.
 * Parameters: tenant, store, range start, range end, currency.
 */
export const operatingDashboardOrderBalancesSql = `
  WITH receipts AS (
    SELECT order_id,sum(amount_minor) amount FROM mbox.order_payment_facts
    WHERE tenant_id=$1 AND store_id=$2 AND status IN('succeeded','partially_refunded','refunded') GROUP BY order_id
  ), refunds AS (
    SELECT order_id,sum(amount_minor) amount FROM mbox.order_refund_facts
    WHERE tenant_id=$1 AND store_id=$2 AND status='succeeded' GROUP BY order_id
  ), adjustments AS (
    SELECT order_id,sum(amount_minor) amount FROM mbox.item_receivable_adjustment_facts
    WHERE tenant_id=$1 AND store_id=$2 GROUP BY order_id
  ), delivered AS (
    SELECT order_id,sum(total_amount_minor) amount FROM mbox.order_items
    WHERE tenant_id=$1 AND store_id=$2 AND status='delivered' GROUP BY order_id
  ), balances AS MATERIALIZED (
    SELECT o.public_id,o.business_date,o.submitted_at,o.created_at,o.status,o.payment_status,
      CASE WHEN (CASE WHEN o.status='cancelled' THEN COALESCE(d.amount,0)
        ELSE o.total_amount_minor-COALESCE(a.amount,0) END)
        -COALESCE(p.amount,0)+COALESCE(r.amount,0)>0
        THEN ${orderCollectionDueSql('o')} ELSE 0 END amount
    FROM mbox.orders o
    LEFT JOIN receipts p ON p.order_id=o.id
    LEFT JOIN refunds r ON r.order_id=o.id
    LEFT JOIN adjustments a ON a.order_id=o.id
    LEFT JOIN delivered d ON d.order_id=o.id
    WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.currency=$5 AND o.status<>'draft'
  )
  SELECT public_id,'order' source_type,business_date::text,COALESCE(submitted_at,created_at)::text occurred_at,
    amount::text,payment_status IN('paid','partially_refunded','refunded') paid
  FROM balances WHERE (status<>'cancelled' OR amount>0)
    AND (business_date BETWEEN $3::date AND $4::date OR amount>0)
`
