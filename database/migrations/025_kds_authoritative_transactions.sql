BEGIN;

ALTER TABLE mbox.operational_kds_tasks
  ADD COLUMN started_at timestamptz,
  ADD COLUMN started_by text,
  ADD COLUMN completed_by text,
  ADD COLUMN picked_up_at timestamptz,
  ADD COLUMN picked_up_by text,
  ADD COLUMN delivered_by text;

UPDATE mbox.operational_kds_tasks
SET
  started_at = NULLIF(payload ->> 'startedAt', '')::timestamptz,
  started_by = NULLIF(payload ->> 'startedBy', ''),
  completed_by = NULLIF(payload ->> 'completedBy', ''),
  picked_up_at = NULLIF(payload ->> 'pickedUpAt', '')::timestamptz,
  picked_up_by = NULLIF(payload ->> 'pickedUpBy', ''),
  delivered_by = NULLIF(payload ->> 'deliveredBy', '');

CREATE INDEX operational_kds_tasks_work_queue_idx
  ON mbox.operational_kds_tasks (
    tenant_id, store_id, station_id, status, queued_at, source_id
  )
  WHERE status <> 'delivered';

CREATE TABLE mbox.operational_kds_task_events (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_event_id text NOT NULL,
  kds_task_id text NOT NULL,
  operation_scope text NOT NULL,
  event_type text NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  request_id text,
  occurred_at timestamptz NOT NULL,
  business_date date NOT NULL,
  runtime_revision bigint NOT NULL CHECK (runtime_revision > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, source_event_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT operational_kds_task_events_scope_format
    CHECK (operation_scope ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  CONSTRAINT operational_kds_task_events_idempotency_length
    CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  CONSTRAINT operational_kds_task_events_actor_not_blank
    CHECK (length(btrim(actor_id)) > 0),
  CONSTRAINT operational_kds_task_events_type_format
    CHECK (event_type ~ '^kds\.[a-z0-9_.-]+\.v[1-9][0-9]*$'),
  CONSTRAINT operational_kds_task_events_status_values CHECK (
    from_status IN ('queued', 'preparing', 'completed', 'picked_up', 'delivered')
    AND to_status IN ('queued', 'preparing', 'completed', 'picked_up', 'delivered')
  ),
  CONSTRAINT operational_kds_task_events_idempotency_uq
    UNIQUE (tenant_id, store_id, operation_scope, idempotency_key)
);

CREATE FUNCTION mbox.require_kds_task_for_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM mbox.operational_kds_tasks task
    WHERE task.tenant_id = NEW.tenant_id
      AND task.store_id = NEW.store_id
      AND task.source_id = NEW.kds_task_id
  ) THEN
    RAISE EXCEPTION 'KDS event references a missing task: %', NEW.kds_task_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER operational_kds_task_events_task_exists
BEFORE INSERT ON mbox.operational_kds_task_events
FOR EACH ROW EXECUTE FUNCTION mbox.require_kds_task_for_event();

CREATE INDEX operational_kds_task_events_timeline_idx
  ON mbox.operational_kds_task_events (
    tenant_id, store_id, kds_task_id, occurred_at, source_event_id
  );
CREATE INDEX operational_kds_task_events_business_date_idx
  ON mbox.operational_kds_task_events (
    tenant_id, store_id, business_date, event_type, occurred_at
  );

ALTER TABLE mbox.operational_kds_task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.operational_kds_task_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_store_isolation ON mbox.operational_kds_task_events
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

CREATE TRIGGER operational_kds_task_events_append_only
BEFORE UPDATE OR DELETE ON mbox.operational_kds_task_events
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

GRANT SELECT, INSERT, UPDATE, DELETE ON mbox.operational_kds_tasks TO mbox_app;
GRANT SELECT, INSERT ON mbox.operational_kds_task_events TO mbox_app;

COMMENT ON TABLE mbox.operational_kds_tasks IS
  'Authoritative row-locked transaction model for KDS production and delivery work. runtime_states retains a same-transaction compatibility mirror.';
COMMENT ON TABLE mbox.operational_kds_task_events IS
  'Append-only evidence for normalized KDS commands, exceptions and manager cancellation. Insert requires a live task, while no persistent FK blocks prior-version rebuilds or future archival.';
COMMENT ON COLUMN mbox.operational_kds_tasks.snapshot_revision IS
  'Runtime compatibility-mirror revision committed in the same transaction as this authoritative KDS row.';

COMMIT;
