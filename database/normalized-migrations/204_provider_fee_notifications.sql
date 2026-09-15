BEGIN;

-- Verified fee receipts never authorize payment/refund state or ledger changes.
-- No payment FK: the signed fee may arrive before the transaction result.
CREATE TABLE mbox.provider_fee_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'postar' CHECK (provider='postar'),
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 8 AND 256),
  integration_ref text NOT NULL CHECK (length(integration_ref) BETWEEN 3 AND 256),
  merchant_order_id text NOT NULL CHECK (length(merchant_order_id) BETWEEN 8 AND 128),
  provider_order_id text NOT NULL CHECK (length(provider_order_id) BETWEEN 1 AND 256),
  amount_minor bigint NOT NULL CHECK (amount_minor<>0 AND abs(amount_minor)<=9007199254740991),
  net_amount_minor bigint NOT NULL CHECK (abs(net_amount_minor)<=9007199254740991),
  fee_minor bigint NOT NULL CHECK (abs(fee_minor)<=9007199254740991),
  occurred_at timestamptz NOT NULL,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  UNIQUE (tenant_id,store_id,provider_event_id)
);
CREATE INDEX provider_fee_notifications_order_idx
  ON mbox.provider_fee_notifications(tenant_id,store_id,merchant_order_id,recorded_at DESC);
ALTER TABLE mbox.provider_fee_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.provider_fee_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.provider_fee_notifications
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
-- Append-only; no UPDATE/DELETE grant and no raw body, signature or customer data.
GRANT SELECT, INSERT ON mbox.provider_fee_notifications TO mbox_runtime;
COMMENT ON TABLE mbox.provider_fee_notifications IS
  'Signed Postar NOTIFY_TYPE=01 receipts; fee evidence only, never financial transition authority.';
UPDATE mbox.normalized_schema_metadata SET schema_version='204',updated_at=clock_timestamp()
  WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
