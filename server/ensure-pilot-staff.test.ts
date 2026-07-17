import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import { PILOT_EMPLOYEE_IDS, reconcilePilotStaff } from './ensure-pilot-staff.js'

describe('pilot staff reconciliation', () => {
  it('adds only missing staff and shifts, repairs canonical duties and remains idempotent', () => {
    const state = createSeedState()
    const retainedIds = new Set(['emp-lin', 'emp-jie', 'emp-wu', 'emp-qing', 'emp-mia', 'emp-chen'])
    state.employees = state.employees.filter((employee) => retainedIds.has(employee.id))
    state.shiftAssignments = state.shiftAssignments.filter((shift) => retainedIds.has(shift.employeeId))
    const bartender = state.employees.find((employee) => employee.id === 'emp-qing')!
    bartender.displayName = '虚拟员工'
    bartender.roleId = 'specialist'
    bartender.roleIds = []
    bartender.skillIds = []
    const bartenderShift = state.shiftAssignments.find((shift) => shift.employeeId === 'emp-qing')!
    bartenderShift.roleId = 'specialist'
    bartenderShift.stationIds = []
    const previousRevision = state.revision

    const first = reconcilePilotStaff(state, createSeedState(), '2026-07-15T01:00:00.000Z')
    expect(first).toMatchObject({ changed: true, addedEmployeeIds: expect.arrayContaining([
      'emp-owner', 'emp-admin', 'emp-han', 'emp-tao', 'emp-cashier', 'emp-host',
    ]) })
    expect(state.employees.map((employee) => employee.id).filter((id) => PILOT_EMPLOYEE_IDS.includes(id as typeof PILOT_EMPLOYEE_IDS[number]))).toHaveLength(12)
    expect(state.employees.find((employee) => employee.id === 'emp-qing')).toMatchObject({
      displayName: '冷言志', roleId: 'bartender', roleIds: ['supervisor'],
      skillIds: ['skill-bar', 'skill-runner'],
    })
    expect(state.shiftAssignments.find((shift) => shift.employeeId === 'emp-qing')).toMatchObject({
      roleId: 'bartender', roleIds: ['supervisor'],
      stationIds: ['bar-main', 'kitchen-cold', 'kitchen-hot'],
    })
    expect(state.revision).toBe(previousRevision + 1)
    expect(state.auditEntries.at(-1)?.action).toBe('pilot.staff_roster_reconciled.v1')

    const second = reconcilePilotStaff(state, createSeedState(), '2026-07-15T01:01:00.000Z')
    expect(second.changed).toBe(false)
    expect(state.revision).toBe(previousRevision + 1)
  })
})
