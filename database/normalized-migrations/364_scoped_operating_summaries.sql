BEGIN;

CREATE INDEX channel_attribution_visit_orders ON mbox.channel_order_attributions(tenant_id,store_id,visit_id,order_id);
CREATE INDEX channel_correction_visit_orders ON mbox.channel_order_corrections(tenant_id,store_id,visit_id,order_id);

-- Limit by the order's business day first. Later receipts and corrections
-- still belong to that order. Pending refunds can span multiple orders/days.
CREATE FUNCTION mbox.operating_day_summaries(p_tenant uuid,p_store uuid,p_start date,p_end date)
RETURNS TABLE(business_day date,summary jsonb) LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog,mbox SET jit=off AS $report$
 WITH window_orders AS MATERIALIZED (
   SELECT id,business_date,status,total_amount_minor
   FROM mbox.orders
   WHERE tenant_id=p_tenant AND store_id=p_store AND business_date BETWEEN p_start AND p_end
 ), receipts AS (
   SELECT p.order_id,sum(p.amount_minor) AS amount
   FROM mbox.order_payment_facts p JOIN window_orders o ON o.id=p.order_id
   WHERE p.tenant_id=p_tenant AND p.store_id=p_store AND p.status IN('succeeded','partially_refunded','refunded')
   GROUP BY p.order_id
 ), exceptional_orders AS (
   SELECT a.order_id FROM mbox.item_receivable_adjustment_facts a JOIN window_orders o ON o.id=a.order_id
   WHERE a.tenant_id=p_tenant AND a.store_id=p_store
   UNION ALL
   SELECT c.order_id FROM mbox.ticket_dining_collections c JOIN window_orders o ON o.id=c.order_id
   WHERE c.tenant_id=p_tenant AND c.store_id=p_store
   UNION ALL
   SELECT t.order_id FROM mbox.tab_points_requests t JOIN window_orders o ON o.id=t.order_id
   WHERE t.tenant_id=p_tenant AND t.store_id=p_store AND t.state='applied'
   UNION ALL
   SELECT f.order_id FROM mbox.order_refund_facts f JOIN window_orders o ON o.id=f.order_id
   WHERE f.tenant_id=p_tenant AND f.store_id=p_store AND f.status='succeeded'
 ), classified AS MATERIALIZED (
   SELECT o.*,d.order_id IS NULL AND o.status NOT IN('cancelled','draft')
     AND coalesce(p.amount,0)>=o.total_amount_minor
     AND NOT EXISTS(SELECT 1 FROM exceptional_orders e WHERE e.order_id=o.id) AS ordinary_paid
   FROM window_orders o LEFT JOIN receipts p ON p.order_id=o.id
   LEFT JOIN mbox.order_carryover_debts d ON (d.tenant_id,d.store_id,d.order_id)=(p_tenant,p_store,o.id)
   WHERE o.status NOT IN('cancelled','draft') OR d.eligibility='confirmed'
 ), amounts AS MATERIALIZED (
   SELECT business_date,total_amount_minor,
     CASE WHEN ordinary_paid THEN total_amount_minor ELSE mbox.order_financial_receivable_amount(p_tenant,p_store,id) END AS effective,
     CASE WHEN ordinary_paid THEN 0 ELSE mbox.order_collection_due_amount(p_tenant,p_store,id) END AS due
   FROM classified
 ), daily AS (
   SELECT business_date,count(*) AS orders,sum(total_amount_minor) AS original,sum(effective) AS effective,
     sum(total_amount_minor-effective) AS stopped,count(*) FILTER(WHERE due>0) AS unsettled,sum(due) AS due
   FROM amounts GROUP BY business_date
 ), pending AS (
   SELECT o.business_date,count(DISTINCT r.id) AS refunds FROM window_orders o
   JOIN mbox.order_payment_facts p ON (p.tenant_id,p.store_id,p.order_id)=(p_tenant,p_store,o.id)
   JOIN mbox.refunds r ON (r.tenant_id,r.store_id,r.payment_id)=(p.tenant_id,p.store_id,p.id)
     AND (r.order_id IS NULL OR r.order_id=p.order_id)
   WHERE r.status IN('requested','approved','processing','failed')
     AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_refund_retries x
       WHERE (x.tenant_id,x.store_id,x.previous_refund_id)=(r.tenant_id,r.store_id,r.id))
   GROUP BY o.business_date
 )
 SELECT day::date,jsonb_build_object('orderCount',coalesce(d.orders,0),
   'originalOrderAmountMinor',coalesce(d.original,0)::text,'stoppedAmountMinor',coalesce(d.stopped,0)::text,
   'orderAmountMinor',coalesce(d.effective,0)::text,'unsettledCount',coalesce(d.unsettled,0),
   'outstandingMinor',coalesce(d.due,0)::text,'pendingPaymentCount',0,'pendingRefundCount',coalesce(p.refunds,0))
 FROM generate_series(p_start::timestamp,p_end::timestamp,interval '1 day') day
 LEFT JOIN daily d ON d.business_date=day::date LEFT JOIN pending p ON p.business_date=day::date
$report$;

REVOKE ALL ON FUNCTION mbox.operating_day_summaries(uuid,uuid,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.operating_day_summaries(uuid,uuid,date,date) TO mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.operating_day_summary(p_tenant uuid,p_store uuid,p_date date)
RETURNS jsonb LANGUAGE sql STABLE AS $report$
 SELECT summary FROM mbox.operating_day_summaries(p_tenant,p_store,p_date,p_date)
$report$;

UPDATE mbox.normalized_schema_metadata SET schema_version='364',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
