BEGIN;

CREATE TABLE mbox.role_access_configuration_authorities (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  role_id uuid NOT NULL,
  configuration_kind text NOT NULL CHECK (configuration_kind IN ('permission', 'data_scope', 'approval_limit', 'navigation')),
  configuration_code text NOT NULL CHECK (configuration_code ~ '^[a-z][A-Za-z0-9_.:-]{2,191}$'),
  authority_source text NOT NULL DEFAULT 'runtime' CHECK (authority_source IN ('runtime', 'migration_backfill')),
  configured_by_employee_id uuid,
  configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, role_id, configuration_kind, configuration_code),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, role_id) REFERENCES mbox.roles(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, configured_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id)
);

ALTER TABLE mbox.role_access_configuration_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.role_access_configuration_authorities FORCE ROW LEVEL SECURITY;
CREATE POLICY role_access_configuration_authorities_tenant_store_policy
  ON mbox.role_access_configuration_authorities
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

GRANT SELECT, INSERT, UPDATE ON TABLE mbox.role_access_configuration_authorities TO mbox_runtime;

-- Protect every configuration that predates this item-level authority table. On a
-- fresh database these SELECTs are empty because store provisioning happens after
-- migrations; on an upgraded database they prevent the first rc.72 provision from
-- silently replacing the current operating decision. Missing actor data remains
-- NULL instead of attributing a migration to an actual employee.
INSERT INTO mbox.role_access_configuration_authorities (
  tenant_id, store_id, role_id, configuration_kind, configuration_code,
  authority_source, configured_by_employee_id
)
SELECT assignment.tenant_id, assignment.store_id, assignment.role_id,
  'permission', permission.code, 'migration_backfill', NULL
FROM mbox.role_permission_assignments assignment
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id
  AND permission.id=assignment.permission_id
ON CONFLICT DO NOTHING;

INSERT INTO mbox.role_access_configuration_authorities (
  tenant_id, store_id, role_id, configuration_kind, configuration_code,
  authority_source, configured_by_employee_id
)
SELECT scope.tenant_id, scope.store_id, scope.role_id, 'data_scope',
  scope.scope_key || ':' || scope.effect,
  CASE WHEN scope.configured_by_employee_id IS NULL THEN 'migration_backfill' ELSE 'runtime' END,
  scope.configured_by_employee_id
FROM mbox.role_data_scopes scope
ON CONFLICT DO NOTHING;

INSERT INTO mbox.role_access_configuration_authorities (
  tenant_id, store_id, role_id, configuration_kind, configuration_code,
  authority_source, configured_by_employee_id
)
SELECT approval.tenant_id, approval.store_id, approval.role_id, 'approval_limit',
  approval.approval_code || ':' || approval.currency,
  CASE WHEN approval.configured_by_employee_id IS NULL THEN 'migration_backfill' ELSE 'runtime' END,
  approval.configured_by_employee_id
FROM mbox.role_approval_limits approval
ON CONFLICT DO NOTHING;

INSERT INTO mbox.role_access_configuration_authorities (
  tenant_id, store_id, role_id, configuration_kind, configuration_code,
  authority_source, configured_by_employee_id
)
SELECT navigation.tenant_id, navigation.store_id, navigation.role_id, 'navigation',
  navigation.navigation_code,
  CASE WHEN navigation.configured_by_employee_id IS NULL THEN 'migration_backfill' ELSE 'runtime' END,
  navigation.configured_by_employee_id
FROM mbox.role_navigation_items navigation
ON CONFLICT DO NOTHING;

COMMENT ON TABLE mbox.role_access_configuration_authorities IS
  'Marks one role configuration item as runtime-managed or migration-protected so release provisioning can merge unrelated defaults without overwriting it.';

COMMIT;
