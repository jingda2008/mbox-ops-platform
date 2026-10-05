BEGIN;

-- Logical order is assigned only after the shared session/order locks. Wall
-- clocks remain audit/display facts, never the order of new recollection facts.
-- NULL means pre-migration evidence; do not invent an order for old rows.
CREATE SEQUENCE mbox.financial_fact_sequence AS bigint NO CYCLE CACHE 1;
REVOKE ALL ON SEQUENCE mbox.financial_fact_sequence FROM PUBLIC,mbox_runtime;
ALTER TABLE mbox.payments ADD COLUMN local_financial_sequence bigint CHECK(local_financial_sequence>0);
ALTER TABLE mbox.reconciliation_entries ADD COLUMN local_financial_sequence bigint CHECK(local_financial_sequence>0);
ALTER TABLE mbox.order_recollection_authorizations
 ADD COLUMN local_financial_sequence bigint CHECK(local_financial_sequence>0),
 ADD COLUMN captured_refund_ids uuid[];
CREATE UNIQUE INDEX payment_local_financial_sequence ON mbox.payments(local_financial_sequence);
CREATE UNIQUE INDEX reconciliation_local_financial_sequence ON mbox.reconciliation_entries(local_financial_sequence);
CREATE UNIQUE INDEX recollection_local_financial_sequence ON mbox.order_recollection_authorizations(local_financial_sequence);

CREATE FUNCTION mbox.lock_financial_causal_order() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,mbox AS $lock$
DECLARE target_ids uuid[]; item record;
BEGIN
 IF TG_TABLE_NAME='order_recollection_authorizations' THEN
   target_ids:=ARRAY[NEW.order_id];
 ELSIF TG_TABLE_NAME='payments' THEN
   IF NEW.payable_kind='order' THEN target_ids:=ARRAY[NEW.order_id];
   ELSIF NEW.payable_kind='order_batch' THEN
     SELECT array_agg(order_id ORDER BY order_id) INTO target_ids FROM mbox.order_payment_allocations
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND batch_id=NEW.order_batch_id;
   END IF;
 ELSIF TG_TABLE_NAME='reconciliation_entries' AND NEW.payment_id IS NOT NULL THEN
   SELECT array_agg(order_id ORDER BY order_id) INTO target_ids FROM mbox.order_payment_facts
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.payment_id;
 END IF;
 -- A batch payment must already have its immutable allocation rows, as in the
 -- repository. Deferred totals constraints must not let an empty batch skip
 -- serialization and acquire an unanchored sequence.
 IF COALESCE(cardinality(target_ids),0)=0 AND (
   (TG_TABLE_NAME='payments' AND to_jsonb(NEW)->>'payable_kind' IN('order','order_batch'))
   OR (TG_TABLE_NAME='order_recollection_authorizations')
   OR (TG_TABLE_NAME='reconciliation_entries' AND EXISTS(
     SELECT 1 FROM mbox.payments p WHERE (p.tenant_id,p.store_id,p.id)
       =(NEW.tenant_id,NEW.store_id,(to_jsonb(NEW)->>'payment_id')::uuid)
       AND p.payable_kind IN('order','order_batch')))
 ) THEN RAISE EXCEPTION 'financial causal target requires original order allocations' USING ERRCODE='23503'; END IF;
 IF COALESCE(cardinality(target_ids),0)>0 THEN
   -- Same parent-first hierarchy as normal capture, refunds and table closure;
   -- all batch orders are locked in UUID order, never caller/allocation order.
   FOR item IN SELECT session.id FROM mbox.table_sessions session
     WHERE session.tenant_id=NEW.tenant_id AND session.store_id=NEW.store_id
       AND session.id IN(SELECT table_session_id FROM mbox.orders WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=ANY(target_ids))
     ORDER BY session.id FOR SHARE
   LOOP NULL; END LOOP;
   FOR item IN SELECT id FROM mbox.orders
     WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=ANY(target_ids)
     ORDER BY id FOR UPDATE
   LOOP NULL; END LOOP;
   IF (SELECT count(*) FROM mbox.orders WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=ANY(target_ids))<>cardinality(target_ids) THEN
     RAISE EXCEPTION 'financial causal target is not visible' USING ERRCODE='23503';
   END IF;
 END IF;
 IF TG_TABLE_NAME='order_recollection_authorizations' THEN
   SELECT COALESCE(array_agg(r.id ORDER BY r.id),'{}'::uuid[]) INTO NEW.captured_refund_ids
   FROM mbox.order_refund_facts r JOIN mbox.refunds original
     ON (original.tenant_id,original.store_id,original.id)=(r.tenant_id,r.store_id,r.id)
   WHERE (r.tenant_id,r.store_id,r.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id)
     AND r.status='succeeded' AND original.purpose IS DISTINCT FROM 'service_compensation'
     -- Already fully restored refunds cannot be lent to a later authorization.
     -- Partial/unrestored allocations remain eligible for the final receipt.
     AND (NOT EXISTS(SELECT 1 FROM mbox.order_recollection_item_restorations restored
       WHERE (restored.tenant_id,restored.store_id,restored.order_id,restored.refund_id)
         =(r.tenant_id,r.store_id,r.order_id,r.id))
       OR EXISTS(SELECT 1 FROM mbox.refund_items allocation
         JOIN mbox.order_items original_item ON (original_item.tenant_id,original_item.store_id,original_item.id)
           =(allocation.tenant_id,allocation.store_id,allocation.order_item_id)
         WHERE (allocation.tenant_id,allocation.store_id,allocation.refund_id,original_item.order_id)
           =(r.tenant_id,r.store_id,r.id,r.order_id) AND allocation.amount_minor>0
           AND NOT EXISTS(SELECT 1 FROM mbox.order_recollection_item_restorations restored
             WHERE (restored.tenant_id,restored.store_id,restored.refund_id,restored.order_item_id)
               =(allocation.tenant_id,allocation.store_id,allocation.refund_id,allocation.order_item_id))))
     AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds q
       WHERE (q.tenant_id,q.store_id,q.refund_id)=(r.tenant_id,r.store_id,r.id));
 END IF;
 RETURN NEW;
