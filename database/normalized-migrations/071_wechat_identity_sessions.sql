BEGIN;

CREATE TABLE mbox.wechat_auth_challenges (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  app_id text NOT NULL CHECK (length(btrim(app_id)) BETWEEN 3 AND 128),
  channel text NOT NULL DEFAULT 'mini_program' CHECK (channel = 'mini_program'),
  state_sha256 char(64) NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  nonce_sha256 char(64) NOT NULL CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key_sha256 char(64) NOT NULL CHECK (idempotency_key_sha256 ~ '^[0-9a-f]{64}$'),
  request_fingerprint varchar(64) NOT NULL CHECK (request_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  response_ciphertext bytea NOT NULL CHECK (octet_length(response_ciphertext) >= 29),
  response_key_version integer NOT NULL CHECK (response_key_version > 0),
  redirect_path text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, app_id, state_sha256),
  UNIQUE (tenant_id, store_id, app_id, idempotency_key_sha256),
  UNIQUE (tenant_id, store_id, id),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX wechat_auth_challenges_expiry_idx
  ON mbox.wechat_auth_challenges (tenant_id, store_id, expires_at, id)
  WHERE consumed_at IS NULL;

CREATE TABLE mbox.wechat_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  external_identity_id text NOT NULL CHECK (length(btrim(external_identity_id)) BETWEEN 1 AND 200),
  principal_type text NOT NULL CHECK (principal_type IN ('guest', 'member')),
  principal_id text NOT NULL CHECK (length(btrim(principal_id)) BETWEEN 8 AND 200),
  channel text NOT NULL DEFAULT 'mini_program' CHECK (channel = 'mini_program'),
  app_id text NOT NULL CHECK (length(btrim(app_id)) BETWEEN 3 AND 128),
  openid_sha256 char(64) NOT NULL CHECK (openid_sha256 ~ '^[0-9a-f]{64}$'),
  openid_ciphertext bytea NOT NULL CHECK (octet_length(openid_ciphertext) >= 29),
  openid_key_version integer NOT NULL CHECK (openid_key_version > 0),
  unionid_sha256 char(64) CHECK (unionid_sha256 IS NULL OR unionid_sha256 ~ '^[0-9a-f]{64}$'),
  unionid_ciphertext bytea,
  unionid_key_version integer,
  member_id uuid,
  consent_version text NOT NULL CHECK (length(btrim(consent_version)) BETWEEN 3 AND 128),
  consented_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_authenticated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, member_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, external_identity_id),
  UNIQUE (tenant_id, store_id, channel, app_id, openid_sha256),
  UNIQUE (tenant_id, store_id, id),
  CHECK (
    (unionid_sha256 IS NULL AND unionid_ciphertext IS NULL AND unionid_key_version IS NULL)
    OR (unionid_sha256 IS NOT NULL AND unionid_ciphertext IS NOT NULL AND unionid_key_version > 0)
  ),
  CHECK ((member_id IS NULL AND principal_type = 'guest') OR (member_id IS NOT NULL AND principal_type = 'member')),
  CHECK (revoked_at IS NULL OR revoked_at >= consented_at)
);

CREATE INDEX wechat_identities_principal_active_idx
  ON mbox.wechat_identities (tenant_id, store_id, principal_id, app_id)
  WHERE revoked_at IS NULL;
CREATE INDEX wechat_identities_union_active_idx
  ON mbox.wechat_identities (tenant_id, store_id, unionid_sha256)
  WHERE unionid_sha256 IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE mbox.wechat_identity_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  app_id text NOT NULL,
  identity_external_id text NOT NULL,
  principal_id text NOT NULL,
  access_token_sha256 varchar(43) NOT NULL CHECK (access_token_sha256 ~ '^[A-Za-z0-9_-]{43}$'),
  principal_ciphertext bytea NOT NULL CHECK (octet_length(principal_ciphertext) >= 29),
  principal_key_version integer NOT NULL CHECK (principal_key_version > 0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text CHECK (revocation_reason IN ('logout', 'authorization_revoked', 'administrative')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, identity_external_id)
    REFERENCES mbox.wechat_identities(tenant_id, store_id, external_identity_id),
  UNIQUE (tenant_id, store_id, access_token_sha256),
  UNIQUE (tenant_id, store_id, id),
  CHECK (expires_at > issued_at),
  CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL AND revoked_at >= issued_at)
  )
);

