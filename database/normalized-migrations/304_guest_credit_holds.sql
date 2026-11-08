BEGIN;
CREATE TABLE mbox.guest_credit_holds (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,cart_id uuid NOT NULL,cart_version bigint NOT NULL,
 payment_id uuid NOT NULL,topup_payment_id uuid NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,cart_id,cart_version,payment_id,topup_payment_id),
 FOREIGN KEY(tenant_id,store_id,cart_id) REFERENCES mbox.guest_shared_carts(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,payment_id) REFERENCES mbox.payments(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,topup_payment_id) REFERENCES mbox.payments(tenant_id,store_id,id)
);
ALTER TABLE mbox.guest_credit_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.guest_credit_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_credit_hold_scope ON mbox.guest_credit_holds USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON mbox.guest_credit_holds TO mbox_runtime;
CREATE TRIGGER immutable_guest_credit_hold BEFORE UPDATE OR DELETE ON mbox.guest_credit_holds FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE VIEW mbox.active_guest_credit_holds WITH(security_invoker=true) AS
 SELECT h.* FROM mbox.guest_credit_holds h
 JOIN mbox.guest_shared_carts c ON(c.tenant_id,c.store_id,c.id,c.version)=(h.tenant_id,h.store_id,h.cart_id,h.cart_version)
 JOIN mbox.payments p ON(p.tenant_id,p.store_id,p.id)=(h.tenant_id,h.store_id,h.topup_payment_id)
 WHERE c.status='open' AND NOT EXISTS(SELECT 1 FROM mbox.table_prepayment_revocations r WHERE(r.tenant_id,r.store_id,r.payment_id)=(h.tenant_id,h.store_id,h.payment_id)) AND (p.status IN('created','pending') OR(p.status='succeeded' AND p.succeeded_at>statement_timestamp()-interval '15 minutes'));
