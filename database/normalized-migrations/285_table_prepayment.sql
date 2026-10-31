BEGIN;
ALTER TABLE mbox.table_sessions ADD COLUMN minimum_spend_mode text NOT NULL DEFAULT 'order_gate'
 CHECK(minimum_spend_mode IN ('order_gate','prepaid'));
ALTER TABLE mbox.table_sessions ADD COLUMN minimum_spend_waiver_minor bigint NOT NULL DEFAULT 0
 CHECK(minimum_spend_waiver_minor>=0 AND minimum_spend_waiver_minor<=minimum_spend_minor);
ALTER TABLE mbox.payments ADD COLUMN prepaid_table_session_id uuid;
ALTER TABLE mbox.payments ADD COLUMN prepaid_customer_id uuid;
ALTER TABLE mbox.payments ADD CONSTRAINT prepaid_session_fk FOREIGN KEY(tenant_id,store_id,prepaid_table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id);
ALTER TABLE mbox.payments ADD CONSTRAINT prepaid_customer_fk FOREIGN KEY(tenant_id,store_id,prepaid_customer_id) REFERENCES mbox.customers(tenant_id,store_id,id);
ALTER TABLE mbox.payments DROP CONSTRAINT payments_payable_kind_check;
ALTER TABLE mbox.payments ADD CHECK(payable_kind IN ('order','order_batch','activity_registration','table_prepayment'));
ALTER TABLE mbox.payments DROP CONSTRAINT payments_exactly_one_payable_ck;
ALTER TABLE mbox.payments ADD CONSTRAINT payments_exactly_one_payable_ck CHECK(
 (payable_kind='order' AND order_id IS NOT NULL AND activity_registration_id IS NULL AND order_batch_id IS NULL AND prepaid_table_session_id IS NULL AND prepaid_customer_id IS NULL)
 OR(payable_kind='order_batch' AND order_batch_id IS NOT NULL AND order_id IS NULL AND activity_registration_id IS NULL AND prepaid_table_session_id IS NULL AND prepaid_customer_id IS NULL)
 OR(payable_kind='activity_registration' AND activity_registration_id IS NOT NULL AND order_id IS NULL AND order_batch_id IS NULL AND prepaid_table_session_id IS NULL AND prepaid_customer_id IS NULL)
 OR(payable_kind='table_prepayment' AND prepaid_table_session_id IS NOT NULL AND prepaid_customer_id IS NOT NULL AND order_id IS NULL AND order_batch_id IS NULL AND activity_registration_id IS NULL));
ALTER TABLE mbox.payments DROP CONSTRAINT payments_activity_registration_cycle_ck;
ALTER TABLE mbox.payments ADD CONSTRAINT payments_activity_registration_cycle_ck CHECK(
 (payable_kind='activity_registration' AND (activity_registration_cycle IS NULL OR activity_registration_cycle>=1))
 OR(payable_kind<>'activity_registration' AND activity_registration_cycle IS NULL));
CREATE INDEX payments_prepaid_session_idx ON mbox.payments(tenant_id,store_id,prepaid_table_session_id) WHERE prepaid_table_session_id IS NOT NULL;
CREATE TABLE mbox.table_prepayment_allocations (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,payment_id uuid NOT NULL,order_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,payment_id,order_id),
 FOREIGN KEY(tenant_id,store_id,payment_id) REFERENCES mbox.payments(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id)
);
CREATE TABLE mbox.table_minimum_spend_waivers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 table_session_id uuid NOT NULL,employee_id uuid NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 2 AND 500),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
DO $$ DECLARE rel text; BEGIN
 FOREACH rel IN ARRAY ARRAY['table_prepayment_allocations','table_minimum_spend_waivers'] LOOP
 EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',rel);
 EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',rel);
 EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',rel);
 EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',rel);
 EXECUTE format('CREATE TRIGGER immutable_prepayment_fact BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',rel);
 END LOOP;
END $$;
-- Order-level receipts are allocations, never a second channel charge.
DO $$ DECLARE direct_cols text;allocated_cols text; BEGIN
 SELECT string_agg(format('p.%I',attname),',' ORDER BY attnum),
 string_agg(CASE attname WHEN 'order_id' THEN 'a.order_id' WHEN 'amount_minor' THEN 'a.amount_minor' ELSE format('p.%I',attname) END,',' ORDER BY attnum)
 INTO direct_cols,allocated_cols FROM pg_attribute WHERE attrelid='mbox.order_payment_facts'::regclass AND attnum>0 AND NOT attisdropped;
 EXECUTE 'CREATE OR REPLACE VIEW mbox.order_payment_facts WITH(security_invoker=true) AS SELECT '||direct_cols||' FROM mbox.payments p WHERE p.payable_kind=''order'' UNION ALL SELECT '||allocated_cols||' FROM mbox.payments p JOIN mbox.order_payment_allocations a ON (a.tenant_id,a.store_id,a.batch_id)=(p.tenant_id,p.store_id,p.order_batch_id) WHERE p.payable_kind=''order_batch'' UNION ALL SELECT '||allocated_cols||' FROM mbox.payments p JOIN mbox.table_prepayment_allocations a ON (a.tenant_id,a.store_id,a.payment_id)=(p.tenant_id,p.store_id,p.id) WHERE p.payable_kind=''table_prepayment''';
END $$;
CREATE OR REPLACE FUNCTION mbox.validate_allocated_payment_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.payment_id IS NOT NULL AND NEW.order_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM mbox.order_payment_facts p WHERE (p.tenant_id,p.store_id,p.id,p.order_id)=(NEW.tenant_id,NEW.store_id,NEW.payment_id,NEW.order_id))
 THEN RAISE EXCEPTION 'payment does not belong to original order' USING ERRCODE='23503';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION mbox.guard_batch_financial_targets() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment_order uuid;payment_batch uuid;prepaid_session uuid;
