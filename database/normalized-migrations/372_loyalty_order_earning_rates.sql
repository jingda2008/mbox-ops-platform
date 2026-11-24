BEGIN;
-- Keep historical versions valid. New effective dates are set by the existing
-- store policy publication workflow, independently of the schema rollout.
ALTER TABLE mbox.loyalty_policy_versions
  DROP CONSTRAINT loyalty_order_points_fixed_rule,
  ADD CONSTRAINT loyalty_order_points_fixed_rule CHECK (
    points_rounding_scope <> 'order' OR
    (points_numerator = 1 AND points_denominator_minor IN (1000, 2000) AND rounding_mode = 'floor')
  );
UPDATE mbox.normalized_schema_metadata SET schema_version='372',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
