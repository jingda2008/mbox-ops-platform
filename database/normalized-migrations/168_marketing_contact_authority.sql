BEGIN;
-- New purpose, new explicit evidence. Never copy transactional notification
-- permissions, phone authorization, fan-card approvals or platform follows.
CREATE TABLE mbox.marketing_notice_versions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{1,39}$'),version integer NOT NULL CHECK(version>0),
  operator_name text NOT NULL CHECK(length(btrim(operator_name)) BETWEEN 2 AND 200),
  operator_contact text NOT NULL CHECK(length(btrim(operator_contact)) BETWEEN 2 AND 300),
  summary text NOT NULL CHECK(length(btrim(summary)) BETWEEN 2 AND 3000),
  withdrawal_instructions text NOT NULL CHECK(length(btrim(withdrawal_instructions)) BETWEEN 2 AND 1000),
  purposes text[] NOT NULL CHECK(cardinality(purposes) BETWEEN 1 AND 2 AND purposes<@ARRAY['own_activities','mbox_joint_activities']::text[]),
  channels text[] NOT NULL CHECK(cardinality(channels) BETWEEN 1 AND 3 AND channels<@ARRAY['wechat','sms','phone']::text[]),
  data_categories text[] NOT NULL CHECK(cardinality(data_categories) BETWEEN 1 AND 20),
  valid_from timestamptz NOT NULL,valid_until timestamptz NOT NULL CHECK(valid_until>valid_from),
  consent_days integer NOT NULL CHECK(consent_days BETWEEN 1 AND 3660),
  contact_start_minute integer NOT NULL CHECK(contact_start_minute BETWEEN 0 AND 1439),
  contact_end_minute integer NOT NULL CHECK(contact_end_minute BETWEEN 1 AND 1440 AND contact_end_minute>contact_start_minute),
  weekdays integer[] NOT NULL CHECK(cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays<@ARRAY[1,2,3,4,5,6,7]),
  maximum_per_day integer NOT NULL CHECK(maximum_per_day BETWEEN 1 AND 100),
  maximum_per_month integer NOT NULL CHECK(maximum_per_month BETWEEN maximum_per_day AND 1000),
  sharing_mode text NOT NULL CHECK(sharing_mode='no_partner_list'),
  created_by_employee_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 500),
  request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),request_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,code,version),UNIQUE(tenant_id,store_id,request_key),
  FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.marketing_notice_decisions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,notice_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN('approve','publish','stop')),employee_id uuid NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 500),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,notice_id,action),
  FOREIGN KEY(tenant_id,store_id,notice_id) REFERENCES mbox.marketing_notice_versions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.marketing_consent_events(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sequence bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,customer_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN('granted','withdrawn','denied','stop_all')),
  channel text CHECK(channel IN('wechat','sms','phone')),purpose text CHECK(purpose IN('own_activities','mbox_joint_activities')),
  notice_id uuid,valid_until timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((action='stop_all')=(channel IS NULL)),CHECK((action='stop_all')=(purpose IS NULL)),
  CHECK(action<>'granted' OR (notice_id IS NOT NULL AND valid_until IS NOT NULL AND valid_until>created_at)),
  source text NOT NULL CHECK(source IN('customer_self','staff_recorded_refusal')),
  actor_employee_id uuid,reason text,
  CHECK((source='staff_recorded_refusal')=(actor_employee_id IS NOT NULL)),
  CHECK(source<>'staff_recorded_refusal' OR (action IN('withdrawn','stop_all') AND length(btrim(reason)) BETWEEN 2 AND 500)),
  UNIQUE(tenant_id,store_id,id),UNIQUE(sequence),
  FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,notice_id) REFERENCES mbox.marketing_notice_versions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,actor_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE INDEX marketing_consent_family_history ON mbox.marketing_consent_events(tenant_id,store_id,customer_id,sequence DESC);
