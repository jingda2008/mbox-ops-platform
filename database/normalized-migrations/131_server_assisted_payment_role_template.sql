BEGIN;

-- Migration 115 backfilled roles that already existed, but new stores and
-- roles created afterwards did not inherit the same SERVER template. Keep the
-- collection action narrow: table ownership is still checked by the payment
-- command and this does not grant all-table collection or manual cash/POS.
INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
 AND permission.code='payment.initiate.staff' AND permission.status='active'
WHERE role.status='active' AND role.code='SERVER'
ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_server_assisted_payment_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='active' AND NEW.code='SERVER' THEN
    INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
    SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
    FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
      AND permission.code='payment.initiate.staff' AND permission.status='active'
    ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roles_seed_server_assisted_payment_permission
  AFTER INSERT OR UPDATE OF status,code ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_server_assisted_payment_permission();

-- Initiating a customer-owned payment for an assigned table happens inside the
-- live assisted-order sheet. It must not unlock the store-wide cashier and
-- after-sales workbench. Keep the database configuration catalog aligned with
-- the permission-derived application registry for existing and future stores.
UPDATE mbox.staff_access_configuration_definitions
SET required_permission_codes=ARRAY[
  'payment.manual.cash.record','payment.manual.pos.record','payment.manual.external.record',
  'payment.settlement.view','refund.request','refund.approve','refund.execute',
  'reconciliation.view','reconciliation.manage','business_day.close'
]::text[]
WHERE definition_kind='navigation' AND code='payments';

CREATE OR REPLACE FUNCTION mbox.limit_cashier_navigation_to_cashier_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mbox.staff_access_configuration_definitions
  SET required_permission_codes=ARRAY[
    'payment.manual.cash.record','payment.manual.pos.record','payment.manual.external.record',
    'payment.settlement.view','refund.request','refund.approve','refund.execute',
    'reconciliation.view','reconciliation.manage','business_day.close'
  ]::text[]
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.id
    AND definition_kind='navigation' AND code='payments';
  RETURN NEW;
END;
$$;

CREATE TRIGGER zz_stores_limit_cashier_navigation_to_cashier_authority
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.limit_cashier_navigation_to_cashier_authority();

UPDATE mbox.normalized_schema_metadata
SET schema_version='131',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
