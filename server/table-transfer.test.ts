import { describe, expect, it } from 'vitest'
import { createServiceTask } from './domain.js'
import { createOrderDraft } from './order-domain.js'
import { createSeedState } from './seed.js'
import { transferOpenTableSession } from './table-session-api.js'

const occurredAt = '2026-07-15T20:30:00+08:00'

function input(targetTableId = 'table-l04') {
  return {
    targetTableId,
    kind: 'relocate' as const,
    reason: '顾客申请更换位置',
    idempotencyKey: 'transfer-l01-l04-001',
  }
}

describe('whole-table transfer', () => {
  it('keeps the table session and moves active operational responsibility atomically', () => {
    const state = createSeedState()
    const sourceSession = state.songState.tableSessions.find((session) => session.tableId === 'table-l01')!
    const order = createOrderDraft(state.orderDomain, {
      orderId: 'order-transfer-001', tableSessionId: sourceSession.id, createdBy: 'emp-lin',
      occurredAt, idempotencyKey: 'order-transfer-draft-001',
    })
    const task = createServiceTask(state, {
      tableCode: 'L01', serviceTypeId: 'water', source: 'employee', note: '',
      idempotencyKey: 'transfer-task-water-001', requestedBy: 'emp-lin',
    })
    state.awaitingOrderIntents.push({
      id: 'awaiting-transfer-001', tableId: 'table-l01', status: 'active', startedBy: 'emp-lin',
      startedAt: occurredAt, nextReminderAt: occurredAt, reminderCount: 0, lastReminderAt: null,
      stoppedAt: null, stoppedBy: null, stopReason: null, configVersion: state.config.version,
    })

    const record = transferOpenTableSession(state, 'table-l01', input(), 'emp-chen', occurredAt)

    expect(record.tableSessionId).toBe(sourceSession.id)
    expect(record.guestCount).toBe(4)
    expect(state.tables.find((table) => table.id === 'table-l01')).toMatchObject({ status: 'available', guestCount: 0, openedAt: null })
    expect(state.tables.find((table) => table.id === 'table-l04')).toMatchObject({ status: 'occupied', guestCount: 4 })
    expect(sourceSession).toMatchObject({ tableId: 'table-l04', tableCode: 'L04', status: 'open' })
    expect(state.tasks.find((item) => item.id === task.id)?.tableId).toBe('table-l04')
    expect(state.awaitingOrderIntents[0]?.tableId).toBe('table-l04')
    expect(order?.tableSessionId).toBe(sourceSession.id)
    expect(state.taskEvents.some((event) => event.taskId === task.id && event.type === 'task.table_transferred.v1')).toBe(true)
    expect(state.auditEntries.at(-1)).toMatchObject({ action: 'table.transferred.v1', objectId: record.id })
  })

  it('returns the same record for an identical idempotent replay', () => {
    const state = createSeedState()
    const first = transferOpenTableSession(state, 'table-l01', input(), 'emp-chen', occurredAt)
    const second = transferOpenTableSession(state, 'table-l01', input(), 'emp-chen', '2026-07-15T20:31:00+08:00')
    expect(second).toEqual(first)
    expect(state.tableTransfers).toHaveLength(1)
  })

  it.each([
    ['table-i03', '目标桌容量不足'],
    ['table-l02', '合台需要使用专用合台流程'],
    ['table-l03', '目标桌已被预约锁定'],
  ])('blocks unsafe target %s', (targetTableId, message) => {
    const state = createSeedState()
    expect(() => transferOpenTableSession(
      state,
      'table-l01',
      { ...input(targetTableId), idempotencyKey: `transfer-block-${targetTableId}` },
      'emp-chen',
      occurredAt,
    )).toThrow(message)
    expect(state.tableTransfers).toHaveLength(0)
    expect(state.tables.find((table) => table.id === 'table-l01')?.status).toBe('occupied')
  })
})
