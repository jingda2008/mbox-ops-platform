import { describe, expect, it } from 'vitest'
import type { Order } from '../src/shared/order-contracts.js'
import { createServiceTask } from './domain.js'
import { createSeedState } from './seed.js'
import { executeAnalyticsQuery } from './analytics-engine.js'

const now = Date.parse('2026-07-18T12:00:00.000Z')

function order(
  id: string,
  tableSessionId: string,
  createdAt: string,
  items: Array<{ id: string; skuId: string; name: string; quantity: number; sale: number; cost: number }>,
): Order {
  const grossAmount = items.reduce((sum, item) => sum + item.sale * item.quantity, 0)
  return {
    id,
    tableSessionId,
    status: 'submitted',
    items: items.map((item) => ({
      id: item.id,
      skuId: item.skuId,
      name: item.name,
      specification: '1份',
      quantity: item.quantity,
      unitListPriceAmount: item.sale,
      unitSalePriceAmount: item.sale,
      unitCostAmount: item.cost,
      stationId: 'bar-main',
      configVersion: 1,
      fulfillmentStatus: 'queued',
      kdsTaskId: null,
      addedBy: 'emp-lin',
      addedAt: createdAt,
    })),
    amounts: { grossAmount, discountAmount: 0, giftAmount: 0, payableAmount: grossAmount },
    revision: 1,
    createdBy: 'emp-lin',
    createdAt,
    submittedBy: 'emp-lin',
    submittedAt: createdAt,
    fulfilledAt: null,
  }
}

function analyticsState() {
  const state = createSeedState(new Date(now))
  const businessDate = state.store.businessDate
  const loungeSessionId = `session:table-l01:${businessDate}`
  const interactiveSessionId = `session:table-i01:${businessDate}`
  state.orderDomain.orders = [
    order('order-lounge', loungeSessionId, '2026-07-18T12:10:00.000Z', [
      { id: 'item-cocktail', skuId: 'product-cocktail', name: '招牌鸡尾酒', quantity: 2, sale: 8800, cost: 2200 },
    ]),
    order('order-interactive', interactiveSessionId, '2026-07-18T13:10:00.000Z', [
      { id: 'item-beer', skuId: 'product-beer', name: '精酿啤酒', quantity: 4, sale: 6800, cost: 1800 },
    ]),
  ]
  state.tableSessionOperations = [
    {
      tableSessionId: loungeSessionId,
      openedTableId: 'table-l01',
      openedTableCode: 'L01',
      source: 'walk_in',
      sourceId: 'walk-in-l01',
      guestCount: 4,
      minimumSpendSnapshot: {
        configVersion: 1, ruleId: null, ruleName: '未设置低消', targetType: null, targetId: null,
        weekday: 6, startTime: null, endTime: null, amount: 0, currency: 'CNY',
        reminder: { enabled: false, firstReminderMinutes: 60, repeatMinutes: 30, thresholdPercent: 80 },
        capturedAt: '2026-07-18T10:00:00.000Z',
      },
      createdAt: '2026-07-18T10:00:00.000Z',
    },
    {
      tableSessionId: interactiveSessionId,
      openedTableId: 'table-i01',
      openedTableCode: 'I01',
      source: 'walk_in',
      sourceId: 'walk-in-i01',
      guestCount: 6,
      minimumSpendSnapshot: {
        configVersion: 1, ruleId: null, ruleName: '未设置低消', targetType: null, targetId: null,
        weekday: 6, startTime: null, endTime: null, amount: 0, currency: 'CNY',
        reminder: { enabled: false, firstReminderMinutes: 60, repeatMinutes: 30, thresholdPercent: 80 },
        capturedAt: '2026-07-18T10:00:00.000Z',
      },
      createdAt: '2026-07-18T10:00:00.000Z',
    },
  ]
  state.salesAttributionRecords = [
    {
      id: 'sales-lounge', subjectType: 'table_session', subjectId: loungeSessionId,
      salesEmployeeId: 'emp-lin', previousSalesEmployeeId: null, actorId: 'emp-chen',
      reason: '测试销售归属', occurredAt: '2026-07-18T10:00:00.000Z', idempotencyKey: 'sales-lounge',
    },
    {
      id: 'sales-interactive', subjectType: 'table_session', subjectId: interactiveSessionId,
      salesEmployeeId: 'emp-wu', previousSalesEmployeeId: null, actorId: 'emp-chen',
      reason: '测试销售归属', occurredAt: '2026-07-18T10:00:00.000Z', idempotencyKey: 'sales-interactive',
    },
  ]
  return state
}

