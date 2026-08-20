BEGIN;

ALTER TABLE mbox.public_reservation_policies
  DROP CONSTRAINT public_reservation_policies_hold_minutes_check,
  ADD CONSTRAINT public_reservation_policies_hold_minutes_check
    CHECK (hold_minutes BETWEEN 1 AND 120);

CREATE OR REPLACE FUNCTION mbox.initialize_reservation_runtime_policy_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  configured_hold integer;
  configured_grace integer;
  configured_version integer;
BEGIN
  SELECT policy.hold_minutes, policy.arrival_grace_minutes, policy.policy_version
  INTO configured_hold, configured_grace, configured_version
  FROM mbox.public_reservation_policies policy
  WHERE policy.tenant_id=NEW.tenant_id AND policy.store_id=NEW.store_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation policy is not configured for store %', NEW.store_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.arrival_grace_ends_at IS NULL THEN
    NEW.arrival_grace_ends_at := NEW.arrival_at + make_interval(mins => configured_grace);
  END IF;
  IF NEW.status='pending' AND NEW.request_hold_expires_at IS NULL THEN
    NEW.request_hold_expires_at := LEAST(
      NEW.arrival_at,
      COALESCE(NEW.created_at, clock_timestamp()) + make_interval(mins => configured_hold)
    );
  END IF;
  IF NEW.reservation_policy_version IS NULL OR NEW.reservation_policy_version=1 THEN
    NEW.reservation_policy_version := configured_version;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON COLUMN mbox.public_reservation_policies.hold_minutes IS
  'Configurable request hold duration (1-120 minutes); the applied policy_version is frozen on each reservation.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='068', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
