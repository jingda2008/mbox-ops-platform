import type { OperatingDashboardProjection, OperatingDashboardSourceQuery } from '../shared/operating-dashboard'
export type DashboardPeriod = 'day' | 'month' | 'year'
export interface DashboardSelection { period: DashboardPeriod; anchor: string }
export type DashboardReport = OperatingDashboardProjection & { period: DashboardPeriod; range: { startDate: string; endDate: string }; asOf: string; currency: string; status: 'complete' | 'provisional'; caveats: string[] }
export function operatingDashboardPath(selection: DashboardSelection, source: OperatingDashboardSourceQuery = {}) {
  const query = new URLSearchParams({ period: selection.period })
  if (selection.anchor) query.set('anchor', selection.anchor)
  if (source.kind) query.set('sourceKind', source.kind)
  if (source.category) query.set('sourceCategory', source.category)
  if (source.page) query.set('sourcePage', String(source.page))
  return `/api/commercial-ops/profit?${query}`
}
export function dashboardRange(selection: DashboardSelection, current: string) {
  const anchor = selection.anchor || current
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || !/^\d{4}-\d{2}-\d{2}$/.test(current)) return null
  const start = selection.period === 'year' ? `${anchor.slice(0, 4)}-01-01` : selection.period === 'month' ? `${anchor.slice(0, 7)}-01` : anchor
  const last = selection.period === 'year' ? `${anchor.slice(0, 4)}-12-31` : selection.period === 'month' ? new Date(Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 0)).toISOString().slice(0, 10) : anchor
  return start > current ? null : { start, end: last > current ? current : last }
}
export function readDashboardReport(value: unknown): DashboardReport {
  const report = value as DashboardReport
  if (!report || !report.dashboard || !report.range || typeof report.range.startDate !== 'string' || typeof report.asOf !== 'string'
    || !['day', 'month', 'year'].includes(report.period) || !['complete', 'provisional'].includes(report.status)
    || typeof report.currentBusinessDate !== 'string' || typeof report.effectiveEndDate !== 'string'
    || !Array.isArray(report.trend) || !Array.isArray(report.incomeBreakdown) || !Array.isArray(report.costBreakdown)
    || !Array.isArray(report.coverage) || !Array.isArray(report.sources?.rows)
    || ![report.sources.page, report.sources.total].every(value => Number.isSafeInteger(value) && value >= 0)
    || !Number.isSafeInteger(report.sources.pageSize) || report.sources.pageSize <= 0 || typeof report.sources.hasMore !== 'boolean') throw new Error('经营数据不完整，请重新读取，不能按零计算')
  const keys = ['incomeMinor', 'totalCostMinor', 'operatingProfitMinor', 'actualReceiptsMinor', 'successfulRefundsMinor', 'actualNetReceiptsMinor', 'periodOutstandingMinor', 'currentAllOutstandingMinor', 'validOrderCount', 'paidOrderCount'] as const
  if (keys.some(key => !Number.isSafeInteger(report.dashboard[key])) || !Number.isSafeInteger(report.knownMissingCostCount) || !Number.isSafeInteger(report.unassignedIncomeCount)
    || report.trend.some(row => !Number.isSafeInteger(row.incomeMinor) || !Number.isSafeInteger(row.costMinor) || !Number.isSafeInteger(row.actualNetReceiptsMinor))
    || [...report.incomeBreakdown, ...report.costBreakdown].some(row => !Number.isSafeInteger(row.amountMinor))
    || report.sources.rows.some(row => (row.amountMinor !== null && !Number.isSafeInteger(row.amountMinor)) || (row.originalAmountMinor !== undefined && !Number.isSafeInteger(row.originalAmountMinor)))) throw new Error('经营金额不完整，请重新读取，不能按零计算')
  return report
}
export function dashboardMoney(value: number | null) { return value === null ? '待补充' : `¥${(value / 100).toFixed(2)}` }
