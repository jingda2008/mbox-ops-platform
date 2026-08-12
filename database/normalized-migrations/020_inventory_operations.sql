BEGIN;

ALTER TABLE mbox.inventory_items
  ADD COLUMN whole_unit_count boolean NOT NULL DEFAULT false,
  ADD COLUMN reasonable_waste_quantity numeric(18,6) NOT NULL DEFAULT 0
    CHECK (reasonable_waste_quantity >= 0),
  ADD COLUMN category_code text NOT NULL DEFAULT 'uncategorized'
    CHECK (category_code ~ '^[a-z][a-z0-9_.-]{1,63}$');

ALTER TABLE mbox.inventory_movements
  ALTER COLUMN unit_cost_minor TYPE numeric(18,6)
  USING unit_cost_minor::numeric(18,6);

CREATE UNIQUE INDEX inventory_movements_sale_once_uq
  ON mbox.inventory_movements (tenant_id, store_id, order_item_id, inventory_item_id)
  WHERE movement_type = 'sale' AND order_item_id IS NOT NULL;

CREATE TABLE mbox.inventory_barcodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 3 AND 128),
  code_type text NOT NULL DEFAULT 'barcode'
    CHECK (code_type IN ('barcode', 'qr', 'internal')),
  package_quantity numeric(18,6) NOT NULL DEFAULT 1 CHECK (package_quantity > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, inventory_item_id)
    REFERENCES mbox.inventory_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.purchase_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  supplier_ref text,
  supplier_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(supplier_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'received', 'cancelled')),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  invoice_total_minor bigint CHECK (invoice_total_minor IS NULL OR invoice_total_minor >= 0),
  note text,
  created_by_employee_id uuid NOT NULL,
  received_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  received_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, received_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK ((status = 'received') = (received_at IS NOT NULL)),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.purchase_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  batch_code text NOT NULL CHECK (length(btrim(batch_code)) BETWEEN 1 AND 128),
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  unit_cost_minor numeric(18,6) NOT NULL CHECK (unit_cost_minor >= 0),
  total_cost_minor bigint NOT NULL CHECK (total_cost_minor >= 0),
  expires_on date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, receipt_id)
    REFERENCES mbox.purchase_receipts(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, inventory_item_id)
    REFERENCES mbox.inventory_items(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, receipt_id, inventory_item_id, batch_code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.inventory_stock_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  note text,
  created_by_employee_id uuid NOT NULL,
  submitted_by_employee_id uuid,
  decided_by_employee_id uuid,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, submitted_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, decided_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (status = 'draft' OR submitted_at IS NOT NULL),
  CHECK (status NOT IN ('approved', 'rejected') OR (
    decided_at IS NOT NULL AND decided_by_employee_id IS NOT NULL
    AND length(btrim(decision_reason)) BETWEEN 2 AND 1000
  )),
  CHECK (decided_by_employee_id IS NULL OR decided_by_employee_id <> created_by_employee_id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.inventory_stock_count_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  stock_count_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  counted_quantity numeric(18,6) NOT NULL CHECK (counted_quantity >= 0),
  system_quantity_snapshot numeric(18,6) NOT NULL CHECK (system_quantity_snapshot >= 0),
  variance_quantity numeric(18,6)
    GENERATED ALWAYS AS (counted_quantity - system_quantity_snapshot) STORED,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, stock_count_id)
    REFERENCES mbox.inventory_stock_counts(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, inventory_item_id)
    REFERENCES mbox.inventory_items(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, stock_count_id, inventory_item_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.stored_bottles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  inventory_item_id uuid NOT NULL,
  source_receipt_line_id uuid,
  customer_id uuid,
  holder_display_name text,
  holder_contact_token text,
  current_table_session_id uuid NOT NULL,
  original_quantity numeric(18,6) NOT NULL CHECK (original_quantity > 0),
  remaining_quantity numeric(18,6) NOT NULL CHECK (remaining_quantity >= 0),
  status text NOT NULL DEFAULT 'stored'
    CHECK (status IN ('stored', 'in_use', 'consumed', 'voided')),
  stored_by_employee_id uuid NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, inventory_item_id)
    REFERENCES mbox.inventory_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, source_receipt_line_id)
    REFERENCES mbox.purchase_receipt_lines(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, current_table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, stored_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (remaining_quantity <= original_quantity),
  CHECK (status <> 'consumed' OR remaining_quantity = 0),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);

ALTER TABLE mbox.purchase_receipt_lines
  ADD CONSTRAINT purchase_receipt_lines_item_identity_uq
    UNIQUE (tenant_id, store_id, id, inventory_item_id);
ALTER TABLE mbox.stored_bottles
  ADD CONSTRAINT stored_bottles_source_item_fk
    FOREIGN KEY (tenant_id, store_id, source_receipt_line_id, inventory_item_id)
    REFERENCES mbox.purchase_receipt_lines(tenant_id, store_id, id, inventory_item_id);

