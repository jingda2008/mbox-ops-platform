BEGIN;

-- A normal SERVER may confirm or release a member hold only for a table that
-- the employee currently owns. The command still rechecks the exact
-- loyalty.redemption.fulfill permission and table assignment in its write
-- transaction. Do not widen this role to benefit.cancel or table.view_all.
INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
 AND permission.code='loyalty.redemption.fulfill' AND permission.status='active'
WHERE role.status='active' AND role.code='SERVER'
ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_server_member_fulfillment_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='active' AND NEW.code='SERVER' THEN
    INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
    SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
    FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
      AND permission.code='loyalty.redemption.fulfill' AND permission.status='active'
    ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roles_seed_server_member_fulfillment_permission
  AFTER INSERT OR UPDATE OF status,code ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_server_member_fulfillment_permission();

UPDATE mbox.normalized_schema_metadata
SET schema_version='132',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
