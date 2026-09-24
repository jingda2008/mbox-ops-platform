BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- Migration 095 revoked table-level UPDATE and granted only a subset of columns.
-- releaseSourcePhonesForMerge / releaseLegacyMbxPhonesForHash set
-- processing_status and revocation_reason_code. Those columns were not granted,
-- so mbox_runtime received "permission denied for table customer_verified_contacts"
-- and POST /public/mini/membership/enroll-with-phone returned 500.
-- Production already applied this column grant manually. GRANT is idempotent:
-- repeating it does not widen table-level UPDATE and does not revoke the
-- earlier column grants (revoked_at and the 079/095 verification columns).
GRANT UPDATE (processing_status, revocation_reason_code)
  ON TABLE mbox.customer_verified_contacts TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata SET schema_version='247',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
