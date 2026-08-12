import { describe, expect, it } from 'vitest'
import type {
  CreatePaymentIntentCommand,
  HandlePaymentNotificationCommand,
} from '../src/shared/payment-contracts.js'
import { PHYSICAL_POS_CHANNEL } from '../src/shared/payment-contracts.js'
import {
  applyPaymentQueryResult,
  approveRefund,
  buildSettlementChannelSummaries,
  confirmCashPayment,
  createPaymentDomainState,
  createPaymentIntent,
  expirePaymentIntents,
  handlePaymentNotification,
  markRefundFailed,
  markRefundSucceeded,
  queryPaymentStatus,
  reportPhysicalPosPayment,
  requestRefund,
  reviewCashierHandover,
  startRefund,
  submitCashierHandover,
} from './payment-domain.js'

const CREATED_AT = '2026-07-14T12:00:00.000Z'
const EXPIRES_AT = '2026-07-14T12:15:00.000Z'

function intentCommand(
  overrides: Partial<CreatePaymentIntentCommand> = {},
): CreatePaymentIntentCommand {
  return {
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
    expiresAt: EXPIRES_AT,
    idempotencyKey: 'create-pay-1',
    ...overrides,
  }
}

function successNotification(
  overrides: Partial<HandlePaymentNotificationCommand> = {},
): HandlePaymentNotificationCommand {
  return {
    channel: 'provider-a',
    notificationId: 'notice-1',
    paymentIntentId: 'pay-1',
    channelTransactionId: 'channel-tx-1',
    status: 'succeeded',
    amount: 3000,
    currency: 'CNY',
    merchantId: 'merchant-mbox',
    signatureVerified: true,
    channelOccurredAt: '2026-07-14T12:01:00.000Z',
    receivedAt: '2026-07-14T12:01:01.000Z',
    ...overrides,
  }
}

describe('payment intent and channel result', () => {
  it('binds payment to table, orders and item allocations without amount inference', () => {
    const state = createPaymentDomainState()
    const intent = createPaymentIntent(state, intentCommand())

    expect(intent.tableSessionId).toBe('table-session-A')
    expect(intent.orderIds).toEqual(['order-A'])
    expect(intent.lineAllocations.map((item) => item.paidAmount)).toEqual([2400, 600])
    expect(() =>
      createPaymentIntent(
        state,
        intentCommand({ paymentIntentId: 'pay-2', amount: 2999, idempotencyKey: 'create-pay-2' }),
      ),
    ).toThrow('支付金额必须等于明确关联的商品实付金额')
    expect(() =>
      createPaymentIntent(
        state,
        intentCommand({ paymentIntentId: 'pay-3', amount: 30.5, idempotencyKey: 'create-pay-3' }),
      ),
    ).toThrow('支付金额必须是正安全整数')
  })

  it('closes expired active intents while preserving a verified payment completed before expiry', () => {
    const state = createPaymentDomainState()
    const intent = createPaymentIntent(state, intentCommand())
    intent.status = 'processing'

    expect(expirePaymentIntents(state, '2026-07-14T12:16:00.000Z')).toEqual([intent])
    expect(intent).toMatchObject({ status: 'closed', failureReason: '支付意图已过期' })

    handlePaymentNotification(state, successNotification({
      channelOccurredAt: '2026-07-14T12:14:59.000Z',
      receivedAt: '2026-07-14T12:16:01.000Z',
    }))
    expect(intent).toMatchObject({ status: 'succeeded', closedAt: null, failureReason: null })
  })

  it('processes the same verified callback exactly once and rejects conflicting reuse', () => {
    const state = createPaymentDomainState()
    const intent = createPaymentIntent(state, intentCommand())
    const command = successNotification()

    const first = handlePaymentNotification(state, command)
    const repeated = handlePaymentNotification(state, command)

    expect(repeated).toBe(first)
    expect(state.paymentNotifications).toHaveLength(1)
    expect(intent.status).toBe('succeeded')
    expect(intent.channelTransactionId).toBe('channel-tx-1')
    expect(() =>
      handlePaymentNotification(state, { ...command, amount: 2999 }),
    ).toThrow('重复支付通知内容不一致')
  })

  it('never matches equal payments by amount across different tables', () => {
    const state = createPaymentDomainState()
    const first = createPaymentIntent(state, intentCommand())
    const second = createPaymentIntent(
      state,
      intentCommand({
        paymentIntentId: 'pay-2',
        tableSessionId: 'table-session-B',
        lineAllocations: [{ orderId: 'order-B', orderItemId: 'line-B1', quantity: 1, unitPaidAmount: 3000 }],
        idempotencyKey: 'create-pay-2',
      }),
    )

    handlePaymentNotification(state, successNotification())

    expect(first.status).toBe('succeeded')
    expect(second.status).toBe('pending')
    expect(() =>
      handlePaymentNotification(
        state,
        successNotification({
          notificationId: 'notice-2',
          paymentIntentId: 'pay-2',
          channelTransactionId: 'channel-tx-1',
        }),
      ),
    ).toThrow('渠道交易号已绑定其他支付意图')
  })

  it('provides an auditable active query entry that can recover a missing callback', () => {
    const state = createPaymentDomainState()
    const intent = createPaymentIntent(state, intentCommand())
    const query = queryPaymentStatus(state, {
      queryId: 'query-1',
      paymentIntentId: intent.id,
      requestedBy: 'cashier-1',
      occurredAt: '2026-07-14T12:02:00.000Z',
      idempotencyKey: 'query-request-1',
    })

    applyPaymentQueryResult(state, {
      queryId: query.id,
      channelTransactionId: 'channel-tx-query',
      status: 'succeeded',
      amount: 3000,
      currency: 'CNY',
      merchantId: 'merchant-mbox',
      channelOccurredAt: '2026-07-14T12:01:30.000Z',
      receivedAt: '2026-07-14T12:02:01.000Z',
      idempotencyKey: 'query-result-1',
    })

    expect(query.status).toBe('completed')
    expect(query.resultStatus).toBe('succeeded')
    expect(intent.status).toBe('succeeded')
  })
})

