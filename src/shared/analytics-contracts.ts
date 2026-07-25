import { z } from 'zod'

export const analyticsMetricIds = [
  'sales_amount',
  'sales_quantity',
  'estimated_gross_profit',
  'order_count',
  'average_check',
  'guest_count',
  'service_request_count',
  'service_completion_rate',
  'median_service_response_seconds',
  'complaint_count',
] as const

export type AnalyticsMetricId = (typeof analyticsMetricIds)[number]

export const analyticsDimensionIds = [
  'none',
  'product',
  'category',
  'table',
  'employee',
  'party_size',
  'business_date',
  'hour',
  'service_type',
] as const

export type AnalyticsDimensionId = (typeof analyticsDimensionIds)[number]

export const analyticsPeriodIds = [
  'current_business_day',
  'previous_business_day',
  'last_7_business_days',
  'this_month',
  'last_month',
  'custom',
] as const

export type AnalyticsPeriodId = (typeof analyticsPeriodIds)[number]

export const analyticsQuerySchema = z.object({
  metric: z.enum(analyticsMetricIds),
  dimension: z.enum(analyticsDimensionIds).default('none'),
  period: z.enum(analyticsPeriodIds).default('current_business_day'),
  limit: z.number().int().min(1).max(20).default(10),
  sort: z.enum(['desc', 'asc']).default('desc'),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
}).strict().superRefine((query, context) => {
  if (query.period === 'custom' && (!query.dateFrom || !query.dateTo)) {
    context.addIssue({ code: 'custom', path: ['dateFrom'], message: '自定义统计需要开始和结束营业日' })
  }
  if (query.period !== 'custom' && (query.dateFrom || query.dateTo)) {
    context.addIssue({ code: 'custom', path: ['dateFrom'], message: '非自定义统计不能附带日期范围' })
  }
})

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>

export type AnalyticsValueUnit = 'amount_minor' | 'count' | 'percent' | 'seconds'

export interface AnalyticsResultRow {
  key: string
  label: string
  value: number
  formattedValue: string
  sampleSize: number
}

export interface AnalyticsResult {
  query: AnalyticsQuery
  metricLabel: string
  dimensionLabel: string
  periodLabel: string
  dateFrom: string
  dateTo: string
  scopeLabel: string
  unit: AnalyticsValueUnit
  total: number
  formattedTotal: string
  rows: AnalyticsResultRow[]
  sampleSize: number
  definition: string
  dataAsOf: string
  completeness: 'complete' | 'partial'
  missingPartySizeSessions: number
}