CREATE FUNCTION mbox.validate_marketing_notice_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE author uuid;approver uuid;
BEGIN
  SELECT created_by_employee_id INTO author FROM mbox.marketing_notice_versions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.notice_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM mbox.marketing_notice_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND notice_id=NEW.notice_id AND action='stop') THEN RAISE EXCEPTION 'Marketing notice is stopped'; END IF;
  IF NEW.action IN('approve','publish') AND NEW.employee_id=author THEN RAISE EXCEPTION 'Marketing notice author cannot self approve or publish'; END IF;
  SELECT employee_id INTO approver FROM mbox.marketing_notice_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND notice_id=NEW.notice_id AND action='approve';
  IF NEW.action='publish' AND (approver IS NULL OR approver=NEW.employee_id) THEN RAISE EXCEPTION 'Marketing notice requires separate approval'; END IF;
  IF NEW.action='stop' AND NOT EXISTS(SELECT 1 FROM mbox.marketing_notice_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND notice_id=NEW.notice_id AND action='publish') THEN RAISE EXCEPTION 'Only published marketing notice can stop'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_marketing_notice_decision BEFORE INSERT ON mbox.marketing_notice_decisions FOR EACH ROW EXECUTE FUNCTION mbox.validate_marketing_notice_decision();
CREATE FUNCTION mbox.validate_marketing_consent_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE notice mbox.marketing_notice_versions;
BEGIN
  IF NEW.action<>'granted' THEN RETURN NEW; END IF;
  SELECT * INTO notice FROM mbox.marketing_notice_versions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.notice_id FOR UPDATE;
  IF notice.id IS NULL OR NOT NEW.channel=ANY(notice.channels) OR NOT NEW.purpose=ANY(notice.purposes) OR NEW.valid_until>notice.valid_until OR NEW.valid_until>NEW.created_at+(notice.consent_days*interval '1 day') OR NEW.created_at<notice.valid_from OR NEW.created_at>=notice.valid_until
    OR NOT EXISTS(SELECT 1 FROM mbox.marketing_notice_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND notice_id=NEW.notice_id AND action='publish')
    OR EXISTS(SELECT 1 FROM mbox.marketing_notice_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND notice_id=NEW.notice_id AND action='stop') THEN RAISE EXCEPTION 'Marketing consent requires current published scope and expiry'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_marketing_consent_grant BEFORE INSERT ON mbox.marketing_consent_events FOR EACH ROW EXECUTE FUNCTION mbox.validate_marketing_consent_grant();
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['marketing_notice_versions','marketing_notice_decisions','marketing_consent_events'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',name);
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',name);
    EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',name);
    EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',name);
  END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE mbox.marketing_consent_events_sequence_seq TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.validate_marketing_notice_decision(),mbox.validate_marketing_consent_grant() FROM PUBLIC;
CREATE FUNCTION mbox.seed_marketing_permission_definitions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category)
    SELECT NEW.tenant_id,NEW.id,p.code,p.name,'customer_benefit' FROM (VALUES
      ('marketing.notice.view','查看营销告知规则'),('marketing.notice.edit','编辑营销告知规则'),
      ('marketing.notice.approve','审核营销告知规则'),('marketing.notice.publish','发布营销告知规则'),
      ('marketing.send','执行营销联系任务'),('marketing.refusal.record','记录客户拒绝营销'),
      ('marketing.consent.audit','核查营销授权证据')) p(code,name)
    ON CONFLICT(tenant_id,store_id,code) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.seed_marketing_permission_definitions() FROM PUBLIC;
CREATE TRIGGER seed_marketing_permission_definitions AFTER INSERT ON mbox.stores FOR EACH ROW EXECUTE FUNCTION mbox.seed_marketing_permission_definitions();
INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category)
 SELECT s.tenant_id,s.id,p.code,p.name,'customer_benefit' FROM mbox.stores s CROSS JOIN(VALUES
   ('marketing.notice.view','查看营销告知规则'),('marketing.notice.edit','编辑营销告知规则'),
   ('marketing.notice.approve','审核营销告知规则'),('marketing.notice.publish','发布营销告知规则'),
   ('marketing.send','执行营销联系任务'),('marketing.refusal.record','记录客户拒绝营销'),
   ('marketing.consent.audit','核查营销授权证据')) p(code,name)
 ON CONFLICT(tenant_id,store_id,code) DO NOTHING;
-- Definitions only: no employee or role receives these powers automatically.
UPDATE mbox.normalized_schema_metadata SET schema_version='168',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
