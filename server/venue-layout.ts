import type { Employee, RuntimeState, Table } from '../src/shared/contracts.js'
import {
  MBOX_LEGACY_AREA_ID,
  MBOX_VENUE_LAYOUT_VERSION,
  mboxVenueAreas,
  mboxVenueTables,
  type VenueTableDefinition,
} from '../src/shared/venue-layout.js'

const migrationAction = 'runtime.mbox_venue_layout_v1_migrated.v1'
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

/**
 * Reconciles the venue-owned table catalogue without deleting operational data.
 * Existing tables keep their configured capacity and live state; only missing
 * venue tables are created from the floor-plan catalogue.
 */
export function applyMboxVenueLayout(state: RuntimeState) {
  if (state.store.id !== 'mbox-lujiazui') return

  for (const definition of mboxVenueAreas) {
    const existing = state.areas.find((area) => area.id === definition.id)
    if (existing) Object.assign(existing, definition)
    else state.areas.push(structuredClone(definition))
  }
  for (const definition of mboxVenueTables) reconcileTable(state, definition)

  for (const table of state.tables) {
    if (!legacyTableCodes.has(table.code)) continue
    table.areaId = MBOX_LEGACY_AREA_ID
    table.displayName = `${table.code}旧互动桌`
    if (table.status === 'available') table.status = 'paused'
  }
  reconcileEmployeeAreas(state)

  if (!state.auditEntries.some((entry) => entry.action === migrationAction)) {
    state.auditEntries.push({
      id: 'runtime-migration-mbox-venue-layout-v1',
      actorId: 'system',
      action: migrationAction,
      objectType: 'store',
      objectId: state.store.id,
      occurredAt: new Date().toISOString(),
      details: {
        layoutVersion: MBOX_VENUE_LAYOUT_VERSION,
        realTableCount: mboxVenueTables.length,
        duplicateLabelsCorrected: { secondW5: 'W06', secondW10: 'W11' },
        legacyTablesRetainedUntilIdle: [...legacyTableCodes],
      },
    })
  }
}
