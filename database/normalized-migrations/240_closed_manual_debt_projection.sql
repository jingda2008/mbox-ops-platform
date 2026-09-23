BEGIN;

-- Exact financial projection for authorized historical manual receipts.
-- Retained service compensation does not become a new collection obligation.
-- Only the private AFTER INSERT trigger creates this source fact, after the
-- existing 236 guard admitted the precise historical manual collection.
-- No backfill: editable timestamps on old payments cannot establish admission.
CREATE TABLE mbox.closed_debt_manual_payment_admissions (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,payment_id uuid NOT NULL,
 order_id uuid NOT NULL,table_session_id uuid NOT NULL,collected_by_employee_id uuid NOT NULL,
 authorization_id uuid NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),currency char(3) NOT NULL,
 provider text NOT NULL CHECK(provider IN ('cash','physical_pos','external_manual')),method text NOT NULL,
 provider_reference text NOT NULL,authorization_created_at timestamptz NOT NULL,authorization_expires_at timestamptz NOT NULL,
 payment_created_at timestamptz NOT NULL,payment_succeeded_at timestamptz NOT NULL,closed_at timestamptz NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,payment_id),
 FOREIGN KEY(tenant_id,store_id,payment_id) REFERENCES mbox.payments(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,collected_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,authorization_id,order_id) REFERENCES mbox.order_recollection_authorizations(tenant_id,store_id,id,order_id),
 CHECK(authorization_created_at<=admitted_at AND admitted_at<authorization_expires_at)
);
ALTER TABLE mbox.closed_debt_manual_payment_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.closed_debt_manual_payment_admissions FORCE ROW LEVEL SECURITY;
CREATE POLICY closed_debt_manual_admission_scope ON mbox.closed_debt_manual_payment_admissions
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
CREATE TRIGGER closed_debt_manual_admissions_append_only
 BEFORE UPDATE OR DELETE ON mbox.closed_debt_manual_payment_admissions
 FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
REVOKE ALL ON mbox.closed_debt_manual_payment_admissions FROM PUBLIC,mbox_runtime;
GRANT SELECT ON mbox.closed_debt_manual_payment_admissions TO mbox_runtime;

CREATE FUNCTION mbox.record_closed_debt_manual_payment_admission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $admission$
DECLARE closed_at_value timestamptz;session_id uuid;
BEGIN
 IF NEW.payable_kind<>'order' OR NEW.status<>'succeeded'
   OR NEW.provider NOT IN ('cash','physical_pos','external_manual') THEN RETURN NEW;END IF;
 SELECT session.id,session.closed_at INTO session_id,closed_at_value
 FROM mbox.orders ordering JOIN mbox.table_sessions session
   ON (session.tenant_id,session.store_id,session.id)=(ordering.tenant_id,ordering.store_id,ordering.table_session_id)
 WHERE (ordering.tenant_id,ordering.store_id,ordering.id)=(NEW.tenant_id,NEW.store_id,NEW.order_id) AND session.status='closed'
 FOR SHARE OF session;
 IF NOT FOUND THEN RETURN NEW;END IF;
 IF NEW.tenant_id IS DISTINCT FROM mbox.current_tenant_id() OR NEW.store_id IS DISTINCT FROM mbox.current_store_id()
 THEN RAISE EXCEPTION 'historical manual receipt scope does not match' USING ERRCODE='42501';END IF;
 -- AFTER INSERT proves an actual insertion passed the existing 236 BEFORE
 -- guard. ON CONFLICT DO NOTHING/UPDATE must never grant old rows admission.
 INSERT INTO mbox.closed_debt_manual_payment_admissions(
   tenant_id,store_id,payment_id,order_id,table_session_id,collected_by_employee_id,
   authorization_id,amount_minor,currency,provider,method,provider_reference,
   authorization_created_at,authorization_expires_at,payment_created_at,payment_succeeded_at,closed_at)
 SELECT approval.tenant_id,approval.store_id,NEW.id,approval.order_id,session_id,
   (NEW.provider_snapshot->>'collectedByEmployeeId')::uuid,approval.id,approval.amount_minor,approval.currency,
   NEW.provider,NEW.method,NEW.provider_transaction_id,approval.created_at,approval.expires_at,
   NEW.created_at,NEW.succeeded_at,closed_at_value
 FROM mbox.order_recollection_authorizations approval
 WHERE (approval.tenant_id,approval.store_id,approval.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id)
   AND approval.status='active' AND approval.expires_at>clock_timestamp()
   AND approval.amount_minor=NEW.amount_minor AND approval.currency=NEW.currency
 ORDER BY approval.created_at DESC,approval.id DESC LIMIT 1 FOR UPDATE OF approval;
 IF NOT FOUND THEN RAISE EXCEPTION 'historical manual receipt lost its exact active authorization' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $admission$;
