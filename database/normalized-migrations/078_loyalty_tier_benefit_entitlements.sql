BEGIN;

-- Tier benefits are a published operating policy. Display JSON remains on the
-- benefit definition, but eligibility, cadence, validity and downgrade
-- handling are all strongly typed here.
ALTER TABLE mbox.membership_tier_events
  ADD CONSTRAINT membership_tier_events_transition_semantics_ck CHECK (
    (event_type='upgraded' AND
      CASE to_tier WHEN 'member' THEN 0 WHEN 'silver' THEN 1 ELSE 2 END >
      CASE from_tier WHEN 'member' THEN 0 WHEN 'silver' THEN 1 ELSE 2 END)
    OR (event_type='downgraded' AND
      CASE to_tier WHEN 'member' THEN 0 WHEN 'silver' THEN 1 ELSE 2 END <
      CASE from_tier WHEN 'member' THEN 0 WHEN 'silver' THEN 1 ELSE 2 END)
    OR (event_type IN ('retained','grace_started') AND to_tier=from_tier)
    OR event_type='corrected'
  ) NOT VALID;
ALTER TABLE mbox.membership_tier_events
  VALIDATE CONSTRAINT membership_tier_events_transition_semantics_ck;

CREATE TABLE mbox.loyalty_tier_benefit_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  tier_policy_version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','published','paused','retired')),
  effective_from timestamptz,
  effective_until timestamptz,
  drafted_by_employee_id uuid NOT NULL,
  approved_by_employee_id uuid,
  approved_at timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, tier_policy_version_id)
    REFERENCES mbox.loyalty_tier_policy_versions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, tier_policy_version_id, version),
  UNIQUE (tenant_id, store_id, id),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from),
  CHECK (
    (status='published' AND effective_from IS NOT NULL
      AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id)
    OR status<>'published'
  )
);

CREATE UNIQUE INDEX loyalty_tier_benefit_policy_one_published_uq
  ON mbox.loyalty_tier_benefit_policy_versions
    (tenant_id, store_id, tier_policy_version_id)
  WHERE status='published';

CREATE TABLE mbox.loyalty_tier_benefit_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  rule_code text NOT NULL CHECK (rule_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  eligible_tier text NOT NULL CHECK (eligible_tier IN ('member','silver','gold')),
  inherit_to_higher_tiers boolean NOT NULL DEFAULT false,
  grant_on_entry boolean NOT NULL DEFAULT true,
  grant_on_retention boolean NOT NULL DEFAULT false,
  benefit_definition_id uuid NOT NULL,
  quantity smallint NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  validity_days smallint NOT NULL CHECK (validity_days BETWEEN 1 AND 366),
  revocation_policy text NOT NULL DEFAULT 'revoke_unreserved'
    CHECK (revocation_policy IN ('revoke_unreserved','protect_until_expiry')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id, policy_version_id)
    REFERENCES mbox.loyalty_tier_benefit_policy_versions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_definition_id)
    REFERENCES mbox.loyalty_benefit_definitions(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, policy_version_id, rule_code),
  UNIQUE (tenant_id, store_id, id),
  CHECK (grant_on_entry OR grant_on_retention)
);

CREATE TABLE mbox.membership_tier_benefit_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  tier_event_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  benefit_id uuid NOT NULL,
  granted_tier text NOT NULL CHECK (granted_tier IN ('member','silver','gold')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','revocation_pending','revoked','fulfilled','expired')),
  granted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  resolution_reason text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, tier_event_id)
    REFERENCES mbox.membership_tier_events(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, policy_version_id)
    REFERENCES mbox.loyalty_tier_benefit_policy_versions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, rule_id)
    REFERENCES mbox.loyalty_tier_benefit_rules(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_id)
    REFERENCES mbox.benefits(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, membership_id, tier_event_id, rule_id),
  UNIQUE (tenant_id, store_id, benefit_id),
  UNIQUE (tenant_id, store_id, id),
  CHECK (expires_at > granted_at),
  CHECK (
    (status='active' AND resolution_reason IS NULL AND resolved_at IS NULL)
    OR (status='revocation_pending' AND length(btrim(resolution_reason)) BETWEEN 2 AND 500
      AND resolved_at IS NULL)
    OR (status IN ('revoked','fulfilled','expired')
      AND length(btrim(resolution_reason)) BETWEEN 2 AND 500 AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX membership_tier_benefit_grants_active_idx
  ON mbox.membership_tier_benefit_grants
    (tenant_id, store_id, membership_id, expires_at, id)
  WHERE status IN ('active','revocation_pending');

CREATE TABLE mbox.membership_tier_benefit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  tier_event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'granted','revocation_pending','revocation_cancelled','revoked','fulfilled','expired'
  )),
  from_status text,
  to_status text NOT NULL CHECK (to_status IN (
    'active','revocation_pending','revoked','fulfilled','expired'
  )),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id, grant_id)
    REFERENCES mbox.membership_tier_benefit_grants(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, tier_event_id)
    REFERENCES mbox.membership_tier_events(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, grant_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id),
  CHECK (from_status IS NULL OR from_status IN (
    'active','revocation_pending','revoked','fulfilled','expired'
  ))
);

