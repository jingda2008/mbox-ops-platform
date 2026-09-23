BEGIN;

-- Accepted service intents outlive the expiring transport cache. A throttle is
-- not acceptance and must never occupy a permanent business receipt.
CREATE TABLE mbox.guest_service_command_receipts (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  table_session_id uuid,
  customer_id uuid,
  actor_ref_hash char(64) CHECK (actor_ref_hash ~ '^[0-9a-f]{64}$'),
  device_hash char(64) CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object' AND result->>'status' IN ('created','merged')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,store_id,idempotency_key),
  CHECK ((table_session_id IS NULL AND customer_id IS NULL AND actor_ref_hash IS NULL AND device_hash IS NULL)
    OR (table_session_id IS NOT NULL AND customer_id IS NOT NULL AND actor_ref_hash IS NOT NULL AND device_hash IS NOT NULL)),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id)
);

-- Deployment uses the maintenance gate. Lock the old cache while preserving
-- accepted receipts, even if their transport TTL expired. Bind an owner only
-- when the original behavior is unique; unbound rows block unsafe resubmission.
-- Never infer an actor from the service task owner or from the current group.
LOCK TABLE mbox.idempotency_records IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO mbox.guest_service_command_receipts
  (tenant_id,store_id,idempotency_key,table_session_id,customer_id,actor_ref_hash,device_hash,request_sha256,result,created_at)
SELECT receipt.tenant_id,receipt.store_id,receipt.idempotency_key,event.table_session_id,event.customer_id,
  event.actor_ref_hash,event.device_hash,receipt.request_sha256,receipt.response_snapshot->'result',receipt.created_at
FROM mbox.idempotency_records receipt
LEFT JOIN LATERAL (
  SELECT event.*,count(*) OVER() AS matches
  FROM mbox.guest_behavior_events event
  WHERE event.tenant_id=receipt.tenant_id AND event.store_id=receipt.store_id
    AND event.behavior_type=CASE receipt.response_snapshot->'result'->>'status'
      WHEN 'created' THEN 'guest.service.requested' WHEN 'merged' THEN 'guest.service.merged' END
    AND event.behavior_code=receipt.response_snapshot->'result'->>'requestType'
    AND event.behavior_data->>'taskPublicId'=receipt.response_snapshot->'result'->>'taskPublicId'
    AND event.behavior_data->>'requestCount'=receipt.response_snapshot->'result'->>'requestCount'
) event ON event.matches=1
WHERE receipt.operation_scope='guest.service.request' AND receipt.status='completed'
  AND receipt.response_snapshot->'result'->>'status' IN ('created','merged');

CREATE TRIGGER guest_service_receipts_immutable BEFORE UPDATE OR DELETE ON mbox.guest_service_command_receipts
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.guest_service_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.guest_service_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.guest_service_command_receipts
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.guest_service_command_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON mbox.guest_service_command_receipts TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata SET schema_version='233',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
