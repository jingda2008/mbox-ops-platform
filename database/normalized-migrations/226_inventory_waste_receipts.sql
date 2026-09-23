BEGIN;

-- Domain receipts outlive the expiring transport idempotency cache. The original
-- request hash includes the acting employee, route, method and complete body.
CREATE TABLE mbox.inventory_waste_receipts (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  operation_scope text NOT NULL CHECK (operation_scope IN (
    'inventory.waste.record','inventory.waste.submit',
    'inventory.waste-request.approve','inventory.waste-request.reject'
  )),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,operation_scope,idempotency_key),
  FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);

-- Block old writers before the backfill snapshot until its capture trigger is installed.
-- Otherwise a completion between SELECT and CREATE TRIGGER can miss both paths.
LOCK TABLE mbox.idempotency_records IN SHARE ROW EXCLUSIVE MODE;

-- Retain completed pre-upgrade receipts, including expired rows not yet cleaned.
-- Never reconstruct an identity from an unbound movement or alter its amounts.
INSERT INTO mbox.inventory_waste_receipts
  (tenant_id,store_id,operation_scope,idempotency_key,request_sha256,result,created_at)
SELECT tenant_id,store_id,operation_scope,idempotency_key,request_sha256,
  response_snapshot->'result',created_at
FROM mbox.idempotency_records
WHERE operation_scope IN ('inventory.waste.record','inventory.waste.submit',
  'inventory.waste-request.approve','inventory.waste-request.reject')
  AND status='completed' AND jsonb_typeof(response_snapshot->'result')='object';

CREATE TRIGGER inventory_waste_receipts_immutable
  BEFORE UPDATE OR DELETE ON mbox.inventory_waste_receipts
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.inventory_waste_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.inventory_waste_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.inventory_waste_receipts
  USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.inventory_waste_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON mbox.inventory_waste_receipts TO mbox_runtime;

-- Capture completions from the previous application while a rolling release is
-- between migration and cutover. This also makes cache cleanup harmless.
CREATE FUNCTION mbox.retain_inventory_waste_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='completed' AND NEW.operation_scope IN (
    'inventory.waste.record','inventory.waste.submit',
    'inventory.waste-request.approve','inventory.waste-request.reject'
  ) THEN
    INSERT INTO mbox.inventory_waste_receipts
      (tenant_id,store_id,operation_scope,idempotency_key,request_sha256,result)
    VALUES(NEW.tenant_id,NEW.store_id,NEW.operation_scope,NEW.idempotency_key,
      NEW.request_sha256,NEW.response_snapshot->'result')
    ON CONFLICT DO NOTHING;
    IF NOT EXISTS(SELECT 1 FROM mbox.inventory_waste_receipts receipt
      WHERE receipt.tenant_id=NEW.tenant_id AND receipt.store_id=NEW.store_id
        AND receipt.operation_scope=NEW.operation_scope AND receipt.idempotency_key=NEW.idempotency_key
        AND receipt.request_sha256=NEW.request_sha256 AND receipt.result=NEW.response_snapshot->'result') THEN
      RAISE EXCEPTION 'Waste operation receipt conflicts with original request' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER retain_inventory_waste_receipt AFTER INSERT OR UPDATE ON mbox.idempotency_records
  FOR EACH ROW EXECUTE FUNCTION mbox.retain_inventory_waste_receipt();
UPDATE mbox.normalized_schema_metadata SET schema_version='226',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
