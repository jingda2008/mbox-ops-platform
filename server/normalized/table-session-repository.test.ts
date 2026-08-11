import { describe, expect, it } from 'vitest'
import type {
  CommandExecution,
  CommandOutcome,
  IdempotentCommand,
  JsonObject,
  ScopedTransaction,
} from './index.js'
import {
  TableAlreadyOpenError,
  TableSessionCommandService,
  TableSessionRepository,
  TableSessionTransitionError,
  type TableSession,
} from './table-session-repository.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const tableId = '33333333-3333-4333-8333-333333333333'
const employeeId = '44444444-4444-4444-8444-444444444444'
const sessionId = '55555555-5555-4555-8555-555555555555'

interface QueryCall {
  sql: string
  values: readonly unknown[]
}

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  readonly calls: QueryCall[] = []

  constructor(private readonly responses: Array<{ rows: Record<string, unknown>[]; rowCount?: number }>) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql: normalizeSql(text), values: [...values] })
    const response = this.responses.shift()
    if (response === undefined) throw new Error(`Unexpected query: ${normalizeSql(text)}`)
    return {
      rows: response.rows as Row[],
      rowCount: response.rowCount ?? response.rows.length,
    }
  }
}

class RecordingCommandExecutor {
  operationScope: string | null = null
  calls = 0

  constructor(private readonly transaction: ScopedTransaction) {}

  async execute<Result>(
    command: Readonly<IdempotentCommand<Result>>,
    handler: (transaction: ScopedTransaction) => Promise<CommandOutcome<Result>>,
  ): Promise<CommandExecution<Result>> {
    this.operationScope = command.operationScope
    this.calls += 1
    const outcome = await handler(this.transaction)
    expect(outcome.auditEvents).toHaveLength(1)
    expect(outcome.outboxMessages).toHaveLength(1)
    return { value: outcome.result, replayed: false }
  }
}

