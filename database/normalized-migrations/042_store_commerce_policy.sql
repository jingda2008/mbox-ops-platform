BEGIN;

CREATE TABLE mbox.store_commerce_policies (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  online_payment_enabled boolean NOT NULL,
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  updated_by_employee_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, updated_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id)
);

ALTER TABLE mbox.store_commerce_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.store_commerce_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY store_commerce_policies_tenant_store_policy
  ON mbox.store_commerce_policies
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

GRANT SELECT, INSERT, UPDATE ON TABLE mbox.store_commerce_policies TO mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.seed_store_payment_policy_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions (
    tenant_id, store_id, code, name, category, description, status
  ) VALUES (
    NEW.tenant_id, NEW.id, 'payment.policy.manage', '管理线上支付开关', 'payment',
    '开启或关闭顾客及员工发起的线上支付，必须填写原因并保留审计', 'active'
  ) ON CONFLICT (tenant_id, store_id, code) DO UPDATE
    SET name=EXCLUDED.name, category=EXCLUDED.category,
        description=EXCLUDED.description, status='active';
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_payment_policy_permission
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_payment_policy_permission();

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT tenant_id, id, 'payment.policy.manage', '管理线上支付开关', 'payment',
  '开启或关闭顾客及员工发起的线上支付，必须填写原因并保留审计', 'active'
FROM mbox.stores
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name=EXCLUDED.name, category=EXCLUDED.category,
    description=EXCLUDED.description, status='active';

UPDATE mbox.normalized_schema_metadata
SET schema_version = '042', updated_at = clock_timestamp()
WHERE singleton = true AND schema_flavor = 'normalized-core-v1';

COMMENT ON TABLE mbox.store_commerce_policies IS
  'Strongly typed, versioned store operating policy. Runtime provider readiness remains a hard prerequisite for enabling online payment.';

COMMIT;
