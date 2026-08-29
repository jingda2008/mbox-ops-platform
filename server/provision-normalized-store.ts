import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { ScryptCredentialHasher } from './normalized/staff-auth-command-service.js'

export interface StoreProvisionConfig {
  version: string
  tenant: { id: string; code: string; name: string }
  store: {
    id: string
    code: string
    name: string
    timezone?: string
    businessDayCutoff?: string
    currency?: string
  }
  areas: Array<{
    code: string
    name: string
    type: 'indoor' | 'outdoor' | 'bar' | 'stage' | 'vip' | 'other'
    sortOrder?: number
    layout?: Record<string, unknown>
  }>
  tables: Array<{
    code: string
    name: string
    areaCode: string
    capacity: number
    minimumSpendMinor?: number | null
    layout?: Record<string, unknown>
  }>
  roles: Array<{
    code: string
    name: string
    permissions: string[]
    navigation?: Array<{
      code: string
      label: string
      route: string
      icon?: string | null
      sortOrder?: number
      highFrequency?: boolean
    }>
    dataScopes?: Array<{
      key: string
      effect: 'include' | 'exclude'
      value: unknown
      enabled?: boolean
    }>
    approvalLimits?: Array<{
      code: string
      amountMinor: number | null
      currency?: string
      rules?: Record<string, unknown>
      enabled?: boolean
    }>
    canReceiveTasks?: boolean
  }>
  employees: Array<{
    code: string
    name: string
    roleCodes: string[]
    pinEnv: string
  }>
  reservationPolicy: {
    holdMinutes: 20
    arrivalGraceMinutes: number
    maxAdvanceDays: number
    defaultDurationMinutes: number
    customerCancelCutoffMinutes: number
    depositMode: 'disabled' | 'flat' | 'minimum_spend_ratio'
    depositMinor?: number | null
    depositRatioBps?: number | null
    depositRuleText?: string | null
  }
  automaticTableTurnover: {
    enabled: boolean
    operatingStartsAt: string
  }
  dailyCredentialEnv?: string
  bootstrapAdminEmployeeCode?: string
}

export interface ProvisionSummary {
  tenantId: string
  storeId: string
  areaCount: number
  tableCount: number
  roleCount: number
  employeeCount: number
  employeeIds: Record<string, string>
  dailyCredentialConfigured: boolean
  configVersion: string
  configSha256: string
}

