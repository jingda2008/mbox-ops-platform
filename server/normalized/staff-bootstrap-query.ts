import { createHash } from 'node:crypto'
import type {
  StaffBootstrapView,
  StaffDomainKey,
  StaffDomainSummary,
  StaffEndpointReferences,
  StaffHighFrequencyEntry,
} from '../../src/shared/normalized-contracts.js'
import { STAFF_BOOTSTRAP_SCHEMA_VERSION } from '../../src/shared/normalized-contracts.js'
import {
  ScopedPostgresTransactionRunner,
  type ScopedTransaction,
  type StoreScope,
} from './transaction-runner.js'

export interface StaffBootstrapQueryResult {
  view: StaffBootstrapView
  etag: string
}

interface BootstrapIdentityRow extends Record<string, unknown> {
  id: string
  code: string
  name: string
  timezone: string
  business_day_cutoff: string
  currency: string
  business_day_status: StaffBootstrapView['businessDay']['status']
  business_day_opened_at: string | null
  business_day_rollover_at: string | null
  business_day_closed_at: string | null
  employee_id: string
  employee_code: string
  display_name: string
  role_codes: unknown
  role_names: unknown
  permissions: unknown
  denied_permissions: unknown
  data_scopes: unknown
  approval_limits: unknown
  navigation: unknown
  resolved_at: string
  identity_watermark: string
}

interface SummaryRow extends Record<string, unknown> {
  active_tables: string
  open_service_tasks: string
  urgent_service_tasks: string
  active_kds_tasks: string
  ready_kds_tasks: string
  overdue_kds_tasks: string
  active_reservations: string
  reservation_attention: string
  pending_payments: string
  failed_payments: string
  refund_approvals: string
  low_inventory_items: string
  active_print_jobs: string
  failed_print_jobs: string
  watermark_seed: string
}

interface DomainDefinition {
  key: StaffDomainKey
  label: string
  endpointRef: keyof StaffEndpointReferences
  permissionPrefixes: readonly string[]
  navigationCodes: readonly string[]
  values(row: SummaryRow): Pick<StaffDomainSummary, 'activeCount' | 'attentionCount' | 'readyCount'>
}

const ENDPOINT_REFERENCES: StaffEndpointReferences = Object.freeze({
  workspace: '/api/staff/workspace',
  sessions: '/api/operations',
  operations: '/api/operations',
  tableManagement: '/api/table-management/tables',
  fulfillment: '/api/commerce/fulfillment',
  reservations: '/api/staff/reservations',
  reservationIntake: '/api/staff/reservation-intake',
  reconciliation: '/api/reconciliation',
  inventory: '/api/inventory',
  notifications: '/api/notifications',
  aiCapabilities: '/api/ai/capabilities',
  hardwareWork: '/api/hardware/work',
})

const DOMAIN_DEFINITIONS: readonly DomainDefinition[] = [
  {
    key: 'live', label: '营业桌台', endpointRef: 'operations',
    permissionPrefixes: ['dashboard.', 'table.'], navigationCodes: ['live'],
    values: (row) => counts(row.active_tables, '0', '0'),
  },
  {
    key: 'service', label: '服务任务', endpointRef: 'operations',
    permissionPrefixes: ['service.', 'sop.'], navigationCodes: ['tasks'],
    values: (row) => counts(row.open_service_tasks, row.urgent_service_tasks, '0'),
  },
  {
    key: 'fulfillment', label: '出品履约', endpointRef: 'fulfillment',
    permissionPrefixes: ['order.', 'work.'], navigationCodes: ['commerce'],
    values: (row) => counts(row.active_kds_tasks, row.overdue_kds_tasks, row.ready_kds_tasks),
  },
  {
    key: 'reservations', label: '当日预约', endpointRef: 'reservations',
    permissionPrefixes: ['reservation.'], navigationCodes: ['reservations'],
    values: (row) => counts(row.active_reservations, row.reservation_attention, '0'),
  },
  {
    key: 'payments', label: '收银异常', endpointRef: 'reconciliation',
    permissionPrefixes: ['payment.', 'refund.', 'cash.'], navigationCodes: ['payments'],
    values: (row) => counts(row.pending_payments, addCounts(row.failed_payments, row.refund_approvals), '0'),
  },
  {
    key: 'inventory', label: '库存预警', endpointRef: 'inventory',
    permissionPrefixes: ['inventory.', 'bottle.'], navigationCodes: ['inventory'],
    values: (row) => counts(row.low_inventory_items, row.low_inventory_items, '0'),
  },
  {
    key: 'printing', label: '打印任务', endpointRef: 'hardwareWork',
    permissionPrefixes: ['print.', 'hardware.'], navigationCodes: ['devices'],
    values: (row) => counts(row.active_print_jobs, row.failed_print_jobs, '0'),
  },
]

