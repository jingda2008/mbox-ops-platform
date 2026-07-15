import { describe, expect, it } from 'vitest'
import type { Order } from '../src/shared/order-contracts.js'
import {
  createInventoryDomainState,
  publishRecipeVersion,
  receiveInventory,
  upsertIngredientSku,
} from './inventory-domain.js'
import {
  consumeManagedInventoryForRemadeOrderItem,
  consumeManagedInventoryForSubmittedOrder,
} from './inventory-order-integration.js'

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

function recipeInventory() {
  const state = createInventoryDomainState({ tenantId: 'mbox', storeId: 'mbox-lujiazui' })
  for (const ingredient of [
    { id: 'ingredient-gin', sku: 'GIN-001', name: '金酒', unit: 'ml', quantity: 1000 },
    { id: 'ingredient-tonic', sku: 'TONIC-001', name: '汤力水', unit: 'ml', quantity: 2000 },
  ]) {
    upsertIngredientSku(state, {
      ingredientSkuId: ingredient.id, sku: ingredient.sku, name: ingredient.name,
      baseUnitCode: ingredient.unit, costAmountPerBaseUnit: 1,
      conversions: [{ unitCode: ingredient.unit, baseQuantity: 1 }], enabled: true,
      actorId: 'emp-chen', reason: '测试原料配置', occurredAt,
      idempotencyKey: `ingredient-config-${ingredient.id}`,
    })
    receiveInventory(state, {
      movementId: `receipt-${ingredient.id}`, productId: ingredient.id, unitCode: ingredient.unit,
      quantity: ingredient.quantity, actorId: 'emp-chen', reason: '测试原料入库',
      businessDate: '2026-07-14', occurredAt, idempotencyKey: `receipt-${ingredient.id}-0001`,
    })
  }
  publishRecipeVersion(state, {
    recipeVersionId: 'recipe-cocktail-v1', productId: 'product-cocktail',
    lines: [
      { ingredientSkuId: 'ingredient-gin', standardQuantity: 45, allowedLossBps: 500 },
      { ingredientSkuId: 'ingredient-tonic', standardQuantity: 120, allowedLossBps: 200 },
    ],
    actorId: 'emp-chen', reason: '发布测试配方', occurredAt,
    idempotencyKey: 'recipe-cocktail-publish-0001',
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

  it('consumes every recipe ingredient and stores the exact version snapshot', () => {
    const state = recipeInventory()
    const submitted = order([line('line-cocktail', 'product-cocktail', 2, 8_800)])

    const movements = consumeManagedInventoryForSubmittedOrder(state, submitted, {
      actorId: 'emp-lin', businessDate: '2026-07-14', occurredAt,
    })

    expect(movements).toHaveLength(2)
    expect(movements).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 'ingredient-gin', quantity: 90, type: 'sale' }),
      expect.objectContaining({ productId: 'ingredient-tonic', quantity: 240, type: 'sale' }),
    ]))
    expect(movements[0]?.configurationSnapshot).toMatchObject({
      kind: 'recipe', consumptionType: 'sale', orderedProductId: 'product-cocktail', orderedQuantity: 2,
      recipe: { id: 'recipe-cocktail-v1', version: 1 },
    })
    expect(state.balances.find((item) => item.productId === 'ingredient-gin')?.onHandQuantity).toBe(910)
    expect(state.balances.find((item) => item.productId === 'ingredient-tonic')?.onHandQuantity).toBe(1760)
  })

  it('records remake consumption separately without changing the original order fact', () => {
    const state = recipeInventory()
    const submitted = order([line('line-cocktail', 'product-cocktail', 1, 8_800)])
    consumeManagedInventoryForSubmittedOrder(state, submitted, {
      actorId: 'emp-lin', businessDate: '2026-07-14', occurredAt,
    })

    const remake = consumeManagedInventoryForRemadeOrderItem(state, submitted, submitted.items[0]!, {
      actorId: 'emp-mia', businessDate: '2026-07-14', occurredAt: '2026-07-14T12:05:00.000Z',
      quantity: 1, reason: '错品补做', idempotencyKey: 'remake-cocktail-0001',
    })

    expect(remake).toHaveLength(2)
    expect(remake.every((movement) => movement.type === 'remake')).toBe(true)
    expect(remake[0]?.configurationSnapshot).toMatchObject({ kind: 'recipe', consumptionType: 'remake' })
    expect(state.movements.filter((movement) => movement.type === 'sale')).toHaveLength(2)
    expect(state.movements.filter((movement) => movement.type === 'remake')).toHaveLength(2)
  })

  it('does not leave partial recipe movements when one ingredient is insufficient', () => {
    const state = recipeInventory()
    state.balances.find((item) => item.productId === 'ingredient-tonic')!.onHandQuantity = 100
    const before = structuredClone(state)
    const submitted = order([line('line-cocktail', 'product-cocktail', 1, 8_800)])

    expect(() => consumeManagedInventoryForSubmittedOrder(state, submitted, {
      actorId: 'emp-lin', businessDate: '2026-07-14', occurredAt,
    })).toThrow('库存不足，禁止产生负库存')
    expect(state).toEqual(before)
  })
})
