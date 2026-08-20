BEGIN;

-- A subscription-message template is executable policy, not display metadata.
-- Every field that changes eligibility, routing, timing or throttling is typed.
CREATE TABLE mbox.wechat_notification_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  notification_type text NOT NULL CHECK (notification_type IN (
    'loyalty_points_credited','loyalty_points_reversed','loyalty_points_expiring'
  )),
  authorization_purpose text NOT NULL CHECK (authorization_purpose IN (
    'loyalty_balance_change','loyalty_expiry_reminder'
  )),
  authorization_context text NOT NULL CHECK (authorization_context IN (
    'loyalty_accrual','loyalty_refund','loyalty_expiry'
  )),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  template_id text NOT NULL CHECK (length(btrim(template_id)) BETWEEN 8 AND 128),
  page_path text NOT NULL CHECK (page_path ~ '^pages/[A-Za-z0-9_./-]{1,180}$'),
  points_data_key text NOT NULL CHECK (points_data_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  balance_data_key text CHECK (balance_data_key IS NULL OR balance_data_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  occurred_at_data_key text NOT NULL CHECK (occurred_at_data_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  expires_at_data_key text CHECK (expires_at_data_key IS NULL OR expires_at_data_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  expiry_lead_days integer CHECK (expiry_lead_days IS NULL OR expiry_lead_days BETWEEN 1 AND 90),
  max_per_customer_per_24h integer NOT NULL DEFAULT 3
    CHECK (max_per_customer_per_24h BETWEEN 1 AND 20),
  minimum_interval_minutes integer NOT NULL DEFAULT 10
    CHECK (minimum_interval_minutes BETWEEN 0 AND 1440),
  quiet_hours_start time,
  quiet_hours_end time,
  effective_from timestamptz,
  effective_until timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, notification_type, policy_version),
  UNIQUE (
    tenant_id, store_id, id, notification_type, authorization_purpose,
    authorization_context, policy_version, template_id
  ),
  UNIQUE (tenant_id, store_id, id),
  CHECK (
    (notification_type='loyalty_points_credited'
      AND authorization_purpose='loyalty_balance_change'
      AND authorization_context='loyalty_accrual'
      AND balance_data_key IS NOT NULL AND expires_at_data_key IS NULL
      AND expiry_lead_days IS NULL)
    OR (notification_type='loyalty_points_reversed'
      AND authorization_purpose='loyalty_balance_change'
      AND authorization_context='loyalty_refund'
      AND balance_data_key IS NOT NULL AND expires_at_data_key IS NULL
      AND expiry_lead_days IS NULL)
    OR (notification_type='loyalty_points_expiring'
      AND authorization_purpose='loyalty_expiry_reminder'
      AND authorization_context='loyalty_expiry'
      AND balance_data_key IS NULL AND expires_at_data_key IS NOT NULL
      AND expiry_lead_days IS NOT NULL)
  ),
  CHECK ((quiet_hours_start IS NULL) = (quiet_hours_end IS NULL)),
  CHECK (quiet_hours_start IS NULL OR quiet_hours_start<>quiet_hours_end),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until>effective_from),
  CHECK (
    (status='published' AND effective_from IS NOT NULL AND published_at IS NOT NULL)
    OR status<>'published'
  )
);

ALTER TABLE mbox.wechat_notification_policies
  ADD CONSTRAINT wechat_notification_policies_no_published_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    store_id WITH =,
    notification_type WITH =,
    tstzrange(effective_from, effective_until, '[)') WITH &&
  ) WHERE (status='published');

CREATE FUNCTION mbox.wechat_notification_scheduled_at(
  event_at timestamptz,
  quiet_start time,
  quiet_end time,
  timezone_name text
) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE
  local_event timestamp;
  local_time time;
BEGIN
  IF quiet_start IS NULL OR quiet_end IS NULL THEN RETURN event_at; END IF;
  local_event := event_at AT TIME ZONE timezone_name;
  local_time := local_event::time;
  IF quiet_start<quiet_end AND local_time>=quiet_start AND local_time<quiet_end THEN
    RETURN (local_event::date+quiet_end) AT TIME ZONE timezone_name;
  END IF;
  IF quiet_start>quiet_end AND local_time>=quiet_start THEN
    RETURN ((local_event::date+1)+quiet_end) AT TIME ZONE timezone_name;
  END IF;
  IF quiet_start>quiet_end AND local_time<quiet_end THEN
    RETURN (local_event::date+quiet_end) AT TIME ZONE timezone_name;
  END IF;
  RETURN event_at;
