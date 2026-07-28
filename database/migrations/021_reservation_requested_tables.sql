BEGIN;

ALTER TABLE mbox.reservations
  ADD COLUMN assignment_mode text NOT NULL DEFAULT 'direct'
    CHECK (assignment_mode IN ('direct', 'self_select')),
  ADD COLUMN requested_table_id uuid,
  ADD COLUMN requested_table_code text
    CHECK (requested_table_code IS NULL OR length(requested_table_code) BETWEEN 1 AND 32),
  ADD CONSTRAINT reservations_requested_table_fk
    FOREIGN KEY (tenant_id, store_id, requested_table_id)
    REFERENCES mbox.venue_tables(tenant_id, store_id, id),
  ADD CONSTRAINT reservations_requested_table_shape CHECK (
    (
      assignment_mode = 'direct'
      AND requested_table_id IS NULL
      AND requested_table_code IS NULL
    ) OR (
      assignment_mode = 'self_select'
      AND requested_table_id IS NOT NULL
      AND requested_table_code IS NOT NULL
    )
  );

CREATE INDEX reservations_requested_table_schedule_idx
  ON mbox.reservations (
    tenant_id,
    store_id,
    requested_table_id,
    scheduled_at,
    status
  )
  WHERE requested_table_id IS NOT NULL
    AND status NOT IN ('cancelled', 'no_show');

COMMIT;
