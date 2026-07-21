BEGIN;

CREATE TABLE mbox.operational_projection_checkpoints (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  runtime_revision bigint NOT NULL CHECK (runtime_revision > 0),
  state_sha256 char(64) NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  entity_counts jsonb NOT NULL CHECK (jsonb_typeof(entity_counts) = 'object'),
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id)
);

CREATE TABLE mbox.operational_table_sessions (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_id text NOT NULL,
  table_id text NOT NULL,
  table_code text NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  guest_count integer NOT NULL DEFAULT 0 CHECK (guest_count >= 0),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision > 0),
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, source_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id)
);
CREATE INDEX operational_table_sessions_live_idx
  ON mbox.operational_table_sessions (tenant_id, store_id, business_date, status, opened_at);

CREATE TABLE mbox.operational_service_tasks (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_id text NOT NULL,
  table_id text NOT NULL,
  table_session_id text,
  service_type_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('guest', 'employee', 'system')),
  status text NOT NULL,
  priority text NOT NULL,
  owner_id text,
  escalation_level integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  created_at timestamptz NOT NULL,
  accepted_at timestamptz,
  arrived_at timestamptz,
  completed_at timestamptz,
  archived_at timestamptz,
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision > 0),
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, source_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id)
);
CREATE INDEX operational_service_tasks_live_idx
  ON mbox.operational_service_tasks (tenant_id, store_id, status, priority, created_at)
  WHERE archived_at IS NULL;
CREATE INDEX operational_service_tasks_owner_idx
  ON mbox.operational_service_tasks (tenant_id, store_id, owner_id, status, created_at)
  WHERE archived_at IS NULL;

CREATE TABLE mbox.operational_orders (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_id text NOT NULL,
  table_session_id text NOT NULL,
  status text NOT NULL,
  gross_amount_minor bigint NOT NULL CHECK (gross_amount_minor >= 0),
  discount_amount_minor bigint NOT NULL CHECK (discount_amount_minor >= 0),
  gift_amount_minor bigint NOT NULL CHECK (gift_amount_minor >= 0),
  payable_amount_minor bigint NOT NULL CHECK (payable_amount_minor >= 0),
  cost_amount_minor bigint NOT NULL CHECK (cost_amount_minor >= 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  submitted_at timestamptz,
  fulfilled_at timestamptz,
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision > 0),
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, source_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id)
);
CREATE INDEX operational_orders_session_idx
  ON mbox.operational_orders (tenant_id, store_id, table_session_id, created_at);
CREATE INDEX operational_orders_status_idx
  ON mbox.operational_orders (tenant_id, store_id, status, submitted_at);

CREATE TABLE mbox.operational_order_items (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_id text NOT NULL,
  order_id text NOT NULL,
  product_id text NOT NULL,
  item_name text NOT NULL,
  category_id text,
  station_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_sale_amount_minor bigint NOT NULL CHECK (unit_sale_amount_minor >= 0),
  unit_cost_amount_minor bigint NOT NULL CHECK (unit_cost_amount_minor >= 0),
  fulfillment_status text NOT NULL,
  added_by text NOT NULL,
  added_at timestamptz NOT NULL,
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision > 0),
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, source_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id)
);
CREATE INDEX operational_order_items_order_idx
  ON mbox.operational_order_items (tenant_id, store_id, order_id, added_at);
CREATE INDEX operational_order_items_station_idx
  ON mbox.operational_order_items (tenant_id, store_id, station_id, fulfillment_status, added_at);

CREATE TABLE mbox.operational_payment_intents (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_id text NOT NULL,
  table_session_id text NOT NULL,
  status text NOT NULL,
  channel text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  paid_at timestamptz,
  failed_at timestamptz,
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision > 0),
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, source_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id)
);
CREATE INDEX operational_payment_intents_status_idx
  ON mbox.operational_payment_intents (tenant_id, store_id, status, created_at);
CREATE INDEX operational_payment_intents_session_idx
  ON mbox.operational_payment_intents (tenant_id, store_id, table_session_id, created_at);

CREATE TABLE mbox.operational_inventory_balances (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id text NOT NULL,
  unit_code text NOT NULL,
  on_hand_quantity numeric(18,4) NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  source_updated_at timestamptz NOT NULL,
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision > 0),
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, product_id, unit_code),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id)
);
CREATE INDEX operational_inventory_balances_quantity_idx
  ON mbox.operational_inventory_balances (tenant_id, store_id, on_hand_quantity, product_id);

ALTER TABLE mbox.operational_projection_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_projection_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_table_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_table_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_service_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_service_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_order_items FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_payment_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_inventory_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_inventory_balances FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_store_isolation ON mbox.operational_projection_checkpoints
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());
CREATE POLICY tenant_store_isolation ON mbox.operational_table_sessions
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());
CREATE POLICY tenant_store_isolation ON mbox.operational_service_tasks
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());
CREATE POLICY tenant_store_isolation ON mbox.operational_orders
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());
CREATE POLICY tenant_store_isolation ON mbox.operational_order_items
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());
CREATE POLICY tenant_store_isolation ON mbox.operational_payment_intents
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());
CREATE POLICY tenant_store_isolation ON mbox.operational_inventory_balances
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

COMMENT ON TABLE mbox.operational_projection_checkpoints IS
  'Synchronous checkpoint for normalized high-frequency operational projections.';
COMMENT ON TABLE mbox.operational_service_tasks IS
  'Normalized read model projected transactionally from RuntimeState during compatibility migration.';

COMMIT;
