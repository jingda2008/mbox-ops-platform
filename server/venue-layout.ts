import type { Employee, RuntimeState, Table } from '../src/shared/contracts.js'
import {
  MBOX_LEGACY_AREA_ID,
  MBOX_VENUE_LAYOUT_VERSION,
  mboxVenueAreas,
  mboxVenueTables,
  type VenueTableDefinition,
} from '../src/shared/venue-layout.js'

const migrationAction = 'runtime.mbox_venue_layout_v1_migrated.v1'
const legacyRetirementAction = 'runtime.legacy_simulation_tables_retired.v1'
const legacyTableCodes = new Set(['I01', 'I02', 'I03'])
const realAreaIds = mboxVenueAreas
  .filter((area) => area.id !== MBOX_LEGACY_AREA_ID)
  .map((area) => area.id)

const employeeAreaAssignments: Record<string, string[]> = {
  'emp-owner': realAreaIds,
  'emp-operations-director': realAreaIds,
  'emp-admin': realAreaIds,
  'emp-chen': realAreaIds,
  'emp-cashier': realAreaIds,
  'emp-jie': realAreaIds,
  'emp-qing': realAreaIds,
  'emp-mia': realAreaIds,
  'emp-lin': ['booth', 'lounge', 'main-a', 'special', 'walkin'],
  'emp-wu': ['main-b', 'main-c', 'social', 'special'],
  'emp-han': ['main-a', 'main-b', 'main-c', 'social'],
  'emp-tao': ['lounge', 'main-a', 'main-b', 'main-c', 'social'],
}

const primaryCandidates: Record<VenueTableDefinition['assignmentGroup'], string[]> = {
  vip: ['emp-lin', 'emp-jie', 'emp-chen'],
  lounge: ['emp-lin', 'emp-jie', 'emp-chen'],
  'main-a': ['emp-lin', 'emp-jie', 'emp-chen'],
  'main-b': ['emp-wu', 'emp-jie', 'emp-chen'],
  'main-c': ['emp-wu', 'emp-jie', 'emp-chen'],
  'stage-side': ['emp-jie', 'emp-wu', 'emp-chen'],
  special: ['emp-jie', 'emp-lin', 'emp-chen'],
  outside: ['emp-lin', 'emp-jie', 'emp-chen'],
}

function activeEmployee(state: RuntimeState, employeeId: string) {
  return state.employees.find((employee) => employee.id === employeeId && employee.status === 'active')
}

function fallbackEmployee(state: RuntimeState) {
  return state.employees.find((employee) => employee.status === 'active' && ['server', 'backup', 'manager'].includes(employee.roleId))
    ?? state.employees.find((employee) => employee.status === 'active')
}

function primaryEmployee(state: RuntimeState, definition: VenueTableDefinition) {
  return primaryCandidates[definition.assignmentGroup]
    .map((employeeId) => activeEmployee(state, employeeId))
    .find((employee): employee is Employee => Boolean(employee))
    ?? fallbackEmployee(state)
}

function backupEmployeeIds(state: RuntimeState, primaryEmployeeId: string) {
  const preferred = ['emp-jie', 'emp-chen', 'emp-lin', 'emp-wu']
    .filter((employeeId) => employeeId !== primaryEmployeeId && activeEmployee(state, employeeId))
  if (preferred.length > 0) return preferred.slice(0, 2)
  const fallback = state.employees.find(
    (employee) => employee.status === 'active' && employee.id !== primaryEmployeeId,
  )
  return fallback ? [fallback.id] : [primaryEmployeeId]
}

function createTable(state: RuntimeState, definition: VenueTableDefinition): Table | null {
  const primary = primaryEmployee(state, definition)
  if (!primary) return null
  return {
    id: definition.id,
    code: definition.code,
    displayName: definition.displayName,
    areaId: definition.areaId,
    capacity: definition.capacity,
    status: 'available',
    primaryEmployeeId: primary.id,
    backupEmployeeIds: backupEmployeeIds(state, primary.id),
    guestCount: 0,
    openedAt: null,
  }
}

function reconcileTable(state: RuntimeState, definition: VenueTableDefinition) {
  const existing = state.tables.find((table) => table.id === definition.id || table.code === definition.code)
  if (!existing) {
    const created = createTable(state, definition)
    if (created) state.tables.push(created)
    return
  }

  existing.id = definition.id
  existing.code = definition.code
  existing.areaId = definition.areaId
  if (!activeEmployee(state, existing.primaryEmployeeId)) {
    const primary = primaryEmployee(state, definition)
    if (primary) existing.primaryEmployeeId = primary.id
  }
  existing.backupEmployeeIds = existing.backupEmployeeIds.filter((employeeId) => activeEmployee(state, employeeId))
  if (existing.backupEmployeeIds.length === 0) {
    existing.backupEmployeeIds = backupEmployeeIds(state, existing.primaryEmployeeId)
  }
}

