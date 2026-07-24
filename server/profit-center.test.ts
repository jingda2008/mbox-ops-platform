import { describe, expect, it } from 'vitest'
import type { OperatingCostEntry, RecurringCostTemplate } from '../src/shared/commercial-ops-contracts.js'
import type { PaymentIntent } from '../src/shared/payment-contracts.js'
import { buildProfitCenterReport, profitPeriodRange } from './profit-center.js'
import { createSeedState } from './seed.js'

const NOW = '2026-08-10T10:00:00.000Z'

function payment(id: string, amount: number, status: PaymentIntent['status'], businessDate: string): PaymentIntent {
  return {
    id,
    tableSessionId: 'session:table-l01:test',
    orderIds: [],
    lineAllocations: [],
    amount,
    currency: 'CNY',
    channel: status === 'reported_pending_reconciliation' ? 'physical_pos' : 'wechat',
    merchantId: 'merchant-test',
    status,
    channelTransactionId: null,
    createdBy: 'emp-cashier',
    deviceId: 'device-test',
    createdAt: `${businessDate}T12:00:00+08:00`,
    expiresAt: `${businessDate}T12:15:00+08:00`,
    paidAt: status === 'succeeded' ? `${businessDate}T12:01:00+08:00` : null,
    failedAt: null,
    closedAt: null,
    failureReason: null,
    businessDate,
  }
}

function cost(input: Partial<OperatingCostEntry> & Pick<OperatingCostEntry, 'id' | 'name' | 'amount' | 'status'>): OperatingCostEntry {
  return {
    categoryId: 'rent',
    currency: 'CNY',
    recognitionMode: 'spread_daily',
    recognitionStartDate: '2026-07-01',
    recognitionEndDate: '2026-07-31',
    counterparty: '陆家嘴场地方',
    reference: '',
    note: '',
    replacesEntryId: null,
    sourceTemplateId: null,
    sourceOccurrenceDate: null,
    createdAt: NOW,
    createdBy: 'emp-chen',
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    idempotencyKey: `cost-${input.id}`,
    ...input,
  }
}

function recurring(input: Partial<RecurringCostTemplate> & Pick<RecurringCostTemplate, 'id' | 'name' | 'amount'>): RecurringCostTemplate {
  return {
    categoryId: 'performer',
    currency: 'CNY',
    frequency: 'monthly',
    recognitionMode: 'spread_daily',
    startDate: '2026-01-01',
    endDate: null,
    counterparty: '驻场演出团队',
    note: '',
    enabled: true,
    revision: 1,
    createdAt: NOW,
    createdBy: 'emp-chen',
    updatedAt: NOW,
    updatedBy: 'emp-chen',
    ...input,
  }
}

