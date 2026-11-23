BEGIN;
SET LOCAL lock_timeout='3s';
ALTER TABLE mbox.community_activities
  ADD COLUMN ticket_only boolean NOT NULL DEFAULT false;
ALTER TABLE mbox.table_ticket_offers
  ADD COLUMN recommend_in_community boolean NOT NULL DEFAULT false;
UPDATE mbox.normalized_schema_metadata SET schema_version='366',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
