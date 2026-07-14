BEGIN;

-- Inventory-count and bottle-storage approvals use the existing approval workflow.
ALTER TABLE mbox.approvals
  DROP CONSTRAINT IF EXISTS approvals_approval_type_check;
ALTER TABLE mbox.approvals
  ADD CONSTRAINT approvals_approval_type_check CHECK (
    approval_type IN (
      'refund', 'discount', 'void', 'writeoff', 'manual_payment',
      'inventory_count', 'bottle_storage'
    )
  );

-- These keys let downstream records prove that an item belongs to the referenced order.
ALTER TABLE mbox.order_items
  ADD CONSTRAINT order_items_tenant_store_id_order_uq
  UNIQUE (tenant_id, store_id, id, order_id);

CREATE TABLE mbox.inventory_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_code text NOT NULL CHECK (unit_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),
  on_hand_quantity bigint NOT NULL DEFAULT 0 CHECK (on_hand_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  CONSTRAINT inventory_balances_product_uq UNIQUE (tenant_id, store_id, product_id),
  CONSTRAINT inventory_balances_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX inventory_balances_lookup_idx
  ON mbox.inventory_balances (tenant_id, store_id, product_id);

CREATE TABLE mbox.inventory_stock_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_code text NOT NULL CHECK (unit_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),
  expected_quantity bigint NOT NULL CHECK (expected_quantity >= 0),
  counted_quantity bigint NOT NULL CHECK (counted_quantity >= 0),
  difference_quantity bigint GENERATED ALWAYS AS (counted_quantity - expected_quantity) STORED,
  status text NOT NULL CHECK (status IN ('pending_confirmation', 'applied', 'rejected')),
  counted_by_employee_id uuid NOT NULL,
  counted_at timestamptz NOT NULL,
  approval_id uuid,
  confirmed_by_employee_id uuid,
  confirmed_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 1000),
  adjustment_movement_id uuid,
  business_date date NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, counted_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, confirmed_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approval_id)
    REFERENCES mbox.approvals(tenant_id, store_id, id),
  CONSTRAINT inventory_stock_counts_two_people CHECK (
    confirmed_by_employee_id IS NULL OR confirmed_by_employee_id <> counted_by_employee_id
  ),
  CONSTRAINT inventory_stock_counts_confirmation_time CHECK (
    confirmed_at IS NULL OR confirmed_at >= counted_at
  ),
  CONSTRAINT inventory_stock_counts_state_shape CHECK (
    (
      difference_quantity = 0
      AND status = 'applied'
      AND approval_id IS NULL
      AND confirmed_by_employee_id IS NULL
      AND confirmed_at IS NOT NULL
      AND adjustment_movement_id IS NULL
    ) OR (
      difference_quantity <> 0
      AND status = 'pending_confirmation'
      AND approval_id IS NOT NULL
      AND confirmed_by_employee_id IS NULL
      AND confirmed_at IS NULL
      AND adjustment_movement_id IS NULL
    ) OR (
      difference_quantity <> 0
      AND status = 'applied'
      AND approval_id IS NOT NULL
      AND confirmed_by_employee_id IS NOT NULL
      AND confirmed_at IS NOT NULL
      AND adjustment_movement_id IS NOT NULL
    ) OR (
      difference_quantity <> 0
      AND status = 'rejected'
      AND approval_id IS NOT NULL
      AND confirmed_by_employee_id IS NOT NULL
      AND confirmed_at IS NOT NULL
      AND adjustment_movement_id IS NULL
    )
  ),
  CONSTRAINT inventory_stock_counts_idempotency_uq
    UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT inventory_stock_counts_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX inventory_stock_counts_pending_idx
  ON mbox.inventory_stock_counts (tenant_id, store_id, counted_at, id)
  WHERE status = 'pending_confirmation';

