BEGIN;
SET LOCAL lock_timeout='3s';
ALTER TABLE mbox.community_activity_registration_contact_versions
  DROP CONSTRAINT community_activity_registration_contact_ve_contact_source_check,
  ADD CONSTRAINT ticket_contact_source_check CHECK (contact_source IS NULL OR contact_source IN ('mini_program','staff_assisted')) NOT VALID;
ALTER TABLE mbox.community_activity_registration_contact_versions VALIDATE CONSTRAINT ticket_contact_source_check;
UPDATE mbox.normalized_schema_metadata SET schema_version='375', updated_at=clock_timestamp() WHERE singleton;
COMMIT;
