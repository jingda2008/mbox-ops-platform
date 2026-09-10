BEGIN;
ALTER TABLE mbox.guest_shared_cart_operations
 DROP CONSTRAINT guest_shared_cart_operations_command_check,
 ADD CONSTRAINT guest_shared_cart_operations_command_check
 CHECK(command IN ('adjust','replace_selection','replace_portion','remove','clear','submit','expire'));
UPDATE mbox.normalized_schema_metadata SET schema_version='178',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
