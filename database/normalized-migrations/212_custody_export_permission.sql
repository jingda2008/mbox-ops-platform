BEGIN;
CREATE FUNCTION mbox.seed_custody_export_permission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description,status)
 VALUES(NEW.tenant_id,NEW.id,'bottle.custody.export','导出会员存酒报表','inventory','导出本店按当前筛选的会员存酒Excel；仍须具备全店瓶存管理权限','active')
 ON CONFLICT(tenant_id,store_id,code) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER stores_seed_custody_export_permission AFTER INSERT ON mbox.stores FOR EACH ROW EXECUTE FUNCTION mbox.seed_custody_export_permission();
INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description,status)
 SELECT tenant_id,id,'bottle.custody.export','导出会员存酒报表','inventory','导出本店按当前筛选的会员存酒Excel；仍须具备全店瓶存管理权限','active' FROM mbox.stores
 ON CONFLICT(tenant_id,store_id,code) DO NOTHING;
-- No automatic grants. The venue configures export responsibility explicitly.
UPDATE mbox.normalized_schema_metadata SET schema_version='212',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
