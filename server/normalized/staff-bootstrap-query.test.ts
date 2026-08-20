import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import type { PostgresPool, PostgresPoolClient, PostgresQueryResult } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { StaffBootstrapQuery, StaffBootstrapStoreNotFoundError } from './staff-bootstrap-query.js'

const tenantId = '91111111-1111-4111-8111-111111111111'
const storeId = '92222222-2222-4222-8222-222222222222'
const employeeId = '93333333-3333-4333-8333-333333333333'

type ScriptedResponse = PostgresQueryResult | (() => PostgresQueryResult | Promise<PostgresQueryResult>)

class ScriptedClient implements PostgresPoolClient {
  readonly calls: Array<{ sql: string; values: unknown[] }> = []
  released = false

  constructor(private readonly responses: ScriptedResponse[]) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql: text.replace(/\s+/g, ' ').trim(), values })
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [], rowCount: 0 }
    if (text.includes("set_config('app.tenant_id'")) return { rows: [], rowCount: 1 }
    const scripted = this.responses.shift()
    const response = typeof scripted === 'function' ? await scripted() : scripted
    if (response === undefined) throw new Error(`Unexpected query: ${text}`)
    return response as PostgresQueryResult<Row>
  }

  release(): void {
    this.released = true
  }
}

function fixture(responses: ScriptedResponse[]) {
  const clients: ScriptedClient[] = []
  const pool: PostgresPool = {
    connect: async () => {
      const response = responses.shift()
      if (response === undefined) throw new Error('Unexpected connection')
      const client = new ScriptedClient([response])
      clients.push(client)
      return client
    },
    end: async () => undefined,
  }
  return { clients, query: new StaffBootstrapQuery(new ScopedPostgresTransactionRunner(pool)) }
}

function responses(): Array<PostgresQueryResult> {
  return [
    {
      rows: [{
        id: storeId,
        code: 'lujiazui',
        name: 'M-BOX',
        timezone: 'Asia/Shanghai',
        business_day_cutoff: '06:00:00',
        currency: 'CNY',
        business_day_status: 'open',
        business_day_opened_at: '2026-08-11T04:00:00.000Z',
        business_day_rollover_at: null,
        business_day_closed_at: null,
        employee_id: employeeId,
        employee_code: 'LIYAN',
        display_name: '李艳',
        role_codes: ['MANAGER'],
        role_names: ['店长'],
        permissions: ['dashboard.view', 'inventory.view', 'reservation.view', 'service.execute'],
        denied_permissions: [],
        data_scopes: [{ key: 'area', effect: 'include', value: ['indoor'] }],
        approval_limits: [{ code: 'order.gift', amountMinor: 8800, currency: 'CNY', rules: {} }],
        navigation: [
          { code: 'live', label: '现场', route: '/live', icon: 'layout', sortOrder: 1, displayConfig: { highFrequency: true } },
          { code: 'tasks', label: '任务', route: '/tasks', icon: 'list', sortOrder: 2, displayConfig: {} },
          { code: 'reservations', label: '预约', route: '/reservations', icon: null, sortOrder: 3, displayConfig: {} },
        ],
        resolved_at: '2026-08-11T12:00:00.000Z',
        identity_watermark: 'identity-watermark-9',
      }],
      rowCount: 1,
    },
    {
      rows: [{
        active_tables: '6',
        open_service_tasks: '4',
        urgent_service_tasks: '1',
        active_kds_tasks: '3',
        ready_kds_tasks: '2',
        overdue_kds_tasks: '1',
        carryover_kds_tasks: '2',
        carryover_ready_kds_tasks: '1',
        active_reservations: '8',
        reservation_attention: '2',
        pending_payments: '1',
        failed_payments: '0',
        refund_approvals: '0',
        current_refund_approval_tasks: '0',
        current_refund_execution_tasks: '0',
        carryover_refund_approval_tasks: '0',
        carryover_refund_execution_tasks: '0',
        low_inventory_items: '5',
        active_print_jobs: '0',
        failed_print_jobs: '0',
        watermark_seed: 'normalized-watermark-17',
      }],
      rowCount: 1,
    },
  ]
}

