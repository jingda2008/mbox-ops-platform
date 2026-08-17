BEGIN;

-- Publication is a separate, accountable action from approval.  A published
-- version may be scheduled for the future; current runtime selection continues
-- to use the earlier published interval until the exact cut-over instant.
ALTER TABLE mbox.loyalty_policy_versions
  ADD COLUMN published_by_employee_id uuid,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN publication_mode text NOT NULL DEFAULT 'separated'
    CHECK (publication_mode IN ('legacy_combined','separated')),
  ADD CONSTRAINT loyalty_policy_versions_publisher_fk
    FOREIGN KEY (tenant_id,store_id,published_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id);
ALTER TABLE mbox.loyalty_tier_policy_versions
  ADD COLUMN published_by_employee_id uuid,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN publication_mode text NOT NULL DEFAULT 'separated'
    CHECK (publication_mode IN ('legacy_combined','separated')),
  ADD CONSTRAINT loyalty_tier_policy_versions_publisher_fk
    FOREIGN KEY (tenant_id,store_id,published_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id);
ALTER TABLE mbox.redemption_catalog_versions
  ADD COLUMN published_by_employee_id uuid,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN publication_mode text NOT NULL DEFAULT 'separated'
    CHECK (publication_mode IN ('legacy_combined','separated')),
  ADD CONSTRAINT redemption_catalog_versions_publisher_fk
    FOREIGN KEY (tenant_id,store_id,published_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id);
ALTER TABLE mbox.loyalty_tier_benefit_policy_versions
  ADD COLUMN published_by_employee_id uuid,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN publication_mode text NOT NULL DEFAULT 'separated'
    CHECK (publication_mode IN ('legacy_combined','separated')),
  ADD CONSTRAINT loyalty_tier_benefit_policy_publisher_fk
    FOREIGN KEY (tenant_id,store_id,published_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id);

-- Existing rows were created by the former combined approve-and-publish
-- command.  Preserve that fact explicitly instead of claiming three-person
-- separation retroactively.
UPDATE mbox.loyalty_policy_versions SET
  published_by_employee_id=approved_by_employee_id,
  published_at=approved_at,
  publication_mode='legacy_combined'
WHERE status IN ('published','paused','retired') AND approved_by_employee_id IS NOT NULL;
UPDATE mbox.loyalty_tier_policy_versions SET
  published_by_employee_id=approved_by_employee_id,
  published_at=approved_at,
  publication_mode='legacy_combined'
WHERE status IN ('published','paused','retired') AND approved_by_employee_id IS NOT NULL;
UPDATE mbox.redemption_catalog_versions SET
  published_by_employee_id=approved_by_employee_id,
  published_at=approved_at,
  publication_mode='legacy_combined'
WHERE status IN ('published','retired') AND approved_by_employee_id IS NOT NULL;
UPDATE mbox.loyalty_tier_benefit_policy_versions SET
  published_by_employee_id=approved_by_employee_id,
  published_at=approved_at,
  publication_mode='legacy_combined'
WHERE status IN ('published','paused','retired') AND approved_by_employee_id IS NOT NULL;

ALTER TABLE mbox.loyalty_policy_versions
  DROP CONSTRAINT loyalty_policy_versions_status_check,
  DROP CONSTRAINT loyalty_policy_versions_check1,
  ADD CONSTRAINT loyalty_policy_versions_status_check
    CHECK (status IN ('draft','approved','published','paused','retired')),
  ADD CONSTRAINT loyalty_policy_versions_release_shape_ck CHECK (
    (status='draft' AND approved_by_employee_id IS NULL AND approved_at IS NULL
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL AND publication_mode='separated')
    OR (status='approved' AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL AND publication_mode='separated')
    OR (status IN ('published','paused','retired') AND effective_from IS NOT NULL
      AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL AND published_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND ((publication_mode='legacy_combined' AND published_by_employee_id=approved_by_employee_id)
        OR (publication_mode='separated' AND published_by_employee_id<>drafted_by_employee_id
          AND published_by_employee_id<>approved_by_employee_id)))
  );