export class StaffBootstrapQuery {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  async get(
    scope: Readonly<StoreScope>,
    employeeId: string,
    businessDate: string,
  ): Promise<StaffBootstrapQueryResult> {
    if (employeeId.trim().length === 0) throw new TypeError('employeeId must not be blank')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new TypeError('businessDate must use YYYY-MM-DD')

    const reads = await Promise.allSettled([
      this.transactions.run(
        scope,
        (transaction) => readIdentity(transaction, employeeId, businessDate),
        { isolation: 'repeatable-read', readOnly: true },
      ),
      this.transactions.run(
        scope,
        (transaction) => readSummaries(transaction, businessDate, employeeId),
        { isolation: 'repeatable-read', readOnly: true },
      ),
    ] as const)
    const [identityRead, summaryRead] = reads
    if (identityRead.status === 'rejected') throw identityRead.reason
    if (summaryRead.status === 'rejected') throw summaryRead.reason
    const identity = identityRead.value
    const summary = summaryRead.value
    const roleCodes = stringArray(identity.role_codes)
    const roleNames = stringArray(identity.role_names)
    const permissions = stringArray(identity.permissions)
    const deniedPermissions = stringArray(identity.denied_permissions)
    const dataScopes = dataScopeArray(identity.data_scopes)
    const approvalLimits = approvalLimitArray(identity.approval_limits)
    const navigation = navigationArray(identity.navigation)
    const watermark = hashWatermark([
      scope.tenantId,
      scope.storeId,
      employeeId,
      businessDate,
      identity.identity_watermark,
      summary.watermark_seed,
      JSON.stringify({
        roles: roleCodes,
        permissions,
        denied: deniedPermissions,
        scopes: dataScopes,
        approvals: approvalLimits,
        navigation,
      }),
    ].join('|'))
    const generatedAt = identity.resolved_at
    const view: StaffBootstrapView = {
      schemaVersion: STAFF_BOOTSTRAP_SCHEMA_VERSION,
      generatedAt,
      watermark,
      store: {
        id: identity.id,
        code: identity.code,
        name: identity.name,
        timezone: identity.timezone,
        businessDayCutoff: identity.business_day_cutoff,
        currency: identity.currency,
      },
      businessDay: {
        date: businessDate,
        status: identity.business_day_status,
        openedAt: identity.business_day_opened_at,
        rolloverAt: identity.business_day_rollover_at,
        closedAt: identity.business_day_closed_at,
      },
      staff: {
        id: identity.employee_id,
        code: identity.employee_code,
        displayName: identity.display_name,
        roleCodes,
        roleNames,
      },
      access: {
        permissions,
        deniedPermissions,
        dataScopes,
        approvalLimits,
        resolvedAt: identity.resolved_at,
      },
      navigation,
      highFrequencyEntries: highFrequencyEntries(navigation),
      domainSummaries: visibleDomainSummaries(summary, permissions, navigation.map((item) => item.code)),
      endpointRefs: { ...ENDPOINT_REFERENCES },
    }
    return { view, etag: `"staff-bootstrap-${watermark}"` }
  }
}

