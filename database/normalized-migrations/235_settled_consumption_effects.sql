BEGIN;

-- A one-use payment permission can expire or be consumed by an unpaid attempt.
-- Its confirmed recollection obligation remains bound to the original refunds;
-- a later refund is never silently covered by an earlier authorization.
LOCK TABLE mbox.order_recollection_authorizations IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE mbox.order_recollection_authorizations ADD CONSTRAINT recollection_authorization_order_identity
 UNIQUE(tenant_id,store_id,id,order_id);
CREATE TABLE mbox.order_recollection_refund_obligations (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_id uuid NOT NULL,
 refund_id uuid NOT NULL,authorization_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,order_id,refund_id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,refund_id) REFERENCES mbox.refunds(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,authorization_id,order_id) REFERENCES mbox.order_recollection_authorizations(tenant_id,store_id,id,order_id)
);
INSERT INTO mbox.order_recollection_refund_obligations(tenant_id,store_id,order_id,refund_id,authorization_id)
 SELECT DISTINCT ON(a.tenant_id,a.store_id,a.order_id,r.id) a.tenant_id,a.store_id,a.order_id,r.id,a.id
 FROM mbox.order_recollection_authorizations a
 JOIN mbox.order_refund_facts r ON (r.tenant_id,r.store_id,r.order_id)=(a.tenant_id,a.store_id,a.order_id)
 JOIN mbox.refunds original ON (original.tenant_id,original.store_id,original.id)=(r.tenant_id,r.store_id,r.id)
 WHERE r.status='succeeded' AND r.completed_at<=a.created_at
   AND original.purpose IS DISTINCT FROM 'service_compensation'
   AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds q
     WHERE (q.tenant_id,q.store_id,q.refund_id)=(r.tenant_id,r.store_id,r.id))
 ORDER BY a.tenant_id,a.store_id,a.order_id,r.id,a.created_at,a.id;
ALTER TABLE mbox.order_recollection_refund_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.order_recollection_refund_obligations FORCE ROW LEVEL SECURITY;
CREATE POLICY recollection_obligation_scope ON mbox.order_recollection_refund_obligations
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
CREATE TRIGGER recollection_obligation_append_only BEFORE UPDATE OR DELETE ON mbox.order_recollection_refund_obligations
 FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
REVOKE ALL ON mbox.order_recollection_refund_obligations FROM PUBLIC;
GRANT SELECT,INSERT ON mbox.order_recollection_refund_obligations TO mbox_runtime;
CREATE FUNCTION mbox.validate_order_recollection_obligation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $validate$
BEGIN
 IF NOT EXISTS(
   SELECT 1 FROM mbox.order_recollection_authorizations a
   JOIN mbox.order_refund_facts r ON (r.tenant_id,r.store_id,r.order_id)=(a.tenant_id,a.store_id,a.order_id)
   JOIN mbox.refunds original ON (original.tenant_id,original.store_id,original.id)=(r.tenant_id,r.store_id,r.id)
   WHERE (a.tenant_id,a.store_id,a.order_id,a.id)=(NEW.tenant_id,NEW.store_id,NEW.order_id,NEW.authorization_id)
     AND r.id=NEW.refund_id AND r.status='succeeded' AND r.completed_at<=a.created_at
     AND original.purpose IS DISTINCT FROM 'service_compensation'
     AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds q
       WHERE (q.tenant_id,q.store_id,q.refund_id)=(r.tenant_id,r.store_id,r.id))
 ) THEN RAISE EXCEPTION 'recollection obligation requires the original authorized order and succeeded refund'
   USING ERRCODE='23503'; END IF;
 RETURN NEW;
END $validate$;
REVOKE ALL ON FUNCTION mbox.validate_order_recollection_obligation() FROM PUBLIC;
CREATE TRIGGER recollection_obligation_original_facts BEFORE INSERT ON mbox.order_recollection_refund_obligations
 FOR EACH ROW EXECUTE FUNCTION mbox.validate_order_recollection_obligation();
