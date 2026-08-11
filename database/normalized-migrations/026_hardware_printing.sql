BEGIN;

CREATE TABLE mbox.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  device_type text NOT NULL CHECK (device_type IN (
    'printer', 'kds_display', 'cash_drawer', 'headset', 'controller'
  )),
  station_code text CHECK (station_code IS NULL OR station_code IN ('bar', 'kitchen', 'cashier', 'service')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  connectivity_status text NOT NULL DEFAULT 'unknown'
    CHECK (connectivity_status IN ('unknown', 'online', 'offline', 'degraded')),
  capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config_snapshot) = 'object'),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.printer_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  station_code text NOT NULL CHECK (station_code IN ('bar', 'kitchen', 'cashier')),
  product_category_code text,
  printer_device_id uuid NOT NULL,
  copies smallint NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 5),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, printer_device_id)
    REFERENCES mbox.devices(tenant_id, store_id, id),
  CHECK (product_category_code IS NULL OR length(btrim(product_category_code)) BETWEEN 1 AND 64),
  UNIQUE (tenant_id, store_id, code),
  UNIQUE NULLS NOT DISTINCT (
    tenant_id, store_id, station_code, product_category_code, printer_device_id
  ),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX printer_routes_resolution_idx
  ON mbox.printer_routes (
    tenant_id, store_id, station_code, product_category_code, priority, id
  ) WHERE status = 'active';

CREATE TABLE mbox.print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  business_key text NOT NULL CHECK (length(business_key) BETWEEN 8 AND 160),
  source_outbox_message_id uuid NOT NULL,
  printer_route_id uuid NOT NULL,
  printer_device_id uuid NOT NULL,
  station_code text NOT NULL CHECK (station_code IN ('bar', 'kitchen', 'cashier')),
  product_category_code text,
  source_type text NOT NULL CHECK (source_type IN ('order', 'kds', 'cashier')),
  source_reference text NOT NULL CHECK (length(btrim(source_reference)) BETWEEN 1 AND 160),
  print_snapshot jsonb NOT NULL CHECK (jsonb_typeof(print_snapshot) = 'object'),
  contains_priority_note boolean NOT NULL DEFAULT false,
  copies smallint NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'printing', 'printed', 'failed', 'dead', 'cancelled')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  locked_by text,
  locked_at timestamptz,
  last_error_code text,
  printed_at timestamptz,
  dead_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, source_outbox_message_id)
    REFERENCES mbox.outbox_messages(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, printer_route_id)
    REFERENCES mbox.printer_routes(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, printer_device_id)
    REFERENCES mbox.devices(tenant_id, store_id, id),
  CHECK (product_category_code IS NULL OR length(btrim(product_category_code)) BETWEEN 1 AND 64),
  CHECK ((status = 'printed') = (printed_at IS NOT NULL)),
  CHECK ((status = 'dead') = (dead_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((status = 'printing') = (locked_by IS NOT NULL AND locked_at IS NOT NULL)),
  UNIQUE (tenant_id, store_id, business_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX print_jobs_claim_idx
  ON mbox.print_jobs (tenant_id, store_id, available_at, created_at, id)
  WHERE status IN ('pending', 'failed', 'printing');
CREATE INDEX print_jobs_visibility_idx
  ON mbox.print_jobs (tenant_id, store_id, station_code, status, created_at DESC, id);

CREATE TABLE mbox.print_job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  print_job_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  from_status text,
  to_status text,
  actor_type text NOT NULL CHECK (actor_type IN ('employee', 'system', 'integration')),
  actor_employee_id uuid,
  failure_code text,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, print_job_id)
    REFERENCES mbox.print_jobs(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK ((actor_type = 'employee') = (actor_employee_id IS NOT NULL)),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX print_job_events_timeline_idx
  ON mbox.print_job_events (tenant_id, store_id, print_job_id, occurred_at, id);

CREATE TABLE mbox.hardware_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  device_id uuid NOT NULL,
  command_type text NOT NULL CHECK (command_type IN (
    'test_print', 'reconnect', 'ping', 'open_cash_drawer', 'restart'
  )),
  requested_by_employee_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  payload_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload_snapshot) = 'object'),
  result_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'executing', 'succeeded', 'failed', 'cancelled')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  locked_by text,
  locked_at timestamptz,
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, device_id)
    REFERENCES mbox.devices(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, requested_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (completed_at IS NOT NULL)),
  CHECK ((status = 'executing') = (locked_by IS NOT NULL AND locked_at IS NOT NULL)),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX hardware_commands_claim_idx
  ON mbox.hardware_commands (tenant_id, store_id, available_at, created_at, id)
  WHERE status IN ('requested', 'executing');

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['devices','printer_routes','print_jobs','hardware_commands']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON mbox.%I '
      'FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at()',
      table_name, table_name
    );
  END LOOP;
END $$;

CREATE TRIGGER print_job_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.print_job_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'devices', 'printer_routes', 'print_jobs', 'print_job_events', 'hardware_commands'
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE mbox.%I TO mbox_runtime', table_name);
  END LOOP;
END $$;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  'hardware_printing', permission.description, 'active'
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('hardware.view', '查看设备状态', '查看职责范围内的设备状态'),
  ('hardware.view_all', '查看全部设备', '查看全店设备及打印状态'),
  ('hardware.manage', '管理设备和路由', '配置设备及打印分流规则'),
  ('hardware.command', '执行硬件命令', '执行测试打印、重连、钱箱等需审计命令'),
  ('print.view', '查看打印任务', '查看岗位职责范围内的打印任务'),
  ('print.view_all', '查看全部打印任务', '查看全店全部打印任务'),
  ('print.retry', '重试打印任务', '人工重试失败或终止的打印任务'),
  ('work.bar', '查看吧台工作', '仅查看酒水和吧台工作'),
  ('work.kitchen', '查看后厨工作', '仅查看小吃和后厨工作'),
  ('work.cashier', '查看收银工作', '仅查看收银工作'),
  ('work.delivery', '查看配送工作', '仅查看制作完成待配送工作')
) AS permission(code, name, description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name = EXCLUDED.name,
    category = EXCLUDED.category,
    description = EXCLUDED.description,
    status = EXCLUDED.status;

COMMENT ON TABLE mbox.print_jobs IS
  'Immutable server-generated print snapshots materialized from trusted Outbox events. Client APIs cannot create print content.';
COMMENT ON TABLE mbox.print_job_events IS
  'Append-only printing lifecycle evidence; raw provider responses and secrets are prohibited.';

COMMIT;
