BEGIN;

CREATE TABLE mbox.staff_login_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  attempt_kind text NOT NULL
    CHECK (attempt_kind IN ('daily_store_credential', 'employee_pin')),
  principal_hash char(64) NOT NULL CHECK (principal_hash ~ '^[0-9a-f]{64}$'),
  device_key_hash char(64) NOT NULL CHECK (device_key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CHECK (expires_at > window_started_at),
  UNIQUE (tenant_id, store_id, attempt_kind, principal_hash, device_key_hash),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX staff_login_rate_limits_expiry_idx
  ON mbox.staff_login_rate_limits (tenant_id, store_id, expires_at, id);

CREATE TRIGGER staff_login_rate_limits_touch_updated_at
  BEFORE UPDATE ON mbox.staff_login_rate_limits
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

ALTER TABLE mbox.staff_login_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.staff_login_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.staff_login_rate_limits
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

REVOKE ALL ON TABLE mbox.staff_login_rate_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mbox.staff_login_rate_limits TO mbox_runtime;

COMMENT ON TABLE mbox.staff_login_rate_limits IS
  'Short-lived authentication attempt windows. Principal values are HMAC hashed and plaintext credentials are never stored.';

COMMIT;
