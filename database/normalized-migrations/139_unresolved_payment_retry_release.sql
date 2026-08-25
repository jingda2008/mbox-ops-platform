BEGIN;

-- A replacement collection is a staff decision, not a fabricated failure.
-- Keep the original payment pending so a late, verified provider result can
-- still be applied, while making its pending state stop blocking the next
-- collection attempt for the same order.
ALTER TABLE mbox.payments
  ADD COLUMN retry_released_at timestamptz,
  ADD COLUMN retry_released_by_employee_id uuid,
  ADD COLUMN retry_release_reason text,
  ADD COLUMN retry_release_idempotency_key text;

ALTER TABLE mbox.payments
  ADD CONSTRAINT payments_retry_release_actor_fk
    FOREIGN KEY (tenant_id, store_id, retry_released_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  ADD CONSTRAINT payments_retry_release_fields_ck CHECK (
    (retry_released_at IS NULL
      AND retry_released_by_employee_id IS NULL
      AND retry_release_reason IS NULL
      AND retry_release_idempotency_key IS NULL)
    OR
    (retry_released_at IS NOT NULL
      AND retry_released_by_employee_id IS NOT NULL
      AND length(btrim(retry_release_reason)) BETWEEN 4 AND 500
      AND retry_release_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$')
  );

CREATE UNIQUE INDEX payments_retry_release_idempotency_uq
  ON mbox.payments(tenant_id, store_id, retry_release_idempotency_key)
  WHERE retry_release_idempotency_key IS NOT NULL;

CREATE INDEX payments_retry_released_order_idx
  ON mbox.payments(tenant_id, store_id, order_id, retry_released_at, created_at, id)
  WHERE order_id IS NOT NULL AND retry_released_at IS NOT NULL;

COMMENT ON COLUMN mbox.payments.retry_released_at IS
  'Staff recorded no explicit success and opened a replacement collection. The original payment remains eligible for a late verified success callback.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='139', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
