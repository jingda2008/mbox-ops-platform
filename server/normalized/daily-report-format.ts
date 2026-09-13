import type { OperatingHistory } from '../../src/shared/operating-history.js'
import type { PrintTicketLine } from './print-ticket-layout.js'

export type DailyReportMode = 'summary' | 'details' | 'both'
export type DailyReportGrouping = 'none' | 'products' | 'categories' | 'bundles'
export interface DailyReportOptions { mode: DailyReportMode; grouping: DailyReportGrouping }
export const DEFAULT_DAILY_REPORT: DailyReportOptions = { mode: 'summary', grouping: 'none' }
export function buildDailyReportLines(snapshot: OperatingHistory, start: string, end: string, options = DEFAULT_DAILY_REPORT): PrintTicketLine[] {
  const money = (value: number) => {
    if (!Number.isSafeInteger(value)) throw new Error('日报金额缺失或超出范围，请核对后打印')
    return `¥${(value / 100).toFixed(2)}`
  }
  const field = (key: 'orderAmountMinor' | 'outstandingMinor') => {
    const value = snapshot.summary?.[key]
    if (value === undefined || value === null) throw new Error('日报金额字段缺失，请核对后打印')
    return money(Number(value))
  }
  const period = snapshot.orders.filter(order => (order.businessDate ?? start) >= start && (order.businessDate ?? start) <= end)
  const carried = snapshot.orders.filter(order => (order.businessDate ?? start) < start)
  const lines: PrintTicketLine[] = [{ name: `${options.mode === 'details' ? '期间销售明细' : '扎账汇总'} ${start} 至 ${end}`, quantity: 1 }]
  if (options.mode !== 'summary') {
    for (const order of period) {
      lines.push({ name: `${order.tableCode} · ${order.publicId}`, quantity: 1, note: `原订单金额 ${money(order.totalMinor)}${order.status === 'cancelled' ? '；已取消，不计入期间销售合计' : ''}` })
      for (const item of order.items) lines.push({ name: item.name, quantity: item.quantity,
        ...(item.includedInBundle ? {} : { unitAmountMinor: item.unitPriceMinor, totalAmountMinor: item.totalMinor }),
        note: [item.includedInBundle ? '套餐内商品，不另收费' : null, item.status === 'cancelled' ? '已取消，保留原记录' : null, item.note].filter(Boolean).join('；') || null })
    }
  }
  const totals = snapshot.receipts.reduce((sum, row) => ({ received: sum.received + row.receivedMinor, refunded: sum.refunded + row.refundedMinor, net: sum.net + row.netMinor }), { received: 0, refunded: 0, net: 0 })
  lines.push({ name: '销售合计', quantity: 1, note: field('orderAmountMinor') },
    { name: '实际收款', quantity: 1, note: money(totals.received) }, { name: '实际退款', quantity: 1, note: money(totals.refunded) },
    { name: '净收', quantity: 1, note: money(totals.net) }, { name: '尚待收款', quantity: 1, note: field('outstandingMinor') })
  const providers: Record<string, string> = { cash: '现金', postar: '星驿', wechat: '微信', physical_pos: '实体POS', external_manual: '其他线下', simulation: '模拟' }
  for (const receipt of snapshot.receipts) lines.push({ name: providers[receipt.provider] ?? receipt.provider, quantity: 1,
    note: `收款 ${money(receipt.receivedMinor)} / 退款 ${money(receipt.refundedMinor)} / 净收 ${money(receipt.netMinor)}` })
  if (options.grouping !== 'none') {
    lines.push({ name: '原成交商品汇总（取消另列，非退款后净销量）', quantity: 1 })
    const groups = new Map<string, { name: string; quantity: number; amount: number; included: boolean; cancelled: boolean; unit: string }>()
    for (const order of period) {
      const parents = new Set(order.items.map(item => item.bundleParentId).filter(Boolean))
      for (const item of order.items) {
        if (options.grouping === 'bundles' && !item.includedInBundle && !parents.has(item.id)) continue
        const name = options.grouping === 'categories' ? `${item.categoryLabel || '历史分类未留存'}${item.unitLabel ? '' : ` / ${item.name}`}` : item.name
        const included = Boolean(item.includedInBundle), cancelled = order.status === 'cancelled' || item.status === 'cancelled'
        const unit = item.unitLabel || '计价单位未留存'
        const key = JSON.stringify([options.grouping === 'categories' ? name : item.productId || item.name, name, unit, included, cancelled])
        const group = groups.get(key) ?? { name, quantity: 0, amount: 0, included, cancelled, unit }
        group.quantity += item.quantity
        group.amount += included ? 0 : item.totalMinor
        groups.set(key, group)
      }
    }
    for (const group of groups.values()) lines.push({ name: group.name, quantity: group.quantity,
      ...(group.included ? {} : { totalAmountMinor: group.amount }),
      note: [group.unit, group.included ? '套餐内出品，不重复计费' : null, group.cancelled ? '已取消，保留原成交记录' : null].filter(Boolean).join('；') })
  }
  if (carried.length) {
    lines.push({ name: '历史未完事项（不计入本期销售）', quantity: 1, note: `${carried.length}单；订单中心可查` })
    if (options.mode !== 'summary') for (const order of carried) lines.push({ name: `${order.businessDate} · ${order.tableCode} · ${order.publicId}`, quantity: 1, note: `原订单金额 ${money(order.totalMinor)}；请核对待收或售后进度` })
  }
  return lines
}
