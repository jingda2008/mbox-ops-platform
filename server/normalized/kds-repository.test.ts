import { describe, expect, it } from 'vitest'
import type { ScopedTransaction } from './index.js'
import { KdsRepository, KdsTransitionError, type KdsStatus } from './kds-repository.js'
import { KdsAuthorizationError, type KdsAuthorizationPort } from './kds-authorization-policy.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const itemId = '33333333-3333-4333-8333-333333333333'
const taskId = '44444444-4444-4444-8444-444444444444'
const employeeId = '55555555-5555-4555-8555-555555555555'

interface Call { sql: string; values: readonly unknown[] }
type Response = { rows: Record<string, unknown>[]; rowCount?: number } | Error

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  readonly calls: Call[] = []
  constructor(private readonly responses: Response[]) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) {
    this.calls.push({ sql: normalize(text), values: [...values] })
    const response = this.responses.shift()
    if (!response) throw new Error(`Unexpected query: ${normalize(text)}`)
    if (response instanceof Error) throw response
    return { rows: response.rows as Row[], rowCount: response.rowCount ?? response.rows.length }
  }
}

describe('KdsRepository', () => {
  it('creates a KDS task linked directly to one order item and appends an event', async () => {
    const tx = new ScriptedTransaction([{ rows: [taskRow('pending')] }, { rows: [], rowCount: 1 }])
    const task = await new KdsRepository(tx).create({
      orderItemId: itemId,
      stationCode: 'bar',
      quantity: 2,
    })
    expect(task.orderItemId).toBe(itemId)
    expect(tx.calls[0]?.sql).toContain('order_item_id')
    expect(tx.calls[1]?.sql).toContain('INSERT INTO mbox.kds_task_events')
  })

  it('uses a conditional row lock for state changes and never copies state to order items', async () => {
    const tx = new ScriptedTransaction([
      { rows: [{ ...taskRow('preparing'), previous_status: 'accepted' }] },
      { rows: [], rowCount: 1 },
    ])
    const task = await new KdsRepository(tx, allowAuthorization()).startPreparing({
      taskId,
      actorEmployeeId: employeeId,
      eventIdempotencyKey: 'kds-start-0001',
    })
    expect(task.status).toBe('preparing')
    expect(tx.calls[0]?.sql).toContain('FOR UPDATE OF task')
    expect(tx.calls[0]?.sql).toContain('task.status = ANY($6::text[])')
    expect(tx.calls.every((call) => !call.sql.includes('UPDATE mbox.order_items'))).toBe(true)
    expect(tx.calls[1]?.values.slice(4, 6)).toEqual(['accepted', 'preparing'])
  })

  it('claims no more than 50 pending tasks using SKIP LOCKED and writes claim events', async () => {
    const tx = new ScriptedTransaction([
      { rows: [{ ...taskRow('accepted'), previous_status: 'pending' }] },
      { rows: [], rowCount: 1 },
    ])
    const tasks = await new KdsRepository(tx, allowAuthorization()).claimPending({
      stationCode: 'bar',
      actorEmployeeId: employeeId,
      workerId: 'bar-tablet-01',
      limit: 50,
    })
    expect(tasks).toHaveLength(1)
    expect(tx.calls[0]?.sql).toContain('FOR UPDATE OF task SKIP LOCKED')
    expect(tx.calls[0]?.sql).toContain('LIMIT $4')
    expect(tx.calls[0]?.values[3]).toBe(50)
    expect(tx.calls[1]?.values[3]).toBe('task.accepted')
  })

  it('rejects a lost or illegal transition without creating an event', async () => {
    const tx = new ScriptedTransaction([{ rows: [] }])
    await expect(new KdsRepository(tx, allowAuthorization()).markReady({ taskId, actorEmployeeId: employeeId }))
      .rejects.toBeInstanceOf(KdsTransitionError)
    expect(tx.calls).toHaveLength(1)
  })

  it('authorizes every employee transition before taking the task row lock', async () => {
    const actions: string[] = []
    const authorization: KdsAuthorizationPort = {
      assertCanPrepare: async ({ action }) => { actions.push(action) },
    }
    const tx = new ScriptedTransaction([
      { rows: [{ ...taskRow('ready'), previous_status: 'preparing' }] },
      { rows: [], rowCount: 1 },
    ])

    await new KdsRepository(tx, authorization).markReady({ taskId, actorEmployeeId: employeeId })

    expect(actions).toEqual(['complete'])
    expect(tx.calls[0]?.sql).toContain('FOR UPDATE OF task')
  })

  it.each([
    ['accept', (repository: KdsRepository) => repository.accept({ taskId, actorEmployeeId: employeeId })],
    ['start', (repository: KdsRepository) => repository.startPreparing({ taskId, actorEmployeeId: employeeId })],
    ['complete', (repository: KdsRepository) => repository.markReady({ taskId, actorEmployeeId: employeeId })],
    ['cancel', (repository: KdsRepository) => repository.cancel({ taskId, actorEmployeeId: employeeId })],
    ['fail', (repository: KdsRepository) => repository.fail({ taskId, actorEmployeeId: employeeId })],
  ] as const)('requires authorization for the %s employee action', async (expectedAction, execute) => {
    const tx = new ScriptedTransaction([])
    const authorization: KdsAuthorizationPort = {
      assertCanPrepare: async ({ action }) => {
        expect(action).toBe(expectedAction)
        throw new KdsAuthorizationError('KDS_PREPARE_FORBIDDEN', action)
      },
    }

    await expect(execute(new KdsRepository(tx, authorization)))
      .rejects.toBeInstanceOf(KdsAuthorizationError)
    expect(tx.calls).toHaveLength(0)
  })

  it('fails closed before reading or locking tasks when authorization is denied', async () => {
    const tx = new ScriptedTransaction([])
    const authorization: KdsAuthorizationPort = {
      assertCanPrepare: async ({ action }) => {
        throw new KdsAuthorizationError('KDS_PREPARE_FORBIDDEN', action)
      },
    }

    await expect(new KdsRepository(tx, authorization).claimPending({
      stationCode: 'bar',
      actorEmployeeId: employeeId,
      workerId: 'bar-tablet-01',
    })).rejects.toMatchObject({ code: 'KDS_PREPARE_FORBIDDEN', action: 'claim' })
    expect(tx.calls).toHaveLength(0)
  })
})

function allowAuthorization(): KdsAuthorizationPort {
  return { assertCanPrepare: async () => undefined }
}

function taskRow(status: KdsStatus): Record<string, unknown> {
  return {
    id: taskId,
    order_item_id: itemId,
    remake_of_task_id: null,
    station_code: 'bar',
    status,
    priority: 100,
    quantity: 2,
    assigned_employee_id: status === 'pending' ? null : employeeId,
    due_at: null,
    next_action_at: '2026-08-11T12:00:00.000Z',
    accepted_at: status === 'pending' ? null : '2026-08-11T12:00:00.000Z',
    ready_at: status === 'ready' ? '2026-08-11T12:03:00.000Z' : null,
    cancelled_at: status === 'cancelled' ? '2026-08-11T12:03:00.000Z' : null,
  }
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
