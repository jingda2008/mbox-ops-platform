import type { RoleConfig, RuntimeState, StaffPermissionId, StoreConfig } from '../src/shared/contracts.js'
import { createSeedConfig } from './seed.js'
import { withDefaultRolePolicy } from '../src/shared/role-policy.js'

interface BuiltInRoleUpgrade {
  requiredPermissionIds: StaffPermissionId[]
  addedPermissionIds: StaffPermissionId[]
}

// Only upgrade a known built-in role when its legacy capability fingerprint is
// still present. A customized role with any prerequisite removed is left alone.
const builtInRoleUpgrades: Record<string, BuiltInRoleUpgrade> = {
  owner: {
    requiredPermissionIds: ['config.manage', 'identity.manage', 'reservation.manage', 'payment.refund.approve'],
    addedPermissionIds: ['reservation.view', 'reservation.config.manage', 'table.close', 'business_day.close'],
  },
  admin: {
    requiredPermissionIds: ['config.manage', 'identity.manage', 'master_data.manage'],
    addedPermissionIds: ['shift.manage', 'table.manage'],
  },
  manager: {
    requiredPermissionIds: ['shift.manage', 'table.manage', 'reservation.manage', 'payment.refund.approve'],
    addedPermissionIds: ['reservation.view', 'reservation.config.manage', 'table.close', 'business_day.close'],
  },
  supervisor: {
    requiredPermissionIds: ['shift.manage', 'table.manage', 'reservation.manage'],
    addedPermissionIds: ['reservation.view'],
  },
  cashier: {
    requiredPermissionIds: ['finance.view', 'payment.collect', 'payment.pos_report'],
    addedPermissionIds: ['reservation.view', 'table.close'],
  },
  host: {
    requiredPermissionIds: ['table.manage', 'reservation.manage'],
    addedPermissionIds: ['reservation.view'],
  },
}

const permissionPolicyMigrationAction = 'runtime.permission_policy_v2_migrated.v1'

function withBuiltInRoleUpgrade(role: RoleConfig): RoleConfig {
  const upgrade = builtInRoleUpgrades[role.id]
  if (!upgrade || !role.permissionIds) return role

  const permissions = new Set(role.permissionIds)
  if (!upgrade.requiredPermissionIds.every((permissionId) => permissions.has(permissionId))) return role
  for (const permissionId of upgrade.addedPermissionIds) permissions.add(permissionId)
  return { ...role, permissionIds: [...permissions] }
}

function migrateWorkstationDeliveryServices(config: StoreConfig): StoreConfig {
  const fulfillmentService = config.serviceTypes.find(
    (serviceType) => serviceType.id === 'fulfillment-delivery' && serviceType.code === 'FULFILLMENT_DELIVERY',
  ) ?? config.serviceTypes.find((serviceType) => serviceType.code === 'FULFILLMENT_DELIVERY')
  if (!fulfillmentService) return config

  return {
    ...config,
    workstations: config.workstations.map((workstation) => {
      if (!workstation.deliveryServiceTypeId) return workstation
      const referencedService = config.serviceTypes.find(
        (serviceType) => serviceType.id === workstation.deliveryServiceTypeId,
      )
      if (referencedService?.code === 'FULFILLMENT_DELIVERY') return workstation
      return { ...workstation, deliveryServiceTypeId: fulfillmentService.id }
    }),
  }
}

function configWithOperationalDefaults(
  config: StoreConfig,
  defaults: StoreConfig,
  upgradeBuiltInRoles: boolean,
): StoreConfig {
  const serviceTypeIds = new Set(config.serviceTypes.map((type) => type.id))
  const roleIds = new Set(config.roles.map((role) => role.id))
  const skillIds = new Set((config.skills ?? []).map((skill) => skill.id))
  const requiredServiceTypes = defaults.serviceTypes.filter(
    (type) => type.code === 'FULFILLMENT_DELIVERY' && !serviceTypeIds.has(type.id),
  )
  const enriched = {
    ...config,
    serviceTypes: [...config.serviceTypes, ...structuredClone(requiredServiceTypes)],
    roles: [
      ...config.roles.map(withDefaultRolePolicy).map((role) => (
        upgradeBuiltInRoles ? withBuiltInRoleUpgrade(role) : role
      )),
      ...structuredClone(defaults.roles.filter((role) => !roleIds.has(role.id))),
    ],
    skills: [...(config.skills ?? []), ...structuredClone(defaults.skills.filter((skill) => !skillIds.has(skill.id)))],
    workstations: config.workstations ?? structuredClone(defaults.workstations),
    proactiveOrderCare: config.proactiveOrderCare ?? structuredClone(defaults.proactiveOrderCare),
  }
  return migrateWorkstationDeliveryServices(enriched)
}

