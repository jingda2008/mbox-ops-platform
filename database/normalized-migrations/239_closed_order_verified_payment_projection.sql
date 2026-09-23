BEGIN;

-- A late original capture after a completed refund can legitimately change a
-- closed order from refunded to partially_refunded (or paid). This predicate
-- admits only that derived projection, never a new operating or money fact.
CREATE FUNCTION mbox.allow_closed_order_verified_payment_projection(p_old jsonb,p_new jsonb,p_session uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,mbox AS $guard$
DECLARE
 tenant uuid:=(p_new->>'tenant_id')::uuid; store uuid:=(p_new->>'store_id')::uuid;
 target uuid:=(p_new->>'id')::uuid; closed_at_value timestamptz;
 gross numeric; refunded numeric; receivable numeric; expected text;
BEGIN
 IF tenant IS DISTINCT FROM mbox.current_tenant_id() OR store IS DISTINCT FROM mbox.current_store_id()
   OR p_old->>'payment_status'<>'refunded' OR p_new->>'payment_status' NOT IN ('paid','partially_refunded')
   OR (p_new-ARRAY['payment_status','updated_at']) IS DISTINCT FROM (p_old-ARRAY['payment_status','updated_at'])
   OR (p_new->>'table_session_id')::uuid IS DISTINCT FROM p_session THEN RETURN false;END IF;
 SELECT session.closed_at INTO closed_at_value FROM mbox.table_sessions session
 WHERE (session.tenant_id,session.store_id,session.id)=(tenant,store,p_session) AND session.status='closed';
 IF closed_at_value IS NULL THEN RETURN false;END IF;

 -- The application projects against original total less actual receivable
 -- adjustments, not collection due or the service-compensation allowance.
 SELECT mbox.order_receivable_amount(tenant,store,target),
   COALESCE((SELECT SUM(fact.amount_minor) FROM mbox.order_payment_facts fact
     WHERE (fact.tenant_id,fact.store_id,fact.order_id)=(tenant,store,target)
       AND fact.status IN ('succeeded','partially_refunded','refunded')),0),
   COALESCE((SELECT SUM(fact.amount_minor) FROM mbox.order_refund_facts fact
     WHERE (fact.tenant_id,fact.store_id,fact.order_id)=(tenant,store,target) AND fact.status='succeeded'),0)
 INTO receivable,gross,refunded;
 IF receivable IS NULL OR receivable<0 OR gross<=0 OR refunded<=0 THEN RETURN false;END IF;
 expected:=CASE WHEN gross-refunded>=receivable THEN 'paid'
   WHEN gross-refunded<=0 THEN 'refunded' ELSE 'partially_refunded' END;
 IF p_new->>'payment_status' IS DISTINCT FROM expected THEN RETURN false;END IF;

 -- A batch's order facts contain allocation amounts. Its immutable ledger is
 -- checked against the authoritative WHOLE payment, once per payment identity.
 IF EXISTS(SELECT 1 FROM mbox.order_payment_facts fact
   JOIN mbox.payments payment ON (payment.tenant_id,payment.store_id,payment.id)=(fact.tenant_id,fact.store_id,fact.id)
   WHERE (fact.tenant_id,fact.store_id,fact.order_id)=(tenant,store,target)
     AND fact.status IN ('succeeded','partially_refunded','refunded')
     AND (fact.currency IS DISTINCT FROM p_new->>'currency'
       OR (SELECT COUNT(*) FROM mbox.reconciliation_entries entry
         WHERE (entry.tenant_id,entry.store_id,entry.payment_id)=(tenant,store,payment.id) AND entry.entry_type='payment')<>1
       OR NOT EXISTS(SELECT 1 FROM mbox.reconciliation_entries entry
         WHERE (entry.tenant_id,entry.store_id,entry.payment_id)=(tenant,store,payment.id)
           AND entry.entry_type='payment' AND entry.refund_id IS NULL
           AND entry.provider=payment.provider AND entry.provider_reference=payment.provider_transaction_id
           AND entry.amount_minor=payment.amount_minor AND entry.currency=payment.currency))) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM mbox.order_refund_facts fact
   JOIN mbox.refunds refund ON (refund.tenant_id,refund.store_id,refund.id)=(fact.tenant_id,fact.store_id,fact.id)
   JOIN mbox.payments payment ON (payment.tenant_id,payment.store_id,payment.id)=(refund.tenant_id,refund.store_id,refund.payment_id)
   WHERE (fact.tenant_id,fact.store_id,fact.order_id)=(tenant,store,target) AND fact.status='succeeded'
     AND (fact.currency IS DISTINCT FROM p_new->>'currency'
       OR (SELECT COUNT(*) FROM mbox.reconciliation_entries entry
         WHERE (entry.tenant_id,entry.store_id,entry.refund_id)=(tenant,store,refund.id) AND entry.entry_type='refund')<>1
       OR NOT EXISTS(SELECT 1 FROM mbox.reconciliation_entries entry
         WHERE (entry.tenant_id,entry.store_id,entry.refund_id)=(tenant,store,refund.id)
           AND entry.entry_type='refund' AND entry.payment_id=payment.id
           AND entry.provider=payment.provider AND entry.provider_reference=refund.provider_refund_id
           AND entry.amount_minor=-refund.amount_minor AND entry.currency=refund.currency))) THEN RETURN false;END IF;

 -- The capture must belong to an existing pre-close attempt, have an exactly
 -- matched consumed observation, and have been locally recorded after close.
 -- Provider occurred_at can precede closure; it is not our local commit time.
 RETURN EXISTS(SELECT 1 FROM mbox.order_payment_facts fact
   JOIN mbox.payments payment ON (payment.tenant_id,payment.store_id,payment.id)=(fact.tenant_id,fact.store_id,fact.id)
   JOIN mbox.reconciliation_entries entry ON (entry.tenant_id,entry.store_id,entry.payment_id)=(payment.tenant_id,payment.store_id,payment.id)
   JOIN mbox.verified_provider_observations observation ON (observation.tenant_id,observation.store_id,observation.payment_id)=(payment.tenant_id,payment.store_id,payment.id)
   WHERE (fact.tenant_id,fact.store_id,fact.order_id)=(tenant,store,target)
     AND payment.status IN ('succeeded','partially_refunded','refunded') AND payment.created_at<=closed_at_value
     AND entry.entry_type='payment' AND entry.created_at>=closed_at_value
     AND observation.subject_kind='payment' AND observation.observed_status='payment_succeeded'
     AND observation.consumed_at IS NOT NULL AND observation.consumed_operation IN ('payment.callback','payment.provider-query')
     AND observation.provider=payment.provider AND observation.provider_transaction_id=payment.provider_transaction_id
     AND observation.reported_amount_minor=payment.amount_minor AND observation.reported_currency=payment.currency
     AND observation.occurred_at=payment.succeeded_at);
