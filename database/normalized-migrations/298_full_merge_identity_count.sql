BEGIN;

-- Capture the locked source headcount for new movement facts. Historical facts
-- remain unchanged; NULL means this snapshot was not recorded at that time.
ALTER TABLE mbox.table_customer_movement_events
  ADD COLUMN source_guest_count_before integer CHECK (source_guest_count_before > 0),
  DROP CONSTRAINT table_customer_movement_events_participant_count_check,
  ADD CONSTRAINT table_customer_movement_events_participant_count_check CHECK (
    moved_participant_count >= 0 AND (
      movement_kind = 'whole_table_transfer'
      OR moved_participant_count <= moved_guest_count
      OR (movement_kind = 'participant_merge' AND source_guest_count_before IS NOT NULL
        AND moved_guest_count = source_guest_count_before)
    )
  );

-- Keep the current definer's permissions, settlement and closure protections.
-- A full merge is determined from the locked source, never a client boolean.
DO $migration$
DECLARE
  definition text;
  patch record;
  matches integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='mbox' AND p.proname='execute_table_customer_movement' AND p.pronargs=15;
  FOR patch IN SELECT * FROM (VALUES
    ($old$OR selected_count>requested_moved_guest_count THEN$old$,
     $new$OR (selected_count>requested_moved_guest_count
        AND NOT (requested_kind='participant_merge'
          AND requested_moved_guest_count=source_session.guest_count)) THEN$new$,1),
    ($old$moved_guest_count,moved_participant_count,$old$,
     $new$source_guest_count_before,moved_guest_count,moved_participant_count,$new$,2),
    ($old$target_table.id,target_table.code,source_session.guest_count,selected_count,expected_revoked_count,$old$,
     $new$target_table.id,target_table.code,source_session.guest_count,source_session.guest_count,selected_count,expected_revoked_count,$new$,1),
    ($old$requested_moved_guest_count,selected_count,expected_revoked_count,target_capacity_at_movement_value,$old$,
     $new$source_session.guest_count,requested_moved_guest_count,selected_count,expected_revoked_count,target_capacity_at_movement_value,$new$,1)
  ) AS patches(needle,replacement,expected_count) LOOP
    matches := (length(definition)-length(replace(definition,patch.needle,'')))/length(patch.needle);
    IF matches<>patch.expected_count THEN
      RAISE EXCEPTION 'migration 298 movement predecessor drift: expected %, found %',patch.expected_count,matches;
    END IF;
    definition := replace(definition,patch.needle,patch.replacement);
  END LOOP;
  EXECUTE definition;
END $migration$;

UPDATE mbox.normalized_schema_metadata
SET schema_version='298',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
