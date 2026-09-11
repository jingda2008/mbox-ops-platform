BEGIN;

-- A pending channel attempt does not reserve the right to collect an order.
-- Command idempotency, provider transaction uniqueness and locked confirmed
-- balances remain authoritative; unresolved rows retain their original facts.
DROP INDEX IF EXISTS mbox.payments_one_active_intent_per_order_uq;
CREATE INDEX payments_unresolved_order_lookup_idx
  ON mbox.payments (tenant_id, store_id, order_id, created_at)
  WHERE status IN ('created','pending');

UPDATE mbox.normalized_schema_metadata SET schema_version='190',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
