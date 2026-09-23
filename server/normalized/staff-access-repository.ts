import type { JsonObject, JsonValue } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { effectiveStaffNavigation } from '../../src/shared/staff-module-access.js'

export interface EffectiveDataScope {
  key: string
  effect: 'include' | 'exclude'
  value: JsonValue
}

export interface EffectiveApprovalLimit {
  code: string
  amountMinor: number | null
  currency: string
  calculationMode: 'amount_limit' | 'fixed_amount' | 'basis_points' | 'full_gift'
  fixedAmountMinor: number | null
  discountBasisPoints: number | null
  allowFullGift: boolean
  requiresReason: boolean
  requiresSecondActor: boolean
  rules: JsonObject
}

export interface StaffApprovalAuthority extends EffectiveApprovalLimit {
  id: string
}

export interface EffectiveNavigationItem {
  code: string
  label: string
  route: string
  icon: string | null
  sortOrder: number
  displayConfig: JsonObject
}

export interface EffectiveStaffAccess {
  employeeId: string
  employeeCode: string
  displayName: string
  roleCodes: string[]
  roleNames: string[]
  permissions: string[]
  deniedPermissions: string[]
  dataScopes: EffectiveDataScope[]
  approvalLimits: EffectiveApprovalLimit[]
  navigation: EffectiveNavigationItem[]
  resolvedAt: string
}

export interface PermissionDefinitionInput {
  code: string
  name: string
  category?: string
  description?: string | null
  status?: 'active' | 'inactive'
}

export interface RolePermissionInput {
  roleId: string
  permissionCode: string
  enabled: boolean
  configuredByEmployeeId: string
}

export interface EmployeePermissionOverrideInput {
  employeeId: string
  permissionCode: string
  effect: 'grant' | 'deny' | null
  reason: string
  configuredByEmployeeId: string
  startsAt?: string
  endsAt?: string | null
}

export interface RoleDataScopeInput {
  roleId: string
  scopeKey: string
  effect: 'include' | 'exclude'
  scopeValue: JsonValue
  enabled: boolean
  configuredByEmployeeId: string
}

export interface RoleApprovalLimitInput {
  roleId: string
  approvalCode: string
  amountMinor: number | null
  currency: string
  rules?: JsonObject
  enabled: boolean
  configuredByEmployeeId: string
}

export interface RoleNavigationInput {
  roleId: string
  navigationCode: string
  label: string
  route: string
  icon?: string | null
  sortOrder: number
  enabled: boolean
  displayConfig?: JsonObject
  configuredByEmployeeId: string
}

interface EmployeeRow extends Record<string, unknown> {
  id: string
  employee_code: string
  display_name: string
  status: 'active' | 'suspended' | 'departed'
}

interface PermissionRow extends Record<string, unknown> {
  code: string
  role_granted: boolean
  override_granted: boolean
  override_denied: boolean
}

interface ScopeRow extends Record<string, unknown> {
  scope_key: string
  effect: 'include' | 'exclude'
  value_kind: 'boolean' | 'text' | 'text_set'
  boolean_value: boolean | null
  text_value: string | null
  text_values: string[]
}

interface ApprovalRow extends Record<string, unknown> {
  id: string
  approval_code: string
  amount_minor: string | null
  currency: string
  calculation_mode: EffectiveApprovalLimit['calculationMode']
  fixed_amount_minor: string | null
  discount_basis_points: number | null
  allow_full_gift: boolean
  requires_reason: boolean
  requires_second_actor: boolean
}

interface NavigationRow extends Record<string, unknown> {
  navigation_code: string
  label: string
  route: string
  icon: string | null
  sort_order: number
  display_config: JsonObject
}

export class StaffAccessDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaffAccessDeniedError'
  }
}

export class StaffNotFoundError extends Error {
  constructor(employeeId: string) {
    super(`Employee was not found: ${employeeId}`)
    this.name = 'StaffNotFoundError'
  }
}

