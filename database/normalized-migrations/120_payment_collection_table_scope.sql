BEGIN;

-- Collection capability and table data scope are intentionally separate.
-- A server may initiate payment only for a currently assigned table, while a
-- cashier can collect across the store without inheriting all table-management
-- controls from table.view_all.
CREATE OR REPLACE FUNCTION mbox.seed_payment_collection_table_scope_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id, store_id, code, name, category, description, status
  ) VALUES (
    NEW.tenant_id, NEW.id, 'payment.collect.all_tables', '全店桌台收款',
    'payment', '在当前门店为任意有效桌次发起或记录收款；不授予桌台管理权限', 'active'
  )
  ON CONFLICT (tenant_id, store_id, code) DO UPDATE
  SET name=EXCLUDED.name,
      category=EXCLUDED.category,
      description=EXCLUDED.description,
      status='active';
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_payment_collection_table_scope_permission
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_payment_collection_table_scope_permission();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, 'payment.collect.all_tables', '全店桌台收款',
  'payment', '在当前门店为任意有效桌次发起或记录收款；不授予桌台管理权限', 'active'
FROM mbox.stores store
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name=EXCLUDED.name,
    category=EXCLUDED.category,
    description=EXCLUDED.description,
    status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
SELECT role.tenant_id, role.store_id, role.id, permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id
 AND permission.store_id=role.store_id
 AND permission.code='payment.collect.all_tables'
 AND permission.status='active'
WHERE role.status='active'
  AND role.code IN ('OWNER','OPS_LEAD','MANAGER','CASHIER')
ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_cashier_payment_collection_table_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='active' AND NEW.code IN ('OWNER','OPS_LEAD','MANAGER','CASHIER') THEN
    INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
    SELECT NEW.tenant_id, NEW.store_id, NEW.id, permission.id
    FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id=NEW.tenant_id
      AND permission.store_id=NEW.store_id
      AND permission.code='payment.collect.all_tables'
      AND permission.status='active'
    ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roles_seed_cashier_payment_collection_table_scope
  AFTER INSERT OR UPDATE OF status, code ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_cashier_payment_collection_table_scope();

UPDATE mbox.normalized_schema_metadata
SET schema_version='120', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