describe('physical POS reporting', () => {
  it('records an explicit pending-reconciliation report and enforces terminal flow uniqueness', () => {
    const state = createPaymentDomainState()
    const first = createPaymentIntent(
      state,
      intentCommand({ channel: PHYSICAL_POS_CHANNEL }),
    )
    createPaymentIntent(
      state,
      intentCommand({
        paymentIntentId: 'pay-2',
        tableSessionId: 'table-session-B',
        lineAllocations: [{ orderId: 'order-B', orderItemId: 'line-B1', quantity: 1, unitPaidAmount: 3000 }],
        channel: PHYSICAL_POS_CHANNEL,
        idempotencyKey: 'create-pay-2',
      }),
    )
    const reportCommand = {
      reportId: 'pos-report-1',
      paymentIntentId: first.id,
      terminalId: 'terminal-01',
      terminalTransactionId: 'terminal-tx-100',
      paymentMethod: 'bank_card',
      amount: 3000,
      currency: 'CNY',
      paidAt: '2026-07-14T12:03:00.000Z',
      reportedBy: 'cashier-1',
      deviceId: 'cashier-pc-1',
      receiptReference: 'receipt-100',
      occurredAt: '2026-07-14T12:03:30.000Z',
      idempotencyKey: 'pos-report-key-1',
    }

    const report = reportPhysicalPosPayment(state, reportCommand)
    expect(report.tableSessionId).toBe('table-session-A')
    expect(report.orderIds).toEqual(['order-A'])
    expect(first.status).toBe('reported_pending_reconciliation')
    expect(reportPhysicalPosPayment(state, reportCommand)).toBe(report)

    expect(() =>
      reportPhysicalPosPayment(state, {
        ...reportCommand,
        reportId: 'pos-report-2',
        paymentIntentId: 'pay-2',
        idempotencyKey: 'pos-report-key-2',
      }),
    ).toThrow('终端交易号已被报送')
  })

  it('keeps manual POS reports pending while requiring reason and next-day ownership at handover', () => {
    const state = createPaymentDomainState()
    const intent = createPaymentIntent(state, intentCommand({ channel: PHYSICAL_POS_CHANNEL, businessDate: '2026-07-14' }))
    reportPhysicalPosPayment(state, {
      reportId: 'pos-handover-report', paymentIntentId: intent.id, terminalId: 'POS-01',
      terminalTransactionId: 'POS-HANDOVER-001', paymentMethod: 'bank_card', amount: intent.amount,
      currency: intent.currency, paidAt: '2026-07-14T12:03:00.000Z', reportedBy: 'cashier-1',
      deviceId: 'cashier-pc-1', occurredAt: '2026-07-14T12:03:30.000Z', idempotencyKey: 'pos-handover-report-key',
    })
    const channels = buildSettlementChannelSummaries(state, '2026-07-14', { physical_pos: 3000 })
    expect(channels.find((item) => item.channel === 'physical_pos')).toMatchObject({
      systemReceivableAmount: 3000,
      confirmedActualAmount: 3000,
      pendingReconciliationAmount: 3000,
      differenceAmount: 0,
    })
    const command = {
      handoverId: 'handover-1', businessDate: '2026-07-14', shiftId: 'shift-cashier',
      submittedBy: 'cashier-1', deviceId: 'cashier-pc-1', channels,
      issues: [], occurredAt: '2026-07-14T18:00:00.000Z', idempotencyKey: 'handover-submit-1',
    }
    expect(() => submitCashierHandover(state, command)).toThrow('必须填写原因和次日责任人')
    const handover = submitCashierHandover(state, {
      ...command,
      issues: [{ channel: 'physical_pos', reason: '等待收单机构账单', nextDayOwnerId: 'cashier-2' }],
    })
    expect(() => reviewCashierHandover(state, {
      handoverId: handover.id, decision: 'approve', reviewedBy: 'cashier-1',
      occurredAt: '2026-07-14T18:01:00.000Z', idempotencyKey: 'handover-review-same-actor',
    })).toThrow('必须为不同员工')
    reviewCashierHandover(state, {
      handoverId: handover.id, decision: 'approve', reviewedBy: 'manager-1', note: '小票和报送记录一致',
      occurredAt: '2026-07-14T18:02:00.000Z', idempotencyKey: 'handover-review-manager',
    })
    expect(handover.status).toBe('approved')
    expect(intent.status).toBe('reported_pending_reconciliation')
  })
})

