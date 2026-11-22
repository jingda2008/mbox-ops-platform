BEGIN;
ALTER TABLE mbox.ticket_dining_collections ADD COLUMN rewarded_minor bigint CHECK(rewarded_minor BETWEEN 0 AND amount_minor);
GRANT UPDATE(rewarded_minor) ON mbox.ticket_dining_collections TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='336',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
