import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapacityOverrideReasonRequiredError } from './table-management-repository.js'
import { tableManagementApiPlugin } from './table-management-api.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const tableId = '44444444-4444-4444-8444-444444444444'

const apps: ReturnType<typeof Fastify>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('table management API', () => {
  it('opens any table using table.open without requiring a responsibility assignment', async () => {
    const commands = commandPort()
    commands.open.mockResolvedValue({
      replayed: false,
      value: { id: 'session-id', tableId, tableCode: 'W01', guestCount: 2 },
    })
    const app = await build(commands)
    const response = await app.inject({
      method: 'POST',
      url: '/table-management/sessions/open',
      headers: { 'x-idempotency-key': 'open-w01-request-001' },
      payload: { tableId, guestCount: 2 },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      data: { id: 'session-id', tableId, tableCode: 'W01', guestCount: 2 },
      meta: { replayed: false },
    })
    expect(commands.open).toHaveBeenCalledWith(expect.objectContaining({
      tableId,
      guestCount: 2,
      reason: '现场开台',
      actor: { type: 'employee', employeeId },
    }))
  })

  it('returns a specific capacity override instruction instead of a generic failure', async () => {
    const commands = commandPort()
    commands.open.mockRejectedValue(new CapacityOverrideReasonRequiredError(4, 6))
    const app = await build(commands)
    const response = await app.inject({
      method: 'POST',
      url: '/table-management/sessions/open',
      headers: { 'x-idempotency-key': 'open-capacity-request-001' },
      payload: { tableId, guestCount: 6 },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({
      error: {
        code: 'CAPACITY_OVERRIDE_REASON_REQUIRED',
        message: '人数6超过桌台容量4，必须填写加座原因',
      },
    })
  })

  it('requires an idempotency key for every write route', async () => {
    const commands = commandPort()
    const app = await build(commands)
    const response = await app.inject({
      method: 'POST',
      url: '/table-management/sessions/open',
      payload: { tableId, guestCount: 2 },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('TABLE_REQUEST_INVALID')
    expect(commands.open).not.toHaveBeenCalled()
  })

  it('returns a scoped table list and marks responsibility separately from action permission', async () => {
    const commands = commandPort()
    const app = await build(commands, scriptedTransaction())
    const response = await app.inject({ method: 'GET', url: '/table-management/tables' })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual([expect.objectContaining({
      id: tableId,
      code: 'W01',
      assignedToActor: false,
      status: 'available',
    })])
  })
})

async function build(commands = commandPort(), transaction = scriptedTransaction()) {
  const app = Fastify()
  apps.push(app)
  await app.register(tableManagementApiPlugin, {
    transactions: {
      run: async (_scope, operation) => operation(transaction),
    },
    commands,
    resolveContext: () => ({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-11',
      capabilities: ['table.open'],
    }),
  })
  return app
}

function commandPort() {
  return {
    createArea: vi.fn(), updateArea: vi.fn(), createTable: vi.fn(), updateTable: vi.fn(),
    assign: vi.fn(), endAssignment: vi.fn(), open: vi.fn(), transfer: vi.fn(),
  }
}

function scriptedTransaction(): ScopedTransaction {
  return {
    scope: { tenantId, storeId },
    query: async <Row extends Record<string, unknown>>(sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ')
      let rows: Record<string, unknown>[]
      if (normalized.includes('FROM mbox.employees')) {
        rows = [{ id: employeeId, employee_code: 'liyan', display_name: '李艳', status: 'active' }]
      } else if (normalized.includes('FROM mbox.employee_roles')) {
        rows = [{ code: 'STORE_MANAGER', name: '店长' }]
      } else if (normalized.includes('permission_facts')) {
        rows = [{ code: 'table.open', role_granted: true, override_granted: false, override_denied: false }]
      } else if (normalized.includes('FROM mbox.role_data_scopes')) {
        rows = []
      } else if (normalized.includes('FROM mbox.role_approval_limits')) {
        rows = []
      } else if (normalized.includes('FROM mbox.role_navigation_items')) {
        rows = []
      } else if (normalized.includes('FROM mbox.tables AS venue_table')) {
        rows = [{
          id: tableId, area_id: '55555555-5555-4555-8555-555555555555',
          area_code: 'OUTSIDE', area_name: '室外区域', code: 'W01', display_name: 'W01',
          capacity: 4, minimum_spend_minor: null, currency: 'CNY', layout_snapshot: {},
          status: 'available', assigned_to_actor: false, active_session_id: null,
          active_guest_count: null, created_at: '2026-08-11T00:00:00.000Z',
          updated_at: '2026-08-11T00:00:00.000Z',
        }]
      } else {
        throw new Error(`Unexpected query: ${normalized}`)
      }
      return { rows: rows as Row[], rowCount: rows.length }
    },
  }
}
