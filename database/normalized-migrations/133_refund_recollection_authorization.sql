BEGIN;

-- A completed refund is a terminal financial fact.  Re-charging the same
-- order requires a separate, time-bounded cashier authorization; it is not
-- inferred from “order total - paid + refunded”.
CREATE TABLE mbox.order_recollection_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  order_id uuid NOT NULL,
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
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,authorized_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,consumed_payment_id) REFERENCES mbox.payments(tenant_id,store_id,id),
  CHECK ((status='active' AND consumed_payment_id IS NULL AND consumed_at IS NULL AND cancelled_at IS NULL)
      OR (status='consumed' AND consumed_payment_id IS NOT NULL AND consumed_at IS NOT NULL)
      OR (status IN ('cancelled','expired'))),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,id)
);
CREATE UNIQUE INDEX order_recollection_authorizations_one_active
  ON mbox.order_recollection_authorizations(tenant_id,store_id,order_id)
  WHERE status='active';
CREATE INDEX order_recollection_authorizations_order_status_idx
  ON mbox.order_recollection_authorizations(tenant_id,store_id,order_id,status,expires_at,id);
CREATE TRIGGER order_recollection_authorizations_touch_updated_at
  BEFORE UPDATE ON mbox.order_recollection_authorizations
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

ALTER TABLE mbox.order_recollection_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.order_recollection_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.order_recollection_authorizations
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON TABLE mbox.order_recollection_authorizations FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.order_recollection_authorizations TO mbox_runtime;
REVOKE DELETE ON TABLE mbox.order_recollection_authorizations FROM mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.seed_store_refund_recollection_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) VALUES (
    NEW.tenant_id,NEW.id,'payment.recollect.authorize','授权退款后重新收款','payment',
    '退款完成后，确认客人仍需支付时创建一次性、限额、限时的重新收款授权','active'
  ) ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;
CREATE TRIGGER stores_seed_refund_recollection_permission
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_refund_recollection_permission();

INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description,status)
SELECT store.tenant_id,store.id,'payment.recollect.authorize','授权退款后重新收款','payment',
  '退款完成后，确认客人仍需支付时创建一次性、限额、限时的重新收款授权','active'
FROM mbox.stores store
ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

-- Reuse the independent refund-approval role boundary.  Servers never inherit
-- this permission; their table collection remains limited to normal unpaid
-- orders or a cashier-created authorization.
INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,recollect.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions approve
  ON approve.tenant_id=role.tenant_id AND approve.store_id=role.store_id
 AND approve.code='refund.approve' AND approve.status='active'
JOIN mbox.role_permission_assignments assignment
  ON assignment.tenant_id=role.tenant_id AND assignment.store_id=role.store_id
 AND assignment.role_id=role.id AND assignment.permission_id=approve.id
JOIN mbox.staff_permission_definitions recollect
  ON recollect.tenant_id=role.tenant_id AND recollect.store_id=role.store_id
 AND recollect.code='payment.recollect.authorize' AND recollect.status='active'
WHERE role.status='active'
ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_refund_recollection_role_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
      AND permission.id=NEW.permission_id AND permission.code='refund.approve'
      AND permission.status='active'
  ) THEN
    INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
    SELECT NEW.tenant_id,NEW.store_id,NEW.role_id,permission.id
    FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
      AND permission.code='payment.recollect.authorize' AND permission.status='active'
    ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_permissions_seed_refund_recollection
  AFTER INSERT ON mbox.role_permission_assignments
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_refund_recollection_role_permission();

UPDATE mbox.normalized_schema_metadata
SET schema_version='133',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
