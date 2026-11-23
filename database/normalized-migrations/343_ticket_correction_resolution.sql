BEGIN;
ALTER TABLE mbox.table_ticket_corrections ADD COLUMN consumption_resolution text NOT NULL DEFAULT 'unused' CHECK(consumption_resolution IN('unused','merchant_assumes')),
 ADD COLUMN consumed_points integer NOT NULL DEFAULT 0 CHECK(consumed_points>=0),
 ADD COLUMN decision_reason text;
GRANT UPDATE(decision_reason) ON mbox.table_ticket_corrections TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='343',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
