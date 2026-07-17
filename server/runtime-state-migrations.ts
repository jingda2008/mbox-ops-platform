import type { RoleConfig, RuntimeState, StaffPermissionId, StoreConfig } from '../src/shared/contracts.js'
import { createSeedConfig } from './seed.js'
import { withDefaultRolePolicy } from '../src/shared/role-policy.js'
import { reconcilePresence } from './presence.js'

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
      )),
      ...structuredClone(defaults.roles.filter((role) => !roleIds.has(role.id))),
    ],
    skills: [...(config.skills ?? []), ...structuredClone(defaults.skills.filter((skill) => !skillIds.has(skill.id)))],
    workstations: config.workstations ?? structuredClone(defaults.workstations),
    proactiveOrderCare: config.proactiveOrderCare ?? structuredClone(defaults.proactiveOrderCare),
    guestServiceLimits: config.guestServiceLimits ?? structuredClone(defaults.guestServiceLimits),
    communityBrand,
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
    confirmedBy: request.confirmedBy ?? (request.status === 'pending_confirmation' ? null : 'legacy-system'),
    confirmedAt: request.confirmedAt ?? (request.status === 'pending_confirmation' ? null : request.createdAt),
    payment: request.payment
      ? { ...request.payment, collectionChannel: request.payment.collectionChannel ?? 'physical_pos' }
      : null,
  }))
  reconcilePresence(migrated, Date.now(), false)
  const menuDefaults = new Map([
    ['product-cocktail', { categoryId: 'drinks', categoryName: '酒水', description: '柑橘香气与清爽气泡，现场现调。', imageUrl: '/menu/cocktail.jpg', tags: ['招牌', '现调'], sortOrder: 1 }],
    ['product-beer', { categoryId: 'drinks', categoryName: '酒水', description: '冰镇精酿，入口清爽，适合分享。', imageUrl: '/menu/beer.jpg', tags: ['冰镇'], sortOrder: 2 }],
    ['product-fruit', { categoryId: 'food', categoryName: '餐食', description: '当日鲜切水果，适合多人分享。', imageUrl: '/menu/fruit.jpg', tags: ['鲜切'], sortOrder: 3 }],
    ['product-snack', { categoryId: 'food', categoryName: '餐食', description: '热制下酒小食组合，出品约八分钟。', imageUrl: '/menu/snack.jpg', tags: ['热食'], sortOrder: 4 }],
  ])
  migrated.products = migrated.products.map((product) => ({
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
    migrated.reservationState.config.lateHoldMinutes ??= 30
    migrated.reservationState.config.waitlistResponseMinutes ??= 10
    migrated.reservationState.config.businessHours ??= {
      timeZone: 'Asia/Shanghai', openingTime: '20:30', closingTime: '02:00', slotMinutes: 30, closedWeekdays: [],
    }
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
