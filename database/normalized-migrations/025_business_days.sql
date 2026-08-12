BEGIN;

CREATE TABLE mbox.business_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'awaiting_close', 'closed')),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rollover_at timestamptz,
  closed_at timestamptz,
  closed_by_employee_id uuid,
  close_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, closed_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (closed_at IS NULL OR close_reason IS NOT NULL),
  UNIQUE (tenant_id, store_id, business_date),
  UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX business_days_one_open_store_uq
  ON mbox.business_days (tenant_id, store_id)
  WHERE status = 'open';
CREATE INDEX business_days_rollover_claim_idx
  ON mbox.business_days (tenant_id, store_id, business_date, id)
  WHERE status = 'open';
CREATE INDEX business_days_awaiting_close_idx
  ON mbox.business_days (tenant_id, store_id, business_date DESC, id)
  WHERE status = 'awaiting_close';

CREATE TRIGGER business_days_touch_updated_at
  BEFORE UPDATE ON mbox.business_days
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

ALTER TABLE mbox.business_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.business_days FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.business_days
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());
REVOKE ALL ON TABLE mbox.business_days FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE mbox.business_days TO mbox_runtime;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description
)
SELECT tenant_id, id, permission.code, permission.name, 'business_day', permission.description
FROM mbox.stores
CROSS JOIN (VALUES
  ('business_day.view', '查看营业日', '查看当前营业日和待关账营业日'),
  ('business_day.close', '营业日关账', '人工确认对账后关闭营业日')
) AS permission(code, name, description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, status = 'active';

COMMENT ON TABLE mbox.business_days IS
  'Operational business-day lifecycle derived from the store timezone and cutoff. Rollover never implies financial close.';

COMMIT;
