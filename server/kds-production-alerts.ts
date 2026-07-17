import type { RuntimeState } from '../src/shared/contracts.js'
import { effectiveRoleIdsForEmployee } from '../src/shared/staff-access.js'
import { createServiceTask } from './domain.js'
import { normalizeOrderFulfillmentState, resolveKdsWorkstation } from './fulfillment-workstations.js'

const triggerPrefix = 'kds-production-delay:'

function tableForSession(state: RuntimeState, tableSessionId: string) {
  const session = state.songState.tableSessions.find((item) => item.id === tableSessionId)
  if (session) return state.tables.find((table) => table.id === session.tableId)
  return state.tables.find((table) => tableSessionId === table.id || tableSessionId.startsWith(`session:${table.id}:`))
}

function stationRoleIds(state: RuntimeState, stationId: string, productionRoleIds: string[]) {
  const stationWorkers = state.employees.filter((employee) => {
    const shift = state.shiftAssignments.find((item) => (
      item.employeeId === employee.id
      && item.businessDate === state.store.businessDate
      && item.status === 'active'
    ))
    return (!shift?.stationIds?.length || shift.stationIds.includes(stationId))
      && effectiveRoleIdsForEmployee(state, employee.id).some((roleId) => productionRoleIds.includes(roleId))
  })
  const workerRoles = stationWorkers.flatMap((employee) => effectiveRoleIdsForEmployee(state, employee.id))
    .filter((roleId) => productionRoleIds.includes(roleId))
  return [...new Set([...workerRoles, 'supervisor', 'manager'])]
}

/** Creates one normal service-task escalation for each KDS item that exceeds its production SLA. */
export function processOverdueProductionTasks(state: RuntimeState, now = new Date()) {
  normalizeOrderFulfillmentState(state.orderDomain)
  let created = 0
  for (const kdsTask of state.orderDomain.kdsTasks) {
    if (!['queued', 'preparing'].includes(kdsTask.status) || !kdsTask.productionSla?.dueAt) continue
    if (Date.parse(kdsTask.productionSla.dueAt) > now.getTime()) continue
    const triggerId = `${triggerPrefix}${kdsTask.id}`
    if (state.tasks.some((task) => task.triggerId === triggerId)) continue
    const table = tableForSession(state, kdsTask.tableSessionId)
    if (!table || table.status !== 'occupied') continue
    const workstation = resolveKdsWorkstation(state.orderDomain, kdsTask)
    const overdueMinutes = Math.max(1, Math.ceil((now.getTime() - Date.parse(kdsTask.productionSla.dueAt)) / 60_000))
    createServiceTask(state, {
      tableCode: table.code,
      serviceTypeId: 'kds-production-delay',
      source: 'system',
      note: `${workstation.name} · ${kdsTask.itemName}×${kdsTask.quantity} 已超过制作时限${overdueMinutes}分钟`,
      idempotencyKey: triggerId,
      triggerId,
      requestedBy: 'system',
      dispatchRoleIds: stationRoleIds(state, workstation.id, workstation.productionRoleIds),
    })
    created += 1
  }
  return created
}