describe('cash payment confirmation', () => {
  it('records cash as succeeded only after an explicit cashier confirmation', () => {
    const state = createPaymentDomainState()
    const intent = createPaymentIntent(state, intentCommand({ channel: 'cash', businessDate: '2026-07-14' }))
    expect(intent.status).toBe('pending')
    confirmCashPayment(state, {
      confirmationId: 'cash-confirmation-1', paymentIntentId: intent.id, amount: intent.amount,
      currency: intent.currency, confirmedBy: 'cashier-1', deviceId: 'cashier-pc-1',
      occurredAt: '2026-07-14T12:01:00.000Z', idempotencyKey: 'cash-confirmation-key-1',
    })
    expect(intent.status).toBe('succeeded')
    expect(state.cashPaymentConfirmations).toHaveLength(1)
  })

  it('settles midnight-to-05:59 Beijing transactions into the previous 06:00 business day', () => {
    const state = createPaymentDomainState()
    const beforeCutoff = createPaymentIntent(state, intentCommand({
      paymentIntentId: 'pay-before-cutoff',
      channel: 'cash',
      occurredAt: '2026-07-27T21:59:59.000Z',
      expiresAt: '2026-07-27T22:14:59.000Z',
      idempotencyKey: 'create-pay-before-cutoff',
    }))
    confirmCashPayment(state, {
      confirmationId: 'cash-before-cutoff', paymentIntentId: beforeCutoff.id, amount: beforeCutoff.amount,
      currency: beforeCutoff.currency, confirmedBy: 'cashier-1', deviceId: 'cashier-pc-1',
      occurredAt: '2026-07-27T21:59:59.500Z', idempotencyKey: 'confirm-before-cutoff',
    })
    const afterCutoff = createPaymentIntent(state, intentCommand({
      paymentIntentId: 'pay-after-cutoff',
      channel: 'cash',
      occurredAt: '2026-07-27T22:00:00.000Z',
      expiresAt: '2026-07-27T22:15:00.000Z',
      idempotencyKey: 'create-pay-after-cutoff',
    }))
    confirmCashPayment(state, {
      confirmationId: 'cash-after-cutoff', paymentIntentId: afterCutoff.id, amount: afterCutoff.amount,
      currency: afterCutoff.currency, confirmedBy: 'cashier-1', deviceId: 'cashier-pc-1',
      occurredAt: '2026-07-27T22:00:00.500Z', idempotencyKey: 'confirm-after-cutoff',
    })

    expect(buildSettlementChannelSummaries(state, '2026-07-27').find((item) => item.channel === 'cash')?.systemReceivableAmount).toBe(3000)
    expect(buildSettlementChannelSummaries(state, '2026-07-28').find((item) => item.channel === 'cash')?.systemReceivableAmount).toBe(3000)
  })
})