END $lock$;
REVOKE ALL ON FUNCTION mbox.lock_financial_causal_order() FROM PUBLIC;

-- This definer only stamps NEW with a private counter. It cannot read or write
-- business rows and cannot be invoked as an ordinary SQL function.
CREATE FUNCTION mbox.stamp_financial_causal_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $stamp$
BEGIN
 IF TG_TABLE_SCHEMA<>'mbox' OR TG_TABLE_NAME NOT IN('payments','reconciliation_entries','order_recollection_authorizations') THEN
   RAISE EXCEPTION 'unsupported financial causal target' USING ERRCODE='23514';
 END IF;
 NEW.local_financial_sequence:=nextval('mbox.financial_fact_sequence'::regclass);
 RETURN NEW;
END $stamp$;
REVOKE ALL ON FUNCTION mbox.stamp_financial_causal_order() FROM PUBLIC,mbox_runtime;

CREATE FUNCTION mbox.protect_financial_causal_order() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,mbox AS $protect$
BEGIN
 IF NEW.local_financial_sequence IS DISTINCT FROM OLD.local_financial_sequence THEN
   RAISE EXCEPTION 'financial causal sequence is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='order_recollection_authorizations' THEN
   IF (NEW.tenant_id,NEW.store_id,NEW.id,NEW.order_id,NEW.amount_minor,NEW.currency,NEW.authorized_by_employee_id,NEW.captured_refund_ids)
     IS DISTINCT FROM (OLD.tenant_id,OLD.store_id,OLD.id,OLD.order_id,OLD.amount_minor,OLD.currency,OLD.authorized_by_employee_id,OLD.captured_refund_ids)
     OR (OLD.status='consumed' AND (NEW.status,NEW.consumed_payment_id) IS DISTINCT FROM (OLD.status,OLD.consumed_payment_id)) THEN
     RAISE EXCEPTION 'recollection causal identity is immutable' USING ERRCODE='55000';
   END IF;
   IF NEW.status='consumed' AND OLD.status<>'consumed' AND NEW.local_financial_sequence IS NOT NULL THEN
     IF OLD.status<>'active' OR NOT EXISTS(
       SELECT 1 FROM mbox.payments payment JOIN mbox.order_payment_facts allocation
        ON (allocation.tenant_id,allocation.store_id,allocation.id)=(payment.tenant_id,payment.store_id,payment.id)
       WHERE (payment.tenant_id,payment.store_id,payment.id)=(NEW.tenant_id,NEW.store_id,NEW.consumed_payment_id)
         AND allocation.order_id=NEW.order_id AND allocation.currency=NEW.currency
         AND allocation.amount_minor>0 AND allocation.amount_minor<=NEW.amount_minor
         AND payment.local_financial_sequence>NEW.local_financial_sequence
     ) THEN RAISE EXCEPTION 'recollection consumption requires a later original payment' USING ERRCODE='55000'; END IF;
   END IF;
 END IF;
 RETURN NEW;
END $protect$;
REVOKE ALL ON FUNCTION mbox.protect_financial_causal_order() FROM PUBLIC;
DO $triggers$
DECLARE target text;
BEGIN
 FOREACH target IN ARRAY ARRAY['payments','reconciliation_entries','order_recollection_authorizations'] LOOP
   EXECUTE format('CREATE TRIGGER z_financial_causal_lock BEFORE INSERT ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.lock_financial_causal_order()',target);
   EXECUTE format('CREATE TRIGGER zz_financial_causal_stamp BEFORE INSERT ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.stamp_financial_causal_order()',target);
   EXECUTE format('CREATE TRIGGER financial_causal_immutable BEFORE UPDATE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.protect_financial_causal_order()',target);
 END LOOP;
