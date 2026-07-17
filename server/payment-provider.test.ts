import { describe, expect, it, vi } from 'vitest'
import type {
  PaymentProviderAdapter,
  PaymentProviderContext,
  PaymentProviderSecretSource,
  ProviderCreatePaymentResult,
  ProviderPaymentObservation,
  ProviderRefundObservation,
  RawPaymentProviderCallback,
  VerifiedProviderPaymentCallback,
} from '../src/shared/payment-provider-contracts.js'
import {
  approveRefund,
  createPaymentDomainState,
  createPaymentIntent,
  requestRefund,
} from './payment-domain.js'
import {
  applyProviderPaymentCreation,
  createPaymentThroughProvider,
  processPaymentProviderCallback,
  queryPaymentThroughProvider,
  queryRefundThroughProvider,
  submitRefundThroughProvider,
} from './payment-provider.js'

const CREATED_AT = '2026-07-14T12:00:00.000Z'
const secrets: PaymentProviderSecretSource = {
  getSecret: vi.fn(async () => 'injected-test-secret'),
}

function paymentObservation(
  overrides: Partial<ProviderPaymentObservation> = {},
): ProviderPaymentObservation {
  return {
    paymentIntentId: 'pay-1',
    providerTransactionId: 'provider-tx-1',
    status: 'succeeded',
    amount: 3000,
    currency: 'CNY',
    merchantId: 'merchant-mbox',
    occurredAt: '2026-07-14T12:01:00.000Z',
    ...overrides,
  }
}

function verifiedCallbackObservation(): VerifiedProviderPaymentCallback {
  return { ...paymentObservation(), providerEventId: 'event-1' }
}

function fakeAdapter(overrides: Partial<PaymentProviderAdapter> = {}): PaymentProviderAdapter {
  return {
    provider: 'provider-a',
    createPayment: vi.fn<PaymentProviderAdapter['createPayment']>(async (request): Promise<ProviderCreatePaymentResult> => ({
      paymentIntentId: request.paymentIntentId,
      providerTransactionId: 'provider-order-1',
      status: 'processing',
      amount: request.amount,
      currency: request.currency,
      merchantId: request.merchantId,
      occurredAt: '2026-07-14T12:00:30.000Z',
      paymentPayload: { token: 'provider-payment-token' },
    })),
    verifyPaymentCallback: vi.fn<PaymentProviderAdapter['verifyPaymentCallback']>(
      async () => verifiedCallbackObservation(),
    ),
    queryPayment: vi.fn<PaymentProviderAdapter['queryPayment']>(
      async () => paymentObservation(),
    ),
    requestRefund: vi.fn<PaymentProviderAdapter['requestRefund']>(async (request) => ({
      refundId: request.refundId,
      providerRefundId: 'provider-refund-1',
      providerRefundTransactionId: null,
      status: 'processing',
      amount: request.amount,
      currency: request.currency,
      occurredAt: '2026-07-14T12:06:00.000Z',
    })),
    queryRefund: vi.fn<PaymentProviderAdapter['queryRefund']>(async (request) => ({
      refundId: request.refundId,
      providerRefundId: request.providerRefundId,
      providerRefundTransactionId: 'provider-refund-tx-1',
      status: 'succeeded',
      amount: 1200,
      currency: 'CNY',
      occurredAt: '2026-07-14T12:07:00.000Z',
    })),
    downloadBill: vi.fn<PaymentProviderAdapter['downloadBill']>(async () => []),
    ...overrides,
  }
}

function stateWithIntent() {
  const state = createPaymentDomainState()
  createPaymentIntent(state, {
    paymentIntentId: 'pay-1',
    tableSessionId: 'table-session-A',
    lineAllocations: [
      { orderId: 'order-A', orderItemId: 'line-A1', quantity: 2, unitPaidAmount: 1200 },
      { orderId: 'order-A', orderItemId: 'line-A2', quantity: 1, unitPaidAmount: 600 },
    ],
    amount: 3000,
    currency: 'CNY',
    channel: 'provider-a',
    merchantId: 'merchant-mbox',
    createdBy: 'cashier-1',
    deviceId: 'cashier-pc-1',
    occurredAt: CREATED_AT,
    expiresAt: '2026-07-14T12:15:00.000Z',
    idempotencyKey: 'create-pay-1',
  })
  return state
}

function callback(): RawPaymentProviderCallback {
  return {
    rawBody: new TextEncoder().encode('{"provider":"opaque"}'),
    headers: { 'x-provider-signature': 'opaque-signature' },
    receivedAt: '2026-07-14T12:01:01.000Z',
  }
}

async function markIntentPaid(state: ReturnType<typeof stateWithIntent>) {
  await processPaymentProviderCallback({
    state,
    adapter: fakeAdapter(),
    secrets,
    callback: callback(),
  })
}

