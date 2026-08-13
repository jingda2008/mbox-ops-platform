import type {
  StaffAccessEmployeeOverrideView,
  StaffAccessEmployeeView,
  StaffAccessConfigurationDefinitionView,
  StaffAccessManagementOverview,
  StaffAccessPermissionView,
  StaffAccessRoleView,
  StaffPermissionDeploymentChange,
  StaffPermissionDeploymentResult,
} from '../../src/shared/normalized-contracts.js'
import type { JsonCodec, JsonObject, JsonValue } from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import { ScopedPostgresTransactionRunner, type ScopedTransaction, type StoreScope } from './transaction-runner.js'

interface RoleRow extends Record<string, unknown> {
  id: string
  code: string
  name: string
  status: string
  member_count: string
  permission_codes: string[]
  data_scopes: Array<{ key: string; effect: 'include' | 'exclude'; value: JsonValue; enabled: boolean }>
  approval_limits: Array<{ code: string; amountMinor: number | null; currency: string; rules: JsonObject; enabled: boolean }>
  navigation: Array<{ code: string; label: string; route: string; icon: string | null; sortOrder: number; enabled: boolean; displayConfig: JsonObject }>
  data_scope_count: string
  approval_limit_count: string
  navigation_count: string
}

interface AreaRow extends Record<string, unknown> {
  id: string
  code: string
  name: string
}

interface EmployeeRow extends Record<string, unknown> {
  id: string
  employee_code: string
  display_name: string
  status: string
  role_codes: string[]
  overrides: StaffAccessEmployeeOverrideView[]
}

interface PermissionRow extends Record<string, unknown> {
  code: string
  name: string
  category: string
  description: string | null
}

interface ConfigurationDefinitionRow extends Record<string, unknown> {
  definition_kind: StaffAccessConfigurationDefinitionView['kind']
  code: string
  label: string
  description: string | null
  required_permission_codes: string[]
  sort_order: number
  config: JsonObject
}

interface PermissionDeploymentValue {
  verifiedAt: string
  changes: Array<{
    kind: StaffPermissionDeploymentChange['kind']
    targetId: string
    configurationCode: string
    applied: boolean
    effectiveEmployeeCount: number
    affectedEmployeeCount: number
  }>
  overview: StaffAccessManagementOverview
}

export class StaffAccessManagementService {
  constructor(
    private readonly transactions: ScopedPostgresTransactionRunner,
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
  ) {}

  getOverview(input: Readonly<{ scope: StoreScope; actorEmployeeId: string }>): Promise<StaffAccessManagementOverview> {
    return this.transactions.run(input.scope, async (transaction) => {
      await requireAdministrator(transaction, input.actorEmployeeId)
      return readOverview(transaction)
    })
  }