END;
$$;

ALTER TABLE mbox.customer_memberships
  ADD CONSTRAINT customer_memberships_notification_customer_uq
  UNIQUE (tenant_id, store_id, id, customer_id);

CREATE TABLE mbox.wechat_notification_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  identity_external_id text NOT NULL,
  policy_id uuid NOT NULL,
  notification_type text NOT NULL,
  authorization_purpose text NOT NULL,
  authorization_context text NOT NULL,
  policy_version integer NOT NULL,
  template_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('granted','denied','revoked')),
  platform_result text NOT NULL CHECK (platform_result IN ('accept','reject','ban','revoke')),
  authorization_version integer NOT NULL CHECK (authorization_version > 0),
  uses_allowed integer NOT NULL CHECK (uses_allowed IN (0,1)),
  source text NOT NULL CHECK (source IN ('wechat_client','customer_revoke')),
  platform_event_reference_hash char(64) NOT NULL
    CHECK (platform_event_reference_hash ~ '^[0-9a-f]{64}$'),
  authorized_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id, customer_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id, customer_id),
  FOREIGN KEY (tenant_id, store_id, identity_external_id)
    REFERENCES mbox.wechat_identities(tenant_id, store_id, external_identity_id),
  FOREIGN KEY (
    tenant_id, store_id, policy_id, notification_type, authorization_purpose,
    authorization_context, policy_version, template_id
  ) REFERENCES mbox.wechat_notification_policies(
    tenant_id, store_id, id, notification_type, authorization_purpose,
    authorization_context, policy_version, template_id
  ),
  UNIQUE (tenant_id, store_id, customer_id, policy_id, authorization_version),
  UNIQUE (tenant_id, store_id, identity_external_id, platform_event_reference_hash),
  UNIQUE (
    tenant_id, store_id, id, customer_id, membership_id, identity_external_id,
    policy_id, notification_type, authorization_purpose, authorization_context,
    policy_version, template_id
  ),
  UNIQUE (tenant_id, store_id, id),
  CHECK (
    (platform_result='accept' AND decision='granted' AND uses_allowed=1 AND source='wechat_client')
    OR (platform_result IN ('reject','ban') AND decision='denied' AND uses_allowed=0 AND source='wechat_client')
    OR (platform_result='revoke' AND decision='revoked' AND uses_allowed=0 AND source='customer_revoke')
  )
);

CREATE INDEX wechat_notification_authorizations_latest_idx
  ON mbox.wechat_notification_authorizations (
    tenant_id, store_id, customer_id, policy_id, authorization_version DESC, id DESC
  );

-- Client evidence is accepted only for the currently authenticated customer's own
-- active WeChat principal. A caller cannot nominate another customer's identity.
CREATE FUNCTION mbox.validate_wechat_notification_authorization_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM mbox.wechat_identities identity
    JOIN mbox.customer_identities customer_identity
      ON customer_identity.tenant_id=identity.tenant_id
     AND customer_identity.store_id=identity.store_id
     AND customer_identity.identity_kind='wechat'
     AND customer_identity.identity_hash=encode(digest('wechat:'||identity.principal_id,'sha256'),'hex')
     AND customer_identity.status='active'
    WHERE identity.tenant_id=NEW.tenant_id
      AND identity.store_id=NEW.store_id
      AND identity.external_identity_id=NEW.identity_external_id
      AND identity.channel='mini_program'
      AND identity.revoked_at IS NULL
      AND customer_identity.customer_id=NEW.customer_id
      AND (identity.member_id IS NULL OR identity.member_id=NEW.membership_id)
  ) THEN
    RAISE EXCEPTION 'WeChat notification authorization identity does not belong to customer';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wechat_notification_authorizations_owner_guard
  BEFORE INSERT ON mbox.wechat_notification_authorizations
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_wechat_notification_authorization_owner();

