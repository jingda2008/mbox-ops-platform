BEGIN;
CREATE OR REPLACE FUNCTION mbox.operating_day_summary(p_tenant uuid,p_store uuid,p_date date)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH day_orders AS (
   SELECT o.* FROM mbox.orders o WHERE o.tenant_id=p_tenant AND o.store_id=p_store AND o.business_date=p_date
     AND o.status NOT IN ('draft','cancelled')
 ), amounts AS (
   SELECT o.id,o.total_amount_minor,
     CASE WHEN EXISTS(SELECT 1 FROM mbox.order_settlement_exception_events e WHERE e.tenant_id=p_tenant AND e.store_id=p_store AND e.order_id=o.id) THEN 0 ELSE
       GREATEST(0,o.total_amount_minor-COALESCE((SELECT sum(p.amount_minor) FROM mbox.payments p
         WHERE p.tenant_id=p_tenant AND p.store_id=p_store AND p.order_id=o.id
         AND p.status IN ('succeeded','partially_refunded','refunded')),0)
         + CASE WHEN EXISTS(SELECT 1 FROM mbox.order_recollection_authorizations a WHERE a.tenant_id=p_tenant AND a.store_id=p_store AND a.order_id=o.id AND a.status='active' AND a.expires_at>statement_timestamp())
           THEN COALESCE((SELECT sum(r.amount_minor) FROM mbox.refunds r JOIN mbox.payments p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id
             WHERE p.tenant_id=p_tenant AND p.store_id=p_store AND p.order_id=o.id AND r.status='succeeded'),0) ELSE 0 END) END AS outstanding
   FROM day_orders o
 ) SELECT jsonb_build_object(
   'orderCount',(SELECT count(*) FROM amounts),
   'orderAmountMinor',(SELECT COALESCE(sum(total_amount_minor),0)::text FROM amounts),
   'unsettledCount',(SELECT count(*) FROM amounts WHERE outstanding>0),
   'outstandingMinor',(SELECT COALESCE(sum(outstanding),0)::text FROM amounts),
   'pendingPaymentCount',0,
   'pendingRefundCount',(SELECT count(*) FROM mbox.refunds r JOIN mbox.payments p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id
     JOIN mbox.orders o ON o.tenant_id=p.tenant_id AND o.store_id=p.store_id AND o.id=p.order_id
     WHERE p.tenant_id=p_tenant AND p.store_id=p_store AND o.business_date=p_date AND r.status IN ('requested','approved','processing','failed')))
$$;
REVOKE ALL ON FUNCTION mbox.operating_day_summary(uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.operating_day_summary(uuid,uuid,date) TO mbox_runtime;


UPDATE mbox.normalized_schema_metadata SET schema_version='192',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