function migratedTableSessionId(state: RuntimeState, tableId: string) {
  const base = `session:${tableId}:${state.store.businessDate}:migrated`
  const existingIds = new Set(state.songState.tableSessions.map((session) => session.id))
  if (!existingIds.has(base)) return base
  let suffix = 2
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

function migrateMissingOpenTableSessions(state: RuntimeState) {
  for (const table of state.tables) {
    if (table.status !== 'occupied') continue
    const hasOpenSession = state.songState.tableSessions.some(
      (session) => session.tableId === table.id && session.status === 'open',
    )
    if (hasOpenSession) continue
    state.songState.tableSessions.push({
      id: migratedTableSessionId(state, table.id),
      tableId: table.id,
      tableCode: table.code,
      status: 'open',
      openedAt: table.openedAt ?? `${state.store.businessDate}T00:00:00+08:00`,
      closedAt: null,
    })
  }
}

/** Enriches older persisted documents without discarding store-specific state. */
export function migrateRuntimeState(state: RuntimeState): RuntimeState {
  const defaults = createSeedConfig()
  const migrated = structuredClone(state)
  const upgradeBuiltInRoles = !migrated.auditEntries.some(
    (entry) => entry.action === permissionPolicyMigrationAction,
  )

  migrated.config = configWithOperationalDefaults(migrated.config, defaults, upgradeBuiltInRoles)
  migrated.draftConfig = migrated.draftConfig
    ? configWithOperationalDefaults(migrated.draftConfig, defaults, upgradeBuiltInRoles)
    : null
  migrated.configVersions = (migrated.configVersions ?? []).map((record) => ({
    ...record,
    snapshot: configWithOperationalDefaults(record.snapshot, defaults, upgradeBuiltInRoles),
  }))
  migrated.employees = migrated.employees.map((employee) => ({
    ...employee,
    skillIds: employee.skillIds ?? [],
  }))
  migrated.shiftAssignments = migrated.shiftAssignments.map((assignment) => ({
    ...assignment,
    stationIds: assignment.stationIds ?? [],
  }))
  migrated.tableTransfers ??= []
  migrated.waitlistEntries ??= []
  if (migrated.reservationState) {
    migrated.reservationState.config.lateHoldMinutes ??= 30
    migrated.reservationState.config.waitlistResponseMinutes ??= 10
    migrated.reservationState.reservations = migrated.reservationState.reservations.map((reservation) => ({
      ...reservation,
      expectedArrivalAt: reservation.expectedArrivalAt ?? null,
      lateContactReference: reservation.lateContactReference ?? null,
      holdStatus: reservation.holdStatus ?? 'none',
      holdUntil: reservation.holdUntil ?? null,
      holdDecidedBy: reservation.holdDecidedBy ?? null,
      holdDecidedAt: reservation.holdDecidedAt ?? null,
      holdReason: reservation.holdReason ?? null,
    }))
  }
  migrateMissingOpenTableSessions(migrated)
  if (upgradeBuiltInRoles) {
    migrated.auditEntries.push({
      id: 'runtime-migration-permission-policy-v2',
      actorId: 'system',
      action: permissionPolicyMigrationAction,
      objectType: 'store',
      objectId: migrated.store.id,
      occurredAt: `${migrated.store.businessDate}T00:00:00+08:00`,
      details: { strategy: 'built-in-role-capability-fingerprint' },
    })
  }

  return migrated
}