describe('TableSessionRepository', () => {
  it('locks only the addressed table and records seats above capacity in the snapshot', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [tableRow('W01', 4)] },
      { rows: [] },
      { rows: [sessionRow('W01', 'open', { occasion: 'friends', extraSeatCount: 2 }, 6)] },
    ])

    const session = await new TableSessionRepository(transaction).open({
      table: { kind: 'code', value: 'W01' },
      publicId: 'session-w01-20260811',
      businessDate: '2026-08-11',
      guestCount: 6,
      capacityOverrideReason: '现场加椅并保持通道畅通',
      guestProfileSnapshot: { occasion: 'friends' },
      openedByEmployeeId: employeeId,
    })

    expect(session.guestCount).toBe(6)
    expect(session.guestProfileSnapshot).toEqual({ occasion: 'friends', extraSeatCount: 2 })
    expect(transaction.calls[0]?.sql).toContain('WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND code = $3 FOR UPDATE')
    expect(transaction.calls[0]?.values[2]).toBe('W01')
    expect(transaction.calls[0]?.sql).not.toContain('mbox.table_sessions')
    expect(transaction.calls[2]?.values[7]).toBe('现场加椅并保持通道畅通')
    expect(transaction.calls[2]?.values[8]).toBe(employeeId)
    expect(JSON.parse(String(transaction.calls[2]?.values[9]))).toEqual({
      occasion: 'friends',
      extraSeatCount: 2,
    })
  })

  it('rejects a second active session after taking the target table lock', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [tableRow('VIP1', 8)] },
      { rows: [{ id: sessionId }] },
    ])

    await expect(new TableSessionRepository(transaction).open({
      table: { kind: 'id', value: tableId },
      publicId: 'session-vip1-20260811',
      businessDate: '2026-08-11',
      guestCount: 8,
    })).rejects.toBeInstanceOf(TableAlreadyOpenError)

    expect(transaction.calls).toHaveLength(2)
    expect(transaction.calls[0]?.sql).toContain('id = $3::uuid')
    expect(transaction.calls[0]?.sql).toContain('FOR UPDATE')
  })

  it('uses a session row lock and an explicit open -> closing transition', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [sessionRow('W01', 'open', { extraSeatCount: 0 })] },
      { rows: [sessionRow('W01', 'closing', { extraSeatCount: 0 })] },
    ])

    const result = await new TableSessionRepository(transaction).beginClosing(sessionId, employeeId)

    expect(result.status).toBe('closing')
    expect(transaction.calls[0]?.sql).toContain('FOR UPDATE OF s')
    expect(transaction.calls[1]?.sql).toContain('AND s.status = $7')
    expect(transaction.calls[1]?.values[6]).toBe('open')
  })

  it('rejects skipping the closing state and issues no update', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [sessionRow('W01', 'open', { extraSeatCount: 0 })] },
    ])

    await expect(
      new TableSessionRepository(transaction).completeClosing(sessionId, employeeId),
    ).rejects.toBeInstanceOf(TableSessionTransitionError)
    expect(transaction.calls).toHaveLength(1)
  })

  it('wraps open-table writes with the normalized idempotent command executor', async () => {
    const transaction = new ScriptedTransaction([
      { rows: [tableRow('L01', 4)] },
      { rows: [] },
      { rows: [sessionRow('L01', 'open', { extraSeatCount: 0 })] },
    ])
    const executor = new RecordingCommandExecutor(transaction)
    const service = new TableSessionCommandService(executor)

    const result = await service.open({
      scope: { tenantId, storeId },
      table: { kind: 'code', value: 'L01' },
      publicId: 'session-l01-20260811',
      businessDate: '2026-08-11',
      guestCount: 2,
      actor: { type: 'employee', employeeId },
      openedByEmployeeId: employeeId,
      idempotencyKey: 'open-l01-request-001',
      requestFingerprint: '{"table":"L01","guestCount":2}',
    })

    expect(result.replayed).toBe(false)
    expect(executor.operationScope).toBe('table-session.open')
    expect(executor.calls).toBe(1)
  })

  it('has no process-wide queue, so different table repositories can progress independently', async () => {
    const w01 = new ScriptedTransaction([
      { rows: [tableRow('W01', 4)] }, { rows: [] },
      { rows: [sessionRow('W01', 'open', { extraSeatCount: 0 })] },
    ])
    const l01 = new ScriptedTransaction([
      { rows: [tableRow('L01', 4)] }, { rows: [] },
      { rows: [sessionRow('L01', 'open', { extraSeatCount: 0 })] },
    ])

    const [first, second] = await Promise.all([
      new TableSessionRepository(w01).open(openInput('W01')),
      new TableSessionRepository(l01).open(openInput('L01')),
    ])

    expect([first.tableCode, second.tableCode]).toEqual(['W01', 'L01'])
    expect(w01.calls[0]?.values[2]).toBe('W01')
    expect(l01.calls[0]?.values[2]).toBe('L01')
  })
})

function openInput(code: string) {
  return {
    table: { kind: 'code' as const, value: code },
    publicId: `session-${code.toLowerCase()}-20260811`,
    businessDate: '2026-08-11',
    guestCount: 2,
  }
}

function tableRow(code: string, capacity: number): Record<string, unknown> {
  return { id: tableId, code, display_name: code, capacity, status: 'available' }
}

function sessionRow(
  tableCode: string,
  status: TableSession['status'],
  snapshot: JsonObject,
  guestCount = 2,
): Record<string, unknown> {
  return {
    id: sessionId,
    table_id: tableId,
    table_code: tableCode,
    public_id: `session-${tableCode.toLowerCase()}-20260811`,
    business_date: '2026-08-11',
    guest_count: guestCount,
    capacity_at_open: 4,
    capacity_override_reason: guestCount > 4 ? '现场加椅并保持通道畅通' : null,
    capacity_overridden_by_employee_id: guestCount > 4 ? employeeId : null,
    guest_profile_snapshot: snapshot,
    status,
    opened_by_employee_id: employeeId,
    closed_by_employee_id: status === 'open' ? null : employeeId,
    opened_at: '2026-08-11T12:00:00.000Z',
    closed_at: status === 'closed' ? '2026-08-11T13:00:00.000Z' : null,
  }
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
