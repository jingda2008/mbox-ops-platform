import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  FULFILLMENT_VIEW_ALL_PERMISSION,
  FulfillmentQueryService,
  KDS_DELIVER_PERMISSION,
  KDS_PREPARE_PERMISSION,
  KDS_STATION_SCOPE,
} from './fulfillment-query-service.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type PostgresPoolClient,
  type PostgresQueryResult,
} from './transaction-runner.js'

const tenantId = '71000000-0000-4000-8000-000000000001'
const storeId = '71000000-0000-4000-8000-000000000002'
const actorId = '71000000-0000-4000-8000-000000000003'

describe('FulfillmentQueryService', () => {
  it('uses live staff access and station scopes without accepting a client all-store switch', async () => {
    const fixture = scriptedService([
      employeeRow(actorId, 'BAR01', '调酒师'),
      rows([{ code: 'BARTENDER', name: '调酒师' }]),
      permissionRows(KDS_PREPARE_PERMISSION),
      rows([
        { scope_key: KDS_STATION_SCOPE, effect: 'include', value_kind: 'text_set', boolean_value: null, text_value: null, text_values: ['bar', 'kitchen'] },
        { scope_key: KDS_STATION_SCOPE, effect: 'exclude', value_kind: 'text_set', boolean_value: null, text_value: null, text_values: ['kitchen'] },
      ]),
      rows([]),
      rows([]),
      rows([fulfillmentRow({ station_code: 'bar', can_prepare: true })]),
    ])

    const result = await fixture.service.getStaffWorkQueue({ tenantId, storeId }, actorId)

    expect(result.actor).toMatchObject({
      employeeId: actorId,
      permissions: [KDS_PREPARE_PERMISSION],
      allowedStations: ['bar'],
      canViewAll: false,
    })
    expect(result.workItems[0]).toMatchObject({
      stationCode: 'bar',
      canPrepare: true,
      canDeliver: false,
      table: { code: 'VIP1' },
      attentionMessages: ['整单一起上', '少冰，柠檬另放'],
    })

    const query = fulfillmentCall(fixture.client)
    expect(query.values.slice(3)).toEqual([false, ['bar'], true, false])
    expect(query.sql).toContain("(assignment.assignment_type IN ('primary', 'backup')) DESC")
    expect(query.sql).toContain("task.status = 'ready'")
    expect(query.sql).toContain('task.priority DESC')
    expect(query.sql).not.toMatch(/cost_snapshot|payment_status|payments|refunds/i)
    expect(fixture.client.calls[0]?.sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(fixture.client.released).toBe(true)
  })

  it('lets delivery staff support any ready item while preserving assignment context', async () => {
    const fixture = scriptedService([
      employeeRow(actorId, 'SERVER01', '服务员'),
      rows([{ code: 'SERVER', name: '服务员' }]),
      permissionRows(KDS_DELIVER_PERMISSION),
      rows([]),
      rows([]),
      rows([]),
      rows([fulfillmentRow({
        kds_status: 'ready',
        ready_for_delivery: true,
        can_deliver: true,
        assignment_type: 'backup',
      })]),
    ])

    const result = await fixture.service.getStaffWorkQueue({ tenantId, storeId }, actorId)

    expect(result.actor.allowedStations).toEqual([])
    expect(result.workItems).toHaveLength(1)
    expect(result.workItems[0]).toMatchObject({
      kdsStatus: 'ready',
      readyForDelivery: true,
      canPrepare: false,
      canDeliver: true,
      table: { assignmentType: 'backup' },
    })
    expect(fulfillmentCall(fixture.client).values.slice(3)).toEqual([false, [], false, true])
  })

  it('lets an unassigned delivery-capable employee take a ready item without exposing production work', async () => {
    const fixture = scriptedService([
      employeeRow(actorId, 'SERVER02', '候补服务员'),
      rows([{ code: 'SERVER', name: '服务员' }]),
      permissionRows(KDS_DELIVER_PERMISSION),
      rows([]),
      rows([]),
      rows([]),
      rows([fulfillmentRow({
        kds_status: 'ready',
        ready_for_delivery: true,
        can_deliver: true,
        assignment_type: null,
      })]),
    ])

    const result = await fixture.service.getStaffWorkQueue({ tenantId, storeId }, actorId)

    expect(result.workItems).toHaveLength(1)
    expect(result.workItems[0]).toMatchObject({
      kdsStatus: 'ready',
      canPrepare: false,
      canDeliver: true,
      table: { assignmentType: null },
    })
    const query = fulfillmentCall(fixture.client)
    expect(query.sql).toContain("$7::boolean AND task.status = 'ready'")
    expect(query.sql).not.toContain("task.status = 'ready' AND assignment.assignment_type")
  })

  it('shows the whole store only with the explicit fulfillment view-all permission', async () => {
    const fixture = scriptedService([
      employeeRow(actorId, 'MANAGER01', '店长'),
      rows([{ code: 'MANAGER', name: '店长' }]),
      permissionRows(FULFILLMENT_VIEW_ALL_PERMISSION),
      rows([]),
      rows([]),
      rows([]),
      rows([fulfillmentRow({ station_code: 'kitchen' })]),
    ])

    const result = await fixture.service.getStaffWorkQueue({ tenantId, storeId }, actorId)

    expect(result.actor.canViewAll).toBe(true)
    expect(result.workItems[0]).toMatchObject({
      stationCode: 'kitchen',
      canPrepare: false,
      canDeliver: false,
    })
    expect(fulfillmentCall(fixture.client).values.slice(3)).toEqual([true, [], false, false])
  })
})

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('FulfillmentQueryService PostgreSQL authorization and ordering', () => {
  let pool: Pool
  let service: FulfillmentQueryService

  const areaId = '71000000-0000-4000-8000-000000000004'
  const tableOneId = '71000000-0000-4000-8000-000000000005'
  const tableTwoId = '71000000-0000-4000-8000-000000000006'
  const sessionOneId = '71000000-0000-4000-8000-000000000007'
  const sessionTwoId = '71000000-0000-4000-8000-000000000008'
  const bartenderId = '71000000-0000-4000-8000-000000000009'
  const serverId = '71000000-0000-4000-8000-000000000010'
  const managerId = '71000000-0000-4000-8000-000000000011'
  const barRoleId = '71000000-0000-4000-8000-000000000012'
  const serverRoleId = '71000000-0000-4000-8000-000000000013'
  const managerRoleId = '71000000-0000-4000-8000-000000000014'
  const barProductId = '71000000-0000-4000-8000-000000000015'
  const kitchenProductId = '71000000-0000-4000-8000-000000000016'
  const barOrderId = '71000000-0000-4000-8000-000000000017'
  const readyOrderId = '71000000-0000-4000-8000-000000000018'
  const kitchenOrderId = '71000000-0000-4000-8000-000000000019'
  const barItemId = '71000000-0000-4000-8000-000000000020'
  const readyItemId = '71000000-0000-4000-8000-000000000021'
  const kitchenItemId = '71000000-0000-4000-8000-000000000022'

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 3 })
    service = new FulfillmentQueryService(new ScopedPostgresTransactionRunner(asPool(pool)))
    await seedIntegrationData(pool, {
      areaId,
      tableOneId,
      tableTwoId,
      sessionOneId,
      sessionTwoId,
      bartenderId,
      serverId,
      managerId,
      barRoleId,
      serverRoleId,
      managerRoleId,
      barProductId,
      kitchenProductId,
      barOrderId,
      readyOrderId,
      kitchenOrderId,
      barItemId,
      readyItemId,
      kitchenItemId,
    })
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('enforces station, delivery-table and explicit all-store visibility with deterministic priority', async () => {
    const scope = { tenantId, storeId }
    const bartender = await service.getStaffWorkQueue(scope, bartenderId)
    const server = await service.getStaffWorkQueue(scope, serverId)
    const manager = await service.getStaffWorkQueue(scope, managerId)

    expect(bartender.workItems.map((item) => item.taskId)).toEqual([
      '71000000-0000-4000-8000-000000000023',
      '71000000-0000-4000-8000-000000000024',
    ])
    expect(bartender.workItems.every((item) => item.stationCode === 'bar')).toBe(true)
    expect(bartender.workItems[0]).toMatchObject({ overdue: true, canPrepare: true })
    expect(bartender.workItems[1]).toMatchObject({ readyForDelivery: true, canPrepare: false })

    expect(server.workItems.map((item) => item.taskId)).toEqual([
      '71000000-0000-4000-8000-000000000024',
    ])
    expect(server.workItems[0]).toMatchObject({
      canDeliver: true,
      table: { code: 'VIP1', assignmentType: 'backup' },
    })

    expect(manager.workItems.map((item) => item.taskId)).toEqual([
      '71000000-0000-4000-8000-000000000023',
      '71000000-0000-4000-8000-000000000024',
      '71000000-0000-4000-8000-000000000025',
    ])
    expect(manager.actor).toMatchObject({ canViewAll: true, allowedStations: [] })
    expect(manager.workItems.every((item) => !item.canPrepare && !item.canDeliver)).toBe(true)
    expect(JSON.stringify(manager)).not.toMatch(/costSnapshot|paymentStatus|amountMinor|provider|refund/i)
  })
})

