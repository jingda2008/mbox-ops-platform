BEGIN;
CREATE FUNCTION mbox.seed_custody_management_permission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description,status)
 VALUES(NEW.tenant_id,NEW.id,'bottle.manage.all','管理全店瓶存','inventory','跨责任桌次管理瓶存与会员存酒；导出仍需独立授权','active')
 ON CONFLICT(tenant_id,store_id,code) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER stores_seed_custody_management_permission AFTER INSERT ON mbox.stores FOR EACH ROW EXECUTE FUNCTION mbox.seed_custody_management_permission();
INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description,status)
 SELECT tenant_id,id,'bottle.manage.all','管理全店瓶存','inventory','跨责任桌次管理瓶存与会员存酒；导出仍需独立授权','active' FROM mbox.stores
 ON CONFLICT(tenant_id,store_id,code) DO NOTHING;
-- Restore the catalog entry omitted by the older new-store trigger; do not grant roles.
UPDATE mbox.normalized_schema_metadata SET schema_version='213',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
