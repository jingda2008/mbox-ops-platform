import { describe, expect, it } from 'vitest'
import type { CreatePaymentIntentCommand } from '../src/shared/payment-contracts.js'
import {
  approveRefund,
  buildSettlementChannelSummaries,
  createPaymentDomainState,
  createPaymentIntent,
  handlePaymentNotification,
  markRefundFailed,
  markRefundSucceeded,
  rejectRefund,
  requestRefund,
  startRefund,
} from './payment-domain.js'

const CREATED_AT = '2026-07-30T12:00:00.000Z'

function createPaidIntent(
  state: ReturnType<typeof createPaymentDomainState>,
  overrides: Partial<CreatePaymentIntentCommand> = {},
) {
  const command: CreatePaymentIntentCommand = {
    paymentIntentId: 'pay-refund-1',
    tableSessionId: 'table-session-l01',
    lineAllocations: [
      { orderId: 'order-refund-1', orderItemId: 'line-cocktail', quantity: 2, unitPaidAmount: 8_800 },
      { orderId: 'order-refund-1', orderItemId: 'line-snack', quantity: 1, unitPaidAmount: 6_800 },
    ],
    amount: 24_400,
    currency: 'CNY',
    channel: 'wechat_mock',
    merchantId: 'merchant-mbox',
    createdBy: 'emp-cashier',
    deviceId: 'cashier-pc',
    occurredAt: CREATED_AT,
    expiresAt: '2026-07-30T12:15:00.000Z',
    idempotencyKey: 'create-pay-refund-1',
    businessDate: '2026-07-30',
    ...overrides,
  }
  const intent = createPaymentIntent(state, command)
  handlePaymentNotification(state, {
    channel: intent.channel,
    notificationId: `notice-${intent.id}`,
    paymentIntentId: intent.id,
    channelTransactionId: `channel-${intent.id}`,
    status: 'succeeded',
    amount: intent.amount,
    currency: intent.currency,
    merchantId: intent.merchantId,
    settlementChannel: 'wechat',
    signatureVerified: true,
    channelOccurredAt: '2026-07-30T12:01:00.000Z',
    receivedAt: '2026-07-30T12:01:01.000Z',
  })
  return intent
}

function requestCocktailRefund(
  state: ReturnType<typeof createPaymentDomainState>,
  refundId: string,
  quantity = 1,
) {
  return requestRefund(state, {
    refundId,
    paymentIntentId: 'pay-refund-1',
    items: [{ orderId: 'order-refund-1', orderItemId: 'line-cocktail', quantity }],
    reason: '现场退回鸡尾酒',
    requestedBy: 'emp-server',
    occurredAt: '2026-07-30T12:02:00.000Z',
    idempotencyKey: `${refundId}:request`,
  })
}

function approveAndStart(
  state: ReturnType<typeof createPaymentDomainState>,
  refundId: string,
) {
  approveRefund(state, {
    refundId,
    approvedBy: 'emp-manager',
    reason: '经理核对商品与付款记录',
    occurredAt: '2026-07-30T12:03:00.000Z',
    idempotencyKey: `${refundId}:approve`,
  })
  return startRefund(state, {
    refundId,
    channelRefundId: `channel-${refundId}`,
    actorId: 'emp-manager',
    occurredAt: '2026-07-30T12:04:00.000Z',
    idempotencyKey: `${refundId}:start`,
  })
}

