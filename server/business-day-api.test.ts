import { describe, expect, it } from 'vitest'
import { prepareNextBusinessDayShifts } from './business-day-api.js'
import { createSeedState } from './seed.js'

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

describe('business day shift continuity', () => {
  it('activates existing next-day shifts without copying the current roster', () => {
    const state = createSeedState()
    const currentDate = state.store.businessDate
    const followingDate = nextDate(currentDate)
    const scheduled = {
      ...structuredClone(state.shiftAssignments[0]!),
      id: 'shift-next-existing',
      businessDate: followingDate,
      status: 'scheduled' as const,
    }
    state.shiftAssignments.push(scheduled)

    const result = prepareNextBusinessDayShifts(state, currentDate, followingDate)

    expect(result).toEqual({ source: 'existing', shiftIds: ['shift-next-existing'] })
    expect(state.shiftAssignments.find((shift) => shift.id === scheduled.id)?.status).toBe('active')
    expect(state.shiftAssignments.filter((shift) => shift.businessDate === followingDate)).toHaveLength(1)
  })

  it('copies active shifts with preserved duration when no next-day roster exists', () => {
    const state = createSeedState()
    const currentDate = state.store.businessDate
    const followingDate = nextDate(currentDate)
    const source = state.shiftAssignments[0]!
    const sourceDuration = Date.parse(source.endAt) - Date.parse(source.startAt)

    const result = prepareNextBusinessDayShifts(state, currentDate, followingDate)
    const copies = state.shiftAssignments.filter((shift) => shift.businessDate === followingDate)

    expect(result.source).toBe('copied')
    expect(copies).toHaveLength(state.shiftAssignments.length / 2)
    expect(copies.every((shift) => shift.status === 'active')).toBe(true)
    expect(Date.parse(copies[0]!.endAt) - Date.parse(copies[0]!.startAt)).toBe(sourceDuration)
  })

  it('refuses to roll over into a business day with no usable roster source', () => {
    const state = createSeedState()
    const currentDate = state.store.businessDate
    state.shiftAssignments.forEach((shift) => { shift.status = 'completed' })

    expect(() => prepareNextBusinessDayShifts(state, currentDate, nextDate(currentDate)))
      .toThrow('无可复制的有效班次')
  })
})
