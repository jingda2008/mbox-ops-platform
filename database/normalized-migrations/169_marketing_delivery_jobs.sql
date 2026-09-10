BEGIN;
-- Persist business intent separately from attempts. No existing customer is
-- enrolled, queued, or contacted by this migration.
CREATE TABLE mbox.marketing_delivery_jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  customer_id uuid NOT NULL,notice_id uuid NOT NULL,consent_id uuid NOT NULL,
  channel text NOT NULL CHECK(channel IN('wechat','sms','phone')),
  purpose text NOT NULL CHECK(purpose IN('own_activities','mbox_joint_activities')),
  campaign_key text NOT NULL CHECK(campaign_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$'),
  content text NOT NULL CHECK(length(btrim(content)) BETWEEN 2 AND 2000),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','blocked','dispatching','submitted','sent','unknown','cancelled','failed')),
  blocked_reason text,checks integer NOT NULL DEFAULT 0 CHECK(checks>=0),
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
  created_by_employee_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(expires_at>created_at),
  UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,campaign_key,customer_id,channel),
  FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,notice_id) REFERENCES mbox.marketing_notice_versions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,consent_id) REFERENCES mbox.marketing_consent_events(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.marketing_delivery_attempts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  job_id uuid NOT NULL,customer_id uuid NOT NULL,consent_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'dispatching' CHECK(state IN('dispatching','submitted','sent','unknown','failed','cancelled')),
  capability_evidence_ref text NOT NULL CHECK(length(capability_evidence_ref) BETWEEN 2 AND 200),
  recipient_evidence_ref text NOT NULL CHECK(length(recipient_evidence_ref) BETWEEN 2 AND 200),
  platform_evidence_ref text NOT NULL CHECK(length(platform_evidence_ref) BETWEEN 2 AND 200),
  provider_receipt_ref text,handoff_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,job_id),
  FOREIGN KEY(tenant_id,store_id,job_id) REFERENCES mbox.marketing_delivery_jobs(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,consent_id) REFERENCES mbox.marketing_consent_events(tenant_id,store_id,id)
);
CREATE INDEX marketing_jobs_due ON mbox.marketing_delivery_jobs(tenant_id,store_id,next_check_at,id) WHERE status IN('queued','blocked');
CREATE INDEX marketing_attempt_frequency ON mbox.marketing_delivery_attempts(tenant_id,store_id,customer_id,created_at);
CREATE FUNCTION mbox.validate_marketing_delivery_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE consent mbox.marketing_consent_events;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Marketing jobs retain audit evidence'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO consent FROM mbox.marketing_consent_events WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.consent_id;
    IF NEW.status<>'queued' OR NEW.checks<>0 OR consent.action<>'granted' OR consent.id IS NULL
      OR consent.notice_id<>NEW.notice_id OR consent.channel<>NEW.channel OR consent.purpose<>NEW.purpose
      OR mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,consent.customer_id)<>mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.customer_id)
      OR NEW.expires_at>consent.valid_until THEN RAISE EXCEPTION 'Marketing job requires original scoped consent'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['status','blocked_reason','checks','next_check_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','blocked_reason','checks','next_check_at','updated_at']) OR NEW.checks<OLD.checks THEN RAISE EXCEPTION 'Marketing job terms are immutable'; END IF;
  IF OLD.status IN('sent','failed','cancelled') THEN RAISE EXCEPTION 'Marketing terminal job is immutable'; END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status IN('queued','blocked') AND NEW.status IN('blocked','dispatching','cancelled')) OR
    (OLD.status='dispatching' AND NEW.status IN('submitted','sent','unknown','failed','cancelled')) OR
    (OLD.status IN('submitted','unknown') AND NEW.status IN('sent','failed'))
  ) THEN RAISE EXCEPTION 'Marketing job transition is invalid'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_marketing_delivery_job BEFORE INSERT OR UPDATE OR DELETE ON mbox.marketing_delivery_jobs FOR EACH ROW EXECUTE FUNCTION mbox.validate_marketing_delivery_job();
