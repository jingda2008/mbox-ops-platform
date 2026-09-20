BEGIN;

CREATE TABLE mbox.inventory_waste_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  waste_type text NOT NULL CHECK (waste_type IN ('mixing_failure','discarded','expired','tasting','complimentary','count_difference','other')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  requested_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by_employee_id uuid,
  decided_at timestamptz,
  decision_reason text,
  movement_id uuid,
  UNIQUE (tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,movement_id),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,inventory_item_id) REFERENCES mbox.inventory_items(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,requested_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,decided_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,movement_id) REFERENCES mbox.inventory_movements(tenant_id,store_id,id),
  CHECK (decided_by_employee_id IS NULL OR decided_by_employee_id <> requested_by_employee_id),
  CHECK ((status='pending' AND decided_by_employee_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL AND movement_id IS NULL)
    OR (status IN ('approved','rejected') AND decided_by_employee_id IS NOT NULL AND decided_at IS NOT NULL
      AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) BETWEEN 2 AND 500 AND (status='approved')=(movement_id IS NOT NULL)))
);
CREATE INDEX inventory_waste_requests_review_idx ON mbox.inventory_waste_requests(tenant_id,store_id,status,created_at DESC,id DESC);
ALTER TABLE mbox.inventory_waste_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.inventory_waste_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.inventory_waste_requests
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.inventory_waste_requests FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON mbox.inventory_waste_requests TO mbox_runtime;
CREATE FUNCTION mbox.guard_inventory_waste_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.status='pending'
    OR (to_jsonb(OLD)-ARRAY['status','decided_by_employee_id','decided_at','decision_reason','movement_id'])
       IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','decided_by_employee_id','decided_at','decision_reason','movement_id']) THEN
    RAISE EXCEPTION 'Waste requests are immutable except for one independent decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_waste_request_decision BEFORE UPDATE ON mbox.inventory_waste_requests
  FOR EACH ROW EXECUTE FUNCTION mbox.guard_inventory_waste_decision();

UPDATE mbox.normalized_schema_metadata SET schema_version='223',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
