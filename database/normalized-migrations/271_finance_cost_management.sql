BEGIN;
-- Finance staff may read and correct operating expenses. No payment, refund,
-- payroll, inventory, or staff-administration permission is granted here.
INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
 ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
 AND permission.code IN ('commercial.cost.view','commercial.cost.manage') AND permission.status='active'
WHERE role.code='FINANCE' AND role.status='active'
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE FUNCTION mbox.seed_finance_cost_permissions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.code='FINANCE' AND NEW.status='active' THEN
  INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,id FROM mbox.staff_permission_definitions
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
   AND code IN ('commercial.cost.view','commercial.cost.manage') AND status='active'
  ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER roles_seed_finance_cost_permissions AFTER INSERT ON mbox.roles
 FOR EACH ROW EXECUTE FUNCTION mbox.seed_finance_cost_permissions();
GRANT EXECUTE ON FUNCTION mbox.seed_finance_cost_permissions() TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='271',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