describe('item-level refund state machine', () => {
  it('records whether the order is retained and whether the refund reopens the receivable', () => {
    const state = createPaymentDomainState()
    const intent = createPaymentIntent(state, intentCommand())
    handlePaymentNotification(state, successNotification())

    const refund = requestRefund(state, {
      refundId: 'refund-recollect',
      paymentIntentId: intent.id,
      items: [{ orderId: 'order-A', orderItemId: 'line-A1', quantity: 1 }],
      reason: '更换付款账户',
      orderDisposition: 'retain_order',
      receivableDisposition: 'reopen_receivable',
      requestedBy: 'cashier-1',
      occurredAt: '2026-07-14T12:04:00.000Z',
      idempotencyKey: 'refund-recollect-request',
    })

    expect(refund).toMatchObject({
      orderDisposition: 'retain_order',
      receivableDisposition: 'reopen_receivable',
      amount: 1200,
    })
    expect(() => requestRefund(state, {
      refundId: 'refund-invalid',
      paymentIntentId: intent.id,
      items: [{ orderId: 'order-A', orderItemId: 'line-A2', quantity: 1 }],
      reason: '错误组合',
      orderDisposition: 'cancel_items',
      receivableDisposition: 'reopen_receivable',
      requestedBy: 'cashier-1',
      occurredAt: '2026-07-14T12:05:00.000Z',
      idempotencyKey: 'refund-invalid-request',
    })).toThrow('退掉商品后不能恢复同一笔应收')
  })

  it('derives the amount from original items and requires request, approval, processing and success', () => {
    const state = createPaymentDomainState()
    const intent = createPaymentIntent(state, intentCommand())
    handlePaymentNotification(state, successNotification())

    const refund = requestRefund(state, {
      refundId: 'refund-1',
      paymentIntentId: intent.id,
      items: [{ orderId: 'order-A', orderItemId: 'line-A1', quantity: 1 }],
      reason: '商品退回',
      requestedBy: 'server-1',
      occurredAt: '2026-07-14T12:04:00.000Z',
      idempotencyKey: 'refund-request-1',
    })
    expect(refund.amount).toBe(1200)
    expect(refund.status).toBe('requested')
    expect(() =>
      markRefundSucceeded(state, {
        refundId: refund.id,
        channelRefundTransactionId: 'refund-tx-1',
        refundedAmount: 1200,
        currency: 'CNY',
        occurredAt: '2026-07-14T12:05:00.000Z',
        idempotencyKey: 'refund-success-early',
      }),
    ).toThrow('只有渠道处理中的退款可以成功')

    approveRefund(state, {
      refundId: refund.id,
      approvedBy: 'manager-1',
      reason: '核验通过',
      occurredAt: '2026-07-14T12:05:00.000Z',
      idempotencyKey: 'refund-approve-1',
    })
    startRefund(state, {
      refundId: refund.id,
      channelRefundId: 'channel-refund-1',
      actorId: 'cashier-1',
      occurredAt: '2026-07-14T12:06:00.000Z',
      idempotencyKey: 'refund-start-1',
    })
    markRefundSucceeded(state, {
      refundId: refund.id,
      channelRefundTransactionId: 'refund-tx-1',
      refundedAmount: 1200,
      currency: 'CNY',
      occurredAt: '2026-07-14T12:07:00.000Z',
      idempotencyKey: 'refund-success-1',
    })

    expect(refund.status).toBe('succeeded')
    expect(refund.items).toEqual([
      { orderId: 'order-A', orderItemId: 'line-A1', quantity: 1, unitPaidAmount: 1200, amount: 1200 },
    ])
  })

  it('rejects unlinked items and cumulative quantity over-refunds', () => {
    const state = createPaymentDomainState()
    const intent = createPaymentIntent(state, intentCommand())
    handlePaymentNotification(state, successNotification())

    expect(() =>
      requestRefund(state, {
        refundId: 'refund-wrong-order',
        paymentIntentId: intent.id,
        items: [{ orderId: 'order-B', orderItemId: 'line-A1', quantity: 1 }],
        reason: '错误订单',
        requestedBy: 'server-1',
        occurredAt: '2026-07-14T12:04:00.000Z',
        idempotencyKey: 'refund-wrong-order',
      }),
    ).toThrow('退款商品不属于原支付意图')

    requestRefund(state, {
      refundId: 'refund-1',
      paymentIntentId: intent.id,
      items: [{ orderId: 'order-A', orderItemId: 'line-A1', quantity: 2 }],
      reason: '退两件',
      requestedBy: 'server-1',
      occurredAt: '2026-07-14T12:04:00.000Z',
      idempotencyKey: 'refund-request-1',
    })
    expect(() =>
      requestRefund(state, {
        refundId: 'refund-2',
        paymentIntentId: intent.id,
        items: [{ orderId: 'order-A', orderItemId: 'line-A1', quantity: 1 }],
        reason: '重复多退',
        requestedBy: 'server-1',
        occurredAt: '2026-07-14T12:05:00.000Z',
        idempotencyKey: 'refund-request-2',
      }),
    ).toThrow('商品累计退款数量超过原支付数量')
  })

  it('retries a failed channel refund with a new idempotency key and keeps replays safe', () => {
    const state = createPaymentDomainState()
    const intent = createPaymentIntent(state, intentCommand())
    handlePaymentNotification(state, successNotification())
    const refund = requestRefund(state, {
      refundId: 'refund-retry', paymentIntentId: intent.id,
      items: [{ orderId: 'order-A', orderItemId: 'line-A1', quantity: 1 }],
      reason: '首次渠道失败后重试', requestedBy: 'server-1',
      occurredAt: '2026-07-14T12:04:00.000Z', idempotencyKey: 'refund-retry-request',
    })
    approveRefund(state, {
      refundId: refund.id, approvedBy: 'manager-1', reason: '复核通过',
      occurredAt: '2026-07-14T12:05:00.000Z', idempotencyKey: 'refund-retry-approve',
    })
    startRefund(state, {
      refundId: refund.id, channelRefundId: 'channel-refund-failed', actorId: 'cashier-1',
      occurredAt: '2026-07-14T12:06:00.000Z', idempotencyKey: 'refund-retry-start-1',
    })
    markRefundFailed(state, {
      refundId: refund.id, reason: '渠道暂时不可用',
      occurredAt: '2026-07-14T12:07:00.000Z', idempotencyKey: 'refund-retry-failed-1',
    })

    const retried = startRefund(state, {
      refundId: refund.id, channelRefundId: 'channel-refund-retry', actorId: 'cashier-1',
      occurredAt: '2026-07-14T12:08:00.000Z', idempotencyKey: 'refund-retry-start-2',
    })
    const replay = startRefund(state, {
      refundId: refund.id, channelRefundId: 'channel-refund-retry', actorId: 'cashier-1',
      occurredAt: '2026-07-14T12:08:00.000Z', idempotencyKey: 'refund-retry-start-2',
    })
    expect(replay).toBe(retried)
    expect(retried).toMatchObject({
      status: 'processing', channelRefundId: 'channel-refund-retry', failedAt: null, failureReason: null,
    })
  })
})
