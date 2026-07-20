import { describe, expect, it } from 'vitest'
import type { Order } from '../src/shared/order-contracts.js'
import {
  queuePrintJobsForOrder,
  recentGuestOrderCount,
  recentMatchingGuestOrder,
  salesByEmployeeCategory,
} from './commercial-ops.js'
import { createSeedState } from './seed.js'

const NOW = '2026-07-19T13:00:00.000Z'

function order(id: string, createdAt = NOW): Order {
  return {
    id,
    tableSessionId: 'session:table-l01:seed',
    status: 'submitted',
    items: [
      {
        id: `${id}-bar`, skuId: 'product-beer', name: '精酿啤酒', specification: '330ml', quantity: 2,
        unitListPriceAmount: 6800, unitSalePriceAmount: 6800, unitCostAmount: 1800,
        stationId: 'bar-main', configVersion: 1, fulfillmentStatus: 'queued', kdsTaskId: `${id}-bar-kds`,
        addedBy: 'guest-L01', addedAt: createdAt,
      },
      {
        id: `${id}-food`, skuId: 'product-snack', name: '小食拼盘', specification: '1份', quantity: 1,
        unitListPriceAmount: 9800, unitSalePriceAmount: 9800, unitCostAmount: 3200,
        stationId: 'kitchen-hot', configVersion: 1, fulfillmentStatus: 'queued', kdsTaskId: `${id}-food-kds`,
        addedBy: 'guest-L01', addedAt: createdAt,
      },
    ],
    amounts: { grossAmount: 23_400, discountAmount: 0, giftAmount: 0, payableAmount: 23_400 },
    revision: 1,
    createdBy: 'guest-L01',
    createdAt,
    submittedBy: 'guest-L01',
    submittedAt: createdAt,
    fulfilledAt: null,
  }
}

describe('commercial operations domain', () => {
  it('detects the same guest cart inside the configured safety window', () => {
    const state = createSeedState()
    const existing = order('order-duplicate', '2026-07-19T12:59:40.000Z')
    state.orderDomain.orders.push(existing)

    expect(recentGuestOrderCount(state, existing.tableSessionId, Date.parse(NOW))).toBe(1)
    expect(recentMatchingGuestOrder(state, existing.tableSessionId, [
      { productId: 'product-snack', quantity: 1 },
      { productId: 'product-beer', quantity: 2 },
    ], Date.parse(NOW))?.id).toBe(existing.id)
    expect(recentMatchingGuestOrder(state, existing.tableSessionId, [
      { productId: 'product-beer', quantity: 1 },
    ], Date.parse(NOW))).toBeNull()
  })

  it('splits one order into independent bar and kitchen print jobs without duplicating retries', () => {
    const state = createSeedState()
    const submitted = order('order-print')

    const jobs = queuePrintJobsForOrder(state, submitted, NOW)
    const replay = queuePrintJobsForOrder(state, submitted, NOW)

    expect(jobs).toHaveLength(2)
    expect(state.commercialOps?.printJobs).toHaveLength(2)
    expect(replay.map((job) => job.id)).toEqual(jobs.map((job) => job.id))
    expect(jobs.find((job) => job.routeId === 'route-bar')?.orderItemIds).toEqual(['order-print-bar'])
    expect(jobs.find((job) => job.routeId === 'route-kitchen')?.orderItemIds).toEqual(['order-print-food'])
  })

  it('aggregates employee sales by product category with gross profit', () => {
    const state = createSeedState()
    const submitted = order('order-sales')
    state.orderDomain.orders.push(submitted)
    state.salesAttributionRecords = [{
      id: 'sales-owner-1', subjectType: 'table_session', subjectId: submitted.tableSessionId,
      salesEmployeeId: 'emp-lin', assignedBy: 'emp-chen', assignedAt: NOW,
      reason: '责任区销售归属', idempotencyKey: 'sales-owner-commercial-1',
    }]

    const rows = salesByEmployeeCategory(state)
    expect(rows.find((row) => row.categoryId === 'drinks')).toMatchObject({
      employeeId: 'emp-lin', quantity: 2, salesAmount: 13_600, costAmount: 3600, grossProfitAmount: 10_000,
    })
    expect(rows.find((row) => row.categoryId === 'food')).toMatchObject({
      employeeId: 'emp-lin', quantity: 1, salesAmount: 9800, costAmount: 3200, grossProfitAmount: 6600,
    })
  })
})