END $triggers$;

CREATE OR REPLACE FUNCTION mbox.validate_order_recollection_obligation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $validate$
BEGIN
 IF NOT EXISTS(
   SELECT 1 FROM mbox.order_recollection_authorizations a
   JOIN mbox.order_refund_facts r ON (r.tenant_id,r.store_id,r.order_id)=(a.tenant_id,a.store_id,a.order_id)
   JOIN mbox.refunds original ON (original.tenant_id,original.store_id,original.id)=(r.tenant_id,r.store_id,r.id)
   WHERE (a.tenant_id,a.store_id,a.order_id,a.id)=(NEW.tenant_id,NEW.store_id,NEW.order_id,NEW.authorization_id)
     AND r.id=NEW.refund_id AND r.status='succeeded' AND ((a.local_financial_sequence IS NOT NULL AND r.id=ANY(a.captured_refund_ids)) OR (a.local_financial_sequence IS NULL AND r.completed_at<=a.created_at))
     AND original.purpose IS DISTINCT FROM 'service_compensation'
     AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds q
       WHERE (q.tenant_id,q.store_id,q.refund_id)=(r.tenant_id,r.store_id,r.id))
 ) THEN RAISE EXCEPTION 'recollection obligation requires the original authorized order and succeeded refund'
   USING ERRCODE='23503'; END IF;
 RETURN NEW;
END $validate$;

CREATE OR REPLACE FUNCTION mbox.capture_order_recollection_obligations() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $capture$
BEGIN
 INSERT INTO mbox.order_recollection_refund_obligations(tenant_id,store_id,order_id,refund_id,authorization_id)
 SELECT NEW.tenant_id,NEW.store_id,NEW.order_id,r.id,NEW.id
 FROM mbox.order_refund_facts r
 JOIN mbox.refunds original ON (original.tenant_id,original.store_id,original.id)=(r.tenant_id,r.store_id,r.id)
 WHERE (r.tenant_id,r.store_id,r.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id)
   AND r.status='succeeded' AND ((NEW.local_financial_sequence IS NOT NULL AND r.id=ANY(NEW.captured_refund_ids)) OR (NEW.local_financial_sequence IS NULL AND r.completed_at<=NEW.created_at))
   AND original.purpose IS DISTINCT FROM 'service_compensation'
   AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds q
     WHERE (q.tenant_id,q.store_id,q.refund_id)=(r.tenant_id,r.store_id,r.id))
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $capture$;

