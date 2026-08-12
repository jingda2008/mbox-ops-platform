BEGIN;

ALTER TABLE mbox.table_sessions
  ADD COLUMN capacity_at_open integer,
  ADD COLUMN capacity_override_reason text,
  ADD COLUMN capacity_overridden_by_employee_id uuid,
  ADD CONSTRAINT table_sessions_capacity_overridden_by_fk
    FOREIGN KEY (tenant_id, store_id, capacity_overridden_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id);

UPDATE mbox.table_sessions AS session
SET capacity_at_open = venue_table.capacity,
    capacity_override_reason = CASE
      WHEN session.guest_count > venue_table.capacity
        THEN COALESCE(NULLIF(btrim(session.guest_profile_snapshot ->> 'capacityOverrideReason'), ''),
          '规范化迁移保留的历史加座记录')
      ELSE NULL
    END,
    capacity_overridden_by_employee_id = CASE
      WHEN session.guest_count > venue_table.capacity THEN session.opened_by_employee_id
      ELSE NULL
    END
FROM mbox.tables AS venue_table
WHERE venue_table.tenant_id = session.tenant_id
  AND venue_table.store_id = session.store_id
  AND venue_table.id = session.table_id;

ALTER TABLE mbox.table_sessions
  ALTER COLUMN capacity_at_open SET NOT NULL,
  ADD CONSTRAINT table_sessions_capacity_at_open_ck
    CHECK (capacity_at_open > 0 AND capacity_at_open <= 200),
  ADD CONSTRAINT table_sessions_capacity_override_ck CHECK (
    (guest_count <= capacity_at_open
      AND capacity_override_reason IS NULL
      AND capacity_overridden_by_employee_id IS NULL)
    OR
    (guest_count > capacity_at_open
      AND length(btrim(capacity_override_reason)) BETWEEN 2 AND 1000
      AND capacity_overridden_by_employee_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION mbox.enforce_table_session_capacity_override()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.capacity_at_open IS NULL THEN
    SELECT capacity INTO NEW.capacity_at_open
    FROM mbox.tables
    WHERE tenant_id = NEW.tenant_id AND store_id = NEW.store_id AND id = NEW.table_id;
  END IF;
  IF NEW.guest_count > NEW.capacity_at_open
    AND (NEW.capacity_override_reason IS NULL OR NEW.capacity_overridden_by_employee_id IS NULL)
  THEN
    RAISE EXCEPTION 'capacity override reason and employee are required'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER table_sessions_enforce_capacity_override
  BEFORE INSERT OR UPDATE OF guest_count, capacity_at_open,
    capacity_override_reason, capacity_overridden_by_employee_id
  ON mbox.table_sessions
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_table_session_capacity_override();

DROP INDEX mbox.table_assignments_one_active_primary_uq;

ALTER TABLE mbox.table_assignments
  ADD COLUMN reason text NOT NULL DEFAULT '现场责任分配'
    CHECK (length(btrim(reason)) BETWEEN 2 AND 1000),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

ALTER TABLE mbox.table_assignments
  ALTER COLUMN reason DROP DEFAULT;

ALTER TABLE mbox.table_assignments
  ADD CONSTRAINT table_assignments_primary_no_overlap_excl
  EXCLUDE USING gist (
    tenant_id WITH =,
    store_id WITH =,
    table_id WITH =,
    tstzrange(starts_at, COALESCE(ends_at, 'infinity'::timestamptz), '[)') WITH &&
  ) WHERE (assignment_type = 'primary');

ALTER TABLE mbox.table_assignments
  ADD CONSTRAINT table_assignments_employee_no_overlap_excl
  EXCLUDE USING gist (
    tenant_id WITH =,
    store_id WITH =,
    table_id WITH =,
    employee_id WITH =,
    tstzrange(starts_at, COALESCE(ends_at, 'infinity'::timestamptz), '[)') WITH &&
  );

CREATE INDEX table_assignments_table_time_idx
  ON mbox.table_assignments (tenant_id, store_id, table_id, starts_at, ends_at);

CREATE TRIGGER table_assignments_touch_updated_at
  BEFORE UPDATE ON mbox.table_assignments
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

CREATE TABLE mbox.table_session_transfer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  table_session_id uuid NOT NULL,
  source_table_id uuid NOT NULL,
  target_table_id uuid NOT NULL,
  transferred_by_employee_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 1000),
  ownership_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(ownership_snapshot) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, source_table_id)
    REFERENCES mbox.tables(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, target_table_id)
    REFERENCES mbox.tables(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, transferred_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (source_table_id <> target_table_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX table_session_transfer_events_session_idx
  ON mbox.table_session_transfer_events (
    tenant_id, store_id, table_session_id, occurred_at DESC, id
  );

ALTER TABLE mbox.table_session_transfer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_session_transfer_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.table_session_transfer_events
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

REVOKE ALL ON TABLE mbox.table_session_transfer_events FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE mbox.table_session_transfer_events TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.areas, mbox.tables, mbox.table_sessions,
  mbox.table_assignments TO mbox_runtime;

CREATE TRIGGER table_session_transfer_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.table_session_transfer_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  'table_management', permission.description, 'active'
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('table.open', '开台', '开任意可用区域的桌台，不受责任分配限制'),
  ('table.view_all', '查看全店桌台', '查看全店区域、桌台、桌次和责任分配'),
  ('table.manage', '配置区域和桌台', '新增或调整区域与桌台基础配置'),
  ('table.assignment.manage', '管理桌台责任', '分配主负责、候补和临时跨岗位责任'),
  ('table.transfer', '转桌', '将当前桌次转移到另一个可用桌台')
) AS permission(code, name, description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name = EXCLUDED.name,
    category = EXCLUDED.category,
    description = EXCLUDED.description,
    status = EXCLUDED.status;

COMMIT;