GRANT SELECT ON mbox.active_guest_credit_holds TO mbox_runtime;
CREATE OR REPLACE FUNCTION mbox.prepayment_available(t uuid,s uuid,p uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN payment.status IN ('succeeded','partially_refunded') THEN payment.amount_minor
 - COALESCE((SELECT sum(a.amount_minor) FROM mbox.table_prepayment_allocations a WHERE(a.tenant_id,a.store_id,a.payment_id)=(t,s,p)),0)
 - COALESCE((SELECT sum(r.amount_minor) FROM mbox.refunds r WHERE(r.tenant_id,r.store_id,r.payment_id)=(t,s,p) AND r.order_id IS NULL AND r.status NOT IN('cancelled','rejected')),0)
 - COALESCE((SELECT sum(h.amount_minor) FROM mbox.active_guest_credit_holds h WHERE(h.tenant_id,h.store_id,h.payment_id)=(t,s,p)),0)
 ELSE 0 END::bigint FROM mbox.payments payment WHERE(payment.tenant_id,payment.store_id,payment.id)=(t,s,p) AND payment.payable_kind='table_prepayment'
$$;
CREATE FUNCTION mbox.guard_guest_credit_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid;source_sid uuid;target_sid uuid;available bigint;
BEGIN
 SELECT table_session_id INTO sid FROM mbox.guest_shared_carts WHERE(tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.cart_id) AND version=NEW.cart_version AND status='open';
 PERFORM 1 FROM mbox.table_sessions WHERE(tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,sid) AND status='open' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit cart changed' USING ERRCODE='23514';END IF;
 SELECT prepaid_table_session_id INTO source_sid FROM mbox.payments WHERE(tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.payment_id) AND provider_snapshot->>'sharedTableConsent'='v1' AND NOT EXISTS(SELECT 1 FROM mbox.table_prepayment_revocations r WHERE(r.tenant_id,r.store_id,r.payment_id)=(NEW.tenant_id,NEW.store_id,NEW.payment_id)) FOR UPDATE;
 SELECT prepaid_table_session_id INTO target_sid FROM mbox.payments WHERE(tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.topup_payment_id) AND status IN('created','pending');
 available:=mbox.prepayment_available(NEW.tenant_id,NEW.store_id,NEW.payment_id);
 IF sid IS DISTINCT FROM source_sid OR sid IS DISTINCT FROM target_sid OR available IS NULL OR NEW.amount_minor>available THEN RAISE EXCEPTION 'credit hold exceeds available funds' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_credit_hold_guard BEFORE INSERT ON mbox.guest_credit_holds FOR EACH ROW EXECUTE FUNCTION mbox.guard_guest_credit_hold();
REVOKE ALL ON FUNCTION mbox.guard_guest_credit_hold() FROM PUBLIC;
DO $$ DECLARE d text;owner_name text;BEGIN
 d:=pg_get_functiondef('mbox.table_prepayment_unsettled(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'mbox.prepayment_available(t,s,p.id)>0','(mbox.prepayment_available(t,s,p.id)>0 OR EXISTS(SELECT 1 FROM mbox.active_guest_credit_holds h WHERE(h.tenant_id,h.store_id,h.payment_id)=(t,s,p.id)))');
 FOR owner_name IN SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc WHERE oid IN('mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)'::regprocedure,'mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,character)'::regprocedure) LOOP
 EXECUTE format('GRANT SELECT ON mbox.guest_credit_holds,mbox.active_guest_credit_holds,mbox.guest_shared_carts,mbox.table_prepayment_revocations TO %I',owner_name);
 END LOOP;
END $$;
-- Cross-day debt must not initiate a second collection while a linked table
-- receipt still needs reconciliation, including money that arrives after closure.
CREATE FUNCTION mbox.order_has_unresolved_table_credit(t uuid,s uuid,o uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.table_credit_order_links l JOIN mbox.payments p ON(p.tenant_id,p.store_id,p.prepaid_table_session_id)=(l.tenant_id,l.store_id,l.table_session_id)
 WHERE(l.tenant_id,l.store_id,l.order_id)=(t,s,o) AND(p.status IN('created','pending') OR mbox.prepayment_available(t,s,p.id)>0
 OR EXISTS(SELECT 1 FROM mbox.active_guest_credit_holds h WHERE(h.tenant_id,h.store_id,h.payment_id)=(t,s,p.id))
 OR EXISTS(SELECT 1 FROM mbox.refunds r WHERE(r.tenant_id,r.store_id,r.payment_id)=(t,s,p.id) AND r.status NOT IN('succeeded','cancelled','rejected'))))
$$;
REVOKE ALL ON FUNCTION mbox.order_has_unresolved_table_credit(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_has_unresolved_table_credit(uuid,uuid,uuid) TO mbox_runtime;
DO $$ DECLARE d text;owner_name text;BEGIN
 d:=pg_get_functiondef('mbox.carryover_tab_review_basis(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'WHERE candidate IS NOT NULL','WHERE candidate IS NOT NULL AND NOT mbox.order_has_unresolved_table_credit(p_tenant,p_store,p_order)');
 d:=pg_get_functiondef('mbox.carryover_collection_eligibility(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'CASE WHEN d.eligibility=','CASE WHEN mbox.order_has_unresolved_table_credit(p_tenant,p_store,p_order) OR d.eligibility=');
 FOR owner_name IN SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc WHERE oid IN('mbox.confirm_carryover_tab_review(uuid,uuid,uuid,uuid,bigint,jsonb,text)'::regprocedure,'mbox.capture_closed_table_tab_reviews()'::regprocedure,'mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)'::regprocedure,'mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,character)'::regprocedure) LOOP
 EXECUTE format('GRANT SELECT ON mbox.table_credit_order_links,mbox.guest_credit_holds,mbox.active_guest_credit_holds,mbox.guest_shared_carts,mbox.table_prepayment_revocations TO %I',owner_name);
 EXECUTE format('GRANT EXECUTE ON FUNCTION mbox.order_has_unresolved_table_credit(uuid,uuid,uuid) TO %I',owner_name);
 END LOOP;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='304',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
