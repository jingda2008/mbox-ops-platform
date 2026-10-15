BEGIN;
CREATE TABLE mbox.loyalty_manual_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 membership_id uuid NOT NULL, customer_id uuid NOT NULL, policy_version_id uuid NOT NULL,
 points_delta integer NOT NULL CHECK(points_delta<>0 AND abs(points_delta)<=1000000),
 requested_by_employee_id uuid NOT NULL, reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 240),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,membership_id) REFERENCES mbox.customer_memberships(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,policy_version_id) REFERENCES mbox.loyalty_policy_versions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,requested_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.loyalty_manual_decisions (
 tenant_id uuid NOT NULL, store_id uuid NOT NULL, request_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','rejected')),
 decided_by_employee_id uuid NOT NULL, reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 240),
 ledger_entry_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,request_id), UNIQUE(tenant_id,store_id,ledger_entry_id),
 FOREIGN KEY(tenant_id,store_id,request_id) REFERENCES mbox.loyalty_manual_requests(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,decided_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,ledger_entry_id) REFERENCES mbox.loyalty_point_ledger(tenant_id,store_id,id),
 CHECK((decision='approved')=(ledger_entry_id IS NOT NULL))
);
CREATE TABLE mbox.loyalty_manual_receipts (
 tenant_id uuid NOT NULL, store_id uuid NOT NULL, operation text NOT NULL CHECK(operation IN ('request','decision')),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
 fingerprint char(64) NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,operation,idempotency_key),
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['loyalty_manual_requests','loyalty_manual_decisions','loyalty_manual_receipts'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY scoped ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',t);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',t);
 END LOOP;
END $$;
CREATE FUNCTION mbox.guard_manual_points_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
DECLARE r mbox.loyalty_manual_requests; BEGIN
 SELECT * INTO STRICT r FROM mbox.loyalty_manual_requests WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.request_id);
 IF r.requested_by_employee_id=NEW.decided_by_employee_id THEN RAISE EXCEPTION 'Manual points require independent review' USING ERRCODE='23514'; END IF;
 IF NEW.decision='approved' AND NOT EXISTS(SELECT 1 FROM mbox.loyalty_point_ledger l WHERE (l.tenant_id,l.store_id,l.id)=(NEW.tenant_id,NEW.store_id,NEW.ledger_entry_id)
  AND l.membership_id=r.membership_id AND l.customer_id=r.customer_id AND l.points_delta=r.points_delta
  AND l.policy_version_id=r.policy_version_id AND l.entry_type='adjust' AND l.source_type='manual' AND l.source_id=r.id::text AND l.created_by_employee_id=NEW.decided_by_employee_id) THEN
  RAISE EXCEPTION 'Manual points decision requires exact ledger evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.guard_manual_points_decision() FROM PUBLIC;
CREATE TRIGGER manual_points_review_guard BEFORE INSERT ON mbox.loyalty_manual_decisions FOR EACH ROW EXECUTE FUNCTION mbox.guard_manual_points_decision();
CREATE INDEX manual_points_requests_history ON mbox.loyalty_manual_requests(tenant_id,store_id,created_at DESC,id);
CREATE INDEX manual_points_decision_receipt ON mbox.loyalty_manual_receipts(tenant_id,store_id,(result->>'requestId')) WHERE operation='decision';
COMMENT ON TABLE mbox.loyalty_manual_requests IS 'Append-only human adjustments, separate from original-order supplements. Approval uses an explicitly configured loyalty.adjust.manual CNY limit at one yuan per point. No default amount authority is granted.';
CREATE FUNCTION mbox.seed_manual_points_configuration() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
 INSERT INTO mbox.staff_access_configuration_definitions(tenant_id,store_id,definition_kind,code,label,description,required_permission_codes,sort_order,config)
 VALUES(NEW.tenant_id,NEW.id,'approval_limit','loyalty.adjust.manual','人工积分调整审批','按每积分1元控制单笔人工补发或纠错额度，必须由另一员工审核',ARRAY['loyalty.adjust.manual','loyalty.accrual.approve'],35,'{"currency":"CNY","defaultRules":{"requiresSecondActor":true,"requiresReason":true},"controls":["second_actor"]}') ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.seed_manual_points_configuration() FROM PUBLIC;
CREATE TRIGGER store_manual_points_configuration AFTER INSERT ON mbox.stores FOR EACH ROW EXECUTE FUNCTION mbox.seed_manual_points_configuration();
INSERT INTO mbox.staff_access_configuration_definitions(tenant_id,store_id,definition_kind,code,label,description,required_permission_codes,sort_order,config)
 SELECT tenant_id,id,'approval_limit','loyalty.adjust.manual','人工积分调整审批','按每积分1元控制单笔人工补发或纠错额度，必须由另一员工审核',ARRAY['loyalty.adjust.manual','loyalty.accrual.approve'],35,'{"currency":"CNY","defaultRules":{"requiresSecondActor":true,"requiresReason":true},"controls":["second_actor"]}'::jsonb FROM mbox.stores ON CONFLICT DO NOTHING;
UPDATE mbox.normalized_schema_metadata SET schema_version='269',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
