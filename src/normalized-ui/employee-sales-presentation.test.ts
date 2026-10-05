import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { employeeSales, signedMinorAmount, loadOperatingReports } from './employee-sales-presentation'
import { EmployeeSalesSummary } from './EmployeeSalesSummary'
import { OperationsModule } from './StaffModulePanel'

// Mirrors commercial-ops-api.toEmployeeSalesDto: public codes, decimal quantity,
// signed net attribution, and explicitly unknown cost. UUIDs are not on the wire.
const dto = {
  employeeCode: 'staff-a', employeeDisplayName: '同名员工',
  productCode: 'drink-a', productName: '原商品', categoryCode: 'drink',
  quantity: '-0.500000', salesAmountMinor: -1250,
  costAmountMinor: null, contributionProfitMinor: null,
  refundReversalAmountMinor: 1250, costCoverageComplete: false, currency: 'CNY',
}

describe('employee sales public contract', () => {
  it('accepts the actual public DTO without internal UUIDs and retains signed decimal quantity', () => {
    expect(employeeSales([dto])).toEqual([{
      employeeCode: 'staff-a', employeeDisplayName: '同名员工',
      productCode: 'drink-a', productName: '原商品',
      quantity: '-0.500000', salesAmountMinor: -1250, currency: 'CNY',
    }])
  })
  it('shows negative net attribution as negative without presenting cost or profit', () => {
    const html = renderToStaticMarkup(createElement(EmployeeSalesSummary, { sales: employeeSales([dto]) }))
    expect(html).toContain('原商品')
    expect(html).toContain('净数量 -0.500000件')
    expect(html).toContain('¥-12.50')
    expect(html).toContain('含退款冲减')
    expect(html).not.toContain('暂无销售归属')
    expect(html).not.toContain('contributionProfit')
    expect(html).not.toContain('成本 ¥0')
  })
  it('keeps different public employee codes with the same display name as separate rows', () => {
    const sales = employeeSales([dto, { ...dto, employeeCode: 'staff-b', quantity: '2.000000', salesAmountMinor: 5000 }])
    const html = renderToStaticMarkup(createElement(EmployeeSalesSummary, { sales }))
    expect(html.match(/<article/g)).toHaveLength(2)
    expect(html).toContain('¥-12.50')
    expect(html).toContain('¥50.00')
  })
  it('offers subsequent rows instead of silently discarding every row after the thirtieth', () => {
    const sales = employeeSales(Array.from({ length: 31 }, (_, index) => ({ ...dto, productCode: `drink-${index}`, productName: `商品${index}` })))
    const html = renderToStaticMarkup(createElement(EmployeeSalesSummary, { sales }))
    expect(html.match(/<article/g)).toHaveLength(30)
    expect(html).toContain('已显示 30 / 31 条销售归属')
    expect(html).toContain('显示更多销售归属')
  })
  it('distinguishes a valid empty response from a malformed or incompatible response', () => {
    expect(employeeSales([])).toEqual([])
    expect(() => employeeSales({})).toThrow('数据格式异常')
    expect(() => employeeSales([{ ...dto, employeeCode: undefined, employeeId: 'internal-id' }])).toThrow('记录不完整')
  })
  it.each([
    { quantity: 2 }, { quantity: 'NaN' }, { quantity: '1e3' },
    { salesAmountMinor: NaN }, { salesAmountMinor: Infinity }, { salesAmountMinor: 12.5 },
    { salesAmountMinor: Number.MAX_SAFE_INTEGER + 1 }, { currency: '' },
  ])('rejects invalid values rather than silently rendering an empty or zero sales result: %j', (invalid) => {
    expect(() => employeeSales([{ ...dto, ...invalid }])).toThrow('记录不完整')
  })
  it('keeps zero and negative minor-unit arithmetic explicit', () => {
    expect(signedMinorAmount(0)).toBe('0.00')
    expect(signedMinorAmount(-1)).toBe('-0.01')
    expect(signedMinorAmount(1250)).toBe('12.50')
  })
  it('also preserves a refund-heavy day negative net receipt in the operating overview', () => {
    const props: Parameters<typeof OperationsModule>[0] = {
      api: {} as never, auth: { permissions: ['commercial.profit.view'] } as never,
      canViewProfit: true, sales: [],
      view: {
        range: { startDate: '2026-10-05', endDate: '2026-10-05' }, status: 'complete',
        revenue: { cash: { netReceiptsMinor: -12345 } },
        costs: { goodsCostMinor: 0, operatingExpenseMinor: 0, inventoryLossMinor: 0 },
        profit: { grossProfitMinor: -12345, operatingProfitMinor: -12345, cashBalanceMinor: -12345 },
        gaps: { orderItemsMissingCostCount: 0, inventoryLossesMissingCostCount: 0 }, caveats: [],
      } as never,
    }
    const html = renderToStaticMarkup(createElement(OperationsModule, props))
    expect(html).toMatch(/实收净额<\/small><strong class="is-negative">¥-123\.45<\/strong>/)
  })
})

