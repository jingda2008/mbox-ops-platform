BEGIN;

ALTER TABLE mbox.store_commerce_policies
  ADD COLUMN payment_reservation_minutes smallint NOT NULL DEFAULT 10
    CHECK (payment_reservation_minutes BETWEEN 2 AND 30);

ALTER TABLE mbox.orders
  ADD COLUMN fulfillment_state text,
  ADD COLUMN fulfillment_expires_at timestamptz,
  ADD COLUMN fulfillment_activated_at timestamptz DEFAULT clock_timestamp(),
  ADD COLUMN fulfillment_released_at timestamptz,
  ADD COLUMN fulfillment_priority smallint NOT NULL DEFAULT 100
    CHECK (fulfillment_priority BETWEEN 0 AND 1000),
  ADD COLUMN fulfillment_due_at timestamptz,
  ADD COLUMN fulfillment_override_reason text;

ALTER TABLE mbox.order_items
  ADD COLUMN fulfillment_priority smallint NOT NULL DEFAULT 100
    CHECK (fulfillment_priority BETWEEN 0 AND 1000),
  ADD COLUMN fulfillment_due_at timestamptz,
  ADD CONSTRAINT order_items_order_identity_uq
    UNIQUE (tenant_id, store_id, order_id, id);

ALTER TABLE mbox.inventory_movements
  ADD CONSTRAINT inventory_movements_item_identity_uq
    UNIQUE (tenant_id, store_id, inventory_item_id, id);

UPDATE mbox.order_items AS item
SET fulfillment_priority = task.priority,
    fulfillment_due_at = task.due_at
FROM mbox.kds_tasks AS task
WHERE task.tenant_id = item.tenant_id AND task.store_id = item.store_id
  AND task.order_item_id = item.id;

UPDATE mbox.orders
SET fulfillment_state = 'active',
    fulfillment_activated_at = COALESCE(submitted_at, created_at);

