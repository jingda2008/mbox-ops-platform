BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS mbox;

CREATE OR REPLACE FUNCTION mbox.current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION mbox.current_store_id()
RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.store_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION mbox.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mbox.reject_row_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TABLE mbox.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE mbox.stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES mbox.tenants(id),
  code text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  business_day_cutoff time NOT NULL DEFAULT TIME '06:00',
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE mbox.areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  area_type text NOT NULL CHECK (area_type IN ('indoor', 'outdoor', 'bar', 'stage', 'vip', 'other')),
  sort_order integer NOT NULL DEFAULT 0,
  layout_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(layout_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  area_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  capacity integer NOT NULL CHECK (capacity > 0 AND capacity <= 200),
  minimum_spend_minor bigint CHECK (minimum_spend_minor IS NULL OR minimum_spend_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  qr_version integer NOT NULL DEFAULT 1 CHECK (qr_version > 0),
  layout_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(layout_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'paused', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, area_id) REFERENCES mbox.areas(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  employee_code text NOT NULL CHECK (employee_code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  pin_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'departed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, employee_code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  can_receive_tasks boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.employee_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  role_id uuid NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ends_at timestamptz,
  granted_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, role_id) REFERENCES mbox.roles(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, granted_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  UNIQUE NULLS NOT DISTINCT (tenant_id, store_id, employee_id, role_id, ends_at),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.table_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  role_id uuid NOT NULL,
  assignment_type text NOT NULL DEFAULT 'primary' CHECK (assignment_type IN ('primary', 'backup', 'temporary')),
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ends_at timestamptz,
  created_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_id) REFERENCES mbox.tables(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, role_id) REFERENCES mbox.roles(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX table_assignments_one_active_primary_uq
  ON mbox.table_assignments (tenant_id, store_id, table_id)
  WHERE assignment_type = 'primary' AND ends_at IS NULL;
CREATE INDEX table_assignments_employee_active_idx
  ON mbox.table_assignments (tenant_id, store_id, employee_id, table_id)
  WHERE ends_at IS NULL;

CREATE TABLE mbox.table_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  business_date date NOT NULL,
  guest_count integer NOT NULL CHECK (guest_count > 0 AND guest_count <= 200),
  guest_profile_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(guest_profile_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closing', 'closed', 'cancelled')),
  opened_by_employee_id uuid,
  closed_by_employee_id uuid,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_id) REFERENCES mbox.tables(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, opened_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, closed_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (closed_at IS NULL OR closed_at >= opened_at),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, id, table_id)
);

CREATE UNIQUE INDEX table_sessions_one_active_table_uq
  ON mbox.table_sessions (tenant_id, store_id, table_id)
  WHERE status IN ('open', 'closing');
CREATE INDEX table_sessions_business_date_idx
  ON mbox.table_sessions (tenant_id, store_id, business_date, status, opened_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['tenants','stores','areas','tables','employees','roles','table_sessions']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at()', table_name, table_name);
  END LOOP;
END $$;

COMMIT;
