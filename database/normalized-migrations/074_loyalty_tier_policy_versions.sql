BEGIN;

CREATE TABLE mbox.loyalty_tier_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused', 'retired')),
  evaluation_window_months smallint NOT NULL CHECK (evaluation_window_months BETWEEN 1 AND 36),
  tier_period_months smallint NOT NULL CHECK (tier_period_months BETWEEN 1 AND 36),
  downgrade_grace_days smallint NOT NULL CHECK (downgrade_grace_days BETWEEN 0 AND 180),
  silver_upgrade_growth integer NOT NULL CHECK (silver_upgrade_growth > 0),
  silver_retain_growth integer NOT NULL CHECK (silver_retain_growth >= 0),
  gold_upgrade_growth integer NOT NULL CHECK (gold_upgrade_growth > silver_upgrade_growth),
  gold_retain_growth integer NOT NULL CHECK (gold_retain_growth >= silver_retain_growth),
  silver_points_multiplier_numerator integer NOT NULL CHECK (silver_points_multiplier_numerator > 0),
  silver_points_multiplier_denominator integer NOT NULL CHECK (silver_points_multiplier_denominator > 0),
  gold_points_multiplier_numerator integer NOT NULL CHECK (gold_points_multiplier_numerator > 0),
  gold_points_multiplier_denominator integer NOT NULL CHECK (gold_points_multiplier_denominator > 0),
  effective_from timestamptz,
  effective_until timestamptz,
  drafted_by_employee_id uuid NOT NULL,
  approved_by_employee_id uuid,
  approved_at timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, version),
  UNIQUE (tenant_id, store_id, id),
  CHECK (silver_retain_growth <= silver_upgrade_growth),
  CHECK (gold_retain_growth <= gold_upgrade_growth),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from),
  CHECK (
    (status='published' AND approved_by_employee_id IS NOT NULL
      AND approved_at IS NOT NULL AND approved_by_employee_id<>drafted_by_employee_id
      AND effective_from IS NOT NULL)
    OR status<>'published'
  )
);

CREATE UNIQUE INDEX loyalty_tier_policy_versions_one_published_uq
  ON mbox.loyalty_tier_policy_versions (tenant_id, store_id)
  WHERE status='published';

CREATE TABLE mbox.membership_tier_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  tier text NOT NULL CHECK (tier IN ('member', 'silver', 'gold')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  grace_ends_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'grace', 'completed', 'reversed')),
  qualification_growth integer NOT NULL CHECK (qualification_growth >= 0),
  review_growth integer,
  review_result text CHECK (review_result IN ('retained', 'downgraded', 'upgraded', 'not_due')),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, policy_version_id)
    REFERENCES mbox.loyalty_tier_policy_versions(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (grace_ends_at IS NULL OR (ends_at IS NOT NULL AND grace_ends_at >= ends_at))
);

CREATE UNIQUE INDEX membership_tier_periods_active_uq
  ON mbox.membership_tier_periods (tenant_id, store_id, membership_id)
  WHERE status IN ('active', 'grace');

CREATE TABLE mbox.membership_tier_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('upgraded', 'retained', 'grace_started', 'downgraded', 'corrected')),
  from_tier text NOT NULL CHECK (from_tier IN ('member', 'silver', 'gold')),
  to_tier text NOT NULL CHECK (to_tier IN ('member', 'silver', 'gold')),
  evaluated_growth integer NOT NULL CHECK (evaluated_growth >= 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  source_type text NOT NULL CHECK (source_type IN ('automatic_growth', 'period_review', 'approved_correction')),
  source_id text NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 128),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, policy_version_id)
    REFERENCES mbox.loyalty_tier_policy_versions(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, membership_id, source_type, source_id, event_type),
  UNIQUE (tenant_id, store_id, id)
);

ALTER TABLE mbox.orders
  ADD COLUMN loyalty_tier_policy_version_id uuid,
  ADD COLUMN loyalty_tier_at_submission text NOT NULL DEFAULT 'member'
    CHECK (loyalty_tier_at_submission IN ('member', 'silver', 'gold')),
  ADD COLUMN loyalty_points_multiplier_numerator integer NOT NULL DEFAULT 1
    CHECK (loyalty_points_multiplier_numerator > 0),
  ADD COLUMN loyalty_points_multiplier_denominator integer NOT NULL DEFAULT 1
    CHECK (loyalty_points_multiplier_denominator > 0),
  ADD CONSTRAINT orders_loyalty_tier_policy_version_fk
    FOREIGN KEY (tenant_id, store_id, loyalty_tier_policy_version_id)
    REFERENCES mbox.loyalty_tier_policy_versions(tenant_id, store_id, id);

