import { describe, expect, it } from 'vitest'
import { reconcileAutomaticBusinessDay } from './business-day-rollover.js'
import { createSeedState } from './seed.js'

function stateFor(businessDate: string) {
  const state = createSeedState()
  state.store.businessDate = businessDate
  state.songState.businessDate = businessDate
  state.tableOperationsConfig = {
    ...(state.tableOperationsConfig ?? {
      version: 1,
      updatedAt: '2026-07-19T00:00:00.000Z',
      reminder: { enabled: true, firstReminderMinutes: 60, repeatMinutes: 30, thresholdPercent: 80 },
      minimumSpendRules: [],
    }),
    automaticBusinessDayRollover: true,
    businessDayRolloverHour: 6,
  }
  for (const shift of state.shiftAssignments) shift.businessDate = businessDate
  return state
}

describe('automatic business day rollover', () => {
  it('keeps the previous business day through 05:59 Beijing time', () => {
    const state = stateFor('2026-07-19')
    const revision = state.revision

    const result = reconcileAutomaticBusinessDay(state, new Date('2026-07-20T05:59:59+08:00'))

    expect(result.status).toBe('current')
    expect(state.store.businessDate).toBe('2026-07-19')
    expect(state.revision).toBe(revision)
    expect(state.songState.tableSessions.some((session) => session.status === 'open')).toBe(true)
  })

  it('switches at exactly 06:00, archives live work and preserves financial review status', () => {
    const state = stateFor('2026-07-19')

    const result = reconcileAutomaticBusinessDay(state, new Date('2026-07-20T06:00:00+08:00'))

    expect(result).toMatchObject({
      status: 'rolled_over',
      businessDate: '2026-07-20',
      expectedBusinessDate: '2026-07-20',
      steps: [{
        businessDate: '2026-07-19',
        nextBusinessDate: '2026-07-20',
        financialCloseStatus: 'pending_review',
        handoverId: null,
      }],
    })
    expect(state.store.businessDate).toBe('2026-07-20')
    expect(state.songState.businessDate).toBe('2026-07-20')
    expect(state.songState.tableSessions.every((session) => session.status === 'closed')).toBe(true)
    expect(state.tables.every((table) => !['occupied', 'reserved'].includes(table.status))).toBe(true)
    expect(state.shiftAssignments.filter((shift) => shift.businessDate === '2026-07-19').every((shift) => shift.status === 'completed')).toBe(true)
    expect(state.shiftAssignments.filter((shift) => shift.businessDate === '2026-07-20' && shift.status === 'active')).toHaveLength(13)
    expect(state.auditEntries).toContainEqual(expect.objectContaining({
      action: 'business_day.auto_rolled_over.v1',
      objectId: '2026-07-19',
      details: expect.objectContaining({ rolloverHour: 6, financialCloseStatus: 'pending_review' }),
    }))
  })

  it('catches up every missed business day once and is idempotent afterwards', () => {
    const state = stateFor('2026-07-17')

    const first = reconcileAutomaticBusinessDay(state, new Date('2026-07-20T12:00:00+08:00'))
    const revision = state.revision
    const second = reconcileAutomaticBusinessDay(state, new Date('2026-07-20T12:01:00+08:00'))

    expect(first.status).toBe('rolled_over')
    expect(first.steps.map((step) => step.businessDate)).toEqual(['2026-07-17', '2026-07-18', '2026-07-19'])
    expect(state.store.businessDate).toBe('2026-07-20')
    expect(second.status).toBe('current')
    expect(state.revision).toBe(revision)
    expect(state.auditEntries.filter((entry) => entry.action === 'business_day.auto_rolled_over.v1')).toHaveLength(3)
  })

  it('honors the store switch when automatic rollover is disabled', () => {
    const state = stateFor('2026-07-19')
    state.tableOperationsConfig!.automaticBusinessDayRollover = false

    const result = reconcileAutomaticBusinessDay(state, new Date('2026-07-20T12:00:00+08:00'))

    expect(result.status).toBe('disabled')
    expect(state.store.businessDate).toBe('2026-07-19')
  })
})