CREATE INDEX wechat_identity_sessions_principal_active_idx
  ON mbox.wechat_identity_sessions (tenant_id, store_id, principal_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX wechat_identity_sessions_expiry_idx
  ON mbox.wechat_identity_sessions (tenant_id, store_id, expires_at, id);

CREATE TABLE mbox.wechat_authentication_replays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  app_id text NOT NULL,
  idempotency_key_sha256 char(64) NOT NULL CHECK (idempotency_key_sha256 ~ '^[0-9a-f]{64}$'),
  request_fingerprint varchar(64) NOT NULL CHECK (request_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  identity_external_id text NOT NULL,
  principal_id text NOT NULL,
  response_ciphertext bytea NOT NULL CHECK (octet_length(response_ciphertext) >= 29),
  response_key_version integer NOT NULL CHECK (response_key_version > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, identity_external_id)
    REFERENCES mbox.wechat_identities(tenant_id, store_id, external_identity_id),
  UNIQUE (tenant_id, store_id, app_id, idempotency_key_sha256),
  UNIQUE (tenant_id, store_id, id),
  CHECK (expires_at > created_at)
);

CREATE INDEX wechat_authentication_replays_principal_idx
  ON mbox.wechat_authentication_replays (tenant_id, store_id, principal_id, expires_at);

CREATE TABLE mbox.wechat_identity_mutation_replays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('logout', 'unbind', 'revoke')),
  principal_id text NOT NULL,
  idempotency_key_sha256 char(64) NOT NULL CHECK (idempotency_key_sha256 ~ '^[0-9a-f]{64}$'),
  request_fingerprint varchar(64) NOT NULL CHECK (request_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  result_ciphertext bytea NOT NULL CHECK (octet_length(result_ciphertext) >= 29),
  result_key_version integer NOT NULL CHECK (result_key_version > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, operation, principal_id, idempotency_key_sha256),
  UNIQUE (tenant_id, store_id, id),
  CHECK (expires_at > created_at)
);

CREATE INDEX wechat_identity_mutation_replays_expiry_idx
  ON mbox.wechat_identity_mutation_replays (tenant_id, store_id, expires_at, id);

CREATE TABLE mbox.wechat_member_binding_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  member_id uuid NOT NULL,
  grant_token_sha256 varchar(43) NOT NULL CHECK (grant_token_sha256 ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_principal_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, member_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, grant_token_sha256),
  UNIQUE (tenant_id, store_id, id),
  CHECK (expires_at > created_at),
  CHECK (
    (consumed_at IS NULL AND consumed_by_principal_id IS NULL)
    OR (consumed_at IS NOT NULL AND consumed_by_principal_id IS NOT NULL
      AND consumed_at >= created_at AND consumed_at < expires_at)
  )
);

CREATE INDEX wechat_member_binding_grants_expiry_idx
  ON mbox.wechat_member_binding_grants (tenant_id, store_id, expires_at, id);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'wechat_auth_challenges',
    'wechat_identities',
    'wechat_identity_sessions',
    'wechat_authentication_replays',
    'wechat_identity_mutation_replays',
    'wechat_member_binding_grants'
  ]
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mbox.%I TO mbox_runtime', table_name);
  END LOOP;
END;
$$;

REVOKE UPDATE, DELETE ON TABLE mbox.wechat_identities FROM mbox_runtime;
GRANT UPDATE (principal_type, member_id, openid_ciphertext, openid_key_version,
  unionid_sha256, unionid_ciphertext, unionid_key_version, consent_version,
  consented_at, revoked_at, last_authenticated_at, updated_at)
  ON TABLE mbox.wechat_identities TO mbox_runtime;
REVOKE DELETE ON TABLE mbox.wechat_identities FROM mbox_runtime;

COMMENT ON TABLE mbox.wechat_identities IS
  'Encrypted WeChat identity facts. OpenID and UnionID plaintext never persist; business code uses normalized customer identities.';
COMMENT ON TABLE mbox.wechat_identity_sessions IS
  'Short-lived WeChat bearer sessions. Only SHA-256 token digests and encrypted principal envelopes persist.';

COMMIT;
