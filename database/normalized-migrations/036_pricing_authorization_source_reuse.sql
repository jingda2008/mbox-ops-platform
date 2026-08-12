BEGIN;

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT constraint_record.conname
  INTO constraint_name
  FROM pg_constraint AS constraint_record
  WHERE constraint_record.conrelid = 'mbox.pricing_authorizations'::regclass
    AND constraint_record.contype = 'u'
    AND pg_get_constraintdef(constraint_record.oid)
      LIKE '%(tenant_id, store_id, table_session_id, source_type, source_id)%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE mbox.pricing_authorizations DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;
END $$;

CREATE UNIQUE INDEX pricing_authorizations_benefit_once_per_table_uq
  ON mbox.pricing_authorizations (
    tenant_id, store_id, table_session_id, source_type, source_id
  )
  WHERE source_type = 'benefit';

COMMENT ON TABLE mbox.pricing_authorizations IS
  'Server-issued, table-scoped pricing authority. A customer benefit can be consumed once per table session; employee role limits remain reusable and are checked per order.';

UPDATE mbox.normalized_schema_metadata
SET schema_version = '036', updated_at = clock_timestamp()
WHERE singleton = true;

COMMIT;
