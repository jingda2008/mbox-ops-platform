BEGIN;

-- This is deliberately separate from the loyalty-points subscription pipeline.
-- Points templates have a rigid numeric contract; activity, benefit and tier
-- templates carry service text.  Combining the two would weaken both contracts.
CREATE TABLE mbox.wechat_member_service_notification_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  notification_type text NOT NULL CHECK (notification_type IN (
    'activity_registration_confirmed','member_benefit_issued','membership_tier_changed'
  )),
  authorization_purpose text NOT NULL DEFAULT 'member_service_update'
    CHECK (authorization_purpose='member_service_update'),
  authorization_context text NOT NULL CHECK (authorization_context IN (
    'activity_registration','member_benefit','membership_tier'
  )),
  policy_version integer NOT NULL CHECK (policy_version>0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  template_id text NOT NULL CHECK (length(btrim(template_id)) BETWEEN 8 AND 128),
  page_path text NOT NULL CHECK (page_path ~ '^pages/[A-Za-z0-9_./-]{1,180}$'),
  title_data_key text NOT NULL CHECK (title_data_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  detail_data_key text NOT NULL CHECK (detail_data_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  occurred_at_data_key text NOT NULL CHECK (occurred_at_data_key ~ '^[a-z][a-z0-9_]{1,31}$'),
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
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  UNIQUE (tenant_id,store_id,notification_type,policy_version),
  UNIQUE (tenant_id,store_id,id,notification_type,authorization_purpose,
    authorization_context,policy_version,template_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (notification_type='activity_registration_confirmed' AND authorization_context='activity_registration')
    OR (notification_type='member_benefit_issued' AND authorization_context='member_benefit')
    OR (notification_type='membership_tier_changed' AND authorization_context='membership_tier')
  ),
  CHECK ((quiet_hours_start IS NULL)=(quiet_hours_end IS NULL)),
  CHECK (title_data_key<>detail_data_key AND title_data_key<>occurred_at_data_key
    AND detail_data_key<>occurred_at_data_key),
  CHECK (quiet_hours_start IS NULL OR quiet_hours_start<>quiet_hours_end),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until>effective_from),
  CHECK ((status='published' AND effective_from IS NOT NULL AND published_at IS NOT NULL) OR status<>'published')
);

ALTER TABLE mbox.wechat_member_service_notification_policies
  ADD CONSTRAINT wechat_member_service_notification_policies_no_published_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,store_id WITH =,notification_type WITH =,
    tstzrange(effective_from,effective_until,'[)') WITH &&
  ) WHERE (status='published');

CREATE TABLE mbox.wechat_member_service_notification_authorizations (
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
  authorization_version integer NOT NULL CHECK (authorization_version>0),
  uses_allowed integer NOT NULL CHECK (uses_allowed IN (0,1)),
  source text NOT NULL CHECK (source IN ('wechat_client','customer_revoke')),
  platform_event_reference_hash char(64) NOT NULL CHECK (platform_event_reference_hash ~ '^[0-9a-f]{64}$'),
  authorized_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,membership_id,customer_id)
    REFERENCES mbox.customer_memberships(tenant_id,store_id,id,customer_id),
  FOREIGN KEY (tenant_id,store_id,identity_external_id)
    REFERENCES mbox.wechat_identities(tenant_id,store_id,external_identity_id),
  FOREIGN KEY (tenant_id,store_id,policy_id,notification_type,authorization_purpose,
    authorization_context,policy_version,template_id)
    REFERENCES mbox.wechat_member_service_notification_policies(
      tenant_id,store_id,id,notification_type,authorization_purpose,
      authorization_context,policy_version,template_id
    ),
  UNIQUE (tenant_id,store_id,customer_id,policy_id,authorization_version),
  UNIQUE (tenant_id,store_id,identity_external_id,platform_event_reference_hash),
  UNIQUE (tenant_id,store_id,id,customer_id,membership_id,identity_external_id,
    policy_id,notification_type,authorization_purpose,authorization_context,policy_version,template_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (platform_result='accept' AND decision='granted' AND uses_allowed=1 AND source='wechat_client')
    OR (platform_result IN ('reject','ban') AND decision='denied' AND uses_allowed=0 AND source='wechat_client')
    OR (platform_result='revoke' AND decision='revoked' AND uses_allowed=0 AND source='customer_revoke')
  )
);
CREATE INDEX wechat_member_service_notification_authorizations_latest_idx
  ON mbox.wechat_member_service_notification_authorizations(
    tenant_id,store_id,customer_id,policy_id,authorization_version DESC,id DESC
  );

