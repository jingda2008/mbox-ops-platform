BEGIN;

CREATE TABLE mbox.guest_behavior_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  behavior_type text NOT NULL CHECK (behavior_type ~ '^guest\.[a-z0-9_.-]{2,96}$'),
  behavior_code text CHECK (
    behavior_code IS NULL OR behavior_code ~ '^[a-z][a-z0-9_.-]{0,63}$'
  ),
  behavior_data jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(behavior_data) = 'object'),
  actor_ref_hash char(64) NOT NULL CHECK (actor_ref_hash ~ '^[0-9a-f]{64}$'),
  device_hash char(64) NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id, customer_id)
    REFERENCES mbox.table_session_customers(tenant_id, store_id, table_session_id, customer_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX guest_behavior_events_table_timeline_idx
  ON mbox.guest_behavior_events (
    tenant_id, store_id, table_session_id, occurred_at DESC, id DESC
  );
CREATE INDEX guest_behavior_events_customer_timeline_idx
  ON mbox.guest_behavior_events (
    tenant_id, store_id, customer_id, behavior_type, occurred_at DESC, id DESC
  );

CREATE TABLE mbox.guest_service_request_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  request_type text NOT NULL CHECK (
    request_type IN ('call_staff', 'complaint', 'custom')
  ),
  merge_key char(64) NOT NULL CHECK (merge_key ~ '^[0-9a-f]{64}$'),
  current_service_task_id uuid,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  last_device_hash char(64) CHECK (
    last_device_hash IS NULL OR last_device_hash ~ '^[0-9a-f]{64}$'
  ),
  first_requested_at timestamptz,
  last_requested_at timestamptz,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id, customer_id)
    REFERENCES mbox.table_session_customers(tenant_id, store_id, table_session_id, customer_id),
  FOREIGN KEY (tenant_id, store_id, current_service_task_id)
    REFERENCES mbox.service_tasks(tenant_id, store_id, id),
  CHECK ((request_count = 0) = (first_requested_at IS NULL)),
  CHECK ((request_count = 0) = (last_requested_at IS NULL)),
  CHECK (last_requested_at IS NULL OR last_requested_at >= first_requested_at),
  UNIQUE (tenant_id, store_id, table_session_id, merge_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX guest_service_request_groups_task_idx
  ON mbox.guest_service_request_groups (
    tenant_id, store_id, current_service_task_id, updated_at DESC, id
  ) WHERE current_service_task_id IS NOT NULL;

CREATE TABLE mbox.guest_request_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  dimension text NOT NULL CHECK (dimension IN ('table', 'device')),
  action_kind text NOT NULL CHECK (action_kind IN ('service_request')),
  principal_hash char(64) NOT NULL CHECK (principal_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CHECK (expires_at > window_started_at),
  UNIQUE (
    tenant_id, store_id, dimension, action_kind, principal_hash, window_started_at
  ),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX guest_request_rate_limits_expiry_idx
  ON mbox.guest_request_rate_limits (expires_at, id);

CREATE TRIGGER guest_behavior_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.guest_behavior_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER guest_service_request_groups_touch_updated_at
  BEFORE UPDATE ON mbox.guest_service_request_groups
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER guest_request_rate_limits_touch_updated_at
  BEFORE UPDATE ON mbox.guest_request_rate_limits
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'guest_behavior_events',
    'guest_service_request_groups',
    'guest_request_rate_limits'
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

GRANT SELECT, INSERT ON TABLE mbox.guest_behavior_events TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.guest_service_request_groups TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mbox.guest_request_rate_limits TO mbox_runtime;

COMMENT ON TABLE mbox.guest_behavior_events IS
  'Append-only guest and table-session behavior evidence. Raw guest tokens and device identifiers are never stored.';
COMMENT ON TABLE mbox.guest_service_request_groups IS
  'Concurrency-safe merge identity for guest service requests without duplicating service tasks.';
COMMENT ON TABLE mbox.guest_request_rate_limits IS
  'Per-table and per-device request windows for guest service abuse protection.';

COMMIT;
