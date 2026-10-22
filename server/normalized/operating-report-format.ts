import type { OperatingProfitReport } from './profit-query-service.js'
import type { PrintTicketLine } from './print-ticket-layout.js'

/** Amounts are notes because the existing merchandise line schema forbids negatives. */
export function buildOperatingReportLines(report: OperatingProfitReport): PrintTicketLine[] {
  const metric = report.dashboard
  const money = (name: string, amount: number): PrintTicketLine => {
    if (!Number.isSafeInteger(amount)) throw new TypeError('经营报表金额无效')
    return { name, quantity: 1, note: `¥${(amount / 100).toFixed(2)}` }
  }
  return [
    { name: '经营汇总（非财务关账）', quantity: 1 },
    money('经营收入（按订单归属）', metric.incomeMinor),
    money('总经营成本', metric.totalCostMinor),
    money('经营盈亏', metric.operatingProfitMinor),
    money('实际净收（收款减成功退款）', metric.actualNetReceiptsMinor),
    money('本期成功退款', metric.successfulRefundsMinor),
    money('本期待收（截至生成时仍未收）', metric.periodOutstandingMinor),
    { name: '收入分类', quantity: 1 },
    ...report.incomeBreakdown.map(row => money(row.label, row.amountMinor)),
    { name: '成本分类（本期计入）', quantity: 1 },
    ...report.costBreakdown.map(row => ({ ...money(row.label, row.amountMinor),
      note: `¥${(row.amountMinor / 100).toFixed(2)}${row.missingCount ? ` · ${row.missingCount}项成本未知` : ''}` })),
    { name: report.status === 'provisional' ? '存在已识别缺口，相关利润暂估' : '按已入账数据计算', quantity: 1 },
    ...report.coverage.map(text => ({ name: '业务覆盖', quantity: 1, note: text })),
    ...report.caveats.map(text => ({ name: '口径与缺项', quantity: 1, note: text })),
    { name: '生成时间', quantity: 1, note: report.asOf },
  ]
}
