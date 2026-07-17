import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Employee, RuntimeState, ShiftAssignment } from '../src/shared/contracts.js'
import { createRuntimeDependencies } from './repository-factory.js'
import { loadRuntimeConfig } from './runtime-config.js'
import { createSeedState } from './seed.js'

export const PILOT_EMPLOYEE_IDS = [
  'emp-owner',
  'emp-operations-director',
  'emp-admin',
  'emp-lin',
  'emp-jie',
  'emp-wu',
  'emp-qing',
  'emp-han',
  'emp-tao',
  'emp-mia',
  'emp-chen',
  'emp-cashier',
  'emp-host',
] as const

const PILOT_ROLE_IDS = [
  'owner',
  'operations_director',
  'backup',
  'specialist',
  'market_design',
  'market_operations',
  'technical',
] as const

function sameList(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
}

function reconcileEmployee(existing: Employee, reference: Employee) {
  const changed = existing.displayName !== reference.displayName
    || existing.initials !== reference.initials
    || existing.status !== 'active'
    || existing.roleId !== reference.roleId
    || !sameList(existing.roleIds, reference.roleIds)
    || !sameList(existing.permissionIds, reference.permissionIds)
    || !sameList(existing.areaIds, reference.areaIds)
    || !sameList(existing.skillIds, reference.skillIds)
  if (!changed) return false
  existing.displayName = reference.displayName
  existing.initials = reference.initials
  existing.status = 'active'
  existing.roleId = reference.roleId
  existing.roleIds = [...(reference.roleIds ?? [])]
  existing.permissionIds = [...(reference.permissionIds ?? [])]
  existing.areaIds = [...reference.areaIds]
  existing.skillIds = [...(reference.skillIds ?? [])]
  existing.online = false
  existing.paused = false
  return true
}

function reconcileShift(existing: ShiftAssignment, reference: ShiftAssignment) {
  const changed = existing.roleId !== reference.roleId
    || !sameList(existing.roleIds, reference.roleIds)
    || !sameList(existing.areaIds, reference.areaIds)
    || !sameList(existing.stationIds, reference.stationIds)
    || existing.isPrimary !== reference.isPrimary
  if (!changed) return false
  existing.roleId = reference.roleId
  existing.roleIds = [...(reference.roleIds ?? [])]
  existing.areaIds = [...reference.areaIds]
  existing.stationIds = [...(reference.stationIds ?? [])]
  existing.isPrimary = reference.isPrimary
  return true
}

export interface PilotStaffReconciliationResult {
  addedRoleIds: string[]
  updatedRoleIds: string[]
  addedEmployeeIds: string[]
  updatedEmployeeIds: string[]
  addedShiftIds: string[]
  updatedShiftIds: string[]
  updatedTableIds: string[]
  updatedAuthorityIds: string[]
  addedAuthorityIds: string[]
  updatedPolicySections: string[]
  changed: boolean
}

