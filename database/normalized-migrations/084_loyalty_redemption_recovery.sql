BEGIN;

-- Recovery decisions are authoritative operating facts. JSON snapshots remain display/audit
-- evidence only and are deliberately absent from every transition constraint below.
ALTER TABLE mbox.member_redemptions
  ADD COLUMN failure_code text CHECK (failure_code IN (
    'customer_cancelled','product_unavailable','benefit_unavailable','activity_unavailable',
    'service_unavailable','fulfillment_rejected','fulfillment_timeout','technical_failure'
  )),
  ADD COLUMN recovery_state text NOT NULL DEFAULT 'not_required'
    CHECK (recovery_state IN ('not_required','manual_review','restored')),
  ADD COLUMN recovery_source text CHECK (recovery_source IN ('customer','employee','worker')),
  ADD COLUMN recovery_requested_at timestamptz,
  ADD COLUMN recovered_at timestamptz,
  ADD COLUMN recovered_by_employee_id uuid,
  ADD COLUMN recovered_by_worker_id text
    CHECK (recovered_by_worker_id IS NULL OR recovered_by_worker_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$'),
  ADD COLUMN points_restored integer NOT NULL DEFAULT 0 CHECK (points_restored >= 0),
  ADD COLUMN points_restored_at timestamptz,
  ADD COLUMN catalog_inventory_released_at timestamptz,
  ADD CONSTRAINT member_redemptions_recovered_by_employee_fk
    FOREIGN KEY (tenant_id, store_id, recovered_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  ADD CONSTRAINT member_redemptions_recovery_points_check
    CHECK (points_restored <= points_used),
  ADD CONSTRAINT member_redemptions_recovery_shape_check CHECK (
    (recovery_state='not_required'
      AND status IN ('authorizing','awaiting_fulfillment','fulfilled')
      AND failure_code IS NULL AND recovery_source IS NULL
      AND recovery_requested_at IS NULL AND recovered_at IS NULL
      AND recovered_by_employee_id IS NULL AND recovered_by_worker_id IS NULL
      AND points_restored=0 AND points_restored_at IS NULL
      AND catalog_inventory_released_at IS NULL)
    OR
    (recovery_state='manual_review' AND status='awaiting_fulfillment'
      AND failure_code IS NOT NULL AND recovery_source='worker'
      AND recovery_requested_at IS NOT NULL AND recovered_at IS NULL
      AND recovered_by_employee_id IS NULL AND recovered_by_worker_id IS NOT NULL
      AND points_restored=0 AND points_restored_at IS NULL
      AND catalog_inventory_released_at IS NULL)
    OR
    (recovery_state='restored' AND status IN ('cancelled','failed','expired')
      AND failure_code IS NOT NULL AND recovery_source IS NOT NULL
      AND recovery_requested_at IS NOT NULL AND recovered_at IS NOT NULL
      AND points_restored=points_used AND points_restored_at IS NOT NULL
      AND catalog_inventory_released_at IS NOT NULL
      AND (
        (recovery_source='customer' AND recovered_by_employee_id IS NULL AND recovered_by_worker_id IS NULL)
        OR (recovery_source='employee' AND recovered_by_employee_id IS NOT NULL AND recovered_by_worker_id IS NULL)
        OR (recovery_source='worker' AND recovered_by_employee_id IS NULL AND recovered_by_worker_id IS NOT NULL)
      ))
  ) NOT VALID;

-- Historical terminal rows are not inferred from free-text/JSON. They remain visibly
-- unvalidated and require an explicit operational review before any future transition.
COMMENT ON CONSTRAINT member_redemptions_recovery_shape_check ON mbox.member_redemptions IS
  'Enforced for new/changed rows. Historical cancelled/failed/expired rows are not auto-promoted into authoritative recovery evidence.';

CREATE INDEX member_redemptions_recovery_due_idx
  ON mbox.member_redemptions (tenant_id, store_id, expires_at, id)
  WHERE status='awaiting_fulfillment' AND recovery_state='not_required';

ALTER TABLE mbox.loyalty_point_lot_movements
  ADD CONSTRAINT loyalty_point_lot_movements_lot_identity_uq
  UNIQUE (tenant_id, store_id, lot_id, id);

ALTER TABLE mbox.redemption_point_allocations
  ADD COLUMN restored_at timestamptz,
  ADD COLUMN restoration_movement_id uuid,
  ADD CONSTRAINT redemption_point_allocations_restore_movement_fk
    FOREIGN KEY (tenant_id, store_id, point_lot_id, restoration_movement_id)
    REFERENCES mbox.loyalty_point_lot_movements(tenant_id, store_id, lot_id, id),
  ADD CONSTRAINT redemption_point_allocations_restore_shape_check CHECK (
    (restored_at IS NULL AND restoration_movement_id IS NULL)
    OR (restored_at IS NOT NULL AND restoration_movement_id IS NOT NULL)
  );

GRANT UPDATE (restored_at, restoration_movement_id)
  ON TABLE mbox.redemption_point_allocations TO mbox_runtime;

ALTER TABLE mbox.redemption_fulfillment_events
  DROP CONSTRAINT redemption_fulfillment_events_event_type_check,
  ADD CONSTRAINT redemption_fulfillment_events_event_type_check CHECK (event_type IN (
    'authorized','kds_created','fulfilled','cancelled','failed','expired',
    'points_restored','recovery_review_required'
  ));

ALTER TABLE mbox.inventory_order_reservations
  ADD COLUMN return_movement_id uuid,
  ADD COLUMN returned_at timestamptz,
  ADD CONSTRAINT inventory_order_reservations_return_movement_fk
    FOREIGN KEY (tenant_id, store_id, inventory_item_id, return_movement_id)
    REFERENCES mbox.inventory_movements(tenant_id, store_id, inventory_item_id, id),
  DROP CONSTRAINT inventory_order_reservations_status_check,
  DROP CONSTRAINT inventory_order_reservations_check,
  ADD CONSTRAINT inventory_order_reservations_status_check
    CHECK (status IN ('reserved','consumed','released','returned')),
  ADD CONSTRAINT inventory_order_reservations_state_shape_check CHECK (
    (status='reserved' AND expires_at IS NOT NULL AND movement_id IS NULL
      AND consumed_at IS NULL AND released_at IS NULL AND return_movement_id IS NULL
      AND returned_at IS NULL AND release_reason IS NULL)
    OR (status='consumed' AND expires_at IS NULL AND movement_id IS NOT NULL
      AND consumed_at IS NOT NULL AND released_at IS NULL AND return_movement_id IS NULL
      AND returned_at IS NULL AND release_reason IS NULL)
    OR (status='released' AND expires_at IS NULL AND movement_id IS NULL
      AND consumed_at IS NULL AND released_at IS NOT NULL AND return_movement_id IS NULL
      AND returned_at IS NULL AND length(btrim(release_reason)) > 0)
    OR (status='returned' AND expires_at IS NULL AND movement_id IS NOT NULL
      AND consumed_at IS NOT NULL AND released_at IS NULL AND return_movement_id IS NOT NULL
      AND returned_at IS NOT NULL AND length(btrim(release_reason)) > 0)
  );

COMMENT ON COLUMN mbox.member_redemptions.recovery_state IS
  'Strong recovery state. Timeout workers may restore only before fulfillment evidence exists; ambiguous rows enter manual_review.';
COMMENT ON COLUMN mbox.redemption_point_allocations.restoration_movement_id IS
  'Append-only proof that this exact consumed lot allocation was restored once.';
COMMENT ON COLUMN mbox.inventory_order_reservations.return_movement_id IS
  'Authoritative inventory return movement for a consumed reservation whose fulfillment was proven not delivered.';

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'member_redemptions','redemption_point_allocations','redemption_fulfillment_events',
    'inventory_order_reservations'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='mbox' AND relation.relname=table_name
        AND relation.relrowsecurity AND relation.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'Recovery table %.% must keep forced RLS', 'mbox', table_name;
    END IF;
  END LOOP;
END $$;

COMMIT;