class ScriptedClient implements PostgresPoolClient {
  calls: Array<{ sql: string; values: unknown[] }> = []
  released = false

  constructor(private readonly responses: PostgresQueryResult[]) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    const sql = text.replace(/\s+/g, ' ').trim()
    this.calls.push({ sql, values })
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 }
    if (sql.includes("set_config('app.tenant_id'")) return { rows: [], rowCount: 1 }
    const response = this.responses.shift()
    if (response === undefined) throw new Error(`Unexpected query: ${sql}`)
    return response as PostgresQueryResult<Row>
  }

  release(): void {
    this.released = true
  }
}

function scriptedService(responses: PostgresQueryResult[]) {
  const client = new ScriptedClient(responses)
  const pool: PostgresPool = { connect: async () => client, end: async () => undefined }
  return {
    client,
    service: new FulfillmentQueryService(new ScopedPostgresTransactionRunner(pool)),
  }
}

function fulfillmentCall(client: ScriptedClient) {
  const call = client.calls.find((candidate) => candidate.sql.includes('FROM mbox.kds_tasks AS task'))
  if (call === undefined) throw new Error('Fulfillment query was not executed')
  return call
}

function employeeRow(id: string, employeeCode: string, displayName: string) {
  return rows([{ id, employee_code: employeeCode, display_name: displayName, status: 'active' }])
}

