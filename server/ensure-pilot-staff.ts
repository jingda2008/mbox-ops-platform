import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Employee, RuntimeState, ShiftAssignment } from '../src/shared/contracts.js'
import { createRuntimeDependencies } from './repository-factory.js'
import { loadRuntimeConfig } from './runtime-config.js'
import { createSeedState } from './seed.js'

export const PILOT_EMPLOYEE_IDS = [
  'emp-owner',
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

function sameList(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
}

function reconcileEmployee(existing: Employee, reference: Employee) {
  const changed = existing.status !== 'active'
    || existing.roleId !== reference.roleId
    || !sameList(existing.areaIds, reference.areaIds)
    || !sameList(existing.skillIds, reference.skillIds)
  if (!changed) return false
  existing.status = 'active'
  existing.roleId = reference.roleId
  existing.areaIds = [...reference.areaIds]
  existing.skillIds = [...(reference.skillIds ?? [])]
  return true
}

function reconcileShift(existing: ShiftAssignment, reference: ShiftAssignment) {
  const changed = existing.roleId !== reference.roleId
    || !sameList(existing.areaIds, reference.areaIds)
    || !sameList(existing.stationIds, reference.stationIds)
  if (!changed) return false
  existing.roleId = reference.roleId
  existing.areaIds = [...reference.areaIds]
  existing.stationIds = [...(reference.stationIds ?? [])]
  return true
}

export interface PilotStaffReconciliationResult {
  addedEmployeeIds: string[]
  updatedEmployeeIds: string[]
  addedShiftIds: string[]
  updatedShiftIds: string[]
  changed: boolean
}

export function reconcilePilotStaff(
  state: RuntimeState,
  reference: RuntimeState = createSeedState(),
  occurredAt = new Date().toISOString(),
): PilotStaffReconciliationResult {
  const result: PilotStaffReconciliationResult = {
    addedEmployeeIds: [],
    updatedEmployeeIds: [],
    addedShiftIds: [],
    updatedShiftIds: [],
    changed: false,
  }
  const shiftWindow = state.shiftAssignments.find((shift) => (
    shift.businessDate === state.store.businessDate && shift.status === 'active'
  ))

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

  result.changed = result.addedEmployeeIds.length > 0
    || result.updatedEmployeeIds.length > 0
    || result.addedShiftIds.length > 0
    || result.updatedShiftIds.length > 0
  if (!result.changed) return result

  state.auditEntries.push({
    id: `audit_${randomUUID()}`,
    actorId: 'system-pilot-roster',
    action: 'pilot.staff_roster_reconciled.v1',
    objectType: 'store',
    objectId: state.store.id,
    occurredAt,
    details: {
      addedEmployeeIds: result.addedEmployeeIds,
      updatedEmployeeIds: result.updatedEmployeeIds,
      addedShiftIds: result.addedShiftIds,
      updatedShiftIds: result.updatedShiftIds,
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
