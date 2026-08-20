BEGIN;

ALTER TABLE mbox.reservations
  ADD COLUMN preferred_schedule_id uuid,
  ADD COLUMN reservation_policy_acknowledged_version integer;

UPDATE mbox.reservations
SET reservation_policy_acknowledged_version = reservation_policy_version
WHERE reservation_policy_acknowledged_version IS NULL;

ALTER TABLE mbox.reservations
  ALTER COLUMN reservation_policy_acknowledged_version SET NOT NULL,
  ADD CONSTRAINT reservations_policy_acknowledged_version_check
    CHECK (reservation_policy_acknowledged_version > 0),
  ADD CONSTRAINT reservations_preferred_schedule_fk
    FOREIGN KEY (tenant_id, store_id, preferred_schedule_id)
    REFERENCES mbox.schedules(tenant_id, store_id, id);

CREATE INDEX reservations_preferred_schedule_idx
  ON mbox.reservations (tenant_id, store_id, preferred_schedule_id, arrival_at, id)
  WHERE preferred_schedule_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbox.initialize_reservation_policy_acknowledgement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reservation_policy_acknowledged_version IS NULL THEN
    NEW.reservation_policy_acknowledged_version := NEW.reservation_policy_version;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reservations_initialize_policy_acknowledgement
  BEFORE INSERT ON mbox.reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.initialize_reservation_policy_acknowledgement();

COMMIT;
