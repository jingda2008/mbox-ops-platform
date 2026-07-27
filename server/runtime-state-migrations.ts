import type { RoleConfig, RuntimeState, StaffPermissionId, StoreConfig } from '../src/shared/contracts.js'
import { createSeedConfig } from './seed.js'
import { withDefaultRolePolicy } from '../src/shared/role-policy.js'
import { reconcilePresence } from './presence.js'
import { CHINA_TIME_ZONE } from '../src/shared/china-time.js'
import { normalizeCommercialOpsState } from './commercial-ops.js'
import { normalizeReservationConfig } from './reservation-domain.js'
import { normalizeHardwareState } from './hardware-domain.js'
import { fulfillmentServiceTaskId } from './fulfillment-service.js'
import { normalizeMenuProductConfiguration } from '../src/shared/menu-recommendation.js'
import { applyMenuCatalogMigration } from './menu-catalog-migration.js'

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
const frontlineTableOperationsMigrationAction = 'runtime.frontline_table_operations_v1_migrated.v1'
const chinaTimezoneMigrationAction = 'runtime.china_timezone_normalized.v1'
const workstationProductionRoleMigrationAction = 'runtime.workstation_production_roles_v1_migrated.v1'
const hardwarePermissionMigrationAction = 'runtime.hardware_permissions_v1_migrated.v1'
const financeCostPermissionMigrationAction = 'runtime.finance_cost_permissions_v1_migrated.v1'
const fulfillmentTaskIdMigrationAction = 'runtime.fulfillment_task_ids_v1_migrated.v1'

const hardwareRoleUpgrades: Record<string, BuiltInRoleUpgrade> = {
  owner: {
    requiredPermissionIds: ['config.manage', 'audit.view', 'master_data.manage'],
    addedPermissionIds: ['hardware.view', 'hardware.operate', 'hardware.manage'],
  },
  operations_director: {
    requiredPermissionIds: ['config.manage', 'audit.view', 'master_data.manage'],
    addedPermissionIds: ['hardware.view', 'hardware.operate', 'hardware.manage'],
  },
  admin: {
    requiredPermissionIds: ['config.manage', 'identity.manage', 'master_data.manage'],
    addedPermissionIds: ['hardware.view', 'hardware.operate', 'hardware.manage'],
  },
  manager: {
    requiredPermissionIds: ['shift.manage', 'table.manage', 'audit.view'],
    addedPermissionIds: ['hardware.view', 'hardware.operate'],
  },
  technical: {
    requiredPermissionIds: ['dashboard.view', 'song.view'],
    addedPermissionIds: ['hardware.view', 'hardware.operate'],
  },
}

const financeCostRoleUpgrades: Record<string, BuiltInRoleUpgrade> = {
  owner: {
    requiredPermissionIds: ['finance.view', 'config.manage', 'payment.refund.approve'],
    addedPermissionIds: ['finance.manage'],
  },
  operations_director: {
    requiredPermissionIds: ['finance.view', 'config.manage', 'payment.refund.approve'],
    addedPermissionIds: ['finance.manage'],
  },
  manager: {
    requiredPermissionIds: ['finance.view', 'shift.manage', 'payment.refund.approve'],
    addedPermissionIds: ['finance.manage'],
  },
}

const legacyWorkstationProductionRoles = new Map<string, string[]>([
  ['bar-main', ['bartender', 'specialist', 'supervisor', 'manager']],
  ['kitchen-cold', ['kitchen', 'specialist', 'supervisor', 'manager']],
  ['kitchen-hot', ['kitchen', 'specialist', 'supervisor', 'manager']],
])

