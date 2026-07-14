BEGIN;

CREATE SCHEMA IF NOT EXISTS mbox;

CREATE OR REPLACE FUNCTION mbox.touch_versioned_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version = OLD.version THEN
    NEW.version := OLD.version + 1;
  ELSIF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'version must advance by exactly one (old %, new %)', OLD.version, NEW.version
      USING ERRCODE = '40001';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TABLE mbox.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT tenants_code_format CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  CONSTRAINT tenants_code_uq UNIQUE (code)
);

CREATE TRIGGER tenants_touch_version
BEFORE UPDATE ON mbox.tenants
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES mbox.tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'closed')),
  timezone text NOT NULL,
  business_day_cutoff time without time zone NOT NULL DEFAULT TIME '06:00:00',
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT stores_code_format CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  CONSTRAINT stores_tenant_code_uq UNIQUE (tenant_id, code),
  CONSTRAINT stores_tenant_id_uq UNIQUE (tenant_id, id)
);

CREATE INDEX stores_tenant_status_idx ON mbox.stores (tenant_id, status);

CREATE TRIGGER stores_touch_version
BEFORE UPDATE ON mbox.stores
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  short_name text NOT NULL,
  area_type text NOT NULL
    CHECK (area_type IN ('lounge', 'interactive', 'general', 'booth', 'bar', 'stage', 'other')),
  color text,
  map_geometry jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(map_geometry) = 'object'),
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT areas_code_format CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
  CONSTRAINT areas_tenant_store_code_uq UNIQUE (tenant_id, store_id, code),
  CONSTRAINT areas_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX areas_store_sort_idx ON mbox.areas (tenant_id, store_id, sort_order, id);

CREATE TRIGGER areas_touch_version
BEFORE UPDATE ON mbox.areas
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.venue_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  area_id uuid NOT NULL,
  code text NOT NULL,
  display_name text NOT NULL,
  capacity integer NOT NULL CHECK (capacity > 0 AND capacity <= 100),
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'occupied', 'reserved', 'paused', 'retired')),
  qr_token_version integer NOT NULL DEFAULT 1 CHECK (qr_token_version > 0),
  map_geometry jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(map_geometry) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, area_id) REFERENCES mbox.areas(tenant_id, store_id, id),
  CONSTRAINT venue_tables_code_format CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
  CONSTRAINT venue_tables_tenant_store_code_uq UNIQUE (tenant_id, store_id, code),
  CONSTRAINT venue_tables_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX venue_tables_area_status_idx
  ON mbox.venue_tables (tenant_id, store_id, area_id, status);

CREATE TRIGGER venue_tables_touch_version
BEFORE UPDATE ON mbox.venue_tables
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  employee_code text NOT NULL,
  display_name text NOT NULL,
  initials text NOT NULL,
  contact_ref text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'suspended', 'departed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT employees_code_format CHECK (employee_code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT employees_tenant_store_code_uq UNIQUE (tenant_id, store_id, employee_code),
  CONSTRAINT employees_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX employees_store_status_idx ON mbox.employees (tenant_id, store_id, status);

CREATE TRIGGER employees_touch_version
BEFORE UPDATE ON mbox.employees
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  max_concurrent_tasks integer NOT NULL DEFAULT 1
    CHECK (max_concurrent_tasks BETWEEN 1 AND 20),
  can_receive_tasks boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT roles_code_format CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT roles_tenant_store_code_uq UNIQUE (tenant_id, store_id, code),
  CONSTRAINT roles_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE TRIGGER roles_touch_version
BEFORE UPDATE ON mbox.roles
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  business_date date NOT NULL,
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'open', 'closed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT shifts_time_order CHECK (ends_at > starts_at),
  CONSTRAINT shifts_tenant_store_name_start_uq UNIQUE (tenant_id, store_id, name, starts_at),
  CONSTRAINT shifts_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX shifts_store_business_date_idx
  ON mbox.shifts (tenant_id, store_id, business_date, starts_at);

CREATE TRIGGER shifts_touch_version
BEFORE UPDATE ON mbox.shifts
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.shift_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  role_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'checked_in', 'paused', 'checked_out', 'cancelled')),
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, shift_id) REFERENCES mbox.shifts(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, role_id) REFERENCES mbox.roles(tenant_id, store_id, id),
  CONSTRAINT shift_assignments_checkout_order
    CHECK (checked_out_at IS NULL OR (checked_in_at IS NOT NULL AND checked_out_at >= checked_in_at)),
  CONSTRAINT shift_assignments_employee_role_uq
    UNIQUE (tenant_id, store_id, shift_id, employee_id, role_id),
  CONSTRAINT shift_assignments_tenant_store_id_uq UNIQUE (tenant_id, store_id, id),
  CONSTRAINT shift_assignments_tenant_store_id_shift_uq UNIQUE (tenant_id, store_id, id, shift_id)
);