describe('analytics semantic engine', () => {
  it('answers product, table and party-size questions from verified order and session facts', () => {
    const state = analyticsState()
    const product = executeAnalyticsQuery(state, { actorId: 'emp-chen' }, {
      metric: 'sales_quantity', dimension: 'product', period: 'current_business_day', limit: 10, sort: 'desc',
    }, now).result
    const table = executeAnalyticsQuery(state, { actorId: 'emp-chen' }, {
      metric: 'sales_amount', dimension: 'table', period: 'current_business_day', limit: 10, sort: 'desc',
    }, now).result
    const party = executeAnalyticsQuery(state, { actorId: 'emp-chen' }, {
      metric: 'guest_count', dimension: 'party_size', period: 'current_business_day', limit: 10, sort: 'desc',
    }, now).result

    expect(product.rows[0]).toMatchObject({ label: '精酿啤酒', value: 4 })
    expect(table.rows[0]).toMatchObject({ label: 'I01', value: 27_200 })
    expect(party).toMatchObject({ total: 40, completeness: 'complete', missingPartySizeSessions: 0 })
    expect(party.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '6人', value: 12 }),
      expect.objectContaining({ label: '4人', value: 4 }),
    ]))
  })

  it('enforces assigned-area scope and finance permissions', () => {
    const state = analyticsState()
    const tom = executeAnalyticsQuery(state, { actorId: 'emp-lin' }, {
      metric: 'sales_amount', dimension: 'table', period: 'current_business_day',
    }, now).result

    expect(tom.rows).toEqual([expect.objectContaining({ label: 'L01', value: 17_600 })])
    expect(() => executeAnalyticsQuery(state, { actorId: 'emp-lin' }, {
      metric: 'estimated_gross_profit', dimension: 'product', period: 'current_business_day',
    }, now)).toThrow('财务查看权限')
    expect(executeAnalyticsQuery(state, { actorId: 'emp-chen' }, {
      metric: 'estimated_gross_profit', dimension: 'none', period: 'current_business_day',
    }, now).result.total).toBe(33_200)
  })

  it('calculates service completion and response without allowing arbitrary SQL fields', () => {
    const state = analyticsState()
    const completed = createServiceTask(state, {
      tableCode: 'L01', serviceTypeId: 'water', source: 'employee', note: '',
      idempotencyKey: 'analytics-task-complete', requestedBy: 'emp-chen',
    })
    Object.assign(completed, {
      ownerId: 'emp-lin',
      status: 'completed',
      createdAt: '2026-07-18T12:00:00.000Z',
      acceptedAt: '2026-07-18T12:00:12.000Z',
      completedAt: '2026-07-18T12:01:00.000Z',
    })
    const pending = createServiceTask(state, {
      tableCode: 'L01', serviceTypeId: 'water', source: 'employee', note: '',
      idempotencyKey: 'analytics-task-pending', requestedBy: 'emp-chen',
    })
    Object.assign(pending, {
      ownerId: 'emp-lin',
      status: 'pending',
      createdAt: '2026-07-18T12:02:00.000Z',
      acceptedAt: null,
    })

    expect(executeAnalyticsQuery(state, { actorId: 'emp-chen' }, {
      metric: 'service_completion_rate', dimension: 'none', period: 'current_business_day',
    }, now).result.total).toBe(50)
    expect(executeAnalyticsQuery(state, { actorId: 'emp-chen' }, {
      metric: 'median_service_response_seconds', dimension: 'none', period: 'current_business_day',
    }, now).result.total).toBe(12)
    expect(() => executeAnalyticsQuery(state, { actorId: 'emp-chen' }, {
      metric: 'sales_amount', dimension: 'none', period: 'current_business_day', sql: 'DROP TABLE orders',
    }, now)).toThrow()
  })
})