describe('complex on-site refund operations', () => {
  it('refunds a complete multi-item order from original paid allocations', () => {
    const state = createPaymentDomainState()
    createPaidIntent(state)

    const refund = requestRefund(state, {
      refundId: 'refund-full-order',
      paymentIntentId: 'pay-refund-1',
      items: [
        { orderId: 'order-refund-1', orderItemId: 'line-cocktail', quantity: 2 },
        { orderId: 'order-refund-1', orderItemId: 'line-snack', quantity: 1 },
      ],
      reason: '经理批准整单退回',
      requestedBy: 'emp-server',
      occurredAt: '2026-07-30T12:02:00.000Z',
      idempotencyKey: 'refund-full-order:request',
    })

    expect(refund.amount).toBe(24_400)
    expect(refund.items).toEqual([
      expect.objectContaining({ orderItemId: 'line-cocktail', quantity: 2, amount: 17_600 }),
      expect.objectContaining({ orderItemId: 'line-snack', quantity: 1, amount: 6_800 }),
    ])
  })

  it('keeps a failed refund reserved because the same refund remains retryable', () => {
    const state = createPaymentDomainState()
    createPaidIntent(state)
    requestCocktailRefund(state, 'refund-failed', 2)
    approveAndStart(state, 'refund-failed')
    markRefundFailed(state, {
      refundId: 'refund-failed',
      reason: '渠道暂时不可用',
      occurredAt: '2026-07-30T12:05:00.000Z',
      idempotencyKey: 'refund-failed:failed',
    })

    expect(() => requestCocktailRefund(state, 'refund-duplicate-after-failure')).toThrow(
      '商品累计退款数量超过原支付数量',
    )
    expect(startRefund(state, {
      refundId: 'refund-failed',
      channelRefundId: 'channel-refund-failed-retry',
      actorId: 'emp-manager',
      occurredAt: '2026-07-30T12:06:00.000Z',
      idempotencyKey: 'refund-failed:retry',
    })).toMatchObject({ status: 'processing', channelRefundId: 'channel-refund-failed-retry' })
  })

  it('releases rejected quantities so a corrected refund can be requested', () => {
    const state = createPaymentDomainState()
    createPaidIntent(state)
    requestCocktailRefund(state, 'refund-rejected', 2)
    rejectRefund(state, {
      refundId: 'refund-rejected',
      rejectedBy: 'emp-manager',
      reason: '现场数量填写错误',
      occurredAt: '2026-07-30T12:03:00.000Z',
      idempotencyKey: 'refund-rejected:reject',
    })

    expect(requestCocktailRefund(state, 'refund-corrected', 1)).toMatchObject({
      status: 'requested',
      amount: 8_800,
    })
  })

  it('keeps mixed-payment refunds attached to the payment that funded each item', () => {
    const state = createPaymentDomainState()
    createPaidIntent(state, {
      paymentIntentId: 'pay-refund-1',
      lineAllocations: [
        { orderId: 'order-refund-1', orderItemId: 'line-cocktail', quantity: 2, unitPaidAmount: 8_800 },
      ],
      amount: 17_600,
      idempotencyKey: 'create-pay-refund-1',
    })
    createPaidIntent(state, {
      paymentIntentId: 'pay-refund-2',
      lineAllocations: [
        { orderId: 'order-refund-1', orderItemId: 'line-snack', quantity: 1, unitPaidAmount: 6_800 },
      ],
      amount: 6_800,
      channel: 'alipay_mock',
      idempotencyKey: 'create-pay-refund-2',
    })

    expect(() => requestRefund(state, {
      refundId: 'refund-wrong-channel',
      paymentIntentId: 'pay-refund-1',
      items: [{ orderId: 'order-refund-1', orderItemId: 'line-snack', quantity: 1 }],
      reason: '错误地从微信支付退另一渠道商品',
      requestedBy: 'emp-server',
      occurredAt: '2026-07-30T12:02:00.000Z',
      idempotencyKey: 'refund-wrong-channel:request',
    })).toThrow('退款商品不属于原支付意图')

    expect(requestRefund(state, {
      refundId: 'refund-pos-item',
      paymentIntentId: 'pay-refund-2',
      items: [{ orderId: 'order-refund-1', orderItemId: 'line-snack', quantity: 1 }],
      reason: '按原支付渠道退回小食',
      requestedBy: 'emp-server',
      occurredAt: '2026-07-30T12:02:00.000Z',
      idempotencyKey: 'refund-pos-item:request',
    })).toMatchObject({ paymentIntentId: 'pay-refund-2', amount: 6_800 })
  })

  it('rejects channel amount and currency mismatches without claiming success', () => {
    const state = createPaymentDomainState()
    createPaidIntent(state)
    const refund = requestCocktailRefund(state, 'refund-mismatch')
    approveAndStart(state, refund.id)

    expect(() => markRefundSucceeded(state, {
      refundId: refund.id,
      channelRefundTransactionId: 'refund-tx-wrong-amount',
      refundedAmount: refund.amount - 1,
      currency: refund.currency,
      occurredAt: '2026-07-30T12:05:00.000Z',
      idempotencyKey: 'refund-mismatch:wrong-amount',
    })).toThrow('渠道退款金额与商品退款金额不一致')
    expect(() => markRefundSucceeded(state, {
      refundId: refund.id,
      channelRefundTransactionId: 'refund-tx-wrong-currency',
      refundedAmount: refund.amount,
      currency: 'USD',
      occurredAt: '2026-07-30T12:05:00.000Z',
      idempotencyKey: 'refund-mismatch:wrong-currency',
    })).toThrow('渠道退款币种不一致')
    expect(refund.status).toBe('processing')
    expect(refund.channelRefundTransactionId).toBeNull()
  })

  it('never lets one channel refund transaction settle two refund requests', () => {
    const state = createPaymentDomainState()
    createPaidIntent(state)
    createPaidIntent(state, {
      paymentIntentId: 'pay-refund-2',
      lineAllocations: [
        { orderId: 'order-refund-2', orderItemId: 'line-wine', quantity: 1, unitPaidAmount: 12_800 },
      ],
      amount: 12_800,
      idempotencyKey: 'create-pay-refund-2',
    })
    const first = requestCocktailRefund(state, 'refund-first')
    const second = requestRefund(state, {
      refundId: 'refund-second',
      paymentIntentId: 'pay-refund-2',
      items: [{ orderId: 'order-refund-2', orderItemId: 'line-wine', quantity: 1 }],
      reason: '第二桌退回葡萄酒',
      requestedBy: 'emp-server',
      occurredAt: '2026-07-30T12:02:00.000Z',
      idempotencyKey: 'refund-second:request',
    })
    approveAndStart(state, first.id)
    approveAndStart(state, second.id)

    markRefundSucceeded(state, {
      refundId: first.id,
      channelRefundTransactionId: 'shared-refund-transaction',
      refundedAmount: first.amount,
      currency: first.currency,
      occurredAt: '2026-07-30T12:05:00.000Z',
      idempotencyKey: 'refund-first:success',
    })
    expect(() => markRefundSucceeded(state, {
      refundId: second.id,
      channelRefundTransactionId: 'shared-refund-transaction',
      refundedAmount: second.amount,
      currency: second.currency,
      occurredAt: '2026-07-30T12:05:00.000Z',
      idempotencyKey: 'refund-second:success',
    })).toThrow('渠道退款交易号已被使用')
    expect(second.status).toBe('processing')
  })

  it('books a cross-business-day refund on the actual refund day without rewriting the sale day', () => {
    const state = createPaymentDomainState()
    createPaidIntent(state)
    const refund = requestCocktailRefund(state, 'refund-next-day')
    approveAndStart(state, refund.id)
    markRefundSucceeded(state, {
      refundId: refund.id,
      channelRefundTransactionId: 'refund-tx-next-day',
      refundedAmount: refund.amount,
      currency: refund.currency,
      occurredAt: '2026-07-31T02:00:00.000Z',
      idempotencyKey: 'refund-next-day:success',
    })

    const saleDay = buildSettlementChannelSummaries(state, '2026-07-30')
      .find((item) => item.channel === 'wechat')
    const refundDay = buildSettlementChannelSummaries(state, '2026-07-31')
      .find((item) => item.channel === 'wechat')
    expect(saleDay?.systemReceivableAmount).toBe(24_400)
    expect(refundDay?.systemReceivableAmount).toBe(-8_800)
  })
})