ALTER TABLE mbox.loyalty_tier_policy_versions
  DROP CONSTRAINT loyalty_tier_policy_versions_status_check,
  DROP CONSTRAINT loyalty_tier_policy_versions_check5,
  ADD CONSTRAINT loyalty_tier_policy_versions_status_check
    CHECK (status IN ('draft','approved','published','paused','retired')),
  ADD CONSTRAINT loyalty_tier_policy_versions_release_shape_ck CHECK (
    (status='draft' AND approved_by_employee_id IS NULL AND approved_at IS NULL
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL AND publication_mode='separated')
    OR (status='approved' AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL AND publication_mode='separated')
    OR (status IN ('published','paused','retired') AND effective_from IS NOT NULL
      AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL AND published_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND ((publication_mode='legacy_combined' AND published_by_employee_id=approved_by_employee_id)
        OR (publication_mode='separated' AND published_by_employee_id<>drafted_by_employee_id
          AND published_by_employee_id<>approved_by_employee_id)))
  );
ALTER TABLE mbox.redemption_catalog_versions
  DROP CONSTRAINT redemption_catalog_versions_status_check,
  DROP CONSTRAINT redemption_catalog_versions_check1,
  ADD CONSTRAINT redemption_catalog_versions_status_check
    CHECK (status IN ('draft','approved','published','retired')),
  ADD CONSTRAINT redemption_catalog_versions_release_shape_ck CHECK (
    (status='draft' AND approved_by_employee_id IS NULL AND approved_at IS NULL
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL AND publication_mode='separated')
    OR (status='approved' AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL AND publication_mode='separated')
    OR (status IN ('published','retired') AND effective_from IS NOT NULL
      AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL AND published_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND ((publication_mode='legacy_combined' AND published_by_employee_id=approved_by_employee_id)
        OR (publication_mode='separated' AND published_by_employee_id<>drafted_by_employee_id
          AND published_by_employee_id<>approved_by_employee_id)))
  );
ALTER TABLE mbox.loyalty_tier_benefit_policy_versions
  DROP CONSTRAINT loyalty_tier_benefit_policy_versions_status_check,
  DROP CONSTRAINT loyalty_tier_benefit_policy_versions_check1,
  ADD CONSTRAINT loyalty_tier_benefit_policy_versions_status_check
    CHECK (status IN ('draft','approved','published','paused','retired')),
  ADD CONSTRAINT loyalty_tier_benefit_policy_release_shape_ck CHECK (
    (status='draft' AND approved_by_employee_id IS NULL AND approved_at IS NULL
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL AND publication_mode='separated')
    OR (status='approved' AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND published_by_employee_id IS NULL AND published_at IS NULL
      AND effective_from IS NULL AND effective_until IS NULL AND publication_mode='separated')
    OR (status IN ('published','paused','retired') AND effective_from IS NOT NULL
      AND approved_by_employee_id IS NOT NULL AND approved_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL AND published_at IS NOT NULL
      AND approved_by_employee_id<>drafted_by_employee_id
      AND ((publication_mode='legacy_combined' AND published_by_employee_id=approved_by_employee_id)
        OR (publication_mode='separated' AND published_by_employee_id<>drafted_by_employee_id
          AND published_by_employee_id<>approved_by_employee_id)))
  );

DROP INDEX mbox.loyalty_policy_versions_one_published_uq;
DROP INDEX mbox.loyalty_tier_policy_versions_one_published_uq;
DROP INDEX mbox.redemption_catalog_versions_one_published_uq;
DROP INDEX mbox.loyalty_tier_benefit_policy_one_published_uq;

ALTER TABLE mbox.loyalty_policy_versions ADD CONSTRAINT loyalty_policy_versions_no_published_overlap_excl
  EXCLUDE USING gist (tenant_id WITH =,store_id WITH =,policy_code WITH =,
    tstzrange(effective_from,effective_until,'[)') WITH &&)
  WHERE (status='published') DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mbox.loyalty_tier_policy_versions ADD CONSTRAINT loyalty_tier_policy_versions_no_published_overlap_excl
  EXCLUDE USING gist (tenant_id WITH =,store_id WITH =,
    tstzrange(effective_from,effective_until,'[)') WITH &&)
  WHERE (status='published') DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mbox.redemption_catalog_versions ADD CONSTRAINT redemption_catalog_versions_no_published_overlap_excl
  EXCLUDE USING gist (tenant_id WITH =,store_id WITH =,
    tstzrange(effective_from,effective_until,'[)') WITH &&)
  WHERE (status='published') DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mbox.loyalty_tier_benefit_policy_versions ADD CONSTRAINT loyalty_tier_benefit_policy_no_published_overlap_excl
  EXCLUDE USING gist (tenant_id WITH =,store_id WITH =,tier_policy_version_id WITH =,
    tstzrange(effective_from,effective_until,'[)') WITH &&)
  WHERE (status='published') DEFERRABLE INITIALLY IMMEDIATE;