CREATE TABLE mbox.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_code text NOT NULL CHECK (unit_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),
  movement_type text NOT NULL CHECK (
    movement_type IN (
      'receipt', 'sale', 'gift', 'refund', 'stock_count_gain', 'stock_count_loss'
    )
  ),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  quantity bigint NOT NULL CHECK (quantity > 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  table_session_id uuid,
  order_id uuid,
  order_item_id uuid,
  refund_id uuid,
  stock_count_id uuid,
  approval_id uuid,
  actor_employee_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  business_date date NOT NULL,
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id, table_session_id)
    REFERENCES mbox.orders(tenant_id, store_id, id, table_session_id) MATCH FULL,
  FOREIGN KEY (tenant_id, store_id, order_item_id, order_id)
    REFERENCES mbox.order_items(tenant_id, store_id, id, order_id) MATCH FULL,
  FOREIGN KEY (tenant_id, store_id, refund_id)
    REFERENCES mbox.refunds(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, stock_count_id)
    REFERENCES mbox.inventory_stock_counts(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approval_id)
    REFERENCES mbox.approvals(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT inventory_movements_reference_shape CHECK (
    (
      movement_type = 'receipt' AND direction = 'in'
      AND table_session_id IS NULL AND order_id IS NULL AND order_item_id IS NULL
      AND refund_id IS NULL AND stock_count_id IS NULL AND approval_id IS NULL
    ) OR (
      movement_type IN ('sale', 'gift') AND direction = 'out'
      AND table_session_id IS NOT NULL AND order_id IS NOT NULL AND order_item_id IS NOT NULL
      AND refund_id IS NULL AND stock_count_id IS NULL
    ) OR (
      movement_type = 'refund' AND direction = 'in'
      AND table_session_id IS NOT NULL AND order_id IS NOT NULL AND order_item_id IS NOT NULL
      AND refund_id IS NOT NULL AND stock_count_id IS NULL
    ) OR (
      movement_type = 'stock_count_gain' AND direction = 'in'
      AND table_session_id IS NULL AND order_id IS NULL AND order_item_id IS NULL
      AND refund_id IS NULL AND stock_count_id IS NOT NULL AND approval_id IS NOT NULL
    ) OR (
      movement_type = 'stock_count_loss' AND direction = 'out'
      AND table_session_id IS NULL AND order_id IS NULL AND order_item_id IS NULL
      AND refund_id IS NULL AND stock_count_id IS NOT NULL AND approval_id IS NOT NULL
    )
  ),
  CONSTRAINT inventory_movements_idempotency_uq
    UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT inventory_movements_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

ALTER TABLE mbox.inventory_stock_counts
  ADD CONSTRAINT inventory_stock_counts_adjustment_movement_fk
  FOREIGN KEY (tenant_id, store_id, adjustment_movement_id)
  REFERENCES mbox.inventory_movements(tenant_id, store_id, id);

CREATE INDEX inventory_movements_product_timeline_idx
  ON mbox.inventory_movements (tenant_id, store_id, product_id, occurred_at, id);
CREATE INDEX inventory_movements_order_idx
  ON mbox.inventory_movements (tenant_id, store_id, order_id, order_item_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX inventory_movements_refund_idx
  ON mbox.inventory_movements (tenant_id, store_id, refund_id)
  WHERE refund_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbox.apply_inventory_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_quantity bigint;
  current_unit text;
  next_quantity bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || NEW.store_id::text || ':' || NEW.product_id::text,
    0
  ));

  SELECT on_hand_quantity, unit_code
    INTO current_quantity, current_unit
  FROM mbox.inventory_balances
  WHERE tenant_id = NEW.tenant_id
    AND store_id = NEW.store_id
    AND product_id = NEW.product_id
  FOR UPDATE;

  IF current_quantity IS NULL THEN
    current_quantity := 0;
  ELSIF current_unit <> NEW.unit_code THEN
    RAISE EXCEPTION 'inventory unit mismatch for product %', NEW.product_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.direction = 'in' THEN
    next_quantity := current_quantity + NEW.quantity;
    IF next_quantity < current_quantity THEN
      RAISE EXCEPTION 'inventory quantity overflow for product %', NEW.product_id
        USING ERRCODE = '22003';
    END IF;
  ELSE
    next_quantity := current_quantity - NEW.quantity;
  END IF;

  IF next_quantity < 0 THEN
    RAISE EXCEPTION 'negative inventory is not allowed for product %', NEW.product_id
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO mbox.inventory_balances (
    tenant_id, store_id, product_id, unit_code, on_hand_quantity, updated_at
  ) VALUES (
    NEW.tenant_id, NEW.store_id, NEW.product_id, NEW.unit_code, next_quantity, NEW.occurred_at
  )
  ON CONFLICT (tenant_id, store_id, product_id) DO UPDATE
  SET on_hand_quantity = EXCLUDED.on_hand_quantity,
      updated_at = EXCLUDED.updated_at,
      version = mbox.inventory_balances.version + 1;

  NEW.balance_after := next_quantity;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_movements_apply_balance
