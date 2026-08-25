BEGIN;

-- A system-external collection is still a financial fact. It must not be
-- represented by a generic order note or a settlement exception because both
-- would bypass reconciliation. The payment row records the full outstanding
-- amount under the order lock; its immutable command and reconciliation entry
-- provide idempotency, employee, business-date and evidence ownership.
ALTER TABLE mbox.payments
  DROP CONSTRAINT payments_provider_check,
  DROP CONSTRAINT payments_provider_method_ck,
  ADD CONSTRAINT payments_provider_check CHECK (
    provider IN ('wechat', 'postar', 'cash', 'physical_pos', 'external_manual', 'simulation')
  ),
  ADD CONSTRAINT payments_provider_method_ck CHECK (
    (provider = 'cash' AND method = 'cash')
    OR (provider = 'physical_pos' AND method IN ('card', 'manual'))
    OR (provider = 'external_manual' AND method = 'manual')
    OR (provider IN ('wechat', 'postar', 'simulation') AND method IN ('jsapi', 'native_qr', 'auth_code'))
  ),
  ADD CONSTRAINT payments_external_manual_evidence_ck CHECK (
    provider <> 'external_manual'
    OR (
      status IN ('succeeded', 'partially_refunded', 'refunded')
      AND coalesce(provider_snapshot->>'externalMethodCode', '') IN (
        'bank_transfer', 'mobile_wallet', 'stored_value_voucher', 'corporate_account', 'other'
      )
      AND length(btrim(coalesce(provider_snapshot->>'receiptReference', ''))) BETWEEN 3 AND 256
      AND length(btrim(coalesce(provider_snapshot->>'collectionNote', ''))) BETWEEN 2 AND 500
      AND length(btrim(coalesce(provider_snapshot->>'collectedByEmployeeId', ''))) > 0
    )
  );

CREATE OR REPLACE FUNCTION mbox.seed_store_manual_external_payment_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id, store_id, code, name, category, description, status
  ) VALUES (
    NEW.tenant_id, NEW.id, 'payment.manual.external.record', '登记其他线下收款',
    'payment', '款项已由系统外方式实际收取后，凭真实凭证和说明登记并进入日结对账', 'active'
  )
  ON CONFLICT (tenant_id, store_id, code) DO UPDATE
  SET name=EXCLUDED.name,
      category=EXCLUDED.category,
      description=EXCLUDED.description,
      status='active';
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_manual_external_payment_permission
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_manual_external_payment_permission();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, 'payment.manual.external.record', '登记其他线下收款',
  'payment', '款项已由系统外方式实际收取后，凭真实凭证和说明登记并进入日结对账', 'active'
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
 AND permission.code='payment.manual.external.record'
 AND permission.status='active'
WHERE role.status='active'
  AND role.code IN ('OWNER', 'MANAGER', 'CASHIER')
ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_role_manual_external_payment_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='active' AND NEW.code IN ('OWNER', 'MANAGER', 'CASHIER') THEN
    INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
    SELECT NEW.tenant_id, NEW.store_id, NEW.id, permission.id
    FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id=NEW.tenant_id
      AND permission.store_id=NEW.store_id
      AND permission.code='payment.manual.external.record'
      AND permission.status='active'
    ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roles_seed_manual_external_payment_permission
  AFTER INSERT OR UPDATE OF status, code ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_role_manual_external_payment_permission();

UPDATE mbox.staff_access_configuration_definitions
SET required_permission_codes = array_append(
      required_permission_codes,
      'payment.manual.external.record'
    ),
    updated_at=clock_timestamp()
WHERE definition_kind='navigation'
  AND code='payments'
  AND NOT ('payment.manual.external.record'=ANY(required_permission_codes));

CREATE OR REPLACE FUNCTION mbox.include_manual_external_payment_navigation_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.definition_kind='navigation'
    AND NEW.code='payments'
    AND NOT ('payment.manual.external.record'=ANY(NEW.required_permission_codes)) THEN
    NEW.required_permission_codes := array_append(
      NEW.required_permission_codes,
      'payment.manual.external.record'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER staff_access_include_manual_external_payment_navigation_permission
  BEFORE INSERT OR UPDATE ON mbox.staff_access_configuration_definitions
  FOR EACH ROW EXECUTE FUNCTION mbox.include_manual_external_payment_navigation_permission();

UPDATE mbox.normalized_schema_metadata
SET schema_version='116', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