const frontlineTableOperationUpgrades: Record<string, BuiltInRoleUpgrade> = {
  owner: {
    requiredPermissionIds: ['config.manage', 'table.manage', 'table.close'],
    addedPermissionIds: ['table.open'],
  },
  operations_director: {
    requiredPermissionIds: ['config.manage', 'table.manage', 'table.close'],
    addedPermissionIds: ['table.open'],
  },
  manager: {
    requiredPermissionIds: ['shift.manage', 'table.manage', 'table.close'],
    addedPermissionIds: ['table.open'],
  },
  supervisor: {
    requiredPermissionIds: ['service.execute', 'table.manage', 'reservation.manage'],
    addedPermissionIds: ['table.open', 'table.close'],
  },
  server: {
    requiredPermissionIds: ['service.execute', 'order.create', 'kds.deliver'],
    addedPermissionIds: ['table.open', 'table.manage', 'table.close'],
  },
  backup: {
    requiredPermissionIds: ['service.execute', 'order.create', 'kds.deliver'],
    addedPermissionIds: ['table.open', 'table.manage', 'table.close'],
  },
  specialist: {
    requiredPermissionIds: ['service.execute', 'order.create', 'song.view'],
    addedPermissionIds: ['table.open', 'table.manage', 'table.close'],
  },
  host: {
    requiredPermissionIds: ['table.manage', 'reservation.manage'],
    addedPermissionIds: ['table.open'],
  },
}

const legacyGuestRepliesByCode = new Map<string, string>([
  ['ADD_WATER', '已收到，{employee}正在为您处理。'],
  ['ADD_ICE_LEMON', '已收到，{employee}马上为您准备。'],
  ['ORDER_HELP', '已收到，{employee}会到桌协助您点单。'],
  ['REQUEST_BILL', '买单请求已收到，{employee}正在核对您的桌账。'],
  ['COMPLAINT', '您的反馈已由值班领班接管，我们会尽快到桌处理。'],
  ['BIRTHDAY_CARE', '生日安排已收到，服务专员会与您确认细节。'],
  ['CUSTOM_REQUEST', '您的个性化需求已收到，{employee}正在为您处理。'],
  ['FULFILLMENT_DELIVERY', '出品已完成，服务人员正在取送。'],
])

function withBuiltInRoleUpgrade(role: RoleConfig): RoleConfig {
  const upgrade = builtInRoleUpgrades[role.id]
  if (!upgrade || !role.permissionIds) return role

  const permissions = new Set(role.permissionIds)
  if (!upgrade.requiredPermissionIds.every((permissionId) => permissions.has(permissionId))) return role
  for (const permissionId of upgrade.addedPermissionIds) permissions.add(permissionId)
  return { ...role, permissionIds: [...permissions] }
}

function withFrontlineTableOperationUpgrade(role: RoleConfig): RoleConfig {
  const upgrade = frontlineTableOperationUpgrades[role.id]
  if (!upgrade || !role.permissionIds) return role

  const permissions = new Set(role.permissionIds)
  if (!upgrade.requiredPermissionIds.every((permissionId) => permissions.has(permissionId))) return role
  for (const permissionId of upgrade.addedPermissionIds) permissions.add(permissionId)
  return { ...role, permissionIds: [...permissions] }
}

function withHardwarePermissionUpgrade(role: RoleConfig): RoleConfig {
  const upgrade = hardwareRoleUpgrades[role.id]
  if (!upgrade || !role.permissionIds) return role
  const permissions = new Set(role.permissionIds)
  if (!upgrade.requiredPermissionIds.every((permissionId) => permissions.has(permissionId))) return role
  for (const permissionId of upgrade.addedPermissionIds) permissions.add(permissionId)
  return { ...role, permissionIds: [...permissions] }
}

function migrateHardwarePermissions(config: StoreConfig): StoreConfig {
  return { ...config, roles: config.roles.map(withHardwarePermissionUpgrade) }
}

function withFinanceCostPermissionUpgrade(role: RoleConfig): RoleConfig {
  const upgrade = financeCostRoleUpgrades[role.id]
  if (!upgrade || !role.permissionIds) return role
  const permissions = new Set(role.permissionIds)
  if (!upgrade.requiredPermissionIds.every((permissionId) => permissions.has(permissionId))) return role
  for (const permissionId of upgrade.addedPermissionIds) permissions.add(permissionId)
  return { ...role, permissionIds: [...permissions] }
}

