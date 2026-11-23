BEGIN;
ALTER TABLE mbox.table_ticket_offers ADD COLUMN sale_from timestamptz, ADD COLUMN sale_until timestamptz,
 ADD CHECK(sale_from IS NULL OR sale_until IS NULL OR sale_from<sale_until);
UPDATE mbox.normalized_schema_metadata SET schema_version='350',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
