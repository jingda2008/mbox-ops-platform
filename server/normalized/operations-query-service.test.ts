import { describe, expect, it } from 'vitest'
import type { PostgresPool, PostgresPoolClient, PostgresQueryResult } from './transaction-runner.js'
import { OperationsQueryService, StaffNotFoundError } from './operations-query-service.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'

class ScriptedClient implements PostgresPoolClient {
  calls: Array<{ sql: string; values: unknown[] }> = []
  released = false

  constructor(private readonly responses: Array<PostgresQueryResult>) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql: text.replace(/\s+/g, ' ').trim(), values })
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [], rowCount: 0 }
    if (text.includes("set_config('app.tenant_id'")) return { rows: [], rowCount: 1 }
    const response = this.responses.shift()
    if (!response) throw new Error(`Unexpected query: ${text}`)
    return response as PostgresQueryResult<Row>
  }

  release(): void {
    this.released = true
  }
}

function service(responses: Array<PostgresQueryResult>) {
  const client = new ScriptedClient(responses)
  const pool: PostgresPool = { connect: async () => client, end: async () => undefined }
  return { client, value: new OperationsQueryService(new ScopedPostgresTransactionRunner(pool)) }
}

describe('OperationsQueryService', () => {
  it('builds a repeatable normalized staff view without a RuntimeState aggregate', async () => {
    const fixture = service([
      { rows: [{ id: storeId, code: 'lujiazui', name: 'M-BOX', timezone: 'Asia/Shanghai', business_day_cutoff: '06:00:00' }], rowCount: 1 },
      { rows: [{ id: employeeId, employee_code: 'LIYAN', display_name: '李艳', status: 'active' }], rowCount: 1 },
      { rows: [{ code: 'MANAGER', name: '店长' }], rowCount: 1 },
      { rows: [{ code: 'table.view_all', role_granted: true, override_granted: false, override_denied: false }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [{
        id: '44444444-4444-4444-8444-444444444444', code: 'VIP1', display_name: 'VIP1',
        area_id: '55555555-5555-4555-8555-555555555555', area_name: '室内', capacity: 8,
        status: 'available', assigned_to_actor: false,
        session_id: '66666666-6666-4666-8666-666666666666', session_public_id: 'session-vip1-20260811',
        business_date: '2026-08-11', guest_count: 10, guest_profile_snapshot: { extraSeatCount: 2 },
        session_status: 'open', opened_at: '2026-08-11T12:00:00.000Z',
      }], rowCount: 1 },
      { rows: [{
        id: '77777777-7777-4777-8777-777777777777', public_id: 'task-water-vip1',
        table_id: '44444444-4444-4444-8444-444444444444', table_code: 'VIP1',
        table_session_id: '66666666-6666-4666-8666-666666666666', task_type: 'water',
        title: '加水', detail: null, priority: 'high', status: 'pending', source: 'guest',
        requested_role_code: 'SERVER', assigned_employee_id: null, backup_employee_id: null,
        due_at: null, escalate_at: null, created_at: '2026-08-11T12:01:00.000Z',
      }], rowCount: 1 },
    ])

    const view = await fixture.value.getStaffView(
      { tenantId, storeId }, employeeId,
    )

    expect(view.actor).toMatchObject({ displayName: '李艳', roleCodes: ['MANAGER'] })
    expect(view.tables[0]?.activeSession).toMatchObject({ guestCount: 10, guestProfileSnapshot: { extraSeatCount: 2 } })
    expect(view.tasks[0]).toMatchObject({ tableCode: 'VIP1', title: '加水' })
    expect(fixture.client.calls[0]?.sql).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(fixture.client.calls.some((call) => call.sql.includes('runtime_states'))).toBe(false)
    expect(fixture.client.calls[9]?.values[3]).toBe(true)
    expect(fixture.client.released).toBe(true)
  })

  it('fails closed when the employee is absent or inactive', async () => {
    const fixture = service([
      { rows: [{ id: storeId, code: 'lujiazui', name: 'M-BOX', timezone: 'Asia/Shanghai', business_day_cutoff: '06:00:00' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ])
    await expect(fixture.value.getStaffView(
      { tenantId, storeId }, employeeId,
    )).rejects.toBeInstanceOf(StaffNotFoundError)
    expect(fixture.client.released).toBe(true)
  })
})