describe('profit center', () => {
  it('builds Beijing business day periods for day, week, month, quarter and year', () => {
    expect(profitPeriodRange('day', '2026-07-23')).toEqual({ startDate: '2026-07-23', endDate: '2026-07-23' })
    expect(profitPeriodRange('week', '2026-07-23')).toEqual({ startDate: '2026-07-20', endDate: '2026-07-26' })
    expect(profitPeriodRange('month', '2026-02-10')).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' })
    expect(profitPeriodRange('quarter', '2026-07-23')).toEqual({ startDate: '2026-07-01', endDate: '2026-09-30' })
    expect(profitPeriodRange('year', '2026-07-23')).toEqual({ startDate: '2026-01-01', endDate: '2026-12-31' })
  })

  it('recalculates a historical month when a late actual bill replaces its estimate', () => {
    const state = createSeedState()
    state.paymentDomain.paymentIntents.push(
      payment('payment-paid', 100_000, 'succeeded', '2026-07-15'),
      payment('payment-pos', 20_000, 'reported_pending_reconciliation', '2026-07-15'),
    )
    state.paymentDomain.refunds.push({
      id: 'refund-paid',
      paymentIntentId: 'payment-paid',
      tableSessionId: 'session:table-l01:test',
      items: [],
      amount: 10_000,
      currency: 'CNY',
      reason: '测试退款',
      status: 'succeeded',
      requestedBy: 'emp-cashier',
      requestedAt: '2026-07-18T12:00:00+08:00',
      decidedBy: 'emp-chen',
      decidedAt: '2026-07-18T12:01:00+08:00',
      decisionReason: '批准',
      channelRefundId: 'channel-refund',
      processingAt: '2026-07-18T12:02:00+08:00',
      channelRefundTransactionId: 'refund-transaction',
      succeededAt: '2026-07-18T12:03:00+08:00',
      failedAt: null,
      failureReason: null,
    })
    const estimate = cost({ id: 'rent-estimate', name: '7月房租预估', amount: 31_000, status: 'estimated' })
    const actual = cost({
      id: 'rent-actual',
      name: '7月房租账单',
      amount: 62_000,
      status: 'actual',
      replacesEntryId: estimate.id,
      createdAt: '2026-08-10T10:00:00+08:00',
    })
    state.commercialOps!.costEntries.push(estimate, actual)

    const report = buildProfitCenterReport(state, 'month', '2026-07-15', new Date(NOW))

    expect(report.revenue).toMatchObject({
      paymentAmount: 100_000,
      refundAmount: 10_000,
      netAmount: 90_000,
      pendingPosAmount: 20_000,
    })
    expect(report.costs.actualOperatingExpenseAmount).toBe(62_000)
    expect(report.costs.estimatedOperatingExpenseAmount).toBe(0)
    expect(report.profit.projectedOperatingProfitAmount).toBe(28_000)
    expect(report.quality).toMatchObject({ pendingPosCount: 1, actualEntryCount: 1, estimatedEntryCount: 0 })
  })

  it('expands recurring costs and lets an actual occurrence replace only its own month', () => {
    const state = createSeedState()
    const template = recurring({ id: 'performer-monthly', name: '驻场演出月费', amount: 12_000 })
    state.commercialOps!.recurringCostTemplates.push(template)
    state.commercialOps!.costEntries.push(cost({
      id: 'performer-march-actual',
      name: '3月驻场演出结算',
      categoryId: 'performer',
      amount: 15_000,
      status: 'actual',
      recognitionStartDate: '2026-03-01',
      recognitionEndDate: '2026-03-31',
      sourceTemplateId: template.id,
      sourceOccurrenceDate: '2026-03-01',
    }))

    const report = buildProfitCenterReport(state, 'quarter', '2026-02-15', new Date(NOW))
    const row = report.categoryRows.find((item) => item.categoryId === 'performer')

    expect(row).toMatchObject({ actualAmount: 15_000, estimatedAmount: 24_000, totalAmount: 39_000 })
    expect(report.quality).toMatchObject({ actualEntryCount: 1, estimatedEntryCount: 2 })
  })

  it('does not double count a voucher when its linked order was paid outside the selected period', () => {
    const state = createSeedState()
    const settledPayment = payment('payment-linked', 10_000, 'succeeded', '2026-06-30')
    settledPayment.orderIds = ['order-linked']
    state.paymentDomain.paymentIntents.push(settledPayment)
    state.commercialOps!.voucherRedemptions.push({
      id: 'voucher-linked',
      platform: '测试团购',
      campaignName: '测试套餐',
      voucherCodeMasked: '12****34',
      voucherCodeHash: 'voucher-hash',
      faceValueAmount: 12_000,
      settlementAmount: 8_000,
      tableSessionId: null,
      orderId: 'order-linked',
      status: 'redeemed',
      redeemedAt: '2026-07-01T12:00:00+08:00',
      redeemedBy: 'emp-chen',
      voidedAt: null,
      voidedBy: null,
      reason: '测试跨期去重',
      idempotencyKey: 'voucher-linked-idempotency',
    })

    const report = buildProfitCenterReport(state, 'month', '2026-07-15', new Date(NOW))

    expect(report.revenue.voucherSettlementAmount).toBe(0)
    expect(report.quality.excludedDuplicateVoucherCount).toBe(1)
  })

  it('uses immutable inventory consumption first and estimates only untracked order items', () => {
    const state = createSeedState()
    state.orderDomain.orders.push({
      id: 'order-cost',
      tableSessionId: 'session:table-l01:test',
      status: 'submitted',
      items: [{
        id: 'order-cost-item',
        skuId: 'product-beer',
        name: '精酿啤酒',
        specification: '330ml',
        quantity: 2,
        unitListPriceAmount: 6800,
        unitSalePriceAmount: 6800,
        unitCostAmount: 1800,
        stationId: 'bar-main',
        configVersion: 1,
        fulfillmentStatus: 'queued',
        kdsTaskId: 'kds-cost',
        addedBy: 'emp-chen',
        addedAt: '2026-07-20T12:00:00+08:00',
      }],
      amounts: { grossAmount: 13_600, discountAmount: 0, giftAmount: 0, payableAmount: 13_600 },
      revision: 1,
      createdBy: 'emp-chen',
      createdAt: '2026-07-20T12:00:00+08:00',
      submittedBy: 'emp-chen',
      submittedAt: '2026-07-20T12:00:00+08:00',
      fulfilledAt: null,
    })

    const estimated = buildProfitCenterReport(state, 'day', '2026-07-20', new Date(NOW))
    expect(estimated.costs).toMatchObject({ goodsCostAmount: 0, estimatedGoodsCostAmount: 3600 })
    expect(estimated.quality.estimatedGoodsOrderItemCount).toBe(1)

    state.inventoryDomain!.movements.push({
      id: 'movement-cost',
      tenantId: state.inventoryDomain!.tenantId,
      storeId: state.inventoryDomain!.storeId,
      productId: 'product-beer',
      unitCode: 'bottle',
      type: 'sale',
      direction: 'out',
      quantity: 2,
      balanceAfter: 20,
      tableSessionId: 'session:table-l01:test',
      orderId: 'order-cost',
      orderItemId: 'order-cost-item',
      refundId: null,
      stockCountId: null,
      approvalId: null,
      actorId: 'emp-chen',
      reason: '订单出库',
      businessDate: '2026-07-20',
      occurredAt: '2026-07-20T12:00:00+08:00',
      configurationSnapshot: {
        kind: 'direct_product',
        consumptionType: 'sale',
        orderedProductId: 'product-beer',
        orderedProductName: '精酿啤酒',
        orderedQuantity: 2,
        inventoryUnitCode: 'bottle',
      },
    })
    const actual = buildProfitCenterReport(state, 'day', '2026-07-20', new Date(NOW))
    expect(actual.costs).toMatchObject({ goodsCostAmount: 3600, estimatedGoodsCostAmount: 0 })
    expect(actual.quality.estimatedGoodsOrderItemCount).toBe(0)
  })
})
