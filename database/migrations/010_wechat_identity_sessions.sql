BEGIN;

ALTER TABLE mbox.wechat_auth_challenges
  ADD COLUMN idempotency_key_sha256 char(64),
  ADD COLUMN request_fingerprint varchar(64),
  ADD COLUMN response_ciphertext bytea,
  ADD COLUMN response_key_version integer,
  ADD CONSTRAINT wechat_auth_challenges_idempotency_hash_check CHECK (
    idempotency_key_sha256 IS NULL OR idempotency_key_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT wechat_auth_challenges_request_fingerprint_check CHECK (
    request_fingerprint IS NULL OR request_fingerprint ~ '^[A-Za-z0-9_-]{43}$'
  ),
  ADD CONSTRAINT wechat_auth_challenges_response_envelope_check CHECK (
    (idempotency_key_sha256 IS NULL AND request_fingerprint IS NULL
      AND response_ciphertext IS NULL AND response_key_version IS NULL)
    OR
    (idempotency_key_sha256 IS NOT NULL AND request_fingerprint IS NOT NULL
      AND octet_length(response_ciphertext) >= 29 AND response_key_version > 0)
  );

CREATE UNIQUE INDEX wechat_auth_challenges_idempotency_uq
  ON mbox.wechat_auth_challenges (tenant_id, store_id, app_id, idempotency_key_sha256)
  WHERE idempotency_key_sha256 IS NOT NULL;

ALTER TABLE mbox.wechat_identities
  ADD COLUMN external_identity_id text,
  ADD COLUMN member_id uuid,
  ADD COLUMN openid_key_version integer NOT NULL DEFAULT 1,
  ADD COLUMN unionid_key_version integer,
  ADD COLUMN last_authenticated_at timestamptz NOT NULL DEFAULT clock_timestamp();

UPDATE mbox.wechat_identities
SET external_identity_id = id::text
WHERE external_identity_id IS NULL;

ALTER TABLE mbox.wechat_identities
  ALTER COLUMN external_identity_id SET NOT NULL,
  ADD CONSTRAINT wechat_identities_external_id_format CHECK (
    length(btrim(external_identity_id)) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT wechat_identities_openid_key_version_check CHECK (openid_key_version > 0),
  ADD CONSTRAINT wechat_identities_union_key_version_check CHECK (
    (unionid_sha256 IS NULL AND unionid_ciphertext IS NULL AND unionid_key_version IS NULL)
    OR
    (unionid_sha256 IS NOT NULL AND unionid_ciphertext IS NOT NULL AND unionid_key_version > 0)
  ),
  ADD CONSTRAINT wechat_identities_tenant_store_id_uq UNIQUE (tenant_id, store_id, id),
  ADD CONSTRAINT wechat_identities_tenant_store_external_id_uq
    UNIQUE (tenant_id, store_id, external_identity_id),
  ADD CONSTRAINT wechat_identities_member_fk
    FOREIGN KEY (tenant_id, store_id, member_id)
    REFERENCES mbox.customer_members(tenant_id, store_id, id);

CREATE INDEX wechat_identities_principal_active_idx
  ON mbox.wechat_identities (tenant_id, store_id, principal_id, app_id)
  WHERE revoked_at IS NULL;

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
  CONSTRAINT wechat_identity_sessions_token_uq
    UNIQUE (tenant_id, store_id, access_token_sha256),
  CONSTRAINT wechat_identity_sessions_tenant_store_id_uq
    UNIQUE (tenant_id, store_id, id),
  CONSTRAINT wechat_identity_sessions_expiry_order CHECK (expires_at > issued_at),
  CONSTRAINT wechat_identity_sessions_revocation_shape CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL)
    OR
    (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL AND revoked_at >= issued_at)
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
  CONSTRAINT wechat_authentication_replays_idempotency_uq
    UNIQUE (tenant_id, store_id, app_id, idempotency_key_sha256),
  CONSTRAINT wechat_authentication_replays_tenant_store_id_uq
    UNIQUE (tenant_id, store_id, id),
  CONSTRAINT wechat_authentication_replays_expiry_order CHECK (expires_at > created_at)
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
  CONSTRAINT wechat_identity_mutation_replays_idempotency_uq
    UNIQUE (tenant_id, store_id, operation, principal_id, idempotency_key_sha256),
  CONSTRAINT wechat_identity_mutation_replays_tenant_store_id_uq
    UNIQUE (tenant_id, store_id, id),
  CONSTRAINT wechat_identity_mutation_replays_expiry_order CHECK (expires_at > created_at)
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
    REFERENCES mbox.customer_members(tenant_id, store_id, id),
  CONSTRAINT wechat_member_binding_grants_token_uq
    UNIQUE (tenant_id, store_id, grant_token_sha256),
  CONSTRAINT wechat_member_binding_grants_tenant_store_id_uq
    UNIQUE (tenant_id, store_id, id),
  CONSTRAINT wechat_member_binding_grants_expiry_order CHECK (expires_at > created_at),
  CONSTRAINT wechat_member_binding_grants_consumption_shape CHECK (
    (consumed_at IS NULL AND consumed_by_principal_id IS NULL)
    OR
    (consumed_at IS NOT NULL AND consumed_by_principal_id IS NOT NULL
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
  END LOOP;
END;
$$;

-- Reassert FORCE RLS on the two 008 tables extended by this migration.
ALTER TABLE mbox.wechat_auth_challenges FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.wechat_identities FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE mbox.wechat_identity_sessions IS
  'Mini-program bearer sessions. Only SHA-256 token digests and AES-256-GCM encrypted principals are persisted.';
COMMENT ON TABLE mbox.wechat_authentication_replays IS
  'Encrypted authentication responses used for scoped idempotent replay until session expiry.';
COMMENT ON TABLE mbox.wechat_member_binding_grants IS
  'Single-use, tenant/store/member-bound grants. Raw grant tokens are never persisted.';

COMMIT;
