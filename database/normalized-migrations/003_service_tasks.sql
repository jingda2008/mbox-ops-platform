BEGIN;

CREATE TABLE mbox.service_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  task_type text NOT NULL CHECK (task_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  detail text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'in_progress', 'completed', 'cancelled', 'expired')),
  source text NOT NULL CHECK (source IN ('guest', 'employee', 'sop', 'ai', 'system')),
  requested_role_code text,
  assigned_employee_id uuid,
  backup_employee_id uuid,
  created_by_employee_id uuid,
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count > 0),
  request_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(request_snapshot) = 'object'),
  due_at timestamptz,
  escalate_at timestamptz,
  next_action_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  worker_locked_by text,
  worker_locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_id) REFERENCES mbox.tables(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id, table_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id, table_id),
  FOREIGN KEY (tenant_id, store_id, assigned_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, backup_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (completed_at IS NULL OR status = 'completed'),
  CHECK (cancelled_at IS NULL OR status = 'cancelled'),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX service_tasks_sla_claim_idx
  ON mbox.service_tasks (next_action_at, priority, created_at, id)
  WHERE status IN ('pending', 'acknowledged', 'in_progress');
CREATE INDEX service_tasks_store_sla_claim_idx
  ON mbox.service_tasks (tenant_id, store_id, next_action_at, priority, created_at, id)
  WHERE status IN ('pending', 'acknowledged', 'in_progress');
CREATE INDEX service_tasks_employee_queue_idx
  ON mbox.service_tasks (tenant_id, store_id, assigned_employee_id, priority, created_at, id)
  WHERE status IN ('pending', 'acknowledged', 'in_progress');

CREATE TABLE mbox.service_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  service_task_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  from_status text,
  to_status text,
  actor_type text NOT NULL CHECK (actor_type IN ('guest', 'employee', 'system', 'integration')),
  actor_employee_id uuid,
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  idempotency_key text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, service_task_id) REFERENCES mbox.service_tasks(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (
    (actor_type = 'employee' AND actor_employee_id IS NOT NULL)
    OR (actor_type <> 'employee' AND actor_employee_id IS NULL)
  ),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX service_task_events_timeline_idx
  ON mbox.service_task_events (tenant_id, store_id, service_task_id, occurred_at, id);
CREATE UNIQUE INDEX service_task_events_idempotency_uq
  ON mbox.service_task_events (tenant_id, store_id, service_task_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER service_task_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.service_task_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER service_tasks_touch_updated_at
  BEFORE UPDATE ON mbox.service_tasks
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

COMMIT;
