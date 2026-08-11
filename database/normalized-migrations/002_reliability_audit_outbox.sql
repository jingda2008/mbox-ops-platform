BEGIN;

CREATE TABLE mbox.idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  operation_scope text NOT NULL CHECK (operation_scope ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_snapshot jsonb CHECK (response_snapshot IS NULL OR jsonb_typeof(response_snapshot) = 'object'),
  resource_type text,
  resource_id uuid,
  locked_until timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CHECK (expires_at > created_at),
  CHECK (status <> 'completed' OR (response_status IS NOT NULL AND response_snapshot IS NOT NULL)),
  UNIQUE (tenant_id, store_id, operation_scope, idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX idempotency_processing_idx
  ON mbox.idempotency_records (tenant_id, store_id, locked_until, created_at, id)
  WHERE status = 'processing';
CREATE INDEX idempotency_expiry_idx ON mbox.idempotency_records (expires_at, id);

CREATE TABLE mbox.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('guest', 'employee', 'system', 'integration', 'support')),
  actor_employee_id uuid,
  actor_ref text,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  object_type text NOT NULL CHECK (object_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  object_id text NOT NULL CHECK (length(btrim(object_id)) > 0),
  before_snapshot jsonb CHECK (before_snapshot IS NULL OR jsonb_typeof(before_snapshot) = 'object'),
  after_snapshot jsonb CHECK (after_snapshot IS NULL OR jsonb_typeof(after_snapshot) = 'object'),
  reason text,
  request_id text,
  trace_id text,
  business_date date NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (
    (actor_type = 'employee' AND actor_employee_id IS NOT NULL)
    OR (actor_type <> 'employee' AND actor_employee_id IS NULL)
  ),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX audit_events_object_timeline_idx
  ON mbox.audit_events (tenant_id, store_id, object_type, object_id, occurred_at DESC, id);
CREATE INDEX audit_events_trace_idx
  ON mbox.audit_events (tenant_id, store_id, trace_id) WHERE trace_id IS NOT NULL;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.audit_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TABLE mbox.outbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  message_key text NOT NULL CHECK (length(message_key) BETWEEN 8 AND 160),
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  message_type text NOT NULL CHECK (message_type ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  headers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(headers) = 'object'),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, message_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX outbox_pending_claim_idx
  ON mbox.outbox_messages (available_at, created_at, id)
  WHERE delivered_at IS NULL;
CREATE INDEX outbox_store_pending_claim_idx
  ON mbox.outbox_messages (tenant_id, store_id, available_at, created_at, id)
  WHERE delivered_at IS NULL;

CREATE OR REPLACE FUNCTION mbox.protect_outbox_message()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
     NEW.store_id IS DISTINCT FROM OLD.store_id OR NEW.message_key IS DISTINCT FROM OLD.message_key OR
     NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id OR
     NEW.aggregate_version IS DISTINCT FROM OLD.aggregate_version OR
     NEW.message_type IS DISTINCT FROM OLD.message_type OR NEW.payload IS DISTINCT FROM OLD.payload OR
     NEW.headers IS DISTINCT FROM OLD.headers OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.attempts < OLD.attempts OR
     (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at) THEN
    RAISE EXCEPTION 'outbox message identity and payload are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outbox_messages_protect
  BEFORE UPDATE OR DELETE ON mbox.outbox_messages
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_outbox_message();

CREATE TRIGGER idempotency_records_touch_updated_at
  BEFORE UPDATE ON mbox.idempotency_records
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

COMMIT;