CREATE INDEX shift_assignments_live_idx
  ON mbox.shift_assignments (tenant_id, store_id, shift_id, status, employee_id);

CREATE TRIGGER shift_assignments_touch_version
BEFORE UPDATE ON mbox.shift_assignments
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.assignment_responsibilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('store', 'area', 'table')),
  area_id uuid,
  table_id uuid,
  is_primary boolean NOT NULL DEFAULT false,
  priority smallint NOT NULL DEFAULT 100 CHECK (priority >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, shift_id) REFERENCES mbox.shifts(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, assignment_id, shift_id)
    REFERENCES mbox.shift_assignments(tenant_id, store_id, id, shift_id),
  FOREIGN KEY (tenant_id, store_id, area_id) REFERENCES mbox.areas(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_id) REFERENCES mbox.venue_tables(tenant_id, store_id, id),
  CONSTRAINT assignment_responsibilities_scope_check CHECK (
    (scope_type = 'store' AND area_id IS NULL AND table_id IS NULL) OR
    (scope_type = 'area' AND area_id IS NOT NULL AND table_id IS NULL) OR
    (scope_type = 'table' AND area_id IS NULL AND table_id IS NOT NULL)
  ),
  CONSTRAINT assignment_responsibilities_uq
    UNIQUE NULLS NOT DISTINCT (tenant_id, store_id, shift_id, assignment_id, scope_type, area_id, table_id),
  CONSTRAINT assignment_responsibilities_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX assignment_primary_store_uq
  ON mbox.assignment_responsibilities (tenant_id, store_id, shift_id)
  WHERE scope_type = 'store' AND is_primary;
CREATE UNIQUE INDEX assignment_primary_area_uq
  ON mbox.assignment_responsibilities (tenant_id, store_id, shift_id, area_id)
  WHERE scope_type = 'area' AND is_primary;
CREATE UNIQUE INDEX assignment_primary_table_uq
  ON mbox.assignment_responsibilities (tenant_id, store_id, shift_id, table_id)
  WHERE scope_type = 'table' AND is_primary;
CREATE INDEX assignment_responsibility_dispatch_idx
  ON mbox.assignment_responsibilities (tenant_id, store_id, shift_id, scope_type, priority, assignment_id);

CREATE TABLE mbox.table_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_id uuid NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'transferred', 'closing', 'closed', 'cancelled')),
  guest_count integer NOT NULL DEFAULT 0 CHECK (guest_count BETWEEN 0 AND 100),
  owner_assignment_id uuid,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  opened_by_employee_id uuid,
  closed_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_id) REFERENCES mbox.venue_tables(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, owner_assignment_id)
    REFERENCES mbox.shift_assignments(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, opened_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, closed_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT table_sessions_closed_order CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CONSTRAINT table_sessions_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX table_sessions_one_live_per_table_uq
  ON mbox.table_sessions (tenant_id, store_id, table_id)
  WHERE status IN ('open', 'transferred', 'closing');
CREATE INDEX table_sessions_business_date_idx
  ON mbox.table_sessions (tenant_id, store_id, business_date, status, opened_at DESC);

CREATE TRIGGER table_sessions_touch_version
BEFORE UPDATE ON mbox.table_sessions
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  config_kind text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('store', 'area', 'business_date', 'shift')),
  scope_ref text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'published', 'retired', 'rejected')),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  document_sha256 char(64) NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  based_on_version_id uuid,
  effective_at timestamptz,
  created_by_employee_id uuid,
  approved_by_employee_id uuid,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, based_on_version_id)
    REFERENCES mbox.config_versions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT config_versions_kind_format CHECK (config_kind ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT config_versions_scope_ref_nonempty CHECK (length(btrim(scope_ref)) > 0),
  CONSTRAINT config_versions_publish_fields CHECK (
    status <> 'published' OR (published_at IS NOT NULL AND effective_at IS NOT NULL)
  ),
  CONSTRAINT config_versions_scope_version_uq
    UNIQUE (tenant_id, store_id, config_kind, scope_type, scope_ref, version),
  CONSTRAINT config_versions_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX config_versions_one_draft_uq
  ON mbox.config_versions (tenant_id, store_id, config_kind, scope_type, scope_ref)
  WHERE status = 'draft';
CREATE INDEX config_versions_effective_idx
  ON mbox.config_versions (tenant_id, store_id, config_kind, status, effective_at DESC);

CREATE OR REPLACE FUNCTION mbox.touch_config_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.row_version = OLD.row_version THEN
    NEW.row_version := OLD.row_version + 1;
  ELSIF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'row_version must advance by exactly one'
      USING ERRCODE = '40001';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER config_versions_touch
BEFORE UPDATE ON mbox.config_versions
FOR EACH ROW EXECUTE FUNCTION mbox.touch_config_version();

CREATE OR REPLACE FUNCTION mbox.validate_config_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'retired')) OR
    (OLD.status = 'pending_approval' AND NEW.status IN ('draft', 'published', 'rejected')) OR
    (OLD.status = 'published' AND NEW.status = 'retired') OR
    (OLD.status = 'rejected' AND NEW.status IN ('draft', 'retired'))
  ) THEN
    RAISE EXCEPTION 'invalid configuration transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER config_versions_validate_transition