CREATE OR REPLACE FUNCTION mbox.protect_loyalty_tier_benefit_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE enabled_rules integer;
DECLARE invalid_definitions integer;
DECLARE tier_policy_status text;
BEGIN
  IF TG_OP='INSERT' AND NEW.status='published' THEN
    RAISE EXCEPTION 'tier benefit policy must be drafted before publication';
  END IF;
  IF TG_OP='DELETE' AND OLD.status<>'draft' THEN
    RAISE EXCEPTION 'published tier benefit policy versions are immutable';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status<>'draft' THEN
    IF NEW.status NOT IN ('paused','retired')
      OR ROW(NEW.id,NEW.tenant_id,NEW.store_id,NEW.tier_policy_version_id,NEW.version,
        NEW.effective_from,NEW.drafted_by_employee_id,NEW.approved_by_employee_id,
        NEW.approved_at,NEW.reason,NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id,OLD.tenant_id,OLD.store_id,OLD.tier_policy_version_id,OLD.version,
        OLD.effective_from,OLD.drafted_by_employee_id,OLD.approved_by_employee_id,
        OLD.approved_at,OLD.reason,OLD.created_at) THEN
      RAISE EXCEPTION 'published tier benefit policy versions are immutable';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND NEW.status='published' AND OLD.status<>'published' THEN
    SELECT status INTO tier_policy_status
    FROM mbox.loyalty_tier_policy_versions
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
      AND id=NEW.tier_policy_version_id;
    IF tier_policy_status IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'tier benefit policy requires a published tier policy version';
    END IF;
    SELECT count(*), count(*) FILTER (WHERE definition.status<>'active')
    INTO enabled_rules, invalid_definitions
    FROM mbox.loyalty_tier_benefit_rules rule
    JOIN mbox.loyalty_benefit_definitions definition
      ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id
     AND definition.id=rule.benefit_definition_id
    WHERE rule.tenant_id=NEW.tenant_id AND rule.store_id=NEW.store_id
      AND rule.policy_version_id=NEW.id AND rule.enabled;
    IF enabled_rules=0 OR invalid_definitions>0 THEN
      RAISE EXCEPTION 'published tier benefit policy requires active typed benefit rules';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION mbox.protect_loyalty_tier_benefit_rule()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  SELECT status INTO parent_status
  FROM mbox.loyalty_tier_benefit_policy_versions
  WHERE tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id)
    AND store_id=COALESCE(NEW.store_id,OLD.store_id)
    AND id=COALESCE(NEW.policy_version_id,OLD.policy_version_id);
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'tier benefit rules are mutable only while their version is draft';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION mbox.protect_published_tier_benefit_definition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mbox.loyalty_tier_benefit_rules rule
    JOIN mbox.loyalty_tier_benefit_policy_versions policy
      ON policy.tenant_id=rule.tenant_id AND policy.store_id=rule.store_id
     AND policy.id=rule.policy_version_id
    WHERE rule.tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id)
      AND rule.store_id=COALESCE(NEW.store_id,OLD.store_id)
      AND rule.benefit_definition_id=COALESCE(NEW.id,OLD.id)
      AND policy.status IN ('published','paused','retired')
  ) THEN
    RAISE EXCEPTION 'benefit definitions referenced by published tier policies are immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION mbox.protect_membership_tier_benefit_grant()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matching_facts integer;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT count(*) INTO matching_facts
    FROM mbox.membership_tier_events tier_event
    JOIN mbox.loyalty_tier_benefit_policy_versions policy
      ON policy.tenant_id=tier_event.tenant_id AND policy.store_id=tier_event.store_id
     AND policy.id=NEW.policy_version_id
     AND policy.tier_policy_version_id=tier_event.policy_version_id
     AND policy.status='published' AND policy.approved_at<=tier_event.occurred_at
     AND policy.effective_from<=tier_event.occurred_at
     AND (policy.effective_until IS NULL OR policy.effective_until>tier_event.occurred_at)
    JOIN mbox.loyalty_tier_benefit_rules rule
      ON rule.tenant_id=policy.tenant_id AND rule.store_id=policy.store_id
     AND rule.id=NEW.rule_id AND rule.policy_version_id=policy.id
     AND rule.enabled
     AND (
       (tier_event.event_type='retained' AND rule.grant_on_retention)
       OR (tier_event.event_type IN ('upgraded','downgraded','corrected')
         AND tier_event.from_tier<>tier_event.to_tier AND rule.grant_on_entry)
     )
     AND (
       rule.eligible_tier=tier_event.to_tier
       OR (rule.inherit_to_higher_tiers AND
         CASE rule.eligible_tier WHEN 'member' THEN 0 WHEN 'silver' THEN 1 ELSE 2 END <
         CASE tier_event.to_tier WHEN 'member' THEN 0 WHEN 'silver' THEN 1 ELSE 2 END)
     )
    JOIN mbox.benefits benefit
      ON benefit.tenant_id=tier_event.tenant_id AND benefit.store_id=tier_event.store_id
     AND benefit.id=NEW.benefit_id AND benefit.customer_id=NEW.customer_id
     AND benefit.benefit_definition_id=rule.benefit_definition_id
     AND benefit.valid_from=NEW.granted_at AND benefit.valid_until=NEW.expires_at
    WHERE tier_event.tenant_id=NEW.tenant_id AND tier_event.store_id=NEW.store_id
      AND tier_event.id=NEW.tier_event_id AND tier_event.membership_id=NEW.membership_id
      AND tier_event.to_tier=NEW.granted_tier;
    IF matching_facts<>1 THEN
      RAISE EXCEPTION 'tier benefit grant facts do not match the tier event, rule and benefit';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.store_id,NEW.membership_id,NEW.customer_id,
      NEW.tier_event_id,NEW.policy_version_id,NEW.rule_id,NEW.benefit_id,
      NEW.granted_tier,NEW.granted_at,NEW.expires_at,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.tenant_id,OLD.store_id,OLD.membership_id,OLD.customer_id,
      OLD.tier_event_id,OLD.policy_version_id,OLD.rule_id,OLD.benefit_id,
      OLD.granted_tier,OLD.granted_at,OLD.expires_at,OLD.created_at) THEN
    RAISE EXCEPTION 'tier benefit grant facts are immutable';
  END IF;
  IF OLD.status IN ('revoked','fulfilled','expired') THEN
    RAISE EXCEPTION 'resolved tier benefit grants are immutable';
  END IF;
  IF (OLD.status='active' AND NEW.status NOT IN ('active','revocation_pending','revoked','fulfilled','expired'))
    OR (OLD.status='revocation_pending' AND NEW.status NOT IN ('active','revocation_pending','revoked','fulfilled','expired')) THEN
    RAISE EXCEPTION 'invalid tier benefit grant transition';
  END IF;
  RETURN NEW;
