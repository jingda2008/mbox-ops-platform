BEGIN;
CREATE TABLE mbox.order_payment_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 table_session_id uuid NOT NULL,created_by_employee_id uuid,created_by_customer_id uuid,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),currency char(3) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,created_by_customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 CHECK((created_by_employee_id IS NULL)<>(created_by_customer_id IS NULL)),
 UNIQUE(tenant_id,store_id,id)
);
CREATE TABLE mbox.order_payment_allocations (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,batch_id uuid NOT NULL,order_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),outstanding_at_creation_minor bigint NOT NULL CHECK(outstanding_at_creation_minor>=amount_minor),
 position integer NOT NULL CHECK(position>=0),
 PRIMARY KEY(tenant_id,store_id,batch_id,order_id),UNIQUE(tenant_id,store_id,batch_id,position),
 FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.order_payment_batches(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id)
);
CREATE INDEX order_payment_allocations_order_idx ON mbox.order_payment_allocations(tenant_id,store_id,order_id,batch_id);
ALTER TABLE mbox.payments ADD COLUMN order_batch_id uuid;
ALTER TABLE mbox.payments ADD CONSTRAINT payments_order_batch_fk FOREIGN KEY(tenant_id,store_id,order_batch_id) REFERENCES mbox.order_payment_batches(tenant_id,store_id,id);
ALTER TABLE mbox.payments DROP CONSTRAINT payments_payable_kind_check;
ALTER TABLE mbox.payments ADD CHECK(payable_kind IN ('order','activity_registration','order_batch'));
ALTER TABLE mbox.payments DROP CONSTRAINT payments_exactly_one_payable_ck;
ALTER TABLE mbox.payments ADD CONSTRAINT payments_exactly_one_payable_ck CHECK(
 (payable_kind='order' AND order_id IS NOT NULL AND activity_registration_id IS NULL AND order_batch_id IS NULL)
 OR(payable_kind='activity_registration' AND order_id IS NULL AND activity_registration_id IS NOT NULL AND order_batch_id IS NULL)
 OR(payable_kind='order_batch' AND order_id IS NULL AND activity_registration_id IS NULL AND order_batch_id IS NOT NULL));
ALTER TABLE mbox.payments DROP CONSTRAINT payments_activity_registration_cycle_ck;
ALTER TABLE mbox.payments ADD CONSTRAINT payments_activity_registration_cycle_ck CHECK(
 (payable_kind='activity_registration' AND activity_registration_id IS NOT NULL AND (activity_registration_cycle IS NULL OR activity_registration_cycle>=1))
 OR(payable_kind IN ('order','order_batch') AND activity_registration_cycle IS NULL));
CREATE UNIQUE INDEX payments_order_batch_uq ON mbox.payments(tenant_id,store_id,order_batch_id) WHERE order_batch_id IS NOT NULL;
ALTER TABLE mbox.refunds ADD COLUMN order_id uuid;
ALTER TABLE mbox.refunds ADD CONSTRAINT refunds_order_target_fk FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id);

DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['order_payment_batches','order_payment_allocations'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',name);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC',name);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',name);
  EXECUTE format('CREATE TRIGGER immutable_batch BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',name);
 END LOOP;
END $$;
CREATE FUNCTION mbox.validate_order_payment_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch uuid; scope_tenant uuid;scope_store uuid;expected bigint;actual bigint;session uuid;currency_code char(3);
BEGIN
 IF TG_TABLE_NAME='payments' THEN batch:=NEW.order_batch_id;ELSE batch:=NEW.batch_id;END IF;
 IF batch IS NULL THEN RETURN NEW;END IF;
 scope_tenant:=NEW.tenant_id;scope_store:=NEW.store_id;
 SELECT b.amount_minor,b.table_session_id,b.currency INTO STRICT expected,session,currency_code FROM mbox.order_payment_batches b WHERE b.tenant_id=scope_tenant AND b.store_id=scope_store AND b.id=batch;
 SELECT COALESCE(sum(a.amount_minor),0) INTO actual FROM mbox.order_payment_allocations a WHERE a.tenant_id=scope_tenant AND a.store_id=scope_store AND a.batch_id=batch;
 IF expected<>actual THEN RAISE EXCEPTION 'batch allocations do not equal payment amount' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM mbox.order_payment_allocations a JOIN mbox.orders o ON o.tenant_id=a.tenant_id AND o.store_id=a.store_id AND o.id=a.order_id WHERE a.tenant_id=scope_tenant AND a.store_id=scope_store AND a.batch_id=batch AND (o.table_session_id<>session OR o.currency<>currency_code)) THEN RAISE EXCEPTION 'batch crosses table session or currency' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='payments' THEN IF NEW.amount_minor<>expected OR NEW.currency<>currency_code THEN RAISE EXCEPTION 'batch payment amount mismatch' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER payment_batch_amount_guard AFTER INSERT ON mbox.payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.validate_order_payment_batch();
