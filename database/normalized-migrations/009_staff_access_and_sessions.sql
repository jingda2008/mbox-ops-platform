BEGIN;

ALTER TABLE mbox.employees
  ADD CONSTRAINT employees_pin_hash_secure_format_ck
  CHECK (pin_hash IS NULL OR pin_hash ~ '^(scrypt|argon2id)\$');

CREATE TABLE mbox.staff_permission_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  category text NOT NULL DEFAULT 'operations' CHECK (category ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.role_permission_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_id uuid NOT NULL,
  granted_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, role_id) REFERENCES mbox.roles(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, permission_id)
    REFERENCES mbox.staff_permission_definitions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, granted_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, role_id, permission_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.employee_permission_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  permission_id uuid NOT NULL,
  effect text NOT NULL CHECK (effect IN ('grant', 'deny')),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ends_at timestamptz,
  configured_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, permission_id)
    REFERENCES mbox.staff_permission_definitions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, configured_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  UNIQUE NULLS NOT DISTINCT (tenant_id, store_id, employee_id, permission_id, ends_at),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.role_data_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  role_id uuid NOT NULL,
  scope_key text NOT NULL CHECK (scope_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  effect text NOT NULL DEFAULT 'include' CHECK (effect IN ('include', 'exclude')),
  scope_value jsonb NOT NULL CHECK (jsonb_typeof(scope_value) IN ('object', 'array', 'string', 'number', 'boolean')),
  enabled boolean NOT NULL DEFAULT true,
  configured_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, role_id) REFERENCES mbox.roles(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, configured_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, role_id, scope_key, effect),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.role_approval_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  role_id uuid NOT NULL,
  approval_code text NOT NULL CHECK (approval_code ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rules) = 'object'),
  enabled boolean NOT NULL DEFAULT true,
  configured_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, role_id) REFERENCES mbox.roles(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, configured_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, role_id, approval_code, currency),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.role_navigation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  role_id uuid NOT NULL,
  navigation_code text NOT NULL CHECK (navigation_code ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  route text NOT NULL CHECK (route LIKE '/%'),
  icon text,
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  display_config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(display_config) = 'object'),
  configured_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, role_id) REFERENCES mbox.roles(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, configured_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, role_id, navigation_code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.store_daily_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  business_date date NOT NULL,
  credential_hash text NOT NULL CHECK (credential_hash ~ '^(scrypt|argon2id)\$'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  revoked_at timestamptz,
  configured_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, configured_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (valid_until > valid_from),
  CHECK (revoked_at IS NULL OR revoked_at >= valid_from),
  UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX store_daily_credentials_one_active_uq
  ON mbox.store_daily_credentials (tenant_id, store_id, business_date)
  WHERE revoked_at IS NULL;

CREATE TABLE mbox.store_device_access_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  daily_credential_id uuid NOT NULL,
  business_date date NOT NULL,
  device_key_hash char(64) NOT NULL CHECK (device_key_hash ~ '^[0-9a-f]{64}$'),
  lease_token_hash char(64) NOT NULL CHECK (lease_token_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, daily_credential_id)
    REFERENCES mbox.store_daily_credentials(tenant_id, store_id, id),
  CHECK (expires_at > issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  UNIQUE (tenant_id, store_id, lease_token_hash),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX store_device_access_leases_active_idx
  ON mbox.store_device_access_leases (tenant_id, store_id, business_date, device_key_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE mbox.staff_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  device_access_lease_id uuid NOT NULL,
  session_token_hash char(64) NOT NULL CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  online_lease_until timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_employee_id uuid,
  revoke_reason text,
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, device_access_lease_id)
    REFERENCES mbox.store_device_access_leases(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, revoked_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (expires_at = issued_at + interval '6 hours'),
  CHECK (online_lease_until >= issued_at AND online_lease_until <= expires_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK ((revoked_at IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND length(btrim(revoke_reason)) > 0)),
  UNIQUE (tenant_id, store_id, session_token_hash),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX staff_sessions_employee_active_idx
  ON mbox.staff_sessions (tenant_id, store_id, employee_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX staff_sessions_online_idx
  ON mbox.staff_sessions (tenant_id, store_id, online_lease_until, expires_at)
  WHERE revoked_at IS NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'staff_permission_definitions', 'role_permission_assignments',
    'employee_permission_overrides', 'role_data_scopes', 'role_approval_limits',
    'role_navigation_items'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at()',
      table_name,
      table_name
    );
  END LOOP;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'staff_permission_definitions', 'role_permission_assignments',
    'employee_permission_overrides', 'role_data_scopes', 'role_approval_limits',
    'role_navigation_items', 'store_daily_credentials',
    'store_device_access_leases', 'staff_sessions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) '
      'WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC', table_name);
  END LOOP;
END $$;

COMMENT ON TABLE mbox.staff_sessions IS
  'Six-hour employee sessions. Permission and employee status are resolved from live tables on every authorization check.';
COMMENT ON TABLE mbox.store_device_access_leases IS
  'Device-scoped proof of a valid daily store credential; switching employees still requires the target employee PIN.';
COMMENT ON COLUMN mbox.employees.pin_hash IS
  'Salted password hash only. Plaintext PIN values must never be persisted or emitted.';

COMMIT;
