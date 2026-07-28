import { describe, expect, it } from 'vitest'
import type { MenuProduct } from '../src/shared/contracts.js'
import { createOrderDraft, submitOrder } from './order-domain.js'
import { addConfiguredProductToOrder } from './product-order-expansion.js'
import { createSeedState } from './seed.js'

const ORDERED_AT = '2026-07-27T13:00:00.000Z'
const SUBMITTED_AT = '2026-07-27T13:01:00.000Z'

function configuredProduct(state: ReturnType<typeof createSeedState>, productId: string) {
  const product = state.products.find((candidate) => candidate.id === productId)
  if (!product) throw new Error(`测试商品不存在：${productId}`)
  return product
}

function createDraft(state: ReturnType<typeof createSeedState>, orderId: string) {
  return createOrderDraft(state.orderDomain, {
    orderId,
    tableSessionId: `session-${orderId}`,
    createdBy: 'emp-lin',
    occurredAt: ORDERED_AT,
    idempotencyKey: `create-${orderId}`,
  })
}

function addProduct(
  state: ReturnType<typeof createSeedState>,
  orderId: string,
  product: MenuProduct,
  quantity = 1,
) {
  return addConfiguredProductToOrder(state, {
    orderId,
    product,
    quantity,
    actorId: 'emp-lin',
    occurredAt: ORDERED_AT,
    idempotencyKey: `add-${orderId}-${product.id}`,
    linePrefix: 'line',
  })
}

describe('configured bundle order expansion', () => {
  it('creates one charged parent and zero-priced fulfillment children without double-counting', () => {
    const state = createSeedState(new Date(ORDERED_AT))
    const order = createDraft(state, 'order-bundle-amount')
    const bundle = configuredProduct(state, 'product-pair-cocktail-night')

    const expanded = addProduct(state, order.id, bundle, 2)
    const parent = order.items.find((item) => item.id === expanded.parentLineId)
    const children = order.items.filter((item) => item.parentOrderItemId === expanded.parentLineId)

    expect(parent).toMatchObject({
      skuId: bundle.id,
      quantity: 2,
      unitListPriceAmount: bundle.listPriceAmount,
      unitSalePriceAmount: bundle.listPriceAmount,
      commercialLine: true,
      parentOrderItemId: null,
      inventoryTracked: false,
      requiresFulfillment: false,
    })
    expect(children).toHaveLength(2)
    expect(children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skuId: 'product-cocktail',
          quantity: 4,
          unitListPriceAmount: 0,
          unitSalePriceAmount: 0,
          commercialLine: false,
          parentOrderItemId: expanded.parentLineId,
          inventoryTracked: true,
        }),
        expect.objectContaining({
          skuId: 'product-snack',
          quantity: 2,
          unitListPriceAmount: 0,
          unitSalePriceAmount: 0,
          commercialLine: false,
          parentOrderItemId: expanded.parentLineId,
          inventoryTracked: true,
        }),
      ]),
    )
    expect(order.amounts).toEqual({
      grossAmount: bundle.listPriceAmount * 2,
      discountAmount: 0,
      giftAmount: 0,
      payableAmount: bundle.listPriceAmount * 2,
    })
  })

  it('routes bundle components to their own fulfillment workstations', () => {
    const state = createSeedState(new Date(ORDERED_AT))
    const order = createDraft(state, 'order-bundle-routing')
    const bundle = configuredProduct(state, 'product-pair-cocktail-night')

    const expanded = addProduct(state, order.id, bundle)
    submitOrder(state.orderDomain, {
      orderId: order.id,
      submittedBy: 'emp-lin',
      occurredAt: SUBMITTED_AT,
      idempotencyKey: `submit-${order.id}`,
    })

    const parent = order.items.find((item) => item.id === expanded.parentLineId)
    const componentTasks = state.orderDomain.kdsTasks.filter((task) =>
      expanded.componentLineIds.includes(task.orderItemId),
    )

    expect(parent).toMatchObject({
      fulfillmentStatus: 'delivered',
      kdsTaskId: null,
    })
    expect(componentTasks).toHaveLength(2)
    expect(componentTasks.map((task) => task.stationId).sort()).toEqual(['bar-main', 'kitchen-hot'])
    expect(componentTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemName: '招牌鸡尾酒', quantity: 2, status: 'queued' }),
        expect.objectContaining({ itemName: '小食拼盘', quantity: 1, status: 'queued' }),
      ]),
    )
  })

  it('preserves the configured ready-to-serve route from product to KDS', () => {
    const state = createSeedState(new Date(ORDERED_AT))
    const order = createDraft(state, 'order-ready-to-serve')
    const beer = configuredProduct(state, 'product-beer')

    const expanded = addProduct(state, order.id, beer)
    submitOrder(state.orderDomain, {
      orderId: order.id,
      submittedBy: 'emp-lin',
      occurredAt: SUBMITTED_AT,
      idempotencyKey: `submit-${order.id}`,
    })

    expect(order.items.find((item) => item.id === expanded.parentLineId)).toMatchObject({
      fulfillmentType: 'ready_to_serve',
      fulfillmentStatus: 'completed',
    })
    expect(state.orderDomain.kdsTasks.find((task) => task.orderItemId === expanded.parentLineId)).toMatchObject({
      fulfillmentType: 'ready_to_serve',
      status: 'completed',
    })
  })

  it('rejects a bundle whose component is missing or disabled', () => {
    const state = createSeedState(new Date(ORDERED_AT))
    const order = createDraft(state, 'order-invalid-component')
    const bundle: MenuProduct = {
      ...configuredProduct(state, 'product-pair-cocktail-night'),
      id: 'bundle-invalid-component',
      name: '无效组成组合',
      bundleComponents: [{ productId: 'product-does-not-exist', quantity: 1 }],
    }

    expect(() => addProduct(state, order.id, bundle)).toThrow('包含已停用的组成商品')
  })

  it('rejects nested bundle components', () => {
    const state = createSeedState(new Date(ORDERED_AT))
    const order = createDraft(state, 'order-nested-bundle')
    const existingBundle = configuredProduct(state, 'product-pair-cocktail-night')
    const nestedBundle: MenuProduct = {
      ...existingBundle,
      id: 'bundle-nested',
      name: '嵌套组合',
      bundleComponents: [{ productId: existingBundle.id, quantity: 1 }],
    }

    expect(() => addProduct(state, order.id, nestedBundle)).toThrow('包含嵌套组合')
  })
})