CREATE CONSTRAINT TRIGGER allocation_batch_amount_guard AFTER INSERT ON mbox.order_payment_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.validate_order_payment_batch();
REVOKE ALL ON FUNCTION mbox.validate_order_payment_batch() FROM PUBLIC;

CREATE FUNCTION mbox.guard_batch_financial_targets() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment_order uuid;payment_batch uuid;
BEGIN
 IF TG_TABLE_NAME='payments' THEN
  IF NEW.order_batch_id IS DISTINCT FROM OLD.order_batch_id OR ((OLD.order_batch_id IS NOT NULL OR NEW.order_batch_id IS NOT NULL) AND (NEW.amount_minor<>OLD.amount_minor OR NEW.currency<>OLD.currency OR NEW.payable_kind<>OLD.payable_kind)) THEN RAISE EXCEPTION 'batch financial target is immutable' USING ERRCODE='23514';END IF;
 ELSE
  IF TG_OP='UPDATE' THEN IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN RAISE EXCEPTION 'refund order target is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
  SELECT order_id,order_batch_id INTO payment_order,payment_batch FROM mbox.payments WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.payment_id;
  IF payment_batch IS NOT NULL THEN
   IF NEW.order_id IS NULL OR NOT EXISTS(SELECT 1 FROM mbox.order_payment_allocations WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND batch_id=payment_batch AND order_id=NEW.order_id) THEN RAISE EXCEPTION 'refund order not in payment batch' USING ERRCODE='23514';END IF;
  ELSIF NEW.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM payment_order THEN RAISE EXCEPTION 'refund order differs from payment' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_batch_payment_target BEFORE UPDATE ON mbox.payments FOR EACH ROW EXECUTE FUNCTION mbox.guard_batch_financial_targets();
CREATE TRIGGER guard_batch_refund_target BEFORE INSERT OR UPDATE ON mbox.refunds FOR EACH ROW EXECUTE FUNCTION mbox.guard_batch_financial_targets();
REVOKE ALL ON FUNCTION mbox.guard_batch_financial_targets() FROM PUBLIC;

-- This read model is for order-level balance and presentation only. Financial
-- ledgers continue to use the single authoritative row in mbox.payments.
DO $$ DECLARE columns text; BEGIN
 SELECT string_agg(CASE attname WHEN 'order_id' THEN 'a.order_id' WHEN 'amount_minor' THEN 'a.amount_minor' ELSE format('p.%I',attname) END,',' ORDER BY attnum)
 INTO columns FROM pg_attribute WHERE attrelid='mbox.payments'::regclass AND attnum>0 AND NOT attisdropped;
 EXECUTE 'CREATE VIEW mbox.order_payment_facts WITH(security_invoker=true) AS SELECT p.* FROM mbox.payments p WHERE p.payable_kind=''order'' UNION ALL SELECT '||columns||' FROM mbox.payments p JOIN mbox.order_payment_allocations a ON a.tenant_id=p.tenant_id AND a.store_id=p.store_id AND a.batch_id=p.order_batch_id WHERE p.payable_kind=''order_batch''';
END $$;
CREATE VIEW mbox.order_refund_facts WITH(security_invoker=true) AS
 SELECT r.id,r.tenant_id,r.store_id,r.payment_id,COALESCE(r.order_id,p.order_id) AS order_id,r.amount_minor,r.status,r.currency,r.created_at,r.completed_at
 FROM mbox.refunds r JOIN mbox.payments p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id
 WHERE COALESCE(r.order_id,p.order_id) IS NOT NULL;
GRANT SELECT ON mbox.order_payment_facts,mbox.order_refund_facts TO mbox_runtime;
-- Awards remain once per original order. A shared payment may settle several
-- original orders without duplicating a channel transaction.
DO $$ DECLARE rel text;constraint_name text; BEGIN
 FOREACH rel IN ARRAY ARRAY['loyalty_order_awards','loyalty_order_reward_contributions','loyalty_accrual_deferred_orders'] LOOP
  SELECT conname INTO constraint_name FROM pg_constraint WHERE conrelid=('mbox.'||rel)::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, store_id, payment_id)';
  IF constraint_name IS NULL THEN RAISE EXCEPTION 'missing expected single-payment award constraint on %',rel;END IF;
  EXECUTE format('ALTER TABLE mbox.%I DROP CONSTRAINT %I',rel,constraint_name);
 END LOOP;
