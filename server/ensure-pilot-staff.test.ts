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
    state.config.roles.find((role) => role.id === 'owner')!.name = '旧老板岗位'
    state.config.roles = state.config.roles.filter((role) => !['operations_director', 'market_operations'].includes(role.id))
    state.benefitGrantPolicies = state.benefitGrantPolicies.filter((policy) => policy.roleId !== 'operations_director')
    for (const roleIds of Object.values(state.inventoryDomain.policy)) {
      const index = roleIds.indexOf('operations_director')
      if (index >= 0) roleIds.splice(index, 1)
    }
    state.songState.managerActorIds = state.songState.managerActorIds.filter((actorId) => actorId !== 'emp-operations-director')
    const previousRevision = state.revision

    const first = reconcilePilotStaff(state, createSeedState(), '2026-07-15T01:00:00.000Z')
    expect(first).toMatchObject({
      changed: true,
      addedRoleIds: ['operations_director', 'market_operations'],
      updatedRoleIds: ['owner'],
      updatedPolicySections: [
        'benefit.operations_director',
        'inventory.operations_director',
        'song.manager_actors',
      ],
      addedEmployeeIds: expect.arrayContaining([
      'emp-owner', 'emp-operations-director', 'emp-admin', 'emp-han', 'emp-tao', 'emp-cashier', 'emp-host',
      ]),
    })
    expect(state.config.roles.find((role) => role.id === 'owner')?.name).toBe('老板')
    expect(state.config.roles.find((role) => role.id === 'operations_director')?.name).toBe('运营负责人')
    expect(state.config.roles.find((role) => role.id === 'market_operations')?.name).toBe('市场运营总监')
    expect(state.benefitGrantPolicies.find((policy) => policy.roleId === 'operations_director')?.canApprove).toBe(true)
    expect(state.inventoryDomain.policy.stockCountApprovalRoleIds).toContain('operations_director')
    expect(state.songState.managerActorIds).toContain('emp-operations-director')
    expect(state.employees.map((employee) => employee.id).filter((id) => PILOT_EMPLOYEE_IDS.includes(id as typeof PILOT_EMPLOYEE_IDS[number]))).toHaveLength(13)
    expect(state.employees.find((employee) => employee.id === 'emp-qing')).toMatchObject({
      displayName: '冷言志', roleId: 'bartender', roleIds: ['supervisor'],
      skillIds: ['skill-bar'],
    })
    expect(state.shiftAssignments.find((shift) => shift.employeeId === 'emp-qing')).toMatchObject({
      roleId: 'bartender', roleIds: ['supervisor'],
      stationIds: ['bar-main'],
    })
    expect(state.revision).toBe(previousRevision + 1)
    expect(state.auditEntries.at(-1)?.action).toBe('pilot.staff_roster_reconciled.v1')

    const second = reconcilePilotStaff(state, createSeedState(), '2026-07-15T01:01:00.000Z')
    expect(second.changed).toBe(false)
    expect(state.revision).toBe(previousRevision + 1)
  })
})
