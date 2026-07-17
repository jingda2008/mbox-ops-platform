import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerCommerceRoutes } from './commerce-api.js'
import { registerPaymentRoutes } from './payment-api.js'
import { JsonRepository } from './repository.js'
import { receiveInventory } from './inventory-domain.js'
import { anonymousVisitId, MemoryGuestInsightsStore } from './guest-insights.js'

function registerTestActor(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('mboxActor', null)
  app.addHook('preHandler', async (request) => {
    request.mboxActor = {
      actorId: 'emp-lin',
      storeId: 'mbox-lujiazui',
      roleId: 'server',
      runtimeMode: 'test',
      authenticatedBy: 'local_header',
    }
  })
}

describe('commercial API idempotency', () => {
  it('assigns a visit identity and records staff-assisted menu ordering', async () => {
    const repository = new JsonRepository(`/tmp/mbox-assisted-insight-${crypto.randomUUID()}.json`)
    await repository.init()
    const guestInsights = new MemoryGuestInsightsStore()
    const app = Fastify()
    registerTestActor(app)
    registerCommerceRoutes(app, repository, {
      guestTokenSecret: 'q'.repeat(32),
      guestInsights,
    })

    const initial = await repository.read()
    const table = initial.tables.find((item) => item.status === 'occupied')!
    const product = initial.products.find((item) => item.enabled)!
    await repository.mutate((state) => {
      receiveInventory(state.inventoryDomain!, {
        movementId: 'assisted-insight-receipt-1',
        productId: product.id,
        unitCode: 'bottle',
        quantity: 10,
        actorId: 'emp-chen',
        reason: '协助点单匿名行为测试入库',
        businessDate: state.store.businessDate,
        occurredAt: new Date().toISOString(),
        idempotencyKey: 'assisted-insight-receipt-0001',
      })
      state.revision += 1
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      payload: {
        tableId: table.id,
        items: [{ productId: product.id, quantity: 2 }],
        actorId: 'emp-lin',
        idempotencyKey: 'assisted-insight-order-0001',
      },
    })
    expect(response.statusCode).toBe(201)
    expect(guestInsights.events).toEqual([
      expect.objectContaining({
        anonymousId: anonymousVisitId(response.json().tableSessionId),
        tableSessionId: response.json().tableSessionId,
        eventType: 'order_created',
        source: 'staff_assisted',
        metadata: expect.objectContaining({ itemCount: 2 }),
      }),
    ])
    await app.close()
    await repository.close()
  })

  it('replays order and payment creation without duplicate entities or audit entries', async () => {
    const repository = new JsonRepository(`/tmp/mbox-idempotency-${crypto.randomUUID()}.json`)
    await repository.init()
    const app = Fastify()
    registerTestActor(app)
    registerCommerceRoutes(app, repository)
    app.setErrorHandler((error, _request, reply) => reply.status(400).send({ message: error.message }))
    registerPaymentRoutes(app, repository)

    const state = await repository.read()
    const table = state.tables.find((item) => item.status === 'occupied')!
    const product = state.products.find((item) => item.enabled)!
    await repository.mutate((workingState) => {
      receiveInventory(workingState.inventoryDomain!, {
        movementId: 'commercial-receipt-1',
        productId: product.id,
        unitCode: 'bottle',
        quantity: 10,
        actorId: 'emp-chen',
        reason: '商业幂等测试入库',
        businessDate: workingState.store.businessDate,
        occurredAt: new Date().toISOString(),
        idempotencyKey: 'commercial-receipt-0001',
      })
      workingState.revision += 1
    })
    const orderPayload = {
      tableId: table.id,
      productId: product.id,
      quantity: 1,
      actorId: 'emp-lin',
      idempotencyKey: 'commercial-order-retry-0001',
    }
    const firstOrder = await app.inject({ method: 'POST', url: '/api/commerce/quick-orders', payload: orderPayload })
    const replayedOrder = await app.inject({ method: 'POST', url: '/api/commerce/quick-orders', payload: orderPayload })
    expect(firstOrder.statusCode).toBe(201)
    expect(replayedOrder.statusCode).toBe(201)
    expect(replayedOrder.json().id).toBe(firstOrder.json().id)

    const tableSessionId = firstOrder.json().tableSessionId as string
    const paymentPayload = {
      tableSessionId,
      channel: 'wechat_mock',
      actorId: 'emp-lin',
      deviceId: 'cashier-test',
      idempotencyKey: 'commercial-payment-retry-0001',
    }
    const firstPayment = await app.inject({ method: 'POST', url: '/api/payments/table-intents', payload: paymentPayload })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const replayedPayment = await app.inject({ method: 'POST', url: '/api/payments/table-intents', payload: paymentPayload })
    expect(firstPayment.statusCode).toBe(201)
    expect(replayedPayment.statusCode).toBe(201)
    expect(replayedPayment.json().id).toBe(firstPayment.json().id)

    const finalState = await repository.read()
    expect(finalState.orderDomain.orders.filter((item) => item.id === firstOrder.json().id)).toHaveLength(1)
    expect(finalState.paymentDomain.paymentIntents.filter((item) => item.id === firstPayment.json().id)).toHaveLength(1)
    expect(finalState.auditEntries.filter((entry) => entry.action === 'commerce.quick_order.v1')).toHaveLength(1)
    expect(finalState.auditEntries.filter((entry) => entry.action === 'payment.intent.created.v1')).toHaveLength(1)
    expect(finalState.inventoryDomain?.movements.filter((movement) => movement.type === 'sale')).toEqual([
      expect.objectContaining({
        productId: product.id,
        orderId: firstOrder.json().id,
        orderItemId: firstOrder.json().items[0].id,
        tableSessionId,
        businessDate: finalState.store.businessDate,
      }),
    ])
    expect(finalState.inventoryDomain?.balances.find((balance) => balance.productId === product.id)?.onHandQuantity).toBe(9)

    await app.close()
    await repository.close()
  })

  it('rolls back the quick order, KDS and inventory when managed stock is insufficient', async () => {
    const repository = new JsonRepository(`/tmp/mbox-stock-rollback-${crypto.randomUUID()}.json`)
    await repository.init()
    const app = Fastify()
    registerTestActor(app)
    registerCommerceRoutes(app, repository)
    app.setErrorHandler((error, _request, reply) => reply.status(400).send({ message: error.message }))

    const initial = await repository.read()
    const table = initial.tables.find((item) => item.status === 'occupied')!
    const product = initial.products.find((item) => item.enabled)!
    await repository.mutate((state) => {
      receiveInventory(state.inventoryDomain!, {
        movementId: 'rollback-receipt-1',
        productId: product.id,
        unitCode: 'bottle',
        quantity: 1,
        actorId: 'emp-chen',
        reason: '库存不足回滚测试入库',
        businessDate: state.store.businessDate,
        occurredAt: new Date().toISOString(),
        idempotencyKey: 'rollback-receipt-0001',
      })
      state.revision += 1
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/commerce/quick-orders',
      payload: {
        tableId: table.id,
        productId: product.id,
        quantity: 2,
        actorId: 'emp-lin',
        idempotencyKey: 'commercial-stock-shortage-0001',
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('库存不足')

    const finalState = await repository.read()
    expect(finalState.orderDomain.orders).toHaveLength(0)
    expect(finalState.orderDomain.kdsTasks).toHaveLength(0)
    expect(finalState.orderDomain.tableLedgerEntries).toHaveLength(0)
    expect(finalState.auditEntries.filter((entry) => entry.action === 'commerce.quick_order.v1')).toHaveLength(0)
    expect(finalState.inventoryDomain?.balances.find((balance) => balance.productId === product.id)?.onHandQuantity).toBe(1)
    expect(finalState.inventoryDomain?.movements).toHaveLength(1)

    await app.close()
    await repository.close()
  })
})
