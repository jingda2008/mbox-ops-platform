BEGIN;
ALTER TABLE mbox.member_card_projects ADD COLUMN social_configuration_required boolean NOT NULL DEFAULT false;
-- Historical projects retain their published terms. New public API drafts opt
-- into the v9 gate and cannot open until both account bindings are configured.
UPDATE mbox.normalized_schema_metadata SET schema_version='216',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