END $$;

-- A downgrade never breaks an already reserved entitlement. Once that
-- reservation is released or completed, the pending revocation is resolved.
CREATE OR REPLACE FUNCTION mbox.apply_pending_tier_benefit_resolution()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantity_reserved=0 AND EXISTS (
    SELECT 1 FROM mbox.membership_tier_benefit_grants grant_row
    WHERE grant_row.tenant_id=NEW.tenant_id AND grant_row.store_id=NEW.store_id
      AND grant_row.benefit_id=NEW.id AND grant_row.status='revocation_pending'
  ) AND NEW.status IN ('issued','redeemed') THEN
    IF NEW.quantity_redeemed < NEW.quantity_total THEN NEW.status := 'revoked'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.sync_tier_benefit_grant_resolution()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_status text;
DECLARE target_event text;
DECLARE target_reason text;
DECLARE grant_row record;
BEGIN
  IF NEW.status NOT IN ('revoked','redeemed','expired') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  target_status := CASE
    WHEN NEW.status='redeemed' OR (NEW.status='revoked' AND NEW.quantity_redeemed>0)
      THEN 'fulfilled'
    ELSE NEW.status END;
  target_event := CASE
    WHEN NEW.status='redeemed' OR (NEW.status='revoked' AND NEW.quantity_redeemed>0)
      THEN 'fulfilled'
    ELSE NEW.status END;
  target_reason := CASE NEW.status
    WHEN 'redeemed' THEN '等级权益已履约，不因后续等级变化删除'
    WHEN 'expired' THEN '等级权益已到有效期'
    ELSE CASE WHEN NEW.quantity_redeemed>0
      THEN '已履约数量保留事实，仅撤销剩余未预留数量'
      ELSE '按已发布等级权益规则撤销未预留权益' END END;
  FOR grant_row IN
    WITH prior AS (
      SELECT id,tier_event_id,status AS from_status
      FROM mbox.membership_tier_benefit_grants
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND benefit_id=NEW.id
        AND status IN ('active','revocation_pending')
      FOR UPDATE
    ), changed AS (
      UPDATE mbox.membership_tier_benefit_grants grant_target
      SET status=target_status,resolution_reason=target_reason,
        resolved_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM prior
      WHERE grant_target.tenant_id=NEW.tenant_id AND grant_target.store_id=NEW.store_id
        AND grant_target.id=prior.id
      RETURNING grant_target.id,grant_target.tier_event_id,prior.from_status
    ) SELECT * FROM changed
  LOOP
    INSERT INTO mbox.membership_tier_benefit_events(
      tenant_id,store_id,grant_id,tier_event_id,event_type,from_status,to_status,
      reason,idempotency_key,occurred_at
    ) VALUES (
      NEW.tenant_id,NEW.store_id,grant_row.id,grant_row.tier_event_id,target_event,
      grant_row.from_status,target_status,target_reason,
      'benefit-resolution:'||NEW.id::text||':'||target_status,clock_timestamp()
    ) ON CONFLICT (tenant_id,store_id,grant_id,idempotency_key) DO NOTHING;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER loyalty_tier_benefit_policy_protect
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_tier_benefit_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_loyalty_tier_benefit_policy();
CREATE TRIGGER loyalty_tier_benefit_policy_touch
  BEFORE UPDATE ON mbox.loyalty_tier_benefit_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER loyalty_tier_benefit_rules_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_tier_benefit_rules
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_loyalty_tier_benefit_rule();
CREATE TRIGGER loyalty_tier_benefit_rules_touch
  BEFORE UPDATE ON mbox.loyalty_tier_benefit_rules
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER loyalty_tier_benefit_definition_protect
  BEFORE UPDATE OR DELETE ON mbox.loyalty_benefit_definitions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_published_tier_benefit_definition();
