BEGIN;

-- Refund submission is a financial state machine, not a free JSON convention.
-- Existing processing rows predate the authoritative submission claim and are
-- deliberately sent to manual review. We do not promote JSON evidence into
-- trusted order numbers or invent a submission time.
ALTER TABLE mbox.refunds
  ADD COLUMN merchant_refund_id text,
  ADD COLUMN provider_submission_started_at timestamptz,
  ADD COLUMN provider_submission_state text NOT NULL DEFAULT 'not_started'
    CHECK (provider_submission_state IN ('not_started', 'submitting', 'submitted', 'manual_review'));

UPDATE mbox.refunds
SET provider_submission_state='manual_review', updated_at=clock_timestamp()
WHERE status='processing';

ALTER TABLE mbox.refunds
  ADD CONSTRAINT refunds_provider_submission_pair_ck CHECK (
    (
      provider_submission_state IN ('not_started', 'manual_review')
      AND merchant_refund_id IS NULL
      AND provider_submission_started_at IS NULL
    ) OR (
      provider_submission_state IN ('submitting', 'submitted')
      AND merchant_refund_id ~ '^[A-Fa-f0-9]{32}$'
      AND provider_submission_started_at IS NOT NULL
    )
  );

CREATE UNIQUE INDEX refunds_merchant_refund_id_uq
  ON mbox.refunds (tenant_id, store_id, merchant_refund_id)
  WHERE merchant_refund_id IS NOT NULL;

COMMENT ON COLUMN mbox.refunds.merchant_refund_id IS
  'Stable 32-character provider request order number derived from the internal refund UUID; never accepted from clients.';
COMMENT ON COLUMN mbox.refunds.provider_submission_started_at IS
  'Authoritative first provider-submission claim time used for provider refund queries.';
COMMENT ON COLUMN mbox.refunds.provider_submission_state IS
  'Strong provider submission state. manual_review marks pre-057 processing rows that must never be guessed or automatically resubmitted.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='057', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
