BEGIN;

-- The reusable beverage-launch package is composed in the staff access UI
-- from existing fine-grained permissions. This migration adds only the one
-- missing controlled capability: menu-image assets. It does not create a
-- coarse permission that could bypass inventory, pricing or publication checks.
CREATE OR REPLACE FUNCTION mbox.seed_menu_media_asset_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id, store_id, code, name, category, description, status
  ) VALUES (
    NEW.tenant_id, NEW.id, 'media.asset.menu.manage', '管理商品图片素材',
    'catalog', '上传、查看并选择不超过200KB的受控商品菜单图片', 'active'
  )
  ON CONFLICT (tenant_id, store_id, code) DO UPDATE
  SET name=EXCLUDED.name,
      category=EXCLUDED.category,
      description=EXCLUDED.description,
      status='active';
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_menu_media_asset_permission
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_menu_media_asset_permission();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, 'media.asset.menu.manage', '管理商品图片素材',
  'catalog', '上传、查看并选择不超过200KB的受控商品菜单图片', 'active'
FROM mbox.stores store
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name=EXCLUDED.name,
    category=EXCLUDED.category,
    description=EXCLUDED.description,
    status='active';

UPDATE mbox.staff_access_configuration_definitions
SET required_permission_codes=(
      SELECT ARRAY(
        SELECT DISTINCT code
        FROM unnest(required_permission_codes || ARRAY['media.asset.menu.manage']::text[]) code
        ORDER BY code
      )
    ),
    label='库存与酒水上架',
    description='扫码入库、成本、商品、配方、定价、渠道和发布',
    updated_at=clock_timestamp()
WHERE definition_kind='navigation' AND code='inventory';

UPDATE mbox.normalized_schema_metadata
SET schema_version='118', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