export interface StoreProvisionEnvironment {
  employeePins: Map<string, string>
  dailyCredential: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const ROLE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/
const PERMISSION = /^[a-z][a-z0-9_.-]{2,127}$/
const ENV_NAME = /^MBOX_[A-Z0-9_]{3,120}$/

export function parseStoreProvisionConfig(value: unknown): StoreProvisionConfig {
  const root = object(value, 'config')
  const version = text(root.version, 'version')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) throw new TypeError('version is invalid')
  const tenant = object(root.tenant, 'tenant')
  const store = object(root.store, 'store')
  const areas = array(root.areas, 'areas').map((entry, index) => {
    const area = object(entry, `areas[${index}]`)
    const type = text(area.type, `areas[${index}].type`)
    if (!['indoor', 'outdoor', 'bar', 'stage', 'vip', 'other'].includes(type)) {
      throw new TypeError(`areas[${index}].type is invalid`)
    }
    return {
      code: code(area.code, `areas[${index}].code`),
      name: text(area.name, `areas[${index}].name`),
      type: type as StoreProvisionConfig['areas'][number]['type'],
      sortOrder: optionalInteger(area.sortOrder, `areas[${index}].sortOrder`) ?? index,
      layout: optionalObject(area.layout, `areas[${index}].layout`) ?? {},
    }
  })
  const tables = array(root.tables, 'tables').map((entry, index) => {
    const table = object(entry, `tables[${index}]`)
    const capacity = integer(table.capacity, `tables[${index}].capacity`)
    if (capacity < 1 || capacity > 200) throw new TypeError(`tables[${index}].capacity is invalid`)
    const minimum = table.minimumSpendMinor === null
      ? null
      : optionalInteger(table.minimumSpendMinor, `tables[${index}].minimumSpendMinor`)
    if (minimum !== undefined && minimum !== null && minimum < 0) {
      throw new TypeError(`tables[${index}].minimumSpendMinor is invalid`)
    }
    return {
      code: code(table.code, `tables[${index}].code`),
      name: text(table.name, `tables[${index}].name`),
      areaCode: code(table.areaCode, `tables[${index}].areaCode`),
      capacity,
      minimumSpendMinor: minimum,
      layout: optionalObject(table.layout, `tables[${index}].layout`) ?? {},
    }
  })
  const roles = array(root.roles, 'roles').map((entry, index) => {
    const role = object(entry, `roles[${index}]`)
    const roleCode = text(role.code, `roles[${index}].code`)
    if (!ROLE_CODE.test(roleCode)) throw new TypeError(`roles[${index}].code is invalid`)
    const permissions = unique(array(role.permissions, `roles[${index}].permissions`).map((permission, p) => {
      const result = text(permission, `roles[${index}].permissions[${p}]`)
      if (!PERMISSION.test(result)) throw new TypeError(`roles[${index}].permissions[${p}] is invalid`)
      return result
    }))
    const navigation = role.navigation === undefined ? [] : array(role.navigation, `roles[${index}].navigation`).map((entry, n) => {
      const item = object(entry, `roles[${index}].navigation[${n}]`)
      const route = text(item.route, `roles[${index}].navigation[${n}].route`)
      if (!route.startsWith('/')) throw new TypeError(`roles[${index}].navigation[${n}].route is invalid`)
      return {
        code: permissionCode(item.code, `roles[${index}].navigation[${n}].code`),
        label: text(item.label, `roles[${index}].navigation[${n}].label`),
        route,
        icon: optionalText(item.icon, `roles[${index}].navigation[${n}].icon`),
        sortOrder: optionalInteger(item.sortOrder, `roles[${index}].navigation[${n}].sortOrder`) ?? n,
        highFrequency: item.highFrequency === true,
      }
    })
    const dataScopes = role.dataScopes === undefined ? [] : array(role.dataScopes, `roles[${index}].dataScopes`).map((entry, s) => {
      const scope = object(entry, `roles[${index}].dataScopes[${s}]`)
      const effect = text(scope.effect, `roles[${index}].dataScopes[${s}].effect`)
      if (effect !== 'include' && effect !== 'exclude') {
        throw new TypeError(`roles[${index}].dataScopes[${s}].effect is invalid`)
      }
      const value = jsonValue(scope.value, `roles[${index}].dataScopes[${s}].value`)
      if (value === null) throw new TypeError(`roles[${index}].dataScopes[${s}].value is invalid`)
      return {
        key: permissionCode(scope.key, `roles[${index}].dataScopes[${s}].key`),
        effect: effect as 'include' | 'exclude',
        value,
        enabled: scope.enabled !== false,
      }
    })
    const approvalLimits = role.approvalLimits === undefined ? [] : array(role.approvalLimits, `roles[${index}].approvalLimits`).map((entry, a) => {
      const approval = object(entry, `roles[${index}].approvalLimits[${a}]`)
      const amountMinor = approval.amountMinor === null
        ? null
        : integer(approval.amountMinor, `roles[${index}].approvalLimits[${a}].amountMinor`)
      if (amountMinor !== null && amountMinor < 0) {
        throw new TypeError(`roles[${index}].approvalLimits[${a}].amountMinor is invalid`)
      }
      const currency = optionalText(approval.currency, `roles[${index}].approvalLimits[${a}].currency`) ?? 'CNY'
      if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError(`roles[${index}].approvalLimits[${a}].currency is invalid`)
      return {
        code: permissionCode(approval.code, `roles[${index}].approvalLimits[${a}].code`),
        amountMinor,
        currency,
        rules: jsonObject(approval.rules, `roles[${index}].approvalLimits[${a}].rules`),
        enabled: approval.enabled !== false,
      }
    })
    return {
      code: roleCode,
      name: text(role.name, `roles[${index}].name`),
      permissions,
      navigation,
      dataScopes,
      approvalLimits,
      canReceiveTasks: role.canReceiveTasks !== false,
    }
  })
  const employees = array(root.employees, 'employees').map((entry, index) => {
    const employee = object(entry, `employees[${index}]`)
    const pinEnv = text(employee.pinEnv, `employees[${index}].pinEnv`)
    if (!ENV_NAME.test(pinEnv)) throw new TypeError(`employees[${index}].pinEnv is invalid`)
    return {
      code: code(employee.code, `employees[${index}].code`),
      name: text(employee.name, `employees[${index}].name`),
      roleCodes: unique(array(employee.roleCodes, `employees[${index}].roleCodes`).map((entry, r) => {
        const result = text(entry, `employees[${index}].roleCodes[${r}]`)
        if (!ROLE_CODE.test(result)) throw new TypeError(`employees[${index}].roleCodes[${r}] is invalid`)
        return result
      })),
      pinEnv,
    }
  })
  const policy = object(root.reservationPolicy, 'reservationPolicy')
  const automaticPolicy = root.automaticTableTurnover === undefined
    ? {} : object(root.automaticTableTurnover, 'automaticTableTurnover')
  const holdMinutes = integer(policy.holdMinutes, 'reservationPolicy.holdMinutes')
  if (holdMinutes !== 20) throw new TypeError('reservationPolicy.holdMinutes must be 20')
  const arrivalGraceMinutes = rangedInteger(policy.arrivalGraceMinutes, 'reservationPolicy.arrivalGraceMinutes', 1, 120)
  const maxAdvanceDays = rangedInteger(policy.maxAdvanceDays, 'reservationPolicy.maxAdvanceDays', 1, 365)
  const defaultDurationMinutes = rangedInteger(policy.defaultDurationMinutes, 'reservationPolicy.defaultDurationMinutes', 30, 720)
  const customerCancelCutoffMinutes = rangedInteger(policy.customerCancelCutoffMinutes, 'reservationPolicy.customerCancelCutoffMinutes', 0, 10_080)
  const depositMode = text(policy.depositMode, 'reservationPolicy.depositMode')
  if (!['disabled', 'flat', 'minimum_spend_ratio'].includes(depositMode)) throw new TypeError('reservationPolicy.depositMode is invalid')
  const depositMinor = policy.depositMinor === null ? null : optionalInteger(policy.depositMinor, 'reservationPolicy.depositMinor')
  const depositRatioBps = policy.depositRatioBps === null ? null : optionalInteger(policy.depositRatioBps, 'reservationPolicy.depositRatioBps')
  if (depositMinor !== undefined && depositMinor !== null && depositMinor < 0) throw new TypeError('reservationPolicy.depositMinor is invalid')
  if (depositRatioBps !== undefined && depositRatioBps !== null && (depositRatioBps < 1 || depositRatioBps > 10_000)) {
    throw new TypeError('reservationPolicy.depositRatioBps is invalid')
  }
  if ((depositMode === 'disabled' && (depositMinor != null || depositRatioBps != null))
    || (depositMode === 'flat' && (depositMinor == null || depositRatioBps != null))
    || (depositMode === 'minimum_spend_ratio' && (depositMinor != null || depositRatioBps == null))) {
    throw new TypeError('reservationPolicy deposit configuration is inconsistent')
  }
  const businessDayCutoff = timeOfDay(
    optionalText(store.businessDayCutoff, 'store.businessDayCutoff') ?? '06:00',
    'store.businessDayCutoff',
  )
  const operatingStartsAt = timeOfDay(
    optionalText(automaticPolicy.operatingStartsAt, 'automaticTableTurnover.operatingStartsAt') ?? '12:00',
    'automaticTableTurnover.operatingStartsAt',
  )
  if (minutesOfDay(operatingStartsAt) <= minutesOfDay(businessDayCutoff)) {
    throw new TypeError('automaticTableTurnover.operatingStartsAt must be after store.businessDayCutoff')
  }
  const result: StoreProvisionConfig = {
    version,
    tenant: {
      id: uuid(tenant.id, 'tenant.id'), code: code(tenant.code, 'tenant.code'), name: text(tenant.name, 'tenant.name'),
    },
    store: {
      id: uuid(store.id, 'store.id'), code: code(store.code, 'store.code'), name: text(store.name, 'store.name'),
      timezone: optionalText(store.timezone, 'store.timezone') ?? 'Asia/Shanghai',
      businessDayCutoff,
      currency: optionalText(store.currency, 'store.currency') ?? 'CNY',
    },
    areas, tables, roles, employees,
    reservationPolicy: {
      holdMinutes: 20,
      arrivalGraceMinutes,
      maxAdvanceDays,
      defaultDurationMinutes,
      customerCancelCutoffMinutes,
      depositMode: depositMode as StoreProvisionConfig['reservationPolicy']['depositMode'],
      depositMinor: depositMinor ?? null,
      depositRatioBps: depositRatioBps ?? null,
      depositRuleText: optionalText(policy.depositRuleText, 'reservationPolicy.depositRuleText'),
    },
    automaticTableTurnover: {
      enabled: optionalBoolean(automaticPolicy.enabled, 'automaticTableTurnover.enabled') ?? false,
      operatingStartsAt,
    },
    dailyCredentialEnv: optionalText(root.dailyCredentialEnv, 'dailyCredentialEnv') ?? undefined,
    bootstrapAdminEmployeeCode: optionalText(root.bootstrapAdminEmployeeCode, 'bootstrapAdminEmployeeCode') ?? undefined,
  }
  assertUnique(result.areas.map((entry) => entry.code), 'area code')
  assertUnique(result.tables.map((entry) => entry.code), 'table code')
  assertUnique(result.roles.map((entry) => entry.code), 'role code')
  assertUnique(result.employees.map((entry) => entry.code), 'employee code')
  const areaCodes = new Set(result.areas.map((entry) => entry.code))
  result.tables.forEach((entry) => { if (!areaCodes.has(entry.areaCode)) throw new TypeError(`unknown area: ${entry.areaCode}`) })
  const roleCodes = new Set(result.roles.map((entry) => entry.code))
  for (const role of result.roles) {
    assertUnique((role.dataScopes ?? []).map((scope) => `${scope.key}:${scope.effect}`), `data scope in role ${role.code}`)
    assertUnique((role.approvalLimits ?? []).map((limit) => `${limit.code}:${limit.currency}`), `approval limit in role ${role.code}`)
  }
  result.employees.flatMap((entry) => entry.roleCodes).forEach((entry) => {
    if (!roleCodes.has(entry)) throw new TypeError(`unknown role: ${entry}`)
  })
  if (result.dailyCredentialEnv && !ENV_NAME.test(result.dailyCredentialEnv)) {
    throw new TypeError('dailyCredentialEnv is invalid')
  }
  if (result.dailyCredentialEnv && !result.bootstrapAdminEmployeeCode) {
    throw new TypeError('bootstrapAdminEmployeeCode is required when dailyCredentialEnv is configured')
  }
  if (result.bootstrapAdminEmployeeCode && !result.employees.some((employee) => employee.code === result.bootstrapAdminEmployeeCode)) {
    throw new TypeError(`unknown bootstrap admin employee: ${result.bootstrapAdminEmployeeCode}`)
  }
  return result
}