async function readIdentity(
  transaction: ScopedTransaction,
  employeeId: string,
  businessDate: string,
): Promise<BootstrapIdentityRow> {
  const result = await transaction.query<BootstrapIdentityRow>(`
    WITH active_roles AS (
      SELECT role.id, role.code, role.name, role.updated_at, employee_role.created_at
      FROM mbox.employee_roles AS employee_role
      JOIN mbox.roles AS role
        ON role.tenant_id = employee_role.tenant_id
        AND role.store_id = employee_role.store_id
        AND role.id = employee_role.role_id
      WHERE employee_role.tenant_id = $1::uuid
        AND employee_role.store_id = $2::uuid
        AND employee_role.employee_id = $4::uuid
        AND role.status = 'active'
        AND employee_role.starts_at <= transaction_timestamp()
        AND (employee_role.ends_at IS NULL OR employee_role.ends_at > transaction_timestamp())
    ), permission_facts AS (
      SELECT permission.code,
        EXISTS (
          SELECT 1 FROM mbox.role_permission_assignments AS assignment
          JOIN active_roles AS active_role ON active_role.id = assignment.role_id
          WHERE assignment.tenant_id = permission.tenant_id
            AND assignment.store_id = permission.store_id
            AND assignment.permission_id = permission.id
        ) AS role_granted,
        EXISTS (
          SELECT 1 FROM mbox.employee_permission_overrides AS override
          WHERE override.tenant_id = permission.tenant_id
            AND override.store_id = permission.store_id
            AND override.employee_id = $4::uuid
            AND override.permission_id = permission.id
            AND override.effect = 'grant'
            AND override.starts_at <= transaction_timestamp()
            AND (override.ends_at IS NULL OR override.ends_at > transaction_timestamp())
        ) AS override_granted,
        EXISTS (
          SELECT 1 FROM mbox.employee_permission_overrides AS override
          WHERE override.tenant_id = permission.tenant_id
            AND override.store_id = permission.store_id
            AND override.employee_id = $4::uuid
            AND override.permission_id = permission.id
            AND override.effect = 'deny'
            AND override.starts_at <= transaction_timestamp()
            AND (override.ends_at IS NULL OR override.ends_at > transaction_timestamp())
        ) AS override_denied
      FROM mbox.staff_permission_definitions AS permission
      WHERE permission.tenant_id = $1::uuid
        AND permission.store_id = $2::uuid
        AND permission.status = 'active'
    ), effective_navigation AS (
      SELECT DISTINCT ON (navigation.navigation_code)
        navigation.navigation_code, navigation.label, navigation.route,
        navigation.icon, navigation.sort_order, navigation.display_config,
        navigation.updated_at
      FROM mbox.role_navigation_items AS navigation
      JOIN active_roles AS active_role ON active_role.id = navigation.role_id
      WHERE navigation.tenant_id = $1::uuid
        AND navigation.store_id = $2::uuid
        AND navigation.enabled = true
      ORDER BY navigation.navigation_code, navigation.sort_order, navigation.id
    )
    SELECT store.id, store.code, store.name, store.timezone,
      store.business_day_cutoff::text, store.currency,
      COALESCE(day.status, 'not_initialized') AS business_day_status,
      day.opened_at::text AS business_day_opened_at,
      day.rollover_at::text AS business_day_rollover_at,
      day.closed_at::text AS business_day_closed_at,
      employee.id AS employee_id,
      employee.employee_code,
      employee.display_name,
      COALESCE((SELECT jsonb_agg(code ORDER BY code) FROM active_roles), '[]'::jsonb) AS role_codes,
      COALESCE((SELECT jsonb_agg(name ORDER BY code, name) FROM active_roles), '[]'::jsonb) AS role_names,
      COALESCE((SELECT jsonb_agg(code ORDER BY code) FROM permission_facts
        WHERE (role_granted OR override_granted) AND NOT override_denied), '[]'::jsonb) AS permissions,
      COALESCE((SELECT jsonb_agg(code ORDER BY code) FROM permission_facts
        WHERE override_denied), '[]'::jsonb) AS denied_permissions,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'key', scope.scope_key, 'effect', scope.effect, 'value', CASE scope.value_kind
          WHEN 'boolean' THEN to_jsonb(scope.boolean_value)
          WHEN 'text' THEN to_jsonb(scope.text_value)
          ELSE to_jsonb(scope.text_values) END
      ) ORDER BY scope.scope_key, scope.effect)
        FROM mbox.role_data_scopes AS scope
        JOIN active_roles AS active_role ON active_role.id = scope.role_id
        WHERE scope.tenant_id = $1::uuid AND scope.store_id = $2::uuid AND scope.enabled = true
      ), '[]'::jsonb) AS data_scopes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'code', approval.approval_code,
        'amountMinor', approval.amount_minor,
        'currency', approval.currency,
        'rules', jsonb_strip_nulls(jsonb_build_object(
          'allowFullGift', CASE WHEN approval.allow_full_gift THEN true ELSE NULL END,
          'fixedAmountMinor', approval.fixed_amount_minor,
          'discountBasisPoints', approval.discount_basis_points,
          'requiresReason', CASE WHEN approval.requires_reason THEN true ELSE NULL END,
          'requiresSecondActor', CASE WHEN approval.requires_second_actor THEN true ELSE NULL END
        ))
      ) ORDER BY approval.approval_code, approval.currency, approval.amount_minor DESC NULLS LAST)
        FROM mbox.role_approval_limits AS approval
        JOIN active_roles AS active_role ON active_role.id = approval.role_id
        WHERE approval.tenant_id = $1::uuid AND approval.store_id = $2::uuid AND approval.enabled = true
      ), '[]'::jsonb) AS approval_limits,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'code', navigation_code, 'label', label, 'route', route, 'icon', icon,
        'sortOrder', sort_order, 'displayConfig', display_config
      ) ORDER BY sort_order, navigation_code) FROM effective_navigation), '[]'::jsonb) AS navigation,
      transaction_timestamp()::text AS resolved_at,
      GREATEST(
        store.updated_at,
        employee.updated_at,
        COALESCE(day.updated_at, '-infinity'::timestamptz),
        COALESCE((SELECT max(updated_at) FROM active_roles), '-infinity'::timestamptz),
        COALESCE((SELECT max(updated_at) FROM effective_navigation), '-infinity'::timestamptz),
        COALESCE((SELECT max(updated_at) FROM mbox.staff_permission_definitions
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid), '-infinity'::timestamptz),
        COALESCE((SELECT max(updated_at) FROM mbox.role_permission_assignments
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid), '-infinity'::timestamptz),
        COALESCE((SELECT max(updated_at) FROM mbox.employee_permission_overrides
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND employee_id = $4::uuid), '-infinity'::timestamptz)
      )::text AS identity_watermark
    FROM mbox.stores AS store
    JOIN mbox.employees AS employee
      ON employee.tenant_id = store.tenant_id
      AND employee.store_id = store.id
      AND employee.id = $4::uuid
      AND employee.status = 'active'
    LEFT JOIN mbox.business_days AS day
      ON day.tenant_id = store.tenant_id
      AND day.store_id = store.id
      AND day.business_date = $3::date
    WHERE store.tenant_id = $1::uuid AND store.id = $2::uuid AND store.status = 'active'
  `, [transaction.scope.tenantId, transaction.scope.storeId, businessDate, employeeId])
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new StaffBootstrapStoreNotFoundError()
  return row
}