END $guard$;
REVOKE ALL ON FUNCTION mbox.allow_closed_order_verified_payment_projection(jsonb,jsonb,uuid) FROM PUBLIC;

-- Preserve every earlier guard branch. Invoke this exact fallback only after
-- those branches rejected the closed-table write; no new runtime privileges.
DO $patch$
DECLARE definition text;needle text:=$old$  IF table_session_status NOT IN ('open','closing') AND NOT closed_write_allowed THEN$old$;
 replacement text:=$new$  IF table_session_status='closed' AND NOT closed_write_allowed
    AND TG_TABLE_NAME='orders' AND TG_OP='UPDATE' THEN
    closed_write_allowed:=mbox.allow_closed_order_verified_payment_projection(old_row,new_row,table_session_id_value);
  END IF;
  IF table_session_status NOT IN ('open','closing') AND NOT closed_write_allowed THEN$new$;
BEGIN
 definition:=pg_get_functiondef('mbox.lock_table_session_for_closure_fact_write()'::regprocedure);
 IF array_length(string_to_array(definition,needle),1)<>2 THEN RAISE EXCEPTION 'unexpected closure guard baseline' USING ERRCODE='55000';END IF;
 EXECUTE replace(definition,needle,replacement);
END $patch$;
UPDATE mbox.normalized_schema_metadata SET schema_version='239',updated_at=clock_timestamp() WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
