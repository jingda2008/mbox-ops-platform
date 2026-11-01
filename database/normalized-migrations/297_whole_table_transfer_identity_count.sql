BEGIN;

-- A scanned account is a location identity, not an authoritative headcount.
-- Whole-table movement preserves the declared party size and moves every active
-- identity. Partial movements still require an explicit sufficient guest count.
ALTER TABLE mbox.table_customer_movement_events
  DROP CONSTRAINT table_customer_movement_events_check,
  ADD CONSTRAINT table_customer_movement_events_participant_count_check CHECK (
    moved_participant_count >= 0
    AND (movement_kind = 'whole_table_transfer' OR moved_participant_count <= moved_guest_count)
  );

UPDATE mbox.normalized_schema_metadata
SET schema_version='297',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
