BEGIN;

ALTER TABLE mbox.group_voucher_redemptions
  ADD COLUMN platform_code text CHECK (
    platform_code IS NULL
    OR platform_code IN ('dianping', 'meituan', 'douyin', 'kuaishou')
  ),
  ADD COLUMN provider_certificate_id text CHECK (
    provider_certificate_id IS NULL
    OR length(btrim(provider_certificate_id)) BETWEEN 1 AND 128
  ),
  ADD COLUMN provider_verify_id text CHECK (
    provider_verify_id IS NULL
    OR length(btrim(provider_verify_id)) BETWEEN 1 AND 128
  ),
  ADD COLUMN provider_status text CHECK (
    provider_status IS NULL
    OR provider_status IN ('consumed', 'already_consumed')
  );

COMMENT ON COLUMN mbox.group_voucher_redemptions.platform_code IS
  'Stable platform identity for Dianping, Meituan, Douyin or Kuaishou. Display name stays in platform.';
COMMENT ON COLUMN mbox.group_voucher_redemptions.provider_verify_id IS
  'Platform consumption receipt. Absence means the local record has no provider confirmation.';

CREATE TABLE mbox.group_voucher_verification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  platform_code text NOT NULL CHECK (platform_code IN ('dianping', 'meituan', 'douyin', 'kuaishou')),
  action text NOT NULL CHECK (action IN ('prepare', 'consume')),
  outcome text NOT NULL CHECK (outcome IN (
    'success', 'not_found', 'already_used', 'expired', 'rejected', 'unavailable', 'invalid'
  )),
  voucher_code_hash char(64) NOT NULL CHECK (voucher_code_hash ~ '^[0-9a-f]{64}$'),
  voucher_code_masked text NOT NULL CHECK (length(btrim(voucher_code_masked)) BETWEEN 4 AND 32),
  campaign_name text CHECK (campaign_name IS NULL OR length(btrim(campaign_name)) BETWEEN 1 AND 128),
  provider_code text CHECK (provider_code IS NULL OR length(btrim(provider_code)) BETWEEN 1 AND 64),
  message text NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 240),
  employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX group_voucher_verification_attempts_recent_idx
  ON mbox.group_voucher_verification_attempts (
    tenant_id, store_id, created_at DESC, id DESC
  );

ALTER TABLE mbox.group_voucher_verification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.group_voucher_verification_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.group_voucher_verification_attempts
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());
REVOKE ALL ON TABLE mbox.group_voucher_verification_attempts FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE mbox.group_voucher_verification_attempts TO mbox_runtime;
CREATE TRIGGER group_voucher_verification_attempts_append_only
  BEFORE UPDATE OR DELETE ON mbox.group_voucher_verification_attempts
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
SELECT role.tenant_id, role.store_id, role.id, permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id = role.tenant_id
 AND permission.store_id = role.store_id
 AND permission.code IN ('commercial.voucher.view', 'commercial.voucher.redeem')
 AND permission.status = 'active'
WHERE role.status = 'active'
  AND role.code IN ('OWNER', 'MANAGER', 'CASHIER')
ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_role_group_voucher_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND NEW.code IN ('OWNER', 'MANAGER', 'CASHIER') THEN
    INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
    SELECT NEW.tenant_id, NEW.store_id, NEW.id, permission.id
    FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id = NEW.tenant_id AND permission.store_id = NEW.store_id
      AND permission.code IN ('commercial.voucher.view', 'commercial.voucher.redeem')
      AND permission.status = 'active'
    ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roles_seed_group_voucher_permissions
  AFTER INSERT OR UPDATE OF status, code ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_role_group_voucher_permissions();

UPDATE mbox.staff_access_configuration_definitions
SET required_permission_codes = CASE
    WHEN NOT ('commercial.voucher.view' = ANY (required_permission_codes))
      THEN array_append(required_permission_codes, 'commercial.voucher.view')
    ELSE required_permission_codes
  END,
  updated_at = clock_timestamp()
WHERE definition_kind = 'navigation' AND code = 'payments';

UPDATE mbox.staff_access_configuration_definitions
SET required_permission_codes = CASE
    WHEN NOT ('commercial.voucher.redeem' = ANY (required_permission_codes))
      THEN array_append(required_permission_codes, 'commercial.voucher.redeem')
    ELSE required_permission_codes
  END,
  updated_at = clock_timestamp()
WHERE definition_kind = 'navigation' AND code = 'payments';

CREATE OR REPLACE FUNCTION mbox.include_group_voucher_payment_navigation_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.definition_kind = 'navigation' AND NEW.code = 'payments' THEN
    IF NOT ('commercial.voucher.view' = ANY (NEW.required_permission_codes)) THEN
      NEW.required_permission_codes := array_append(NEW.required_permission_codes, 'commercial.voucher.view');
    END IF;
    IF NOT ('commercial.voucher.redeem' = ANY (NEW.required_permission_codes)) THEN
      NEW.required_permission_codes := array_append(NEW.required_permission_codes, 'commercial.voucher.redeem');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER staff_access_include_group_voucher_payment_navigation
  BEFORE INSERT OR UPDATE ON mbox.staff_access_configuration_definitions
  FOR EACH ROW EXECUTE FUNCTION mbox.include_group_voucher_payment_navigation_permission();

UPDATE mbox.normalized_schema_metadata
SET schema_version = '222', updated_at = clock_timestamp()
WHERE singleton = true AND schema_flavor = 'normalized-core-v1';

COMMIT;
