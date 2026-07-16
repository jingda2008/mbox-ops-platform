import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import { createSeedState } from './seed.js'
import { migrateRuntimeState } from './runtime-state-migrations.js'

describe('runtime state operational migrations', () => {
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
    }
    delete legacyConfig.lateHoldMinutes
    delete legacyConfig.waitlistResponseMinutes
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
    expect(migrated.reservationState?.config).toMatchObject({ lateHoldMinutes: 30, waitlistResponseMinutes: 10 })
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
})