function permissionRows(...codes: string[]) {
  return rows(codes.map((code) => ({
    code,
    role_granted: true,
    override_granted: false,
    override_denied: false,
  })))
}

function rows(values: Record<string, unknown>[]): PostgresQueryResult {
  return { rows: values, rowCount: values.length }
}

function fulfillmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: '71000000-0000-4000-8000-000000000100',
    station_code: 'bar',
    kds_status: 'preparing',
    priority: 300,
    overdue: true,
    ready_for_delivery: false,
    can_prepare: false,
    can_deliver: false,
    due_at: '2026-08-11T12:00:00.000Z',
    next_action_at: '2026-08-11T11:59:00.000Z',
    task_created_at: '2026-08-11T11:58:00.000Z',
    order_id: '71000000-0000-4000-8000-000000000101',
    order_public_id: 'ORDER-VIP1-001',
    order_channel: 'guest_qr',
    order_status: 'fulfilling',
    order_note: '整单一起上',
    order_item_id: '71000000-0000-4000-8000-000000000102',
    product_id: '71000000-0000-4000-8000-000000000103',
    product_name: '招牌鸡尾酒',
    quantity: 2,
    item_status: 'preparing',
    item_note: '少冰，柠檬另放',
    table_id: '71000000-0000-4000-8000-000000000104',
    table_code: 'VIP1',
    assignment_type: null,
    generated_at: '2026-08-11T12:01:00.000Z',
    ...overrides,
  }
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}

