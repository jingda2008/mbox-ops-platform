import { describe, expect, it } from 'vitest'
import {
  buildWeeklySuggestions,
  CustomerExperienceAnalyticsRepository,
  type ProductExperienceAnalyticsRow,
} from './customer-experience-analytics-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const product = (overrides: Partial<ProductExperienceAnalyticsRow> = {}): ProductExperienceAnalyticsRow => ({
  productId: '10000000-0000-4000-8000-000000000001',
  productName: '测试商品',
  paidOrderCount: 8,
  soldQuantity: 12,
  paidRevenueMinor: 120_000,
  refundedAmountMinor: 0,
  frozenCostMinor: 60_000,
  contributionAmountMinor: 60_000,
  observationCount: 10,
  praiseCount: 1,
  complaintCount: 2,
  remainingCount: 3,
  servedLateCount: 0,
  correctedCount: 1,
  averageObservationConfidence: 0.82,
  ...overrides,
})

describe('customer experience analytics', () => {
  it('reports evidence and opposing evidence without automatically changing the menu', () => {
    const suggestions = buildWeeklySuggestions([product()])
    expect(suggestions.map((entry) => entry.kind)).toContain('high_sales_low_experience')
    expect(suggestions.map((entry) => entry.kind)).toContain('frequent_remaining')
    expect(suggestions[0]).toMatchObject({ sampleSize: 10 })
    expect(suggestions.every((entry) => entry.confidence < 1)).toBe(true)
    expect(suggestions.every((entry) => entry.recommendation.includes('调整') || entry.recommendation.includes('复核'))).toBe(true)
  })

  it('keeps low-sample evidence explicitly directional or insufficient', () => {
    const suggestions = buildWeeklySuggestions([product({
      soldQuantity: 0,
      observationCount: 3,
      praiseCount: 3,
      complaintCount: 0,
      remainingCount: 0,
    })])
    expect(suggestions).toEqual([expect.objectContaining({
      kind: 'low_sales_high_praise',
      confidenceBasis: 'directional',
      sampleSize: 3,
      opposingEvidence: 0,
    })])
  })

  it('maps only strong columns and calculates quality rates', async () => {
    const queries: string[] = []
    const transaction = ({
      scope: {
        tenantId: '10000000-0000-4000-8000-000000000010',
        storeId: '10000000-0000-4000-8000-000000000011',
      },
      query: async (sql: string) => {
        queries.push(sql)
        if (sql.includes('ORDER BY product.menu_sort_order,product.name,product.id')) return { rows: [{
          product_id: '10000000-0000-4000-8000-000000000030',product_name: '测试套餐',
        }],rowCount:1 }
        if (sql.includes('FROM scoped_sessions scoped')) return { rows: [{
          product_id: product().productId, product_name: '测试商品', currency: 'CNY',
          generated: '1', exposed: '1', selected: '1', ignored: '1', rejected: '0',
          staff_modified: '0', ordered: '1', paid: '1', refunded: '0',
          paid_amount_minor: '10000', refunded_amount_minor: '0', frozen_cost_minor: '4000',
          unavailable_cost_count: '0', complaint_order_count: '1', follow_on_paid_order_count: '1',
          repeat_purchase_order_count: '1',
        }], rowCount: 1 }
        if (sql.includes('WITH paid_sales AS')) return { rows: [{
          product_id: product().productId, product_name: '测试商品', paid_order_count: '1',
          sold_quantity: '1', paid_revenue_minor: '10000', refunded_amount_minor: '0',
          frozen_cost_minor: '4000', unavailable_cost_count: '0', observation_count: '1',
          praise_count: '1', complaint_count: '0', remaining_count: '0', served_late_count: '0',
          corrected_count: '0', average_observation_confidence: '0.9',
        }], rowCount: 1 }
        if (sql.includes('AS total_inputs')) return { rows: [{
          total_inputs: '4', confirmed_inputs: '3', unmatched_inputs: '1', corrected_events: '1',
        }], rowCount: 1 }
        if (sql.includes('AS recommendation_without_exposure_count')) return { rows: [{
          recommendation_without_exposure_count: '2',
          paid_recommendation_cost_unavailable_count: '1',
          complaint_without_order_link_count: '3',
        }], rowCount: 1 }
        return { rows: [{
          employee_id: '10000000-0000-4000-8000-000000000020', employee_name: '李艳',
          input_count: '4', confirmed_count: '3', unmatched_input_count: '1',
          corrected_event_count: '1', positive_event_count: '1', neutral_event_count: '1', negative_event_count: '1',
        }], rowCount: 1 }
      },
    } as unknown as ScopedTransaction)
    const result = await new CustomerExperienceAnalyticsRepository(transaction).dashboard({
      from: '2026-08-01T00:00:00.000Z',
      until: '2026-08-08T00:00:00.000Z',
      productId: null,
      employeeId: null,
      partySize: null,
      occasion: null,
      performancePhase: null,
      tableCode: null,
      packageProductId: null,
      recommendationOutcome: 'all',
    })
    expect(result.dataQuality).toMatchObject({ unmatchedRate: 0.25, correctionRate: 0.3333 })
    expect(result.dataQuality.missingFacts).toEqual({
      recommendationWithoutExposureCount: 2,
      paidRecommendationCostUnavailableCount: 1,
      complaintWithoutOrderLinkCount: 3,
    })
    expect(result.recommendation[0]).toMatchObject({
      ignored: 1,complaintOrderCount: 1,followOnPaidOrderCount: 1,repeatPurchaseOrderCount: 1,
      frozenCostMinor: 4000,contributionAmountMinor: 6000,
    })
    expect(result.products[0]?.frozenCostMinor).toBe(4000)
    expect(queries.join('\n')).toContain('total_cost_minor_at_submission')
    expect(queries.join('\n')).toContain('schedule_performance_phase_events')
    expect(queries.find((sql) => sql.includes('AS recommendation_without_exposure_count')))
      .toContain('$6::uuid')
    expect(queries.join('\n')).not.toContain('$8::text IS NULL OR $8::text IS NOT NULL')
    expect(queries.join('\n')).toContain('table_occasion.occasion=$8::text')
    expect(queries.join('\n')).toContain('parent_order_item_id')
    expect(result.packageOptions).toEqual([{
      productId: '10000000-0000-4000-8000-000000000030',productName: '测试套餐',
    }])
    expect(result.filterCapabilities.customerSegment).toMatchObject({ available:false })
    expect(queries.join('\n')).not.toContain('product_snapshot->')
    expect(result.decisionBoundary).toContain('不得')
  })

  it('rejects an unbounded analytics range', async () => {
    const transaction = ({
      scope: { tenantId: 't', storeId: 's' },
      query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as ScopedTransaction)
    await expect(new CustomerExperienceAnalyticsRepository(transaction).dashboard({
      from: '2026-01-01T00:00:00.000Z',
      until: '2026-08-08T00:00:00.000Z',
      productId: null,
      employeeId: null,
      partySize: null,
      occasion: null,
      performancePhase: null,
      tableCode: null,
      packageProductId: null,
      recommendationOutcome: 'all',
    })).rejects.toThrow('cannot exceed 93 days')
  })

  it('filters only strong recommendation outcomes and does not claim causation', async () => {
    const transaction = ({
      scope: {
        tenantId: '10000000-0000-4000-8000-000000000010',
        storeId: '10000000-0000-4000-8000-000000000011',
      },
      query: async (sql: string) => {
        if (sql.includes('FROM scoped_sessions scoped')) return { rows: [{
          product_id: product().productId,product_name:'测试商品',currency:'CNY',generated:'1',exposed:'1',
          selected:'1',ignored:'0',rejected:'0',staff_modified:'0',ordered:'1',paid:'1',refunded:'0',
          paid_amount_minor:'10000',refunded_amount_minor:'0',frozen_cost_minor:'4000',unavailable_cost_count:'0',
          complaint_order_count:'0',follow_on_paid_order_count:'0',repeat_purchase_order_count:'0',
        }],rowCount:1 }
        if (sql.includes('WITH paid_sales AS')) return { rows: [],rowCount:0 }
        if (sql.includes('AS total_inputs')) return { rows: [],rowCount:0 }
        if (sql.includes('AS recommendation_without_exposure_count')) return { rows: [],rowCount:0 }
        return { rows: [],rowCount:0 }
      },
    } as unknown as ScopedTransaction)
    const result = await new CustomerExperienceAnalyticsRepository(transaction).dashboard({
      from:'2026-08-01T00:00:00.000Z',until:'2026-08-08T00:00:00.000Z',productId:null,
      employeeId:null,partySize:null,occasion:null,performancePhase:null,tableCode:null,
      packageProductId:null,
      recommendationOutcome:'repeat_purchase',
    })
    expect(result.recommendation).toEqual([])
    expect(result.decisionBoundary).toContain('人工复核')
  })
})
