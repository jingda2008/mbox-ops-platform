BEGIN;

CREATE OR REPLACE FUNCTION mbox.seed_catalog_management_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions (
    tenant_id, store_id, code, name, category, description, status
  ) VALUES
    (NEW.tenant_id, NEW.id, 'catalog.product.manage', '管理商品资料', 'catalog',
      '新增、编辑、上下架商品并配置推荐、展示和组合内容', 'active'),
    (NEW.tenant_id, NEW.id, 'catalog.price.manage', '管理商品售价', 'catalog',
      '调整标准售价并保留价格历史、原因和审计记录', 'active')
  ON CONFLICT (tenant_id, store_id, code) DO UPDATE
  SET name=EXCLUDED.name, category=EXCLUDED.category,
      description=EXCLUDED.description, status='active';
  UPDATE mbox.staff_access_configuration_definitions
  SET required_permission_codes = (
        SELECT ARRAY(SELECT DISTINCT code FROM unnest(
          required_permission_codes || ARRAY['catalog.product.manage','catalog.price.manage']::text[]
        ) AS code ORDER BY code)
      ),
      description = '权限、商品、支付、设备与AI配置',
      updated_at = clock_timestamp()
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.id
    AND definition_kind='navigation' AND code='settings';
  RETURN NEW;
END;
$$;

-- PostgreSQL executes same-event triggers by name. The zz prefix deliberately runs
-- after the staff-access catalog trigger from migration 040.
CREATE TRIGGER zz_stores_seed_catalog_management_permissions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_catalog_management_permissions();

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  'catalog', permission.description, 'active'
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('catalog.product.manage', '管理商品资料', '新增、编辑、上下架商品并配置推荐、展示和组合内容'),
  ('catalog.price.manage', '管理商品售价', '调整标准售价并保留价格历史、原因和审计记录')
) AS permission(code, name, description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name=EXCLUDED.name, category=EXCLUDED.category,
    description=EXCLUDED.description, status='active';

UPDATE mbox.staff_access_configuration_definitions
SET required_permission_codes = (
      SELECT ARRAY(SELECT DISTINCT code FROM unnest(
        required_permission_codes || ARRAY['catalog.product.manage','catalog.price.manage']::text[]
      ) AS code ORDER BY code)
    ),
    description = '权限、商品、支付、设备与AI配置',
    updated_at = clock_timestamp()
WHERE definition_kind='navigation' AND code='settings';

COMMIT;