CREATE TABLE mbox.stored_bottle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  stored_bottle_id uuid NOT NULL,
  event_type text NOT NULL
    CHECK (event_type IN ('stored', 'used', 'transferred', 'voided')),
  quantity_delta numeric(18,6) NOT NULL DEFAULT 0,
  from_table_session_id uuid,
  to_table_session_id uuid,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_by_employee_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, stored_bottle_id)
    REFERENCES mbox.stored_bottles(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, from_table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, to_table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (
    (event_type = 'used' AND quantity_delta < 0)
    OR (event_type <> 'used' AND quantity_delta = 0)
  ),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX inventory_barcodes_lookup_idx
  ON mbox.inventory_barcodes (tenant_id, store_id, code) WHERE status = 'active';
CREATE INDEX purchase_receipts_status_idx
  ON mbox.purchase_receipts (tenant_id, store_id, status, created_at, id);
CREATE INDEX purchase_receipt_lines_item_idx
  ON mbox.purchase_receipt_lines (tenant_id, store_id, inventory_item_id, created_at, id);
CREATE INDEX inventory_stock_counts_status_idx
  ON mbox.inventory_stock_counts (tenant_id, store_id, status, created_at, id);
CREATE INDEX stored_bottles_session_status_idx
  ON mbox.stored_bottles (tenant_id, store_id, current_table_session_id, status, id);

CREATE OR REPLACE FUNCTION mbox.validate_inventory_count_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mbox
AS $$
DECLARE whole_units boolean;
DECLARE count_status text;
BEGIN
  SELECT item.whole_unit_count, count.status
  INTO whole_units, count_status
  FROM mbox.inventory_items AS item
  JOIN mbox.inventory_stock_counts AS count
    ON count.tenant_id = NEW.tenant_id AND count.store_id = NEW.store_id
   AND count.id = NEW.stock_count_id
  WHERE item.tenant_id = NEW.tenant_id AND item.store_id = NEW.store_id
    AND item.id = NEW.inventory_item_id;
  IF count_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'stock count lines are editable only while draft' USING ERRCODE = '23514';
  END IF;
  IF whole_units AND trunc(NEW.counted_quantity) <> NEW.counted_quantity THEN
    RAISE EXCEPTION 'whole-unit inventory must be counted as an integer' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mbox.protect_received_purchase_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mbox
AS $$
DECLARE receipt_status text;
BEGIN
  SELECT status INTO receipt_status
  FROM mbox.purchase_receipts
  WHERE tenant_id = OLD.tenant_id AND store_id = OLD.store_id AND id = OLD.receipt_id;
  IF receipt_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'received purchase lines are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_stock_count_lines_validate
  BEFORE INSERT OR UPDATE ON mbox.inventory_stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_inventory_count_line();
CREATE TRIGGER inventory_stock_count_lines_locked
  BEFORE DELETE ON mbox.inventory_stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER purchase_receipt_lines_protect
  BEFORE UPDATE OR DELETE ON mbox.purchase_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_received_purchase_line();
CREATE TRIGGER stored_bottle_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.stored_bottle_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'inventory_barcodes', 'purchase_receipts', 'inventory_stock_counts', 'stored_bottles'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON mbox.%I '
      'FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at()', table_name, table_name
    );
  END LOOP;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'inventory_barcodes', 'purchase_receipts', 'purchase_receipt_lines',
    'inventory_stock_counts', 'inventory_stock_count_lines',
    'stored_bottles', 'stored_bottle_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) '
      'WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE mbox.%I TO mbox_runtime', table_name);
  END LOOP;
END $$;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  'inventory', permission.description, 'active'
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('inventory.view', '查看库存', '查看库存余额、批次和低库存预警'),
  ('inventory.cost.view', '查看采购成本', '查看供应商、采购成本和成本汇总'),
  ('inventory.manage', '管理库存资料', '维护原料、条码和商品配方'),
  ('inventory.receive', '采购收货入库', '登记采购批次并执行收货入库'),
  ('inventory.count', '执行库存盘点', '创建、录入和提交盘点'),
  ('inventory.count.approve', '审批库存盘点', '复核并批准盘点差异'),
  ('inventory.waste', '登记合理损耗', '登记鸡尾酒等合理损耗'),
  ('bottle.view', '查看瓶存', '查看本人责任桌次的瓶存记录'),
  ('bottle.manage', '管理瓶存', '办理瓶存、领用、转桌和作废'),
  ('bottle.manage.all', '管理全店瓶存', '跨责任桌次管理瓶存')
) AS permission(code, name, description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, status = 'active';

GRANT EXECUTE ON FUNCTION mbox.validate_inventory_count_line() TO mbox_runtime;
GRANT EXECUTE ON FUNCTION mbox.protect_received_purchase_line() TO mbox_runtime;

COMMENT ON TABLE mbox.inventory_movements IS
  'Append-only inventory ledger. Balance rows are derived transactionally from this ledger.';
COMMENT ON COLUMN mbox.purchase_receipt_lines.unit_cost_minor IS
  'Decimal minor currency units per inventory base unit; never represented as a floating point value.';
COMMENT ON TABLE mbox.stored_bottle_events IS
  'Append-only bottle custody and quantity event ledger.';

COMMIT;
