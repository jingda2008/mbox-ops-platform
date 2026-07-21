BEGIN;

CREATE TABLE mbox.operational_tables (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_id text NOT NULL,
  table_code text NOT NULL,
  area_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('available', 'occupied', 'reserved', 'paused')),
  primary_employee_id text NOT NULL,
  guest_count integer NOT NULL DEFAULT 0 CHECK (guest_count >= 0),
  opened_at timestamptz,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision > 0),
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, source_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id)
);
CREATE UNIQUE INDEX operational_tables_code_idx
  ON mbox.operational_tables (tenant_id, store_id, table_code);
CREATE INDEX operational_tables_live_idx
  ON mbox.operational_tables (tenant_id, store_id, area_id, status, table_code);

CREATE TABLE mbox.operational_kds_tasks (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_id text NOT NULL,
  order_id text NOT NULL,
  order_item_id text NOT NULL,
  table_session_id text NOT NULL,
  table_code text,
  station_id text NOT NULL,
  item_name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('queued', 'preparing', 'completed', 'picked_up', 'delivered')),
  queued_at timestamptz NOT NULL,
  completed_at timestamptz,
  delivered_at timestamptz,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision > 0),
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, source_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id)
);
CREATE INDEX operational_kds_tasks_station_idx
  ON mbox.operational_kds_tasks (tenant_id, store_id, station_id, status, queued_at);
CREATE INDEX operational_kds_tasks_session_idx
  ON mbox.operational_kds_tasks (tenant_id, store_id, table_session_id, status, queued_at);

ALTER TABLE mbox.operational_table_sessions
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object');
ALTER TABLE mbox.operational_service_tasks
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object');
ALTER TABLE mbox.operational_orders
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object');
ALTER TABLE mbox.operational_order_items
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object');
ALTER TABLE mbox.operational_payment_intents
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object');
ALTER TABLE mbox.operational_inventory_balances
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object');

ALTER TABLE mbox.operational_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_tables FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_kds_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_kds_tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_store_isolation ON mbox.operational_tables
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());
CREATE POLICY tenant_store_isolation ON mbox.operational_kds_tasks
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  mbox.operational_projection_checkpoints,
  mbox.operational_tables,
  mbox.operational_table_sessions,
  mbox.operational_service_tasks,
  mbox.operational_orders,
  mbox.operational_order_items,
  mbox.operational_kds_tasks,
  mbox.operational_payment_intents,
  mbox.operational_inventory_balances
TO mbox_app;

COMMENT ON TABLE mbox.operational_tables IS
  'Authoritative indexed read model for live table status; payload contains one table entity, never the whole store.';
COMMENT ON TABLE mbox.operational_kds_tasks IS
  'Authoritative indexed read model for production and delivery work; payload contains one KDS task entity.';
COMMENT ON COLUMN mbox.operational_tables.snapshot_revision IS
  'Runtime revision in which this entity was last synchronized; global consistency is established by the transactional projection checkpoint.';
COMMENT ON COLUMN mbox.operational_kds_tasks.snapshot_revision IS
  'Runtime revision in which this entity was last synchronized; global consistency is established by the transactional projection checkpoint.';

COMMIT;