export async function provisionNormalizedStore(input: {
  databaseUrl: string
  config: StoreProvisionConfig
  environment?: Readonly<Record<string, string | undefined>>
  now?: Date
  sourceCommitSha?: string
  client?: Client
}): Promise<ProvisionSummary> {
  const environment = input.environment ?? process.env
  const hasher = new ScryptCredentialHasher()
  const provisionEnvironment = validateStoreProvisionEnvironment(input.config, environment)
  const pins = new Map<string, string>()
  for (const [employeeCode, pin] of provisionEnvironment.employeePins) {
    pins.set(employeeCode, await hasher.hash(pin))
  }
  const dailyCredential = provisionEnvironment.dailyCredential
  const dailyCredentialHash = dailyCredential ? await hasher.hash(dailyCredential) : null
  const ownsClient = input.client === undefined
  const client = input.client ?? new Client({ connectionString: input.databaseUrl, application_name: 'mbox-normalized-provisioner' })
  if (ownsClient) await client.connect()
  try {
    // The advisory transaction lock serializes provisioning. READ COMMITTED is
    // intentional here: a transaction waiting for the lock must see the
    // configuration committed by the previous provisioner instead of keeping
    // a stale SERIALIZABLE snapshot and failing with 40001 after the wait.
    if (ownsClient) await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('mbox.normalized.configuration.provision'))`)
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('mbox.normalized.store.provision'))`)
    const schema = await client.query<{ schema_flavor: string; schema_version: string }>(
      'SELECT schema_flavor, schema_version FROM mbox.normalized_schema_metadata WHERE singleton = true',
    )
    if (schema.rows[0]?.schema_flavor !== 'normalized-core-v1' || Number(schema.rows[0]?.schema_version ?? 0) < 45) {
      throw new Error('Normalized schema 046 or later is required')
    }
    const { tenant, store } = input.config
    await client.query(`INSERT INTO mbox.tenants(id, code, name) VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name`, [tenant.id, tenant.code, tenant.name])
    await client.query(`INSERT INTO mbox.stores(id, tenant_id, code, name, timezone, business_day_cutoff, currency)
      VALUES ($1, $2, $3, $4, $5, $6::time, $7)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone,
        business_day_cutoff = EXCLUDED.business_day_cutoff, currency = EXCLUDED.currency`,
    [store.id, tenant.id, store.code, store.name, store.timezone, store.businessDayCutoff, store.currency])
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.store_id', $2, true)`, [tenant.id, store.id])

    const policy = input.config.reservationPolicy
    await client.query(`INSERT INTO mbox.public_reservation_policies(
        tenant_id, store_id, hold_minutes, arrival_grace_minutes, max_advance_days, default_duration_minutes,
        customer_cancel_cutoff_minutes, deposit_mode, deposit_minor, deposit_ratio_bps, deposit_rule_text)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (tenant_id, store_id) DO UPDATE SET
        hold_minutes=EXCLUDED.hold_minutes, arrival_grace_minutes=EXCLUDED.arrival_grace_minutes,
        max_advance_days=EXCLUDED.max_advance_days,
        default_duration_minutes=EXCLUDED.default_duration_minutes,
        customer_cancel_cutoff_minutes=EXCLUDED.customer_cancel_cutoff_minutes,
        deposit_mode=EXCLUDED.deposit_mode, deposit_minor=EXCLUDED.deposit_minor,
        deposit_ratio_bps=EXCLUDED.deposit_ratio_bps, deposit_rule_text=EXCLUDED.deposit_rule_text`, [
      tenant.id, store.id, policy.holdMinutes, policy.arrivalGraceMinutes,
      policy.maxAdvanceDays, policy.defaultDurationMinutes,
      policy.customerCancelCutoffMinutes, policy.depositMode, policy.depositMinor ?? null,
      policy.depositRatioBps ?? null, policy.depositRuleText ?? null,
    ])

    const areaIds = new Map<string, string>()
    for (const area of input.config.areas) {
      const result = await client.query<{ id: string }>(`INSERT INTO mbox.areas(
          tenant_id, store_id, code, name, area_type, sort_order, layout_snapshot)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (tenant_id, store_id, code) DO UPDATE SET name = EXCLUDED.name,
          area_type = EXCLUDED.area_type, sort_order = EXCLUDED.sort_order,
          layout_snapshot = EXCLUDED.layout_snapshot, status = 'active' RETURNING id`,
      [tenant.id, store.id, area.code, area.name, area.type, area.sortOrder, JSON.stringify(area.layout)])
      areaIds.set(area.code, requiredRow(result.rows[0], `area ${area.code}`).id)
    }
    for (const table of input.config.tables) {
      await client.query(`INSERT INTO mbox.tables(
          tenant_id, store_id, area_id, code, display_name, capacity, minimum_spend_minor, currency, layout_snapshot)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT (tenant_id, store_id, code) DO UPDATE SET area_id = EXCLUDED.area_id,
          display_name = EXCLUDED.display_name, capacity = EXCLUDED.capacity,
          minimum_spend_minor = EXCLUDED.minimum_spend_minor, layout_snapshot = EXCLUDED.layout_snapshot,
          status = 'available'`, [tenant.id, store.id, areaIds.get(table.areaCode), table.code,
        table.name, table.capacity, table.minimumSpendMinor ?? null, store.currency, JSON.stringify(table.layout)])
    }

    const roleIds = new Map<string, string>()
    for (const role of input.config.roles) {
      const result = await client.query<{ id: string }>(`INSERT INTO mbox.roles(
          tenant_id, store_id, code, name, capabilities, can_receive_tasks)
        VALUES ($1, $2, $3, $4, $5::text[], $6)
        ON CONFLICT (tenant_id, store_id, code) DO UPDATE SET name = EXCLUDED.name,
          capabilities = EXCLUDED.capabilities, can_receive_tasks = EXCLUDED.can_receive_tasks,
          status = 'active' RETURNING id`,
      [tenant.id, store.id, role.code, role.name, role.permissions, role.canReceiveTasks])
      roleIds.set(role.code, requiredRow(result.rows[0], `role ${role.code}`).id)
    }
    const permissionCodes = unique(input.config.roles.flatMap((role) => role.permissions))
    for (const permission of permissionCodes) {
      await client.query(`INSERT INTO mbox.staff_permission_definitions(
          tenant_id, store_id, code, name, category, description)
        VALUES ($1, $2, $3, $3, split_part($3, '.', 1), 'Provisioned from versioned store configuration')
        ON CONFLICT (tenant_id, store_id, code) DO UPDATE SET status = 'active'`, [tenant.id, store.id, permission])
    }
    for (const role of input.config.roles) {
      const roleId = roleIds.get(role.code)
      if (!roleId) throw new Error(`role ${role.code} is missing after provisioning`)
      await reconcileRoleAccessDefaults(client, tenant.id, store.id, roleId, role, store.currency ?? 'CNY')
      await verifyRoleAccessDefaults(client, tenant.id, store.id, roleId, role)
    }

    const employeeIds: Record<string, string> = {}
    for (const employee of input.config.employees) {
      const result = await client.query<{ id: string }>(`INSERT INTO mbox.employees(
          tenant_id, store_id, employee_code, display_name, pin_hash)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (tenant_id, store_id, employee_code) DO UPDATE SET display_name=EXCLUDED.display_name,
          pin_hash=EXCLUDED.pin_hash, status='active' RETURNING id`,
      [tenant.id, store.id, employee.code, employee.name, pins.get(employee.code)])
      const employeeId = requiredRow(result.rows[0], `employee ${employee.code}`).id
      employeeIds[employee.code] = employeeId
      const desiredRoleIds = employee.roleCodes.map((roleCode) => roleIds.get(roleCode))
      await client.query(`UPDATE mbox.employee_roles SET ends_at=clock_timestamp()
        WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3 AND ends_at IS NULL
          AND NOT (role_id = ANY($4::uuid[]))`, [tenant.id, store.id, employeeId, desiredRoleIds])
      for (const roleCode of employee.roleCodes) {
        await client.query(`INSERT INTO mbox.employee_roles(tenant_id, store_id, employee_id, role_id)
          SELECT $1,$2,$3,$4 WHERE NOT EXISTS (
            SELECT 1 FROM mbox.employee_roles
            WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3 AND role_id=$4 AND ends_at IS NULL
          )`, [tenant.id, store.id, employeeId, roleIds.get(roleCode)])
      }
    }

    const automaticTurnover = input.config.automaticTableTurnover
    await client.query(`INSERT INTO mbox.store_automatic_table_turnover_policies(
        tenant_id,store_id,enabled,operating_starts_at,reason)
      VALUES ($1,$2,$3,$4::time,
        '营业日截止自动收工翻台；财务、退款与晚到支付事实保留待核对')
      ON CONFLICT (tenant_id,store_id) DO UPDATE SET
        enabled=EXCLUDED.enabled,
        operating_starts_at=EXCLUDED.operating_starts_at,
        policy_version=CASE
          WHEN mbox.store_automatic_table_turnover_policies.enabled IS DISTINCT FROM EXCLUDED.enabled
            OR mbox.store_automatic_table_turnover_policies.operating_starts_at IS DISTINCT FROM EXCLUDED.operating_starts_at
          THEN mbox.store_automatic_table_turnover_policies.policy_version+1
          ELSE mbox.store_automatic_table_turnover_policies.policy_version
        END,
        updated_at=clock_timestamp()`, [
      tenant.id, store.id, automaticTurnover.enabled, automaticTurnover.operatingStartsAt,
    ])

    if (dailyCredentialHash) {
      const now = input.now ?? new Date()
      const businessDate = shanghaiBusinessDate(now)
      const validFrom = new Date(now.getTime() - 60_000)
      const validUntil = new Date(now.getTime() + 30 * 60 * 60 * 1_000)
      await client.query(`UPDATE mbox.store_daily_credentials SET revoked_at=clock_timestamp()
        WHERE tenant_id=$1 AND store_id=$2 AND revoked_at IS NULL
          AND (business_date=$3 OR reusable_across_business_dates=true)`, [tenant.id, store.id, businessDate])
      await client.query(`INSERT INTO mbox.store_daily_credentials(
          tenant_id, store_id, business_date, credential_hash, valid_from, valid_until,
          configured_by_employee_id, reusable_across_business_dates)
        VALUES ($1,$2,$3,$4,$5,$6,$7,true)`, [tenant.id, store.id, businessDate, dailyCredentialHash,
        validFrom.toISOString(), validUntil.toISOString(), employeeIds[input.config.bootstrapAdminEmployeeCode ?? '']])
    }
    await client.query(`INSERT INTO mbox.audit_events(
        tenant_id, store_id, actor_type, actor_ref, action, object_type, object_id,
        business_date, after_snapshot, reason)
      VALUES ($1::uuid,$2::uuid,'system','normalized-provisioner','store.provisioned','store',$2::uuid::text,
        $3,$4::jsonb,'Versioned normalized store configuration applied')`, [tenant.id, store.id,
      shanghaiBusinessDate(input.now ?? new Date()), JSON.stringify({ areaCount: input.config.areas.length,
        tableCount: input.config.tables.length, roleCount: input.config.roles.length,
        employeeCount: input.config.employees.length,
        automaticTableTurnover: input.config.automaticTableTurnover })])
    const configSha256 = createHash('sha256').update(stableJson(input.config), 'utf8').digest('hex')
    const sourceCommitSha = input.sourceCommitSha ?? process.env.APP_COMMIT_SHA ?? process.env.GITHUB_SHA
    if (!sourceCommitSha || !/^[0-9a-f]{7,64}$/i.test(sourceCommitSha)) {
      throw new Error('APP_COMMIT_SHA is required for versioned provisioning')
    }
    const existingApplication = await client.query<{ config_sha256: string }>(`
      SELECT config_sha256 FROM mbox.store_configuration_applications
      WHERE tenant_id=$1 AND store_id=$2 AND config_version=$3
      FOR UPDATE`, [tenant.id, store.id, input.config.version])
    if (existingApplication.rows.some((application) => application.config_sha256 !== configSha256)) {
      throw new Error('Configuration version already exists with different content')
    }
    await client.query(`INSERT INTO mbox.store_configuration_applications(
        tenant_id, store_id, config_version, config_sha256, source_commit_sha, summary)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT (tenant_id, store_id, config_version, source_commit_sha) DO NOTHING`, [
      tenant.id, store.id, input.config.version, configSha256, sourceCommitSha.toLowerCase(),
      JSON.stringify({ areaCount: input.config.areas.length, tableCount: input.config.tables.length,
        roleCount: input.config.roles.length, employeeCount: input.config.employees.length }),
    ])
    if (ownsClient) await client.query('COMMIT')
    return {
      tenantId: tenant.id, storeId: store.id, areaCount: input.config.areas.length,
      tableCount: input.config.tables.length, roleCount: input.config.roles.length,
      employeeCount: input.config.employees.length, employeeIds,
      dailyCredentialConfigured: dailyCredentialHash !== null,
      configVersion: input.config.version,
      configSha256,
    }
  } catch (error) {
    if (ownsClient) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    if (ownsClient) await client.end()
  }
}