  async deployPermissions(input: Readonly<{
    scope: StoreScope
    actorEmployeeId: string
    businessDate: string
    idempotencyKey: string
    requestFingerprint: string
    reason: string
    changes: StaffPermissionDeploymentChange[]
  }>): Promise<StaffPermissionDeploymentResult> {
    assertDeployment(input)
    const execution = await this.commands.execute({
      scope: input.scope,
      operationScope: 'staff.permission-deployment',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: deploymentCodec,
    }, async (transaction) => {
      await requireAdministrator(transaction, input.actorEmployeeId)
      const repository = new StaffAccessRepository(transaction)
      await assertConfigurationChangesKnown(transaction, input.changes)
      for (const change of input.changes) {
        if (change.kind === 'role_permission') {
          await repository.setRolePermission({
            ...change,
            configuredByEmployeeId: input.actorEmployeeId,
          })
        } else if (change.kind === 'employee_override') {
          await repository.setEmployeePermissionOverride({
            ...change,
            reason: input.reason,
            configuredByEmployeeId: input.actorEmployeeId,
          })
        } else if (change.kind === 'role_data_scope') {
          await repository.setRoleDataScope({
            roleId: change.roleId,
            scopeKey: change.scopeKey,
            effect: change.effect,
            scopeValue: change.scopeValue as JsonValue,
            enabled: change.enabled,
            configuredByEmployeeId: input.actorEmployeeId,
          })
        } else if (change.kind === 'role_approval_limit') {
          await repository.setRoleApprovalLimit({
            roleId: change.roleId,
            approvalCode: change.approvalCode,
            amountMinor: change.amountMinor,
            currency: change.currency,
            rules: change.rules as JsonObject,
            enabled: change.enabled,
            configuredByEmployeeId: input.actorEmployeeId,
          })
        } else {
          await repository.setRoleNavigation({
            roleId: change.roleId,
            navigationCode: change.navigationCode,
            label: change.label,
            route: change.route,
            icon: change.icon,
            sortOrder: change.sortOrder,
            enabled: change.enabled,
            displayConfig: change.displayConfig as JsonObject,
            configuredByEmployeeId: input.actorEmployeeId,
          })
        }
      }
      await assertConfigurationPrerequisites(transaction, input.changes)
      for (const change of input.changes) {
        const authority = authorityKey(change)
        if (authority === null) continue
        await repository.markRoleConfigurationRuntimeManaged({
          ...authority,
          configuredByEmployeeId: input.actorEmployeeId,
        })
      }
      // Compare temporal access rules against the same database clock that
      // assigned starts_at. App and database hosts can differ by milliseconds.
      const verifiedAt = await databaseTimestamp(transaction)
      await assertAdministratorRemains(transaction, repository, verifiedAt)
      if (input.changes.some((change) => change.kind === 'role_permission' || change.kind === 'role_navigation')) {
        await assertRoleNavigationIsUsable(transaction)
      }
      const changes = []
      for (const change of input.changes) changes.push(await verifyChange(transaction, repository, change, verifiedAt))
      if (changes.some((change) => !change.applied)) {
        throw new TypeError('权限写入后复核不一致，已回滚全部修改')
      }
      const overview = await readOverview(transaction)
      const result: PermissionDeploymentValue = { verifiedAt, changes, overview }
      const evidence = { verifiedAt, changes }
      return {
        result,
        auditEvents: [{
          actor: { type: 'employee', employeeId: input.actorEmployeeId },
          action: 'staff.permission-deployment.verified',
          objectType: 'staff_permission_deployment',
          objectId: input.actorEmployeeId,
          businessDate: input.businessDate,
          reason: input.reason,
          afterData: evidence,
        }],
        outboxMessages: [{
          eventId: `staff-permission-deployment:${input.idempotencyKey}`,
          aggregateType: 'staff_permission_deployment',
          aggregateId: input.actorEmployeeId,
          aggregateVersion: 1,
          eventType: 'staff.permission-deployment.verified.v1',
          payload: evidence,
        }],
      }
    })
    return {
      status: 'verified',
      verifiedAt: execution.value.verifiedAt,
      replayed: execution.replayed,
      changes: execution.value.changes,
      overview: execution.value.overview,
    }
  }
}

async function databaseTimestamp(transaction: ScopedTransaction): Promise<string> {
  const result = await transaction.query<{ verified_at: string }>(`
    SELECT to_char(
      clock_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) AS verified_at
  `)
  const value = result.rows[0]?.verified_at
  if (value === undefined || Number.isNaN(Date.parse(value))) {
    throw new TypeError('数据库验证时间不可用，已回滚全部修改')
  }
  return value
}