export class StaffAccessRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async resolve(employeeId: string, resolvedAt = new Date().toISOString()): Promise<EffectiveStaffAccess> {
    const employeeResult = await this.transaction.query<EmployeeRow>(`
      SELECT id, employee_code, display_name, status
      FROM mbox.employees
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeId])
    const employee = employeeResult.rows[0]
    if (employeeResult.rowCount !== 1 || employee === undefined) throw new StaffNotFoundError(employeeId)
    if (employee.status !== 'active') {
      throw new StaffAccessDeniedError(`Employee is not active: ${employeeId}`)
    }

    // A scoped transaction owns one PostgreSQL client; keep statements sequential on that client.
    const roles = await this.activeRoles(employeeId, resolvedAt)
    const permissionRows = await this.resolvePermissionRows(employeeId, resolvedAt)
    const scopeRows = await this.resolveDataScopeRows(employeeId, resolvedAt)
    const approvalRows = await this.resolveApprovalRows(employeeId, resolvedAt)
    const navigationRows = await this.resolveNavigationRows(employeeId, resolvedAt)

    const permissions: string[] = []
    const deniedPermissions: string[] = []
    for (const permission of permissionRows) {
      if (permission.override_denied) deniedPermissions.push(permission.code)
      else if (permission.override_granted || permission.role_granted) permissions.push(permission.code)
    }

    return {
      employeeId: employee.id,
      employeeCode: employee.employee_code,
      displayName: employee.display_name,
      roleCodes: roles.map((role) => role.code),
      roleNames: roles.map((role) => role.name),
      permissions: permissions.toSorted(),
      deniedPermissions: deniedPermissions.toSorted(),
      dataScopes: scopeRows.map((row) => ({
        key: row.scope_key,
        effect: row.effect,
        value: scopeValue(row),
      })),
      approvalLimits: approvalRows.map(approvalView),
      navigation: effectiveStaffNavigation(permissions, navigationRows.map((row) => ({
        code: row.navigation_code,
        label: row.label,
        route: row.route,
        icon: row.icon,
        sortOrder: row.sort_order,
        displayConfig: row.display_config,
      }))),
      resolvedAt,
    }
  }

  async assertPermission(employeeId: string, permissionCode: string, at?: string) {
    const access = await this.resolve(employeeId, at)
    if (!access.permissions.includes(permissionCode)) {
      throw new StaffAccessDeniedError(
        `Employee ${employeeId} does not have permission ${permissionCode}`,
      )
    }
    return access
  }

  async resolveApprovalAuthority(
    employeeId: string,
    approvalCode: string,
    at = new Date().toISOString(),
  ): Promise<StaffApprovalAuthority | null> {
    const result = await this.transaction.query<ApprovalRow>(`
      SELECT al.id, al.approval_code, al.amount_minor::text, al.currency,
        al.calculation_mode, al.fixed_amount_minor::text, al.discount_basis_points,
        al.allow_full_gift, al.requires_reason, al.requires_second_actor
      FROM mbox.role_approval_limits AS al
      JOIN mbox.employee_roles AS er
        ON er.tenant_id = al.tenant_id AND er.store_id = al.store_id AND er.role_id = al.role_id
      JOIN mbox.roles AS r
        ON r.tenant_id = er.tenant_id AND r.store_id = er.store_id AND r.id = er.role_id
      WHERE al.tenant_id = $1::uuid AND al.store_id = $2::uuid
        AND er.employee_id = $3::uuid AND al.approval_code = $4
        AND al.enabled = true AND r.status = 'active'
        AND er.starts_at <= $5::timestamptz
        AND (er.ends_at IS NULL OR er.ends_at > $5::timestamptz)
      ORDER BY al.amount_minor DESC NULLS LAST, al.id
      LIMIT 1
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      employeeId,
      approvalCode,
      at,
    ])
    const row = result.rows[0]
    return row === undefined ? null : { id: row.id, ...approvalView(row) }
  }

  async upsertPermissionDefinition(input: Readonly<PermissionDefinitionInput>) {
    const result = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.staff_permission_definitions (
        tenant_id, store_id, code, name, category, description, status
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, store_id, code) DO UPDATE
      SET name = EXCLUDED.name, category = EXCLUDED.category,
          description = EXCLUDED.description, status = EXCLUDED.status
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.code,
      input.name,
      input.category ?? 'operations',
      input.description ?? null,
      input.status ?? 'active',
    ])
    return requiredId(result, 'permission definition')
  }

  async setRolePermission(input: Readonly<RolePermissionInput>) {
    const permissionId = await this.permissionId(input.permissionCode)
    await this.assertRole(input.roleId)
    if (input.enabled) {
      const result = await this.transaction.query<{ id: string }>(`
        INSERT INTO mbox.role_permission_assignments (
          tenant_id, store_id, role_id, permission_id, granted_by_employee_id
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)
        ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO UPDATE
        SET granted_by_employee_id = EXCLUDED.granted_by_employee_id
        RETURNING id
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        input.roleId,
        permissionId,
        input.configuredByEmployeeId,
      ])
      return { id: requiredId(result, 'role permission'), enabled: true }
    }
    await this.transaction.query(`
      DELETE FROM mbox.role_permission_assignments
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND role_id = $3::uuid AND permission_id = $4::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.roleId, permissionId])
    return { id: permissionId, enabled: false }
  }

  async setEmployeePermissionOverride(input: Readonly<EmployeePermissionOverrideInput>) {
    const permissionId = await this.permissionId(input.permissionCode)
    await this.assertEmployee(input.employeeId)
    await this.transaction.query(`
      DELETE FROM mbox.employee_permission_overrides
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND employee_id = $3::uuid AND permission_id = $4::uuid
        AND starts_at <= COALESCE($5::timestamptz, clock_timestamp())
        AND (ends_at IS NULL OR ends_at > COALESCE($5::timestamptz, clock_timestamp()))
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.employeeId,
      permissionId,
      input.startsAt ?? null,
    ])
    if (input.effect === null) return { id: permissionId, effect: null }
    const result = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.employee_permission_overrides (
        tenant_id, store_id, employee_id, permission_id, effect, reason,
        starts_at, ends_at, configured_by_employee_id
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
        COALESCE($7::timestamptz, clock_timestamp()), $8::timestamptz, $9::uuid
      )
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.employeeId,
      permissionId,
      input.effect,
      input.reason,
      input.startsAt ?? null,
      input.endsAt ?? null,
      input.configuredByEmployeeId,
    ])
    return { id: requiredId(result, 'employee permission override'), effect: input.effect }
  }

  async setRoleDataScope(input: Readonly<RoleDataScopeInput>) {
    await this.assertRole(input.roleId)
    const strongValue = strongScopeValue(input.scopeValue)
    const result = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.role_data_scopes (
        tenant_id, store_id, role_id, scope_key, effect, scope_value,
        value_kind, boolean_value, text_value, text_values,
        enabled, configured_by_employee_id
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb,
        $7, $8::boolean, $9, $10::text[], $11, $12::uuid
      )
      ON CONFLICT (tenant_id, store_id, role_id, scope_key, effect) DO UPDATE
      SET scope_value = EXCLUDED.scope_value, value_kind=EXCLUDED.value_kind,
          boolean_value=EXCLUDED.boolean_value, text_value=EXCLUDED.text_value,
          text_values=EXCLUDED.text_values, enabled = EXCLUDED.enabled,
          configured_by_employee_id = EXCLUDED.configured_by_employee_id
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.roleId,
      input.scopeKey,
      input.effect,
      JSON.stringify(input.scopeValue),
      strongValue.kind,
      strongValue.booleanValue,
      strongValue.textValue,
      strongValue.textValues,
      input.enabled,
      input.configuredByEmployeeId,
    ])
    return requiredId(result, 'role data scope')
  }

  async setRoleApprovalLimit(input: Readonly<RoleApprovalLimitInput>) {
    await this.assertRole(input.roleId)
    const strongRules = strongApprovalRules(input.rules ?? {})
    const result = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.role_approval_limits (
        tenant_id, store_id, role_id, approval_code, amount_minor, currency,
        rules, calculation_mode, fixed_amount_minor, discount_basis_points,
        allow_full_gift, requires_reason, requires_second_actor,
        enabled, configured_by_employee_id
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5::bigint, $6, $7::jsonb,
        $8, $9::bigint, $10::integer, $11, $12, $13, $14, $15::uuid
      )
      ON CONFLICT (tenant_id, store_id, role_id, approval_code, currency) DO UPDATE
      SET amount_minor = EXCLUDED.amount_minor, rules = EXCLUDED.rules,
          calculation_mode=EXCLUDED.calculation_mode,
          fixed_amount_minor=EXCLUDED.fixed_amount_minor,
          discount_basis_points=EXCLUDED.discount_basis_points,
          allow_full_gift=EXCLUDED.allow_full_gift,
          requires_reason=EXCLUDED.requires_reason,
          requires_second_actor=EXCLUDED.requires_second_actor,
          enabled = EXCLUDED.enabled, configured_by_employee_id = EXCLUDED.configured_by_employee_id
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.roleId,
      input.approvalCode,
      input.amountMinor,
      input.currency,
      JSON.stringify(input.rules ?? {}),
      strongRules.calculationMode,
      strongRules.fixedAmountMinor,
      strongRules.discountBasisPoints,
      strongRules.allowFullGift,
      strongRules.requiresReason,
      strongRules.requiresSecondActor,
      input.enabled,
      input.configuredByEmployeeId,
    ])
    return requiredId(result, 'role approval limit')
  }

  async setRoleNavigation(input: Readonly<RoleNavigationInput>) {
    await this.assertRole(input.roleId)
    const result = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.role_navigation_items (
        tenant_id, store_id, role_id, navigation_code, label, route, icon,
        sort_order, enabled, display_config, configured_by_employee_id
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::uuid)
      ON CONFLICT (tenant_id, store_id, role_id, navigation_code) DO UPDATE
      SET label = EXCLUDED.label, route = EXCLUDED.route, icon = EXCLUDED.icon,
          sort_order = EXCLUDED.sort_order, enabled = EXCLUDED.enabled,
          display_config = EXCLUDED.display_config,
          configured_by_employee_id = EXCLUDED.configured_by_employee_id
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.roleId,
      input.navigationCode,
      input.label,
      input.route,
      input.icon ?? null,
      input.sortOrder,
      input.enabled,
      JSON.stringify(input.displayConfig ?? {}),
      input.configuredByEmployeeId,
    ])
    return requiredId(result, 'role navigation item')
  }

  async markRoleConfigurationRuntimeManaged(input: Readonly<{
    roleId: string
    configurationKind: 'permission' | 'data_scope' | 'approval_limit' | 'navigation'
    configurationCode: string
    configuredByEmployeeId: string
  }>) {
    await this.assertRole(input.roleId)
    await this.transaction.query(`
      INSERT INTO mbox.role_access_configuration_authorities(
        tenant_id, store_id, role_id, configuration_kind, configuration_code,
        configured_by_employee_id
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid)
      ON CONFLICT (tenant_id, store_id, role_id, configuration_kind, configuration_code) DO UPDATE
      SET configured_by_employee_id=EXCLUDED.configured_by_employee_id,
          authority_source='runtime', updated_at=clock_timestamp()
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.roleId,
      input.configurationKind,
      input.configurationCode,
      input.configuredByEmployeeId,
    ])
  }

  private async activeRoles(employeeId: string, at: string) {
    const result = await this.transaction.query<{ code: string; name: string }>(`
      SELECT DISTINCT r.code, r.name
      FROM mbox.employee_roles AS er
      JOIN mbox.roles AS r
        ON r.tenant_id = er.tenant_id AND r.store_id = er.store_id AND r.id = er.role_id
      WHERE er.tenant_id = $1::uuid AND er.store_id = $2::uuid
        AND er.employee_id = $3::uuid AND r.status = 'active'
        AND er.starts_at <= $4::timestamptz
        AND (er.ends_at IS NULL OR er.ends_at > $4::timestamptz)
      ORDER BY r.code, r.name
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeId, at])
    return result.rows
  }

  private async resolvePermissionRows(employeeId: string, at: string) {
    const result = await this.transaction.query<PermissionRow>(`
      WITH active_roles AS (
        SELECT er.role_id
        FROM mbox.employee_roles AS er
        JOIN mbox.roles AS r
          ON r.tenant_id = er.tenant_id AND r.store_id = er.store_id AND r.id = er.role_id
        WHERE er.tenant_id = $1::uuid AND er.store_id = $2::uuid
          AND er.employee_id = $3::uuid AND r.status = 'active'
          AND er.starts_at <= $4::timestamptz
          AND (er.ends_at IS NULL OR er.ends_at > $4::timestamptz)
      ), permission_facts AS (
        SELECT p.id, p.code,
          EXISTS (
            SELECT 1 FROM mbox.role_permission_assignments AS rp
            JOIN active_roles AS ar ON ar.role_id = rp.role_id
            WHERE rp.tenant_id = p.tenant_id AND rp.store_id = p.store_id
              AND rp.permission_id = p.id
          ) AS role_granted,
          EXISTS (
            SELECT 1 FROM mbox.employee_permission_overrides AS eo
            WHERE eo.tenant_id = p.tenant_id AND eo.store_id = p.store_id
              AND eo.employee_id = $3::uuid AND eo.permission_id = p.id
              AND eo.effect = 'grant' AND eo.starts_at <= $4::timestamptz
              AND (eo.ends_at IS NULL OR eo.ends_at > $4::timestamptz)
          ) AS override_granted,
          EXISTS (
            SELECT 1 FROM mbox.employee_permission_overrides AS eo
            WHERE eo.tenant_id = p.tenant_id AND eo.store_id = p.store_id
              AND eo.employee_id = $3::uuid AND eo.permission_id = p.id
              AND eo.effect = 'deny' AND eo.starts_at <= $4::timestamptz
              AND (eo.ends_at IS NULL OR eo.ends_at > $4::timestamptz)
          ) AS override_denied
        FROM mbox.staff_permission_definitions AS p
        WHERE p.tenant_id = $1::uuid AND p.store_id = $2::uuid AND p.status = 'active'
      )
      SELECT code, role_granted, override_granted, override_denied
      FROM permission_facts
      WHERE role_granted OR override_granted OR override_denied
      ORDER BY code
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeId, at])
    return result.rows
  }

  private async resolveDataScopeRows(employeeId: string, at: string) {
    const result = await this.transaction.query<ScopeRow>(`
      SELECT DISTINCT ds.scope_key, ds.effect, ds.value_kind,
        ds.boolean_value, ds.text_value, ds.text_values
      FROM mbox.role_data_scopes AS ds
      JOIN mbox.employee_roles AS er
        ON er.tenant_id = ds.tenant_id AND er.store_id = ds.store_id AND er.role_id = ds.role_id
      JOIN mbox.roles AS r
        ON r.tenant_id = er.tenant_id AND r.store_id = er.store_id AND r.id = er.role_id
      WHERE ds.tenant_id = $1::uuid AND ds.store_id = $2::uuid
        AND er.employee_id = $3::uuid AND ds.enabled = true AND r.status = 'active'
        AND er.starts_at <= $4::timestamptz
        AND (er.ends_at IS NULL OR er.ends_at > $4::timestamptz)
      ORDER BY ds.scope_key, ds.effect
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeId, at])
    return result.rows
  }

  private async resolveApprovalRows(employeeId: string, at: string) {
    const result = await this.transaction.query<ApprovalRow>(`
      SELECT DISTINCT ON (al.approval_code, al.currency)
        al.id, al.approval_code, al.amount_minor::text, al.currency,
        al.calculation_mode, al.fixed_amount_minor::text, al.discount_basis_points,
        al.allow_full_gift, al.requires_reason, al.requires_second_actor
      FROM mbox.role_approval_limits AS al
      JOIN mbox.employee_roles AS er
        ON er.tenant_id = al.tenant_id AND er.store_id = al.store_id AND er.role_id = al.role_id
      JOIN mbox.roles AS r
        ON r.tenant_id = er.tenant_id AND r.store_id = er.store_id AND r.id = er.role_id
      WHERE al.tenant_id = $1::uuid AND al.store_id = $2::uuid
        AND er.employee_id = $3::uuid AND al.enabled = true AND r.status = 'active'
        AND er.starts_at <= $4::timestamptz
        AND (er.ends_at IS NULL OR er.ends_at > $4::timestamptz)
      ORDER BY al.approval_code, al.currency, al.amount_minor DESC NULLS LAST, al.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeId, at])
    return result.rows
  }

  private async resolveNavigationRows(employeeId: string, at: string) {
    const result = await this.transaction.query<NavigationRow>(`
      SELECT DISTINCT ON (nav.navigation_code)
        nav.navigation_code, nav.label, nav.route, nav.icon, nav.sort_order, nav.display_config
      FROM mbox.role_navigation_items AS nav
      JOIN mbox.employee_roles AS er
        ON er.tenant_id = nav.tenant_id AND er.store_id = nav.store_id AND er.role_id = nav.role_id
      JOIN mbox.roles AS r
        ON r.tenant_id = er.tenant_id AND r.store_id = er.store_id AND r.id = er.role_id
      WHERE nav.tenant_id = $1::uuid AND nav.store_id = $2::uuid
        AND er.employee_id = $3::uuid AND nav.enabled = true AND r.status = 'active'
        AND er.starts_at <= $4::timestamptz
        AND (er.ends_at IS NULL OR er.ends_at > $4::timestamptz)
      ORDER BY nav.navigation_code, nav.sort_order, nav.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeId, at])
    return result.rows.toSorted((left, right) => left.sort_order - right.sort_order
      || left.navigation_code.localeCompare(right.navigation_code))
  }

  private async permissionId(code: string) {
    const result = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.staff_permission_definitions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND code = $3 AND status = 'active'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, code])
    return requiredId(result, `permission ${code}`)
  }

  private async assertRole(roleId: string) {
    const result = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.roles
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, roleId])
    requiredId(result, `role ${roleId}`)
  }

  private async assertEmployee(employeeId: string) {
    const result = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.employees
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeId])
    requiredId(result, `employee ${employeeId}`)
  }
}

function requiredId(result: { rows: { id: string }[]; rowCount: number | null }, subject: string) {
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error(`${subject} was not found or persisted`)
  return row.id
}

function scopeValue(row: ScopeRow): JsonValue {
  if (row.value_kind === 'boolean') {
    if (row.boolean_value === null) throw new Error('Boolean staff data scope is incomplete')
    return row.boolean_value
  }
  if (row.value_kind === 'text') {
    if (row.text_value === null) throw new Error('Text staff data scope is incomplete')
    return row.text_value
  }
  return [...row.text_values]
}

function strongScopeValue(value: JsonValue): {
  kind: ScopeRow['value_kind']
  booleanValue: boolean | null
  textValue: string | null
  textValues: string[]
} {
  if (typeof value === 'boolean') {
    return { kind: 'boolean', booleanValue: value, textValue: null, textValues: [] }
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return { kind: 'text', booleanValue: null, textValue: value.trim(), textValues: [] }
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) {
    return {
      kind: 'text_set',
      booleanValue: null,
      textValue: null,
      textValues: [...new Set(value.map((entry) => (entry as string).trim()))].toSorted(),
    }
  }
  throw new TypeError('Role data scope must be a boolean, text, or text array')
}

function strongApprovalRules(rules: JsonObject) {
  const allowFullGift = rules.allowFullGift === true
  const fixedAmountMinor = rules.fixedAmountMinor === undefined
    ? null : strongPositiveInteger(rules.fixedAmountMinor, 'fixedAmountMinor')
  const discountBasisPoints = rules.discountBasisPoints === undefined
    ? null : strongPositiveInteger(rules.discountBasisPoints, 'discountBasisPoints')
  const configured = Number(allowFullGift) + Number(fixedAmountMinor !== null) + Number(discountBasisPoints !== null)
  if (configured > 1 || (discountBasisPoints !== null && discountBasisPoints > 9999)) {
    throw new TypeError('Approval rules must select one valid calculation mode')
  }
  return {
    calculationMode: allowFullGift ? 'full_gift' as const
      : fixedAmountMinor !== null ? 'fixed_amount' as const
        : discountBasisPoints !== null ? 'basis_points' as const : 'amount_limit' as const,
    fixedAmountMinor,
    discountBasisPoints,
    allowFullGift,
    requiresReason: rules.requiresReason !== false,
    requiresSecondActor: rules.requiresSecondActor === true,
  }
}

function strongPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${label} must be a positive integer`)
  return value as number
}

function approvalView(row: ApprovalRow): EffectiveApprovalLimit {
  const fixedAmountMinor = row.fixed_amount_minor === null ? null : Number(row.fixed_amount_minor)
  const rules: JsonObject = {
    ...(row.calculation_mode === 'full_gift' ? { allowFullGift: true } : {}),
    ...(fixedAmountMinor === null ? {} : { fixedAmountMinor }),
    ...(row.discount_basis_points === null ? {} : { discountBasisPoints: row.discount_basis_points }),
    ...(row.requires_reason ? { requiresReason: true } : {}),
    ...(row.requires_second_actor ? { requiresSecondActor: true } : {}),
  }
  return {
    code: row.approval_code,
    amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
    currency: row.currency,
    calculationMode: row.calculation_mode,
    fixedAmountMinor,
    discountBasisPoints: row.discount_basis_points,
    allowFullGift: row.allow_full_gift,
    requiresReason: row.requires_reason,
    requiresSecondActor: row.requires_second_actor,
    rules,
  }
}