export function validateStoreProvisionEnvironment(
  config: StoreProvisionConfig,
  environment: Readonly<Record<string, string | undefined>>,
): StoreProvisionEnvironment {
  const employeePins = new Map<string, string>()
  for (const employee of config.employees) {
    const pin = environment[employee.pinEnv]
    if (!pin || !/^\d{4}$/.test(pin)) {
      throw new Error(`Missing valid four-digit PIN environment: ${employee.pinEnv}`)
    }
    employeePins.set(employee.code, pin)
  }
  const dailyCredentialValue = config.dailyCredentialEnv
    ? environment[config.dailyCredentialEnv]
    : null
  if (config.dailyCredentialEnv && (!dailyCredentialValue || dailyCredentialValue.length < 6)) {
    throw new Error(`Missing store credential environment: ${config.dailyCredentialEnv}`)
  }
  return { employeePins, dailyCredential: dailyCredentialValue ?? null }
}

async function reconcileRoleAccessDefaults(
  client: Client,
  tenantId: string,
  storeId: string,
  roleId: string,
  role: StoreProvisionConfig['roles'][number],
  storeCurrency: string,
) {
  const authorityResult = await client.query<{ configuration_kind: string; configuration_code: string }>(`
    SELECT configuration_kind, configuration_code
    FROM mbox.role_access_configuration_authorities
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid
  `, [tenantId, storeId, roleId])
  const runtimeManaged = new Set(authorityResult.rows.map((row) => `${row.configuration_kind}:${row.configuration_code}`))

  const permissionResult = await client.query<{ code: string }>(`
    SELECT permission.code
    FROM mbox.role_permission_assignments assignment
    JOIN mbox.staff_permission_definitions permission
      ON permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id
      AND permission.id=assignment.permission_id
    WHERE assignment.tenant_id=$1::uuid AND assignment.store_id=$2::uuid AND assignment.role_id=$3::uuid
  `, [tenantId, storeId, roleId])
  const desiredPermissions = new Set(role.permissions)
  for (const permissionCode of desiredPermissions) {
    if (runtimeManaged.has(`permission:${permissionCode}`)) continue
    await client.query(`INSERT INTO mbox.role_permission_assignments(
        tenant_id, store_id, role_id, permission_id)
      SELECT $1::uuid,$2::uuid,$3::uuid,permission.id
      FROM mbox.staff_permission_definitions permission
      WHERE permission.tenant_id=$1::uuid AND permission.store_id=$2::uuid AND permission.code=$4
      ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING`, [tenantId, storeId, roleId, permissionCode])
  }
  for (const existing of permissionResult.rows) {
    if (desiredPermissions.has(existing.code) || runtimeManaged.has(`permission:${existing.code}`)) continue
    await client.query(`DELETE FROM mbox.role_permission_assignments assignment
      USING mbox.staff_permission_definitions permission
      WHERE assignment.tenant_id=$1::uuid AND assignment.store_id=$2::uuid AND assignment.role_id=$3::uuid
        AND permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id
        AND permission.id=assignment.permission_id AND permission.code=$4`, [tenantId, storeId, roleId, existing.code])
  }

  const dataScopeResult = await client.query<{ scope_key: string; effect: 'include' | 'exclude' }>(`
    SELECT scope_key, effect FROM mbox.role_data_scopes
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid
  `, [tenantId, storeId, roleId])
  const desiredScopes = new Set((role.dataScopes ?? []).map((scope) => `${scope.key}:${scope.effect}`))
  for (const scope of role.dataScopes ?? []) {
    const code = `${scope.key}:${scope.effect}`
    if (runtimeManaged.has(`data_scope:${code}`)) continue
    const strongValue = strongProvisionedScope(scope.value)
    await client.query(`INSERT INTO mbox.role_data_scopes(
        tenant_id, store_id, role_id, scope_key, effect, scope_value,
        value_kind, boolean_value, text_value, text_values,
        enabled, configured_by_employee_id)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7,$8::boolean,$9,$10::text[],$11,NULL)
      ON CONFLICT (tenant_id, store_id, role_id, scope_key, effect) DO UPDATE
      SET scope_value=EXCLUDED.scope_value, value_kind=EXCLUDED.value_kind,
          boolean_value=EXCLUDED.boolean_value, text_value=EXCLUDED.text_value,
          text_values=EXCLUDED.text_values, enabled=EXCLUDED.enabled,
          configured_by_employee_id=NULL, updated_at=clock_timestamp()`, [
      tenantId, storeId, roleId, scope.key, scope.effect, JSON.stringify(scope.value),
      strongValue.kind, strongValue.booleanValue, strongValue.textValue, strongValue.textValues,
      scope.enabled ?? true,
    ])
  }
  for (const existing of dataScopeResult.rows) {
    const code = `${existing.scope_key}:${existing.effect}`
    if (desiredScopes.has(code) || runtimeManaged.has(`data_scope:${code}`)) continue
    await client.query(`DELETE FROM mbox.role_data_scopes
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid
        AND scope_key=$4 AND effect=$5`, [tenantId, storeId, roleId, existing.scope_key, existing.effect])
  }

  const approvalResult = await client.query<{ approval_code: string; currency: string }>(`
    SELECT approval_code, currency FROM mbox.role_approval_limits
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid
  `, [tenantId, storeId, roleId])
  const desiredApprovals = new Set((role.approvalLimits ?? []).map((approval) => `${approval.code}:${approval.currency ?? storeCurrency}`))
  for (const approval of role.approvalLimits ?? []) {
    const currency = approval.currency ?? storeCurrency
    const code = `${approval.code}:${currency}`
    if (runtimeManaged.has(`approval_limit:${code}`)) continue
    const strongRules = strongProvisionedApproval(approval.rules ?? {})
    await client.query(`INSERT INTO mbox.role_approval_limits(
        tenant_id, store_id, role_id, approval_code, amount_minor, currency, rules,
        calculation_mode, fixed_amount_minor, discount_basis_points,
        allow_full_gift, requires_reason, requires_second_actor,
        enabled, configured_by_employee_id)
      VALUES (
        $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,
        $8,$9::bigint,$10::integer,$11,$12,$13,$14,NULL
      )
      ON CONFLICT (tenant_id, store_id, role_id, approval_code, currency) DO UPDATE
      SET amount_minor=EXCLUDED.amount_minor, rules=EXCLUDED.rules,
          calculation_mode=EXCLUDED.calculation_mode,
          fixed_amount_minor=EXCLUDED.fixed_amount_minor,
          discount_basis_points=EXCLUDED.discount_basis_points,
          allow_full_gift=EXCLUDED.allow_full_gift,
          requires_reason=EXCLUDED.requires_reason,
          requires_second_actor=EXCLUDED.requires_second_actor,
          enabled=EXCLUDED.enabled,
          configured_by_employee_id=NULL, updated_at=clock_timestamp()`, [
      tenantId, storeId, roleId, approval.code, approval.amountMinor, currency,
      JSON.stringify(approval.rules ?? {}), strongRules.calculationMode,
      strongRules.fixedAmountMinor, strongRules.discountBasisPoints,
      strongRules.allowFullGift, strongRules.requiresReason, strongRules.requiresSecondActor,
      approval.enabled ?? true,
    ])
  }
  for (const existing of approvalResult.rows) {
    const code = `${existing.approval_code}:${existing.currency}`
    if (desiredApprovals.has(code) || runtimeManaged.has(`approval_limit:${code}`)) continue
    await client.query(`DELETE FROM mbox.role_approval_limits
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid
        AND approval_code=$4 AND currency=$5`, [tenantId, storeId, roleId, existing.approval_code, existing.currency])
  }

  const navigationResult = await client.query<{ navigation_code: string }>(`
    SELECT navigation_code FROM mbox.role_navigation_items
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid
  `, [tenantId, storeId, roleId])
  const desiredNavigation = new Set((role.navigation ?? []).map((navigation) => navigation.code))
  for (const navigation of role.navigation ?? []) {
    if (runtimeManaged.has(`navigation:${navigation.code}`)) continue
    await client.query(`INSERT INTO mbox.role_navigation_items(
        tenant_id, store_id, role_id, navigation_code, label, route, icon,
        sort_order, enabled, display_config, configured_by_employee_id)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,true,$9::jsonb,NULL)
      ON CONFLICT (tenant_id, store_id, role_id, navigation_code) DO UPDATE
      SET label=EXCLUDED.label, route=EXCLUDED.route, icon=EXCLUDED.icon,
          sort_order=EXCLUDED.sort_order, enabled=true, display_config=EXCLUDED.display_config,
          configured_by_employee_id=NULL, updated_at=clock_timestamp()`, [
      tenantId, storeId, roleId, navigation.code, navigation.label, navigation.route,
      navigation.icon ?? null, navigation.sortOrder ?? 0,
      JSON.stringify({ highFrequency: navigation.highFrequency ?? false }),
    ])
  }
  for (const existing of navigationResult.rows) {
    if (desiredNavigation.has(existing.navigation_code) || runtimeManaged.has(`navigation:${existing.navigation_code}`)) continue
    await client.query(`DELETE FROM mbox.role_navigation_items
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid AND navigation_code=$4`, [
      tenantId, storeId, roleId, existing.navigation_code,
    ])
  }
}

