BEGIN;
-- Only newly approved online refunds opt in; do not retroactively execute old approvals.
ALTER TABLE mbox.refunds ADD COLUMN auto_execute_requested_at timestamptz;
COMMENT ON COLUMN mbox.refunds.auto_execute_requested_at IS
  'Durable intent recorded with one human approval; provider submission keeps its original idempotency claim.';
UPDATE mbox.normalized_schema_metadata SET schema_version='198',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