CREATE FUNCTION mbox.validate_marketing_delivery_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job mbox.marketing_delivery_jobs;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Marketing attempts retain audit evidence'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO job FROM mbox.marketing_delivery_jobs WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.job_id FOR UPDATE;
    IF job.id IS NULL OR job.status<>'dispatching' OR NEW.state<>'dispatching' OR NEW.handoff_at IS NOT NULL OR NEW.customer_id<>job.customer_id OR NEW.consent_id<>job.consent_id THEN RAISE EXCEPTION 'Marketing attempt requires claimed job'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','provider_receipt_ref','updated_at','handoff_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','provider_receipt_ref','updated_at','handoff_at']) THEN RAISE EXCEPTION 'Marketing attempt authority is immutable'; END IF;
  IF OLD.handoff_at IS NOT NULL AND NEW.handoff_at IS DISTINCT FROM OLD.handoff_at THEN RAISE EXCEPTION 'Marketing handoff cannot be reset'; END IF;
  IF OLD.state='dispatching' AND NEW.state='dispatching' AND OLD.handoff_at IS NULL AND NEW.handoff_at IS NOT NULL AND NEW.provider_receipt_ref IS NOT DISTINCT FROM OLD.provider_receipt_ref THEN RETURN NEW; END IF;
  IF OLD.state IN('sent','failed','cancelled') OR (OLD.provider_receipt_ref IS NOT NULL AND NEW.provider_receipt_ref IS DISTINCT FROM OLD.provider_receipt_ref) THEN RAISE EXCEPTION 'Marketing receipt is immutable'; END IF;
  IF NOT ((OLD.state='dispatching' AND NEW.state IN('submitted','sent','unknown','failed','cancelled')) OR (OLD.state IN('submitted','unknown') AND NEW.state IN('sent','failed'))) THEN RAISE EXCEPTION 'Marketing attempt transition is invalid'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_marketing_delivery_attempt BEFORE INSERT OR UPDATE OR DELETE ON mbox.marketing_delivery_attempts FOR EACH ROW EXECUTE FUNCTION mbox.validate_marketing_delivery_attempt();
CREATE FUNCTION mbox.check_marketing_job_attempt_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job mbox.marketing_delivery_jobs;attempt mbox.marketing_delivery_attempts;job_id uuid;
BEGIN
  IF TG_TABLE_NAME='marketing_delivery_jobs' THEN job_id:=NEW.id; ELSE job_id:=NEW.job_id; END IF;
  SELECT * INTO job FROM mbox.marketing_delivery_jobs WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=job_id;
  SELECT * INTO attempt FROM mbox.marketing_delivery_attempts a WHERE a.tenant_id=NEW.tenant_id AND a.store_id=NEW.store_id AND a.job_id=job.id;
  IF (job.status IN('queued','blocked') AND attempt.id IS NOT NULL) OR
     (job.status IN('dispatching','submitted','sent','unknown','failed') AND (attempt.id IS NULL OR attempt.state<>job.status)) OR
     (job.status='cancelled' AND attempt.id IS NOT NULL AND attempt.state<>'cancelled') THEN RAISE EXCEPTION 'Marketing status requires matching attempt facts'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER check_marketing_job_attempt_consistency AFTER INSERT OR UPDATE ON mbox.marketing_delivery_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.check_marketing_job_attempt_consistency();
CREATE CONSTRAINT TRIGGER check_marketing_job_attempt_consistency AFTER INSERT OR UPDATE ON mbox.marketing_delivery_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.check_marketing_job_attempt_consistency();
-- Stop/rejection and cancellation are one database commit. Already handed-off
-- attempts cannot be recalled; retain them for provider reconciliation.
CREATE FUNCTION mbox.cancel_marketing_jobs_for_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mbox.marketing_delivery_jobs SET status='cancelled',blocked_reason='consent_changed',updated_at=clock_timestamp()
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND status IN('queued','blocked')
      AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.customer_id)
      AND (NEW.action='stop_all' OR (channel=NEW.channel AND purpose=NEW.purpose));
  RETURN NEW;
END $$;
CREATE TRIGGER cancel_marketing_jobs_for_consent AFTER INSERT ON mbox.marketing_consent_events FOR EACH ROW EXECUTE FUNCTION mbox.cancel_marketing_jobs_for_consent();
CREATE FUNCTION mbox.cancel_marketing_jobs_for_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action='stop' THEN
    UPDATE mbox.marketing_delivery_jobs SET status='cancelled',blocked_reason='notice_stopped',updated_at=clock_timestamp() WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND notice_id=NEW.notice_id AND status IN('queued','blocked');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cancel_marketing_jobs_for_notice AFTER INSERT ON mbox.marketing_notice_decisions FOR EACH ROW EXECUTE FUNCTION mbox.cancel_marketing_jobs_for_notice();
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['marketing_delivery_jobs','marketing_delivery_attempts'] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',name);
    EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON mbox.%I TO mbox_runtime',name);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION mbox.validate_marketing_delivery_job(),mbox.validate_marketing_delivery_attempt(),mbox.cancel_marketing_jobs_for_consent(),mbox.cancel_marketing_jobs_for_notice() FROM PUBLIC;
REVOKE ALL ON FUNCTION mbox.check_marketing_job_attempt_consistency() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='169',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
