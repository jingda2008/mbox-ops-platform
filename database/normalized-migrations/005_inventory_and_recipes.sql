BEGIN;

CREATE TABLE mbox.inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  sku text NOT NULL CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  item_type text NOT NULL CHECK (item_type IN ('ingredient', 'bottle', 'food', 'packaging', 'consumable', 'other')),
  base_unit text NOT NULL CHECK (base_unit IN ('ml', 'g', 'piece', 'bottle', 'portion')),
  barcode text,
  low_stock_threshold numeric(18,6) CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, sku),
  UNIQUE (tenant_id, store_id, id)
);
CREATE UNIQUE INDEX inventory_items_barcode_uq
  ON mbox.inventory_items (tenant_id, store_id, barcode)
  WHERE barcode IS NOT NULL;

CREATE TABLE mbox.recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  yield_quantity integer NOT NULL DEFAULT 1 CHECK (yield_quantity > 0),
  instructions_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(instructions_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  effective_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES mbox.products(tenant_id, store_id, id),
  CHECK (status <> 'active' OR effective_at IS NOT NULL),
  UNIQUE (tenant_id, store_id, product_id, version),
  UNIQUE (tenant_id, store_id, id)
);
CREATE UNIQUE INDEX recipes_one_active_product_uq
  ON mbox.recipes (tenant_id, store_id, product_id) WHERE status = 'active';

CREATE TABLE mbox.recipe_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  expected_waste_quantity numeric(18,6) NOT NULL DEFAULT 0 CHECK (expected_waste_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, recipe_id) REFERENCES mbox.recipes(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, inventory_item_id) REFERENCES mbox.inventory_items(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, recipe_id, inventory_item_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('purchase', 'sale', 'waste', 'count_adjustment', 'transfer_in', 'transfer_out', 'return')),
  quantity_delta numeric(18,6) NOT NULL CHECK (quantity_delta <> 0),
  unit_cost_minor bigint CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  reference_type text NOT NULL,
  reference_id uuid,
  order_item_id uuid,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_employee_id uuid,
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, inventory_item_id) REFERENCES mbox.inventory_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_item_id) REFERENCES mbox.order_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX inventory_movements_item_timeline_idx
  ON mbox.inventory_movements (tenant_id, store_id, inventory_item_id, occurred_at, id);
CREATE INDEX inventory_movements_reference_idx
  ON mbox.inventory_movements (tenant_id, store_id, reference_type, reference_id)
  WHERE reference_id IS NOT NULL;
CREATE TRIGGER inventory_movements_append_only
  BEFORE UPDATE OR DELETE ON mbox.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TABLE mbox.inventory_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  on_hand_quantity numeric(18,6) NOT NULL DEFAULT 0 CHECK (on_hand_quantity >= 0),
  reserved_quantity numeric(18,6) NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  last_movement_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, inventory_item_id) REFERENCES mbox.inventory_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, last_movement_id) REFERENCES mbox.inventory_movements(tenant_id, store_id, id),
  CHECK (reserved_quantity <= on_hand_quantity),
  UNIQUE (tenant_id, store_id, inventory_item_id),
  UNIQUE (tenant_id, store_id, id)
);
CREATE INDEX inventory_balances_low_stock_idx
  ON mbox.inventory_balances (tenant_id, store_id, on_hand_quantity, inventory_item_id);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['inventory_items','recipes','inventory_balances']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at()', table_name, table_name);
  END LOOP;
END $$;

COMMIT;
