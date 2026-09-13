BEGIN;
-- Requesting does not move money. Review, self-review prohibition, table scope,
-- explicit employee denies and execution authority remain separate.
INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role JOIN mbox.staff_permission_definitions permission
 ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
 AND permission.code='refund.request' AND permission.status='active'
WHERE role.status='active'
ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE FUNCTION mbox.seed_active_role_refund_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='active' THEN
  INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
  FROM mbox.staff_permission_definitions permission
  WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
   AND permission.code='refund.request' AND permission.status='active'
  ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER roles_seed_refund_request AFTER INSERT OR UPDATE OF status ON mbox.roles
FOR EACH ROW EXECUTE FUNCTION mbox.seed_active_role_refund_request();
UPDATE mbox.staff_permission_definitions SET description='在权限范围内申请退款；另一位有权员工审核，申请本身不退款'
WHERE code='refund.request';
UPDATE mbox.staff_access_configuration_definitions
SET description='退款申请不再要求岗位金额额度；可退余额与审核人员额度仍由系统核验',status='inactive'
WHERE definition_kind='approval_limit' AND code='refund.request';
CREATE FUNCTION mbox.hide_refund_request_amount_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.definition_kind='approval_limit' AND NEW.code='refund.request' THEN
  NEW.status:='inactive';
  NEW.description:='退款申请不再要求岗位金额额度；可退余额与审核人员额度仍由系统核验';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER definition_refund_request_limit BEFORE INSERT OR UPDATE ON mbox.staff_access_configuration_definitions
FOR EACH ROW EXECUTE FUNCTION mbox.hide_refund_request_amount_limit();
UPDATE mbox.normalized_schema_metadata SET schema_version='199',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
