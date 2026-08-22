BEGIN;

ALTER TABLE mbox.store_daily_credentials
  ADD COLUMN reusable_across_business_dates boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN mbox.store_daily_credentials.reusable_across_business_dates IS
  'When true, a successfully verified credential may be copied into the current business date after the previous daily validity window ends. Device leases and employee sessions retain their own expiry and revocation controls.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='099',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
