BEGIN;

CREATE TABLE mbox.idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  operation_scope text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb,
  resource_type text,
  resource_id uuid,
  locked_until timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT idempotency_records_scope_format CHECK (operation_scope ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  CONSTRAINT idempotency_records_response_shape CHECK (
    (status = 'completed' AND response_status IS NOT NULL AND response_body IS NOT NULL) OR
    status <> 'completed'
  ),
  CONSTRAINT idempotency_records_expiry_order CHECK (expires_at > created_at),
  CONSTRAINT idempotency_records_key_uq
    UNIQUE (tenant_id, store_id, operation_scope, idempotency_key),
  CONSTRAINT idempotency_records_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX idempotency_records_expiry_idx ON mbox.idempotency_records (expires_at);
CREATE INDEX idempotency_records_processing_idx
  ON mbox.idempotency_records (tenant_id, store_id, locked_until)
  WHERE status = 'processing';

CREATE TABLE mbox.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  headers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(headers) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT outbox_events_aggregate_type_format CHECK (aggregate_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT outbox_events_type_format CHECK (event_type ~ '^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+\.v[1-9][0-9]*$'),
  CONSTRAINT outbox_events_event_id_uq UNIQUE (event_id),
  CONSTRAINT outbox_events_aggregate_version_uq
    UNIQUE (tenant_id, store_id, aggregate_type, aggregate_id, aggregate_version, event_type),
  CONSTRAINT outbox_events_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX outbox_events_pending_idx
  ON mbox.outbox_events (available_at, occurred_at, id)
  WHERE published_at IS NULL;
CREATE INDEX outbox_events_store_pending_idx
  ON mbox.outbox_events (tenant_id, store_id, available_at, occurred_at, id)
  WHERE published_at IS NULL;
CREATE INDEX outbox_events_aggregate_idx
  ON mbox.outbox_events (tenant_id, store_id, aggregate_type, aggregate_id, aggregate_version);

CREATE TABLE mbox.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('guest', 'employee', 'system', 'integration', 'support')),
  actor_employee_id uuid,
  actor_ref text,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  reason text,
  request_id text,
  trace_id text,
  source_ip inet,
  user_agent text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  business_date date NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CONSTRAINT audit_events_actor_check CHECK (
    (actor_type = 'employee' AND actor_employee_id IS NOT NULL) OR
    (actor_type <> 'employee' AND actor_employee_id IS NULL)
  ),
  CONSTRAINT audit_events_action_format CHECK (action ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  CONSTRAINT audit_events_object_type_format CHECK (object_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT audit_events_change_present CHECK (
    before_data IS NOT NULL OR after_data IS NOT NULL OR reason IS NOT NULL
  ),
  CONSTRAINT audit_events_tenant_store_id_uq UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX audit_events_object_timeline_idx
  ON mbox.audit_events (tenant_id, store_id, object_type, object_id, occurred_at DESC, id);
CREATE INDEX audit_events_actor_timeline_idx
  ON mbox.audit_events (tenant_id, store_id, actor_employee_id, occurred_at DESC)
  WHERE actor_employee_id IS NOT NULL;
CREATE INDEX audit_events_business_date_idx
  ON mbox.audit_events (tenant_id, store_id, business_date, occurred_at, id);
CREATE INDEX audit_events_trace_idx
  ON mbox.audit_events (tenant_id, store_id, trace_id)
  WHERE trace_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbox.reject_row_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER service_task_events_append_only
BEFORE UPDATE OR DELETE ON mbox.service_task_events
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TRIGGER ledger_entries_append_only
BEFORE UPDATE OR DELETE ON mbox.ledger_entries
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TRIGGER refund_items_append_only
BEFORE UPDATE OR DELETE ON mbox.refund_items
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON mbox.audit_events
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE OR REPLACE FUNCTION mbox.protect_outbox_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox events may not be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
     NEW.store_id IS DISTINCT FROM OLD.store_id OR
     NEW.event_id IS DISTINCT FROM OLD.event_id OR
     NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type OR
     NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id OR
     NEW.aggregate_version IS DISTINCT FROM OLD.aggregate_version OR
     NEW.event_type IS DISTINCT FROM OLD.event_type OR
     NEW.payload IS DISTINCT FROM OLD.payload OR
     NEW.headers IS DISTINCT FROM OLD.headers OR
     NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at) OR
     NEW.publish_attempts < OLD.publish_attempts THEN
    RAISE EXCEPTION 'outbox event payload and identity are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_events_protect
BEFORE UPDATE OR DELETE ON mbox.outbox_events
FOR EACH ROW EXECUTE FUNCTION mbox.protect_outbox_event();

CREATE OR REPLACE FUNCTION mbox.protect_provider_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment provider events may not be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
     NEW.store_id IS DISTINCT FROM OLD.store_id OR
     NEW.provider IS DISTINCT FROM OLD.provider OR
     NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id OR
     NEW.provider_transaction_id IS DISTINCT FROM OLD.provider_transaction_id OR
     NEW.signature_verified IS DISTINCT FROM OLD.signature_verified OR
     NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256 OR
     NEW.payload IS DISTINCT FROM OLD.payload OR
     NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'payment provider event evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_provider_events_protect
BEFORE UPDATE OR DELETE ON mbox.payment_provider_events
FOR EACH ROW EXECUTE FUNCTION mbox.protect_provider_event();

CREATE OR REPLACE FUNCTION mbox.protect_published_config()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'published' AND (
    (to_jsonb(NEW) - ARRAY['status', 'row_version', 'updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['status', 'row_version', 'updated_at']) OR
    NEW.status NOT IN ('published', 'retired')
  ) THEN
    RAISE EXCEPTION 'published configuration content is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER config_versions_protect_published
BEFORE UPDATE ON mbox.config_versions
FOR EACH ROW EXECUTE FUNCTION mbox.protect_published_config();

CREATE OR REPLACE FUNCTION mbox.apply_ledger_entry_to_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE mbox.table_ledgers
  SET debit_total_amount_minor = debit_total_amount_minor +
        CASE WHEN NEW.direction = 'debit' THEN NEW.amount_minor ELSE 0 END,
      credit_total_amount_minor = credit_total_amount_minor +
        CASE WHEN NEW.direction = 'credit' THEN NEW.amount_minor ELSE 0 END
  WHERE tenant_id = NEW.tenant_id
    AND store_id = NEW.store_id
    AND id = NEW.ledger_id
    AND currency = NEW.currency
    AND status IN ('open', 'settling');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger % is missing, closed, or uses another currency', NEW.ledger_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entries_apply_balance
AFTER INSERT ON mbox.ledger_entries
FOR EACH ROW EXECUTE FUNCTION mbox.apply_ledger_entry_to_balance();

CREATE OR REPLACE FUNCTION mbox.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION mbox.current_store_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.store_id', true), '')::uuid
$$;

ALTER TABLE mbox.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mbox.tenants
  USING (id = mbox.current_tenant_id())
  WITH CHECK (id = mbox.current_tenant_id());

ALTER TABLE mbox.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.stores FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON mbox.stores
  USING (tenant_id = mbox.current_tenant_id() AND id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND id = mbox.current_store_id());

DO $$
DECLARE
  target_table record;
BEGIN
  FOR target_table IN
    SELECT t.table_name
    FROM information_schema.tables t
    WHERE t.table_schema = 'mbox'
      AND t.table_type = 'BASE TABLE'
      AND t.table_name NOT IN ('tenants', 'stores')
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = t.table_schema
          AND c.table_name = t.table_name
          AND c.column_name = 'tenant_id'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = t.table_schema
          AND c.table_name = t.table_name
          AND c.column_name = 'store_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', target_table.table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', target_table.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) '
      'WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      target_table.table_name
    );
  END LOOP;
END;
$$;

REVOKE CREATE ON SCHEMA mbox FROM PUBLIC;

COMMENT ON SCHEMA mbox IS 'M-Box production transactional schema; all store data is tenant and store isolated.';
COMMENT ON TABLE mbox.ledger_entries IS 'Append-only financial journal. Table ledger totals are updated by trigger.';
COMMENT ON TABLE mbox.outbox_events IS 'Transactional Outbox rows written in the same transaction as aggregate changes.';
COMMENT ON TABLE mbox.audit_events IS 'Append-only management and security audit trail; sensitive values must be redacted before insert.';
COMMENT ON COLUMN mbox.product_prices.amount_minor IS 'Integer amount in the currency minor unit; never a floating-point value.';
COMMENT ON COLUMN mbox.orders.total_amount_minor IS 'Integer amount in the currency minor unit; never a floating-point value.';
COMMENT ON COLUMN mbox.payments.amount_minor IS 'Integer amount in the currency minor unit; never a floating-point value.';
COMMENT ON COLUMN mbox.refunds.amount_minor IS 'Integer amount in the currency minor unit; never a floating-point value.';

COMMIT;
