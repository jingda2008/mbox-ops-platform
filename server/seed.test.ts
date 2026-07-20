import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'

describe('seed business date', () => {
  it('keeps after-midnight operations on the previous Beijing business date', () => {
    const state = createSeedState(new Date('2026-07-19T17:00:00.000Z'))

    expect(state.store.businessDate).toBe('2026-07-19')
    expect(state.shiftAssignments.every((shift) => shift.businessDate === '2026-07-19')).toBe(true)
    expect(state.songState.performanceSessions[0]).toMatchObject({ businessDate: '2026-07-19' })
    expect(state.songState.tableSessions.every((session) => session.id.endsWith(':2026-07-19'))).toBe(true)
  })

  it('moves to the new business date at 06:00 Beijing time', () => {
    const state = createSeedState(new Date('2026-07-19T22:00:00.000Z'))

    expect(state.store.businessDate).toBe('2026-07-20')
    expect(state.shiftAssignments[0]).toMatchObject({
      startAt: '2026-07-20T11:00:00.000Z',
      endAt: '2026-07-20T19:00:00.000Z',
    })
  })
})