async function verifyRoleAccessDefaults(
  client: Client,
  tenantId: string,
  storeId: string,
  roleId: string,
  role: StoreProvisionConfig['roles'][number],
) {
  const authorityResult = await client.query<{ configuration_kind: string; configuration_code: string }>(`
    SELECT configuration_kind, configuration_code
    FROM mbox.role_access_configuration_authorities
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid
  `, [tenantId, storeId, roleId])
  const runtimeManaged = new Set(authorityResult.rows.map((row) => `${row.configuration_kind}:${row.configuration_code}`))
  const permissionResult = await client.query<{ code: string }>(`
    SELECT permission.code
    FROM mbox.role_permission_assignments assignment
    JOIN mbox.staff_permission_definitions permission
      ON permission.tenant_id=assignment.tenant_id AND permission.store_id=assignment.store_id
      AND permission.id=assignment.permission_id
    WHERE assignment.tenant_id=$1::uuid AND assignment.store_id=$2::uuid AND assignment.role_id=$3::uuid
  `, [tenantId, storeId, roleId])
  const actualPermissions = permissionResult.rows
    .map((row) => row.code)
    .filter((code) => !runtimeManaged.has(`permission:${code}`))
    .toSorted()
  const desiredPermissions = role.permissions
    .filter((code) => !runtimeManaged.has(`permission:${code}`))
    .toSorted()
  if (JSON.stringify(actualPermissions) !== JSON.stringify(desiredPermissions)) {
    const missing = desiredPermissions.filter((code) => !actualPermissions.includes(code))
    const unexpected = actualPermissions.filter((code) => !desiredPermissions.includes(code))
    throw new Error(
      `Role ${role.code} permission readback does not match versioned configuration`
      + ` (missing: ${missing.join(',') || 'none'}; unexpected: ${unexpected.join(',') || 'none'})`,
    )
  }

  const navigationResult = await client.query<{
    navigation_code: string
    label: string
    route: string
    icon: string | null
    sort_order: number
    enabled: boolean
  }>(`
    SELECT navigation_code, label, route, icon, sort_order, enabled
    FROM mbox.role_navigation_items
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND role_id=$3::uuid
  `, [tenantId, storeId, roleId])
  const actualNavigation = navigationResult.rows
    .filter((entry) => !runtimeManaged.has(`navigation:${entry.navigation_code}`))
    .map((entry) => ({
      code: entry.navigation_code,
      label: entry.label,
      route: entry.route,
      icon: entry.icon,
      sortOrder: entry.sort_order,
      enabled: entry.enabled,
    }))
    .toSorted((left, right) => left.code.localeCompare(right.code))
  const desiredNavigation = (role.navigation ?? [])
    .filter((entry) => !runtimeManaged.has(`navigation:${entry.code}`))
    .map((entry) => ({
      code: entry.code,
      label: entry.label,
      route: entry.route,
      icon: entry.icon ?? null,
      sortOrder: entry.sortOrder ?? 0,
      enabled: true,
    }))
    .toSorted((left, right) => left.code.localeCompare(right.code))
  if (JSON.stringify(actualNavigation) !== JSON.stringify(desiredNavigation)) {
    throw new Error(`Role ${role.code} navigation readback does not match versioned configuration`)
  }
}