describe('payment provider callback boundary', () => {
  it('moves a provider order only to processing and preserves the provider payment payload', async () => {
    const state = stateWithIntent()
    const intent = await createPaymentThroughProvider({
      state,
      adapter: fakeAdapter(),
      secrets,
      request: {
        paymentIntentId: 'pay-1', merchantId: 'merchant-mbox', amount: 3000, currency: 'CNY',
        expiresAt: '2026-07-14T12:15:00.000Z', presentation: 'jsapi', payWay: 'wechat', payerId: 'openid-1',
        clientIp: '127.0.0.1', callbackUrl: 'https://example.test/postar/callback', operatorId: 'cashier-1',
        remark: 'table A', wxAppid: 'wx-app-1',
      },
    })
    expect(intent.status).toBe('processing')
    expect(intent.channelTransactionId).toBe('provider-order-1')
    expect(intent.providerPaymentPayload).toEqual({ token: 'provider-payment-token' })
  })

  it('passes raw evidence and injected secrets to verification before changing domain state', async () => {
    const state = stateWithIntent()
    const verifier = vi.fn(
      async (_callback: RawPaymentProviderCallback, context: PaymentProviderContext) => {
        expect(context.secrets).toBe(secrets)
        throw new Error('signature invalid')
      },
    )
    const adapter = fakeAdapter({ verifyPaymentCallback: verifier })

    await expect(
      processPaymentProviderCallback({ state, adapter, secrets, callback: callback() }),
    ).rejects.toThrow('signature invalid')
    expect(verifier.mock.calls[0]?.[0].rawBody).toEqual(callback().rawBody)
    expect(state.paymentNotifications).toHaveLength(0)
    expect(state.paymentIntents[0]?.status).toBe('pending')
  })

  it('records a verified duplicate callback exactly once', async () => {
    const state = stateWithIntent()
    const adapter = fakeAdapter()
    const input = { state, adapter, secrets, callback: callback() }

    const first = await processPaymentProviderCallback(input)
    const duplicate = await processPaymentProviderCallback(input)

    expect(duplicate).toBe(first)
    expect(state.paymentNotifications).toHaveLength(1)
    expect(state.paymentIntents[0]?.status).toBe('succeeded')
  })

  it('keeps a verified success when the callback wins the race with order creation persistence', async () => {
    const state = stateWithIntent()
    await markIntentPaid(state)
    const intent = applyProviderPaymentCreation(state, 'provider-a', {
      paymentIntentId: 'pay-1', merchantId: 'merchant-mbox', amount: 3000, currency: 'CNY',
      expiresAt: '2026-07-14T12:15:00.000Z', presentation: 'barcode', customerAuthCode: '101234567890123456',
      clientIp: '127.0.0.1', callbackUrl: 'https://example.test/postar/callback', operatorId: 'cashier-1',
      remark: 'table A',
    }, {
      paymentIntentId: 'pay-1', providerTransactionId: 'provider-tx-1', status: 'processing', amount: 3000,
      currency: 'CNY', merchantId: 'merchant-mbox', occurredAt: '2026-07-14T12:00:30.000Z',
      paymentPayload: { presentation: 'barcode', providerState: 'accepted' },
    })

    expect(intent.status).toBe('succeeded')
    expect(intent.channelTransactionId).toBe('provider-tx-1')
    expect(intent.providerPaymentPayload).toEqual({ presentation: 'barcode', providerState: 'accepted' })
  })
})