-- Approval freezes business facts. Publication may only add release evidence.
-- A published interval may only be shortened to the exact start of another
-- published replacement, preventing direct SQL from creating a gap.
CREATE OR REPLACE FUNCTION mbox.reject_published_loyalty_policy_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.publication_mode='legacy_combined' THEN RAISE EXCEPTION 'legacy combined publication mode is migration-only'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' AND OLD.status<>'draft' THEN RAISE EXCEPTION 'released loyalty policy versions are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF OLD.status='draft' AND NEW.status='approved' THEN
    IF ROW(NEW.policy_code,NEW.version,NEW.points_numerator,NEW.points_denominator_minor,
      NEW.growth_numerator,NEW.growth_denominator_minor,NEW.rounding_mode,NEW.points_validity_months,
      NEW.drafted_by_employee_id,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.policy_code,OLD.version,OLD.points_numerator,OLD.points_denominator_minor,
      OLD.growth_numerator,OLD.growth_denominator_minor,OLD.rounding_mode,OLD.points_validity_months,
      OLD.drafted_by_employee_id,OLD.created_at) THEN RAISE EXCEPTION 'approval cannot change loyalty policy facts'; END IF;
  ELSIF OLD.status='approved' AND NEW.status='published' THEN
    IF ROW(NEW.policy_code,NEW.version,NEW.points_numerator,NEW.points_denominator_minor,
      NEW.growth_numerator,NEW.growth_denominator_minor,NEW.rounding_mode,NEW.points_validity_months,
      NEW.drafted_by_employee_id,NEW.approved_by_employee_id,NEW.approved_at,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.policy_code,OLD.version,OLD.points_numerator,OLD.points_denominator_minor,
      OLD.growth_numerator,OLD.growth_denominator_minor,OLD.rounding_mode,OLD.points_validity_months,
      OLD.drafted_by_employee_id,OLD.approved_by_employee_id,OLD.approved_at,OLD.created_at) THEN
      RAISE EXCEPTION 'publication cannot change approved loyalty policy facts';
    END IF;
    IF EXISTS (SELECT 1 FROM mbox.loyalty_policy_versions prior WHERE prior.tenant_id=NEW.tenant_id
      AND prior.store_id=NEW.store_id AND prior.policy_code=NEW.policy_code AND prior.status='published')
      AND NOT EXISTS (SELECT 1 FROM mbox.loyalty_policy_versions prior WHERE prior.tenant_id=NEW.tenant_id
      AND prior.store_id=NEW.store_id AND prior.policy_code=NEW.policy_code AND prior.status='published'
      AND prior.effective_from<NEW.effective_from
      AND (prior.effective_until IS NULL OR prior.effective_until>=NEW.effective_from)) THEN
      RAISE EXCEPTION 'loyalty policy publication would create an effective-time gap';
    END IF;
  ELSIF OLD.status='published' AND NEW.status='published' THEN
    IF ROW(NEW.policy_code,NEW.version,NEW.points_numerator,NEW.points_denominator_minor,
      NEW.growth_numerator,NEW.growth_denominator_minor,NEW.rounding_mode,NEW.points_validity_months,
      NEW.effective_from,NEW.drafted_by_employee_id,NEW.approved_by_employee_id,NEW.approved_at,
      NEW.published_by_employee_id,NEW.published_at,NEW.publication_mode,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.policy_code,OLD.version,OLD.points_numerator,OLD.points_denominator_minor,
      OLD.growth_numerator,OLD.growth_denominator_minor,OLD.rounding_mode,OLD.points_validity_months,
      OLD.effective_from,OLD.drafted_by_employee_id,OLD.approved_by_employee_id,OLD.approved_at,
      OLD.published_by_employee_id,OLD.published_at,OLD.publication_mode,OLD.created_at)
      OR NEW.effective_until IS NULL OR (OLD.effective_until IS NOT NULL AND NEW.effective_until>OLD.effective_until)
      OR NOT EXISTS (SELECT 1 FROM mbox.loyalty_policy_versions replacement
        WHERE replacement.tenant_id=NEW.tenant_id AND replacement.store_id=NEW.store_id
          AND replacement.policy_code=NEW.policy_code AND replacement.status='published'
          AND replacement.id<>NEW.id AND replacement.effective_from=NEW.effective_until) THEN
      RAISE EXCEPTION 'published loyalty policy versions are immutable outside an exact scheduled cut-over';
    END IF;
  ELSIF OLD.status IN ('approved','published','paused','retired') THEN
    IF NOT (OLD.status='published' AND NEW.status IN ('paused','retired')) THEN
      RAISE EXCEPTION 'released loyalty policy versions are immutable';
    END IF;
  ELSIF OLD.status='draft' AND NEW.status<>'draft' THEN
    RAISE EXCEPTION 'invalid loyalty policy release transition';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.reject_published_loyalty_tier_policy_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.publication_mode='legacy_combined' THEN RAISE EXCEPTION 'legacy combined publication mode is migration-only'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' AND OLD.status<>'draft' THEN RAISE EXCEPTION 'released loyalty tier policy versions are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF OLD.status='draft' AND NEW.status='approved' THEN
    IF ROW(NEW.version,NEW.evaluation_window_months,NEW.tier_period_months,NEW.downgrade_grace_days,
      NEW.silver_upgrade_growth,NEW.silver_retain_growth,NEW.gold_upgrade_growth,NEW.gold_retain_growth,
      NEW.silver_points_multiplier_numerator,NEW.silver_points_multiplier_denominator,
      NEW.gold_points_multiplier_numerator,NEW.gold_points_multiplier_denominator,
      NEW.drafted_by_employee_id,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.version,OLD.evaluation_window_months,OLD.tier_period_months,OLD.downgrade_grace_days,
      OLD.silver_upgrade_growth,OLD.silver_retain_growth,OLD.gold_upgrade_growth,OLD.gold_retain_growth,
      OLD.silver_points_multiplier_numerator,OLD.silver_points_multiplier_denominator,
      OLD.gold_points_multiplier_numerator,OLD.gold_points_multiplier_denominator,
      OLD.drafted_by_employee_id,OLD.created_at) THEN RAISE EXCEPTION 'approval cannot change loyalty tier policy facts'; END IF;
  ELSIF OLD.status='approved' AND NEW.status='published' THEN
    IF ROW(NEW.version,NEW.evaluation_window_months,NEW.tier_period_months,NEW.downgrade_grace_days,
      NEW.silver_upgrade_growth,NEW.silver_retain_growth,NEW.gold_upgrade_growth,NEW.gold_retain_growth,
      NEW.silver_points_multiplier_numerator,NEW.silver_points_multiplier_denominator,
      NEW.gold_points_multiplier_numerator,NEW.gold_points_multiplier_denominator,
      NEW.drafted_by_employee_id,NEW.approved_by_employee_id,NEW.approved_at,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.version,OLD.evaluation_window_months,OLD.tier_period_months,OLD.downgrade_grace_days,
      OLD.silver_upgrade_growth,OLD.silver_retain_growth,OLD.gold_upgrade_growth,OLD.gold_retain_growth,
      OLD.silver_points_multiplier_numerator,OLD.silver_points_multiplier_denominator,
      OLD.gold_points_multiplier_numerator,OLD.gold_points_multiplier_denominator,
      OLD.drafted_by_employee_id,OLD.approved_by_employee_id,OLD.approved_at,OLD.created_at) THEN
      RAISE EXCEPTION 'publication cannot change approved loyalty tier policy facts';
    END IF;
    IF EXISTS (SELECT 1 FROM mbox.loyalty_tier_policy_versions prior WHERE prior.tenant_id=NEW.tenant_id
      AND prior.store_id=NEW.store_id AND prior.status='published')
      AND NOT EXISTS (SELECT 1 FROM mbox.loyalty_tier_policy_versions prior WHERE prior.tenant_id=NEW.tenant_id
      AND prior.store_id=NEW.store_id AND prior.status='published' AND prior.effective_from<NEW.effective_from
      AND (prior.effective_until IS NULL OR prior.effective_until>=NEW.effective_from)) THEN
      RAISE EXCEPTION 'loyalty tier policy publication would create an effective-time gap';
    END IF;
  ELSIF OLD.status='published' AND NEW.status='published' THEN
    IF ROW(NEW.version,NEW.evaluation_window_months,NEW.tier_period_months,NEW.downgrade_grace_days,
      NEW.silver_upgrade_growth,NEW.silver_retain_growth,NEW.gold_upgrade_growth,NEW.gold_retain_growth,
      NEW.silver_points_multiplier_numerator,NEW.silver_points_multiplier_denominator,
      NEW.gold_points_multiplier_numerator,NEW.gold_points_multiplier_denominator,NEW.effective_from,
      NEW.drafted_by_employee_id,NEW.approved_by_employee_id,NEW.approved_at,
      NEW.published_by_employee_id,NEW.published_at,NEW.publication_mode,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.version,OLD.evaluation_window_months,OLD.tier_period_months,OLD.downgrade_grace_days,
      OLD.silver_upgrade_growth,OLD.silver_retain_growth,OLD.gold_upgrade_growth,OLD.gold_retain_growth,
      OLD.silver_points_multiplier_numerator,OLD.silver_points_multiplier_denominator,
      OLD.gold_points_multiplier_numerator,OLD.gold_points_multiplier_denominator,OLD.effective_from,
      OLD.drafted_by_employee_id,OLD.approved_by_employee_id,OLD.approved_at,
      OLD.published_by_employee_id,OLD.published_at,OLD.publication_mode,OLD.created_at)
      OR NEW.effective_until IS NULL OR (OLD.effective_until IS NOT NULL AND NEW.effective_until>OLD.effective_until)
      OR NOT EXISTS (SELECT 1 FROM mbox.loyalty_tier_policy_versions replacement
        WHERE replacement.tenant_id=NEW.tenant_id AND replacement.store_id=NEW.store_id
          AND replacement.status='published' AND replacement.id<>NEW.id
          AND replacement.effective_from=NEW.effective_until) THEN
      RAISE EXCEPTION 'published loyalty tier policy versions are immutable outside an exact scheduled cut-over';
    END IF;
  ELSIF OLD.status IN ('approved','published','paused','retired') THEN
    IF NOT (OLD.status='published' AND NEW.status IN ('paused','retired')) THEN
      RAISE EXCEPTION 'released loyalty tier policy versions are immutable';
    END IF;
  ELSIF OLD.status='draft' AND NEW.status<>'draft' THEN RAISE EXCEPTION 'invalid loyalty tier policy release transition';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.reject_published_redemption_catalog_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.publication_mode='legacy_combined' THEN RAISE EXCEPTION 'legacy combined publication mode is migration-only'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' AND OLD.status<>'draft' THEN RAISE EXCEPTION 'released redemption catalog versions are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF OLD.status='draft' AND NEW.status='approved' THEN
    IF ROW(NEW.version,NEW.drafted_by_employee_id,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.version,OLD.drafted_by_employee_id,OLD.created_at) THEN
      RAISE EXCEPTION 'approval cannot change redemption catalog facts'; END IF;
  ELSIF OLD.status='approved' AND NEW.status='published' THEN
    IF ROW(NEW.version,NEW.drafted_by_employee_id,NEW.approved_by_employee_id,NEW.approved_at,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.version,OLD.drafted_by_employee_id,OLD.approved_by_employee_id,OLD.approved_at,OLD.created_at) THEN
      RAISE EXCEPTION 'publication cannot change approved redemption catalog facts'; END IF;
    IF EXISTS (SELECT 1 FROM mbox.redemption_catalog_versions prior WHERE prior.tenant_id=NEW.tenant_id
      AND prior.store_id=NEW.store_id AND prior.status='published')
      AND NOT EXISTS (SELECT 1 FROM mbox.redemption_catalog_versions prior WHERE prior.tenant_id=NEW.tenant_id
      AND prior.store_id=NEW.store_id AND prior.status='published' AND prior.effective_from<NEW.effective_from
      AND (prior.effective_until IS NULL OR prior.effective_until>=NEW.effective_from)) THEN
      RAISE EXCEPTION 'redemption catalog publication would create an effective-time gap';
    END IF;
  ELSIF OLD.status='published' AND NEW.status='published' THEN
    IF ROW(NEW.version,NEW.effective_from,NEW.drafted_by_employee_id,NEW.approved_by_employee_id,NEW.approved_at,
      NEW.published_by_employee_id,NEW.published_at,NEW.publication_mode,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.version,OLD.effective_from,OLD.drafted_by_employee_id,OLD.approved_by_employee_id,OLD.approved_at,
      OLD.published_by_employee_id,OLD.published_at,OLD.publication_mode,OLD.created_at)
      OR NEW.effective_until IS NULL OR (OLD.effective_until IS NOT NULL AND NEW.effective_until>OLD.effective_until)
      OR NOT EXISTS (SELECT 1 FROM mbox.redemption_catalog_versions replacement
        WHERE replacement.tenant_id=NEW.tenant_id AND replacement.store_id=NEW.store_id
          AND replacement.status='published' AND replacement.id<>NEW.id
          AND replacement.effective_from=NEW.effective_until) THEN
      RAISE EXCEPTION 'published redemption catalog versions are immutable outside an exact scheduled cut-over';
    END IF;
  ELSIF OLD.status IN ('approved','published','retired') THEN
    IF NOT (OLD.status='published' AND NEW.status='retired') THEN RAISE EXCEPTION 'released redemption catalog versions are immutable'; END IF;
  ELSIF OLD.status='draft' AND NEW.status<>'draft' THEN RAISE EXCEPTION 'invalid redemption catalog release transition';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.protect_loyalty_tier_benefit_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tier_policy_status text;