BEGIN
 IF TG_TABLE_NAME='payments' THEN
 IF NEW.order_batch_id IS DISTINCT FROM OLD.order_batch_id OR NEW.prepaid_table_session_id IS DISTINCT FROM OLD.prepaid_table_session_id OR NEW.prepaid_customer_id IS DISTINCT FROM OLD.prepaid_customer_id
 OR ((OLD.order_batch_id IS NOT NULL OR NEW.order_batch_id IS NOT NULL OR OLD.prepaid_table_session_id IS NOT NULL) AND (NEW.amount_minor<>OLD.amount_minor OR NEW.currency<>OLD.currency OR NEW.payable_kind<>OLD.payable_kind)) THEN RAISE EXCEPTION 'financial target is immutable' USING ERRCODE='23514';END IF;
 ELSE
 IF TG_OP='UPDATE' THEN IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN RAISE EXCEPTION 'refund order target is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT order_id,order_batch_id,prepaid_table_session_id INTO payment_order,payment_batch,prepaid_session FROM mbox.payments WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.payment_id;
 IF prepaid_session IS NOT NULL THEN
 IF NEW.order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mbox.table_prepayment_allocations WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND payment_id=NEW.payment_id AND order_id=NEW.order_id) THEN RAISE EXCEPTION 'refund order not allocated from prepayment' USING ERRCODE='23514';END IF;
 ELSIF payment_batch IS NOT NULL THEN
 IF NEW.order_id IS NULL OR NOT EXISTS(SELECT 1 FROM mbox.order_payment_allocations WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND batch_id=payment_batch AND order_id=NEW.order_id) THEN RAISE EXCEPTION 'refund order not in payment batch' USING ERRCODE='23514';END IF;
 ELSIF NEW.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM payment_order THEN RAISE EXCEPTION 'refund order differs from payment' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
-- Balance is reserved by both requested and approved/uncertain refunds. Failed
-- channel results remain reserved until explicitly reconciled/cancelled.
CREATE FUNCTION mbox.prepayment_available(t uuid,s uuid,p uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN payment.status IN ('succeeded','partially_refunded') THEN payment.amount_minor
 - COALESCE((SELECT sum(a.amount_minor) FROM mbox.table_prepayment_allocations a WHERE (a.tenant_id,a.store_id,a.payment_id)=(t,s,p)),0)
 - COALESCE((SELECT sum(r.amount_minor) FROM mbox.refunds r WHERE (r.tenant_id,r.store_id,r.payment_id)=(t,s,p) AND r.order_id IS NULL AND r.status NOT IN ('cancelled','rejected')),0)
 ELSE 0 END::bigint FROM mbox.payments payment WHERE (payment.tenant_id,payment.store_id,payment.id)=(t,s,p) AND payment.payable_kind='table_prepayment'
$$;
CREATE FUNCTION mbox.guard_prepayment_spend() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p mbox.payments; target_session uuid; session_status text;order_session uuid;order_currency text;available bigint;reserved bigint;
BEGIN
 SELECT prepaid_table_session_id INTO target_session FROM mbox.payments WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.payment_id);
 IF target_session IS NULL THEN RETURN NEW;END IF;
 SELECT status INTO session_status FROM mbox.table_sessions WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,target_session) FOR UPDATE;
 SELECT * INTO STRICT p FROM mbox.payments WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.payment_id) FOR UPDATE;
 available:=mbox.prepayment_available(NEW.tenant_id,NEW.store_id,NEW.payment_id);
 IF TG_TABLE_NAME='table_prepayment_allocations' THEN
 SELECT table_session_id,currency INTO order_session,order_currency FROM mbox.orders WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.order_id) FOR UPDATE;
 IF session_status<>'open' OR order_session IS DISTINCT FROM target_session OR order_currency IS DISTINCT FROM p.currency::text OR NEW.amount_minor>available
 OR p.provider_snapshot->>'sharedTableConsent' IS DISTINCT FROM 'v1' THEN RAISE EXCEPTION 'prepayment balance, session or shared authorization invalid' USING ERRCODE='23514';END IF;
 ELSIF TG_OP='INSERT' THEN
 IF NEW.order_id IS NULL THEN
 IF NEW.amount_minor>available THEN RAISE EXCEPTION 'unused prepayment refund exceeds balance' USING ERRCODE='23514';END IF;
 ELSE
 SELECT COALESCE(sum(amount_minor),0) INTO reserved FROM mbox.refunds WHERE (tenant_id,store_id,payment_id,order_id)=(NEW.tenant_id,NEW.store_id,NEW.payment_id,NEW.order_id) AND status NOT IN ('cancelled','rejected');
 IF NEW.amount_minor+reserved>COALESCE((SELECT amount_minor FROM mbox.table_prepayment_allocations WHERE (tenant_id,store_id,payment_id,order_id)=(NEW.tenant_id,NEW.store_id,NEW.payment_id,NEW.order_id)),0) THEN RAISE EXCEPTION 'prepaid goods refund exceeds original allocation' USING ERRCODE='23514';END IF;
 END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER guard_prepayment_allocation BEFORE INSERT ON mbox.table_prepayment_allocations FOR EACH ROW EXECUTE FUNCTION mbox.guard_prepayment_spend();
CREATE TRIGGER guard_prepayment_refund BEFORE INSERT ON mbox.refunds FOR EACH ROW EXECUTE FUNCTION mbox.guard_prepayment_spend();
REVOKE ALL ON FUNCTION mbox.prepayment_available(uuid,uuid,uuid),mbox.guard_prepayment_spend() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.prepayment_available(uuid,uuid,uuid) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='285',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