describe('independent operating report permissions', () => {
  it.each([
    { permissions: ['commercial.profit.view', 'commercial.sales.view'], paths: ['/api/commercial-ops/profit?period=day', '/api/commercial-ops/employee-sales'] },
    { permissions: ['commercial.profit.view'], paths: ['/api/commercial-ops/profit?period=day'] },
    { permissions: ['commercial.sales.view'], paths: ['/api/commercial-ops/employee-sales'] },
    { permissions: ['commercial.sales.view_all'], paths: ['/api/commercial-ops/employee-sales'] },
    { permissions: ['commercial.cost.view'], paths: [] },
  ])('loads only each separately granted report: $permissions', async ({ permissions, paths }) => {
    const calls: string[] = []
    const reports = await loadOperatingReports(async (path) => {
      calls.push(path)
      return { data: path.endsWith('employee-sales') ? [dto] : { status: 'complete' } }
    }, permissions)
    expect(calls).toEqual(paths)
    expect(reports.sales).toHaveLength(paths.some((path) => path.endsWith('employee-sales')) ? 1 : 0)
    expect(reports.profit).toEqual(permissions.includes('commercial.profit.view') ? { status: 'complete' } : null)
  })
  it('does not turn a failed sales read into a zero/empty success', async () => {
    await expect(loadOperatingReports(async () => { throw new Error('暂时无法读取') }, ['commercial.sales.view']))
      .rejects.toThrow('暂时无法读取')
  })
  it.each([true, false])('keeps sales reachable with a profit grant, including missing profit data: %s', (hasProfit) => {
    const props: Parameters<typeof OperationsModule>[0] = {
      api: {} as never,
      auth: { permissions: ['commercial.profit.view', 'commercial.sales.view'] } as never,
      canViewProfit: true, sales: employeeSales([dto]),
      view: hasProfit ? {
        range: { startDate: '2026-10-05', endDate: '2026-10-05' }, status: 'complete',
        revenue: { cash: { netReceiptsMinor: -12345 } },
        costs: { goodsCostMinor: 0, operatingExpenseMinor: 0, inventoryLossMinor: 0 },
        profit: { grossProfitMinor: -12345, operatingProfitMinor: -12345, cashBalanceMinor: -12345 },
        gaps: { orderItemsMissingCostCount: 0, inventoryLossesMissingCostCount: 0 }, caveats: [],
      } as never : null,
    }
    const html = renderToStaticMarkup(createElement(OperationsModule, props))
    expect(html).toContain('aria-label="员工销售归属"')
    expect(html).toContain('原商品')
    expect(html).toContain('¥-12.50')
  })
  it('does not render sales from an old payload after the sales grant is absent', () => {
    const props: Parameters<typeof OperationsModule>[0] = {
      api: {} as never, auth: { permissions: ['commercial.profit.view'] } as never,
      canViewProfit: true, view: null, sales: employeeSales([dto]),
    }
    const html = renderToStaticMarkup(createElement(OperationsModule, props))
    expect(html).not.toContain('员工销售归属')
    expect(html).not.toContain('原商品')
  })
})