CREATE FUNCTION mbox.capture_order_recollection_obligations() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $capture$
BEGIN
 INSERT INTO mbox.order_recollection_refund_obligations(tenant_id,store_id,order_id,refund_id,authorization_id)
 SELECT NEW.tenant_id,NEW.store_id,NEW.order_id,r.id,NEW.id
 FROM mbox.order_refund_facts r
 JOIN mbox.refunds original ON (original.tenant_id,original.store_id,original.id)=(r.tenant_id,r.store_id,r.id)
 WHERE (r.tenant_id,r.store_id,r.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id)
   AND r.status='succeeded' AND r.completed_at<=NEW.created_at
   AND original.purpose IS DISTINCT FROM 'service_compensation'
   AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds q
     WHERE (q.tenant_id,q.store_id,q.refund_id)=(r.tenant_id,r.store_id,r.id))
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $capture$;
REVOKE ALL ON FUNCTION mbox.capture_order_recollection_obligations() FROM PUBLIC;
CREATE TRIGGER recollection_authorization_obligations AFTER INSERT ON mbox.order_recollection_authorizations
 FOR EACH ROW EXECUTE FUNCTION mbox.capture_order_recollection_obligations();
DO $obligation$
DECLARE original text;needle text := 'OR p_allow_ordinary_refunds';
BEGIN
 SELECT pg_get_functiondef('mbox.order_collection_due_amount_for_mode(uuid,uuid,uuid,boolean)'::regprocedure) INTO original;
 IF position(needle IN original)=0 THEN RAISE EXCEPTION 'Unexpected collection balance definition'; END IF;
 EXECUTE replace(original,needle,needle || ' OR EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
 WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id,obligation.refund_id)=(refund.tenant_id,refund.store_id,refund.order_id,refund.id))');
END $obligation$;
CREATE OR REPLACE FUNCTION mbox.order_collection_due_amount(p_tenant uuid,p_store uuid,p_order uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $due$
 SELECT mbox.order_collection_due_amount_for_mode(p_tenant,p_store,p_order,false)
$due$;

-- Financial refund status remains historical truth. Completion effects use
-- confirmed receipts and the collectible balance, including retained compensation.
CREATE FUNCTION mbox.order_consumption_settled(p_tenant uuid,p_store uuid,p_order uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $settled$
 SELECT EXISTS (
   SELECT 1 FROM mbox.orders ordering
   WHERE (ordering.tenant_id,ordering.store_id,ordering.id)=(p_tenant,p_store,p_order)
     AND ordering.status NOT IN ('draft','cancelled')
     AND NOT EXISTS(SELECT 1 FROM mbox.order_settlement_exception_events exception
       WHERE (exception.tenant_id,exception.store_id,exception.order_id)=(p_tenant,p_store,p_order))
     AND EXISTS(SELECT 1 FROM mbox.order_payment_facts receipt
       WHERE (receipt.tenant_id,receipt.store_id,receipt.order_id)=(p_tenant,p_store,p_order)
         AND receipt.status IN ('succeeded','partially_refunded','refunded')
         AND receipt.succeeded_at IS NOT NULL AND receipt.amount_minor>0)
     AND mbox.order_collection_due_amount_for_mode(p_tenant,p_store,p_order,true)=0
 )
$settled$;
REVOKE ALL ON FUNCTION mbox.order_consumption_settled(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_consumption_settled(uuid,uuid,uuid) TO mbox_runtime;

-- Preserve the existing independent points-redemption authorization branch.
DO $upgrade$
DECLARE original text;needle text := '    SELECT NEW.total_amount_minor=0';
BEGIN
 SELECT pg_get_functiondef('mbox.enforce_order_payment_fulfillment_gate()'::regprocedure) INTO original;
 IF position(needle IN original)=0 OR position('points_redemption_authorized' IN original)=0 THEN
   RAISE EXCEPTION 'Unexpected immediate fulfillment gate definition';
 END IF;
 EXECUTE replace(original,needle,
   '    IF mbox.order_consumption_settled(NEW.tenant_id,NEW.store_id,NEW.id) THEN RETURN NEW; END IF;' || chr(10) || needle);
END
$upgrade$;

DO $capacity$
DECLARE original text;needle text := 'order_row.payment_status<>''paid'' AND NOT points_redemption_authorized';
BEGIN
 SELECT pg_get_functiondef('mbox.activate_order_fulfillment_capacity(uuid,uuid,uuid)'::regprocedure) INTO original;
 IF position(needle IN original)=0 THEN RAISE EXCEPTION 'Unexpected capacity activation gate definition'; END IF;
 EXECUTE replace(original,needle,needle || ' AND NOT mbox.order_consumption_settled(p_tenant_id,p_store_id,p_order_id)');
END $capacity$;

UPDATE mbox.normalized_schema_metadata SET schema_version='235',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
