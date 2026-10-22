import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ownerDashboardEntry } from './staff-navigation-model'
import { dashboardRange, operatingDashboardPath, readDashboardReport, type DashboardReport } from './operating-dashboard-presentation'
import { OperatingDashboardSummary, OperatingTrend } from './OperatingDashboardPanel'
const entry = { location: '/', roleCodes: ['OWNER'], permissions: ['commercial.profit.view'], navigation: [{ code: 'operations', route: '/staff/operations' }] as never }
const report: DashboardReport = { period: 'day', range: { startDate: '2026-10-23', endDate: '2026-10-23' }, asOf: '2026-10-23T00:00:00Z', currency: 'CNY', status: 'provisional', caveats: [], dashboard: { incomeMinor: -100, totalCostMinor: 230, operatingProfitMinor: -330, actualReceiptsMinor: 0, successfulRefundsMinor: 100, actualNetReceiptsMinor: -100, periodOutstandingMinor: 0, currentAllOutstandingMinor: 450, validOrderCount: 1, paidOrderCount: 1 }, currentBusinessDate: '2026-10-23', effectiveEndDate: '2026-10-23', requestedEndDate: '2026-10-23', incomeBasis: 'purchase_business_date', knownMissingCostCount: 1, unassignedIncomeCount: 0, unreconciledActivityPaymentsMinor: 0, coverage: ['普通订单'], sources: { rows: [], page: 0, pageSize: 50, total: 0, hasMore: false }, trend: [], incomeBreakdown: [], costBreakdown: [] }
describe('operating dashboard safe entry and period contract', () => {
  it('opens owner dashboard only for authorized targetless login', () => {
    expect(ownerDashboardEntry(entry)).toBe('/staff/operations')
    expect(ownerDashboardEntry({ ...entry, permissions: [] })).toBeNull()
    expect(ownerDashboardEntry({ ...entry, roleCodes: ['FINANCE'] })).toBeNull()
    expect(ownerDashboardEntry({ ...entry, navigation: [] })).toBeNull()
  })
  it.each(['/staff/orders?orderId=one', '/staff/fulfillment?screen=pickup', '/staff/fulfillment?screen=bar', '/?recover=original'])('preserves explicit route %s', location => expect(ownerDashboardEntry({ ...entry, location })).toBeNull())
  it('preserves explicit return and hash instead of repeatedly pulling a manager to the dashboard', () => {
    expect(ownerDashboardEntry({ ...entry, returningInSession: true })).toBeNull()
    expect(ownerDashboardEntry({ ...entry, hash: '#original-operation' })).toBeNull()
  })
  it('uses the store business date and clips current month/year, including leap-day and year boundary', () => {
    expect(dashboardRange({ period: 'day', anchor: '' }, '2025-12-31')).toEqual({ start: '2025-12-31', end: '2025-12-31' })
    expect(dashboardRange({ period: 'month', anchor: '' }, '2026-10-23')).toEqual({ start: '2026-10-01', end: '2026-10-23' })
    expect(dashboardRange({ period: 'year', anchor: '' }, '2026-01-01')).toEqual({ start: '2026-01-01', end: '2026-01-01' })
    expect(dashboardRange({ period: 'month', anchor: '2024-02-01' }, '2026-10-23')).toEqual({ start: '2024-02-01', end: '2024-02-29' })
    expect(dashboardRange({ period: 'day', anchor: '2027-01-01' }, '2026-10-23')).toBeNull()
  })
  it('requests original business period and server pagination without changing the aggregate scope', () => {
    expect(operatingDashboardPath({ period: 'month', anchor: '2026-09-01' }, { kind: 'cost', category: 'rent', page: 2 })).toBe('/api/commercial-ops/profit?period=month&anchor=2026-09-01&sourceKind=cost&sourceCategory=rent&sourcePage=2')
  })
  it('rejects omitted or non-integer financial fields rather than rendering fabricated zero', () => {
    expect(readDashboardReport(report)).toBe(report)
    expect(() => readDashboardReport({ ...report, dashboard: { ...report.dashboard, incomeMinor: undefined } })).toThrow('金额不完整')
    expect(() => readDashboardReport({ ...report, dashboard: { ...report.dashboard, incomeMinor: 0.1 } })).toThrow('金额不完整')
    expect(() => readDashboardReport({ ...report, sources: null })).toThrow('数据不完整')
    expect(() => readDashboardReport({ ...report, sources: { ...report.sources, total: undefined } })).toThrow('数据不完整')
    expect(() => readDashboardReport({ ...report, trend: [{ incomeMinor: 100, costMinor: 50 }] })).toThrow('金额不完整')
  })
  it('shows negative results, unknown cost caveat, source coverage and a non-positive income margin honestly', () => {
    const html = renderToStaticMarkup(createElement(OperatingDashboardSummary, { report }))
    expect(html).toContain('¥-3.30')
    expect(html).toContain('¥-1.00')
    expect(html).toContain('已知部分暂估')
    expect(html).toContain('收入为零或负数')
    expect(html).toContain('普通订单')
    expect(html).not.toContain('数据已完整核对')
  })
  it('shows an independent settlement gap without inventing missing goods costs', () => {
    const html = renderToStaticMarkup(createElement(OperatingDashboardSummary, { report: { ...report, knownMissingCostCount: 0, unassignedIncomeCount: 0, caveats: ['已确认收款尚未对账：¥50.00。请核对原支付账证。'] } }))
    expect(html).toContain('已知部分暂估')
    expect(html).toContain('已确认收款尚未对账：¥50.00')
    expect(html).not.toContain('0 项成本缺失')
  })
  it('keeps negative and zero-only trends finite and explains partial costs without relying only on color', () => {
    for (const amount of [-500, 0]) {
      const html = renderToStaticMarkup(createElement(OperatingTrend, { rows: [{ businessDate: '2026-10-01', label: '10月1日', incomeMinor: amount, costMinor: 0, actualNetReceiptsMinor: amount, provisional: true }] }))
      expect(html).toContain('虚线：经营成本')
      expect(html).toContain('已知部分暂估')
      expect(html).toContain('零值基线')
      expect(html).not.toMatch(/NaN|Infinity/)
    }
  })
})
