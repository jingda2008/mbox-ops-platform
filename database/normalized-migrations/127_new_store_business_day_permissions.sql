BEGIN;

CREATE OR REPLACE FUNCTION mbox.seed_store_business_day_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) VALUES
    (NEW.tenant_id,NEW.id,'business_day.view','查看营业日','business_day','查看当前营业日和待关账营业日','active'),
    (NEW.tenant_id,NEW.id,'business_day.close','营业日关账','business_day','人工确认对账后关闭营业日','active')
  ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,
    description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_business_day_permissions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_business_day_permissions();

-- Backfill stores created after migration 025 but before this trigger existed.
INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,permission.code,permission.name,'business_day',permission.description,'active'
FROM mbox.stores store
CROSS JOIN (VALUES
  ('business_day.view','查看营业日','查看当前营业日和待关账营业日'),
  ('business_day.close','营业日关账','人工确认对账后关闭营业日')
) permission(code,name,description)
ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,
  description=EXCLUDED.description,status='active';

UPDATE mbox.normalized_schema_metadata
SET schema_version='127',updated_at=clock_timestamp()
WHERE singleton=true;

COMMIT;