BEFORE INSERT ON mbox.inventory_movements
FOR EACH ROW EXECUTE FUNCTION mbox.apply_inventory_movement();

CREATE TRIGGER inventory_movements_append_only
BEFORE UPDATE OR DELETE ON mbox.inventory_movements
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE OR REPLACE FUNCTION mbox.validate_inventory_stock_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  approval_type_value text;
  approval_object_id uuid;
  approval_status text;
  approval_approver uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.unit_code IS DISTINCT FROM OLD.unit_code
       OR NEW.expected_quantity IS DISTINCT FROM OLD.expected_quantity
       OR NEW.counted_quantity IS DISTINCT FROM OLD.counted_quantity
       OR NEW.counted_by_employee_id IS DISTINCT FROM OLD.counted_by_employee_id
       OR NEW.counted_at IS DISTINCT FROM OLD.counted_at
       OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
       OR NEW.business_date IS DISTINCT FROM OLD.business_date
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
      RAISE EXCEPTION 'stock count facts are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.status <> 'pending_confirmation'
       OR NEW.status NOT IN ('applied', 'rejected') THEN
      RAISE EXCEPTION 'invalid stock count transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.difference_quantity <> 0 THEN
    SELECT approval_type, object_id, status, approver_employee_id
      INTO approval_type_value, approval_object_id, approval_status, approval_approver
    FROM mbox.approvals
    WHERE tenant_id = NEW.tenant_id
      AND store_id = NEW.store_id
      AND id = NEW.approval_id;

    IF approval_type_value <> 'inventory_count' OR approval_object_id <> NEW.id THEN
      RAISE EXCEPTION 'stock count variance approval does not match count %', NEW.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('applied', 'rejected') AND (
      approval_status <> CASE WHEN NEW.status = 'applied' THEN 'approved' ELSE 'rejected' END
      OR approval_approver IS DISTINCT FROM NEW.confirmed_by_employee_id
    ) THEN
      RAISE EXCEPTION 'stock count decision must match the independent approval'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_stock_counts_validate
BEFORE INSERT OR UPDATE ON mbox.inventory_stock_counts
FOR EACH ROW EXECUTE FUNCTION mbox.validate_inventory_stock_count();

CREATE TRIGGER inventory_stock_counts_touch_version
BEFORE UPDATE ON mbox.inventory_stock_counts
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE OR REPLACE FUNCTION mbox.reject_row_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% may not be deleted', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER inventory_balances_no_delete
BEFORE DELETE ON mbox.inventory_balances
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_delete();
CREATE TRIGGER inventory_stock_counts_no_delete
BEFORE DELETE ON mbox.inventory_stock_counts
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_delete();

