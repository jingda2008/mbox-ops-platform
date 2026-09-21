BEGIN;

-- Consumption due is distinct from net cash. Ordinary compensation never
-- silently reopens collection; succeeded quantity returns undo the matching
-- receipt while immutable repricing facts define the retained consumption.
CREATE FUNCTION mbox.order_collection_due_amount(p_tenant uuid,p_store uuid,p_order uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $due$
 SELECT GREATEST(0,
   CASE WHEN EXISTS(SELECT 1 FROM mbox.order_settlement_exception_events exception
     WHERE (exception.tenant_id,exception.store_id,exception.order_id)=(ordering.tenant_id,ordering.store_id,ordering.id)) THEN 0
   WHEN ordering.status='cancelled' THEN COALESCE((SELECT sum(item.total_amount_minor) FROM mbox.order_items item
     WHERE (item.tenant_id,item.store_id,item.order_id)=(ordering.tenant_id,ordering.store_id,ordering.id) AND item.status='delivered'),0)
   ELSE mbox.order_receivable_amount(ordering.tenant_id,ordering.store_id,ordering.id) END
   - COALESCE((SELECT sum(receipt.amount_minor) FROM mbox.order_payment_facts receipt
       WHERE (receipt.tenant_id,receipt.store_id,receipt.order_id)=(ordering.tenant_id,ordering.store_id,ordering.id)
         AND receipt.status IN('succeeded','partially_refunded','refunded')),0)
   + CASE WHEN EXISTS(SELECT 1 FROM mbox.order_settlement_exception_events exception
       WHERE (exception.tenant_id,exception.store_id,exception.order_id)=(ordering.tenant_id,ordering.store_id,ordering.id)) THEN 0
     ELSE COALESCE((SELECT sum(refund.amount_minor) FROM mbox.order_refund_facts refund
       WHERE (refund.tenant_id,refund.store_id,refund.order_id)=(ordering.tenant_id,ordering.store_id,ordering.id) AND refund.status='succeeded'
         AND (EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds original
           WHERE (original.tenant_id,original.store_id,original.refund_id)=(refund.tenant_id,refund.store_id,refund.id))
         OR EXISTS(SELECT 1 FROM mbox.order_recollection_authorizations recollection
           WHERE (recollection.tenant_id,recollection.store_id,recollection.order_id)=(ordering.tenant_id,ordering.store_id,ordering.id)
             AND recollection.status='active' AND recollection.expires_at>statement_timestamp()))),0) END
 )::bigint
 FROM mbox.orders ordering WHERE (ordering.tenant_id,ordering.store_id,ordering.id)=(p_tenant,p_store,p_order)
$due$;
REVOKE ALL ON FUNCTION mbox.order_collection_due_amount(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_collection_due_amount(uuid,uuid,uuid) TO mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.operating_day_summary(p_tenant uuid,p_store uuid,p_date date)
RETURNS jsonb LANGUAGE sql STABLE AS $summary$
 WITH day_orders AS (
   SELECT o.*,mbox.order_receivable_amount(o.tenant_id,o.store_id,o.id) AS effective_minor
   FROM mbox.orders o WHERE o.tenant_id=p_tenant AND o.store_id=p_store AND o.business_date=p_date
     AND o.status NOT IN ('draft','cancelled')
 ), amounts AS (
   SELECT o.id,o.total_amount_minor,o.effective_minor,
     mbox.order_collection_due_amount(o.tenant_id,o.store_id,o.id) AS outstanding
   FROM day_orders o
 ) SELECT jsonb_build_object(
   'orderCount',(SELECT count(*) FROM amounts),
   'originalOrderAmountMinor',(SELECT COALESCE(sum(total_amount_minor),0)::text FROM amounts),
   'stoppedAmountMinor',(SELECT COALESCE(sum(total_amount_minor-effective_minor),0)::text FROM amounts),
   'orderAmountMinor',(SELECT COALESCE(sum(effective_minor),0)::text FROM amounts),
   'unsettledCount',(SELECT count(*) FROM amounts WHERE outstanding>0),
   'outstandingMinor',(SELECT COALESCE(sum(outstanding),0)::text FROM amounts),
   'pendingPaymentCount',0,
   'pendingRefundCount',(SELECT count(*) FROM mbox.refunds r
     WHERE r.tenant_id=p_tenant AND r.store_id=p_store AND r.status IN ('requested','approved','processing','failed')
       AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_refund_retries superseded WHERE superseded.tenant_id=r.tenant_id AND superseded.store_id=r.store_id AND superseded.previous_refund_id=r.id)
       AND EXISTS(SELECT 1 FROM mbox.order_payment_facts p JOIN mbox.orders o ON o.tenant_id=p.tenant_id AND o.store_id=p.store_id AND o.id=p.order_id
         WHERE p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id AND (r.order_id IS NULL OR r.order_id=p.order_id) AND o.business_date=p_date)))
$summary$;

UPDATE mbox.normalized_schema_metadata SET schema_version='231',updated_at=clock_timestamp()
 WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
