import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { GuestSessionResponse } from '../src/shared/guest-contracts.js'
import type { PaymentProviderAdapter, PaymentProviderSecretSource } from '../src/shared/payment-provider-contracts.js'
import { registerGuestRoutes } from './guest-api.js'
import { registerPaymentRoutes } from './payment-api.js'
import { JsonRepository } from './repository.js'
import { signStaticTableQrToken } from './table-access.js'

describe('guest and assisted Postar payment link', () => {
  it('reuses one QR payment intent and submits a guest order only after a verified callback', async () => {
    const secret = 'guest-postar-payment-secret-0001'
    const repository = new JsonRepository(`/tmp/mbox-guest-postar-${crypto.randomUUID()}.json`)
    await repository.init()
    const initial = await repository.read()
    const table = initial.tables.find((item) => item.status === 'occupied')!
    const product = initial.products.find((item) => item.enabled)!
    let paymentIntentId = ''
    let paymentAmount = 0
    const adapter: PaymentProviderAdapter = {
      provider: 'postar',
      createPayment: vi.fn(async (request) => {
        paymentIntentId = request.paymentIntentId
        paymentAmount = request.amount
        return {
          paymentIntentId,
          providerTransactionId: null,
          status: 'processing' as const,
          amount: request.amount,
          currency: request.currency,
          merchantId: request.merchantId,
          occurredAt: new Date().toISOString(),
          paymentPayload: { presentation: 'qr', qrCodeUrl: `https://pay.postar.example/qr/${paymentIntentId}` },
        }
      }),
      verifyPaymentCallback: vi.fn(async () => {
        return {
          paymentIntentId,
          providerEventId: 'postar-event-guest-001',
          providerTransactionId: 'POSTAR-GUEST-TX-001',
          status: 'succeeded' as const,
          amount: paymentAmount,
          currency: 'CNY',
          merchantId: 'POSTAR-MERCHANT-001',
          settlementChannel: 'unionpay' as const,
          occurredAt: new Date().toISOString(),
        }
      }),
      queryPayment: vi.fn(async () => { throw new Error('not used') }),
      requestRefund: vi.fn(async () => { throw new Error('not used') }),
      queryRefund: vi.fn(async () => { throw new Error('not used') }),
      downloadBill: vi.fn(async () => []),
    }
    const secrets: PaymentProviderSecretSource = { getSecret: vi.fn(async () => 'test-secret') }
    const resolver = () => ({
      adapter,
      secrets,
      merchantId: 'POSTAR-MERCHANT-001',
      callbackUrl: 'https://mbox.example/api/payments/providers/postar/callback',
      callbackAcknowledgement: { rspCod: '000000' as const, rspMsg: 'success' as const },
    })
    const app = Fastify()
    registerGuestRoutes(app, repository, { secret, runtimeMode: 'production', providerResolver: resolver })
    registerPaymentRoutes(app, repository, { providerResolver: resolver })

    const tableToken = signStaticTableQrToken({
      storeId: initial.store.id,
      tableCode: table.code,
      tokenVersion: 1,
      issuedAt: Date.now(),
    }, secret)
    const sessionResponse = await app.inject({
      method: 'GET',
      url: `/api/guest/session?token=${encodeURIComponent(tableToken)}`,
    })
    const session = sessionResponse.json() as GuestSessionResponse
    const orderResponse = await app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      payload: {
        tableToken: session.tableToken,
        items: [{ productId: product.id, quantity: 1 }],
        idempotencyKey: 'guest-postar-order-0001',
      },
    })
    expect(orderResponse.statusCode, orderResponse.body).toBe(201)

    const checkoutPayload = {
      tableToken: session.tableToken,
      orderId: orderResponse.json().id,
      idempotencyKey: 'guest-postar-checkout-0001',
    }
    const checkout = await app.inject({ method: 'POST', url: '/api/guest/checkout', payload: checkoutPayload })
    const replay = await app.inject({ method: 'POST', url: '/api/guest/checkout', payload: checkoutPayload })
    expect(checkout.statusCode, checkout.body).toBe(201)
    expect(replay.statusCode, replay.body).toBe(201)
    expect(checkout.json()).toMatchObject({
      providerRequired: true,
      paymentUrl: `https://pay.postar.example/qr/${paymentIntentId}`,
      paymentIntent: { status: 'processing', channelTransactionId: null },
      order: { status: 'draft' },
    })
    expect(replay.json().paymentIntent.id).toBe(checkout.json().paymentIntent.id)
    expect(adapter.createPayment).toHaveBeenCalledOnce()

    const callback = await app.inject({
      method: 'POST',
      url: '/api/payments/providers/postar/callback',
      payload: { signed: 'provider-evidence' },
    })
    expect(callback.statusCode, callback.body).toBe(200)
    const final = await repository.read()
    expect(final.paymentDomain.paymentIntents.find((item) => item.id === paymentIntentId)).toMatchObject({
      status: 'succeeded',
      channelTransactionId: 'POSTAR-GUEST-TX-001',
      settlementChannel: 'unionpay',
    })
    expect(final.orderDomain.orders.find((item) => item.id === orderResponse.json().id)?.status).toBe('submitted')
    expect(final.orderDomain.kdsTasks.some((item) => item.orderId === orderResponse.json().id)).toBe(true)

    await app.close()
    await repository.close()
  })
})