function strongProvisionedScope(value: unknown) {
  if (typeof value === 'boolean') {
    return { kind: 'boolean', booleanValue: value, textValue: null, textValues: [] as string[] }
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return { kind: 'text', booleanValue: null, textValue: value.trim(), textValues: [] as string[] }
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) {
    return {
      kind: 'text_set', booleanValue: null, textValue: null,
      textValues: [...new Set(value.map((entry) => (entry as string).trim()))].toSorted(),
    }
  }
  throw new TypeError('Provisioned data scope must be a boolean, text, or text array')
}

function strongProvisionedApproval(rules: Record<string, unknown>) {
  const allowFullGift = rules.allowFullGift === true
  const fixedAmountMinor = rules.fixedAmountMinor === undefined
    ? null : rangedInteger(rules.fixedAmountMinor, 'fixedAmountMinor', 1, Number.MAX_SAFE_INTEGER)
  const discountBasisPoints = rules.discountBasisPoints === undefined
    ? null : rangedInteger(rules.discountBasisPoints, 'discountBasisPoints', 1, 9999)
  if (Number(allowFullGift) + Number(fixedAmountMinor !== null) + Number(discountBasisPoints !== null) > 1) {
    throw new TypeError('Provisioned approval must select one calculation mode')
  }
  return {
    calculationMode: allowFullGift ? 'full_gift'
      : fixedAmountMinor !== null ? 'fixed_amount'
        : discountBasisPoints !== null ? 'basis_points' : 'amount_limit',
    fixedAmountMinor,
    discountBasisPoints,
    allowFullGift,
    requiresReason: rules.requiresReason !== false,
    requiresSecondActor: rules.requiresSecondActor === true,
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function rangedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const result = integer(value, name)
  if (result < minimum || result > maximum) throw new TypeError(`${name} is invalid`)
  return result
}

export function shanghaiBusinessDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const businessDate = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)))
  if (Number(values.hour) < 6) businessDate.setUTCDate(businessDate.getUTCDate() - 1)
  return businessDate.toISOString().slice(0, 10)
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`)
  return value as Record<string, unknown>
}
function optionalObject(value: unknown, field: string) { return value === undefined ? undefined : object(value, field) }
function array(value: unknown, field: string): unknown[] { if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`); return value }
function text(value: unknown, field: string): string { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must not be blank`); return value.trim() }
function optionalText(value: unknown, field: string): string | undefined | null { if (value === undefined) return undefined; if (value === null) return null; return text(value, field) }
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`)
  return value
}
function timeOfDay(value: string, field: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new TypeError(`${field} is invalid`)
  return value
}
function minutesOfDay(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}
function integer(value: unknown, field: string): number { if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be an integer`); return value as number }
function optionalInteger(value: unknown, field: string): number | undefined { return value === undefined ? undefined : integer(value, field) }
function jsonValue(value: unknown, field: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${field} must be valid JSON`)
    return value
  }
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${field}[${index}]`))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonValue(entry, `${field}.${key}`)]))
  }
  throw new TypeError(`${field} must be valid JSON`)
}
function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {}
  const parsed = jsonValue(value, field)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${field} must be an object`)
  }
  return parsed as Record<string, unknown>
}
function uuid(value: unknown, field: string): string { const result = text(value, field); if (!UUID.test(result)) throw new TypeError(`${field} is invalid`); return result }
function code(value: unknown, field: string): string { const result = text(value, field); if (!CODE.test(result)) throw new TypeError(`${field} is invalid`); return result }
function permissionCode(value: unknown, field: string): string { const result = text(value, field); if (!PERMISSION.test(result)) throw new TypeError(`${field} is invalid`); return result }
function unique(values: string[]): string[] { return [...new Set(values)] }
function assertUnique(values: string[], field: string) { if (new Set(values).size !== values.length) throw new TypeError(`duplicate ${field}`) }
function requiredRow<T>(row: T | undefined, field: string): T { if (row === undefined) throw new Error(`Unable to provision ${field}`); return row }

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  const configArgument = process.argv.find((entry) => entry.startsWith('--config='))?.slice('--config='.length)
  if (!configArgument) throw new Error('Usage: npm run db:provision:normalized -- --config=/absolute/store.json')
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const config = parseStoreProvisionConfig(JSON.parse(await readFile(resolve(configArgument), 'utf8')))
  const summary = await provisionNormalizedStore({ databaseUrl, config })
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}