ALTER TABLE mbox.orders
  ALTER COLUMN fulfillment_state SET DEFAULT 'active',
  ALTER COLUMN fulfillment_state SET NOT NULL,
  ADD CONSTRAINT orders_fulfillment_state_check
    CHECK (fulfillment_state IN ('awaiting_payment', 'active', 'released', 'cancelled')),
  ADD CONSTRAINT orders_fulfillment_timestamps_check CHECK (
    (fulfillment_state = 'awaiting_payment'
      AND settlement_mode = 'immediate_payment'
      AND fulfillment_expires_at IS NOT NULL
      AND fulfillment_activated_at IS NULL
      AND fulfillment_released_at IS NULL)
    OR (fulfillment_state = 'active'
      AND fulfillment_activated_at IS NOT NULL
      AND fulfillment_expires_at IS NULL
      AND fulfillment_released_at IS NULL)
    OR (fulfillment_state IN ('released', 'cancelled')
      AND fulfillment_expires_at IS NULL
      AND fulfillment_activated_at IS NULL
      AND fulfillment_released_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION mbox.enforce_order_payment_fulfillment_gate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reservation_minutes integer;
BEGIN
  IF TG_OP='INSERT' AND NEW.settlement_mode='immediate_payment' AND NEW.payment_status<>'paid' THEN
    SELECT policy.payment_reservation_minutes INTO reservation_minutes
    FROM mbox.store_commerce_policies policy
    WHERE policy.tenant_id=NEW.tenant_id AND policy.store_id=NEW.store_id;
    NEW.fulfillment_state := 'awaiting_payment';
    NEW.fulfillment_expires_at := COALESCE(
      NEW.fulfillment_expires_at,
      clock_timestamp() + make_interval(mins => COALESCE(reservation_minutes, 10))
    );
    NEW.fulfillment_activated_at := NULL;
    NEW.fulfillment_released_at := NULL;
  ELSIF TG_OP='INSERT' THEN
    NEW.fulfillment_state := 'active';
    NEW.fulfillment_expires_at := NULL;
    NEW.fulfillment_activated_at := COALESCE(NEW.fulfillment_activated_at, clock_timestamp());
    NEW.fulfillment_released_at := NULL;
  ELSIF OLD.fulfillment_state<>'active' AND NEW.fulfillment_state='active'
    AND NEW.settlement_mode='immediate_payment' AND NEW.payment_status<>'paid' THEN
    RAISE EXCEPTION 'immediate-payment order cannot enter active fulfillment before trusted payment'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER orders_payment_fulfillment_gate
  BEFORE INSERT OR UPDATE OF fulfillment_state, payment_status, settlement_mode ON mbox.orders
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_order_payment_fulfillment_gate();

CREATE OR REPLACE FUNCTION mbox.enforce_kds_paid_fulfillment_gate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM mbox.order_items item
    JOIN mbox.orders order_row
      ON order_row.tenant_id=item.tenant_id AND order_row.store_id=item.store_id
      AND order_row.id=item.order_id
    WHERE item.tenant_id=NEW.tenant_id AND item.store_id=NEW.store_id
      AND item.id=NEW.order_item_id AND order_row.fulfillment_state='active'
  ) THEN
    RAISE EXCEPTION 'KDS task requires an active fulfillment order'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER kds_tasks_paid_fulfillment_gate
  BEFORE INSERT ON mbox.kds_tasks
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_kds_paid_fulfillment_gate();

CREATE INDEX orders_fulfillment_expiry_idx
  ON mbox.orders (tenant_id, store_id, fulfillment_expires_at, id)
  WHERE fulfillment_state = 'awaiting_payment';

CREATE TABLE mbox.inventory_order_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'consumed', 'released')),
  expires_at timestamptz,
  movement_id uuid,
  release_reason text,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id, order_item_id)
    REFERENCES mbox.order_items(tenant_id, store_id, order_id, id),
  FOREIGN KEY (tenant_id, store_id, inventory_item_id) REFERENCES mbox.inventory_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, inventory_item_id, movement_id)
    REFERENCES mbox.inventory_movements(tenant_id, store_id, inventory_item_id, id),
  CHECK (
    (status = 'reserved' AND expires_at IS NOT NULL AND movement_id IS NULL
      AND consumed_at IS NULL AND released_at IS NULL)
    OR (status = 'consumed' AND expires_at IS NULL AND movement_id IS NOT NULL
      AND consumed_at IS NOT NULL AND released_at IS NULL)
    OR (status = 'released' AND expires_at IS NULL AND movement_id IS NULL
      AND consumed_at IS NULL AND released_at IS NOT NULL AND length(btrim(release_reason)) > 0)
  ),
  UNIQUE (tenant_id, store_id, order_item_id, inventory_item_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX inventory_order_reservations_order_idx
  ON mbox.inventory_order_reservations (tenant_id, store_id, order_id, status, id);
CREATE INDEX inventory_order_reservations_expiry_idx
  ON mbox.inventory_order_reservations (tenant_id, store_id, expires_at, order_id, id)
  WHERE status = 'reserved';

CREATE TRIGGER inventory_order_reservations_touch_updated_at
  BEFORE UPDATE ON mbox.inventory_order_reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

ALTER TABLE mbox.inventory_order_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.inventory_order_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.inventory_order_reservations
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

GRANT SELECT, INSERT, UPDATE ON TABLE mbox.inventory_order_reservations TO mbox_runtime;

COMMENT ON COLUMN mbox.orders.fulfillment_state IS
  'Payment-to-fulfillment gate. Immediate-payment orders remain awaiting_payment until trusted settlement succeeds.';
COMMENT ON COLUMN mbox.store_commerce_policies.payment_reservation_minutes IS
  'Strong-typed operating policy for how long an unpaid order may reserve inventory before a verified outcome is required.';
COMMENT ON TABLE mbox.inventory_order_reservations IS
  'Per-order strong-typed inventory reservation. Reservation, consumption, and release are transactionally coupled to payment fulfillment state.';
COMMENT ON TRIGGER kds_tasks_paid_fulfillment_gate ON mbox.kds_tasks IS
  'Database fail-closed boundary: no new KDS work may be created until the order fulfillment gate is active.';

COMMIT;
