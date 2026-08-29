BEGIN;

-- Recommendation exposure changes what the customer sees, but every suggested
-- item still passes the existing availability, inventory, capacity and checkout
-- gates. For a small venue, a current legacy policy should therefore be usable
-- as an owner-authorised, reversible pilot rather than leaving the whole guest
-- recommendation surface permanently disabled. A full "enabled" rollout still
-- requires the managed three-person policy introduced in migration 092.
CREATE OR REPLACE FUNCTION mbox.guard_recommendation_feature_rollout()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.feature_code='recommendation.engine'
    AND NEW.rollout_state='pilot'
    AND NOT EXISTS (
      SELECT 1 FROM mbox.recommendation_policy_versions policy
      WHERE policy.tenant_id=NEW.tenant_id AND policy.store_id=NEW.store_id
        AND policy.policy_code='DEFAULT' AND policy.status='published'
        AND policy.effective_from<=clock_timestamp()
        AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
    ) THEN
    RAISE EXCEPTION 'recommendation pilot requires a current published policy';
  END IF;

  IF NEW.feature_code='recommendation.engine'
    AND NEW.rollout_state='enabled'
    AND NOT EXISTS (
      SELECT 1 FROM mbox.recommendation_policy_versions policy
      WHERE policy.tenant_id=NEW.tenant_id AND policy.store_id=NEW.store_id
        AND policy.policy_code='DEFAULT' AND policy.status='published'
        AND policy.publication_mode='separated'
        AND policy.effective_from<=clock_timestamp()
        AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
    ) THEN
    RAISE EXCEPTION 'recommendation enabled rollout requires a current managed three-person policy';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION mbox.guard_recommendation_feature_rollout() IS
  'A current published policy permits a reversible recommendation pilot; full enablement requires a managed three-person policy. Product availability, inventory, capacity and checkout guards remain independent.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='150',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