async function readOverview(transaction: ScopedTransaction): Promise<StaffAccessManagementOverview> {
  const roleResult = await transaction.query<RoleRow>(`
    SELECT role.id, role.code, role.name, role.status,
      (SELECT count(DISTINCT employee_role.employee_id)::text
       FROM mbox.employee_roles employee_role
       JOIN mbox.employees employee ON employee.tenant_id=employee_role.tenant_id
         AND employee.store_id=employee_role.store_id AND employee.id=employee_role.employee_id
       WHERE employee_role.tenant_id=role.tenant_id AND employee_role.store_id=role.store_id
         AND employee_role.role_id=role.id AND employee.status='active' AND employee_role.starts_at <= clock_timestamp()
         AND (employee_role.ends_at IS NULL OR employee_role.ends_at > clock_timestamp())) AS member_count,
      COALESCE((SELECT array_agg(permission.code ORDER BY permission.category, permission.code)
       FROM mbox.role_permission_assignments assignment
       JOIN mbox.staff_permission_definitions permission
         ON permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id
        AND permission.id=assignment.permission_id AND permission.status='active'
       WHERE assignment.tenant_id=role.tenant_id AND assignment.store_id=role.store_id
         AND assignment.role_id=role.id), ARRAY[]::text[]) AS permission_codes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'key', scope.scope_key, 'effect', scope.effect, 'value', scope.scope_value, 'enabled', scope.enabled
      ) ORDER BY scope.scope_key, scope.effect)
       FROM mbox.role_data_scopes scope
       WHERE scope.tenant_id=role.tenant_id AND scope.store_id=role.store_id AND scope.role_id=role.id), '[]'::jsonb) AS data_scopes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'code', approval.approval_code, 'amountMinor', approval.amount_minor, 'currency', approval.currency,
        'rules', approval.rules, 'enabled', approval.enabled
      ) ORDER BY approval.approval_code, approval.currency)
       FROM mbox.role_approval_limits approval
       WHERE approval.tenant_id=role.tenant_id AND approval.store_id=role.store_id AND approval.role_id=role.id), '[]'::jsonb) AS approval_limits,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'code', navigation.navigation_code, 'label', navigation.label, 'route', navigation.route,
        'icon', navigation.icon, 'sortOrder', navigation.sort_order, 'enabled', navigation.enabled,
        'displayConfig', navigation.display_config
      ) ORDER BY navigation.sort_order, navigation.navigation_code)
       FROM mbox.role_navigation_items navigation
       WHERE navigation.tenant_id=role.tenant_id AND navigation.store_id=role.store_id AND navigation.role_id=role.id), '[]'::jsonb) AS navigation,
      (SELECT count(*)::text FROM mbox.role_data_scopes scope
       WHERE scope.tenant_id=role.tenant_id AND scope.store_id=role.store_id AND scope.role_id=role.id AND scope.enabled=true) AS data_scope_count,
      (SELECT count(*)::text FROM mbox.role_approval_limits approval
       WHERE approval.tenant_id=role.tenant_id AND approval.store_id=role.store_id AND approval.role_id=role.id AND approval.enabled=true) AS approval_limit_count,
      (SELECT count(*)::text FROM mbox.role_navigation_items navigation
       WHERE navigation.tenant_id=role.tenant_id AND navigation.store_id=role.store_id AND navigation.role_id=role.id AND navigation.enabled=true) AS navigation_count
    FROM mbox.roles role
    WHERE role.tenant_id=$1::uuid AND role.store_id=$2::uuid
    ORDER BY CASE role.status WHEN 'active' THEN 0 ELSE 1 END, role.name, role.code
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const employeeResult = await transaction.query<EmployeeRow>(`
    SELECT employee.id, employee.employee_code, employee.display_name, employee.status,
      COALESCE((SELECT array_agg(DISTINCT role.code ORDER BY role.code)
       FROM mbox.employee_roles employee_role
       JOIN mbox.roles role ON role.tenant_id=employee_role.tenant_id AND role.store_id=employee_role.store_id AND role.id=employee_role.role_id
       WHERE employee_role.tenant_id=employee.tenant_id AND employee_role.store_id=employee.store_id
         AND employee_role.employee_id=employee.id AND role.status='active'
         AND employee_role.starts_at <= clock_timestamp()
         AND (employee_role.ends_at IS NULL OR employee_role.ends_at > clock_timestamp())), ARRAY[]::text[]) AS role_codes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'permissionCode', permission.code, 'effect', override.effect,
        'reason', override.reason, 'endsAt', override.ends_at
      ) ORDER BY permission.code)
       FROM mbox.employee_permission_overrides override
       JOIN mbox.staff_permission_definitions permission
         ON permission.tenant_id=override.tenant_id AND permission.store_id=override.store_id AND permission.id=override.permission_id
       WHERE override.tenant_id=employee.tenant_id AND override.store_id=employee.store_id
         AND override.employee_id=employee.id AND override.starts_at <= clock_timestamp()
         AND (override.ends_at IS NULL OR override.ends_at > clock_timestamp())), '[]'::jsonb) AS overrides
    FROM mbox.employees employee
    WHERE employee.tenant_id=$1::uuid AND employee.store_id=$2::uuid
    ORDER BY CASE employee.status WHEN 'active' THEN 0 ELSE 1 END, employee.display_name, employee.employee_code
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const permissionResult = await transaction.query<PermissionRow>(`
    SELECT code, name, category, description
    FROM mbox.staff_permission_definitions
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active'
    ORDER BY category, name, code
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const areaResult = await transaction.query<AreaRow>(`
    SELECT id, code, name FROM mbox.areas
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active'
    ORDER BY sort_order, name, code
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const definitionResult = await transaction.query<ConfigurationDefinitionRow>(`
    SELECT definition_kind, code, label, description, required_permission_codes,
      sort_order, config
    FROM mbox.staff_access_configuration_definitions
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active'
    ORDER BY sort_order, definition_kind, code
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  return {
    generatedAt: new Date().toISOString(),
    roles: roleResult.rows.map(roleView),
    employees: employeeResult.rows.map(employeeView),
    permissions: permissionResult.rows.map(permissionView),
    areas: areaResult.rows.map((row) => ({ id: row.id, code: row.code, name: row.name })),
    configurationDefinitions: definitionResult.rows.map(configurationDefinitionView),
  }
}

async function verifyChange(
  transaction: ScopedTransaction,
  repository: StaffAccessRepository,
  change: StaffPermissionDeploymentChange,
  at: string,
) {
  if (change.kind === 'employee_override') {
    const raw = await transaction.query<{ effect: 'grant' | 'deny' }>(`
      SELECT override.effect FROM mbox.employee_permission_overrides override
      JOIN mbox.staff_permission_definitions permission
        ON permission.tenant_id=override.tenant_id AND permission.store_id=override.store_id AND permission.id=override.permission_id
      WHERE override.tenant_id=$1::uuid AND override.store_id=$2::uuid
        AND override.employee_id=$3::uuid AND permission.code=$4
        AND override.starts_at <= $5::timestamptz AND (override.ends_at IS NULL OR override.ends_at > $5::timestamptz)
      ORDER BY override.starts_at DESC LIMIT 1
    `, [transaction.scope.tenantId, transaction.scope.storeId, change.employeeId, change.permissionCode, at])
    const access = await repository.resolve(change.employeeId, at)
    return {
      kind: change.kind,
      targetId: change.employeeId,
      configurationCode: change.permissionCode,
      applied: change.effect === null ? raw.rowCount === 0 : raw.rows[0]?.effect === change.effect,
      effectiveEmployeeCount: access.permissions.includes(change.permissionCode) ? 1 : 0,
      affectedEmployeeCount: 1,
    } as const
  }
  const employees = await roleEmployees(transaction, change.roleId, at)
  if (change.kind === 'role_permission') {
    const assignment = await transaction.query<{ enabled: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM mbox.role_permission_assignments assignment
        JOIN mbox.staff_permission_definitions permission
          ON permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id AND permission.id=assignment.permission_id
        WHERE assignment.tenant_id=$1::uuid AND assignment.store_id=$2::uuid
          AND assignment.role_id=$3::uuid AND permission.code=$4) AS enabled
    `, [transaction.scope.tenantId, transaction.scope.storeId, change.roleId, change.permissionCode])
    const effectiveEmployeeCount = await countEffectiveEmployees(repository, employees, at, (access) => access.permissions.includes(change.permissionCode))
    return {
      kind: change.kind, targetId: change.roleId, configurationCode: change.permissionCode,
      applied: assignment.rows[0]?.enabled === change.enabled,
      effectiveEmployeeCount, affectedEmployeeCount: employees.length,
    } as const
  }
  if (change.kind === 'role_data_scope') {
    const result = await transaction.query<{ scope_value: JsonValue; enabled: boolean }>(`
      SELECT scope_value, enabled FROM mbox.role_data_scopes
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid
        AND scope_key=$4 AND effect=$5
    `, [transaction.scope.tenantId, transaction.scope.storeId, change.roleId, change.scopeKey, change.effect])
    const effectiveEmployeeCount = await countEffectiveEmployees(repository, employees, at, (access) => access.dataScopes.some((scope) => (
      scope.key === change.scopeKey && scope.effect === change.effect && sameJson(scope.value, change.scopeValue)
    )))
    return {
      kind: change.kind, targetId: change.roleId, configurationCode: `${change.scopeKey}:${change.effect}`,
      applied: result.rows[0]?.enabled === change.enabled && sameJson(result.rows[0]?.scope_value, change.scopeValue),
      effectiveEmployeeCount, affectedEmployeeCount: employees.length,
    } as const
  }
  if (change.kind === 'role_approval_limit') {
    const result = await transaction.query<{ amount_minor: string | null; currency: string; rules: JsonObject; enabled: boolean }>(`
      SELECT amount_minor::text, currency, rules, enabled FROM mbox.role_approval_limits
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid
        AND approval_code=$4 AND currency=$5
    `, [transaction.scope.tenantId, transaction.scope.storeId, change.roleId, change.approvalCode, change.currency])
    const row = result.rows[0]
    const effectiveEmployeeCount = await countEffectiveEmployees(repository, employees, at, (access) => access.approvalLimits.some((limit) => (
      limit.code === change.approvalCode && limit.currency === change.currency
        && limit.amountMinor === change.amountMinor && sameJson(limit.rules, change.rules)
    )))
    return {
      kind: change.kind, targetId: change.roleId, configurationCode: `${change.approvalCode}:${change.currency}`,
      applied: row?.enabled === change.enabled
        && (row.amount_minor === null ? null : Number(row.amount_minor)) === change.amountMinor
        && sameJson(row.rules, change.rules),
      effectiveEmployeeCount, affectedEmployeeCount: employees.length,
    } as const
  }
  const result = await transaction.query<{
    label: string; route: string; icon: string | null; sort_order: number; enabled: boolean; display_config: JsonObject
  }>(`
    SELECT label, route, icon, sort_order, enabled, display_config FROM mbox.role_navigation_items
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid AND navigation_code=$4
  `, [transaction.scope.tenantId, transaction.scope.storeId, change.roleId, change.navigationCode])
  const row = result.rows[0]
  const effectiveEmployeeCount = await countEffectiveEmployees(repository, employees, at, (access) => access.navigation.some((item) => (
    item.code === change.navigationCode && item.route === change.route && item.label === change.label
  )))
  return {
    kind: change.kind, targetId: change.roleId, configurationCode: change.navigationCode,
    applied: row?.enabled === change.enabled && row.label === change.label && row.route === change.route
      && row.icon === change.icon && row.sort_order === change.sortOrder && sameJson(row.display_config, change.displayConfig),
    effectiveEmployeeCount, affectedEmployeeCount: employees.length,
  } as const
}

