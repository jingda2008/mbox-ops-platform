BEGIN;
CREATE TABLE mbox.member_visit_reward_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 campaign_version_id uuid NOT NULL, campaign_code text NOT NULL,
 required_visits integer NOT NULL CHECK(required_visits BETWEEN 1 AND 365),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','stopped')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_by_employee_id uuid NOT NULL,
 UNIQUE(tenant_id,store_id,id), UNIQUE(tenant_id,store_id,campaign_code),
 FOREIGN KEY(tenant_id,store_id,campaign_version_id) REFERENCES mbox.member_gift_campaign_versions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.member_visit_reward_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 rule_id uuid NOT NULL, customer_id uuid NOT NULL, earned_business_date date NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','issued','rejected','invalid')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 decided_at timestamptz, decided_by_employee_id uuid, decision_reason text, job_id uuid,
 UNIQUE(tenant_id,store_id,id), UNIQUE(tenant_id,store_id,job_id),
 FOREIGN KEY(tenant_id,store_id,rule_id) REFERENCES mbox.member_visit_reward_rules(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,decided_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,job_id) REFERENCES mbox.member_gift_delivery_jobs(tenant_id,store_id,id),
 CHECK ((status='pending' AND decided_at IS NULL AND decided_by_employee_id IS NULL AND decision_reason IS NULL AND job_id IS NULL)
   OR (status<>'pending' AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND length(trim(decision_reason)) BETWEEN 2 AND 300
     AND ((status='issued' AND job_id IS NOT NULL AND decided_by_employee_id IS NOT NULL)
       OR (status<>'issued' AND job_id IS NULL))))
);
CREATE TABLE mbox.member_visit_reward_sources (
 tenant_id uuid NOT NULL, store_id uuid NOT NULL, request_id uuid NOT NULL, visit_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,store_id,request_id,visit_id),
 FOREIGN KEY(tenant_id,store_id,request_id) REFERENCES mbox.member_visit_reward_requests(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,visit_id) REFERENCES mbox.member_visit_checkins(tenant_id,store_id,id)
);
CREATE INDEX member_visit_reward_pending ON mbox.member_visit_reward_requests(tenant_id,store_id,earned_business_date,status,id);
CREATE INDEX member_visit_reward_customer ON mbox.member_visit_reward_requests(tenant_id,store_id,customer_id,rule_id);
CREATE INDEX member_visit_reward_source_visit ON mbox.member_visit_reward_sources(tenant_id,store_id,visit_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['member_visit_reward_rules','member_visit_reward_requests','member_visit_reward_sources'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY scoped ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',t);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',t);
 END LOOP;
END $$;
GRANT UPDATE(status) ON mbox.member_visit_reward_rules TO mbox_runtime;
GRANT UPDATE(status,decided_at,decided_by_employee_id,decision_reason,job_id) ON mbox.member_visit_reward_requests TO mbox_runtime;
CREATE FUNCTION mbox.guard_member_visit_reward_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='member_visit_reward_rules' THEN
  IF OLD.status<>'active' OR NEW.status<>'stopped' THEN RAISE EXCEPTION 'Attendance reward rule can only stop' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD.status<>'pending' OR NEW.status='pending' THEN RAISE EXCEPTION 'Attendance reward decision is final' USING ERRCODE='23514'; END IF;
  IF NEW.status='issued' AND NOT EXISTS(SELECT 1 FROM mbox.member_gift_delivery_jobs j JOIN mbox.member_visit_reward_rules r ON r.tenant_id=j.tenant_id AND r.store_id=j.store_id AND r.campaign_version_id=j.campaign_version_id WHERE j.tenant_id=NEW.tenant_id AND j.store_id=NEW.store_id AND j.id=NEW.job_id AND j.status='issued' AND j.cycle_key='visit:'||NEW.id::text AND r.id=NEW.rule_id AND mbox.canonical_customer_id(j.tenant_id,j.store_id,j.customer_id)=mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.customer_id)) THEN
   RAISE EXCEPTION 'Attendance approval requires its issued gift receipt' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_visit_reward_rule_stop BEFORE UPDATE ON mbox.member_visit_reward_rules FOR EACH ROW EXECUTE FUNCTION mbox.guard_member_visit_reward_transition();
CREATE TRIGGER member_visit_reward_decision_once BEFORE UPDATE ON mbox.member_visit_reward_requests FOR EACH ROW EXECUTE FUNCTION mbox.guard_member_visit_reward_transition();
COMMENT ON TABLE mbox.member_visit_reward_requests IS 'Each threshold cycle requires a manager decision. Issuance and approval commit atomically; rejected/issued cycles never reuse attendance dates. Invalid cycles release remaining valid dates.';
COMMIT;
