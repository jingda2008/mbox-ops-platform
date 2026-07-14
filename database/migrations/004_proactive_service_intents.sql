BEGIN;

CREATE TABLE mbox.proactive_service_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  table_id uuid NOT NULL,
  intent_type text NOT NULL DEFAULT 'awaiting_order' CHECK (intent_type IN ('awaiting_order')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  started_by_employee_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_reminder_at timestamptz,
  reminder_count integer NOT NULL DEFAULT 0 CHECK (reminder_count BETWEEN 0 AND 10),
  last_reminder_at timestamptz,
  stopped_at timestamptz,
  stopped_by_type text CHECK (stopped_by_type IN ('employee', 'system')),
  stopped_by_employee_id uuid,
  stop_reason text,
  config_version_id uuid NOT NULL,
  start_idempotency_key text NOT NULL CHECK (length(start_idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_id)
    REFERENCES mbox.venue_tables(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, started_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, stopped_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, config_version_id)
    REFERENCES mbox.config_versions(tenant_id, store_id, id),
  CONSTRAINT proactive_service_intents_stop_shape CHECK (
    (status = 'active' AND stopped_at IS NULL AND stopped_by_type IS NULL AND stopped_by_employee_id IS NULL) OR
    (status <> 'active' AND stopped_at IS NOT NULL AND stopped_by_type IS NOT NULL)
  ),
  CONSTRAINT proactive_service_intents_stopped_actor_check CHECK (
    stopped_by_type IS DISTINCT FROM 'employee' OR stopped_by_employee_id IS NOT NULL
  ),
  CONSTRAINT proactive_service_intents_reminder_order CHECK (
    (last_reminder_at IS NULL OR last_reminder_at >= started_at) AND
    (next_reminder_at IS NULL OR next_reminder_at >= started_at) AND
    (stopped_at IS NULL OR stopped_at >= started_at)
  ),
  CONSTRAINT proactive_service_intents_idempotency_uq
    UNIQUE (tenant_id, store_id, start_idempotency_key),
  CONSTRAINT proactive_service_intents_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX proactive_service_intents_one_active_uq
  ON mbox.proactive_service_intents (tenant_id, store_id, table_session_id, intent_type)
  WHERE status = 'active';
CREATE INDEX proactive_service_intents_due_idx
  ON mbox.proactive_service_intents (tenant_id, store_id, next_reminder_at)
  WHERE status = 'active' AND next_reminder_at IS NOT NULL;

CREATE TRIGGER proactive_service_intents_touch_version
BEFORE UPDATE ON mbox.proactive_service_intents
FOR EACH ROW EXECUTE FUNCTION mbox.touch_versioned_row();

ALTER TABLE mbox.service_tasks ADD COLUMN trigger_intent_id uuid;
ALTER TABLE mbox.service_tasks ADD CONSTRAINT service_tasks_trigger_intent_fk
  FOREIGN KEY (tenant_id, store_id, trigger_intent_id)
  REFERENCES mbox.proactive_service_intents(tenant_id, store_id, id);
CREATE INDEX service_tasks_trigger_intent_idx
  ON mbox.service_tasks (tenant_id, store_id, trigger_intent_id, status)
  WHERE trigger_intent_id IS NOT NULL;

ALTER TABLE mbox.proactive_service_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.proactive_service_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.proactive_service_intents
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

COMMENT ON TABLE mbox.proactive_service_intents IS
  'Explicit employee-started proactive service timers. The awaiting_order intent is closed automatically when an order is submitted.';
COMMENT ON COLUMN mbox.service_tasks.trigger_intent_id IS
  'Optional causal link to the proactive service intent that generated this task.';

COMMIT;
