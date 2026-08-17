BEGIN;

ALTER TABLE mbox.community_activities
  ADD COLUMN safety_policy_version text,
  ADD COLUMN safety_acknowledgement_text text,
  ADD COLUMN safety_requirements text[] NOT NULL DEFAULT '{}',
  ADD COLUMN refund_policy_version text,
  ADD COLUMN refund_policy_summary text,
  ADD COLUMN activity_details text,
  ADD COLUMN included_items text[] NOT NULL DEFAULT '{}',
  ADD COLUMN participation_requirements text[] NOT NULL DEFAULT '{}',
  ADD COLUMN contact_instructions text,
  ADD COLUMN member_benefit_text text;

UPDATE mbox.community_activities activity
SET safety_policy_version = CASE
      WHEN jsonb_typeof(activity.safety_snapshot->'policyVersion')='string'
        AND length(btrim(activity.safety_snapshot->>'policyVersion')) BETWEEN 1 AND 64
      THEN btrim(activity.safety_snapshot->>'policyVersion') ELSE NULL END,
    safety_acknowledgement_text = CASE
      WHEN jsonb_typeof(activity.safety_snapshot->'acknowledgementText')='string'
        AND length(btrim(activity.safety_snapshot->>'acknowledgementText')) BETWEEN 2 AND 1000
      THEN btrim(activity.safety_snapshot->>'acknowledgementText') ELSE NULL END,
    safety_requirements = COALESCE((
      SELECT array_agg(value ORDER BY ordinal)
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(activity.safety_snapshot->'requirements')='array'
          THEN activity.safety_snapshot->'requirements' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS entry(value, ordinal)
      WHERE length(btrim(value)) BETWEEN 1 AND 500
    ), '{}'),
    refund_policy_version = CASE
      WHEN jsonb_typeof(activity.refund_policy_snapshot->'policyVersion')='string'
        AND length(btrim(activity.refund_policy_snapshot->>'policyVersion')) BETWEEN 3 AND 64
      THEN btrim(activity.refund_policy_snapshot->>'policyVersion') ELSE NULL END,
    refund_policy_summary = CASE
      WHEN jsonb_typeof(activity.refund_policy_snapshot->'summary')='string'
        AND length(btrim(activity.refund_policy_snapshot->>'summary')) BETWEEN 2 AND 500
      THEN btrim(activity.refund_policy_snapshot->>'summary') ELSE NULL END,
    activity_details = CASE
      WHEN jsonb_typeof(activity.sales_copy->'details')='string'
        AND length(btrim(activity.sales_copy->>'details')) BETWEEN 10 AND 4000
      THEN btrim(activity.sales_copy->>'details') ELSE NULL END,
    included_items = COALESCE((
      SELECT array_agg(value ORDER BY ordinal)
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(activity.sales_copy->'includedItems')='array'
          THEN activity.sales_copy->'includedItems' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS entry(value, ordinal)
      WHERE length(btrim(value)) BETWEEN 1 AND 500
    ), '{}'),
    participation_requirements = COALESCE((
      SELECT array_agg(value ORDER BY ordinal)
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(activity.sales_copy->'participationRequirements')='array'
          THEN activity.sales_copy->'participationRequirements' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS entry(value, ordinal)
      WHERE length(btrim(value)) BETWEEN 1 AND 500
    ), '{}'),
    contact_instructions = CASE
      WHEN jsonb_typeof(activity.sales_copy->'contactInstructions')='string'
        AND length(btrim(activity.sales_copy->>'contactInstructions')) BETWEEN 2 AND 1200
      THEN btrim(activity.sales_copy->>'contactInstructions') ELSE NULL END,
    member_benefit_text = CASE
      WHEN jsonb_typeof(activity.sales_copy->'memberBenefitText')='string'
        AND length(btrim(activity.sales_copy->>'memberBenefitText')) <= 1000
      THEN btrim(activity.sales_copy->>'memberBenefitText') ELSE NULL END;

ALTER TABLE mbox.community_activities
  ADD CONSTRAINT community_activities_safety_policy_version_check
    CHECK (safety_policy_version IS NULL OR length(btrim(safety_policy_version)) BETWEEN 1 AND 64),
  ADD CONSTRAINT community_activities_safety_acknowledgement_text_check
    CHECK (safety_acknowledgement_text IS NULL OR length(btrim(safety_acknowledgement_text)) BETWEEN 2 AND 1000),
  ADD CONSTRAINT community_activities_safety_requirements_check
    CHECK (cardinality(safety_requirements) <= 50),
  ADD CONSTRAINT community_activities_refund_policy_version_check
    CHECK (refund_policy_version IS NULL OR length(btrim(refund_policy_version)) BETWEEN 3 AND 64),
  ADD CONSTRAINT community_activities_refund_policy_summary_check
    CHECK (refund_policy_summary IS NULL OR length(btrim(refund_policy_summary)) BETWEEN 2 AND 500),
  ADD CONSTRAINT community_activities_activity_details_check
    CHECK (activity_details IS NULL OR length(btrim(activity_details)) BETWEEN 10 AND 4000),
  ADD CONSTRAINT community_activities_included_items_check
    CHECK (cardinality(included_items) <= 100),
  ADD CONSTRAINT community_activities_participation_requirements_check
    CHECK (cardinality(participation_requirements) <= 100),
  ADD CONSTRAINT community_activities_contact_instructions_check
    CHECK (contact_instructions IS NULL OR length(btrim(contact_instructions)) BETWEEN 2 AND 1200),
  ADD CONSTRAINT community_activities_member_benefit_text_check
    CHECK (member_benefit_text IS NULL OR length(member_benefit_text) <= 1000),
  ADD CONSTRAINT community_activities_published_contract_check CHECK (
    status NOT IN ('published','full','completed') OR (
      safety_policy_version IS NOT NULL
      AND safety_acknowledgement_text IS NOT NULL
      AND cardinality(safety_requirements)>0
      AND refund_policy_version IS NOT NULL
      AND refund_policy_summary IS NOT NULL
      AND activity_details IS NOT NULL
      AND contact_instructions IS NOT NULL
    )
  );

COMMENT ON COLUMN mbox.community_activities.safety_policy_version IS
  'Strong safety policy version used for customer acknowledgement; safety_snapshot is display evidence only.';
COMMENT ON COLUMN mbox.community_activities.refund_policy_version IS
  'Strong published refund policy version frozen into each registration.';
COMMENT ON COLUMN mbox.community_activities.activity_details IS
  'Strong publication-required activity detail text; sales_copy remains flexible presentation data.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='062', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