CREATE TABLE mbox.bottle_storage_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_batch_id uuid,
  product_id uuid NOT NULL,
  sku_snapshot text NOT NULL,
  product_name_snapshot text NOT NULL,
  owner_type text NOT NULL CHECK (owner_type IN ('member', 'anonymous')),
  member_id uuid,
  anonymous_customer_ref text,
  anonymous_display_name_snapshot text,
  capacity_quantity bigint NOT NULL CHECK (capacity_quantity > 0),
  remaining_quantity bigint NOT NULL CHECK (remaining_quantity >= 0),
  unit_code text NOT NULL CHECK (unit_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),
  measurement_source text NOT NULL DEFAULT 'manual_confirmation'
    CHECK (measurement_source = 'manual_confirmation'),
  status text NOT NULL DEFAULT 'stored' CHECK (
    status IN ('stored', 'partially_used', 'exhausted', 'transferred', 'voided', 'expired')
  ),
  stored_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  original_table_session_id uuid NOT NULL,
  original_order_id uuid NOT NULL,
  original_order_item_id uuid NOT NULL,
  stored_by_employee_id uuid NOT NULL,
  deposit_approval_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, source_batch_id)
    REFERENCES mbox.bottle_storage_batches(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, member_id)
    REFERENCES mbox.customer_members(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, original_table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, original_order_id, original_table_session_id)
    REFERENCES mbox.orders(tenant_id, store_id, id, table_session_id),
  FOREIGN KEY (tenant_id, store_id, original_order_item_id, original_order_id)
    REFERENCES mbox.order_items(tenant_id, store_id, id, order_id),
  FOREIGN KEY (tenant_id, store_id, stored_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, deposit_approval_id)
    REFERENCES mbox.approvals(tenant_id, store_id, id),
  CONSTRAINT bottle_storage_batches_owner_shape CHECK (
    (
      owner_type = 'member'
      AND member_id IS NOT NULL
      AND anonymous_customer_ref IS NULL
      AND anonymous_display_name_snapshot IS NULL
    ) OR (
      owner_type = 'anonymous'
      AND member_id IS NULL
      AND anonymous_customer_ref IS NOT NULL
      AND length(anonymous_customer_ref) BETWEEN 1 AND 255
      AND anonymous_display_name_snapshot IS NOT NULL
      AND length(anonymous_display_name_snapshot) BETWEEN 1 AND 100
    )
  ),
  CONSTRAINT bottle_storage_batches_retention_order CHECK (expires_at > stored_at),
  CONSTRAINT bottle_storage_batches_remaining_limit CHECK (remaining_quantity <= capacity_quantity),
  CONSTRAINT bottle_storage_batches_status_quantity CHECK (
    (status = 'stored' AND remaining_quantity = capacity_quantity) OR
    (status = 'partially_used' AND remaining_quantity > 0 AND remaining_quantity < capacity_quantity) OR
    (status IN ('exhausted', 'transferred', 'voided', 'expired') AND remaining_quantity = 0)
  ),
  CONSTRAINT bottle_storage_batches_idempotency_uq
    UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT bottle_storage_batches_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX bottle_storage_batches_owner_member_idx
  ON mbox.bottle_storage_batches (tenant_id, store_id, member_id, status, expires_at)
  WHERE member_id IS NOT NULL;
CREATE INDEX bottle_storage_batches_owner_anonymous_idx
  ON mbox.bottle_storage_batches (tenant_id, store_id, anonymous_customer_ref, status, expires_at)
  WHERE anonymous_customer_ref IS NOT NULL;
CREATE INDEX bottle_storage_batches_expiry_idx
  ON mbox.bottle_storage_batches (tenant_id, store_id, expires_at, id)
  WHERE status IN ('stored', 'partially_used');

