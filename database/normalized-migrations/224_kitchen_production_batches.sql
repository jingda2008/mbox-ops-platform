BEGIN;

CREATE TABLE mbox.kitchen_production_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name text NOT NULL,
  specification text NOT NULL DEFAULT '',
  item_note text NOT NULL DEFAULT '',
  order_note text NOT NULL DEFAULT '',
  created_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  anchor_at timestamptz NOT NULL,
  equipment text,
  equipment_key text GENERATED ALWAYS AS (lower(regexp_replace(equipment,'\s','','g'))) STORED,
  released_at timestamptz,
  expected_seconds integer CHECK (expected_seconds BETWEEN 1 AND 36000),
  original_quantity integer NOT NULL CHECK (original_quantity BETWEEN 1 AND 999),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  CHECK (equipment IS NULL OR length(btrim(equipment)) BETWEEN 1 AND 40),
  CHECK (started_at IS NOT NULL OR equipment IS NULL AND expected_seconds IS NULL)
);
CREATE UNIQUE INDEX kitchen_equipment_one_active_batch ON mbox.kitchen_production_batches(tenant_id,store_id,equipment_key)
  WHERE equipment_key IS NOT NULL AND released_at IS NULL;
CREATE INDEX kitchen_batches_original_order ON mbox.kitchen_production_batches(tenant_id,store_id,anchor_at,created_at,id);

CREATE TABLE mbox.kitchen_production_units (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  kds_task_id uuid NOT NULL,
  original_table_code text NOT NULL,
  PRIMARY KEY(tenant_id,store_id,unit_id),
  FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.kitchen_production_batches(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,unit_id) REFERENCES mbox.order_item_quantity_units(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,kds_task_id) REFERENCES mbox.kds_tasks(tenant_id,store_id,id)
);
CREATE INDEX kitchen_units_batch ON mbox.kitchen_production_units(tenant_id,store_id,batch_id,kds_task_id);

CREATE FUNCTION mbox.validate_kitchen_unit_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mbox.order_item_quantity_units unit
    JOIN mbox.kds_tasks task ON (task.tenant_id,task.store_id,task.order_item_id)=(unit.tenant_id,unit.store_id,unit.order_item_id)
    JOIN mbox.order_items item ON (item.tenant_id,item.store_id,item.id)=(unit.tenant_id,unit.store_id,unit.order_item_id)
    JOIN mbox.kitchen_production_batches batch ON (batch.tenant_id,batch.store_id,batch.product_id)=(item.tenant_id,item.store_id,item.product_id)
    WHERE unit.tenant_id=NEW.tenant_id AND unit.store_id=NEW.store_id AND unit.id=NEW.unit_id
      AND task.id=NEW.kds_task_id AND task.station_code='kitchen' AND task.remake_of_task_id IS NULL
      AND batch.id=NEW.batch_id AND unit.production_state IN ('started','ready')
      AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped
  ) THEN RAISE EXCEPTION 'Kitchen allocation must refer to the original kitchen portion' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kitchen_unit_original BEFORE INSERT ON mbox.kitchen_production_units
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_kitchen_unit_binding();
CREATE TRIGGER kitchen_units_immutable BEFORE UPDATE OR DELETE ON mbox.kitchen_production_units
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TABLE mbox.kitchen_production_receipts (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 160),
  request_body jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,employee_id,operation_key),
  FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TRIGGER kitchen_receipts_immutable BEFORE UPDATE OR DELETE ON mbox.kitchen_production_receipts
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['kitchen_production_batches','kitchen_production_units','kitchen_production_receipts'] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',relation);
    EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC',relation);
    EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',relation);
  END LOOP;
END $$;
GRANT UPDATE(released_at) ON mbox.kitchen_production_batches TO mbox_runtime;

CREATE FUNCTION mbox.guard_kitchen_batch_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
    OR (to_jsonb(OLD)-'released_at'-'equipment_key') IS DISTINCT FROM (to_jsonb(NEW)-'released_at'-'equipment_key') THEN
    RAISE EXCEPTION 'Production batch allocation and release history are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kitchen_batch_release_only BEFORE UPDATE ON mbox.kitchen_production_batches
  FOR EACH ROW EXECUTE FUNCTION mbox.guard_kitchen_batch_release();

UPDATE mbox.normalized_schema_metadata SET schema_version='224',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
