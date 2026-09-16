BEGIN;
ALTER TABLE mbox.bottle_custody_policies DROP CONSTRAINT bottle_custody_policies_send_minute_check;
UPDATE mbox.bottle_custody_policies SET send_minute=990 WHERE send_minute NOT BETWEEN 960 AND 1020;
ALTER TABLE mbox.bottle_custody_policies ADD CHECK(send_minute BETWEEN 960 AND 1020),
 ADD COLUMN extra_field_definitions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(extra_field_definitions)='array' AND jsonb_array_length(extra_field_definitions)<=20);
ALTER TABLE mbox.bottle_custody_orders ADD COLUMN extra_fields jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(extra_fields)='object'),
 ADD COLUMN extra_field_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(extra_field_snapshot)='array');
UPDATE mbox.normalized_schema_metadata SET schema_version='214',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