CREATE OR REPLACE FUNCTION mbox.validate_bottle_storage_batch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.source_batch_id IS DISTINCT FROM OLD.source_batch_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.sku_snapshot IS DISTINCT FROM OLD.sku_snapshot
       OR NEW.product_name_snapshot IS DISTINCT FROM OLD.product_name_snapshot
       OR NEW.owner_type IS DISTINCT FROM OLD.owner_type
       OR NEW.member_id IS DISTINCT FROM OLD.member_id
       OR NEW.anonymous_customer_ref IS DISTINCT FROM OLD.anonymous_customer_ref
       OR NEW.anonymous_display_name_snapshot IS DISTINCT FROM OLD.anonymous_display_name_snapshot
       OR NEW.capacity_quantity IS DISTINCT FROM OLD.capacity_quantity
       OR NEW.unit_code IS DISTINCT FROM OLD.unit_code
       OR NEW.measurement_source IS DISTINCT FROM OLD.measurement_source
       OR NEW.stored_at IS DISTINCT FROM OLD.stored_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.original_table_session_id IS DISTINCT FROM OLD.original_table_session_id
       OR NEW.original_order_id IS DISTINCT FROM OLD.original_order_id
       OR NEW.original_order_item_id IS DISTINCT FROM OLD.original_order_item_id
       OR NEW.stored_by_employee_id IS DISTINCT FROM OLD.stored_by_employee_id
       OR NEW.deposit_approval_id IS DISTINCT FROM OLD.deposit_approval_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
      RAISE EXCEPTION 'bottle batch identity and measurement facts are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.status NOT IN ('stored', 'partially_used') OR NOT (
      NEW.status IN ('partially_used', 'exhausted', 'transferred', 'voided', 'expired')
      OR (OLD.status = 'partially_used' AND NEW.status = 'partially_used')
    ) THEN
      RAISE EXCEPTION 'invalid bottle storage transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NEW.remaining_quantity >= OLD.remaining_quantity THEN
      RAISE EXCEPTION 'bottle remaining quantity must decrease on transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bottle_storage_batches_validate
BEFORE UPDATE ON mbox.bottle_storage_batches
FOR EACH ROW EXECUTE FUNCTION mbox.validate_bottle_storage_batch();
CREATE TRIGGER bottle_storage_batches_touch_version
BEFORE UPDATE ON mbox.bottle_storage_batches
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();
CREATE TRIGGER bottle_storage_batches_no_delete
BEFORE DELETE ON mbox.bottle_storage_batches
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_delete();