describe('StaffBootstrapQuery', () => {
  it('returns a compact permission-scoped first screen and stable cache identity', async () => {
    const value = fixture([...responses(), ...responses()])
    const first = await value.query.get({ tenantId, storeId }, employeeId, '2026-08-11')
    const second = await value.query.get({ tenantId, storeId }, employeeId, '2026-08-11')

    expect(first.etag).toMatch(/^"staff-bootstrap-[a-f0-9]{32}"$/)
    expect(second.etag).toBe(first.etag)
    expect(first.view).toMatchObject({
      schemaVersion: 1,
      store: { id: storeId, name: 'M-BOX', timezone: 'Asia/Shanghai' },
      businessDay: { date: '2026-08-11', status: 'open' },
      staff: { id: employeeId, displayName: '李艳', roleCodes: ['MANAGER'] },
      highFrequencyEntries: [{ code: 'live', route: '/live' }],
    })
    expect(first.view.domainSummaries).toEqual([
      expect.objectContaining({ key: 'live', activeCount: 6 }),
      expect.objectContaining({ key: 'service', activeCount: 4, attentionCount: 1 }),
      expect.objectContaining({ key: 'reservations', activeCount: 8, attentionCount: 0 }),
      expect.objectContaining({ key: 'inventory', attentionCount: 5 }),
    ])
    expect(first.view.domainSummaries.find((summary) => summary.key === 'fulfillment')).toBeUndefined()
    expect(first.view.endpointRefs.fulfillment).toBe('/api/commerce/fulfillment')
    const calls = value.clients.flatMap((client) => client.calls)
    const businessQueries = calls.filter((call) => (
      call.sql.includes('WITH active_roles') || call.sql.includes('WITH business_window')
    ))
    expect(businessQueries).toHaveLength(4)
    expect(calls.filter((call) => call.sql.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')))
      .toHaveLength(4)
    expect(calls.some((call) => /\bUPDATE\b/.test(call.sql))).toBe(false)
    expect(value.clients).toHaveLength(4)
    expect(value.clients.every((client) => client.released)).toBe(true)
  })

  it('runs the two startup aggregates concurrently', async () => {
    let activeReads = 0
    let peakReads = 0
    const wrap = (response: PostgresQueryResult): ScriptedResponse => async () => {
      activeReads += 1
      peakReads = Math.max(peakReads, activeReads)
      await Promise.resolve()
      activeReads -= 1
      return response
    }
    const scripted = responses()
    const value = fixture([wrap(scripted[0]!), wrap(scripted[1]!)])

    await value.query.get({ tenantId, storeId }, employeeId, '2026-08-11')

    expect(peakReads).toBe(2)
    expect(value.clients.every((client) => client.released)).toBe(true)
  })

  it('does not present store-wide fulfillment or refund queues as a manager task without action permission', async () => {
    const scripted = responses()
    const identity = structuredClone(scripted[0]!.rows[0]!) as Record<string, unknown>
    identity.permissions = [
      'dashboard.view', 'fulfillment.view_all', 'kds.exception.manage',
      'reservation.view', 'reservation.manage', 'refund.request',
    ]
    identity.navigation = [
      { code: 'commerce', label: '出品', route: '/staff/fulfillment', icon: null, sortOrder: 1, displayConfig: {} },
      { code: 'reservations', label: '预约', route: '/staff/reservations', icon: null, sortOrder: 2, displayConfig: {} },
      { code: 'payments', label: '退款发起', route: '/staff/payments', icon: null, sortOrder: 3, displayConfig: {} },
    ]
    const summary = structuredClone(scripted[1]!.rows[0]!) as Record<string, unknown>
    summary.current_refund_approval_tasks = '3'
    summary.current_refund_execution_tasks = '2'
    summary.carryover_refund_approval_tasks = '4'
    summary.carryover_refund_execution_tasks = '1'
    const value = fixture([{ rows: [identity], rowCount: 1 }, { rows: [summary], rowCount: 1 }])

    const result = await value.query.get({ tenantId, storeId }, employeeId, '2026-08-11')

    expect(result.view.domainSummaries.find((item) => item.key === 'fulfillment')).toMatchObject({
      activeCount: 0, attentionCount: 0, readyCount: 0, carryoverCount: 0,
    })
    expect(result.view.domainSummaries.find((item) => item.key === 'reservations')).toMatchObject({
      activeCount: 8, attentionCount: 2,
    })
    expect(result.view.domainSummaries.find((item) => item.key === 'payments')).toMatchObject({
      activeCount: 0, attentionCount: 0, carryoverCount: 0,
    })
  })

  it('fails closed when the active store cannot be resolved', async () => {
    const value = fixture([{ rows: [], rowCount: 0 }, responses()[1]!])
    await expect(value.query.get({ tenantId, storeId }, employeeId, '2026-08-11'))
      .rejects.toBeInstanceOf(StaffBootstrapStoreNotFoundError)
    expect(value.clients).toHaveLength(2)
    expect(value.clients.every((client) => client.released)).toBe(true)
  })

  it('rejects malformed business dates before acquiring a connection', async () => {
    const value = fixture([])
    await expect(value.query.get({ tenantId, storeId }, employeeId, '11/08/2026'))
      .rejects.toThrow('businessDate must use YYYY-MM-DD')
    expect(value.clients).toHaveLength(0)
  })
})

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip

postgresIt('executes the compact bootstrap query against normalized PostgreSQL tables', async () => {
  await runNormalizedMigrations(databaseUrl!)
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const roleId = '94444444-4444-4444-8444-444444444444'
  try {
    await pool.query(`
      INSERT INTO mbox.tenants(id, code, name)
      VALUES ($1::uuid, 'staff-bootstrap-tenant', 'Staff Bootstrap Tenant')
      ON CONFLICT (id) DO NOTHING
    `, [tenantId])
    await pool.query(`
      INSERT INTO mbox.stores(id, tenant_id, code, name, timezone, business_day_cutoff)
      VALUES ($1::uuid, $2::uuid, 'staff-bootstrap-store', 'M-BOX', 'Asia/Shanghai', TIME '06:00')
      ON CONFLICT (id) DO NOTHING
    `, [storeId, tenantId])
    await pool.query(`
      INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'LIYAN', '李艳')
      ON CONFLICT (id) DO NOTHING
    `, [employeeId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.roles(id, tenant_id, store_id, code, name)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'MANAGER', '店长')
      ON CONFLICT (id) DO NOTHING
    `, [roleId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.employee_roles(tenant_id, store_id, employee_id, role_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
      ON CONFLICT DO NOTHING
    `, [tenantId, storeId, employeeId, roleId])
    await pool.query(`
      WITH permission AS (
        INSERT INTO mbox.staff_permission_definitions(tenant_id, store_id, code, name)
        VALUES ($1::uuid, $2::uuid, 'dashboard.view', '查看现场')
        ON CONFLICT (tenant_id, store_id, code) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      )
      INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
      SELECT $1::uuid, $2::uuid, $3::uuid, permission.id FROM permission
      ON CONFLICT DO NOTHING
    `, [tenantId, storeId, roleId])
    await pool.query(`
      INSERT INTO mbox.role_navigation_items(
        tenant_id, store_id, role_id, navigation_code, label, route, sort_order, display_config
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'live', '现场', '/live', 1, '{"highFrequency":true}')
      ON CONFLICT (tenant_id, store_id, role_id, navigation_code) DO NOTHING
    `, [tenantId, storeId, roleId])
    await pool.query(`
      INSERT INTO mbox.business_days(tenant_id, store_id, business_date, status)
      VALUES ($1::uuid, $2::uuid, DATE '2026-08-11', 'open')
      ON CONFLICT (tenant_id, store_id, business_date) DO NOTHING
    `, [tenantId, storeId])

    const query = new StaffBootstrapQuery(new ScopedPostgresTransactionRunner({
      connect: async () => pool.connect(),
      end: async () => pool.end(),
    }))
    const result = await query.get({ tenantId, storeId }, employeeId, '2026-08-11')

    expect(result.etag).toMatch(/^"staff-bootstrap-[a-f0-9]{32}"$/)
    expect(result.view).toMatchObject({
      store: { id: storeId, timezone: 'Asia/Shanghai' },
      staff: { id: employeeId, roleCodes: ['MANAGER'] },
      access: { permissions: [
        'checkout.upgrade.rule.draft',
        'checkout.upgrade.rule.view',
        'community.activity.contact.reveal',
        'customer.membership.merge.approve',
        'customer.membership.recovery.verify',
        'dashboard.view',
        'fulfillment.capacity.draft',
        'fulfillment.capacity.view',
        'loyalty.configuration.edit',
        'loyalty.configuration.preview',
        'loyalty.configuration.view',
        'loyalty.promotion.manage',
        'loyalty.promotion.view',
        'membership.terms.manage',
        'membership.terms.view',
        'performance.phase.manage',
        'performance.schedule.revise',
        'privacy.contact.retention.draft',
        'privacy.contact.retention.view',
        'recommendation.phase.configure',
        'recommendation.rule.draft',
        'recommendation.rule.view',
        'recommendation.staff.modify',
        'recommendation.staff.modify.all',
        'table.participation.manage',
      ] },
      navigation: [{ code: 'live', route: '/live' }],
      highFrequencyEntries: [{ code: 'live', route: '/live' }],
    })
  } finally {
    await pool.end()
  }
}, 120_000)