CREATE TABLE mbox.wechat_customer_notification_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  identity_external_id text NOT NULL,
  authorization_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  notification_type text NOT NULL,
  authorization_purpose text NOT NULL,
  authorization_context text NOT NULL,
  policy_version integer NOT NULL,
  template_id text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN (
    'loyalty_order_award','loyalty_refund_application','loyalty_point_lot'
  )),
  source_id uuid NOT NULL,
  points_change integer NOT NULL,
  points_at_risk integer NOT NULL DEFAULT 0 CHECK (points_at_risk >= 0),
  balance_after integer CHECK (balance_after IS NULL OR balance_after >= 0),
  expires_at timestamptz,
  event_occurred_at timestamptz NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts=1),
  locked_by text,
  locked_at timestamptz,
  sent_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id, customer_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id, customer_id),
  FOREIGN KEY (
    tenant_id, store_id, authorization_id, customer_id, membership_id,
    identity_external_id, policy_id, notification_type, authorization_purpose,
    authorization_context, policy_version, template_id
  ) REFERENCES mbox.wechat_notification_authorizations(
    tenant_id, store_id, id, customer_id, membership_id, identity_external_id,
    policy_id, notification_type, authorization_purpose, authorization_context,
    policy_version, template_id
  ),
  UNIQUE (tenant_id, store_id, source_type, source_id, notification_type),
  UNIQUE (tenant_id, store_id, id),
  CHECK (
    (notification_type='loyalty_points_credited'
      AND source_type='loyalty_order_award' AND points_change>0
      AND points_at_risk=0 AND balance_after IS NOT NULL AND expires_at IS NULL)
    OR (notification_type='loyalty_points_reversed'
      AND source_type='loyalty_refund_application' AND points_change<0
      AND points_at_risk=0 AND balance_after IS NOT NULL AND expires_at IS NULL)
    OR (notification_type='loyalty_points_expiring'
      AND source_type='loyalty_point_lot' AND points_change=0
      AND points_at_risk>0 AND balance_after IS NULL AND expires_at IS NOT NULL)
  ),
  CHECK (
    (status='sending' AND locked_by IS NOT NULL AND locked_at IS NOT NULL AND sent_at IS NULL)
    OR (status='sent' AND locked_by IS NULL AND locked_at IS NULL AND sent_at IS NOT NULL)
    OR (status IN ('pending','failed','suppressed') AND locked_by IS NULL AND locked_at IS NULL AND sent_at IS NULL)
  ),
  CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_.:-]{2,95}$')
);

-- A notification job must be backed by the exact normalized loyalty fact it
-- describes.  This prevents a privileged internal caller from fabricating a
-- sendable balance event by supplying a plausible UUID and typed-looking
-- values.  Provider/display JSON is deliberately irrelevant here.
CREATE FUNCTION mbox.validate_wechat_notification_job_source()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type='loyalty_order_award' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM mbox.loyalty_order_awards award
      WHERE award.tenant_id=NEW.tenant_id AND award.store_id=NEW.store_id
        AND award.id=NEW.source_id AND award.membership_id=NEW.membership_id
        AND award.customer_id=NEW.customer_id
        AND award.awarded_points>=NEW.points_change
        AND award.awarded_at=NEW.event_occurred_at
    ) THEN
      RAISE EXCEPTION 'WeChat points-credit notification has no matching loyalty award';
    END IF;
  ELSIF NEW.source_type='loyalty_refund_application' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM mbox.loyalty_award_refund_applications application
      JOIN mbox.loyalty_order_awards award
        ON award.tenant_id=application.tenant_id AND award.store_id=application.store_id
       AND award.id=application.award_id
      JOIN mbox.refunds refund
        ON refund.tenant_id=application.tenant_id AND refund.store_id=application.store_id
       AND refund.id=application.refund_id AND refund.status='succeeded'
      WHERE application.tenant_id=NEW.tenant_id AND application.store_id=NEW.store_id
        AND application.id=NEW.source_id AND award.membership_id=NEW.membership_id
        AND award.customer_id=NEW.customer_id
        AND application.reversed_points=-NEW.points_change
        AND application.applied_at=NEW.event_occurred_at
    ) THEN
      RAISE EXCEPTION 'WeChat points-reversal notification has no matching refund application';
    END IF;
  ELSIF NEW.source_type='loyalty_point_lot' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM mbox.loyalty_point_lots lot
      JOIN mbox.customer_memberships membership
        ON membership.tenant_id=lot.tenant_id AND membership.store_id=lot.store_id
       AND membership.id=lot.membership_id
      WHERE lot.tenant_id=NEW.tenant_id AND lot.store_id=NEW.store_id
        AND lot.id=NEW.source_id AND lot.membership_id=NEW.membership_id
        AND membership.customer_id=NEW.customer_id
        AND lot.remaining_points=NEW.points_at_risk
        AND lot.expires_at=NEW.expires_at
    ) THEN
      RAISE EXCEPTION 'WeChat points-expiry notification has no matching point lot';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported WeChat notification source type %',NEW.source_type;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wechat_customer_notification_jobs_source_guard
  BEFORE INSERT ON mbox.wechat_customer_notification_jobs
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_wechat_notification_job_source();