DECLARE active_rule_count integer;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.publication_mode='legacy_combined' THEN RAISE EXCEPTION 'legacy combined publication mode is migration-only'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' AND OLD.status<>'draft' THEN RAISE EXCEPTION 'released tier benefit policy versions are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF OLD.status='draft' AND NEW.status='approved' THEN
    IF ROW(NEW.tier_policy_version_id,NEW.version,NEW.drafted_by_employee_id,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.tier_policy_version_id,OLD.version,OLD.drafted_by_employee_id,OLD.created_at) THEN
      RAISE EXCEPTION 'approval cannot change tier benefit policy facts'; END IF;
  ELSIF OLD.status='approved' AND NEW.status='published' THEN
    IF ROW(NEW.tier_policy_version_id,NEW.version,NEW.drafted_by_employee_id,
      NEW.approved_by_employee_id,NEW.approved_at,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.tier_policy_version_id,OLD.version,OLD.drafted_by_employee_id,
      OLD.approved_by_employee_id,OLD.approved_at,OLD.created_at) THEN
      RAISE EXCEPTION 'publication cannot change approved tier benefit policy facts'; END IF;
    SELECT status INTO tier_policy_status FROM mbox.loyalty_tier_policy_versions
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.tier_policy_version_id;
    IF tier_policy_status IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'tier benefit policy requires a published tier policy version'; END IF;
    SELECT count(*)::integer INTO active_rule_count FROM mbox.loyalty_tier_benefit_rules
      WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND policy_version_id=NEW.id AND enabled;
    IF active_rule_count<1 THEN RAISE EXCEPTION 'published tier benefit policy requires active typed benefit rules'; END IF;
    IF EXISTS (SELECT 1 FROM mbox.loyalty_tier_benefit_policy_versions prior
      WHERE prior.tenant_id=NEW.tenant_id AND prior.store_id=NEW.store_id
        AND prior.tier_policy_version_id=NEW.tier_policy_version_id AND prior.status='published')
      AND NOT EXISTS (SELECT 1 FROM mbox.loyalty_tier_benefit_policy_versions prior
      WHERE prior.tenant_id=NEW.tenant_id AND prior.store_id=NEW.store_id
        AND prior.tier_policy_version_id=NEW.tier_policy_version_id AND prior.status='published'
        AND prior.effective_from<NEW.effective_from
        AND (prior.effective_until IS NULL OR prior.effective_until>=NEW.effective_from)) THEN
      RAISE EXCEPTION 'tier benefit policy publication would create an effective-time gap';
    END IF;
  ELSIF OLD.status='published' AND NEW.status='published' THEN
    IF ROW(NEW.tier_policy_version_id,NEW.version,NEW.effective_from,NEW.drafted_by_employee_id,
      NEW.approved_by_employee_id,NEW.approved_at,NEW.published_by_employee_id,NEW.published_at,
      NEW.publication_mode,NEW.created_at) IS DISTINCT FROM
      ROW(OLD.tier_policy_version_id,OLD.version,OLD.effective_from,OLD.drafted_by_employee_id,
      OLD.approved_by_employee_id,OLD.approved_at,OLD.published_by_employee_id,OLD.published_at,
      OLD.publication_mode,OLD.created_at)
      OR NEW.effective_until IS NULL OR (OLD.effective_until IS NOT NULL AND NEW.effective_until>OLD.effective_until)
      OR NOT EXISTS (SELECT 1 FROM mbox.loyalty_tier_benefit_policy_versions replacement
        WHERE replacement.tenant_id=NEW.tenant_id AND replacement.store_id=NEW.store_id
          AND replacement.tier_policy_version_id=NEW.tier_policy_version_id
          AND replacement.status='published' AND replacement.id<>NEW.id
          AND replacement.effective_from=NEW.effective_until) THEN
      RAISE EXCEPTION 'published tier benefit policy versions are immutable outside an exact scheduled cut-over';
    END IF;
  ELSIF OLD.status IN ('approved','published','paused','retired') THEN
    IF NOT (OLD.status='published' AND NEW.status IN ('paused','retired')) THEN RAISE EXCEPTION 'released tier benefit policy versions are immutable'; END IF;
  ELSIF OLD.status='draft' AND NEW.status<>'draft' THEN RAISE EXCEPTION 'invalid tier benefit policy release transition';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER loyalty_policy_versions_immutable ON mbox.loyalty_policy_versions;