async function roleEmployees(transaction: ScopedTransaction, roleId: string, at: string): Promise<string[]> {
  const employees = await transaction.query<{ employee_id: string }>(`
    SELECT DISTINCT employee_role.employee_id
    FROM mbox.employee_roles employee_role
    JOIN mbox.employees employee ON employee.tenant_id=employee_role.tenant_id AND employee.store_id=employee_role.store_id AND employee.id=employee_role.employee_id
    WHERE employee_role.tenant_id=$1::uuid AND employee_role.store_id=$2::uuid AND employee_role.role_id=$3::uuid
      AND employee.status='active' AND employee_role.starts_at <= $4::timestamptz
      AND (employee_role.ends_at IS NULL OR employee_role.ends_at > $4::timestamptz)
  `, [transaction.scope.tenantId, transaction.scope.storeId, roleId, at])
  return employees.rows.map((row) => row.employee_id)
}

async function countEffectiveEmployees(
  repository: StaffAccessRepository,
  employees: string[],
  at: string,
  matches: (access: Awaited<ReturnType<StaffAccessRepository['resolve']>>) => boolean,
) {
  let effectiveEmployeeCount = 0
  for (const employeeId of employees) {
    const access = await repository.resolve(employeeId, at)
    if (matches(access)) effectiveEmployeeCount += 1
  }
  return effectiveEmployeeCount
}