async function readSummaries(
  transaction: ScopedTransaction,
  businessDate: string,
  employeeId: string,
): Promise<SummaryRow> {
  const result = await transaction.query<SummaryRow>(`
    WITH business_window AS (
      SELECT
        ($3::date::timestamp + business_day_cutoff) AT TIME ZONE timezone AS starts_at,
        (($3::date + 1)::timestamp + business_day_cutoff) AT TIME ZONE timezone AS ends_at
      FROM mbox.stores
      WHERE tenant_id = $1::uuid AND id = $2::uuid
    )
    SELECT
      (SELECT count(*) FROM mbox.table_sessions WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND business_date = $3::date AND status IN ('open', 'closing'))::text AS active_tables,
      (SELECT count(*) FROM mbox.service_tasks WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status IN ('pending', 'acknowledged', 'in_progress'))::text AS open_service_tasks,
      (SELECT count(*) FROM mbox.service_tasks WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status IN ('pending', 'acknowledged', 'in_progress')
        AND (priority IN ('urgent', 'high') OR (due_at IS NOT NULL AND due_at <= clock_timestamp())))::text AS urgent_service_tasks,
      (SELECT count(*) FROM mbox.kds_tasks WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status IN ('pending', 'accepted', 'preparing'))::text AS active_kds_tasks,
      (SELECT count(*) FROM mbox.kds_tasks WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status = 'ready')::text AS ready_kds_tasks,
      (SELECT count(*) FROM mbox.kds_tasks WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status IN ('pending', 'accepted', 'preparing') AND due_at IS NOT NULL
        AND due_at <= clock_timestamp())::text AS overdue_kds_tasks,
      (SELECT count(*) FROM mbox.reservations WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND arrival_at >= business_window.starts_at AND arrival_at < business_window.ends_at
        AND status IN ('pending', 'confirmed', 'arrived', 'seated'))::text AS active_reservations,
      (SELECT count(*) FROM mbox.reservations WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND arrival_at >= business_window.starts_at AND arrival_at < business_window.ends_at
        AND status = 'pending')::text AS reservation_attention,
      (SELECT count(*) FROM mbox.payments WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status IN ('created', 'pending'))::text AS pending_payments,
      (SELECT count(*) FROM mbox.payments WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status = 'failed')::text AS failed_payments,
      (SELECT count(*) FROM mbox.refunds WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status = 'requested')::text AS refund_approvals,
      (SELECT count(*) FROM mbox.inventory_balances AS balance
        JOIN mbox.inventory_items AS item ON item.tenant_id = balance.tenant_id
          AND item.store_id = balance.store_id AND item.id = balance.inventory_item_id
        WHERE balance.tenant_id = $1::uuid AND balance.store_id = $2::uuid
          AND item.status = 'active' AND item.low_stock_threshold IS NOT NULL
          AND balance.on_hand_quantity <= item.low_stock_threshold)::text AS low_inventory_items,
      (SELECT count(*) FROM mbox.print_jobs WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status IN ('pending', 'printing', 'failed'))::text AS active_print_jobs,
      (SELECT count(*) FROM mbox.print_jobs WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND status IN ('failed', 'dead'))::text AS failed_print_jobs,
      concat_ws('|', $4::uuid::text,
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.stores
          WHERE tenant_id = $1::uuid AND id = $2::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.business_days
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.employees
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $4::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.role_permission_assignments
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.employee_permission_overrides
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND employee_id = $4::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.role_navigation_items
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.table_sessions
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.service_tasks
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.kds_tasks
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.reservations
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.payments
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.refunds
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.inventory_balances
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid),
        (SELECT concat(count(*), ':', COALESCE(max(updated_at)::text, '')) FROM mbox.print_jobs
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid)
      ) AS watermark_seed
    FROM business_window
  `, [transaction.scope.tenantId, transaction.scope.storeId, businessDate, employeeId])
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error('Staff bootstrap summary query returned no row')
  return row
}