describe('provider active query and partial refund', () => {
  it('uses active query to recover a succeeded payment without a callback', async () => {
    const state = stateWithIntent()
    const queryPayment = vi.fn<PaymentProviderAdapter['queryPayment']>(
      async () => paymentObservation(),
    )
    const adapter = fakeAdapter({ queryPayment })

    const query = await queryPaymentThroughProvider({
      state,
      adapter,
      secrets,
      paymentIntentId: 'pay-1',
      queryId: 'query-1',
      requestedBy: 'cashier-1',
      occurredAt: '2026-07-14T12:02:00.000Z',
      receivedAt: '2026-07-14T12:02:01.000Z',
      idempotencyKey: 'provider-query-1',
    })

    expect(query.status).toBe('completed')
    expect(state.paymentIntents[0]?.status).toBe('succeeded')
    expect(queryPayment.mock.calls[0]?.[1].secrets).toBe(secrets)
  })

  it('submits only an approved item-level partial refund and applies its queried result', async () => {
    const state = stateWithIntent()
    await markIntentPaid(state)
    const refund = requestRefund(state, {
      refundId: 'refund-1',
      paymentIntentId: 'pay-1',
      items: [{ orderId: 'order-A', orderItemId: 'line-A1', quantity: 1 }],
      reason: '退回一件',
      requestedBy: 'server-1',
      occurredAt: '2026-07-14T12:04:00.000Z',
      idempotencyKey: 'refund-request-1',
    })
    const requestProviderRefund = vi.fn<PaymentProviderAdapter['requestRefund']>(
      async (request): Promise<ProviderRefundObservation> => ({
        refundId: request.refundId,
        providerRefundId: 'provider-refund-1',
        providerRefundTransactionId: null,
        status: 'processing',
        amount: request.amount,
        currency: request.currency,
        occurredAt: '2026-07-14T12:06:00.000Z',
      }),
    )
    const adapter = fakeAdapter({ requestRefund: requestProviderRefund })

    await expect(
      submitRefundThroughProvider({
        state,
        adapter,
        secrets,
        refundId: refund.id,
        actorId: 'cashier-1',
        idempotencyKey: 'provider-refund-submit-1',
      }),
    ).rejects.toThrow('只有已批准或渠道失败的退款可以提交渠道')
    expect(requestProviderRefund).not.toHaveBeenCalled()

    approveRefund(state, {
      refundId: refund.id,
      approvedBy: 'manager-1',
      reason: '核验通过',
      occurredAt: '2026-07-14T12:05:00.000Z',
      idempotencyKey: 'refund-approve-1',
    })
    await submitRefundThroughProvider({
      state,
      adapter,
      secrets,
      refundId: refund.id,
      actorId: 'cashier-1',
      idempotencyKey: 'provider-refund-submit-1',
    })

    expect(requestProviderRefund.mock.calls[0]?.[0].items).toEqual([
      { orderId: 'order-A', orderItemId: 'line-A1', quantity: 1, unitPaidAmount: 1200, amount: 1200 },
    ])
    expect(refund.status).toBe('processing')

    await queryRefundThroughProvider({
      state,
      adapter,
      secrets,
      refundId: refund.id,
      requestedBy: 'cashier-1',
      idempotencyKey: 'provider-refund-query-1',
    })
    expect(refund.status).toBe('succeeded')
    expect(refund.channelRefundTransactionId).toBe('provider-refund-tx-1')
  })

  it('submits a failed provider refund again only under a new idempotency key', async () => {
    const state = stateWithIntent()
    await markIntentPaid(state)
    const refund = requestRefund(state, {
      refundId: 'refund-retry-provider', paymentIntentId: 'pay-1',
      items: [{ orderId: 'order-A', orderItemId: 'line-A1', quantity: 1 }],
      reason: '渠道失败重试', requestedBy: 'server-1',
      occurredAt: '2026-07-14T12:04:00.000Z', idempotencyKey: 'refund-provider-retry-request',
    })
    approveRefund(state, {
      refundId: refund.id, approvedBy: 'manager-1', reason: '复核通过',
      occurredAt: '2026-07-14T12:05:00.000Z', idempotencyKey: 'refund-provider-retry-approve',
    })
    const requestProviderRefund = vi.fn<PaymentProviderAdapter['requestRefund']>()
      .mockResolvedValueOnce({
        refundId: refund.id, providerRefundId: 'provider-refund-failed', providerRefundTransactionId: null,
        status: 'failed', amount: refund.amount, currency: refund.currency,
        occurredAt: '2026-07-14T12:06:00.000Z', failureReason: '渠道繁忙',
      })
      .mockResolvedValueOnce({
        refundId: refund.id, providerRefundId: 'provider-refund-retry', providerRefundTransactionId: 'provider-refund-tx-retry',
        status: 'succeeded', amount: refund.amount, currency: refund.currency,
        occurredAt: '2026-07-14T12:07:00.000Z',
      })
    const adapter = fakeAdapter({ requestRefund: requestProviderRefund })

    await submitRefundThroughProvider({
      state, adapter, secrets, refundId: refund.id, actorId: 'cashier-1', idempotencyKey: 'refund-provider-submit-1',
    })
    expect(refund.status).toBe('failed')
    await submitRefundThroughProvider({
      state, adapter, secrets, refundId: refund.id, actorId: 'cashier-1', idempotencyKey: 'refund-provider-submit-2',
    })
    const replay = await submitRefundThroughProvider({
      state, adapter, secrets, refundId: refund.id, actorId: 'cashier-1', idempotencyKey: 'refund-provider-submit-2',
    })

    expect(requestProviderRefund).toHaveBeenCalledTimes(2)
    expect(replay).toBe(refund)
    expect(refund).toMatchObject({
      status: 'succeeded', channelRefundId: 'provider-refund-retry',
      channelRefundTransactionId: 'provider-refund-tx-retry', failureReason: null,
    })
  })
})
