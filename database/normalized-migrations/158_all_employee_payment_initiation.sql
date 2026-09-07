BEGIN;

-- Every active employee role may initiate a collection for an order that is
-- already within that employee's table/order data scope.  This does not grant
-- access to other tables, manual-success recording, refunds, reconciliation,
-- or settlement exceptions; those remain separately permissioned.
UPDATE mbox.staff_permission_definitions
SET name='发起员工协助收款',
    description='为权限范围内的订单发起线上收款；支付未知时可审计地放开新的收款尝试',
    status='active'
WHERE code='payment.initiate.staff';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
 AND permission.code='payment.initiate.staff' AND permission.status='active'
WHERE role.status='active'
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_all_active_role_payment_initiation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='active' THEN
    INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
    SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
    FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
      AND permission.code='payment.initiate.staff' AND permission.status='active'
    ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roles_seed_all_active_role_payment_initiation
  AFTER INSERT OR UPDATE OF status ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_all_active_role_payment_initiation();

UPDATE mbox.normalized_schema_metadata
SET schema_version='158',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
