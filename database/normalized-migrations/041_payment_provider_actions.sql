BEGIN;

CREATE TABLE mbox.payment_provider_actions (
  payment_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  presentation text NOT NULL CHECK (presentation IN ('jsapi', 'qr', 'barcode')),
  initiated_by_type text NOT NULL CHECK (initiated_by_type IN ('employee', 'guest')),
  initiated_by_ref uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('creating', 'ready', 'unknown', 'failed', 'consumed')),
  ciphertext bytea,
  nonce bytea,
  auth_tag bytea,
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 20),
  last_error_code text,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_id) REFERENCES mbox.payments(tenant_id, store_id, id),
  CHECK (
    (state = 'ready' AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL)
    OR (state <> 'ready' AND ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL)
  ),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK (octet_length(COALESCE(nonce, ''::bytea)) IN (0, 12)),
  CHECK (octet_length(COALESCE(auth_tag, ''::bytea)) IN (0, 16)),
  UNIQUE (tenant_id, store_id, payment_id)
);

CREATE INDEX payment_provider_actions_expiry_idx
  ON mbox.payment_provider_actions (tenant_id, store_id, expires_at, payment_id);

CREATE TABLE mbox.wechat_payment_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  app_id text NOT NULL CHECK (length(btrim(app_id)) BETWEEN 6 AND 64),
  channel text NOT NULL CHECK (channel IN ('official_account', 'mini_program')),
  identity_hash char(64) NOT NULL CHECK (identity_hash ~ '^[0-9a-f]{64}$'),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  verified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  UNIQUE (tenant_id, store_id, customer_id, app_id, channel),
  UNIQUE (tenant_id, store_id, app_id, channel, identity_hash),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX wechat_payment_identities_customer_idx
  ON mbox.wechat_payment_identities (tenant_id, store_id, customer_id, app_id, channel, status);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['payment_provider_actions','wechat_payment_identities']
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) '
      'WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON TABLE mbox.payment_provider_actions TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.wechat_payment_identities TO mbox_runtime;

COMMENT ON TABLE mbox.payment_provider_actions IS
  'Short-lived encrypted provider presentation payload; never copy JSAPI signatures or QR payloads into logs or audit JSON.';
COMMENT ON TABLE mbox.wechat_payment_identities IS
  'Encrypted provider-issued WeChat payer identity, populated only after trusted OAuth or mini-program code exchange.';

COMMIT;
