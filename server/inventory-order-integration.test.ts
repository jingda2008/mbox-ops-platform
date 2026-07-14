import { describe, expect, it } from 'vitest'
import type { Order } from '../src/shared/order-contracts.js'
import { createInventoryDomainState, receiveInventory } from './inventory-domain.js'
import { consumeManagedInventoryForSubmittedOrder } from './inventory-order-integration.js'

const occurredAt = '2026-07-14T12:00:00.000Z'

function inventory() {
  const state = createInventoryDomainState({ tenantId: 'mbox', storeId: 'mbox-lujiazui' })
  receiveInventory(state, {
    movementId: 'receipt-beer',
    productId: 'product-beer',
    unitCode: 'bottle',
    quantity: 3,
    actorId: 'emp-chen',
    reason: '测试入库',
    businessDate: '2026-07-14',
    occurredAt,
    idempotencyKey: 'receipt-beer-0001',
  })
  return state
}

function order(items: Order['items']): Order {
  return {
    id: 'order-001',
    tableSessionId: 'session:table-l01:2026-07-14',
    status: 'submitted',
    items,
    amounts: { grossAmount: 0, discountAmount: 0, giftAmount: 0, payableAmount: 0 },
    revision: 1,
    createdBy: 'emp-lin',
    createdAt: occurredAt,
    submittedBy: 'emp-lin',
    submittedAt: occurredAt,
    fulfilledAt: null,
  }
}

function line(id: string, skuId: string, quantity: number, unitSalePriceAmount: number): Order['items'][number] {
  return {
    id,
    skuId,
    name: skuId,
    specification: '1份',
    quantity,
    unitListPriceAmount: 6_800,
    unitSalePriceAmount,
    unitCostAmount: 1_800,
    stationId: 'bar-main',
    configVersion: 1,
    fulfillmentStatus: 'queued',
    kdsTaskId: `kds:${id}`,
    addedBy: 'emp-lin',
    addedAt: occurredAt,
  }
}

describe('submitted order inventory integration', () => {
  it('records sale and gift facts only for managed products and replays by order line', () => {
    const state = inventory()
    const submitted = order([
      line('line-sale', 'product-beer', 1, 6_800),
      line('line-gift', 'product-beer', 1, 0),
      line('line-unmanaged', 'product-fruit', 1, 12_800),
    ])

    const first = consumeManagedInventoryForSubmittedOrder(state, submitted, {
      actorId: 'emp-lin', businessDate: '2026-07-14', occurredAt,
    })
    const replay = consumeManagedInventoryForSubmittedOrder(state, submitted, {
      actorId: 'emp-lin', businessDate: '2026-07-14', occurredAt: '2026-07-14T12:01:00.000Z',
    })

    expect(first.map((movement) => movement.type)).toEqual(['sale', 'gift'])
    expect(replay.map((movement) => movement.id)).toEqual(first.map((movement) => movement.id))
    expect(state.balances.find((balance) => balance.productId === 'product-beer')?.onHandQuantity).toBe(1)
    expect(state.movements).toHaveLength(3)
    expect(state.movements.slice(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tableSessionId: submitted.tableSessionId,
        orderId: submitted.id,
        orderItemId: 'line-sale',
        businessDate: '2026-07-14',
      }),
      expect.objectContaining({ orderItemId: 'line-gift', type: 'gift' }),
    ]))
    expect(state.idempotencyRecords.map((record) => record.key)).toEqual(expect.arrayContaining([
      'inventory.order-submit:order-001:line-sale:v1',
      'inventory.order-submit:order-001:line-gift:v1',
    ]))
  })

  it('leaves every managed line unchanged when the full order cannot be consumed', () => {
    const state = inventory()
    const before = structuredClone(state)
    const submitted = order([
      line('line-first', 'product-beer', 2, 6_800),
      line('line-insufficient', 'product-beer', 2, 6_800),
    ])

    expect(() => consumeManagedInventoryForSubmittedOrder(state, submitted, {
      actorId: 'emp-lin', businessDate: '2026-07-14', occurredAt,
    })).toThrow('库存不足，禁止产生负库存')
    expect(state).toEqual(before)
  })
})
