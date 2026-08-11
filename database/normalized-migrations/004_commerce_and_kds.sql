BEGIN;

CREATE TABLE mbox.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  category_code text NOT NULL,
  fulfillment_station text NOT NULL CHECK (fulfillment_station IN ('bar', 'kitchen', 'cashier', 'none')),
  product_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(product_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold_out', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.product_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  price_type text NOT NULL DEFAULT 'standard' CHECK (price_type IN ('standard', 'promotion', 'member', 'upgrade')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES mbox.products(tenant_id, store_id, id),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  UNIQUE NULLS NOT DISTINCT (tenant_id, store_id, product_id, price_type, valid_from, valid_until),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX product_prices_active_idx
  ON mbox.product_prices (tenant_id, store_id, product_id, price_type, valid_from DESC, valid_until);

CREATE TABLE mbox.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  channel text NOT NULL CHECK (channel IN ('guest_qr', 'staff_assisted', 'cashier', 'reservation', 'integration')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'confirmed', 'fulfilling', 'completed', 'cancelled')),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'pending', 'partially_paid', 'paid', 'partially_refunded', 'refunded')),
  subtotal_amount_minor bigint NOT NULL DEFAULT 0 CHECK (subtotal_amount_minor >= 0),
  discount_amount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_amount_minor >= 0),
  total_amount_minor bigint NOT NULL DEFAULT 0 CHECK (total_amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  note text,
  created_by_employee_id uuid,
  submitted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id) REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (discount_amount_minor <= subtotal_amount_minor),
  CHECK (total_amount_minor = subtotal_amount_minor - discount_amount_minor),
  CHECK (completed_at IS NULL OR status = 'completed'),
  CHECK (cancelled_at IS NULL OR status = 'cancelled'),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX orders_session_timeline_idx
  ON mbox.orders (tenant_id, store_id, table_session_id, created_at DESC, id);

CREATE TABLE mbox.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  parent_order_item_id uuid,
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  discount_amount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_amount_minor >= 0),
  total_amount_minor bigint NOT NULL CHECK (total_amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  fulfillment_station text NOT NULL CHECK (fulfillment_station IN ('bar', 'kitchen', 'cashier', 'none')),
  product_snapshot jsonb NOT NULL CHECK (jsonb_typeof(product_snapshot) = 'object'),
  cost_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cost_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'preparing', 'ready', 'delivered', 'cancelled')),
  note text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, parent_order_item_id) REFERENCES mbox.order_items(tenant_id, store_id, id),
  CHECK (discount_amount_minor <= unit_price_minor * quantity),
  CHECK (total_amount_minor = unit_price_minor * quantity - discount_amount_minor),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX order_items_order_idx ON mbox.order_items (tenant_id, store_id, order_id, created_at, id);

CREATE TABLE mbox.kds_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  station_code text NOT NULL CHECK (station_code IN ('bar', 'kitchen', 'cashier')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'preparing', 'ready', 'cancelled', 'failed')),
  priority smallint NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  quantity integer NOT NULL CHECK (quantity > 0),
  assigned_employee_id uuid,
  due_at timestamptz,
  next_action_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  worker_locked_by text,
  worker_locked_at timestamptz,
  accepted_at timestamptz,
  ready_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, order_item_id) REFERENCES mbox.order_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, assigned_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, order_item_id, station_code),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX kds_tasks_claim_idx
  ON mbox.kds_tasks (station_code, priority, next_action_at, created_at, id)
  WHERE status IN ('pending', 'accepted', 'preparing');
CREATE INDEX kds_tasks_store_claim_idx
  ON mbox.kds_tasks (tenant_id, store_id, station_code, priority, next_action_at, created_at, id)
  WHERE status IN ('pending', 'accepted', 'preparing');

CREATE TABLE mbox.kds_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  kds_task_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  from_status text,
  to_status text,
  actor_employee_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  idempotency_key text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, kds_task_id) REFERENCES mbox.kds_tasks(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX kds_task_events_timeline_idx
  ON mbox.kds_task_events (tenant_id, store_id, kds_task_id, occurred_at, id);
CREATE UNIQUE INDEX kds_task_events_idempotency_uq
  ON mbox.kds_task_events (tenant_id, store_id, kds_task_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER kds_task_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.kds_task_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['products','orders','order_items','kds_tasks']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at()', table_name, table_name);
  END LOOP;
END $$;

COMMIT;
