BEGIN;

-- An ordinary recollection authorization is not a reversal of approved service
-- compensation. Share one amount calculation between authorization, individual
-- and allocated payments, bills, closure and reports. Actual cash/refund ledgers
-- retain every successful refund; no financial fact is rewritten here.
CREATE FUNCTION mbox.order_collection_due_amount_for_mode(p_tenant uuid,p_store uuid,p_order uuid,p_allow_ordinary_refunds boolean)
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
       JOIN mbox.refunds original_refund ON (original_refund.tenant_id,original_refund.store_id,original_refund.id)=(refund.tenant_id,refund.store_id,refund.id)
       WHERE (refund.tenant_id,refund.store_id,refund.order_id)=(ordering.tenant_id,ordering.store_id,ordering.id) AND refund.status='succeeded'
         AND original_refund.purpose IS DISTINCT FROM 'service_compensation'
         AND (EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds original
           WHERE (original.tenant_id,original.store_id,original.refund_id)=(refund.tenant_id,refund.store_id,refund.id))
         OR p_allow_ordinary_refunds)),0) END
 )::bigint
 FROM mbox.orders ordering WHERE (ordering.tenant_id,ordering.store_id,ordering.id)=(p_tenant,p_store,p_order)
$due$;
REVOKE ALL ON FUNCTION mbox.order_collection_due_amount_for_mode(uuid,uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_collection_due_amount_for_mode(uuid,uuid,uuid,boolean) TO mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.order_collection_due_amount(p_tenant uuid,p_store uuid,p_order uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $due$
 SELECT mbox.order_collection_due_amount_for_mode(p_tenant,p_store,p_order,EXISTS(
   SELECT 1 FROM mbox.order_recollection_authorizations recollection
   WHERE (recollection.tenant_id,recollection.store_id,recollection.order_id)=(p_tenant,p_store,p_order)
     AND recollection.status='active' AND recollection.expires_at>statement_timestamp()
 ))
$due$;
REVOKE ALL ON FUNCTION mbox.order_collection_due_amount(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_collection_due_amount(uuid,uuid,uuid) TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata SET schema_version='234',updated_at=clock_timestamp()
 WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