function highFrequencyEntries(navigation: StaffBootstrapView['navigation']): StaffHighFrequencyEntry[] {
  const explicitlyEnabled = navigation.filter((item) => item.displayConfig.highFrequency === true)
  const source = explicitlyEnabled.length > 0 ? explicitlyEnabled : navigation.slice(0, 4)
  return source.slice(0, 6).map(({ code, label, route, icon }) => ({ code, label, route, icon }))
}

function visibleDomainSummaries(
  row: SummaryRow,
  permissions: readonly string[],
  navigationCodes: readonly string[],
): StaffDomainSummary[] {
  return DOMAIN_DEFINITIONS.filter((domain) => (
    domain.navigationCodes.some((code) => navigationCodes.includes(code))
    || domain.permissionPrefixes.some((prefix) => permissions.some((permission) => permission.startsWith(prefix)))
  )).map((domain) => ({
    key: domain.key,
    label: domain.label,
    ...domain.values(row),
    endpointRef: ENDPOINT_REFERENCES[domain.endpointRef],
  }))
}

function counts(active: string, attention: string, ready: string) {
  return {
    activeCount: safeCount(active),
    attentionCount: safeCount(attention),
    readyCount: safeCount(ready),
  }
}

function safeCount(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid aggregate count: ${value}`)
  return parsed
}

function addCounts(left: string, right: string): string {
  return String(safeCount(left) + safeCount(right))
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Staff bootstrap identity contains an invalid string array')
  }
  return [...value]
}

function dataScopeArray(value: unknown): StaffBootstrapView['access']['dataScopes'] {
  return objectArray(value, 'data scopes').map((item) => {
    if (typeof item.key !== 'string' || (item.effect !== 'include' && item.effect !== 'exclude')) {
      throw new Error('Staff bootstrap identity contains an invalid data scope')
    }
    return { key: item.key, effect: item.effect, value: item.value }
  })
}

function approvalLimitArray(value: unknown): StaffBootstrapView['access']['approvalLimits'] {
  return objectArray(value, 'approval limits').map((item) => {
    if (typeof item.code !== 'string' || typeof item.currency !== 'string' || !isRecord(item.rules)) {
      throw new Error('Staff bootstrap identity contains an invalid approval limit')
    }
    const amountMinor = item.amountMinor === null ? null : Number(item.amountMinor)
    if (amountMinor !== null && (!Number.isSafeInteger(amountMinor) || amountMinor < 0)) {
      throw new Error('Staff bootstrap identity contains an invalid approval amount')
    }
    return { code: item.code, amountMinor, currency: item.currency, rules: item.rules }
  })
}

function navigationArray(value: unknown): StaffBootstrapView['navigation'] {
  return objectArray(value, 'navigation').map((item) => {
    if (
      typeof item.code !== 'string'
      || typeof item.label !== 'string'
      || typeof item.route !== 'string'
      || !item.route.startsWith('/')
      || (item.icon !== null && typeof item.icon !== 'string')
      || !Number.isSafeInteger(item.sortOrder)
      || !isRecord(item.displayConfig)
    ) throw new Error('Staff bootstrap identity contains an invalid navigation item')
    return {
      code: item.code,
      label: item.label,
      route: item.route,
      icon: item.icon,
      sortOrder: item.sortOrder as number,
      displayConfig: item.displayConfig,
    }
  })
}

function objectArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new Error(`Staff bootstrap identity contains invalid ${label}`)
  }
  return value as Record<string, unknown>[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hashWatermark(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 32)
}

export class StaffBootstrapStoreNotFoundError extends Error {
  constructor() {
    super('Active store was not found')
    this.name = 'StaffBootstrapStoreNotFoundError'
  }
}
