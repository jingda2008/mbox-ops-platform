BEGIN;

-- A failed task is immutable evidence. A remake gets a fresh task that points
-- back to it, so an order item can be remade without overwriting history.
ALTER TABLE mbox.kds_tasks
  ADD COLUMN remake_of_task_id uuid;

ALTER TABLE mbox.kds_tasks
  ADD CONSTRAINT kds_tasks_remake_of_task_fk
  FOREIGN KEY (tenant_id,store_id,remake_of_task_id)
  REFERENCES mbox.kds_tasks(tenant_id,store_id,id),
  ADD CONSTRAINT kds_tasks_remake_not_self_ck
  CHECK (remake_of_task_id IS NULL OR remake_of_task_id<>id);

ALTER TABLE mbox.kds_tasks
  DROP CONSTRAINT kds_tasks_tenant_id_store_id_order_item_id_station_code_key;

CREATE UNIQUE INDEX kds_tasks_initial_item_station_unique
  ON mbox.kds_tasks(tenant_id,store_id,order_item_id,station_code)
  WHERE remake_of_task_id IS NULL;

-- One failed task produces at most one direct remake. A failed remake may
-- itself be remade, preserving an explicit auditable chain.
CREATE UNIQUE INDEX kds_tasks_one_direct_remake_unique
  ON mbox.kds_tasks(tenant_id,store_id,remake_of_task_id)
  WHERE remake_of_task_id IS NOT NULL;

CREATE INDEX kds_tasks_remake_lineage_idx
  ON mbox.kds_tasks(tenant_id,store_id,remake_of_task_id,created_at,id)
  WHERE remake_of_task_id IS NOT NULL;

-- When the first production attempt already consumed its order reservation,
-- a remake needs a second batch.  Reserve that batch with the remake task,
-- then consume it only when the replacement task actually starts production.
-- This is deliberately separate from the original order reservation: the
-- original sale remains intact and the second physical batch is waste.
CREATE TABLE mbox.kds_remake_inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  remake_task_id uuid NOT NULL,
  original_task_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity>0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','consumed','released')),
  movement_id uuid,
  release_reason text,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,remake_task_id)
    REFERENCES mbox.kds_tasks(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,original_task_id)
    REFERENCES mbox.kds_tasks(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,order_item_id)
    REFERENCES mbox.order_items(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,inventory_item_id)
    REFERENCES mbox.inventory_items(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,inventory_item_id,movement_id)
    REFERENCES mbox.inventory_movements(tenant_id,store_id,inventory_item_id,id),
  CHECK (remake_task_id<>original_task_id),
  CHECK (
    (status='reserved' AND movement_id IS NULL AND consumed_at IS NULL AND released_at IS NULL)
    OR (status='consumed' AND movement_id IS NOT NULL AND consumed_at IS NOT NULL AND released_at IS NULL)
    OR (status='released' AND movement_id IS NULL AND consumed_at IS NULL AND released_at IS NOT NULL
      AND length(btrim(release_reason))>0)
  ),
  UNIQUE (tenant_id,store_id,remake_task_id,inventory_item_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX kds_remake_inventory_reservations_task_idx
  ON mbox.kds_remake_inventory_reservations(tenant_id,store_id,remake_task_id,status,id);

CREATE TRIGGER kds_remake_inventory_reservations_touch_updated_at
  BEFORE UPDATE ON mbox.kds_remake_inventory_reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

ALTER TABLE mbox.kds_remake_inventory_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.kds_remake_inventory_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.kds_remake_inventory_reservations
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.kds_remake_inventory_reservations TO mbox_runtime;

-- A consumed remake batch is a waste movement, idempotent per task/item.
CREATE UNIQUE INDEX inventory_movements_kds_remake_once_unique
  ON mbox.inventory_movements(tenant_id,store_id,inventory_item_id,reference_type,reference_id)
  WHERE movement_type='waste' AND reference_type='kds_remake' AND reference_id IS NOT NULL;

UPDATE mbox.normalized_schema_metadata
SET schema_version='137',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
