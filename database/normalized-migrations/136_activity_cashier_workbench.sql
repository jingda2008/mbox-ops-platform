BEGIN;

-- Activity payments are financial facts, but they must not inherit the broad
-- activity-editor or contact-reveal authority.  This capability is assigned
-- by the access configuration like every other staff permission.
CREATE OR REPLACE FUNCTION mbox.seed_store_activity_cashier_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) VALUES (
    NEW.tenant_id,NEW.id,'community.activity.cashier','活动收银工作台','payment',
    '查看活动收款、退款与受控重收队列；不包含活动编辑、发布或联系方式查看权限','active'
  ) ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;
CREATE TRIGGER stores_seed_activity_cashier_permission
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_activity_cashier_permission();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,'community.activity.cashier','活动收银工作台','payment',
  '查看活动收款、退款与受控重收队列；不包含活动编辑、发布或联系方式查看权限','active'
FROM mbox.stores store
ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

-- Default is an operating convenience only. Commands check the capability at
-- execution time, so administrators may remove it or grant it to another role.
INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
 AND permission.code='community.activity.cashier' AND permission.status='active'
WHERE role.status='active' AND role.code IN ('MANAGER','CASHIER')
ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_activity_cashier_role_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='active' AND NEW.code IN ('MANAGER','CASHIER') THEN
    INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
    SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
    FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
      AND permission.code='community.activity.cashier' AND permission.status='active'
    ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER roles_seed_activity_cashier_permission
  AFTER INSERT OR UPDATE OF status,code ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_activity_cashier_role_permission();

-- A completed refund never silently recreates a payable registration.  A
-- separate cashier-authorized token is consumed with one in-store collection.
CREATE TABLE mbox.activity_registration_recollection_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  activity_registration_id uuid NOT NULL,
  source_refund_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('active','consumed','cancelled','expired')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 4 AND 500),
  authorized_by_employee_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_payment_id uuid,
  consumed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,activity_registration_id)
    REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,source_refund_id)
    REFERENCES mbox.refunds(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,authorized_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,consumed_payment_id)
    REFERENCES mbox.payments(tenant_id,store_id,id),
  CHECK ((status='active' AND consumed_payment_id IS NULL AND consumed_at IS NULL AND cancelled_at IS NULL)
      OR (status='consumed' AND consumed_payment_id IS NOT NULL AND consumed_at IS NOT NULL)
      OR (status IN ('cancelled','expired'))),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,id)
);
CREATE UNIQUE INDEX activity_registration_recollection_one_active
  ON mbox.activity_registration_recollection_authorizations(tenant_id,store_id,activity_registration_id)
  WHERE status='active';
CREATE INDEX activity_registration_recollection_lookup
  ON mbox.activity_registration_recollection_authorizations(
    tenant_id,store_id,activity_registration_id,status,expires_at,id
  );
CREATE TRIGGER activity_registration_recollection_touch_updated_at
  BEFORE UPDATE ON mbox.activity_registration_recollection_authorizations
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

ALTER TABLE mbox.activity_registration_recollection_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.activity_registration_recollection_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY activity_registration_recollection_tenant_store_policy
  ON mbox.activity_registration_recollection_authorizations
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON TABLE mbox.activity_registration_recollection_authorizations FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.activity_registration_recollection_authorizations TO mbox_runtime;
REVOKE DELETE ON TABLE mbox.activity_registration_recollection_authorizations FROM mbox_runtime;

UPDATE mbox.staff_access_configuration_definitions
SET required_permission_codes=array_append(required_permission_codes,'community.activity.cashier'),
    updated_at=clock_timestamp()
WHERE definition_kind='navigation' AND code='payments'
  AND NOT ('community.activity.cashier'=ANY(required_permission_codes));

UPDATE mbox.normalized_schema_metadata
SET schema_version='136',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