function migrateFinanceCostPermissions(config: StoreConfig): StoreConfig {
  return { ...config, roles: config.roles.map(withFinanceCostPermissionUpgrade) }
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

function migrateLegacyWorkstationProductionRoles(config: StoreConfig): StoreConfig {
  return {
    ...config,
    workstations: config.workstations.map((workstation) => {
      const legacyRoles = legacyWorkstationProductionRoles.get(workstation.id)
      if (!legacyRoles || legacyRoles.length !== workstation.productionRoleIds.length) return workstation
      if (!legacyRoles.every((roleId, index) => workstation.productionRoleIds[index] === roleId)) return workstation
      return {
        ...workstation,
        productionRoleIds: [workstation.id === 'bar-main' ? 'bartender' : 'kitchen'],
      }
    }),
  }
}

function configWithOperationalDefaults(
  config: StoreConfig,
  defaults: StoreConfig,
  upgradeBuiltInRoles: boolean,
  upgradeFrontlineTableOperations: boolean,
): StoreConfig {
  const serviceTypeIds = new Set(config.serviceTypes.map((type) => type.id))
  const roleIds = new Set(config.roles.map((role) => role.id))
  const skillIds = new Set((config.skills ?? []).map((skill) => skill.id))
  const communityBrand = structuredClone(config.communityBrand ?? defaults.communityBrand)
  if (communityBrand.eyebrow === 'M-BOX MEMBER COMMUNITY') {
    communityBrand.eyebrow = defaults.communityBrand.eyebrow
  }
  if (communityBrand.tagline === '由 M-Box 相识，在超嗨部落持续相聚') {
    communityBrand.tagline = defaults.communityBrand.tagline
  }
  const requiredServiceTypes = defaults.serviceTypes.filter(
    (type) => ['FULFILLMENT_DELIVERY', 'CUSTOM_REQUEST', 'KDS_PRODUCTION_DELAY'].includes(type.code) && !serviceTypeIds.has(type.id),
  )
  const defaultServiceTypes = new Map(defaults.serviceTypes.map((serviceType) => [serviceType.code, serviceType]))
  const enriched = {
    ...config,
    serviceTypes: [
      ...config.serviceTypes.map((serviceType) => {
        const legacyReply = legacyGuestRepliesByCode.get(serviceType.code)
        const defaultServiceType = defaultServiceTypes.get(serviceType.code)
        if (!legacyReply || !defaultServiceType || serviceType.customerReply !== legacyReply) return serviceType
        return { ...serviceType, customerReply: defaultServiceType.customerReply }
      }),
      ...structuredClone(requiredServiceTypes),
    ],
    roles: [
      ...config.roles.map(withDefaultRolePolicy).map((role) => (
        upgradeBuiltInRoles ? withBuiltInRoleUpgrade(role) : role
      )).map((role) => (
        upgradeFrontlineTableOperations ? withFrontlineTableOperationUpgrade(role) : role
      )),
      ...structuredClone(defaults.roles.filter((role) => !roleIds.has(role.id))),
    ],
    skills: [...(config.skills ?? []), ...structuredClone(defaults.skills.filter((skill) => !skillIds.has(skill.id)))],
    workstations: config.workstations ?? structuredClone(defaults.workstations),
    proactiveOrderCare: config.proactiveOrderCare ?? structuredClone(defaults.proactiveOrderCare),
    guestServiceLimits: config.guestServiceLimits ?? structuredClone(defaults.guestServiceLimits),
    communityBrand,
    assistantCapabilities: structuredClone(config.assistantCapabilities ?? defaults.assistantCapabilities ?? []),
    sopRules: structuredClone(config.sopRules ?? defaults.sopRules ?? []),
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

function migrateServiceTaskVisits(state: RuntimeState) {
  const liveStatuses = new Set(['pending', 'accepted', 'arrived', 'reopened', 'escalated'])
  state.tasks = state.tasks.map((task) => {
    const createdAt = Date.parse(task.createdAt)
    const matchingSession = state.songState.tableSessions
      .filter((session) => session.tableId === task.tableId)
      .filter((session) => {
        const openedAt = Date.parse(session.openedAt)
        const closedAt = session.closedAt ? Date.parse(session.closedAt) : Number.POSITIVE_INFINITY
        return openedAt <= createdAt && createdAt <= closedAt
      })
      .toSorted((left, right) => Date.parse(right.openedAt) - Date.parse(left.openedAt))[0] ?? null
    const session = task.tableSessionId
      ? state.songState.tableSessions.find((candidate) => candidate.id === task.tableSessionId) ?? matchingSession
      : matchingSession
    const table = state.tables.find((candidate) => candidate.id === task.tableId)
    const shouldArchive = Boolean(task.archivedAt || session?.closedAt || (!session && table?.status !== 'occupied'))
    const previousStatus = task.archivedFromStatus ?? (shouldArchive ? task.status : null)
    const archiveOutcome = task.archiveOutcome ?? (shouldArchive
      ? ['completed', 'confirmed', 'cancelled'].includes(previousStatus ?? '') ? 'resolved' : 'unresolved'
      : null)
    return {
      ...task,
      tableSessionId: task.tableSessionId ?? session?.id ?? null,
      archivedAt: task.archivedAt ?? (shouldArchive ? session?.closedAt ?? task.updatedAt : null),
      archiveOutcome,
      archivedFromStatus: previousStatus,
      status: shouldArchive && liveStatuses.has(task.status) ? 'cancelled' as const : task.status,
      resolution: task.resolution ?? (archiveOutcome === 'unresolved' ? '桌次结束时需求仍未完成' : null),
    }
  })
}

function migrateFulfillmentTaskIds(state: RuntimeState) {
  let migratedCount = 0
  for (const kdsTask of state.orderDomain.kdsTasks) {
    const expectedTriggerId = `fulfillment-delivery:${kdsTask.id}`
    const serviceTask = state.tasks.find((task) => task.id === kdsTask.deliveryServiceTask?.id)
      ?? state.tasks.find((task) => task.triggerId === expectedTriggerId)
    if (!serviceTask || serviceTask.triggerId !== expectedTriggerId) continue

    const previousId = serviceTask.id
    const nextId = fulfillmentServiceTaskId(kdsTask.id)
    const collision = state.tasks.find((task) => task.id === nextId && task !== serviceTask)
    if (collision) {
      if (collision.triggerId !== expectedTriggerId) continue
      kdsTask.deliveryServiceTask = {
        id: collision.id,
        status: collision.status,
        ownerId: collision.ownerId,
        createdAt: collision.createdAt,
      }
      continue
    }
    if (previousId !== nextId) {
      serviceTask.id = nextId
      for (const event of state.taskEvents) {
        if (event.taskId === previousId) event.taskId = nextId
      }
      for (const audit of state.auditEntries) {
        if (audit.objectType === 'serviceTask' && audit.objectId === previousId) audit.objectId = nextId
      }
      migratedCount += 1
    }
    kdsTask.deliveryServiceTask = {
      id: serviceTask.id,
      status: serviceTask.status,
      ownerId: serviceTask.ownerId,
      createdAt: serviceTask.createdAt,
    }
  }

  if (migratedCount > 0 && !state.auditEntries.some((entry) => entry.action === fulfillmentTaskIdMigrationAction)) {
    state.auditEntries.push({
      id: 'runtime-migration-fulfillment-task-ids-v1',
      actorId: 'system',
      action: fulfillmentTaskIdMigrationAction,
      objectType: 'store',
      objectId: state.store.id,
      occurredAt: new Date().toISOString(),
      details: { migratedCount, strategy: 'sha256-prefix-32' },
    })
  }
}

/** Enriches older persisted documents without discarding store-specific state. */
export function migrateRuntimeState(state: RuntimeState): RuntimeState {
  const defaults = createSeedConfig()
  const migrated = structuredClone(state)
  const normalizeChinaTimezone = migrated.store.timezone !== CHINA_TIME_ZONE
    || (migrated.reservationState?.config.businessHours?.timeZone !== undefined
      && migrated.reservationState.config.businessHours.timeZone !== CHINA_TIME_ZONE)
  migrated.store.timezone = CHINA_TIME_ZONE
  migrated.tableSessionOperations = (migrated.tableSessionOperations ?? []).map((operation) => {
    if (operation.guestCount !== undefined) return operation
    const session = migrated.songState.tableSessions.find((item) => item.id === operation.tableSessionId)
    const audit = migrated.auditEntries.findLast((entry) => (
      entry.details.tableSessionId === operation.tableSessionId
      && typeof entry.details.guestCount === 'number'
    ))
    const sourcePartySize = operation.source === 'reservation' || operation.source === 'walk_in'
      ? migrated.reservationState?.reservations.find((item) => item.id === operation.sourceId)?.partySize
      : operation.source === 'waitlist'
        ? migrated.waitlistEntries.find((item) => item.id === operation.sourceId)?.partySize
        : operation.source === 'added_table' ? 0 : undefined
    const openTablePartySize = session?.status === 'open'
      ? migrated.tables.find((item) => item.id === session.tableId)?.guestCount
      : undefined
    const guestCount = sourcePartySize
      ?? (typeof audit?.details.guestCount === 'number' ? audit.details.guestCount : undefined)
      ?? openTablePartySize
    return guestCount === undefined ? operation : { ...operation, guestCount }
  })
  migrated.commercialOps = normalizeCommercialOpsState(migrated.commercialOps)
  migrated.hardwareState = normalizeHardwareState(migrated.hardwareState)
  migrated.sopExecutions ??= []
  migrated.sopActionRecords = (migrated.sopActionRecords ?? []).map((record) => ({
    ...record,
    nextAttemptAt: record.nextAttemptAt ?? (record.status === 'queued' ? record.requestedAt : null),
    leaseOwner: record.leaseOwner ?? null,
    leaseExpiresAt: record.leaseExpiresAt ?? null,
  }))
  migrated.sopExecutions = migrated.sopExecutions.map((execution) => ({
    ...execution,
    steps: execution.steps.map((step) => ({
      ...step,
      actionRecordIds: step.actionRecordIds ?? [],
      reason: step.reason ?? null,
      failureHandledAt: step.failureHandledAt ?? null,
    })),
  }))
  migrated.dutyManagerIncidents = (migrated.dutyManagerIncidents ?? []).map((incident) => ({
    ...incident,
    cycle: incident.cycle ?? 1,
    observationCount: incident.observationCount ?? 1,
    acknowledgedAt: incident.acknowledgedAt ?? null,
    acknowledgedBy: incident.acknowledgedBy ?? null,
    deferredAt: incident.deferredAt ?? null,
    deferredBy: incident.deferredBy ?? null,
    deferredUntil: incident.deferredUntil ?? null,
    dismissedAt: incident.dismissedAt ?? null,
    dismissedBy: incident.dismissedBy ?? null,
    dismissedReason: incident.dismissedReason ?? null,
    resolvedAt: incident.resolvedAt ?? null,
    resolvedBy: incident.resolvedBy ?? null,
    resolution: incident.resolution ?? null,
  }))
  const upgradeBuiltInRoles = !migrated.auditEntries.some(
    (entry) => entry.action === permissionPolicyMigrationAction,
  )
  const upgradeFrontlineTableOperations = !migrated.auditEntries.some(
    (entry) => entry.action === frontlineTableOperationsMigrationAction,
  )
  const upgradeWorkstationProductionRoles = !migrated.auditEntries.some(
    (entry) => entry.action === workstationProductionRoleMigrationAction,
  )
  const upgradeHardwarePermissions = !migrated.auditEntries.some(
    (entry) => entry.action === hardwarePermissionMigrationAction,
  )
  const upgradeFinanceCostPermissions = !migrated.auditEntries.some(
    (entry) => entry.action === financeCostPermissionMigrationAction,
  )

  migrated.config = configWithOperationalDefaults(migrated.config, defaults, upgradeBuiltInRoles, upgradeFrontlineTableOperations)
  if (upgradeHardwarePermissions) migrated.config = migrateHardwarePermissions(migrated.config)
  if (upgradeFinanceCostPermissions) migrated.config = migrateFinanceCostPermissions(migrated.config)
  if (upgradeWorkstationProductionRoles) migrated.config = migrateLegacyWorkstationProductionRoles(migrated.config)
  migrated.draftConfig = migrated.draftConfig
    ? configWithOperationalDefaults(migrated.draftConfig, defaults, upgradeBuiltInRoles, upgradeFrontlineTableOperations)
    : null
  if (upgradeWorkstationProductionRoles && migrated.draftConfig) {
    migrated.draftConfig = migrateLegacyWorkstationProductionRoles(migrated.draftConfig)
  }
  if (upgradeHardwarePermissions && migrated.draftConfig) migrated.draftConfig = migrateHardwarePermissions(migrated.draftConfig)
  if (upgradeFinanceCostPermissions && migrated.draftConfig) migrated.draftConfig = migrateFinanceCostPermissions(migrated.draftConfig)
  migrated.configVersions = (migrated.configVersions ?? []).map((record) => {
    let snapshot = configWithOperationalDefaults(
      record.snapshot,
      defaults,
      upgradeBuiltInRoles,
      upgradeFrontlineTableOperations,
    )
    if (upgradeHardwarePermissions) snapshot = migrateHardwarePermissions(snapshot)
    if (upgradeFinanceCostPermissions) snapshot = migrateFinanceCostPermissions(snapshot)
    return { ...record, snapshot }
  })
  migrated.employees = migrated.employees.map((employee) => ({
    ...employee,
    roleIds: [...new Set(employee.roleIds ?? [])].filter((roleId) => roleId !== employee.roleId),
    permissionIds: employee.permissionIds ?? [],
    skillIds: employee.skillIds ?? [],
  }))
  migrated.shiftAssignments = migrated.shiftAssignments.map((assignment) => ({
    ...assignment,
    roleIds: [...new Set(assignment.roleIds ?? [])].filter((roleId) => roleId !== assignment.roleId),
    stationIds: assignment.stationIds ?? [],
  }))
  migrated.songState.requests = migrated.songState.requests.map((request) => ({
    ...request,
    requestMode: request.requestMode ?? 'standard',
    scheduleVersion: request.scheduleVersion ?? 1,
    confirmedBy: request.confirmedBy ?? (request.status === 'pending_confirmation' ? null : 'legacy-system'),
    confirmedAt: request.confirmedAt ?? (request.status === 'pending_confirmation' ? null : request.createdAt),
    payment: request.payment
      ? { ...request.payment, collectionChannel: request.payment.collectionChannel ?? 'physical_pos' }
      : null,
  }))
  migrated.songState.performanceSessions = migrated.songState.performanceSessions.map((session) => ({
    ...session,
    configVersion: session.configVersion ?? 1,
    appearances: session.appearances.map((appearance) => ({
      ...appearance,
      advanceBookingEnabled: appearance.advanceBookingEnabled ?? true,
      extensionNegotiationEnabled: appearance.extensionNegotiationEnabled ?? true,
      extensionThresholdMinutes: appearance.extensionThresholdMinutes ?? 10,
    })),
  }))
  reconcilePresence(migrated, Date.now(), false)
  const menuDefaults = new Map([
    ['product-cocktail', { categoryId: 'drinks', categoryName: '酒水', description: '柑橘香气与清爽气泡，现场现调。', imageUrl: '/menu/cocktail.jpg', tags: ['招牌', '现调'], sortOrder: 1 }],
    ['product-beer', { categoryId: 'drinks', categoryName: '酒水', description: '冰镇精酿，入口清爽，适合分享。', imageUrl: '/menu/beer.jpg', tags: ['冰镇'], sortOrder: 2 }],
    ['product-fruit', { categoryId: 'food', categoryName: '餐食', description: '当日鲜切水果，适合多人分享。', imageUrl: '/menu/fruit.jpg', tags: ['鲜切'], sortOrder: 3 }],
    ['product-snack', { categoryId: 'food', categoryName: '餐食', description: '热制下酒小食组合，出品约八分钟。', imageUrl: '/menu/snack.jpg', tags: ['热食'], sortOrder: 4 }],
  ])
  applyMenuCatalogMigration(migrated)
  migrated.products = migrated.products.map((product) => normalizeMenuProductConfiguration({
    soldOut: false,
    soldOutReason: '',
    availableFrom: null,
    availableUntil: null,
    ...(menuDefaults.get(product.id) ?? { categoryId: 'featured', categoryName: '推荐', description: '', imageUrl: '', tags: [], sortOrder: 99 }),
    ...product,
  }))
  migrated.tableTransfers ??= []
  migrated.waitlistEntries ??= []
  if (migrated.reservationState) {
    migrated.reservationState.config = normalizeReservationConfig(migrated.reservationState.config)
    migrated.reservationState.config.lateHoldMinutes ??= 30
    migrated.reservationState.config.waitlistResponseMinutes ??= 10
    migrated.reservationState.config.businessHours ??= {
      timeZone: CHINA_TIME_ZONE, openingTime: '12:00', closingTime: '02:00', slotMinutes: 30, closedWeekdays: [],
    }
    migrated.reservationState.config.businessHours.timeZone = CHINA_TIME_ZONE
    migrated.reservationState.config.capacity ??= {
      defaultDailyCapacity: 120, defaultSlotCapacity: 20, dateOverrides: [],
    }
    migrated.reservationState.config.publicRules ??= {
      minimumLeadMinutes: 15, maximumAdvanceDays: 180, duplicateWindowMinutes: 60,
      acceptedContactMethods: ['phone', 'wechat'], createRateLimit: { limit: 5, windowMinutes: 10 },
    }
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
  migrateServiceTaskVisits(migrated)
  migrateFulfillmentTaskIds(migrated)
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
  if (upgradeFrontlineTableOperations) {
    migrated.auditEntries.push({
      id: 'runtime-migration-frontline-table-operations-v1',
      actorId: 'system',
      action: frontlineTableOperationsMigrationAction,
      objectType: 'store',
      objectId: migrated.store.id,
      occurredAt: `${migrated.store.businessDate}T00:00:00+08:00`,
      details: {
        strategy: 'built-in-service-role-capability-fingerprint',
        permissions: ['table.open', 'table.manage', 'table.close'],
      },
    })
  }
  if (upgradeFinanceCostPermissions) {
    migrated.auditEntries.push({
      id: 'runtime-migration-finance-cost-permissions-v1',
      actorId: 'system',
      action: financeCostPermissionMigrationAction,
      objectType: 'store',
      objectId: migrated.store.id,
      occurredAt: `${migrated.store.businessDate}T00:00:00+08:00`,
      details: {
        strategy: 'built-in-finance-role-capability-fingerprint',
        permission: 'finance.manage',
      },
    })
  }
  if (normalizeChinaTimezone && !migrated.auditEntries.some((entry) => entry.action === chinaTimezoneMigrationAction)) {
    migrated.auditEntries.push({
      id: 'runtime-migration-china-timezone-v1',
      actorId: 'system',
      action: chinaTimezoneMigrationAction,
      objectType: 'store',
      objectId: migrated.store.id,
      occurredAt: new Date().toISOString(),
      details: { timeZone: CHINA_TIME_ZONE, utcOffset: '+08:00' },
    })
  }
  if (upgradeWorkstationProductionRoles) {
    migrated.auditEntries.push({
      id: 'runtime-migration-workstation-production-roles-v1',
      actorId: 'system',
      action: workstationProductionRoleMigrationAction,
      objectType: 'store',
      objectId: migrated.store.id,
      occurredAt: new Date().toISOString(),
      details: {
        strategy: 'legacy-default-workstation-fingerprint',
        productionRoles: { 'bar-main': ['bartender'], 'kitchen-cold': ['kitchen'], 'kitchen-hot': ['kitchen'] },
      },
    })
  }
  if (upgradeHardwarePermissions) {
    migrated.auditEntries.push({
      id: 'runtime-migration-hardware-permissions-v1',
      actorId: 'system',
      action: hardwarePermissionMigrationAction,
      objectType: 'store',
      objectId: migrated.store.id,
      occurredAt: new Date().toISOString(),
      details: {
        strategy: 'built-in-hardware-role-capability-fingerprint',
        managedRoles: ['owner', 'operations_director', 'admin'],
        operatingRoles: ['manager', 'technical'],
      },
    })
  }

  return migrated
}
