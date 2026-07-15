import type {
  Employee,
  RoleDataScope,
  RuntimeState,
  ShiftAssignment,
  StaffPermissionId,
} from './contracts.js'

export function normalizedRoleIds(record: Pick<Employee | ShiftAssignment, 'roleId' | 'roleIds'> | null | undefined) {
  if (!record) return []
  return [...new Set([record.roleId, ...(record.roleIds ?? [])].filter(Boolean))]
}

export function effectiveRoleIdsForEmployee(state: RuntimeState, employeeId: string) {
  const employee = state.employees.find((item) => item.id === employeeId && item.status === 'active')
  const shifts = state.shiftAssignments.filter((shift) => (
    shift.employeeId === employeeId
    && shift.businessDate === state.store.businessDate
    && shift.status === 'active'
  ))
  if (shifts.length > 0) return [...new Set([
    ...shifts.flatMap(normalizedRoleIds),
    ...(employee?.roleIds ?? []),
  ])]
  return normalizedRoleIds(employee)
}

export function effectivePermissionIdsForEmployee(state: RuntimeState, employeeId: string) {
  const employee = state.employees.find((item) => item.id === employeeId && item.status === 'active')
  const permissions = new Set<StaffPermissionId>(employee?.permissionIds ?? [])
  for (const roleId of effectiveRoleIdsForEmployee(state, employeeId)) {
    const role = state.config.roles.find((item) => item.id === roleId)
    for (const permissionId of role?.permissionIds ?? []) permissions.add(permissionId)
  }
  return [...permissions]
}

const scopeRank: Record<RoleDataScope, number> = {
  own: 0,
  assigned_areas: 1,
  store: 2,
  all_stores: 3,
}

export function effectiveDataScopeForEmployee(state: RuntimeState, employeeId: string): RoleDataScope {
  return effectiveRoleIdsForEmployee(state, employeeId).reduce<RoleDataScope>((broadest, roleId) => {
    const scope = state.config.roles.find((item) => item.id === roleId)?.dataScope ?? 'own'
    return scopeRank[scope] > scopeRank[broadest] ? scope : broadest
  }, 'own')
}