CREATE INDEX wechat_customer_notification_jobs_due_idx
  ON mbox.wechat_customer_notification_jobs (tenant_id, store_id, scheduled_for, id)
  WHERE status IN ('pending','failed');

CREATE TABLE mbox.wechat_notification_authorization_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  notification_job_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, authorization_id)
    REFERENCES mbox.wechat_notification_authorizations(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, notification_job_id)
    REFERENCES mbox.wechat_customer_notification_jobs(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, authorization_id),
  UNIQUE (tenant_id, store_id, notification_job_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.wechat_notification_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  notification_job_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted','provider_rejected','unknown')),
  provider_reference_hash char(64)
    CHECK (provider_reference_hash IS NULL OR provider_reference_hash ~ '^[0-9a-f]{64}$'),
  provider_error_code text CHECK (
    provider_error_code IS NULL OR provider_error_code ~ '^[A-Za-z0-9_.:-]{1,95}$'
  ),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, notification_job_id)
    REFERENCES mbox.wechat_customer_notification_jobs(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, notification_job_id),
  UNIQUE (tenant_id, store_id, id),
  CHECK (
    (outcome='accepted' AND provider_error_code IS NULL)
    OR (outcome<>'accepted' AND provider_error_code IS NOT NULL)
  )
);

CREATE TRIGGER wechat_notification_authorizations_append_only
  BEFORE UPDATE OR DELETE ON mbox.wechat_notification_authorizations
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER wechat_notification_authorization_uses_append_only
  BEFORE UPDATE OR DELETE ON mbox.wechat_notification_authorization_uses
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER wechat_notification_receipts_append_only
  BEFORE UPDATE OR DELETE ON mbox.wechat_notification_receipts
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE FUNCTION mbox.protect_wechat_notification_job()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.tenant_id,NEW.store_id,NEW.customer_id,NEW.membership_id,NEW.identity_external_id,
    NEW.authorization_id,NEW.policy_id,NEW.notification_type,NEW.authorization_purpose,
    NEW.authorization_context,NEW.policy_version,NEW.template_id,NEW.source_type,NEW.source_id,
    NEW.points_change,NEW.points_at_risk,NEW.balance_after,NEW.expires_at,NEW.event_occurred_at,
    NEW.max_attempts,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id,OLD.store_id,OLD.customer_id,OLD.membership_id,OLD.identity_external_id,
    OLD.authorization_id,OLD.policy_id,OLD.notification_type,OLD.authorization_purpose,
    OLD.authorization_context,OLD.policy_version,OLD.template_id,OLD.source_type,OLD.source_id,
    OLD.points_change,OLD.points_at_risk,OLD.balance_after,OLD.expires_at,OLD.event_occurred_at,
    OLD.max_attempts,OLD.created_at
  ) THEN
    RAISE EXCEPTION 'WeChat notification business facts are immutable';
  END IF;
  IF NOT (
    (OLD.status='pending' AND NEW.status IN ('pending','sending','suppressed'))
    OR (OLD.status='sending' AND NEW.status IN ('sent','failed'))
    OR (OLD.status='failed' AND NEW.status IN ('sending','suppressed'))
    OR (OLD.status=NEW.status AND OLD.status IN ('sent','suppressed'))
  ) THEN
    RAISE EXCEPTION 'Invalid WeChat notification job transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wechat_customer_notification_jobs_guard
  BEFORE UPDATE OR DELETE ON mbox.wechat_customer_notification_jobs
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_wechat_notification_job();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'wechat_notification_policies',
    'wechat_notification_authorizations',
    'wechat_customer_notification_jobs',
    'wechat_notification_authorization_uses',
    'wechat_notification_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT ON TABLE mbox.wechat_notification_policies TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.wechat_notification_authorizations TO mbox_runtime;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.wechat_customer_notification_jobs TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.wechat_notification_authorization_uses TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.wechat_notification_receipts TO mbox_runtime;

COMMENT ON TABLE mbox.wechat_notification_authorizations IS
  'Exact, append-only WeChat authorization facts. Legacy generic consent is never promoted into a sendable authorization.';
COMMENT ON TABLE mbox.wechat_customer_notification_jobs IS
  'Typed loyalty notification jobs. Eligibility and message values are not read from JSON payloads.';
COMMENT ON TABLE mbox.wechat_notification_receipts IS
  'Typed provider outcomes. Raw provider responses may be logged externally but never decide notification business state.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='083',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