export function reconcilePilotStaff(
  state: RuntimeState,
  reference: RuntimeState = createSeedState(),
  occurredAt = new Date().toISOString(),
): PilotStaffReconciliationResult {
  const result: PilotStaffReconciliationResult = {
    addedRoleIds: [],
    updatedRoleIds: [],
    addedEmployeeIds: [],
    updatedEmployeeIds: [],
    addedShiftIds: [],
    updatedShiftIds: [],
    updatedTableIds: [],
    updatedAuthorityIds: [],
    addedAuthorityIds: [],
    updatedPolicySections: [],
    changed: false,
  }
  const shiftWindow = state.shiftAssignments.find((shift) => (
    shift.businessDate === state.store.businessDate && shift.status === 'active'
  ))

  for (const roleId of PILOT_ROLE_IDS) {
    const referenceRole = reference.config.roles.find((role) => role.id === roleId)
    if (!referenceRole) throw new Error(`验证岗位模板缺少 ${roleId}`)
    const existingRole = state.config.roles.find((role) => role.id === roleId)
    if (!existingRole) {
      state.config.roles.push(structuredClone(referenceRole))
      result.addedRoleIds.push(roleId)
    } else if (existingRole.name !== referenceRole.name) {
      existingRole.name = referenceRole.name
      result.updatedRoleIds.push(roleId)
    }
  }

  for (const employeeId of PILOT_EMPLOYEE_IDS) {
    const referenceEmployee = reference.employees.find((employee) => employee.id === employeeId)
    const referenceShift = reference.shiftAssignments.find((shift) => shift.employeeId === employeeId)
    if (!referenceEmployee || !referenceShift) throw new Error(`验证名单模板缺少 ${employeeId}`)

    const existingEmployee = state.employees.find((employee) => employee.id === employeeId)
    if (!existingEmployee) {
      state.employees.push(structuredClone(referenceEmployee))
      result.addedEmployeeIds.push(employeeId)
    } else if (reconcileEmployee(existingEmployee, referenceEmployee)) {
      result.updatedEmployeeIds.push(employeeId)
    }

    const existingShift = state.shiftAssignments.find((shift) => (
      shift.employeeId === employeeId
      && shift.businessDate === state.store.businessDate
      && shift.status !== 'cancelled'
    ))
    if (existingShift) {
      if (reconcileShift(existingShift, referenceShift)) result.updatedShiftIds.push(existingShift.id)
      continue
    }

    const shiftId = state.shiftAssignments.some((shift) => shift.id === referenceShift.id)
      ? `${referenceShift.id}-${state.store.businessDate}`
      : referenceShift.id
    state.shiftAssignments.push({
      ...structuredClone(referenceShift),
      id: shiftId,
      businessDate: state.store.businessDate,
      startAt: shiftWindow?.startAt ?? referenceShift.startAt,
      endAt: shiftWindow?.endAt ?? referenceShift.endAt,
      status: 'active',
    })
    result.addedShiftIds.push(shiftId)
  }

  for (const referenceTable of reference.tables) {
    const table = state.tables.find((candidate) => candidate.id === referenceTable.id)
    if (!table) continue
    if (
      table.primaryEmployeeId === referenceTable.primaryEmployeeId
      && sameList(table.backupEmployeeIds, referenceTable.backupEmployeeIds)
    ) continue
    table.primaryEmployeeId = referenceTable.primaryEmployeeId
    table.backupEmployeeIds = [...referenceTable.backupEmployeeIds]
    result.updatedTableIds.push(table.id)
  }

  for (const referenceAuthority of reference.orderDomain.authorizationAuthorities) {
    const authority = state.orderDomain.authorizationAuthorities.find((candidate) => candidate.id === referenceAuthority.id)
    if (!authority) {
      if (referenceAuthority.id === 'operations-director-commerce-authority') {
        state.orderDomain.authorizationAuthorities.push(structuredClone(referenceAuthority))
        result.addedAuthorityIds.push(referenceAuthority.id)
      }
      continue
    }
    if (authority.actorId === referenceAuthority.actorId) continue
    authority.actorId = referenceAuthority.actorId
    result.updatedAuthorityIds.push(authority.id)
  }

  const referenceBenefitPolicy = reference.benefitGrantPolicies.find((policy) => policy.roleId === 'operations_director')
  if (!referenceBenefitPolicy) throw new Error('验证权益模板缺少运营负责人策略')
  const benefitPolicy = state.benefitGrantPolicies.find((policy) => policy.roleId === 'operations_director')
  if (!benefitPolicy) {
    state.benefitGrantPolicies.push(structuredClone(referenceBenefitPolicy))
    result.updatedPolicySections.push('benefit.operations_director')
  } else if (JSON.stringify(benefitPolicy) !== JSON.stringify(referenceBenefitPolicy)) {
    Object.assign(benefitPolicy, structuredClone(referenceBenefitPolicy))
    result.updatedPolicySections.push('benefit.operations_director')
  }

  const referenceInventory = reference.inventoryDomain
  const inventory = state.inventoryDomain
  if (!referenceInventory || !inventory) throw new Error('验证门店缺少库存策略')
  const inventoryPolicyKeys = Object.keys(referenceInventory.policy) as Array<keyof typeof referenceInventory.policy>
  let inventoryPolicyChanged = false
  for (const key of inventoryPolicyKeys) {
    const missingRoleIds = referenceInventory.policy[key].filter((roleId) => !inventory.policy[key].includes(roleId))
    if (missingRoleIds.length === 0) continue
    inventory.policy[key] = [...inventory.policy[key], ...missingRoleIds]
    inventoryPolicyChanged = true
  }
  if (inventoryPolicyChanged) result.updatedPolicySections.push('inventory.operations_director')

  const missingSongManagers = reference.songState.managerActorIds.filter((actorId) => !state.songState.managerActorIds.includes(actorId))
  if (missingSongManagers.length > 0) {
    state.songState.managerActorIds.push(...missingSongManagers)
    result.updatedPolicySections.push('song.manager_actors')
  }

  result.changed = result.addedRoleIds.length > 0
    || result.updatedRoleIds.length > 0
    || result.addedEmployeeIds.length > 0
    || result.updatedEmployeeIds.length > 0
    || result.addedShiftIds.length > 0
    || result.updatedShiftIds.length > 0
    || result.updatedTableIds.length > 0
    || result.addedAuthorityIds.length > 0
    || result.updatedAuthorityIds.length > 0
    || result.updatedPolicySections.length > 0
  if (!result.changed) return result

  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId: 'system-pilot-roster',
    action: 'pilot.staff_roster_reconciled.v1',
    objectType: 'store',
    objectId: state.store.id,
    occurredAt,
    details: {
      addedRoleIds: result.addedRoleIds,
      updatedRoleIds: result.updatedRoleIds,
      addedEmployeeIds: result.addedEmployeeIds,
      updatedEmployeeIds: result.updatedEmployeeIds,
      addedShiftIds: result.addedShiftIds,
      updatedShiftIds: result.updatedShiftIds,
      updatedTableIds: result.updatedTableIds,
      addedAuthorityIds: result.addedAuthorityIds,
      updatedAuthorityIds: result.updatedAuthorityIds,
      updatedPolicySections: result.updatedPolicySections,
    },
  })
  state.revision += 1
  return result
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  if (process.env.MBOX_CONFIRM_PILOT_STAFF !== 'ADD_MISSING_PILOT_STAFF') {
    throw new Error('同步验证员工必须设置MBOX_CONFIRM_PILOT_STAFF=ADD_MISSING_PILOT_STAFF')
  }
  const config = loadRuntimeConfig(process.env)
  const dependencies = createRuntimeDependencies(config)
  await dependencies.repository.init()
  try {
    const result = await dependencies.repository.mutate((state) => reconcilePilotStaff(state))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    await dependencies.repository.close()
  }
}
