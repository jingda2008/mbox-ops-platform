BEGIN;
-- Enforce the same authority even for an older application using the legacy
-- waiver path. Preserve the operator's name at the time of each new action.
ALTER TABLE mbox.order_minimum_spend_releases ADD COLUMN employee_name text;
ALTER TABLE mbox.table_minimum_spend_waivers ADD COLUMN employee_name text;
CREATE FUNCTION mbox.guard_minimum_exception_authority() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
DECLARE permission_code text;
BEGIN
 permission_code:=CASE WHEN TG_TABLE_NAME='order_minimum_spend_releases' THEN 'order.minimum_spend.release' ELSE 'table.minimum_spend.adjust' END;
 IF NOT mbox.employee_has_effective_permission(NEW.tenant_id,NEW.store_id,NEW.employee_id,permission_code)
 OR NOT mbox.employee_has_effective_permission(NEW.tenant_id,NEW.store_id,NEW.employee_id,
   CASE WHEN TG_TABLE_NAME='order_minimum_spend_releases' THEN 'order.create' ELSE 'table.view_all' END) THEN
  RAISE EXCEPTION '当前员工没有本项低消处理权限，请联系负责人' USING ERRCODE='42501';
 END IF;
 SELECT display_name INTO STRICT NEW.employee_name FROM mbox.employees WHERE(tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.employee_id) AND status='active';
 RETURN NEW;
END $$;
CREATE TRIGGER minimum_exception_authority BEFORE INSERT ON mbox.order_minimum_spend_releases FOR EACH ROW EXECUTE FUNCTION mbox.guard_minimum_exception_authority();
CREATE TRIGGER minimum_exception_authority BEFORE INSERT ON mbox.table_minimum_spend_waivers FOR EACH ROW EXECUTE FUNCTION mbox.guard_minimum_exception_authority();
REVOKE ALL ON FUNCTION mbox.guard_minimum_exception_authority() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='296',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