END $$;

-- Retain same-store and exact original-order financial attribution, including
-- an order explicitly allocated by a batch. Independent valid IDs are insufficient.
CREATE FUNCTION mbox.validate_allocated_payment_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.payment_id IS NOT NULL AND NEW.order_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM mbox.payments p
  WHERE p.tenant_id=NEW.tenant_id AND p.store_id=NEW.store_id AND p.id=NEW.payment_id
   AND (p.order_id=NEW.order_id OR EXISTS (
    SELECT 1 FROM mbox.order_payment_allocations a WHERE a.tenant_id=p.tenant_id
     AND a.store_id=p.store_id AND a.batch_id=p.order_batch_id AND a.order_id=NEW.order_id
   ))
 ) THEN RAISE EXCEPTION 'payment does not belong to original order' USING ERRCODE='23503'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.validate_allocated_payment_reference() FROM PUBLIC;
DO $$ DECLARE rel text; existing_fk text; BEGIN
 FOREACH rel IN ARRAY ARRAY['recommendation_behavior_events','customer_experience_plans','loyalty_accrual_deferred_orders'] LOOP
  SELECT conname INTO existing_fk FROM pg_constraint WHERE conrelid=('mbox.'||rel)::regclass
    AND contype='f' AND confrelid='mbox.payments'::regclass AND cardinality(conkey)=4;
  IF existing_fk IS NULL THEN RAISE EXCEPTION 'missing original payment-order reference on %',rel; END IF;
  EXECUTE format('ALTER TABLE mbox.%I DROP CONSTRAINT %I',rel,existing_fk);
  EXECUTE format('ALTER TABLE mbox.%I ADD CONSTRAINT %I FOREIGN KEY(tenant_id,store_id,payment_id) REFERENCES mbox.payments(tenant_id,store_id,id)',rel,existing_fk);
  EXECUTE format('CREATE TRIGGER allocated_payment_reference BEFORE INSERT OR UPDATE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.validate_allocated_payment_reference()',rel);
 END LOOP;
END $$;

DO $$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('mbox.operating_day_summary(uuid,uuid,date)'::regprocedure);
 definition:=replace(definition,'FROM mbox.payments p','FROM mbox.order_payment_facts p');
 definition:=replace(definition,'JOIN mbox.payments p','JOIN mbox.order_payment_facts p');
 definition:=replace(definition,'p.id=r.payment_id','p.id=r.payment_id AND (r.order_id IS NULL OR r.order_id=p.order_id)');
 EXECUTE definition;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='194',updated_at=clock_timestamp() WHERE singleton=true;
-- Root queries retain their original meaning; replace only the per-order signal.
DO $$ DECLARE definition text; BEGIN
 definition:=rtrim(pg_get_viewdef('mbox.payment_financial_monitoring_signals'::regclass,true),E';\n ');
 EXECUTE 'CREATE OR REPLACE VIEW mbox.payment_financial_monitoring_signals WITH(security_invoker=true) AS SELECT * FROM ('||definition||') original WHERE signal<>''order_overcollected'' UNION ALL
 SELECT o.tenant_id,o.store_id,o.id AS subject_id,''order_overcollected''::text AS signal,max(p.succeeded_at) AS observed_at
 FROM mbox.orders o JOIN mbox.order_payment_facts p ON p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id
 WHERE p.status IN (''succeeded'',''partially_refunded'',''refunded'')
 GROUP BY o.tenant_id,o.store_id,o.id,o.total_amount_minor
 HAVING sum(p.amount_minor-COALESCE((SELECT sum(r.amount_minor) FROM mbox.refunds r WHERE r.tenant_id=p.tenant_id AND r.store_id=p.store_id AND r.payment_id=p.id AND (r.order_id IS NULL OR r.order_id=p.order_id) AND r.status=''succeeded''),0))>o.total_amount_minor
 UNION ALL SELECT o.tenant_id,o.store_id,o.id,''cancelled_order_captured''::text,max(p.succeeded_at)
 FROM mbox.orders o JOIN mbox.order_payment_facts p ON p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id
 WHERE o.status=''cancelled'' AND p.status IN (''succeeded'',''partially_refunded'',''refunded'')
 GROUP BY o.tenant_id,o.store_id,o.id
 HAVING sum(p.amount_minor-COALESCE((SELECT sum(r.amount_minor) FROM mbox.refunds r WHERE r.tenant_id=p.tenant_id AND r.store_id=p.store_id AND r.payment_id=p.id AND (r.order_id IS NULL OR r.order_id=p.order_id) AND r.status=''succeeded''),0))>0';
END $$;
COMMIT;
