import { describe, expect, it } from 'vitest'
import { mboxVenueTableCodes, mboxVenueTables } from '../src/shared/venue-layout.js'
import { createSeedState } from './seed.js'
import { applyMboxVenueLayout } from './venue-layout.js'

describe('M-Box venue layout migration', () => {
  it('adds all 61 unique real tables and corrects duplicated W labels', () => {
    const state = createSeedState(new Date('2026-07-28T12:00:00+08:00'))
    applyMboxVenueLayout(state)

    const realTables = state.tables.filter((table) => mboxVenueTableCodes.has(table.code))
    expect(mboxVenueTables).toHaveLength(61)
    expect(realTables).toHaveLength(61)
    expect(new Set(realTables.map((table) => table.code)).size).toBe(61)
    expect(realTables.map((table) => table.code)).toEqual(expect.arrayContaining(['W05', 'W06', 'W10', 'W11']))
  })

  it('preserves real live table state and removes all legacy simulation tables from operations', () => {
    const state = createSeedState(new Date('2026-07-28T12:00:00+08:00'))
    const liveL01 = state.tables.find((table) => table.code === 'L01')!
    const originalCapacity = liveL01.capacity

    applyMboxVenueLayout(state)

    expect(liveL01.status).toBe('occupied')
    expect(liveL01.capacity).toBe(originalCapacity)
    expect(state.tables.some((table) => ['I01', 'I02', 'I03'].includes(table.code))).toBe(false)
    expect(state.areas.some((area) => area.id === 'interactive')).toBe(false)
    expect(state.employees.some((employee) => employee.areaIds.includes('interactive'))).toBe(false)
    expect(state.shiftAssignments.some((shift) => shift.areaIds.includes('interactive'))).toBe(false)
    expect(state.songState.tableSessions
      .filter((session) => ['I01', 'I02', 'I03'].includes(session.tableCode))
      .every((session) => session.status === 'closed' && session.closedAt)).toBe(true)
    expect(state.auditEntries.some((entry) => entry.action === 'runtime.legacy_simulation_tables_retired.v1')).toBe(true)
  })

  it('is idempotent and never overwrites an existing table capacity', () => {
    const state = createSeedState(new Date('2026-07-28T12:00:00+08:00'))
    const originalCapacity = state.tables.find((candidate) => candidate.code === 'L01')!.capacity
    applyMboxVenueLayout(state)
    const table = state.tables.find((candidate) => candidate.code === 'L01')!
    table.status = 'available'
    table.guestCount = 0
    table.openedAt = null

    applyMboxVenueLayout(state)
    applyMboxVenueLayout(state)

    expect(table.capacity).toBe(originalCapacity)
    expect(state.auditEntries.filter((entry) => entry.action === 'runtime.mbox_venue_layout_v1_migrated.v1')).toHaveLength(1)
  })
})