CREATE OR REPLACE FUNCTION mbox.order_recollection_item_restoration_valid(
  p_tenant uuid,p_store uuid,p_order uuid,p_refund uuid,p_item uuid,p_payment uuid
) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog,mbox AS $valid$
  SELECT p_tenant=mbox.current_tenant_id() AND p_store=mbox.current_store_id() AND EXISTS (
    SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
    JOIN mbox.refunds refund ON (refund.tenant_id,refund.store_id,refund.id)
      =(obligation.tenant_id,obligation.store_id,obligation.refund_id)
      AND refund.status='succeeded' AND refund.purpose IS DISTINCT FROM 'service_compensation'
    JOIN mbox.refund_items item ON (item.tenant_id,item.store_id,item.refund_id)
      =(refund.tenant_id,refund.store_id,refund.id)
      AND item.order_item_id=p_item AND item.amount_minor>0 AND item.currency=refund.currency
    JOIN mbox.order_items original_item ON (original_item.tenant_id,original_item.store_id,original_item.order_id,original_item.id)
      =(item.tenant_id,item.store_id,obligation.order_id,item.order_item_id)
      AND original_item.currency=item.currency
    JOIN mbox.order_recollection_authorizations approval
      ON (approval.tenant_id,approval.store_id,approval.id,approval.order_id)
        =(obligation.tenant_id,obligation.store_id,obligation.authorization_id,obligation.order_id)
    JOIN mbox.order_payment_facts receipt ON (receipt.tenant_id,receipt.store_id,receipt.order_id)
      =(obligation.tenant_id,obligation.store_id,obligation.order_id)
      AND receipt.id=p_payment AND receipt.amount_minor>0 AND receipt.currency=item.currency
      AND receipt.status IN ('succeeded','partially_refunded','refunded')
    JOIN mbox.payments payment ON (payment.tenant_id,payment.store_id,payment.id)
      =(receipt.tenant_id,receipt.store_id,receipt.id)
    JOIN mbox.reconciliation_entries current_ledger
      ON (current_ledger.tenant_id,current_ledger.store_id,current_ledger.payment_id)=(payment.tenant_id,payment.store_id,payment.id)
      AND current_ledger.entry_type='payment' AND current_ledger.amount_minor=payment.amount_minor
      AND current_ledger.currency=payment.currency AND current_ledger.provider=payment.provider
    WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id,obligation.refund_id)
      =(p_tenant,p_store,p_order,p_refund)
      AND (
        -- Legacy evidence is not backfilled into invented historical sequence.
        (current_ledger.local_financial_sequence IS NULL AND approval.local_financial_sequence IS NULL
          AND receipt.succeeded_at>=refund.completed_at AND receipt.succeeded_at>=approval.created_at)
        OR (current_ledger.local_financial_sequence IS NOT NULL AND EXISTS(
          SELECT 1 FROM mbox.order_recollection_authorizations consumed
          WHERE (consumed.tenant_id,consumed.store_id,consumed.order_id,consumed.consumed_payment_id)
            =(p_tenant,p_store,p_order,p_payment) AND consumed.status='consumed'
            AND ((consumed.local_financial_sequence IS NOT NULL
              AND refund.id=ANY(consumed.captured_refund_ids)
              AND payment.local_financial_sequence>consumed.local_financial_sequence)
              OR (consumed.local_financial_sequence IS NULL
                AND receipt.succeeded_at>=refund.completed_at
                AND receipt.succeeded_at>=approval.created_at
                AND refund.completed_at<=consumed.created_at))
        ))
      )
      AND NOT EXISTS (SELECT 1 FROM mbox.item_after_sales_case_refunds quantity_refund
        WHERE (quantity_refund.tenant_id,quantity_refund.store_id,quantity_refund.refund_id)
          =(refund.tenant_id,refund.store_id,refund.id))
      AND (SELECT count(*) FROM mbox.reconciliation_entries ledger
        WHERE (ledger.tenant_id,ledger.store_id,ledger.payment_id)=(payment.tenant_id,payment.store_id,payment.id)
          AND ledger.entry_type='payment' AND ledger.amount_minor=payment.amount_minor
          AND ledger.currency=payment.currency AND ledger.provider=payment.provider)=1
      -- Bind the latest locally recorded confirmed receipt. An earlier partial
      -- receipt cannot acquire a false settlement time after another receipt
      -- eventually completes the debt. Provider occurrence time can be delayed.
      AND NOT EXISTS (
        SELECT 1 FROM mbox.order_payment_facts later_receipt
        JOIN mbox.reconciliation_entries later_ledger
          ON (later_ledger.tenant_id,later_ledger.store_id,later_ledger.payment_id)
            =(later_receipt.tenant_id,later_receipt.store_id,later_receipt.id)
          AND later_ledger.entry_type='payment'
        WHERE (later_receipt.tenant_id,later_receipt.store_id,later_receipt.order_id)
            =(p_tenant,p_store,p_order)
          AND later_receipt.status IN ('succeeded','partially_refunded','refunded')
          AND later_receipt.amount_minor>0
          AND ((later_ledger.local_financial_sequence IS NOT NULL
              AND (current_ledger.local_financial_sequence IS NULL OR later_ledger.local_financial_sequence>current_ledger.local_financial_sequence))
            OR (later_ledger.local_financial_sequence IS NULL AND current_ledger.local_financial_sequence IS NULL
              AND (later_ledger.created_at,later_ledger.id)>(current_ledger.created_at,current_ledger.id)))
      )
      AND NOT EXISTS (SELECT 1 FROM mbox.order_payment_facts pending
        WHERE (pending.tenant_id,pending.store_id,pending.order_id)=(p_tenant,p_store,p_order)
          AND (pending.status IN ('created','pending') OR EXISTS(
            SELECT 1 FROM mbox.verified_provider_observations observation
            WHERE (observation.tenant_id,observation.store_id,observation.payment_id)
              =(pending.tenant_id,pending.store_id,pending.id)
              AND observation.observed_status='payment_succeeded' AND observation.consumed_at IS NULL)))
      AND NOT EXISTS (SELECT 1 FROM mbox.order_refund_facts unresolved_refund
        JOIN mbox.verified_provider_observations observation
          ON (observation.tenant_id,observation.store_id,observation.refund_id)
            =(unresolved_refund.tenant_id,unresolved_refund.store_id,unresolved_refund.id)
        WHERE (unresolved_refund.tenant_id,unresolved_refund.store_id,unresolved_refund.order_id)=(p_tenant,p_store,p_order)
          AND observation.observed_status='refund_succeeded' AND observation.consumed_at IS NULL)
      AND mbox.order_consumption_settled(p_tenant,p_store,p_order)
  )
$valid$;

UPDATE mbox.normalized_schema_metadata SET schema_version='264',updated_at=clock_timestamp()
 WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