function reconcileEmployeeAreas(state: RuntimeState) {
  const upgradedAreas = new Map<string, string[]>()
  for (const employee of state.employees) {
    const assignment = employeeAreaAssignments[employee.id]
    if (!assignment) continue
    employee.areaIds = [...new Set([...employee.areaIds, ...assignment])]
    upgradedAreas.set(employee.id, employee.areaIds)
  }
  for (const shift of state.shiftAssignments) {
    const areaIds = upgradedAreas.get(shift.employeeId)
    if (areaIds) shift.areaIds = [...areaIds]
  }
}

function retireLegacySimulationTables(state: RuntimeState, occurredAt: string) {
  const legacyTables = state.tables.filter((table) => legacyTableCodes.has(table.code))
  if (legacyTables.length === 0 && !state.areas.some((area) => area.id === MBOX_LEGACY_AREA_ID)) return

  const legacyTableIds = new Set(legacyTables.map((table) => table.id))
  for (const session of state.songState.tableSessions) {
    if (!legacyTableIds.has(session.tableId) || session.status !== 'open') continue
    session.status = 'closed'
    session.closedAt = occurredAt
  }
  for (const intent of state.awaitingOrderIntents) {
    if (!legacyTableIds.has(intent.tableId) || intent.status !== 'active') continue
    intent.status = 'cancelled'
    intent.stoppedAt = occurredAt
    intent.stoppedBy = 'system'
    intent.stopReason = '旧模拟桌台已退役'
    intent.nextReminderAt = null
  }
  for (const task of state.tasks) {
    if (!legacyTableIds.has(task.tableId) || task.archivedAt) continue
    const previousStatus = task.status
    task.archivedAt = occurredAt
    task.archiveOutcome = ['completed', 'confirmed', 'cancelled'].includes(previousStatus) ? 'resolved' : 'unresolved'
    task.archivedFromStatus = previousStatus
    task.updatedAt = occurredAt
    if (!['completed', 'confirmed', 'cancelled'].includes(previousStatus)) task.status = 'cancelled'
    if (task.archiveOutcome === 'unresolved' && !task.resolution) task.resolution = '旧模拟桌台退役时需求未完成'
    state.taskEvents.push({
      id: `task-event-legacy-retirement-${task.id}`,
      taskId: task.id,
      type: 'task.archived_with_table_visit.v1',
      actorId: 'system',
      occurredAt,
      payload: {
        previousStatus,
        archiveOutcome: task.archiveOutcome,
        reason: 'legacy_simulation_table_retired',
      },
    })
  }

  state.tables = state.tables.filter((table) => !legacyTableIds.has(table.id))
  state.areas = state.areas.filter((area) => area.id !== MBOX_LEGACY_AREA_ID)
  for (const employee of state.employees) {
    employee.areaIds = employee.areaIds.filter((areaId) => areaId !== MBOX_LEGACY_AREA_ID)
  }
  for (const shift of state.shiftAssignments) {
    shift.areaIds = shift.areaIds.filter((areaId) => areaId !== MBOX_LEGACY_AREA_ID)
  }

  if (!state.auditEntries.some((entry) => entry.action === legacyRetirementAction)) {
    state.auditEntries.push({
      id: 'runtime-migration-legacy-simulation-tables-retired-v1',
      actorId: 'system',
      action: legacyRetirementAction,
      objectType: 'store',
      objectId: state.store.id,
      occurredAt,
      details: {
        removedTableCodes: legacyTables.map((table) => table.code),
        historicalSessionsRetained: true,
      },
    })
  }
}

/**
 * Reconciles the venue-owned table catalogue and retires the obsolete simulated
 * table catalogue. Historical sessions remain available for audit, while the
 * retired tables and area no longer appear in live operations.
 * Existing tables keep their configured capacity and live state; only missing
 * venue tables are created from the floor-plan catalogue.
 */
export function applyMboxVenueLayout(state: RuntimeState) {
  if (state.store.id !== 'mbox-lujiazui') return
  const occurredAt = new Date().toISOString()

  for (const definition of mboxVenueAreas) {
    const existing = state.areas.find((area) => area.id === definition.id)
    if (existing) Object.assign(existing, definition)
    else state.areas.push(structuredClone(definition))
  }
  for (const definition of mboxVenueTables) reconcileTable(state, definition)

  retireLegacySimulationTables(state, occurredAt)
  reconcileEmployeeAreas(state)

  if (!state.auditEntries.some((entry) => entry.action === migrationAction)) {
    state.auditEntries.push({
      id: 'runtime-migration-mbox-venue-layout-v1',
      actorId: 'system',
      action: migrationAction,
      objectType: 'store',
      objectId: state.store.id,
      occurredAt,
      details: {
        layoutVersion: MBOX_VENUE_LAYOUT_VERSION,
        realTableCount: mboxVenueTables.length,
        duplicateLabelsCorrected: { secondW5: 'W06', secondW10: 'W11' },
        legacyTablesRetired: [...legacyTableCodes],
      },
    })
  }
}
