// The caller selects an authorized table_sessions row named session. All amounts
// use the allocations for this visit, including when only one original is visible on a page.
export const sessionMoneySql = `
  WITH originals AS MATERIALIZED (
    SELECT o.id,o.tenant_id,o.store_id,o.status,o.total_amount_minor
    FROM mbox.orders o WHERE (o.tenant_id,o.store_id,o.table_session_id)
      =(session.tenant_id,session.store_id,session.id)
  ), receipts AS MATERIALIZED (
    SELECT p.id,p.order_id,p.tenant_id,p.store_id,p.provider,p.amount_minor,p.status,p.retry_released_at,p.provider_transaction_id FROM originals o JOIN mbox.order_payment_facts p
      ON (p.tenant_id,p.store_id,p.order_id)=(o.tenant_id,o.store_id,o.id)
    WHERE p.tenant_id=$1 AND p.store_id=$2
  ), returned AS MATERIALIZED (
    SELECT r.order_id,sum(r.amount_minor) AS refunded FROM originals o JOIN mbox.order_refund_facts r
      ON (r.tenant_id,r.store_id,r.order_id)=(o.tenant_id,o.store_id,o.id)
    WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.status='succeeded' GROUP BY r.order_id
  ), captured AS MATERIALIZED (
    SELECT * FROM receipts WHERE status IN ('succeeded','partially_refunded','refunded')
  ), paid_by_order AS (
    SELECT order_id,sum(amount_minor) AS amount FROM captured GROUP BY order_id
  ), adjustments AS (
    SELECT a.order_id,sum(a.amount_minor) AS amount FROM originals o JOIN mbox.item_receivable_adjustment_facts a
      ON (a.tenant_id,a.store_id,a.order_id)=(o.tenant_id,o.store_id,o.id)
    WHERE a.tenant_id=$1 AND a.store_id=$2 GROUP BY a.order_id
  ), due AS MATERIALIZED (
    -- The same upper bound used by the cashier queue. A covered, unrefunded
    -- ordinary sale cannot owe money. All other candidates use the DB authority.
    SELECT CASE WHEN r.order_id IS NULL AND debt.order_id IS NULL
        AND o.total_amount_minor-COALESCE(adj.amount,0)<=COALESCE(paid.amount,0) THEN 0
      WHEN r.order_id IS NULL THEN mbox.order_collection_due_amount(o.tenant_id,o.store_id,o.id)
      ELSE COALESCE((SELECT a.amount_minor FROM mbox.order_recollection_authorizations a
        WHERE (a.tenant_id,a.store_id,a.order_id)=(o.tenant_id,o.store_id,o.id)
        AND a.status='active' AND a.expires_at>statement_timestamp()
        AND a.amount_minor=mbox.order_collection_due_amount_for_mode(o.tenant_id,o.store_id,o.id,true) LIMIT 1),0)
      END AS amount FROM originals o LEFT JOIN returned r ON r.order_id=o.id
    LEFT JOIN paid_by_order paid ON paid.order_id=o.id
    LEFT JOIN adjustments adj ON adj.order_id=o.id
    LEFT JOIN mbox.order_carryover_debts debt ON (debt.tenant_id,debt.store_id,debt.order_id)=(o.tenant_id,o.store_id,o.id)
    WHERE o.status NOT IN ('draft','cancelled')
  ), prepaid AS (
    SELECT p.amount_minor,CASE WHEN NOT EXISTS (SELECT 1 FROM mbox.table_prepayment_revocations v
      WHERE (v.tenant_id,v.store_id,v.payment_id)=(p.tenant_id,p.store_id,p.id))
      THEN mbox.prepayment_available(p.tenant_id,p.store_id,p.id) ELSE 0 END AS available
    FROM mbox.payments p WHERE (p.tenant_id,p.store_id,p.prepaid_table_session_id)=(session.tenant_id,session.store_id,session.id)
      AND p.status IN ('succeeded','partially_refunded','refunded')
  )
  SELECT (SELECT COALESCE(sum(amount_minor),0) FROM captured)::bigint AS gross_collected_minor,
    (SELECT COALESCE(sum(amount_minor),0) FROM prepaid)::bigint AS prepaid_received,
    (SELECT COALESCE(sum(available),0) FROM prepaid)::bigint AS prepaid_available,
    (SELECT COALESCE(sum(refunded),0) FROM returned)::bigint AS refunded_amount_minor,
    (SELECT COALESCE(sum(amount_minor),0) FROM captured WHERE provider='cash')::bigint AS cash_minor,
    (SELECT count(DISTINCT id) FROM captured WHERE provider='cash')::integer AS cash_count,
    (SELECT count(*) FROM due WHERE amount>0)::integer AS unpaid_order_count,
    (SELECT COALESCE(sum(amount),0) FROM due)::bigint AS due_minor,
    (SELECT count(DISTINCT p.id) FROM receipts p WHERE p.status IN ('created','pending')
      AND p.provider IN ('wechat','postar','simulation') AND p.retry_released_at IS NULL
      AND (p.provider_transaction_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM mbox.payment_provider_actions a WHERE (a.tenant_id,a.store_id,a.payment_id)=(p.tenant_id,p.store_id,p.id)
        AND a.state IN ('creating','ready','unknown'))))::integer AS pending_payment_count
`
