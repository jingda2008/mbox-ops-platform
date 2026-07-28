import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import { createSeedState } from './seed.js'
import { migrateRuntimeState } from './runtime-state-migrations.js'
import { createServiceTask } from './domain.js'

describe('runtime state operational migrations', () => {
  it('normalizes legacy store and reservation timezones to China standard time', () => {
    const legacy = createSeedState()
    legacy.store.timezone = 'UTC'
    legacy.reservationState!.config.businessHours.timeZone = 'America/New_York'

    const migrated = migrateRuntimeState(legacy)

    expect(migrated.store.timezone).toBe('Asia/Shanghai')
    expect(migrated.reservationState?.config.businessHours.timeZone).toBe('Asia/Shanghai')
    expect(migrated.auditEntries).toContainEqual(expect.objectContaining({
      action: 'runtime.china_timezone_normalized.v1',
      details: { timeZone: 'Asia/Shanghai', utcOffset: '+08:00' },
    }))
  })

  it('adds configurable fulfillment defaults without replacing existing store data', () => {
    const legacy = structuredClone(createSeedState()) as RuntimeState & {
      config: RuntimeState['config'] & { skills?: unknown; workstations?: unknown }
    }
    const originalTableName = legacy.tables[0]!.displayName
    delete legacy.config.skills
    delete legacy.config.workstations
    delete (legacy.config as Partial<RuntimeState['config']>).guestServiceLimits
    delete (legacy.config as Partial<RuntimeState['config']>).communityBrand
    legacy.config.roles = legacy.config.roles
      .filter((role) => !['owner', 'admin', 'bartender', 'kitchen', 'runner', 'cashier', 'host'].includes(role.id))
      .map(({ permissionIds: _permissionIds, dataScope: _dataScope, approvalLimits: _approvalLimits, ...role }) => role)
    legacy.config.serviceTypes = legacy.config.serviceTypes.filter(
      (type) => !['FULFILLMENT_DELIVERY', 'CUSTOM_REQUEST'].includes(type.code),
    )
    legacy.employees = legacy.employees.map(({ skillIds: _skillIds, ...employee }) => employee)
    legacy.shiftAssignments = legacy.shiftAssignments.map(({ stationIds: _stationIds, ...shift }) => shift)
    for (const product of legacy.products) {
      delete product.soldOut
      delete product.soldOutReason
      delete product.availableFrom
      delete product.availableUntil
    }

    const migrated = migrateRuntimeState(legacy)

    expect(migrated.tables[0]?.displayName).toBe(originalTableName)
    expect(migrated.config.workstations.map((station) => station.id)).toEqual(
      expect.arrayContaining(['bar-main', 'kitchen-cold', 'kitchen-hot']),
    )
    expect(migrated.config.roles.map((role) => role.id)).toEqual(
      expect.arrayContaining(['owner', 'admin', 'bartender', 'kitchen', 'runner', 'cashier', 'host']),
    )
    expect(migrated.config.serviceTypes.find((type) => type.code === 'FULFILLMENT_DELIVERY')).toMatchObject({
      guestVisible: false,
    })
    expect(migrated.config.serviceTypes.find((type) => type.code === 'CUSTOM_REQUEST')).toMatchObject({
      id: 'custom-request',
      name: '个性化需求',
      dispatchRoleIds: expect.arrayContaining(['server', 'supervisor', 'manager']),
    })
    expect(migrated.config.guestServiceLimits).toEqual({
      windowSeconds: 60,
      maxRequests: 5,
      duplicateSeconds: 60,
    })
    expect(migrated.config.communityBrand).toMatchObject({
      enabled: true,
      name: '超嗨部落',
      guestOrderVisible: true,
      memberPortalVisible: true,
    })
    expect(migrated.employees.every((employee) => Array.isArray(employee.skillIds))).toBe(true)
    expect(migrated.shiftAssignments.every((shift) => Array.isArray(shift.stationIds))).toBe(true)
    expect(migrated.products.every((product) => (
      product.soldOut === false
      && product.soldOutReason === ''
      && product.availableFrom === null
      && product.availableUntil === null
    ))).toBe(true)
    expect(migrated.config.roles.find((role) => role.id === 'server')).toMatchObject({
      dataScope: 'assigned_areas',
      approvalLimits: { giftAmount: 8800 },
    })
    expect(migrated.config.roles.find((role) => role.id === 'admin')?.permissionIds).not.toContain('finance.view')
  })

  it('adds complex SOP defaults to legacy configs and runtime state', () => {
    const legacy = structuredClone(createSeedState())
    delete (legacy.config as Partial<RuntimeState['config']>).sopRules
    for (const version of legacy.configVersions) {
      delete (version.snapshot as Partial<RuntimeState['config']>).sopRules
    }
    delete (legacy as Partial<RuntimeState>).sopExecutions
    delete (legacy as Partial<RuntimeState>).dutyManagerIncidents

    const migrated = migrateRuntimeState(legacy)

    expect(migrated.config.sopRules).toEqual([])
    expect(migrated.configVersions.every((version) => Array.isArray(version.snapshot.sopRules))).toBe(true)
    expect(migrated.sopExecutions).toEqual([])
    expect(migrated.dutyManagerIncidents).toEqual([])
  })

  it('adds disabled hardware defaults and upgrades only built-in device roles once', () => {
    const legacy = structuredClone(createSeedState())
    delete (legacy as Partial<RuntimeState>).hardwareState
    legacy.auditEntries = legacy.auditEntries.filter((entry) => entry.action !== 'runtime.hardware_permissions_v1_migrated.v1')
    for (const role of legacy.config.roles) {
      role.permissionIds = role.permissionIds?.filter((permissionId) => !permissionId.startsWith('hardware.'))
    }

    const migrated = migrateRuntimeState(legacy)

    expect(migrated.hardwareState?.devices).toHaveLength(5)
    expect(migrated.hardwareState?.devices.every((device) => !device.enabled && device.status === 'disabled')).toBe(true)
    expect(migrated.config.roles.find((role) => role.id === 'admin')?.permissionIds).toEqual(expect.arrayContaining([
      'hardware.view', 'hardware.operate', 'hardware.manage',
    ]))
    expect(migrated.config.roles.find((role) => role.id === 'manager')?.permissionIds).toEqual(expect.arrayContaining([
      'hardware.view', 'hardware.operate',
    ]))
    expect(migrated.config.roles.find((role) => role.id === 'server')?.permissionIds).not.toContain('hardware.view')
    expect(migrated.auditEntries.filter((entry) => entry.action === 'runtime.hardware_permissions_v1_migrated.v1')).toHaveLength(1)

    const manager = migrated.config.roles.find((role) => role.id === 'manager')!
    manager.permissionIds = manager.permissionIds?.filter((permissionId) => permissionId !== 'hardware.operate')
    expect(migrateRuntimeState(migrated).config.roles.find((role) => role.id === 'manager')?.permissionIds).not.toContain('hardware.operate')
  })

  it('separates legacy management roles from production while preserving customized workstation roles', () => {
    const legacy = createSeedState()
    legacy.config.workstations.find((item) => item.id === 'bar-main')!.productionRoleIds = [
      'bartender', 'specialist', 'supervisor', 'manager',
    ]
    legacy.config.workstations.find((item) => item.id === 'kitchen-cold')!.productionRoleIds = [
      'kitchen', 'specialist', 'supervisor', 'manager',
    ]
    legacy.config.workstations.find((item) => item.id === 'kitchen-hot')!.productionRoleIds = ['kitchen', 'manager']
    legacy.draftConfig = structuredClone(legacy.config)

    const migrated = migrateRuntimeState(legacy)

    expect(migrated.config.workstations.find((item) => item.id === 'bar-main')?.productionRoleIds).toEqual(['bartender'])
    expect(migrated.config.workstations.find((item) => item.id === 'kitchen-cold')?.productionRoleIds).toEqual(['kitchen'])
    expect(migrated.config.workstations.find((item) => item.id === 'kitchen-hot')?.productionRoleIds).toEqual(['kitchen', 'manager'])
    expect(migrated.draftConfig?.workstations.find((item) => item.id === 'bar-main')?.productionRoleIds).toEqual(['bartender'])
    expect(migrated.auditEntries).toContainEqual(expect.objectContaining({
      action: 'runtime.workstation_production_roles_v1_migrated.v1',
    }))
  })

  it('softens only the previously shipped community-brand copy', () => {
    const legacy = createSeedState()
    legacy.config.communityBrand.eyebrow = 'M-BOX MEMBER COMMUNITY'
    legacy.config.communityBrand.tagline = '由 M-Box 相识，在超嗨部落持续相聚'
    legacy.draftConfig = structuredClone(legacy.config)
    legacy.draftConfig.communityBrand.tagline = '管理员自定义口号'

    const migrated = migrateRuntimeState(legacy)

    expect(migrated.config.communityBrand).toMatchObject({
      eyebrow: 'SUPERHIGH TRIBE · CULTURE MARK',
      tagline: 'M-Box · 超嗨部落旗下现场空间',
    })
    expect(migrated.draftConfig?.communityBrand.tagline).toBe('管理员自定义口号')
  })

  it('upgrades only shipped guest replies and preserves manager-written service copy', () => {
    const legacy = createSeedState()
    const defaults = legacy.config.serviceTypes.map((serviceType) => ({ code: serviceType.code, reply: serviceType.customerReply }))
    const oldReplies = new Map([
      ['ADD_WATER', '已收到，{employee}正在为您处理。'],
      ['ADD_ICE_LEMON', '已收到，{employee}马上为您准备。'],
      ['ORDER_HELP', '已收到，{employee}会到桌协助您点单。'],
      ['REQUEST_BILL', '买单请求已收到，{employee}正在核对您的桌账。'],
      ['COMPLAINT', '您的反馈已由值班领班接管，我们会尽快到桌处理。'],
      ['BIRTHDAY_CARE', '生日安排已收到，服务专员会与您确认细节。'],
      ['CUSTOM_REQUEST', '您的个性化需求已收到，{employee}正在为您处理。'],
      ['FULFILLMENT_DELIVERY', '出品已完成，服务人员正在取送。'],
    ])
    for (const serviceType of legacy.config.serviceTypes) {
      const oldReply = oldReplies.get(serviceType.code)
      if (oldReply) serviceType.customerReply = oldReply
    }
    legacy.config.serviceTypes.find((serviceType) => serviceType.code === 'COMPLAINT')!.customerReply = '经理自定义：我马上到桌。'

    const migrated = migrateRuntimeState(legacy)

    expect(migrated.config.serviceTypes.find((serviceType) => serviceType.code === 'COMPLAINT')?.customerReply).toBe('经理自定义：我马上到桌。')
    for (const expected of defaults.filter((item) => item.code !== 'COMPLAINT')) {
      expect(migrated.config.serviceTypes.find((serviceType) => serviceType.code === expected.code)?.customerReply).toBe(expected.reply)
    }
  })

  it('ships a distinct customer reply for every service scene', () => {
    const replies = createSeedState().config.serviceTypes.map((serviceType) => serviceType.customerReply)
    expect(new Set(replies).size).toBe(replies.length)
    expect(replies.every((reply) => !reply.startsWith('已收到'))).toBe(true)
  })

  it('conservatively upgrades permissions for unchanged built-in roles in all persisted configs', () => {
    const legacy = structuredClone(createSeedState())
    legacy.draftConfig = structuredClone(legacy.config)
    const targets = [legacy.config, legacy.draftConfig, ...legacy.configVersions.map((record) => record.snapshot)]
      .filter((config): config is NonNullable<typeof config> => Boolean(config))

    for (const config of targets) {
      for (const role of config.roles) {
        if (!role.permissionIds) continue
        role.permissionIds = role.permissionIds.filter((permissionId) => ![
          'reservation.view',
          'reservation.config.manage',
          'table.close',
          'business_day.close',
          ...(role.id === 'admin' ? ['shift.manage', 'table.manage'] as const : []),
        ].includes(permissionId as never))
      }
    }

    const migrated = migrateRuntimeState(legacy)
    const migratedConfigs = [migrated.config, migrated.draftConfig, ...migrated.configVersions.map((record) => record.snapshot)]
      .filter((config): config is NonNullable<typeof config> => Boolean(config))

    for (const config of migratedConfigs) {
      expect(config.roles.find((role) => role.id === 'owner')?.permissionIds).toEqual(expect.arrayContaining([
        'reservation.view', 'reservation.config.manage', 'table.close', 'business_day.close',
      ]))
      expect(config.roles.find((role) => role.id === 'manager')?.permissionIds).toEqual(expect.arrayContaining([
        'reservation.view', 'reservation.config.manage', 'table.close', 'business_day.close',
      ]))
      expect(config.roles.find((role) => role.id === 'supervisor')?.permissionIds).toContain('reservation.view')
      expect(config.roles.find((role) => role.id === 'cashier')?.permissionIds).toEqual(expect.arrayContaining([
        'reservation.view', 'table.close',
      ]))
      expect(config.roles.find((role) => role.id === 'host')?.permissionIds).toContain('reservation.view')
      expect(config.roles.find((role) => role.id === 'admin')?.permissionIds).toEqual(expect.arrayContaining([
        'shift.manage', 'table.manage',
      ]))
    }
  })

  it('preserves explicit permission revocations after the one-time upgrade', () => {
    const legacy = structuredClone(createSeedState())
    legacy.auditEntries = legacy.auditEntries.filter(
      (entry) => entry.action !== 'runtime.permission_policy_v2_migrated.v1',
    )
    const upgraded = migrateRuntimeState(legacy)
    const owner = upgraded.config.roles.find((role) => role.id === 'owner')!
    const host = upgraded.config.roles.find((role) => role.id === 'host')!
    owner.permissionIds = owner.permissionIds?.filter((permissionId) => permissionId !== 'table.close')
    host.permissionIds = host.permissionIds?.filter((permissionId) => permissionId !== 'reservation.view')

    const migratedAgain = migrateRuntimeState(upgraded)

    expect(migratedAgain.config.roles.find((role) => role.id === 'owner')?.permissionIds).not.toContain('table.close')
    expect(migratedAgain.config.roles.find((role) => role.id === 'host')?.permissionIds).not.toContain('reservation.view')
    expect(migratedAgain.auditEntries.filter(
      (entry) => entry.action === 'runtime.permission_policy_v2_migrated.v1',
    )).toHaveLength(1)
  })

  it('upgrades frontline table operations once without overwriting later permission revocations', () => {
    const legacy = structuredClone(createSeedState())
    legacy.auditEntries = legacy.auditEntries.filter(
      (entry) => entry.action !== 'runtime.frontline_table_operations_v1_migrated.v1',
    )
    for (const config of [legacy.config, ...legacy.configVersions.map((record) => record.snapshot)]) {
      for (const role of config.roles) {
        if (!['owner', 'operations_director', 'manager', 'supervisor', 'server', 'backup', 'specialist', 'host'].includes(role.id)) continue
        role.permissionIds = role.permissionIds?.filter((permissionId) => ![
          'table.open',
          ...(role.id === 'supervisor' || ['server', 'backup', 'specialist'].includes(role.id)
            ? ['table.close'] as const
            : []),
          ...(['server', 'backup', 'specialist'].includes(role.id) ? ['table.manage'] as const : []),
        ].includes(permissionId as never))
      }
    }

    const upgraded = migrateRuntimeState(legacy)
    for (const config of [upgraded.config, ...upgraded.configVersions.map((record) => record.snapshot)]) {
      expect(config.roles.find((role) => role.id === 'server')?.permissionIds).toEqual(expect.arrayContaining([
        'table.open', 'table.manage', 'table.close',
      ]))
      expect(config.roles.find((role) => role.id === 'backup')?.permissionIds).toEqual(expect.arrayContaining([
        'table.open', 'table.manage', 'table.close',
      ]))
      expect(config.roles.find((role) => role.id === 'specialist')?.permissionIds).toEqual(expect.arrayContaining([
        'table.open', 'table.manage', 'table.close',
      ]))
      expect(config.roles.find((role) => role.id === 'supervisor')?.permissionIds).toEqual(expect.arrayContaining([
        'table.open', 'table.close',
      ]))
      expect(config.roles.find((role) => role.id === 'host')?.permissionIds).toContain('table.open')
    }

    const server = upgraded.config.roles.find((role) => role.id === 'server')!
    server.permissionIds = server.permissionIds?.filter((permissionId) => permissionId !== 'table.close')
    const migratedAgain = migrateRuntimeState(upgraded)

    expect(migratedAgain.config.roles.find((role) => role.id === 'server')?.permissionIds).not.toContain('table.close')
    expect(migratedAgain.auditEntries.filter(
      (entry) => entry.action === 'runtime.frontline_table_operations_v1_migrated.v1',
    )).toHaveLength(1)
  })

  it('does not grant frontline table operations when a service-role prerequisite was removed', () => {
    const legacy = structuredClone(createSeedState())
    legacy.auditEntries = legacy.auditEntries.filter(
      (entry) => entry.action !== 'runtime.frontline_table_operations_v1_migrated.v1',
    )
    const server = legacy.config.roles.find((role) => role.id === 'server')!
    server.permissionIds = server.permissionIds?.filter((permissionId) => ![
      'service.execute', 'table.open', 'table.manage', 'table.close',
    ].includes(permissionId))

    const migrated = migrateRuntimeState(legacy)

    expect(migrated.config.roles.find((role) => role.id === 'server')?.permissionIds).not.toEqual(expect.arrayContaining([
      'table.open', 'table.manage', 'table.close',
    ]))
  })

  it('does not expand custom roles or built-in roles with a removed prerequisite', () => {
    const legacy = structuredClone(createSeedState())
    const owner = legacy.config.roles.find((role) => role.id === 'owner')!
    owner.permissionIds = owner.permissionIds?.filter((permissionId) => (
      permissionId !== 'identity.manage'
      && !['reservation.view', 'reservation.config.manage', 'table.close', 'business_day.close'].includes(permissionId)
    ))
    legacy.config.roles.push({
      id: 'custom-duty-manager',
      name: '自定义值班角色',
      maxConcurrentTasks: 4,
      canReceiveTasks: true,
      permissionIds: ['shift.manage', 'table.manage', 'reservation.manage', 'payment.refund.approve'],
      dataScope: 'store',
      approvalLimits: {
        giftAmount: 0, discountAmount: 0, refundRequestAmount: 0,
        refundApproveAmount: 0, inventoryAdjustmentAmount: 0,
      },
    })

    const migrated = migrateRuntimeState(legacy)

    expect(migrated.config.roles.find((role) => role.id === 'owner')?.permissionIds).not.toEqual(expect.arrayContaining([
      'reservation.view', 'reservation.config.manage', 'table.close', 'business_day.close',
    ]))
    expect(migrated.config.roles.find((role) => role.id === 'custom-duty-manager')?.permissionIds).toEqual([
      'shift.manage', 'table.manage', 'reservation.manage', 'payment.refund.approve',
    ])
  })

  it('creates one deterministic open session for an occupied table that has none', () => {
    const legacy = structuredClone(createSeedState())
    const table = legacy.tables.find((candidate) => candidate.status === 'occupied')!
    legacy.songState.tableSessions = legacy.songState.tableSessions.filter((session) => session.tableId !== table.id)

    const migrated = migrateRuntimeState(legacy)
    const sessions = migrated.songState.tableSessions.filter(
      (session) => session.tableId === table.id && session.status === 'open',
    )

    expect(sessions).toEqual([expect.objectContaining({
      id: `session:${table.id}:${legacy.store.businessDate}:migrated`,
      tableId: table.id,
      tableCode: table.code,
      openedAt: table.openedAt,
      closedAt: null,
    })])
    expect(migrateRuntimeState(migrated).songState.tableSessions.filter(
      (session) => session.tableId === table.id && session.status === 'open',
    )).toHaveLength(1)
  })

  it('binds legacy service tasks to their visit and archives tasks from a closed visit', () => {
    const legacy = structuredClone(createSeedState())
    const task = createServiceTask(legacy, {
      tableCode: 'L01', serviceTypeId: 'water', source: 'guest', note: '遗留未响应需求',
      idempotencyKey: 'legacy-service-visit-migration-0001',
    })
    const table = legacy.tables.find((candidate) => candidate.id === task.tableId)!
    const session = legacy.songState.tableSessions.find((candidate) => candidate.tableId === table.id && candidate.status === 'open')!
    session.closedAt = new Date(Date.parse(task.createdAt) + 60_000).toISOString()
    session.status = 'closed'
    table.status = 'available'
    table.guestCount = 0
    table.openedAt = null
    delete (task as Partial<typeof task>).tableSessionId
    delete (task as Partial<typeof task>).archivedAt
    delete (task as Partial<typeof task>).archiveOutcome
    delete (task as Partial<typeof task>).archivedFromStatus

    const migrated = migrateRuntimeState(legacy)
    expect(migrated.tasks.find((candidate) => candidate.id === task.id)).toMatchObject({
      tableSessionId: session.id,
      status: 'cancelled',
      archiveOutcome: 'unresolved',
      archivedFromStatus: task.status,
      archivedAt: session.closedAt,
    })
  })

  it('repairs legacy workstation delivery references without changing null or valid references', () => {
    const legacy = structuredClone(createSeedState())
    const [invalid, valid, intentionallyNull] = legacy.config.workstations
    invalid!.deliveryServiceTypeId = 'order-help'
    valid!.deliveryServiceTypeId = 'fulfillment-delivery'
    intentionallyNull!.deliveryServiceTypeId = null

    const migrated = migrateRuntimeState(legacy)

    expect(migrated.config.workstations.find((station) => station.id === invalid!.id)?.deliveryServiceTypeId)
      .toBe('fulfillment-delivery')
    expect(migrated.config.workstations.find((station) => station.id === valid!.id)?.deliveryServiceTypeId)
      .toBe('fulfillment-delivery')
    expect(migrated.config.workstations.find((station) => station.id === intentionallyNull!.id)?.deliveryServiceTypeId)
      .toBeNull()
  })

  it('adds transfer, waitlist and late-arrival defaults to legacy persisted state', () => {
    const legacy = structuredClone(createSeedState()) as RuntimeState & {
      tableTransfers?: unknown
      waitlistEntries?: unknown
    }
    delete legacy.tableTransfers
    delete legacy.waitlistEntries
    const legacyConfig = legacy.reservationState!.config as typeof legacy.reservationState.config & {
      lateHoldMinutes?: number
      waitlistResponseMinutes?: number
      businessHours?: typeof legacy.reservationState.config.businessHours
      capacity?: typeof legacy.reservationState.config.capacity
      publicRules?: typeof legacy.reservationState.config.publicRules
    }
    delete legacyConfig.lateHoldMinutes
    delete legacyConfig.waitlistResponseMinutes
    delete legacyConfig.businessHours
    delete legacyConfig.capacity
    delete legacyConfig.publicRules
    const legacyReservation = legacy.reservationState!.reservations[0]
    if (legacyReservation) {
      for (const field of [
        'expectedArrivalAt', 'lateContactReference', 'holdStatus', 'holdUntil',
        'holdDecidedBy', 'holdDecidedAt', 'holdReason',
      ] as const) delete legacyReservation[field]
    }

    const migrated = migrateRuntimeState(legacy as RuntimeState)

    expect(migrated.tableTransfers).toEqual([])
    expect(migrated.waitlistEntries).toEqual([])
    expect(migrated.reservationState?.config).toMatchObject({
      lateHoldMinutes: 30,
      waitlistResponseMinutes: 10,
      businessHours: { timeZone: 'Asia/Shanghai', openingTime: '12:00', closingTime: '02:00', slotMinutes: 30 },
      capacity: { defaultDailyCapacity: 120, defaultSlotCapacity: 20 },
      publicRules: { minimumLeadMinutes: 15, maximumAdvanceDays: 180, duplicateWindowMinutes: 60 },
    })
    if (legacyReservation) {
      expect(migrated.reservationState?.reservations[0]).toMatchObject({
        expectedArrivalAt: null,
        lateContactReference: null,
        holdStatus: 'none',
        holdUntil: null,
        holdDecidedBy: null,
        holdDecidedAt: null,
        holdReason: null,
      })
    }
  })

  it('migrates legacy manual online flags to an empty lease-backed presence state', () => {
    const legacy = structuredClone(createSeedState()) as RuntimeState & { presenceLeases?: unknown }
    delete legacy.presenceLeases
    expect(legacy.employees.some((employee) => employee.online)).toBe(true)

    const migrated = migrateRuntimeState(legacy as RuntimeState)

    expect(migrated.presenceLeases).toEqual([])
    expect(migrated.employees.every((employee) => !employee.online)).toBe(true)
    const migratedAgain = migrateRuntimeState(migrated)
    expect(migratedAgain.presenceLeases).toEqual([])
    expect(migratedAgain.employees.every((employee) => !employee.online)).toBe(true)
  })

  it('extends built-in commerce authorities once without overwriting later configuration', () => {
    const legacy = structuredClone(createSeedState())
    legacy.auditEntries = legacy.auditEntries.filter(
      (entry) => entry.action !== 'runtime.standing_commerce_authorities_v1_migrated.v1',
    )
    const managerAuthority = legacy.orderDomain.authorizationAuthorities.find(
      (authority) => authority.id === 'manager-commerce-authority',
    )!
    managerAuthority.validFrom = '2026-07-01T00:00:00+08:00'
    managerAuthority.validUntil = '2026-07-02T03:00:00+08:00'

    const migrated = migrateRuntimeState(legacy)
    expect(migrated.orderDomain.authorizationAuthorities.find(
      (authority) => authority.id === 'manager-commerce-authority',
    )).toMatchObject({
      validFrom: '2026-01-01T00:00:00+08:00',
      validUntil: '2099-12-31T23:59:59+08:00',
    })
    expect(migrated.auditEntries.filter(
      (entry) => entry.action === 'runtime.standing_commerce_authorities_v1_migrated.v1',
    )).toHaveLength(1)
    expect(migrated.config.roles.find((role) => role.id === 'admin')).toMatchObject({
      approvalLimits: { giftAmount: 500_000, discountAmount: 500_000 },
    })
    expect(migrated.config.roles.find((role) => role.id === 'admin')?.permissionIds)
      .toContain('commerce.authorization.approve')

    const customized = structuredClone(migrated)
    const customizedAuthority = customized.orderDomain.authorizationAuthorities.find(
      (authority) => authority.id === 'manager-commerce-authority',
    )!
    customizedAuthority.validFrom = '2027-01-01T00:00:00+08:00'
    customizedAuthority.validUntil = '2027-12-31T23:59:59+08:00'
    const customizedAdmin = customized.config.roles.find((role) => role.id === 'admin')!
    customizedAdmin.permissionIds = customizedAdmin.permissionIds.filter(
      (permissionId) => permissionId !== 'commerce.authorization.approve',
    )
    customizedAdmin.approvalLimits.giftAmount = 0

    const migratedAgain = migrateRuntimeState(customized)
    expect(migratedAgain.orderDomain.authorizationAuthorities.find(
      (authority) => authority.id === 'manager-commerce-authority',
    )).toMatchObject({
      validFrom: '2027-01-01T00:00:00+08:00',
      validUntil: '2027-12-31T23:59:59+08:00',
    })
    expect(migratedAgain.auditEntries.filter(
      (entry) => entry.action === 'runtime.standing_commerce_authorities_v1_migrated.v1',
    )).toHaveLength(1)
    expect(migratedAgain.config.roles.find((role) => role.id === 'admin')?.permissionIds)
      .not.toContain('commerce.authorization.approve')
    expect(migratedAgain.config.roles.find((role) => role.id === 'admin')?.approvalLimits.giftAmount).toBe(0)
  })
})
