import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { GuestSessionResponse } from '../src/shared/guest-contracts.js'
import { registerCommerceRoutes } from './commerce-api.js'
import { registerGuestRoutes } from './guest-api.js'
import { receiveInventory } from './inventory-domain.js'
import { JsonRepository } from './repository.js'
import { requireGuestSession, verifyTableAccessToken } from './table-access.js'

const secret = 'assisted-payment-test-secret-00001'
const now = Date.parse('2026-07-15T12:00:00.000Z')

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

describe('assisted ordering payment flow', () => {
  it('returns an actionable reason when staff orders for a table that is not open', async () => {
    const repository = new JsonRepository(`/tmp/mbox-assisted-table-state-${crypto.randomUUID()}.json`)
    await repository.init()
    const app = Fastify()
    registerTestActor(app)
    registerCommerceRoutes(app, repository, { guestTokenSecret: secret, now: () => now })
    app.setErrorHandler((error, _request, reply) => {
      const candidate = error as Error & { statusCode?: number; code?: string }
      return reply.status(candidate.statusCode ?? 400).send({ code: candidate.code, message: candidate.message })
    })
    const state = await repository.read()
    const table = state.tables.find((candidate) => candidate.status === 'available')!
    const product = state.products.find((candidate) => candidate.enabled)!

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      payload: {
        tableId: table.id,
        items: [{ productId: product.id, quantity: 1 }],
        actorId: 'emp-lin',
        idempotencyKey: 'staff-cart-table-not-open-0001',
      },
    })

    expect(rejected.statusCode).toBe(409)
    expect(rejected.json()).toMatchObject({
      code: 'COMMERCE_TABLE_NOT_OPEN',
      message: '桌台尚未开台或已经翻台，请先开台后再下单',
    })
    await app.close()
    await repository.close()
  })

  it('rejects reuse of a staff cart key for different contents', async () => {
    const repository = new JsonRepository(`/tmp/mbox-assisted-idempotency-${crypto.randomUUID()}.json`)
    await repository.init()
    const app = Fastify()
    registerTestActor(app)
    registerCommerceRoutes(app, repository, { guestTokenSecret: secret, now: () => now })
    app.setErrorHandler((error, _request, reply) => {
      const candidate = error as Error & { statusCode?: number; code?: string }
      return reply.status(candidate.statusCode ?? 400).send({ code: candidate.code, message: candidate.message })
    })
    const state = await repository.read()
    const table = state.tables.find((candidate) => candidate.status === 'occupied')!
    const products = state.products.filter((candidate) => candidate.enabled)
    const payload = {
      tableId: table.id, actorId: 'emp-lin', idempotencyKey: 'staff-cart-conflict-0001',
      items: [{ productId: products[0]!.id, quantity: 1 }],
    }
    expect((await app.inject({ method: 'POST', url: '/api/commerce/orders', payload })).statusCode).toBe(201)
    const conflict = await app.inject({
      method: 'POST', url: '/api/commerce/orders',
      payload: { ...payload, items: [{ productId: products[1]!.id, quantity: 1 }] },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().code).toBe('COMMERCE_ORDER_IDEMPOTENCY_CONFLICT')
    await app.close()
    await repository.close()
  })

  it('syncs one staff order to the guest phone and pays it without duplicating fulfillment', async () => {
    const repository = new JsonRepository(`/tmp/mbox-assisted-payment-${crypto.randomUUID()}.json`)
    await repository.init()
    const app = Fastify()
    registerTestActor(app)
    registerCommerceRoutes(app, repository, {
      guestTokenSecret: secret,
      assistedPaymentTtlMs: 15 * 60_000,
      now: () => now,
    })
    registerGuestRoutes(app, repository, { secret, runtimeMode: 'test', now: () => now })
    app.setErrorHandler((error, _request, reply) => {
      const candidate = error as Error & { statusCode?: number; code?: string }
      return reply.status(candidate.statusCode ?? 400).send({ code: candidate.code, message: candidate.message })
    })

    const initial = await repository.read()
    const table = initial.tables.find((candidate) => candidate.status === 'occupied')!
    const product = initial.products.find((candidate) => candidate.enabled)!
    await repository.mutate((state) => {
      receiveInventory(state.inventoryDomain, {
        movementId: 'assisted-payment-receipt',
        productId: product.id,
        unitCode: 'bottle',
        quantity: 10,
        actorId: 'emp-lin',
        reason: '协助支付测试入库',
        businessDate: state.store.businessDate,
        occurredAt: new Date(now).toISOString(),
        idempotencyKey: 'assisted-payment-receipt-0001',
      })
      state.revision += 1
    })

    const orderResponse = await app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      payload: {
        tableId: table.id,
        items: [{ productId: product.id, quantity: 1 }],
        fulfillmentNote: '先给客人一只冰杯，酒稍后送',
        actorId: 'emp-lin',
        idempotencyKey: 'assisted-cart-order-0001',
      },
    })
    expect(orderResponse.statusCode).toBe(201)
    expect(orderResponse.json()).toMatchObject({
      status: 'submitted',
      fulfillmentNote: '先给客人一只冰杯，酒稍后送',
      amounts: { payableAmount: product.listPriceAmount },
    })
    expect((await repository.read()).orderDomain.kdsTasks).toContainEqual(expect.objectContaining({
      orderId: orderResponse.json().id,
      fulfillmentNote: '先给客人一只冰杯，酒稍后送',
    }))
    const kdsCountBeforePayment = (await repository.read()).orderDomain.kdsTasks.length
    const saleCountBeforePayment = (await repository.read()).inventoryDomain.movements.filter((item) => item.type === 'sale').length

    const linkPayload = { idempotencyKey: 'assisted-payment-link-0001' }
    const linkResponse = await app.inject({
      method: 'POST',
      url: `/api/commerce/orders/${orderResponse.json().id}/payment-link`,
      payload: linkPayload,
    })
    const replayedLink = await app.inject({
      method: 'POST',
      url: `/api/commerce/orders/${orderResponse.json().id}/payment-link`,
      payload: linkPayload,
    })
    expect(linkResponse.statusCode).toBe(201)
    expect(replayedLink.statusCode).toBe(201)
    expect(linkResponse.json()).toMatchObject({ tableCode: table.code, amount: product.listPriceAmount })
    const claims = requireGuestSession(verifyTableAccessToken(linkResponse.json().tableToken, secret, now))
    expect(claims).toMatchObject({ tableSessionId: orderResponse.json().tableSessionId, expiresAt: now + 15 * 60_000 })

    const sessionResponse = await app.inject({
      method: 'GET',
      url: `/api/guest/session?token=${encodeURIComponent(linkResponse.json().tableToken)}`,
    })
    expect(sessionResponse.statusCode).toBe(200)
    const session = sessionResponse.json() as GuestSessionResponse
    expect(session.account.orders).toContainEqual(expect.objectContaining({
      id: orderResponse.json().id,
      status: 'submitted',
      fulfillmentNote: '先给客人一只冰杯，酒稍后送',
    }))

    const checkoutResponse = await app.inject({
      method: 'POST',
      url: '/api/guest/checkout',
      payload: {
        tableToken: session.tableToken,
        orderId: orderResponse.json().id,
        idempotencyKey: 'assisted-guest-checkout-0001',
      },
    })
    expect(checkoutResponse.statusCode).toBe(201)
    expect(checkoutResponse.json()).toMatchObject({
      providerRequired: false,
      paymentIntent: { status: 'succeeded', orderIds: [orderResponse.json().id] },
      order: { status: 'submitted' },
      wechatJsapiParameters: null,
    })

    const final = await repository.read()
    expect(final.orderDomain.kdsTasks).toHaveLength(kdsCountBeforePayment)
    expect(final.inventoryDomain.movements.filter((item) => item.type === 'sale')).toHaveLength(saleCountBeforePayment)
    expect(final.auditEntries.filter((entry) => entry.action === 'commerce.guest_payment_link_issued.v1')).toHaveLength(1)

    const paidLink = await app.inject({
      method: 'POST',
      url: `/api/commerce/orders/${orderResponse.json().id}/payment-link`,
      payload: { idempotencyKey: 'assisted-payment-link-after-paid' },
    })
    expect(paidLink.statusCode).toBe(400)
    expect(paidLink.json().message).toContain('已经支付')

    await app.close()
    await repository.close()
  })
})
