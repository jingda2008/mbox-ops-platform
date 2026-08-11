import { describe, expect, it } from 'vitest'
import type { ScopedTransaction } from './index.js'
import {
  ServiceTaskRepository,
  ServiceTaskSessionMismatchError,
  ServiceTaskTransitionError,
  type ServiceTaskStatus,
} from './service-task-repository.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const tableId = '33333333-3333-4333-8333-333333333333'
const sessionId = '44444444-4444-4444-8444-444444444444'
const taskId = '55555555-5555-4555-8555-555555555555'
const employeeId = '66666666-6666-4666-8666-666666666666'

interface QueryCall {
  sql: string
  values: readonly unknown[]
}

type Response = { rows: Record<string, unknown>[]; rowCount?: number } | Error

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  readonly calls: QueryCall[] = []

  constructor(private readonly responses: Response[]) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql: normalizeSql(text), values: [...values] })
    const response = this.responses.shift()
    if (response === undefined) throw new Error(`Unexpected query: ${normalizeSql(text)}`)
    if (response instanceof Error) throw response
    return {
      rows: response.rows as Row[],
      rowCount: response.rowCount ?? response.rows.length,
    }
  }
}

describe('ServiceTaskRepository', () => {
  it('creates the task and its creation event through the same transaction', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [taskRow('pending')] },
      { rows: [], rowCount: 1 },
    ])

    const task = await new ServiceTaskRepository(transaction).create(createInput())

    expect(task.status).toBe('pending')
    expect(transaction.calls).toHaveLength(2)
    expect(transaction.calls[0]?.sql).toContain('INSERT INTO mbox.service_tasks')
    expect(transaction.calls[1]?.sql).toContain('INSERT INTO mbox.service_task_events')
    expect(transaction.calls[1]?.values[3]).toBe('task.created')
  })

  it('propagates event failure so the surrounding transaction can roll back the task', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [taskRow('pending')] },
      new Error('event insert failed'),
    ])

    await expect(new ServiceTaskRepository(transaction).create(createInput()))
      .rejects.toThrow('event insert failed')
    expect(transaction.calls.map((call) => call.sql)).toEqual([
      expect.stringContaining('INSERT INTO mbox.service_tasks'),
      expect.stringContaining('INSERT INTO mbox.service_task_events'),
    ])
  })

  it('rejects a task when the table session is closed or belongs to another table', async () => {
    const transaction = new ScriptedTransaction([{ rows: [], rowCount: 0 }])

    await expect(new ServiceTaskRepository(transaction).create(createInput()))
      .rejects.toBeInstanceOf(ServiceTaskSessionMismatchError)

    expect(transaction.calls).toHaveLength(1)
    expect(transaction.calls[0]?.sql).toContain("session.status IN ('open', 'closing')")
    expect(transaction.calls[0]?.sql).toContain('session.table_id = $3::uuid')
  })

  it.each([
    ['acknowledge', 'pending', 'acknowledged'],
    ['start', 'acknowledged', 'in_progress'],
    ['complete', 'in_progress', 'completed'],
    ['cancel', 'pending', 'cancelled'],
  ] as const)('supports legal %s transitions with a conditional update and event', async (
    method,
    previousStatus,
    targetStatus,
  ) => {
    const transaction = new ScriptedTransaction([
      { rows: [{ ...taskRow(targetStatus), previous_status: previousStatus }] },
      { rows: [], rowCount: 1 },
    ])
    const repository = new ServiceTaskRepository(transaction)

    const task = await repository[method]({
      taskId,
      actor: { type: 'employee', employeeId },
      eventIdempotencyKey: `${method}-event-001`,
    })

    expect(task.status).toBe(targetStatus)
    expect(transaction.calls[0]?.sql).toContain('AND status = ANY($6::text[])')
    expect(transaction.calls[0]?.sql).toContain('FOR UPDATE')
    expect(transaction.calls[1]?.values.slice(4, 6)).toEqual([previousStatus, targetStatus])
  })

  it('rejects an illegal or concurrently lost transition without writing an event', async () => {
    const transaction = new ScriptedTransaction([{ rows: [] }])

    await expect(new ServiceTaskRepository(transaction).complete({
      taskId,
      actor: { type: 'employee', employeeId },
    })).rejects.toBeInstanceOf(ServiceTaskTransitionError)

    expect(transaction.calls).toHaveLength(1)
  })

  it('returns only active tasks for one table session in actionable priority order', async () => {
    const transaction = new ScriptedTransaction([{ rows: [taskRow('pending')] }])

    await new ServiceTaskRepository(transaction).findActiveByTableSession(sessionId)

    expect(transaction.calls[0]?.sql).toContain('table_session_id = $3::uuid')
    expect(transaction.calls[0]?.sql).toContain('status = ANY($4::text[])')
    expect(transaction.calls[0]?.sql).toContain("CASE priority WHEN 'urgent' THEN 4")
    expect(transaction.calls[0]?.values[2]).toBe(sessionId)
  })

  it('builds an employee queue from direct, backup and authorized-role ownership', async () => {
    const transaction = new ScriptedTransaction([{ rows: [taskRow('pending')] }])

    await new ServiceTaskRepository(transaction).findQueueForEmployee({
      employeeId,
      roleCodes: ['SERVER', 'DUTY_MANAGER'],
      limit: 50,
    })

    const query = transaction.calls[0]
    expect(query?.sql).toContain('assigned_employee_id = $4::uuid')
    expect(query?.sql).toContain('backup_employee_id = $4::uuid')
    expect(query?.sql).toContain('requested_role_code = ANY($5::text[])')
    expect(query?.values[4]).toEqual(['SERVER', 'DUTY_MANAGER'])
    expect(query?.values[5]).toBe(50)
  })
})

function createInput() {
  return {
    tableId,
    tableSessionId: sessionId,
    publicId: 'service-task-0001',
    taskType: 'guest.call',
    title: '客人呼叫服务',
    source: 'guest' as const,
    requestedRoleCode: 'SERVER',
    actor: { type: 'guest' as const },
  }
}

function taskRow(status: ServiceTaskStatus): Record<string, unknown> {
  return {
    id: taskId,
    table_id: tableId,
    table_session_id: sessionId,
    public_id: 'service-task-0001',
    task_type: 'guest.call',
    title: '客人呼叫服务',
    detail: null,
    priority: 'normal',
    status,
    source: 'guest',
    requested_role_code: 'SERVER',
    assigned_employee_id: null,
    backup_employee_id: null,
    request_count: 1,
    request_snapshot: {},
    due_at: null,
    escalate_at: null,
    next_action_at: '2026-08-11T12:01:00.000Z',
    acknowledged_at: null,
    completed_at: status === 'completed' ? '2026-08-11T12:02:00.000Z' : null,
    cancelled_at: status === 'cancelled' ? '2026-08-11T12:02:00.000Z' : null,
    created_at: '2026-08-11T12:00:00.000Z',
    updated_at: '2026-08-11T12:00:00.000Z',
  }
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