CREATE TRIGGER loyalty_policy_versions_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_published_loyalty_policy_change();
DROP TRIGGER loyalty_tier_policy_versions_immutable ON mbox.loyalty_tier_policy_versions;
CREATE TRIGGER loyalty_tier_policy_versions_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_tier_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_published_loyalty_tier_policy_change();
DROP TRIGGER redemption_catalog_versions_immutable ON mbox.redemption_catalog_versions;
CREATE TRIGGER redemption_catalog_versions_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.redemption_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_published_redemption_catalog_change();

CREATE OR REPLACE FUNCTION mbox.seed_store_loyalty_release_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description,status)
  VALUES
    (NEW.tenant_id,NEW.id,'loyalty.policy.publish','正式发布会员规则','loyalty','最高授权人员发布已独立审批的会员与等级规则','active'),
    (NEW.tenant_id,NEW.id,'loyalty.redemption.catalog.publish','正式发布积分兑换目录','loyalty','最高授权人员发布已独立审批且复验通过的兑换目录','active')
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;
CREATE TRIGGER stores_seed_loyalty_release_permissions AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_loyalty_release_permissions();

INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description,status)
SELECT store.tenant_id,store.id,permission.code,permission.name,'loyalty',permission.description,'active'
FROM mbox.stores store CROSS JOIN (VALUES
  ('loyalty.policy.publish','正式发布会员规则','最高授权人员发布已独立审批的会员与等级规则'),
  ('loyalty.redemption.catalog.publish','正式发布积分兑换目录','最高授权人员发布已独立审批且复验通过的兑换目录')
) permission(code,name,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

COMMENT ON COLUMN mbox.loyalty_policy_versions.publication_mode IS
  'legacy_combined preserves historical combined approvals; separated requires an independent publisher.';
COMMENT ON CONSTRAINT loyalty_policy_versions_no_published_overlap_excl ON mbox.loyalty_policy_versions IS
  'Published versions may be scheduled, but their effective intervals must never overlap.';

COMMIT;
