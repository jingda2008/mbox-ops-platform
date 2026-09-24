BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- Migration 095 revoked table-level UPDATE and granted only a subset of columns.
-- releaseSourcePhonesForMerge / releaseLegacyMbxPhonesForHash SET
-- processing_status and revocation_reason_code. Those two columns were not
-- granted, so enroll-with-phone returned 500 (permission denied for table).
--
-- Production check as login mbox_app_rc217 (2026-09-24):
--   has_table_privilege UPDATE                         = false
--   has_column_privilege UPDATE processing_status      = false
--   has_column_privilege UPDATE revocation_reason_code = false
--   has_column_privilege UPDATE revoked_at             = true
-- Deployment logins inherit mbox_runtime (GRANT mbox_runtime TO mbox_app_*).
-- Column grants belong on mbox_runtime, the same path that already exposes
-- revoked_at. Do not GRANT UPDATE on the whole table. Do not REVOKE anything:
-- REVOKE UPDATE ON TABLE would also drop the existing revoked_at column grant.
-- GRANT of an already-held column privilege is a no-op.
GRANT UPDATE (processing_status, revocation_reason_code)
  ON TABLE mbox.customer_verified_contacts TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata SET schema_version='247',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