CREATE TABLE mbox.bottle_storage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  related_batch_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('deposit', 'use', 'transfer', 'void', 'expire')),
  quantity bigint NOT NULL CHECK (quantity > 0),
  remaining_after bigint NOT NULL CHECK (remaining_after >= 0),
  unit_code text NOT NULL CHECK (unit_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),
  table_session_id uuid,
  order_id uuid,
  order_item_id uuid,
  actor_type text NOT NULL DEFAULT 'employee' CHECK (actor_type IN ('employee', 'system')),
  actor_employee_id uuid,
  actor_ref text,
  approval_id uuid,
  approved_by_employee_id uuid,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  business_date date NOT NULL,
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, batch_id)
    REFERENCES mbox.bottle_storage_batches(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, related_batch_id)
    REFERENCES mbox.bottle_storage_batches(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id, table_session_id)
    REFERENCES mbox.orders(tenant_id, store_id, id, table_session_id) MATCH FULL,
  FOREIGN KEY (tenant_id, store_id, order_item_id, order_id)
    REFERENCES mbox.order_items(tenant_id, store_id, id, order_id) MATCH FULL,
  FOREIGN KEY (tenant_id, store_id, actor_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approval_id)
    REFERENCES mbox.approvals(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT bottle_storage_events_actor_shape CHECK (
    (actor_type = 'employee' AND actor_employee_id IS NOT NULL AND actor_ref IS NULL) OR
    (actor_type = 'system' AND actor_employee_id IS NULL AND actor_ref IS NOT NULL)
  ),
  CONSTRAINT bottle_storage_events_independent_approval CHECK (
    approved_by_employee_id IS NULL OR approved_by_employee_id <> actor_employee_id
  ),
  CONSTRAINT bottle_storage_events_context_shape CHECK (
    (
      event_type = 'deposit'
      AND table_session_id IS NOT NULL AND order_id IS NOT NULL AND order_item_id IS NOT NULL
      AND related_batch_id IS NULL AND approved_by_employee_id IS NULL
    ) OR (
      event_type = 'use'
      AND table_session_id IS NOT NULL AND order_id IS NOT NULL
      AND related_batch_id IS NULL AND approval_id IS NULL AND approved_by_employee_id IS NULL
    ) OR (
      event_type = 'transfer'
      AND table_session_id IS NOT NULL AND related_batch_id IS NOT NULL
      AND approval_id IS NOT NULL AND approved_by_employee_id IS NOT NULL
    ) OR (
      event_type = 'void'
      AND related_batch_id IS NULL
      AND approval_id IS NOT NULL AND approved_by_employee_id IS NOT NULL
    ) OR (
      event_type = 'expire'
      AND actor_type = 'system'
      AND table_session_id IS NULL AND order_id IS NULL AND order_item_id IS NULL
      AND related_batch_id IS NULL AND approval_id IS NULL AND approved_by_employee_id IS NULL
    )
  ),
  CONSTRAINT bottle_storage_events_idempotency_uq
    UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT bottle_storage_events_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX bottle_storage_events_batch_timeline_idx
  ON mbox.bottle_storage_events (tenant_id, store_id, batch_id, occurred_at, id);
CREATE INDEX bottle_storage_events_order_idx
  ON mbox.bottle_storage_events (tenant_id, store_id, order_id, occurred_at, id)
  WHERE order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbox.apply_bottle_storage_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  batch_row mbox.bottle_storage_batches%ROWTYPE;
  recipient_row mbox.bottle_storage_batches%ROWTYPE;
  approval_type_value text;
  approval_object_id uuid;
  approval_status text;
  approval_approver uuid;
  calculated_remaining bigint;
BEGIN
  SELECT * INTO batch_row
  FROM mbox.bottle_storage_batches
  WHERE tenant_id = NEW.tenant_id
    AND store_id = NEW.store_id
    AND id = NEW.batch_id
  FOR UPDATE;

  IF batch_row.id IS NULL THEN
    RAISE EXCEPTION 'bottle storage batch not found'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.unit_code <> batch_row.unit_code THEN
    RAISE EXCEPTION 'bottle event unit does not match batch'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.occurred_at < batch_row.updated_at THEN
    RAISE EXCEPTION 'bottle event predates the latest batch transition'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event_type = 'deposit' THEN
    IF batch_row.source_batch_id IS NOT NULL
       OR batch_row.status <> 'stored'
       OR NEW.quantity <> batch_row.capacity_quantity
       OR NEW.remaining_after <> batch_row.remaining_quantity
       OR EXISTS (
         SELECT 1 FROM mbox.bottle_storage_events e
         WHERE e.tenant_id = NEW.tenant_id AND e.store_id = NEW.store_id AND e.batch_id = NEW.batch_id
       ) THEN
      RAISE EXCEPTION 'invalid bottle deposit event'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF batch_row.status NOT IN ('stored', 'partially_used') THEN
    RAISE EXCEPTION 'bottle batch is not active'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type IN ('use', 'transfer', 'void') AND NEW.occurred_at >= batch_row.expires_at THEN
    RAISE EXCEPTION 'bottle retention period has expired'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event_type = 'use' THEN
    calculated_remaining := batch_row.remaining_quantity - NEW.quantity;
    IF calculated_remaining < 0 THEN
      RAISE EXCEPTION 'bottle use exceeds remaining quantity'
        USING ERRCODE = '23514';
    END IF;
    NEW.remaining_after := calculated_remaining;
    UPDATE mbox.bottle_storage_batches
    SET remaining_quantity = calculated_remaining,
        status = CASE WHEN calculated_remaining = 0 THEN 'exhausted' ELSE 'partially_used' END,
        updated_at = NEW.occurred_at
    WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND id = NEW.batch_id;
    RETURN NEW;
  END IF;

  IF NEW.event_type IN ('transfer', 'void') THEN
    SELECT approval_type, object_id, status, approver_employee_id
      INTO approval_type_value, approval_object_id, approval_status, approval_approver
    FROM mbox.approvals
    WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND id = NEW.approval_id;
    IF approval_type_value <> 'bottle_storage'
       OR approval_object_id <> NEW.batch_id
       OR approval_status <> 'approved'
       OR approval_approver IS DISTINCT FROM NEW.approved_by_employee_id THEN
      RAISE EXCEPTION 'bottle operation does not match an approved independent approval'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.event_type = 'transfer' THEN
    SELECT * INTO recipient_row
    FROM mbox.bottle_storage_batches
    WHERE tenant_id = NEW.tenant_id
      AND store_id = NEW.store_id
      AND id = NEW.related_batch_id;
    IF recipient_row.id IS NULL
       OR recipient_row.source_batch_id <> batch_row.id
       OR recipient_row.product_id <> batch_row.product_id
       OR recipient_row.unit_code <> batch_row.unit_code
       OR recipient_row.capacity_quantity <> batch_row.remaining_quantity
       OR recipient_row.remaining_quantity <> batch_row.remaining_quantity
       OR recipient_row.expires_at <> batch_row.expires_at
       OR recipient_row.status <> 'stored' THEN
      RAISE EXCEPTION 'recipient bottle batch does not preserve transfer facts'
        USING ERRCODE = '23514';
    END IF;
    NEW.quantity := batch_row.remaining_quantity;
    NEW.remaining_after := 0;
    UPDATE mbox.bottle_storage_batches
    SET remaining_quantity = 0, status = 'transferred', updated_at = NEW.occurred_at
    WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND id = NEW.batch_id;
    RETURN NEW;
  END IF;

  IF NEW.event_type = 'void' THEN
    NEW.quantity := batch_row.remaining_quantity;
    NEW.remaining_after := 0;
    UPDATE mbox.bottle_storage_batches
    SET remaining_quantity = 0, status = 'voided', updated_at = NEW.occurred_at
    WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND id = NEW.batch_id;
    RETURN NEW;
  END IF;

  IF NEW.event_type = 'expire' THEN
    IF NEW.occurred_at < batch_row.expires_at THEN
      RAISE EXCEPTION 'bottle batch cannot expire before retention deadline'
        USING ERRCODE = '23514';
    END IF;
    NEW.quantity := batch_row.remaining_quantity;
    NEW.remaining_after := 0;
    UPDATE mbox.bottle_storage_batches
    SET remaining_quantity = 0, status = 'expired', updated_at = NEW.occurred_at
    WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND id = NEW.batch_id;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER bottle_storage_events_apply
BEFORE INSERT ON mbox.bottle_storage_events
FOR EACH ROW EXECUTE FUNCTION mbox.apply_bottle_storage_event();
CREATE TRIGGER bottle_storage_events_append_only
BEFORE UPDATE OR DELETE ON mbox.bottle_storage_events
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'inventory_balances',
    'inventory_stock_counts',
    'inventory_movements',
    'bottle_storage_batches',
    'bottle_storage_events'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
  END LOOP;
END;
$$;

COMMENT ON TABLE mbox.inventory_balances IS
  'SKU on-hand projection. Authoritative changes come only from append-only inventory_movements.';
COMMENT ON TABLE mbox.inventory_movements IS
  'Append-only inventory journal linked to sale, gift, refund or independently approved stock count facts.';
COMMENT ON TABLE mbox.inventory_stock_counts IS
  'Stock-count variance requires a distinct confirmer and a matching approval before adjustment.';
COMMENT ON TABLE mbox.bottle_storage_batches IS
  'Customer bottle-storage custody batches. Quantity and unit are manually confirmed; visual volume estimation is prohibited.';
COMMENT ON TABLE mbox.bottle_storage_events IS
  'Append-only custody journal for deposit, use, transfer, void and retention expiry.';

COMMIT;