BEFORE UPDATE OF status ON mbox.config_versions
FOR EACH ROW EXECUTE FUNCTION mbox.validate_config_transition();

CREATE TABLE mbox.service_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  table_id uuid NOT NULL,
  service_type_code text NOT NULL,
  service_type_name text NOT NULL,
  source text NOT NULL CHECK (source IN ('guest', 'employee', 'system')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'arrived', 'completed', 'confirmed', 'reopened', 'escalated', 'cancelled')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  owner_assignment_id uuid,
  warning_at timestamptz NOT NULL,
  escalate_at timestamptz NOT NULL,
  manager_at timestamptz NOT NULL,
  escalation_level smallint NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 9),
  config_version_id uuid NOT NULL,
  customer_reply text NOT NULL DEFAULT '',
  action_script jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(action_script) = 'array'),
  resolution text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  accepted_at timestamptz,
  arrived_at timestamptz,
  completed_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_id) REFERENCES mbox.venue_tables(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, owner_assignment_id)
    REFERENCES mbox.shift_assignments(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, config_version_id)
    REFERENCES mbox.config_versions(tenant_id, store_id, id),
  CONSTRAINT service_tasks_sla_order CHECK (warning_at < escalate_at AND escalate_at < manager_at),
  CONSTRAINT service_tasks_type_code_format CHECK (service_type_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT service_tasks_idempotency_uq UNIQUE (tenant_id, store_id, idempotency_key),
  CONSTRAINT service_tasks_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX service_tasks_live_queue_idx
  ON mbox.service_tasks (tenant_id, store_id, status, priority, escalate_at)
  WHERE status NOT IN ('confirmed', 'cancelled');
CREATE INDEX service_tasks_owner_live_idx
  ON mbox.service_tasks (tenant_id, store_id, owner_assignment_id, status, created_at)
  WHERE owner_assignment_id IS NOT NULL AND status NOT IN ('confirmed', 'cancelled');
CREATE INDEX service_tasks_table_timeline_idx
  ON mbox.service_tasks (tenant_id, store_id, table_session_id, created_at DESC);

CREATE OR REPLACE FUNCTION mbox.validate_service_task_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('accepted', 'escalated', 'cancelled')) OR
    (OLD.status = 'accepted' AND NEW.status IN ('arrived', 'escalated', 'cancelled')) OR
    (OLD.status = 'arrived' AND NEW.status IN ('completed', 'escalated')) OR
    (OLD.status = 'escalated' AND NEW.status IN ('accepted', 'cancelled')) OR
    (OLD.status = 'completed' AND NEW.status IN ('confirmed', 'reopened')) OR
    (OLD.status = 'reopened' AND NEW.status = 'escalated')
  ) THEN
    RAISE EXCEPTION 'invalid service task transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER service_tasks_validate_transition
BEFORE UPDATE OF status ON mbox.service_tasks
FOR EACH ROW EXECUTE FUNCTION mbox.validate_service_task_transition();

CREATE TRIGGER service_tasks_touch_version
BEFORE UPDATE ON mbox.service_tasks
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

CREATE TABLE mbox.service_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  task_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_type text NOT NULL CHECK (actor_type IN ('guest', 'employee', 'system', 'integration')),
  actor_employee_id uuid,
  actor_ref text,
  request_id text,
  trace_id text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  business_date date NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, task_id) REFERENCES mbox.service_tasks(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT service_task_events_actor_check CHECK (
    (actor_type = 'employee' AND actor_employee_id IS NOT NULL) OR
    (actor_type <> 'employee' AND actor_employee_id IS NULL)
  ),
  CONSTRAINT service_task_events_type_format CHECK (event_type ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  CONSTRAINT service_task_events_status_values CHECK (
    (from_status IS NULL OR from_status IN ('pending', 'accepted', 'arrived', 'completed', 'confirmed', 'reopened', 'escalated', 'cancelled')) AND
    (to_status IS NULL OR to_status IN ('pending', 'accepted', 'arrived', 'completed', 'confirmed', 'reopened', 'escalated', 'cancelled'))
  ),
  CONSTRAINT service_task_events_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX service_task_events_task_timeline_idx
  ON mbox.service_task_events (tenant_id, store_id, task_id, occurred_at, id);
CREATE INDEX service_task_events_business_date_idx
  ON mbox.service_task_events (tenant_id, store_id, business_date, event_type, occurred_at);

COMMIT;