interface IntegrationIds {
  areaId: string
  tableOneId: string
  tableTwoId: string
  sessionOneId: string
  sessionTwoId: string
  bartenderId: string
  serverId: string
  managerId: string
  barRoleId: string
  serverRoleId: string
  managerRoleId: string
  barProductId: string
  kitchenProductId: string
  barOrderId: string
  readyOrderId: string
  kitchenOrderId: string
  barItemId: string
  readyItemId: string
  kitchenItemId: string
}

async function seedIntegrationData(pool: Pool, id: IntegrationIds): Promise<void> {
  await pool.query(`INSERT INTO mbox.tenants(id, code, name) VALUES ($1, 'fulfillment-query', 'Fulfillment Query')`, [tenantId])
  await pool.query(`INSERT INTO mbox.stores(id, tenant_id, code, name) VALUES ($1, $2, 'fulfillment-store', 'Fulfillment Store')`, [storeId, tenantId])
  await pool.query(`INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type) VALUES ($1, $2, $3, 'FQ', 'Fulfillment', 'indoor')`, [id.areaId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity) VALUES
      ($1, $3, $4, $5, 'VIP1', 'VIP1', 8),
      ($2, $3, $4, $5, 'L01', 'L01', 4)
  `, [id.tableOneId, id.tableTwoId, tenantId, storeId, id.areaId])
  await pool.query(`
    INSERT INTO mbox.table_sessions(id, tenant_id, store_id, table_id, public_id, business_date, guest_count) VALUES
      ($1, $3, $4, $5, 'fulfillment-session-vip1', CURRENT_DATE, 4),
      ($2, $3, $4, $6, 'fulfillment-session-l01', CURRENT_DATE, 2)
  `, [id.sessionOneId, id.sessionTwoId, tenantId, storeId, id.tableOneId, id.tableTwoId])
  await pool.query(`
    INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name) VALUES
      ($1, $4, $5, 'BAR01', '调酒师'),
      ($2, $4, $5, 'SERVER01', '服务员'),
      ($3, $4, $5, 'MANAGER01', '店长')
  `, [id.bartenderId, id.serverId, id.managerId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.roles(id, tenant_id, store_id, code, name) VALUES
      ($1, $4, $5, 'BARTENDER', '调酒师'),
      ($2, $4, $5, 'SERVER', '服务员'),
      ($3, $4, $5, 'MANAGER', '店长')
  `, [id.barRoleId, id.serverRoleId, id.managerRoleId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.employee_roles(tenant_id, store_id, employee_id, role_id) VALUES
      ($1, $2, $3, $6), ($1, $2, $4, $7), ($1, $2, $5, $8)
  `, [tenantId, storeId, id.bartenderId, id.serverId, id.managerId, id.barRoleId, id.serverRoleId, id.managerRoleId])
  await pool.query(`
    WITH definitions AS (
      INSERT INTO mbox.staff_permission_definitions(tenant_id, store_id, code, name) VALUES
        ($1, $2, $3, 'KDS production'),
        ($1, $2, $4, 'KDS delivery'),
        ($1, $2, $5, 'Fulfillment all-store view')
      ON CONFLICT (tenant_id, store_id, code) DO UPDATE
      SET name = EXCLUDED.name
      RETURNING id, code
    )
    INSERT INTO mbox.role_permission_assignments(tenant_id, store_id, role_id, permission_id)
    SELECT $1, $2,
      CASE definitions.code WHEN $3 THEN $6::uuid WHEN $4 THEN $7::uuid ELSE $8::uuid END,
      definitions.id
    FROM definitions
    ON CONFLICT (tenant_id, store_id, role_id, permission_id) DO NOTHING
  `, [tenantId, storeId, KDS_PREPARE_PERMISSION, KDS_DELIVER_PERMISSION, FULFILLMENT_VIEW_ALL_PERMISSION, id.barRoleId, id.serverRoleId, id.managerRoleId])
  await pool.query(`
    INSERT INTO mbox.role_data_scopes(
      tenant_id, store_id, role_id, scope_key, effect, scope_value,
      value_kind, text_values
    ) VALUES ($1, $2, $3, $4, 'include', '["bar"]'::jsonb, 'text_set', ARRAY['bar']::text[])
  `, [tenantId, storeId, id.barRoleId, KDS_STATION_SCOPE])
  await pool.query(`
    INSERT INTO mbox.table_assignments(
      tenant_id, store_id, table_id, employee_id, role_id, assignment_type, reason
    ) VALUES ($1, $2, $3, $4, $5, 'backup', '履约查询测试候补责任桌')
  `, [tenantId, storeId, id.tableOneId, id.serverId, id.serverRoleId])
  await pool.query(`
    INSERT INTO mbox.products(id, tenant_id, store_id, code, name, category_code, fulfillment_station) VALUES
      ($1, $3, $4, 'FQ-BAR', '招牌鸡尾酒', 'drink', 'bar'),
      ($2, $3, $4, 'FQ-KITCHEN', '时令果盘', 'food', 'kitchen')
  `, [id.barProductId, id.kitchenProductId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.orders(
      id, tenant_id, store_id, table_session_id, public_id, channel, status, note
    ) VALUES
      ($1, $4, $5, $6, 'FQ-ORDER-BAR-01', 'guest_qr', 'fulfilling', '整单一起上'),
      ($2, $4, $5, $6, 'FQ-ORDER-READY-01', 'staff_assisted', 'fulfilling', NULL),
      ($3, $4, $5, $7, 'FQ-ORDER-KITCHEN-01', 'guest_qr', 'fulfilling', NULL)
  `, [id.barOrderId, id.readyOrderId, id.kitchenOrderId, tenantId, storeId, id.sessionOneId, id.sessionTwoId])
  await pool.query(`
    INSERT INTO mbox.order_items(
      id, tenant_id, store_id, order_id, product_id, quantity, unit_price_minor,
      total_amount_minor, fulfillment_station, product_snapshot, status, note
    ) VALUES
      ($1, $7, $8, $4, $9, 2, 8800, 17600, 'bar', '{}', 'preparing', '少冰'),
      ($2, $7, $8, $5, $9, 1, 8800, 8800, 'bar', '{}', 'ready', '柠檬另放'),
      ($3, $7, $8, $6, $10, 1, 12800, 12800, 'kitchen', '{}', 'submitted', NULL)
  `, [id.barItemId, id.readyItemId, id.kitchenItemId, id.barOrderId, id.readyOrderId, id.kitchenOrderId, tenantId, storeId, id.barProductId, id.kitchenProductId])
  await pool.query(`
    INSERT INTO mbox.kds_tasks(
      id, tenant_id, store_id, order_item_id, station_code, status,
      priority, quantity, due_at, next_action_at, ready_at, created_at
    ) VALUES
      ('71000000-0000-4000-8000-000000000023', $1, $2, $3, 'bar', 'preparing', 300, 2,
        clock_timestamp() - interval '5 minutes', clock_timestamp() - interval '6 minutes', NULL,
        clock_timestamp() - interval '10 minutes'),
      ('71000000-0000-4000-8000-000000000024', $1, $2, $4, 'bar', 'ready', 100, 1,
        clock_timestamp() + interval '5 minutes', clock_timestamp() - interval '2 minutes', clock_timestamp(),
        clock_timestamp() - interval '4 minutes'),
      ('71000000-0000-4000-8000-000000000025', $1, $2, $5, 'kitchen', 'pending', 900, 1,
        clock_timestamp() + interval '10 minutes', clock_timestamp(), NULL, clock_timestamp())
  `, [tenantId, storeId, id.barItemId, id.readyItemId, id.kitchenItemId])
}
