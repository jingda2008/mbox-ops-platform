BEGIN;

ALTER TABLE mbox.community_activity_registrations
  ADD COLUMN acknowledged_safety_policy_version text,
  ADD COLUMN acknowledged_refund_policy_version text,
  ADD COLUMN terms_acknowledged_at timestamptz,
  ADD COLUMN terms_acknowledgement_source text;

-- The former mini-program confirmation copy covered both safety and refund rules,
-- but only stored the safety version in a JSON evidence envelope. Promote only
-- rows with a positive acknowledgement and both frozen versions. Any active row
-- without that evidence makes this migration fail closed at the constraint below.
UPDATE mbox.community_activity_registrations registration
SET acknowledged_safety_policy_version = btrim(registration.safety_acknowledgement->>'policyVersion'),
    acknowledged_refund_policy_version = btrim(registration.refund_policy_snapshot->>'policyVersion'),
    terms_acknowledged_at = registration.registered_at,
    terms_acknowledgement_source = 'legacy_combined_ui'
WHERE registration.safety_acknowledgement->'acknowledged' = 'true'::jsonb
  AND jsonb_typeof(registration.safety_acknowledgement->'policyVersion') = 'string'
  AND length(btrim(registration.safety_acknowledgement->>'policyVersion')) BETWEEN 1 AND 64
  AND jsonb_typeof(registration.refund_policy_snapshot->'policyVersion') = 'string'
  AND length(btrim(registration.refund_policy_snapshot->>'policyVersion')) BETWEEN 3 AND 64;

ALTER TABLE mbox.community_activity_registrations
  ADD CONSTRAINT community_activity_registrations_terms_values_check CHECK (
    (acknowledged_safety_policy_version IS NULL
      AND acknowledged_refund_policy_version IS NULL
      AND terms_acknowledged_at IS NULL
      AND terms_acknowledgement_source IS NULL)
    OR
    (length(btrim(acknowledged_safety_policy_version)) BETWEEN 1 AND 64
      AND length(btrim(acknowledged_refund_policy_version)) BETWEEN 3 AND 64
      AND terms_acknowledged_at IS NOT NULL
      AND terms_acknowledgement_source IN ('mini_program', 'staff_assisted', 'legacy_combined_ui'))
  ),
  ADD CONSTRAINT community_activity_registrations_active_terms_check CHECK (
    status NOT IN ('reserved', 'payment_pending', 'confirmed', 'waitlisted', 'checked_in')
    OR (acknowledged_safety_policy_version IS NOT NULL
      AND acknowledged_refund_policy_version IS NOT NULL
      AND terms_acknowledged_at IS NOT NULL
      AND terms_acknowledgement_source IS NOT NULL)
  );

COMMENT ON COLUMN mbox.community_activity_registrations.acknowledged_safety_policy_version IS
  'Strong safety policy version accepted by the customer; safety_acknowledgement is non-authoritative evidence only.';
COMMENT ON COLUMN mbox.community_activity_registrations.acknowledged_refund_policy_version IS
  'Strong refund policy version accepted by the customer at registration.';
COMMENT ON COLUMN mbox.community_activity_registrations.terms_acknowledged_at IS
  'Server timestamp for the combined safety and refund terms acknowledgement.';
COMMENT ON COLUMN mbox.community_activity_registrations.terms_acknowledgement_source IS
  'Strong acknowledgement channel; legacy_combined_ui identifies a one-time evidence promotion.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='067', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