function roleView(row: RoleRow): StaffAccessRoleView {
  return {
    id: row.id, code: row.code, name: row.name, status: row.status,
    memberCount: count(row.member_count), permissionCodes: row.permission_codes,
    dataScopes: row.data_scopes, approvalLimits: row.approval_limits, navigation: row.navigation,
    dataScopeCount: count(row.data_scope_count), approvalLimitCount: count(row.approval_limit_count),
    navigationCount: count(row.navigation_count),
  }
}

function employeeView(row: EmployeeRow): StaffAccessEmployeeView {
  return {
    id: row.id, code: row.employee_code, displayName: row.display_name,
    status: row.status, roleCodes: row.role_codes, overrides: row.overrides,
  }
}

function permissionView(row: PermissionRow): StaffAccessPermissionView {
  return { code: row.code, name: row.name, category: row.category, description: row.description }
}

function configurationDefinitionView(row: ConfigurationDefinitionRow): StaffAccessConfigurationDefinitionView {
  return {
    kind: row.definition_kind,
    code: row.code,
    label: row.label,
    description: row.description,
    requiredPermissionCodes: row.required_permission_codes,
    sortOrder: row.sort_order,
    config: row.config,
  }
}

function count(value: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`Invalid staff access count: ${value}`)
  return result
}

