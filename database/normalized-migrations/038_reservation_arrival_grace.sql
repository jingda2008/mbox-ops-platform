BEGIN;

ALTER TABLE mbox.public_reservation_policies
  ADD COLUMN arrival_grace_minutes integer NOT NULL DEFAULT 10
    CHECK (arrival_grace_minutes BETWEEN 1 AND 120);

CREATE INDEX reservations_arrival_grace_claim_idx
  ON mbox.reservations (tenant_id, store_id, arrival_at, id)
  WHERE status = 'confirmed';

COMMENT ON COLUMN mbox.public_reservation_policies.arrival_grace_minutes IS
  'Minutes a confirmed reservation remains valid after the scheduled arrival time while the guest is not checked in.';

COMMIT;