CREATE FUNCTION mbox.validate_wechat_member_service_notification_authorization_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mbox.wechat_identities identity
    JOIN mbox.customer_identities customer_identity
      ON customer_identity.tenant_id=identity.tenant_id AND customer_identity.store_id=identity.store_id
     AND customer_identity.identity_kind='wechat'
     AND customer_identity.identity_hash=encode(digest('wechat:'||identity.principal_id,'sha256'),'hex')
     AND customer_identity.status='active'
    WHERE identity.tenant_id=NEW.tenant_id AND identity.store_id=NEW.store_id
      AND identity.external_identity_id=NEW.identity_external_id
      AND identity.channel='mini_program' AND identity.revoked_at IS NULL
      AND customer_identity.customer_id=NEW.customer_id
      AND (identity.member_id IS NULL OR identity.member_id=NEW.membership_id)
  ) THEN
    RAISE EXCEPTION 'WeChat member-service authorization identity does not belong to customer';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wechat_member_service_notification_authorizations_owner_guard
  BEFORE INSERT ON mbox.wechat_member_service_notification_authorizations
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_wechat_member_service_notification_authorization_owner();

CREATE TABLE mbox.wechat_member_service_notification_jobs (
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
  source_type text NOT NULL CHECK (source_type IN ('activity_registration','benefit','membership_tier_event')),
  source_id uuid NOT NULL,
  source_occurrence integer NOT NULL DEFAULT 1 CHECK (source_occurrence>=1),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  detail text NOT NULL CHECK (length(btrim(detail)) BETWEEN 1 AND 160),
  event_occurred_at timestamptz NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts=1),
  locked_by text,
  locked_at timestamptz,
  sent_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,membership_id,customer_id)
    REFERENCES mbox.customer_memberships(tenant_id,store_id,id,customer_id),
  FOREIGN KEY (tenant_id,store_id,authorization_id,customer_id,membership_id,identity_external_id,
    policy_id,notification_type,authorization_purpose,authorization_context,policy_version,template_id)
    REFERENCES mbox.wechat_member_service_notification_authorizations(
      tenant_id,store_id,id,customer_id,membership_id,identity_external_id,
      policy_id,notification_type,authorization_purpose,authorization_context,policy_version,template_id
    ),
  UNIQUE (tenant_id,store_id,source_type,source_id,source_occurrence,notification_type),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (notification_type='activity_registration_confirmed' AND source_type='activity_registration')
    OR (notification_type='member_benefit_issued' AND source_type='benefit')
    OR (notification_type='membership_tier_changed' AND source_type='membership_tier_event')
  ),
  CHECK (
    (status='sending' AND locked_by IS NOT NULL AND locked_at IS NOT NULL AND sent_at IS NULL)
    OR (status='sent' AND locked_by IS NULL AND locked_at IS NULL AND sent_at IS NOT NULL)
    OR (status IN ('pending','failed','suppressed') AND locked_by IS NULL AND locked_at IS NULL AND sent_at IS NULL)
  ),
  CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_.:-]{2,95}$')
);
CREATE INDEX wechat_member_service_notification_jobs_due_idx
  ON mbox.wechat_member_service_notification_jobs(tenant_id,store_id,scheduled_for,id)
  WHERE status IN ('pending','failed');