CREATE OR REPLACE FUNCTION mbox.lock_order_loyalty_policy_version()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tier_row record;
BEGIN
  IF NEW.loyalty_policy_version_id IS NULL THEN
    SELECT policy.id INTO NEW.loyalty_policy_version_id
    FROM mbox.loyalty_policy_versions policy
    WHERE policy.tenant_id=NEW.tenant_id AND policy.store_id=NEW.store_id
      AND policy.policy_code='BASE' AND policy.status='published'
      AND policy.effective_from<=clock_timestamp()
      AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
    ORDER BY policy.version DESC, policy.id DESC LIMIT 1;
  END IF;
  IF NEW.created_by_customer_id IS NOT NULL THEN
    SELECT account.current_tier, policy.id,
      CASE account.current_tier
        WHEN 'silver' THEN policy.silver_points_multiplier_numerator
        WHEN 'gold' THEN policy.gold_points_multiplier_numerator ELSE 1 END AS numerator,
      CASE account.current_tier
        WHEN 'silver' THEN policy.silver_points_multiplier_denominator
        WHEN 'gold' THEN policy.gold_points_multiplier_denominator ELSE 1 END AS denominator
    INTO tier_row
    FROM mbox.loyalty_accounts account
    JOIN mbox.loyalty_tier_policy_versions policy
      ON policy.tenant_id=account.tenant_id AND policy.store_id=account.store_id
     AND policy.status='published' AND policy.effective_from<=clock_timestamp()
     AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
    WHERE account.tenant_id=NEW.tenant_id AND account.store_id=NEW.store_id
      AND account.customer_id=NEW.created_by_customer_id
    ORDER BY policy.version DESC, policy.id DESC LIMIT 1;
    IF tier_row.id IS NOT NULL THEN
      NEW.loyalty_tier_policy_version_id := tier_row.id;
      NEW.loyalty_tier_at_submission := tier_row.current_tier;
      NEW.loyalty_points_multiplier_numerator := tier_row.numerator;
      NEW.loyalty_points_multiplier_denominator := tier_row.denominator;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mbox.reject_published_loyalty_tier_policy_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD.status='published' THEN
    RAISE EXCEPTION 'published loyalty tier policy versions are immutable';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='published' THEN
    IF NEW.status NOT IN ('paused','retired')
      OR ROW(NEW.version,NEW.evaluation_window_months,NEW.tier_period_months,
        NEW.downgrade_grace_days,NEW.silver_upgrade_growth,NEW.silver_retain_growth,
        NEW.gold_upgrade_growth,NEW.gold_retain_growth,
        NEW.silver_points_multiplier_numerator,NEW.silver_points_multiplier_denominator,
        NEW.gold_points_multiplier_numerator,NEW.gold_points_multiplier_denominator,
        NEW.effective_from,NEW.drafted_by_employee_id,NEW.approved_by_employee_id,NEW.approved_at)
       IS DISTINCT FROM
       ROW(OLD.version,OLD.evaluation_window_months,OLD.tier_period_months,
        OLD.downgrade_grace_days,OLD.silver_upgrade_growth,OLD.silver_retain_growth,
        OLD.gold_upgrade_growth,OLD.gold_retain_growth,
        OLD.silver_points_multiplier_numerator,OLD.silver_points_multiplier_denominator,
        OLD.gold_points_multiplier_numerator,OLD.gold_points_multiplier_denominator,
        OLD.effective_from,OLD.drafted_by_employee_id,OLD.approved_by_employee_id,OLD.approved_at) THEN
      RAISE EXCEPTION 'published loyalty tier policy versions are immutable';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER loyalty_tier_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON mbox.loyalty_tier_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_published_loyalty_tier_policy_change();
CREATE TRIGGER loyalty_tier_policy_versions_touch_updated_at
  BEFORE UPDATE ON mbox.loyalty_tier_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER membership_tier_periods_touch_updated_at
  BEFORE UPDATE ON mbox.membership_tier_periods
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER membership_tier_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.membership_tier_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'loyalty_tier_policy_versions','membership_tier_periods','membership_tier_events'
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
REVOKE DELETE ON TABLE mbox.loyalty_tier_policy_versions, mbox.membership_tier_periods FROM mbox_runtime;
REVOKE UPDATE, DELETE ON TABLE mbox.membership_tier_events FROM mbox_runtime;

COMMENT ON TABLE mbox.loyalty_tier_policy_versions IS
  'Maker-checker tier thresholds, retention windows, grace periods and point multipliers. Suggested thresholds must not be published without historical distribution validation.';

COMMIT;
