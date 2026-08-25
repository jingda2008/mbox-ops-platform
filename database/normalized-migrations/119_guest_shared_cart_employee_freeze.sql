BEGIN;

-- A service employee may temporarily freeze guest writes while reconciling the
-- table. Read access remains available to every bound guest and all mutations
-- stay auditable. The freeze is session-scoped and is cleared only explicitly
-- or when the session closes; it never transfers ownership of the cart.
ALTER TABLE mbox.table_sessions
  ADD COLUMN guest_cart_writes_frozen boolean NOT NULL DEFAULT false,
  ADD COLUMN guest_cart_frozen_by_employee_id uuid,
  ADD COLUMN guest_cart_freeze_reason text,
  ADD COLUMN guest_cart_frozen_at timestamptz,
  ADD CONSTRAINT table_sessions_guest_cart_freeze_employee_fk
    FOREIGN KEY (tenant_id, store_id, guest_cart_frozen_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  ADD CONSTRAINT table_sessions_guest_cart_freeze_state_ck CHECK (
    (
      guest_cart_writes_frozen
      AND guest_cart_frozen_by_employee_id IS NOT NULL
      AND guest_cart_frozen_at IS NOT NULL
      AND length(btrim(coalesce(guest_cart_freeze_reason, ''))) BETWEEN 2 AND 500
    ) OR (
      NOT guest_cart_writes_frozen
      AND guest_cart_frozen_by_employee_id IS NULL
      AND guest_cart_frozen_at IS NULL
      AND guest_cart_freeze_reason IS NULL
    )
  );

CREATE OR REPLACE FUNCTION mbox.seed_guest_cart_freeze_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id, store_id, code, name, category, description, status
  ) VALUES (
    NEW.tenant_id, NEW.id, 'guest.cart.freeze', '锁定顾客共享购物车',
    'table', '核对桌台点单时临时锁定或恢复顾客修改；顾客仍可查看，全部操作留痕', 'active'
  )
  ON CONFLICT (tenant_id, store_id, code) DO UPDATE
  SET name=EXCLUDED.name,
      category=EXCLUDED.category,
      description=EXCLUDED.description,
      status='active';
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_guest_cart_freeze_permission
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_guest_cart_freeze_permission();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, 'guest.cart.freeze', '锁定顾客共享购物车',
  'table', '核对桌台点单时临时锁定或恢复顾客修改；顾客仍可查看，全部操作留痕', 'active'
FROM mbox.stores store
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name=EXCLUDED.name,
    category=EXCLUDED.category,
    description=EXCLUDED.description,
    status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
SELECT role.tenant_id, role.store_id, role.id, permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id
 AND permission.store_id=role.store_id
 AND permission.code='guest.cart.freeze'
 AND permission.status='active'
WHERE role.status='active'
  AND role.code IN ('OWNER', 'MANAGER', 'SERVER')
ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_role_guest_cart_freeze_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='active' AND NEW.code IN ('OWNER', 'MANAGER', 'SERVER') THEN
    INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
    SELECT NEW.tenant_id, NEW.store_id, NEW.id, permission.id
    FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id=NEW.tenant_id
      AND permission.store_id=NEW.store_id
      AND permission.code='guest.cart.freeze'
      AND permission.status='active'
    ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roles_seed_guest_cart_freeze_permission
  AFTER INSERT OR UPDATE OF status, code ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_role_guest_cart_freeze_permission();

UPDATE mbox.normalized_schema_metadata
SET schema_version='119', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