CREATE TABLE mbox.wechat_member_service_notification_authorization_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  notification_job_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,authorization_id)
    REFERENCES mbox.wechat_member_service_notification_authorizations(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,notification_job_id)
    REFERENCES mbox.wechat_member_service_notification_jobs(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,authorization_id),
  UNIQUE (tenant_id,store_id,notification_job_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE TABLE mbox.wechat_member_service_notification_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  notification_job_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted','provider_rejected','unknown')),
  provider_reference_hash char(64) CHECK (provider_reference_hash IS NULL OR provider_reference_hash ~ '^[0-9a-f]{64}$'),
  provider_error_code text CHECK (provider_error_code IS NULL OR provider_error_code ~ '^[A-Za-z0-9_.:-]{1,95}$'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,notification_job_id)
    REFERENCES mbox.wechat_member_service_notification_jobs(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,notification_job_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK ((outcome='accepted' AND provider_error_code IS NULL) OR (outcome<>'accepted' AND provider_error_code IS NOT NULL))
);

-- The three source events are emitted in the same transaction as the business
-- fact.  A missing authorization never blocks registration, benefit issuance or
-- tier calculation; it simply produces no sendable job.
CREATE FUNCTION mbox.enqueue_wechat_member_service_notification(
  candidate_tenant_id uuid,candidate_store_id uuid,candidate_type text,candidate_source_type text,candidate_source_id uuid,
  candidate_source_occurrence integer,candidate_membership_id uuid,candidate_customer_id uuid,
  candidate_title text,candidate_detail text,candidate_occurred_at timestamptz
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.wechat_member_service_notification_jobs(
    tenant_id,store_id,customer_id,membership_id,identity_external_id,authorization_id,
    policy_id,notification_type,authorization_purpose,authorization_context,policy_version,
    template_id,source_type,source_id,source_occurrence,title,detail,event_occurred_at,scheduled_for
  )
  SELECT policy.tenant_id,policy.store_id,candidate_customer_id,candidate_membership_id,
    authorization_choice.identity_external_id,authorization_choice.id,policy.id,
    policy.notification_type,policy.authorization_purpose,policy.authorization_context,
    policy.policy_version,policy.template_id,candidate_source_type,candidate_source_id,
    candidate_source_occurrence,left(btrim(candidate_title),80),left(btrim(candidate_detail),160),
    candidate_occurred_at,
    mbox.wechat_notification_scheduled_at(candidate_occurred_at,policy.quiet_hours_start,
      policy.quiet_hours_end,store.timezone)
  FROM mbox.wechat_member_service_notification_policies policy
  JOIN mbox.stores store ON store.tenant_id=policy.tenant_id AND store.id=policy.store_id
  JOIN mbox.customer_memberships membership
    ON membership.tenant_id=policy.tenant_id AND membership.store_id=policy.store_id
   AND membership.id=candidate_membership_id AND membership.customer_id=candidate_customer_id
   AND membership.status='active'
  JOIN LATERAL (
    SELECT candidate_auth.id,candidate_auth.identity_external_id
    FROM mbox.wechat_member_service_notification_authorizations candidate_auth
    WHERE candidate_auth.tenant_id=policy.tenant_id AND candidate_auth.store_id=policy.store_id
      AND candidate_auth.customer_id=candidate_customer_id AND candidate_auth.membership_id=candidate_membership_id
      AND candidate_auth.policy_id=policy.id AND candidate_auth.decision='granted'
    ORDER BY candidate_auth.authorization_version DESC,candidate_auth.id DESC LIMIT 1
  ) authorization_choice ON true
  WHERE policy.tenant_id=candidate_tenant_id AND policy.store_id=candidate_store_id
    AND policy.notification_type=candidate_type AND policy.status='published'
    AND policy.effective_from<=candidate_occurred_at
    AND (policy.effective_until IS NULL OR policy.effective_until>candidate_occurred_at)
    AND NOT EXISTS (
      SELECT 1 FROM mbox.wechat_member_service_notification_authorization_uses authorization_use
      WHERE authorization_use.tenant_id=policy.tenant_id AND authorization_use.store_id=policy.store_id
        AND authorization_use.authorization_id=authorization_choice.id
    )
  ON CONFLICT (tenant_id,store_id,source_type,source_id,source_occurrence,notification_type) DO NOTHING
  ;
END;
$$;

CREATE FUNCTION mbox.enqueue_wechat_member_service_activity_registration()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE activity_title text;
BEGIN
  IF NEW.status='confirmed' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'confirmed')
    AND NEW.membership_id IS NOT NULL THEN
    SELECT title INTO activity_title FROM mbox.community_activities activity
    WHERE activity.tenant_id=NEW.tenant_id AND activity.store_id=NEW.store_id AND activity.id=NEW.activity_id;
    PERFORM mbox.enqueue_wechat_member_service_notification(
      NEW.tenant_id,NEW.store_id,'activity_registration_confirmed','activity_registration',NEW.id,
      NEW.registration_cycle,NEW.membership_id,NEW.customer_id,'活动报名已确认',
      COALESCE(activity_title,'你已成功报名本次活动'),COALESCE(NEW.updated_at,clock_timestamp())
    );
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wechat_member_service_activity_registration_enqueue
  AFTER INSERT OR UPDATE OF status ON mbox.community_activity_registrations
  FOR EACH ROW EXECUTE FUNCTION mbox.enqueue_wechat_member_service_activity_registration();

CREATE FUNCTION mbox.enqueue_wechat_member_service_benefit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE benefit_title text;
BEGIN
  IF NEW.status IN ('issued','reserved') THEN
    benefit_title:=NULLIF(btrim(COALESCE(NEW.benefit_snapshot->>'title',NEW.benefit_snapshot->>'name','')),'');
    PERFORM mbox.enqueue_wechat_member_service_notification(
      NEW.tenant_id,NEW.store_id,'member_benefit_issued','benefit',NEW.id,1,
      membership.id,NEW.customer_id,'会员优惠券已到账',
      COALESCE(benefit_title,NEW.benefit_code),COALESCE(NEW.created_at,clock_timestamp())
    ) FROM mbox.customer_memberships membership
    WHERE membership.tenant_id=NEW.tenant_id AND membership.store_id=NEW.store_id
      AND membership.customer_id=NEW.customer_id AND membership.status='active';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wechat_member_service_benefit_enqueue
  AFTER INSERT ON mbox.benefits
  FOR EACH ROW EXECUTE FUNCTION mbox.enqueue_wechat_member_service_benefit();

CREATE FUNCTION mbox.enqueue_wechat_member_service_tier()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.from_tier IS DISTINCT FROM NEW.to_tier THEN
    PERFORM mbox.enqueue_wechat_member_service_notification(
      NEW.tenant_id,NEW.store_id,'membership_tier_changed','membership_tier_event',NEW.id,1,
      NEW.membership_id,membership.customer_id,'会员等级已更新',
      CASE WHEN NEW.event_type='downgraded' THEN '当前等级：' ELSE '恭喜升级至：' END ||
        CASE NEW.to_tier WHEN 'gold' THEN '金卡会员' WHEN 'silver' THEN '银卡会员' ELSE '普通会员' END,
      NEW.occurred_at
    ) FROM mbox.customer_memberships membership
    WHERE membership.tenant_id=NEW.tenant_id AND membership.store_id=NEW.store_id
      AND membership.id=NEW.membership_id AND membership.status='active';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wechat_member_service_tier_enqueue
  AFTER INSERT ON mbox.membership_tier_events
  FOR EACH ROW EXECUTE FUNCTION mbox.enqueue_wechat_member_service_tier();

CREATE FUNCTION mbox.protect_wechat_member_service_notification_job()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'WeChat member-service notification jobs cannot be deleted'; END IF;
  IF ROW(
    NEW.tenant_id,NEW.store_id,NEW.customer_id,NEW.membership_id,NEW.identity_external_id,
    NEW.authorization_id,NEW.policy_id,NEW.notification_type,NEW.authorization_purpose,
    NEW.authorization_context,NEW.policy_version,NEW.template_id,NEW.source_type,NEW.source_id,
    NEW.source_occurrence,NEW.title,NEW.detail,NEW.event_occurred_at,NEW.max_attempts,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id,OLD.store_id,OLD.customer_id,OLD.membership_id,OLD.identity_external_id,
    OLD.authorization_id,OLD.policy_id,OLD.notification_type,OLD.authorization_purpose,
    OLD.authorization_context,OLD.policy_version,OLD.template_id,OLD.source_type,OLD.source_id,
    OLD.source_occurrence,OLD.title,OLD.detail,OLD.event_occurred_at,OLD.max_attempts,OLD.created_at
  ) THEN RAISE EXCEPTION 'WeChat member-service notification business facts are immutable'; END IF;
  IF NOT (
    (OLD.status='pending' AND NEW.status IN ('pending','sending','suppressed'))
    OR (OLD.status='sending' AND NEW.status IN ('sent','failed'))
    OR (OLD.status='failed' AND NEW.status IN ('sending','suppressed'))
    OR (OLD.status=NEW.status AND OLD.status IN ('sent','suppressed'))
  ) THEN RAISE EXCEPTION 'Invalid WeChat member-service job transition % -> %',OLD.status,NEW.status; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wechat_member_service_notification_jobs_guard
  BEFORE UPDATE OR DELETE ON mbox.wechat_member_service_notification_jobs
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_wechat_member_service_notification_job();
CREATE TRIGGER wechat_member_service_notification_authorizations_append_only
  BEFORE UPDATE OR DELETE ON mbox.wechat_member_service_notification_authorizations
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER wechat_member_service_notification_authorization_uses_append_only
  BEFORE UPDATE OR DELETE ON mbox.wechat_member_service_notification_authorization_uses
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER wechat_member_service_notification_receipts_append_only
  BEFORE UPDATE OR DELETE ON mbox.wechat_member_service_notification_receipts
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'wechat_member_service_notification_policies',
    'wechat_member_service_notification_authorizations',
    'wechat_member_service_notification_jobs',
    'wechat_member_service_notification_authorization_uses',
    'wechat_member_service_notification_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',table_name
    );
  END LOOP;
END $$;

GRANT SELECT ON TABLE mbox.wechat_member_service_notification_policies TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.wechat_member_service_notification_authorizations TO mbox_runtime;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.wechat_member_service_notification_jobs TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.wechat_member_service_notification_authorization_uses TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.wechat_member_service_notification_receipts TO mbox_runtime;

COMMENT ON TABLE mbox.wechat_member_service_notification_policies IS
  'Executable policies for activity registration, benefit issuance and membership-tier service notices. Marketing broadcasts are deliberately excluded.';
COMMENT ON TABLE mbox.wechat_member_service_notification_authorizations IS
  'Exact append-only customer choices for one-use member-service subscription messages.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='146',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
