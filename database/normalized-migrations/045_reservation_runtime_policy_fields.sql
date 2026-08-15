BEGIN;

ALTER TABLE mbox.public_reservation_policies
  ADD COLUMN policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0);

CREATE OR REPLACE FUNCTION mbox.bump_public_reservation_policy_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.hold_minutes, NEW.arrival_grace_minutes, NEW.max_advance_days,
    NEW.default_duration_minutes, NEW.customer_cancel_cutoff_minutes,
    NEW.deposit_mode, NEW.deposit_minor, NEW.deposit_ratio_bps, NEW.deposit_rule_text
  ) IS DISTINCT FROM ROW(
    OLD.hold_minutes, OLD.arrival_grace_minutes, OLD.max_advance_days,
    OLD.default_duration_minutes, OLD.customer_cancel_cutoff_minutes,
    OLD.deposit_mode, OLD.deposit_minor, OLD.deposit_ratio_bps, OLD.deposit_rule_text
  ) THEN
    NEW.policy_version := OLD.policy_version + 1;
  ELSE
    NEW.policy_version := OLD.policy_version;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER public_reservation_policies_bump_version
  BEFORE UPDATE ON mbox.public_reservation_policies
  FOR EACH ROW EXECUTE FUNCTION mbox.bump_public_reservation_policy_version();

ALTER TABLE mbox.reservations
  ADD COLUMN request_hold_expires_at timestamptz,
  ADD COLUMN arrival_grace_ends_at timestamptz,
  ADD COLUMN reservation_policy_version integer NOT NULL DEFAULT 1 CHECK (reservation_policy_version > 0);

UPDATE mbox.reservations reservation
SET request_hold_expires_at = CASE WHEN reservation.status='pending' THEN COALESCE(
      (SELECT min(table_lock.hold_expires_at)
       FROM mbox.reservation_table_locks table_lock
       WHERE table_lock.tenant_id=reservation.tenant_id
         AND table_lock.store_id=reservation.store_id
         AND table_lock.reservation_id=reservation.id
         AND table_lock.status='held'),
      LEAST(
        reservation.arrival_at,
        reservation.created_at + make_interval(mins => CASE
          WHEN reservation.reservation_snapshot->>'requestHoldMinutes' ~ '^\d{1,3}$'
          THEN LEAST(120, GREATEST(1, (reservation.reservation_snapshot->>'requestHoldMinutes')::integer))
          ELSE 20 END)
      )
    ) ELSE NULL END,
    arrival_grace_ends_at = reservation.arrival_at + make_interval(mins => CASE
      WHEN reservation.reservation_snapshot->>'arrivalGraceMinutes' ~ '^\d{1,3}$'
      THEN LEAST(120, GREATEST(1, (reservation.reservation_snapshot->>'arrivalGraceMinutes')::integer))
      ELSE 10 END);

ALTER TABLE mbox.reservations
  ALTER COLUMN arrival_grace_ends_at SET NOT NULL,
  ADD CONSTRAINT reservations_request_hold_before_arrival
    CHECK (request_hold_expires_at IS NULL OR request_hold_expires_at <= arrival_at),
  ADD CONSTRAINT reservations_arrival_grace_after_arrival
    CHECK (arrival_grace_ends_at > arrival_at);

CREATE OR REPLACE FUNCTION mbox.initialize_reservation_runtime_policy_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  configured_hold integer := 20;
  configured_grace integer := 10;
  configured_version integer := 1;
BEGIN
  SELECT policy.hold_minutes, policy.arrival_grace_minutes, policy.policy_version
  INTO configured_hold, configured_grace, configured_version
  FROM mbox.public_reservation_policies policy
  WHERE policy.tenant_id=NEW.tenant_id AND policy.store_id=NEW.store_id;

  IF NOT FOUND THEN
    configured_hold := 20;
    configured_grace := 10;
    configured_version := 1;
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

CREATE TRIGGER reservations_initialize_runtime_policy_fields
  BEFORE INSERT ON mbox.reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.initialize_reservation_runtime_policy_fields();

CREATE INDEX reservations_pending_request_hold_idx
  ON mbox.reservations (tenant_id, store_id, request_hold_expires_at, id)
  WHERE status='pending';
CREATE INDEX reservations_confirmed_grace_end_idx
  ON mbox.reservations (tenant_id, store_id, arrival_grace_ends_at, id)
  WHERE status='confirmed';

UPDATE mbox.normalized_schema_metadata
SET schema_version = '045', updated_at = clock_timestamp()
WHERE singleton = true AND schema_flavor = 'normalized-core-v1';

COMMIT;
