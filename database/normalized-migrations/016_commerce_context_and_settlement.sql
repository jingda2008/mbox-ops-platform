BEGIN;

ALTER TABLE mbox.orders
  ADD COLUMN settlement_mode text NOT NULL DEFAULT 'table_tab'
    CHECK (settlement_mode IN ('immediate_payment', 'table_tab'));

CREATE TABLE mbox.assisted_order_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  token_hash char(64) NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  employee_id uuid NOT NULL,
  staff_session_id uuid NOT NULL,
  device_access_lease_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, staff_session_id)
    REFERENCES mbox.staff_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, device_access_lease_id)
    REFERENCES mbox.store_device_access_leases(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '30 minutes'),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK ((revoked_at IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND length(btrim(revoke_reason)) > 0)),
  UNIQUE (tenant_id, store_id, token_hash),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX assisted_order_contexts_active_idx
  ON mbox.assisted_order_contexts (
    tenant_id, store_id, employee_id, staff_session_id,
    device_access_lease_id, table_session_id, expires_at
  )
  WHERE revoked_at IS NULL;

CREATE TABLE mbox.kds_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  kds_task_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  exception_type text NOT NULL CHECK (exception_type IN ('production_failed', 'manager_cancelled')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  reason_note text NOT NULL CHECK (length(btrim(reason_note)) BETWEEN 2 AND 500),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'remediating', 'resolved')),
  financial_truth_status text NOT NULL DEFAULT 'unchanged_pending_review'
    CHECK (financial_truth_status IN ('unchanged_pending_review', 'no_action_required', 'resolved')),
  inventory_truth_status text NOT NULL DEFAULT 'unchanged_pending_review'
    CHECK (inventory_truth_status IN ('unchanged_pending_review', 'no_action_required', 'resolved')),
  required_actions jsonb NOT NULL CHECK (
    jsonb_typeof(required_actions) = 'array' AND jsonb_array_length(required_actions) > 0
  ),
  reported_by_employee_id uuid NOT NULL,
  resolved_by_employee_id uuid,
  resolution_note text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, kds_task_id)
    REFERENCES mbox.kds_tasks(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_item_id)
    REFERENCES mbox.order_items(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, reported_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, resolved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK ((status = 'resolved' AND resolved_at IS NOT NULL AND length(btrim(resolution_note)) > 0)
    OR (status <> 'resolved' AND resolved_at IS NULL)),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX kds_exceptions_open_idx
  ON mbox.kds_exceptions (tenant_id, store_id, status, occurred_at, id)
  WHERE status <> 'resolved';
CREATE INDEX kds_exceptions_task_timeline_idx
  ON mbox.kds_exceptions (tenant_id, store_id, kds_task_id, occurred_at, id);
CREATE INDEX kds_exceptions_order_item_idx
  ON mbox.kds_exceptions (tenant_id, store_id, order_item_id, occurred_at, id);

ALTER TABLE mbox.assisted_order_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.assisted_order_contexts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.assisted_order_contexts
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

ALTER TABLE mbox.kds_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.kds_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.kds_exceptions
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

REVOKE ALL ON TABLE mbox.assisted_order_contexts, mbox.kds_exceptions FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mbox_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE mbox.assisted_order_contexts TO mbox_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE mbox.kds_exceptions TO mbox_runtime;
  END IF;
END $$;

COMMENT ON TABLE mbox.assisted_order_contexts IS
  'Short-lived server-issued proof binding one staff session and device lease to one open table session.';
COMMENT ON TABLE mbox.kds_exceptions IS
  'Actionable production exception evidence. Cancellation never implies an automatic refund or inventory reversal.';
COMMENT ON COLUMN mbox.orders.settlement_mode IS
  'Requested collection path. immediate_payment remains unpaid until a payment provider confirms success.';

COMMIT;