REVOKE ALL ON FUNCTION mbox.record_closed_debt_manual_payment_admission() FROM PUBLIC;
CREATE TRIGGER payments_record_closed_debt_manual_admission AFTER INSERT ON mbox.payments
 FOR EACH ROW EXECUTE FUNCTION mbox.record_closed_debt_manual_payment_admission();

CREATE FUNCTION mbox.allow_closed_order_manual_debt_projection(p_old jsonb,p_new jsonb,p_session uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,mbox AS $guard$
DECLARE
 tenant uuid:=(p_new->>'tenant_id')::uuid; store uuid:=(p_new->>'store_id')::uuid;
 target uuid:=(p_new->>'id')::uuid; closed_at_value timestamptz;
 gross numeric; refunded numeric; receivable numeric; expected text;
BEGIN
 IF tenant IS DISTINCT FROM mbox.current_tenant_id() OR store IS DISTINCT FROM mbox.current_store_id()
   OR p_old->>'payment_status'<>'refunded' OR p_new->>'payment_status'<>'partially_refunded'
   OR (p_new-ARRAY['payment_status','updated_at']) IS DISTINCT FROM (p_old-ARRAY['payment_status','updated_at'])
   OR (p_new->>'table_session_id')::uuid IS DISTINCT FROM p_session THEN RETURN false;END IF;
 SELECT session.closed_at INTO closed_at_value FROM mbox.table_sessions session
 WHERE (session.tenant_id,session.store_id,session.id)=(tenant,store,p_session) AND session.status='closed';
 IF closed_at_value IS NULL OR p_new->>'status' IN ('draft','cancelled') THEN RETURN false;END IF;
 IF NOT mbox.order_consumption_settled(tenant,store,target)
   OR mbox.order_collection_due_amount(tenant,store,target)<>0
   OR NOT EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
     JOIN mbox.order_recollection_authorizations original
       ON (original.tenant_id,original.store_id,original.id)=(obligation.tenant_id,obligation.store_id,obligation.authorization_id)
     WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id)=(tenant,store,target)
       AND original.created_at<=closed_at_value)
   OR EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
     JOIN mbox.order_recollection_authorizations original
       ON (original.tenant_id,original.store_id,original.id)=(obligation.tenant_id,obligation.store_id,obligation.authorization_id)
     WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id)=(tenant,store,target)
       AND original.created_at>closed_at_value)
   OR EXISTS(SELECT 1 FROM mbox.order_refund_facts fact
     JOIN mbox.refunds original ON (original.tenant_id,original.store_id,original.id)=(fact.tenant_id,fact.store_id,fact.id)
     WHERE (fact.tenant_id,fact.store_id,fact.order_id)=(tenant,store,target) AND fact.status='succeeded'
       AND original.purpose IS DISTINCT FROM 'service_compensation'
       AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds quantity
         WHERE (quantity.tenant_id,quantity.store_id,quantity.refund_id)=(tenant,store,fact.id))
       AND NOT EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
         WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id,obligation.refund_id)=(tenant,store,target,fact.id)))
   OR EXISTS(SELECT 1 FROM mbox.order_payment_facts fact
     WHERE (fact.tenant_id,fact.store_id,fact.order_id)=(tenant,store,target)
       AND (fact.status IN ('created','pending') OR EXISTS(SELECT 1 FROM mbox.verified_provider_observations observation
         WHERE (observation.tenant_id,observation.store_id,observation.payment_id)=(tenant,store,fact.id)
           AND observation.observed_status='payment_succeeded' AND observation.consumed_at IS NULL)))
   OR EXISTS(SELECT 1 FROM mbox.order_refund_facts fact
     JOIN mbox.verified_provider_observations observation ON (observation.tenant_id,observation.store_id,observation.refund_id)=(fact.tenant_id,fact.store_id,fact.id)
     WHERE (fact.tenant_id,fact.store_id,fact.order_id)=(tenant,store,target)
       AND observation.observed_status='refund_succeeded' AND observation.consumed_at IS NULL)
 THEN RETURN false;END IF;

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

 -- The authorized receipt must itself cause the positive net projection.
 -- Neither a mutable payment timestamp nor a consumed flag is sufficient:
 -- all financial facts above have exactly matched immutable whole ledgers.
 RETURN EXISTS(SELECT 1 FROM mbox.payments payment
   JOIN mbox.closed_debt_manual_payment_admissions admission ON (admission.tenant_id,admission.store_id,admission.payment_id,admission.order_id)=(payment.tenant_id,payment.store_id,payment.id,payment.order_id)
   JOIN mbox.reconciliation_entries entry ON (entry.tenant_id,entry.store_id,entry.payment_id)=(payment.tenant_id,payment.store_id,payment.id)
   JOIN mbox.order_recollection_authorizations approval ON (approval.tenant_id,approval.store_id,approval.order_id,approval.consumed_payment_id)=(payment.tenant_id,payment.store_id,payment.order_id,payment.id)
   JOIN mbox.employees employee ON (employee.tenant_id,employee.store_id,employee.id::text)=(payment.tenant_id,payment.store_id,payment.provider_snapshot->>'collectedByEmployeeId')
   WHERE (payment.tenant_id,payment.store_id,payment.order_id)=(tenant,store,target)
     AND payment.payable_kind='order' AND payment.status='succeeded'
     AND (payment.provider,payment.method) IN (('cash','cash'),('physical_pos','card'),('physical_pos','manual'),('external_manual','manual'))
     AND admission.table_session_id=p_session AND admission.closed_at=closed_at_value
     AND admission.admitted_at>=closed_at_value AND admission.amount_minor=payment.amount_minor AND admission.currency=payment.currency
     AND admission.provider=payment.provider AND admission.method=payment.method AND admission.provider_reference=payment.provider_transaction_id
     AND admission.payment_created_at=payment.created_at AND admission.payment_succeeded_at=payment.succeeded_at
     AND admission.collected_by_employee_id=employee.id
     AND admission.authorization_id=approval.id AND admission.authorization_created_at=approval.created_at
     AND admission.authorization_expires_at=approval.expires_at
     AND payment.created_at>=closed_at_value AND payment.succeeded_at>=closed_at_value
     AND gross-payment.amount_minor-refunded<=0
     AND entry.entry_type='payment' AND entry.created_at>=admission.admitted_at
     AND entry.occurred_at=payment.succeeded_at
     AND entry.evidence_snapshot->>'collectedByEmployeeId'=employee.id::text
     AND entry.evidence_snapshot->>'receiptReference'=payment.provider_transaction_id
     AND approval.status='consumed' AND approval.amount_minor=payment.amount_minor AND approval.currency=payment.currency
     AND approval.created_at<=payment.created_at AND approval.consumed_at>=payment.created_at
     AND approval.consumed_at>=admission.admitted_at AND approval.consumed_at<admission.authorization_expires_at
     AND employee.status='active'
     AND mbox.employee_has_effective_permission(tenant,store,employee.id,'payment.collect.all_tables')
     AND mbox.employee_has_effective_permission(tenant,store,employee.id,'payment.recollect.authorize')
     AND mbox.employee_has_effective_permission(tenant,store,employee.id,CASE payment.provider
       WHEN 'cash' THEN 'payment.manual.cash.record' WHEN 'physical_pos' THEN 'payment.manual.pos.record' ELSE 'payment.manual.external.record' END));
END $guard$;
REVOKE ALL ON FUNCTION mbox.allow_closed_order_manual_debt_projection(jsonb,jsonb,uuid) FROM PUBLIC;

DO $patch$
DECLARE definition text;needle text:=$old$  IF table_session_status NOT IN ('open','closing') AND NOT closed_write_allowed THEN$old$;
 replacement text:=$new$  IF table_session_status='closed' AND NOT closed_write_allowed
    AND TG_TABLE_NAME='orders' AND TG_OP='UPDATE' THEN
    closed_write_allowed:=mbox.allow_closed_order_manual_debt_projection(old_row,new_row,table_session_id_value);
  END IF;
  IF table_session_status NOT IN ('open','closing') AND NOT closed_write_allowed THEN$new$;
BEGIN
 definition:=pg_get_functiondef('mbox.lock_table_session_for_closure_fact_write()'::regprocedure);
 IF array_length(string_to_array(definition,needle),1)<>2 THEN RAISE EXCEPTION 'unexpected closure guard baseline' USING ERRCODE='55000';END IF;
 EXECUTE replace(definition,needle,replacement);
END $patch$;
UPDATE mbox.normalized_schema_metadata SET schema_version='240',updated_at=clock_timestamp() WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
