BEGIN;

-- Execution facts required by the published annual-benefit policy. These are
-- stored on the immutable rule/grant instead of being inferred from UI labels
-- when fulfillment happens.
ALTER TABLE mbox.loyalty_annual_benefit_rules
  ADD COLUMN stack_group text,
  ADD COLUMN priority smallint,
  ADD COLUMN inventory_requirement text,
  ADD COLUMN revocation_policy text,
  ADD COLUMN feb29_policy text;

UPDATE mbox.loyalty_annual_benefit_rules
SET stack_group=CASE WHEN rule_kind IN ('birthday','festival') THEN 'festival_gift' ELSE lower(rule_code) END,
    priority=CASE rule_kind WHEN 'birthday' THEN 10 WHEN 'festival' THEN 20 ELSE 100 END,
    inventory_requirement=CASE WHEN rule_kind='priority_seating' THEN 'not_applicable' ELSE 'strict_recipe' END,
    revocation_policy='cancel_before_redeem',
    feb29_policy=CASE WHEN rule_kind='birthday' THEN 'feb28' ELSE NULL END;

ALTER TABLE mbox.loyalty_annual_benefit_rules
  ALTER COLUMN stack_group SET NOT NULL,
  ALTER COLUMN priority SET NOT NULL,
  ALTER COLUMN inventory_requirement SET NOT NULL,
  ALTER COLUMN revocation_policy SET NOT NULL,
  ADD CONSTRAINT loyalty_annual_benefit_rules_stack_group_ck
    CHECK (stack_group ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  ADD CONSTRAINT loyalty_annual_benefit_rules_priority_ck
    CHECK (priority BETWEEN 1 AND 32767),
  ADD CONSTRAINT loyalty_annual_benefit_rules_inventory_requirement_ck
    CHECK (inventory_requirement IN ('not_applicable','strict_recipe')),
  ADD CONSTRAINT loyalty_annual_benefit_rules_revocation_policy_ck
    CHECK (revocation_policy IN ('cancel_before_redeem','expire_only','manual_compensation')),
  ADD CONSTRAINT loyalty_annual_benefit_rules_feb29_policy_ck
    CHECK ((rule_kind='birthday' AND feb29_policy IN ('feb28','mar01','leap_year_only'))
      OR (rule_kind<>'birthday' AND feb29_policy IS NULL)),
  ADD CONSTRAINT loyalty_annual_benefit_rules_festival_stack_ck
    CHECK (rule_kind NOT IN ('birthday','festival') OR stack_group='festival_gift');

COMMENT ON COLUMN mbox.loyalty_annual_benefit_rules.stack_group IS
  'Rules in the same group cannot create overlapping grants for one membership; birthday and festival gifts share festival_gift.';
COMMENT ON COLUMN mbox.loyalty_annual_benefit_rules.priority IS
  'Lower numbers win when use windows in one stack group overlap.';
COMMENT ON COLUMN mbox.loyalty_annual_benefit_rules.inventory_requirement IS
  'Published fulfillment gate; strict_recipe requires an active formal recipe and reservable inventory.';
COMMENT ON COLUMN mbox.loyalty_annual_benefit_rules.revocation_policy IS
  'Published handling when eligibility changes after grant and before redemption.';
COMMENT ON COLUMN mbox.loyalty_annual_benefit_rules.feb29_policy IS
  'Published non-leap-year date policy for members whose birthday is 02-29.';

CREATE TABLE mbox.loyalty_annual_benefit_rule_substitutes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  product_id uuid NOT NULL,
  priority smallint NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 32767),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 240),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,rule_id)
    REFERENCES mbox.loyalty_annual_benefit_rules(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,product_id)
    REFERENCES mbox.products(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,rule_id,product_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE FUNCTION mbox.protect_loyalty_annual_benefit_rule_substitute()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  SELECT policy.status INTO parent_status
  FROM mbox.loyalty_annual_benefit_rules rule
  JOIN mbox.loyalty_annual_benefit_policy_versions policy
    ON policy.tenant_id=rule.tenant_id AND policy.store_id=rule.store_id
   AND policy.id=rule.policy_version_id
  WHERE rule.tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id)
    AND rule.store_id=COALESCE(NEW.store_id,OLD.store_id)
    AND rule.id=COALESCE(NEW.rule_id,OLD.rule_id);
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'annual benefit rule substitutes are mutable only while their policy is draft';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER loyalty_annual_benefit_rule_substitutes_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_annual_benefit_rule_substitutes
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_loyalty_annual_benefit_rule_substitute();

ALTER TABLE mbox.loyalty_annual_benefit_rule_substitutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.loyalty_annual_benefit_rule_substitutes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.loyalty_annual_benefit_rule_substitutes
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.loyalty_annual_benefit_rule_substitutes TO mbox_runtime;
REVOKE DELETE ON TABLE mbox.loyalty_annual_benefit_rule_substitutes FROM mbox_runtime;

ALTER TABLE mbox.membership_annual_benefit_grants
  ADD COLUMN stack_group text,
  ADD COLUMN priority smallint,
  ADD COLUMN window_starts_on date,
  ADD COLUMN window_ends_on date;

UPDATE mbox.membership_annual_benefit_grants grant_row
SET stack_group=rule.stack_group,
    priority=rule.priority,
    window_starts_on=grant_row.cycle_key::date-rule.window_before_days,
    window_ends_on=grant_row.cycle_key::date+rule.window_after_days
FROM mbox.loyalty_annual_benefit_rules rule
WHERE rule.tenant_id=grant_row.tenant_id AND rule.store_id=grant_row.store_id
  AND rule.id=grant_row.rule_id;

ALTER TABLE mbox.membership_annual_benefit_grants
  ALTER COLUMN stack_group SET NOT NULL,
  ALTER COLUMN priority SET NOT NULL,
  ALTER COLUMN window_starts_on SET NOT NULL,
  ALTER COLUMN window_ends_on SET NOT NULL,
  ADD CONSTRAINT membership_annual_benefit_grants_stack_group_ck
    CHECK (stack_group ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  ADD CONSTRAINT membership_annual_benefit_grants_priority_ck
    CHECK (priority BETWEEN 1 AND 32767),
  ADD CONSTRAINT membership_annual_benefit_grants_window_ck
    CHECK (window_ends_on>=window_starts_on);

ALTER TABLE mbox.membership_annual_benefit_grants
  ADD CONSTRAINT membership_annual_benefit_grants_stack_window_excl
  EXCLUDE USING gist (
    tenant_id WITH =,
    store_id WITH =,
    membership_id WITH =,
    stack_group WITH =,
    daterange(window_starts_on,window_ends_on,'[]') WITH &&
  ) WHERE (status IN ('active','fulfilled','expired'))
  DEFERRABLE INITIALLY IMMEDIATE;

UPDATE mbox.normalized_schema_metadata
SET schema_version='121', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
