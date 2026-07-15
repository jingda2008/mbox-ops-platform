import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import {
  normalizeOrderFulfillmentState,
  routeProductToEnabledWorkstation,
  syncOrderFulfillmentWorkstations,
} from './fulfillment-workstations.js'
import {
  addOrderItem,
  createOrderDomainState,
  createOrderDraft,
  submitOrder,
} from './order-domain.js'

describe('fulfillment workstation routing', () => {
  it('uses StoreConfig as the runtime source and routes a disabled product station to its fallback', () => {
    const state = createSeedState()
    state.config.workstations.find((station) => station.id === 'kitchen-hot')!.enabled = false

    const mirrored = syncOrderFulfillmentWorkstations(state)
    const routed = routeProductToEnabledWorkstation(state, 'kitchen-hot')

    expect(mirrored.map((station) => station.id)).not.toContain('kitchen-hot')
    expect(routed.id).toBe('bar-main')
    expect(routed.configVersion).toBe(state.config.version)
  })

  it('rejects a disabled product station when no enabled fallback is available', () => {
    const state = createSeedState()
    state.config.workstations.find((station) => station.id === 'kitchen-hot')!.enabled = false
    state.config.workstations.find((station) => station.id === 'bar-main')!.enabled = false
    syncOrderFulfillmentWorkstations(state)

    expect(() => routeProductToEnabledWorkstation(state, 'kitchen-hot')).toThrow(
      '商品工作站已停用且未配置可用兜底',
    )
  })

  it('hydrates KDS snapshots from legacy persisted order state', () => {
    const state = createOrderDomainState()
    createOrderDraft(state, {
      orderId: 'order-legacy', tableSessionId: 'session:table-l01:2026-07-15', createdBy: 'emp-lin',
      occurredAt: '2026-07-15T10:00:00.000Z', idempotencyKey: 'legacy-create-order',
    })
    addOrderItem(state, {
      orderId: 'order-legacy', actorId: 'emp-lin', occurredAt: '2026-07-15T10:01:00.000Z',
      idempotencyKey: 'legacy-add-item',
      item: {
        id: 'line-legacy', skuId: 'product-beer', name: '精酿啤酒', specification: '330ml', quantity: 1,
        unitListPriceAmount: 6800, unitSalePriceAmount: 6800, unitCostAmount: 1800,
        stationId: 'bar-main', configVersion: 1,
      },
    })
    submitOrder(state, {
      orderId: 'order-legacy', submittedBy: 'emp-lin', occurredAt: '2026-07-15T10:02:00.000Z',
      idempotencyKey: 'legacy-submit-order',
    })
    const task = state.kdsTasks[0]!
    delete state.fulfillmentWorkstations
    delete task.workstation
    delete task.productionSla
    delete task.pickupSla
    delete task.deliveryServiceTask

    normalizeOrderFulfillmentState(state)

    expect(task.workstation).toMatchObject({ id: 'bar-main', deliveryServiceTypeId: 'fulfillment-delivery' })
    expect(task.productionSla?.dueAt).toBe('2026-07-15T10:05:00.000Z')
    expect(task.pickupSla).toEqual({ targetSeconds: 90, dueAt: null })
    expect(task.deliveryServiceTask).toBeNull()
  })
})