async function requireAdministrator(transaction: ScopedTransaction, employeeId: string) {
  await new StaffAccessRepository(transaction).assertPermission(employeeId, 'staff.access.configure')
}

async function assertAdministratorRemains(
  transaction: ScopedTransaction,
  repository: StaffAccessRepository,
  at: string,
) {
  const employees = await transaction.query<{ id: string }>(`
    SELECT id FROM mbox.employees
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active'
    ORDER BY id
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  for (const employee of employees.rows) {
    const access = await repository.resolve(employee.id, at)
    if (access.permissions.includes('staff.access.configure')) return
  }
  throw new TypeError('本次修改会导致门店没有任何权限管理员，已阻止发布')
}

async function assertRoleNavigationIsUsable(transaction: ScopedTransaction) {
  const definitions = await transaction.query<{
    code: string
    required_permission_codes: string[]
    config: JsonObject
  }>(`
    SELECT code, required_permission_codes, config
    FROM mbox.staff_access_configuration_definitions
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      AND definition_kind='navigation' AND status='active'
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const definitionByCode = new Map(definitions.rows.map((definition) => [definition.code, definition]))
  const roles = await transaction.query<{ role_name: string; permission_codes: string[]; navigation: Array<{ code: string; route: string; highFrequency: boolean }> }>(`
    SELECT role.name AS role_name,
      COALESCE((SELECT array_agg(permission.code)
        FROM mbox.role_permission_assignments assignment
        JOIN mbox.staff_permission_definitions permission
          ON permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id AND permission.id=assignment.permission_id
        WHERE assignment.tenant_id=role.tenant_id AND assignment.store_id=role.store_id AND assignment.role_id=role.id), ARRAY[]::text[]) AS permission_codes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('code', navigation.navigation_code, 'route', navigation.route, 'highFrequency', navigation.display_config->>'highFrequency'='true'))
        FROM mbox.role_navigation_items navigation
        WHERE navigation.tenant_id=role.tenant_id AND navigation.store_id=role.store_id
          AND navigation.role_id=role.id AND navigation.enabled=true), '[]'::jsonb) AS navigation
    FROM mbox.roles role
    WHERE role.tenant_id=$1::uuid AND role.store_id=$2::uuid AND role.status='active'
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  for (const role of roles.rows) {
    if (role.navigation.filter((item) => item.highFrequency).length > 4) {
      throw new TypeError(`${role.role_name}最多配置4个高频入口，避免手机工作台过载`)
    }
    for (const navigation of role.navigation) {
      const definition = definitionByCode.get(navigation.code)
      const expectedRoute = stringConfig(definition?.config, 'route')
      if (definition === undefined || expectedRoute !== navigation.route) throw new TypeError(`不支持的岗位入口：${navigation.route}`)
      const required = definition.required_permission_codes
      if (!required.some((permission) => role.permission_codes.includes(permission))) {
        throw new TypeError(`${role.role_name}缺少使用${navigation.route}所需权限，已阻止发布`)
      }
    }
  }
}

async function assertConfigurationPrerequisites(
  transaction: ScopedTransaction,
  changes: StaffPermissionDeploymentChange[],
) {
  const enabled = changes.filter((change) => (
    (change.kind === 'role_data_scope' || change.kind === 'role_approval_limit')
      && change.enabled
  )) as Array<Extract<StaffPermissionDeploymentChange,
    { kind: 'role_data_scope' | 'role_approval_limit' }>>
  if (enabled.length === 0) return
  const roleIds = [...new Set(enabled.map((change) => change.roleId))]
  const roles = await transaction.query<{ id: string; name: string; permission_codes: string[] }>(`
    SELECT role.id, role.name, COALESCE(array_agg(permission.code) FILTER (WHERE permission.code IS NOT NULL), ARRAY[]::text[]) AS permission_codes
    FROM mbox.roles role
    LEFT JOIN mbox.role_permission_assignments assignment
      ON assignment.tenant_id=role.tenant_id AND assignment.store_id=role.store_id AND assignment.role_id=role.id
    LEFT JOIN mbox.staff_permission_definitions permission
      ON permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id
      AND permission.id=assignment.permission_id AND permission.status='active'
    WHERE role.tenant_id=$1::uuid AND role.store_id=$2::uuid AND role.id=ANY($3::uuid[])
    GROUP BY role.id, role.name
  `, [transaction.scope.tenantId, transaction.scope.storeId, roleIds])
  const roleById = new Map(roles.rows.map((role) => [role.id, role]))
  const definitions = await transaction.query<{
    definition_kind: StaffAccessConfigurationDefinitionView['kind']
    code: string
    required_permission_codes: string[]
  }>(`
    SELECT definition_kind, code, required_permission_codes
    FROM mbox.staff_access_configuration_definitions
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active'
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const definitionByKey = new Map(definitions.rows.map((definition) => [`${definition.definition_kind}:${definition.code}`, definition]))
  for (const change of enabled) {
    const kind = change.kind === 'role_data_scope' ? 'data_scope' : 'approval_limit'
    const code = change.kind === 'role_data_scope' ? change.scopeKey
      : change.approvalCode
    const required = definitionByKey.get(`${kind}:${code}`)?.required_permission_codes ?? []
    const role = roleById.get(change.roleId)
    if (role === undefined || (required.length > 0 && !required.some((permission) => role.permission_codes.includes(permission)))) {
      throw new TypeError(`${role?.name ?? '所选岗位'}缺少配置${code}所需权限，已阻止发布`)
    }
  }
}

async function assertConfigurationChangesKnown(
  transaction: ScopedTransaction,
  changes: StaffPermissionDeploymentChange[],
) {
  const definitions = await transaction.query<{
    definition_kind: StaffAccessConfigurationDefinitionView['kind']
    code: string
    required_permission_codes: string[]
    config: JsonObject
  }>(`
    SELECT definition_kind, code, required_permission_codes, config
    FROM mbox.staff_access_configuration_definitions
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active'
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const catalog = new Map(definitions.rows.map((definition) => [`${definition.definition_kind}:${definition.code}`, definition]))
  for (const change of changes) {
    if (change.kind === 'role_permission' || change.kind === 'employee_override') continue
    const kind = change.kind === 'role_data_scope' ? 'data_scope'
      : change.kind === 'role_approval_limit' ? 'approval_limit' : 'navigation'
    const code = change.kind === 'role_data_scope' ? change.scopeKey
      : change.kind === 'role_approval_limit' ? change.approvalCode : change.navigationCode
    const definition = catalog.get(`${kind}:${code}`)
    if (definition === undefined) throw new TypeError(`未登记的配置能力：${code}`)
    if (change.kind === 'role_navigation' && stringConfig(definition.config, 'route') !== change.route) {
      throw new TypeError(`岗位入口地址与服务端目录不一致：${code}`)
    }
    if (change.kind === 'role_approval_limit') {
      const currency = stringConfig(definition.config, 'currency') ?? 'CNY'
      if (change.currency !== currency) throw new TypeError(`审批额度币种与服务端目录不一致：${code}`)
      if (change.rules.requiresReason !== true) throw new TypeError(`审批额度必须保留操作原因：${code}`)
      const controls = stringArrayConfig(definition.config, 'controls')
      const discountBasisPoints = change.rules.discountBasisPoints
      if (controls.includes('discount_percent')
        && (typeof discountBasisPoints !== 'number' || !Number.isInteger(discountBasisPoints)
          || discountBasisPoints < 0 || discountBasisPoints > 10_000)) {
        throw new TypeError(`折扣比例不在允许范围：${code}`)
      }
    }
    if (change.kind === 'role_data_scope') {
      const effect = stringConfig(definition.config, 'effect') ?? 'include'
      if (change.effect !== effect) throw new TypeError(`数据范围类型与服务端目录不一致：${code}`)
      await assertDataScopeValue(transaction, definition.config, code, change.scopeValue)
    }
  }
}

async function assertDataScopeValue(
  transaction: ScopedTransaction,
  config: JsonObject,
  code: string,
  value: unknown,
) {
  const editor = stringConfig(config, 'editor')
  if (editor === 'boolean') {
    if (!sameJson(value, config.enabledValue ?? true)) throw new TypeError(`数据范围值与服务端目录不一致：${code}`)
    return
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`数据范围必须是有效选项列表：${code}`)
  }
  const values = [...new Set(value)] as string[]
  if (editor === 'multi_choice') {
    const options = new Set(stringArrayConfig(config, 'options'))
    if (values.some((entry) => !options.has(entry))) throw new TypeError(`数据范围包含未登记选项：${code}`)
    return
  }
  if (editor !== 'area_multi' && editor !== 'employee_multi') {
    throw new TypeError(`数据范围编辑器未登记：${code}`)
  }
  if (values.some((entry) => !UUID.test(entry))) throw new TypeError(`数据范围包含无效标识：${code}`)
  const table = editor === 'area_multi' ? 'areas' : 'employees'
  const result = await transaction.query<{ id: string }>(`
    SELECT id FROM mbox.${table}
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='active' AND id=ANY($3::uuid[])
  `, [transaction.scope.tenantId, transaction.scope.storeId, values])
  if (result.rows.length !== values.length) throw new TypeError(`数据范围包含非本店或已停用对象：${code}`)
}

function authorityKey(change: StaffPermissionDeploymentChange): {
  roleId: string
  configurationKind: 'permission' | 'data_scope' | 'approval_limit' | 'navigation'
  configurationCode: string
} | null {
  if (change.kind === 'employee_override') return null
  if (change.kind === 'role_permission') return { roleId: change.roleId, configurationKind: 'permission', configurationCode: change.permissionCode }
  if (change.kind === 'role_data_scope') return { roleId: change.roleId, configurationKind: 'data_scope', configurationCode: `${change.scopeKey}:${change.effect}` }
  if (change.kind === 'role_approval_limit') return { roleId: change.roleId, configurationKind: 'approval_limit', configurationCode: `${change.approvalCode}:${change.currency}` }
  return { roleId: change.roleId, configurationKind: 'navigation', configurationCode: change.navigationCode }
}

function stringConfig(config: JsonObject | undefined, key: string): string | undefined {
  const value = config?.[key]
  return typeof value === 'string' ? value : undefined
}

function stringArrayConfig(config: JsonObject | undefined, key: string): string[] {
  const value = config?.[key]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function assertDeployment(input: { reason: string; changes: StaffPermissionDeploymentChange[] }) {
  if (input.reason.trim().length < 2 || input.reason.trim().length > 200) throw new TypeError('发布原因需填写2至200个字')
  if (input.changes.length < 1 || input.changes.length > 100) throw new TypeError('每次需发布1至100项权限修改')
  const keys = input.changes.map(changeKey)
  if (new Set(keys).size !== keys.length) throw new TypeError('同一目标的权限修改不能重复')
}

function changeKey(change: StaffPermissionDeploymentChange): string {
  if (change.kind === 'role_permission') return `${change.kind}:${change.roleId}:${change.permissionCode}`
  if (change.kind === 'employee_override') return `${change.kind}:${change.employeeId}:${change.permissionCode}`
  if (change.kind === 'role_data_scope') return `${change.kind}:${change.roleId}:${change.scopeKey}:${change.effect}`
  if (change.kind === 'role_approval_limit') return `${change.kind}:${change.roleId}:${change.approvalCode}:${change.currency}`
  return `${change.kind}:${change.roleId}:${change.navigationCode}`
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]))
  }
  return value
}

const deploymentCodec: JsonCodec<PermissionDeploymentValue> = {
  encode: (value) => value as unknown as JsonObject,
  decode: (value) => value as PermissionDeploymentValue,
}
