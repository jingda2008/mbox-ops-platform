BEGIN;
-- Preserve historical cumulative policies and orders. No live rules or balances
-- are created, activated or repriced by this schema migration.
ALTER TABLE mbox.loyalty_policy_versions ADD COLUMN points_rounding_scope text NOT NULL DEFAULT 'cumulative'
  CHECK(points_rounding_scope IN ('cumulative','order')),
  ADD CONSTRAINT loyalty_order_points_fixed_rule CHECK(points_rounding_scope<>'order' OR (points_numerator=1 AND points_denominator_minor=1000 AND rounding_mode='floor'));
ALTER TABLE mbox.loyalty_order_reward_contributions ADD COLUMN points_rounding_scope text NOT NULL DEFAULT 'cumulative'
  CHECK(points_rounding_scope IN ('cumulative','order'));
ALTER TABLE mbox.loyalty_order_awards ADD COLUMN points_rounding_scope text NOT NULL DEFAULT 'cumulative' CHECK(points_rounding_scope IN ('cumulative','order'));
CREATE FUNCTION mbox.protect_points_rounding_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.points_rounding_scope IS DISTINCT FROM OLD.points_rounding_scope AND (OLD.status<>'draft' OR NEW.status<>'draft') THEN
    RAISE EXCEPTION 'Approved points rounding scope is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_points_rounding_scope BEFORE UPDATE ON mbox.loyalty_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_points_rounding_scope();
CREATE FUNCTION mbox.protect_order_points_contribution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.points_rounding_scope IS DISTINCT FROM OLD.points_rounding_scope THEN RAISE EXCEPTION 'Original points rounding scope is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_order_points_contribution BEFORE UPDATE ON mbox.loyalty_order_reward_contributions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_order_points_contribution();
CREATE TRIGGER protect_award_points_scope BEFORE UPDATE ON mbox.loyalty_order_awards FOR EACH ROW EXECUTE FUNCTION mbox.protect_order_points_contribution();
REVOKE ALL ON FUNCTION mbox.protect_points_rounding_scope(),mbox.protect_order_points_contribution() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='267',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