CREATE TRIGGER membership_tier_benefit_grants_protect
  BEFORE INSERT OR UPDATE ON mbox.membership_tier_benefit_grants
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_membership_tier_benefit_grant();
CREATE TRIGGER membership_tier_benefit_grants_touch
  BEFORE UPDATE ON mbox.membership_tier_benefit_grants
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER benefits_pending_tier_resolution
  BEFORE UPDATE OF status,quantity_reserved,quantity_redeemed ON mbox.benefits
  FOR EACH ROW EXECUTE FUNCTION mbox.apply_pending_tier_benefit_resolution();
CREATE TRIGGER benefits_sync_tier_grant_resolution
  AFTER UPDATE OF status ON mbox.benefits
  FOR EACH ROW EXECUTE FUNCTION mbox.sync_tier_benefit_grant_resolution();
CREATE TRIGGER membership_tier_benefit_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.membership_tier_benefit_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'loyalty_tier_benefit_policy_versions','loyalty_tier_benefit_rules',
    'membership_tier_benefit_grants','membership_tier_benefit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE mbox.%I TO mbox_runtime', table_name);
  END LOOP;
END $$;
REVOKE DELETE ON TABLE mbox.loyalty_tier_benefit_policy_versions,
  mbox.loyalty_tier_benefit_rules,mbox.membership_tier_benefit_grants FROM mbox_runtime;
REVOKE UPDATE,DELETE ON TABLE mbox.membership_tier_benefit_events FROM mbox_runtime;

COMMENT ON TABLE mbox.loyalty_tier_benefit_policy_versions IS
  'Maker-checker versions that attach configurable automatic benefits to a published loyalty tier policy.';
COMMENT ON TABLE mbox.membership_tier_benefit_grants IS
  'Strong link from a tier event and typed rule to the issued customer benefit; display JSON is never eligibility authority.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='078',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
