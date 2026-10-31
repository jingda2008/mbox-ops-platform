BEGIN;
ALTER TABLE mbox.table_sessions ADD COLUMN minimum_spend_minor bigint NOT NULL DEFAULT 0
  CHECK (minimum_spend_minor BETWEEN 0 AND 9007199254740991);
UPDATE mbox.normalized_schema_metadata SET schema_version='284',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
