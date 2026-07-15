import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import { projectRuntimeStateForActor } from './bootstrap-projection.js'
import { createOrderDraft } from './order-domain.js'
import { transferOpenTableSession } from './table-session-api.js'

function actor(actorId: string, roleId: string) {
  return { actorId, roleId, storeId: 'mbox-lujiazui', runtimeMode: 'test' as const, authenticatedBy: 'local_header' as const }
}

describe('role scoped bootstrap projection', () => {
  it('hides financial, audit and unrelated area data from a server', () => {
    const state = createSeedState()
    state.auditEntries.push({ id: 'audit-1', actorId: 'emp-chen', action: 'secret', objectType: 'order', objectId: '1', occurredAt: new Date().toISOString(), details: {} })
    const projected = projectRuntimeStateForActor(state, actor('emp-lin', 'server'))
    expect(projected.tables.every((table) => ['lounge', 'walkin', 'booth'].includes(table.areaId))).toBe(true)
    expect(projected.products.every((product) => product.costAmount === 0)).toBe(true)
    expect(projected.auditEntries).toEqual([])
    expect(projected.inventoryDomain).toBeDefined()
    expect(projected.draftConfig).toBeNull()
  })

  it('gives an admin configuration data without payment or business benefits', () => {
    const projected = projectRuntimeStateForActor(createSeedState(), actor('emp-admin', 'admin'))
    expect(projected.configVersions.length).toBeGreaterThan(0)
    expect(projected.paymentDomain.paymentIntents).toEqual([])
    expect(projected.members).toEqual([])
    expect(projected.orderDomain.orders).toEqual([])
  })

  it('keeps owner store-wide financial and audit data', () => {
    const state = createSeedState()
    state.auditEntries.push({ id: 'audit-1', actorId: 'emp-chen', action: 'visible', objectType: 'order', objectId: '1', occurredAt: new Date().toISOString(), details: {} })
    const projected = projectRuntimeStateForActor(state, actor('emp-owner', 'owner'))
    expect(projected.tables).toHaveLength(state.tables.length)
    expect(projected.products.some((product) => product.costAmount > 0)).toBe(true)
    expect(projected.auditEntries).toHaveLength(1)
  })

  it('uses active shift areas instead of stale employee areas', () => {
    const state = createSeedState()
    const employee = state.employees.find((item) => item.id === 'emp-lin')!
    const shift = state.shiftAssignments.find((item) => item.employeeId === 'emp-lin')!
    employee.areaIds = ['lounge']
    shift.areaIds = ['interactive']

    const projected = projectRuntimeStateForActor(state, actor('emp-lin', 'server'))
    expect(new Set(projected.tables.map((table) => table.areaId))).toEqual(new Set(['interactive']))
    expect(projected.areas.map((area) => area.id)).toEqual(['interactive'])
  })

  it('falls back to employee areas when there is no active shift', () => {
    const state = createSeedState()
    const employee = state.employees.find((item) => item.id === 'emp-lin')!
    const shift = state.shiftAssignments.find((item) => item.employeeId === 'emp-lin')!
    employee.areaIds = ['lounge']
    shift.areaIds = ['interactive']
    shift.status = 'completed'

    const projected = projectRuntimeStateForActor(state, actor('emp-lin', 'server'))
    expect(new Set(projected.tables.map((table) => table.areaId))).toEqual(new Set(['lounge']))
    expect(projected.areas.map((area) => area.id)).toEqual(['lounge'])
  })

  it('shows an assigned workstation task outside the production employee table areas without leaking table data', () => {
    const state = createSeedState()
    const shift = state.shiftAssignments.find((item) => item.employeeId === 'emp-qing')!
    shift.areaIds = ['lounge']
    shift.stationIds = ['bar-main']
    state.orderDomain.kdsTasks.push({
      id: 'kds-booth-cocktail',
      orderId: 'order-booth',
      orderItemId: 'line-booth-cocktail',
      tableSessionId: `session:table-b01:${state.store.businessDate}`,
      stationId: 'bar-main',
      itemName: '招牌鸡尾酒',
      specification: '1杯',
      quantity: 2,
      status: 'queued',
      workstation: {
        id: 'bar-main',
        name: '主吧台',
        productionRoleIds: ['bartender'],
        deliveryRoleIds: ['runner'],
        requiredSkillIds: ['skill-bar'],
        deliveryServiceTypeId: 'fulfillment-delivery',
        productionSlaSeconds: 180,
        pickupSlaSeconds: 60,
        configVersion: state.config.version,
      },
      queuedAt: new Date().toISOString(),
      startedAt: null,
      startedBy: null,
      completedAt: null,
      completedBy: null,
      pickedUpAt: null,
      pickedUpBy: null,
      deliveredAt: null,
      deliveredBy: null,
    })

    const projected = projectRuntimeStateForActor(state, actor('emp-qing', 'bartender'))
    expect(projected.orderDomain.kdsTasks.map((task) => task.id)).toContain('kds-booth-cocktail')
    expect(projected.tables.some((table) => table.id === 'table-b01')).toBe(false)
    expect(projected.orderDomain.orders.some((order) => order.id === 'order-booth')).toBe(false)

    shift.stationIds = ['kitchen-cold']
    const wrongStation = projectRuntimeStateForActor(state, actor('emp-qing', 'bartender'))
    expect(wrongStation.orderDomain.kdsTasks.map((task) => task.id)).not.toContain('kds-booth-cocktail')
  })

  it('does not project store data to a store-scoped actor authenticated for another store', () => {
    const state = createSeedState()
    const projected = projectRuntimeStateForActor(state, {
      ...actor('emp-chen', 'manager'),
      storeId: 'another-store',
    })
    expect(projected.tables).toEqual([])
    expect(projected.tasks).toEqual([])
    expect(projected.orderDomain.orders).toEqual([])
    expect(projected.paymentDomain.paymentIntents).toEqual([])
  })

  it('resolves a transferred session through its current table instead of its original session id', () => {
    const state = createSeedState()
    const session = state.songState.tableSessions.find((item) => item.tableId === 'table-w01')!
    createOrderDraft(state.orderDomain, {
      orderId: 'order-moved-across-areas',
      tableSessionId: session.id,
      createdBy: 'emp-lin',
      occurredAt: '2026-07-15T20:00:00+08:00',
      idempotencyKey: 'order-moved-across-areas-001',
    })
    transferOpenTableSession(state, 'table-w01', {
      targetTableId: 'table-i03',
      kind: 'relocate',
      reason: '顾客更换到互动区',
      idempotencyKey: 'transfer-w01-i03-projection-001',
    }, 'emp-chen', '2026-07-15T20:05:00+08:00')

    const oldAreaServer = projectRuntimeStateForActor(state, actor('emp-lin', 'server'))
    const newAreaServer = projectRuntimeStateForActor(state, actor('emp-wu', 'server'))
    expect(oldAreaServer.orderDomain.orders.map((order) => order.id)).not.toContain('order-moved-across-areas')
    expect(newAreaServer.orderDomain.orders.map((order) => order.id)).toContain('order-moved-across-areas')
    expect(newAreaServer.tableTransfers[0]).toMatchObject({ sourceTableId: 'table-w01', targetTableId: 'table-i03' })
  })
})
