BEGIN;

CREATE TABLE mbox.runtime_states (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  state_sha256 char(64) NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT runtime_states_revision_matches_document CHECK (
    (state ->> 'revision') ~ '^[1-9][0-9]*$'
    AND (state ->> 'revision')::bigint = revision
  )
);

COMMENT ON TABLE mbox.runtime_states IS
  'Compatibility aggregate for the current API contract. Normalized financial and audit records remain authoritative.';

CREATE TABLE mbox.wechat_auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  app_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('mini_program', 'service_account', 'wecom')),
  state_sha256 char(64) NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  nonce_sha256 char(64) NOT NULL CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  redirect_path text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT wechat_auth_challenges_state_uq UNIQUE (tenant_id, store_id, app_id, state_sha256),
  CONSTRAINT wechat_auth_challenges_expiry CHECK (expires_at > created_at),
  CONSTRAINT wechat_auth_challenges_consumed CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX wechat_auth_challenges_expiry_idx
  ON mbox.wechat_auth_challenges (tenant_id, store_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE mbox.wechat_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('member', 'employee', 'guest')),
  principal_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('mini_program', 'service_account', 'wecom')),
  app_id text NOT NULL,
  openid_sha256 char(64) NOT NULL CHECK (openid_sha256 ~ '^[0-9a-f]{64}$'),
  openid_ciphertext bytea NOT NULL,
  unionid_sha256 char(64) CHECK (unionid_sha256 IS NULL OR unionid_sha256 ~ '^[0-9a-f]{64}$'),
  unionid_ciphertext bytea,
  consent_version text NOT NULL,
  consented_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT wechat_identities_openid_uq UNIQUE (tenant_id, store_id, channel, app_id, openid_sha256),
  CONSTRAINT wechat_identities_principal_uq UNIQUE (tenant_id, store_id, principal_type, principal_id, channel, app_id),
  CONSTRAINT wechat_identities_union_cipher_pair CHECK (
    (unionid_sha256 IS NULL AND unionid_ciphertext IS NULL) OR
    (unionid_sha256 IS NOT NULL AND unionid_ciphertext IS NOT NULL)
  ),
  CONSTRAINT wechat_identities_revoked_order CHECK (revoked_at IS NULL OR revoked_at >= consented_at)
);

CREATE INDEX wechat_identities_union_idx
  ON mbox.wechat_identities (tenant_id, store_id, unionid_sha256)
  WHERE unionid_sha256 IS NOT NULL AND revoked_at IS NULL;

CREATE TRIGGER wechat_identities_touch_version
BEFORE UPDATE ON mbox.wechat_identities
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.payment_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  provider text NOT NULL,
  merchant_id text NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed', 'blocked')),
  provider_file_sha256 char(64) CHECK (provider_file_sha256 IS NULL OR provider_file_sha256 ~ '^[0-9a-f]{64}$'),
  matched_count integer NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  difference_count integer NOT NULL DEFAULT 0 CHECK (difference_count >= 0),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT payment_reconciliation_runs_day_uq UNIQUE (tenant_id, store_id, provider, merchant_id, business_date),
  CONSTRAINT payment_reconciliation_runs_tenant_store_id_uq UNIQUE (tenant_id, store_id, id),
  CONSTRAINT payment_reconciliation_runs_completion CHECK (
    (status IN ('completed', 'failed', 'blocked') AND completed_at IS NOT NULL) OR status = 'processing'
  )
);

CREATE TRIGGER payment_reconciliation_runs_touch_version
BEFORE UPDATE ON mbox.payment_reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.payment_reconciliation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  run_id uuid NOT NULL,
  provider_transaction_id text NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('payment', 'refund')),
  difference_type text NOT NULL CHECK (difference_type IN (
    'matched', 'provider_only', 'internal_only', 'duplicate_provider_entry',
    'amount_mismatch', 'currency_mismatch', 'status_mismatch'
  )),
  manual_status text NOT NULL CHECK (manual_status IN ('not_required', 'pending', 'investigating', 'resolved')),
  resolution text CHECK (resolution IN ('provider_corrected', 'internal_corrected', 'accepted_exception')),
  internal_entry jsonb,
  provider_entry jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, run_id)
    REFERENCES mbox.payment_reconciliation_runs(tenant_id, store_id, id),
  CONSTRAINT payment_reconciliation_items_tenant_store_id_uq UNIQUE (tenant_id, store_id, id),
  CONSTRAINT payment_reconciliation_items_manual_state CHECK (
    (manual_status = 'resolved' AND resolution IS NOT NULL) OR
    (manual_status <> 'resolved' AND resolution IS NULL)
  )
);

CREATE INDEX payment_reconciliation_items_queue_idx
  ON mbox.payment_reconciliation_items (tenant_id, store_id, manual_status, created_at)
  WHERE manual_status IN ('pending', 'investigating');

CREATE TRIGGER payment_reconciliation_items_touch_version
BEFORE UPDATE ON mbox.payment_reconciliation_items
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.payment_reconciliation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  run_id uuid NOT NULL,
  item_id uuid,
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('employee', 'system', 'integration')),
  actor_ref text NOT NULL,
  reason text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, run_id)
    REFERENCES mbox.payment_reconciliation_runs(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, item_id)
    REFERENCES mbox.payment_reconciliation_items(tenant_id, store_id, id)
);

CREATE INDEX payment_reconciliation_events_timeline_idx
  ON mbox.payment_reconciliation_events (tenant_id, store_id, run_id, occurred_at, id);

CREATE TRIGGER payment_reconciliation_events_append_only
BEFORE UPDATE OR DELETE ON mbox.payment_reconciliation_events
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'runtime_states',
    'wechat_auth_challenges',
    'wechat_identities',
    'payment_reconciliation_runs',
    'payment_reconciliation_items',
    'payment_reconciliation_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;
