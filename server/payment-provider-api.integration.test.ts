import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { PaymentProviderAdapter, PaymentProviderSecretSource } from '../src/shared/payment-provider-contracts.js'
import { addOrderItem, createOrderDraft, submitOrder } from './order-domain.js'
import { createPaymentDomainState } from './payment-domain.js'
import { registerPaymentRoutes } from './payment-api.js'
import type { RuntimeRepository } from './repository.js'
import { createSeedState } from './seed.js'

describe('payment provider API mainline', () => {
  it('runs provider order, verified callback, active query and item refund without synchronous fake success', async () => {
    let state = createSeedState()
    state.paymentDomain = createPaymentDomainState()
    const tableSession = state.songState.tableSessions.find((item) => item.status === 'open')!
    const product = state.products.find((item) => item.enabled)!
    createOrderDraft(state.orderDomain, {
      orderId: 'provider-api-order', tableSessionId: tableSession.id, createdBy: 'emp-cashier',
      occurredAt: new Date(Date.now() - 3_000).toISOString(), idempotencyKey: 'provider-api-order-draft',
    })
    addOrderItem(state.orderDomain, {
      orderId: 'provider-api-order', actorId: 'emp-cashier', occurredAt: new Date(Date.now() - 2_000).toISOString(),
      idempotencyKey: 'provider-api-order-item',
      item: {
        id: 'provider-api-line', skuId: product.id, name: product.name, specification: product.specification,
        quantity: 1, unitListPriceAmount: product.listPriceAmount, unitSalePriceAmount: product.listPriceAmount,
        unitCostAmount: product.costAmount, stationId: product.stationId, configVersion: product.configVersion,
      },
    })
    submitOrder(state.orderDomain, {
      orderId: 'provider-api-order', submittedBy: 'emp-cashier', occurredAt: new Date(Date.now() - 1_000).toISOString(),
      idempotencyKey: 'provider-api-order-submit',
    })

    let providerIntentId = ''
    let repositoryMutationActive = false
    const now = () => new Date().toISOString()
    const adapter: PaymentProviderAdapter = {
      provider: 'postar',
      createPayment: vi.fn(async (request) => {
        expect(repositoryMutationActive).toBe(false)
        expect(request.presentation).toBe('barcode')
        expect(request.customerAuthCode).toBe('101234567890123456')
        providerIntentId = request.paymentIntentId
        return {
          paymentIntentId: request.paymentIntentId, providerTransactionId: 'POSTAR-TX-001', status: 'processing' as const,
          amount: request.amount, currency: request.currency, merchantId: request.merchantId,
          occurredAt: now(), paymentPayload: { presentation: 'barcode', providerState: 'processing' },
        }
      }),
      verifyPaymentCallback: vi.fn(async () => ({
        paymentIntentId: providerIntentId, providerEventId: 'POSTAR-EVENT-001', providerTransactionId: 'POSTAR-TX-001',
        status: 'succeeded' as const, amount: product.listPriceAmount, currency: 'CNY', merchantId: 'POSTAR-MERCHANT-001',
        settlementChannel: 'wechat' as const, occurredAt: now(),
      })),
      queryPayment: vi.fn(async () => ({
        paymentIntentId: providerIntentId, providerTransactionId: 'POSTAR-TX-001', status: 'succeeded' as const,
        amount: product.listPriceAmount, currency: 'CNY', merchantId: 'POSTAR-MERCHANT-001', occurredAt: now(),
      })),
      requestRefund: vi.fn(async (request) => {
        expect(repositoryMutationActive).toBe(false)
        return {
          refundId: request.refundId, providerRefundId: 'POSTAR-REFUND-001', providerRefundTransactionId: null,
          status: 'processing' as const, amount: request.amount, currency: request.currency, occurredAt: now(),
        }
      }),
      queryRefund: vi.fn(async (request) => ({
        refundId: request.refundId, providerRefundId: request.providerRefundId,
        providerRefundTransactionId: 'POSTAR-REFUND-TX-001', status: 'succeeded' as const,
        amount: product.listPriceAmount, currency: 'CNY', occurredAt: now(),
      })),
      downloadBill: vi.fn(async () => []),
    }
    const secrets: PaymentProviderSecretSource = { getSecret: vi.fn(async () => 'secret') }
    const repository: RuntimeRepository = {
      init: async () => undefined,
      read: async () => structuredClone(state),
      mutate: async (mutation) => {
        const working = structuredClone(state)
        repositoryMutationActive = true
        try {
          const result = await mutation(working)
          state = working
          return result
        } finally {
          repositoryMutationActive = false
        }
      },
      reset: async () => structuredClone(state),
      healthCheck: async () => ({ ready: true, repository: 'test', revision: state.revision }),
      close: async () => undefined,
    }
    const actor = { id: 'emp-cashier', roleId: 'cashier' }
    const app = Fastify()
    app.addHook('preHandler', async (request) => {
      request.mboxActor = {
        actorId: actor.id, storeId: state.store.id, roleId: actor.roleId, runtimeMode: 'test', authenticatedBy: 'local_header',
      }
    })
    registerPaymentRoutes(app, repository, {
      providerResolver: () => ({
        adapter, secrets, merchantId: 'POSTAR-MERCHANT-001',
        callbackUrl: 'https://pay.example.test/api/payments/providers/postar/callback',
        callbackAcknowledgement: { rspCod: '000000', rspMsg: 'success' },
      }),
    })

    const intentResponse = await app.inject({
      method: 'POST', url: '/api/payments/table-intents',
      payload: {
        tableSessionId: tableSession.id, channel: 'postar', allocation: { mode: 'items', items: [{ orderId: 'provider-api-order', orderItemId: 'provider-api-line', quantity: 1 }] },
        providerPayment: { presentation: 'barcode', customerAuthCode: '101234567890123456' },
        deviceId: 'cashier-test', idempotencyKey: 'provider-api-intent-0001',
      },
    })
    expect(intentResponse.statusCode, intentResponse.body).toBe(201)
    expect(intentResponse.json()).toMatchObject({
      status: 'processing',
      channelTransactionId: 'POSTAR-TX-001',
      providerPaymentPayload: { presentation: 'barcode', providerState: 'processing' },
    })
    expect(JSON.stringify(await repository.read())).not.toContain('101234567890123456')
    expect(intentResponse.json().status).not.toBe('succeeded')

    const callbackResponse = await app.inject({
      method: 'POST', url: '/api/payments/providers/postar/callback', payload: { signed: 'opaque-provider-evidence' },
    })
    expect(callbackResponse.statusCode, callbackResponse.body).toBe(200)
    expect(callbackResponse.json()).toEqual({ rspCod: '000000', rspMsg: 'success' })
    expect((await repository.read()).paymentDomain.paymentIntents[0]).toMatchObject({
      status: 'succeeded', channelTransactionId: 'POSTAR-TX-001', settlementChannel: 'wechat',
    })

    const queryResponse = await app.inject({
      method: 'POST', url: `/api/payments/${providerIntentId}/provider-query`,
      payload: { idempotencyKey: 'provider-api-query-0001' },
    })
    expect(queryResponse.statusCode, queryResponse.body).toBe(200)
    expect(queryResponse.json().resultStatus).toBe('succeeded')

    actor.id = 'emp-lin'; actor.roleId = 'server'
    const refundResponse = await app.inject({
      method: 'POST', url: `/api/payments/${providerIntentId}/refunds`,
      payload: {
        orderId: 'provider-api-order', orderItemId: 'provider-api-line', quantity: 1, reason: '客人退回商品',
        idempotencyKey: 'provider-api-refund-request-0001',
      },
    })
    expect(refundResponse.statusCode, refundResponse.body).toBe(201)
    actor.id = 'emp-chen'; actor.roleId = 'manager'
    const submitRefundResponse = await app.inject({
      method: 'POST', url: `/api/payments/refunds/${refundResponse.json().id}/provider-submit`,
      payload: { reason: '经理复核通过', idempotencyKey: 'provider-api-refund-submit-0001' },
    })
    expect(submitRefundResponse.statusCode, submitRefundResponse.body).toBe(200)
    expect(submitRefundResponse.json().status).toBe('processing')
    const queryRefundResponse = await app.inject({
      method: 'POST', url: `/api/payments/refunds/${refundResponse.json().id}/provider-query`,
      payload: { idempotencyKey: 'provider-api-refund-query-0001' },
    })
    expect(queryRefundResponse.statusCode, queryRefundResponse.body).toBe(200)
    expect(queryRefundResponse.json()).toMatchObject({ status: 'succeeded', channelRefundTransactionId: 'POSTAR-REFUND-TX-001' })
    expect(adapter.createPayment).toHaveBeenCalledOnce()
    expect(adapter.verifyPaymentCallback).toHaveBeenCalledOnce()
    expect(adapter.requestRefund).toHaveBeenCalledOnce()
    expect(adapter.queryRefund).toHaveBeenCalledOnce()
    await app.close()
  })
})
