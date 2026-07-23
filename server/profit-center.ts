import type {
  OperatingCostCategoryId,
  OperatingCostEntry,
  ProfitCategoryRow,
  ProfitCenterReport,
  ProfitReportPeriod,
  ProfitTrendRow,
  RecurringCostFrequency,
  RecurringCostTemplate,
} from '../src/shared/commercial-ops-contracts.js'
import type { RuntimeState } from '../src/shared/contracts.js'
import { chinaBusinessDateKey, shiftDateKey } from '../src/shared/china-time.js'
import { commercialOpsFor } from './commercial-ops.js'
import { tableOperationsConfig } from './table-sessions.js'

interface DateRange {
  startDate: string
  endDate: string
}

interface DailyCost {
  date: string
  categoryId: ProfitCategoryRow['categoryId']
  actualAmount: number
  estimatedAmount: number
  source: ProfitCategoryRow['source']
}

interface DailyRevenue {
  paymentAmount: number
  voucherSettlementAmount: number
  refundAmount: number
  pendingPosAmount: number
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/

function assertDateKey(value: string) {
  if (!datePattern.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00.000Z`))) {
    throw new Error('日期必须使用YYYY-MM-DD格式')
  }
}

function utcDate(value: string) {
  assertDateKey(value)
  return new Date(`${value}T12:00:00.000Z`)
}

function endOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0, 12)).toISOString().slice(0, 10)
}

export function profitPeriodRange(period: ProfitReportPeriod, anchorDate: string): DateRange {
  const anchor = utcDate(anchorDate)
  const year = anchor.getUTCFullYear()
  const month = anchor.getUTCMonth()
  if (period === 'day') return { startDate: anchorDate, endDate: anchorDate }
  if (period === 'week') {
    const mondayOffset = (anchor.getUTCDay() + 6) % 7
    const startDate = shiftDateKey(anchorDate, -mondayOffset)
    return { startDate, endDate: shiftDateKey(startDate, 6) }
  }
  if (period === 'month') {
    return { startDate: `${year}-${String(month + 1).padStart(2, '0')}-01`, endDate: endOfMonth(year, month) }
  }
  if (period === 'quarter') {
    const firstMonth = Math.floor(month / 3) * 3
    return {
      startDate: `${year}-${String(firstMonth + 1).padStart(2, '0')}-01`,
      endDate: endOfMonth(year, firstMonth + 2),
    }
  }
  return { startDate: `${year}-01-01`, endDate: `${year}-12-31` }
}

function datesBetween(startDate: string, endDate: string) {
  const result: string[] = []
  for (let date = startDate; date <= endDate; date = shiftDateKey(date, 1)) result.push(date)
  return result
}

function rangesOverlap(left: DateRange, right: DateRange) {
  return left.startDate <= right.endDate && right.startDate <= left.endDate
}

function amountInsideRange(amount: number, source: DateRange, target: DateRange, spreadDaily: boolean) {
  if (!rangesOverlap(source, target)) return 0
  if (!spreadDaily) return source.startDate >= target.startDate && source.startDate <= target.endDate ? amount : 0
  const sourceDates = datesBetween(source.startDate, source.endDate)
  const base = Math.floor(amount / sourceDates.length)
  const remainder = amount - base * sourceDates.length
  return sourceDates.reduce((total, date, index) => (
    date >= target.startDate && date <= target.endDate ? total + base + (index < remainder ? 1 : 0) : total
  ), 0)
}

function distributeAmount(amount: number, source: DateRange, target: DateRange, spreadDaily: boolean) {
  const amounts = new Map<string, number>()
  if (!rangesOverlap(source, target)) return amounts
  if (!spreadDaily) {
    if (source.startDate >= target.startDate && source.startDate <= target.endDate) amounts.set(source.startDate, amount)
    return amounts
  }
  const sourceDates = datesBetween(source.startDate, source.endDate)
  const base = Math.floor(amount / sourceDates.length)
  const remainder = amount - base * sourceDates.length
  sourceDates.forEach((date, index) => {
    if (date >= target.startDate && date <= target.endDate) amounts.set(date, base + (index < remainder ? 1 : 0))
  })
  return amounts
}

function addMonthsFromAnchor(anchorDate: string, monthOffset: number) {
  const anchor = utcDate(anchorDate)
  const year = anchor.getUTCFullYear()
  const month = anchor.getUTCMonth()
  const day = anchor.getUTCDate()
  const targetFirst = new Date(Date.UTC(year, month + monthOffset, 1, 12))
  const targetYear = targetFirst.getUTCFullYear()
  const targetMonth = targetFirst.getUTCMonth()
  const lastDay = Number(endOfMonth(targetYear, targetMonth).slice(-2))
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
}

function recurringDate(template: RecurringCostTemplate, index: number) {
  if (template.frequency === 'weekly') return shiftDateKey(template.startDate, index * 7)
  const multiplier = template.frequency === 'monthly' ? 1 : template.frequency === 'quarterly' ? 3 : 12
  return addMonthsFromAnchor(template.startDate, index * multiplier)
}

function recurringRecognitionRange(
  template: RecurringCostTemplate,
  occurrenceDate: string,
  nextOccurrenceDate: string,
): DateRange {
  if (template.recognitionMode === 'on_start') return { startDate: occurrenceDate, endDate: occurrenceDate }
  const naturalEnd = shiftDateKey(nextOccurrenceDate, -1)
  return {
    startDate: occurrenceDate,
    endDate: template.endDate && template.endDate < naturalEnd ? template.endDate : naturalEnd,
  }
}

export function recurringOccurrenceRange(template: RecurringCostTemplate, occurrenceDate: string): DateRange | null {
  if (occurrenceDate < template.startDate || (template.endDate && occurrenceDate > template.endDate)) return null
  for (let index = 0; index < 2_000; index += 1) {
    const date = recurringDate(template, index)
    if (date > occurrenceDate || (template.endDate && date > template.endDate)) return null
    if (date === occurrenceDate) {
      return recurringRecognitionRange(template, date, recurringDate(template, index + 1))
    }
  }
  return null
}

function recurringOccurrences(template: RecurringCostTemplate, reportRange: DateRange) {
  const result: Array<{ date: string; range: DateRange }> = []
  if (!template.enabled || template.startDate > reportRange.endDate) return result
  for (let index = 0; index < 2_000; index += 1) {
    const date = recurringDate(template, index)
    if (template.endDate && date > template.endDate) break
    const nextDate = recurringDate(template, index + 1)
    const range = recurringRecognitionRange(template, date, nextDate)
    if (range.startDate > reportRange.endDate) break
    if (rangesOverlap(range, reportRange)) result.push({ date, range })
  }
  return result
}

function movementCost(state: RuntimeState, movement: NonNullable<RuntimeState['inventoryDomain']>['movements'][number]) {
  const snapshot = movement.configurationSnapshot
  if (snapshot?.kind === 'recipe') return Math.round(movement.quantity * snapshot.ingredient.costAmountPerBaseUnit)
  if (snapshot?.kind === 'unit_conversion') return Math.round(movement.quantity * snapshot.ingredient.costAmountPerBaseUnit)
  const orderItem = movement.orderItemId
    ? state.orderDomain.orders.flatMap((order) => order.items).find((item) => item.id === movement.orderItemId)
    : null
  if (orderItem) return Math.round(movement.quantity * orderItem.unitCostAmount)
  const ingredient = state.inventoryDomain?.ingredientSkus.find((item) => item.id === movement.productId)
  if (ingredient) return Math.round(movement.quantity * ingredient.costAmountPerBaseUnit)
  const product = state.products.find((item) => item.id === movement.productId)
  return Math.round(movement.quantity * (product?.costAmount ?? 0))
}

function configuredBusinessDate(state: RuntimeState, value: string) {
  const rolloverHour = tableOperationsConfig(state).businessDayRolloverHour ?? 6
  return chinaBusinessDateKey(value, rolloverHour)
}

function orderDate(state: RuntimeState, order: RuntimeState['orderDomain']['orders'][number]) {
  return configuredBusinessDate(state, order.submittedAt ?? order.createdAt)
}

function revenueByDate(state: RuntimeState, range: DateRange) {
  const rows = new Map<string, DailyRevenue>()
  const rowFor = (date: string) => {
    const existing = rows.get(date)
    if (existing) return existing
    const created = { paymentAmount: 0, voucherSettlementAmount: 0, refundAmount: 0, pendingPosAmount: 0 }
    rows.set(date, created)
    return created
  }
  const succeededOrderIds = new Set<string>()
  let pendingPosCount = 0
  for (const intent of state.paymentDomain.paymentIntents) {
    if (intent.status === 'succeeded') {
      for (const orderId of intent.orderIds) succeededOrderIds.add(orderId)
    }
    const date = intent.businessDate ?? configuredBusinessDate(state, intent.paidAt ?? intent.createdAt)
    if (date < range.startDate || date > range.endDate) continue
    if (intent.status === 'succeeded') {
      rowFor(date).paymentAmount += intent.amount
    } else if (intent.status === 'reported_pending_reconciliation') {
      rowFor(date).pendingPosAmount += intent.amount
      pendingPosCount += 1
    }
  }
  let excludedDuplicateVoucherCount = 0
  for (const redemption of commercialOpsFor(state).voucherRedemptions) {
    if (redemption.status !== 'redeemed') continue
    const date = configuredBusinessDate(state, redemption.redeemedAt)
    if (date < range.startDate || date > range.endDate) continue
    if (redemption.orderId && succeededOrderIds.has(redemption.orderId)) {
      excludedDuplicateVoucherCount += 1
      continue
    }
    rowFor(date).voucherSettlementAmount += redemption.settlementAmount
  }
  for (const refund of state.paymentDomain.refunds) {
    if (refund.status !== 'succeeded' || !refund.succeededAt) continue
    const date = configuredBusinessDate(state, refund.succeededAt)
    if (date >= range.startDate && date <= range.endDate) rowFor(date).refundAmount += refund.amount
  }
  return { rows, pendingPosCount, excludedDuplicateVoucherCount }
}

function goodsCostsByDate(state: RuntimeState, range: DateRange) {
  const actual = new Map<string, number>()
  const estimated = new Map<string, number>()
  const losses = new Map<string, number>()
  const accountedItemIds = new Set<string>()
  for (const movement of state.inventoryDomain?.movements ?? []) {
    if (movement.businessDate < range.startDate || movement.businessDate > range.endDate) continue
    const cost = movementCost(state, movement)
    if (movement.orderItemId && ['sale', 'gift', 'refund'].includes(movement.type)) accountedItemIds.add(movement.orderItemId)
    if (movement.type === 'sale' || movement.type === 'gift') {
      actual.set(movement.businessDate, (actual.get(movement.businessDate) ?? 0) + cost)
    } else if (movement.type === 'refund') {
      actual.set(movement.businessDate, (actual.get(movement.businessDate) ?? 0) - cost)
    } else if (movement.type === 'remake' || movement.type === 'stock_count_loss') {
      losses.set(movement.businessDate, (losses.get(movement.businessDate) ?? 0) + cost)
    }
  }
  let estimatedGoodsOrderItemCount = 0
  for (const order of state.orderDomain.orders) {
    if (order.status === 'draft') continue
    const date = orderDate(state, order)
    if (date < range.startDate || date > range.endDate) continue
    for (const item of order.items) {
      if (accountedItemIds.has(item.id)) continue
      estimated.set(date, (estimated.get(date) ?? 0) + item.unitCostAmount * item.quantity)
      estimatedGoodsOrderItemCount += 1
    }
  }
  return { actual, estimated, losses, estimatedGoodsOrderItemCount }
}

function activeCostEntries(entries: OperatingCostEntry[]) {
  const active = entries.filter((entry) => entry.status !== 'voided')
  const replacedIds = new Set(active.filter((entry) => entry.status === 'actual' && entry.replacesEntryId).map((entry) => entry.replacesEntryId!))
  return active.filter((entry) => !replacedIds.has(entry.id))
}

function operatingCostsByDate(state: RuntimeState, range: DateRange) {
  const domain = commercialOpsFor(state)
  const entries = activeCostEntries(domain.costEntries)
  const costs: DailyCost[] = []
  let actualEntryCount = 0
  let estimatedEntryCount = 0
  const add = (
    categoryId: OperatingCostCategoryId,
    status: 'actual' | 'estimated',
    amount: number,
    sourceRange: DateRange,
    spreadDaily: boolean,
  ) => {
    const distributed = distributeAmount(amount, sourceRange, range, spreadDaily)
    if (distributed.size === 0) return false
    for (const [date, allocated] of distributed) {
      costs.push({
        date,
        categoryId,
        actualAmount: status === 'actual' ? allocated : 0,
        estimatedAmount: status === 'estimated' ? allocated : 0,
        source: 'manual',
      })
    }
    return true
  }
  for (const entry of entries) {
    const included = add(
      entry.categoryId,
      entry.status === 'actual' ? 'actual' : 'estimated',
      entry.amount,
      { startDate: entry.recognitionStartDate, endDate: entry.recognitionEndDate },
      entry.recognitionMode === 'spread_daily',
    )
    if (included) {
      if (entry.status === 'actual') actualEntryCount += 1
      else estimatedEntryCount += 1
    }
  }
  const overriddenOccurrences = new Set(entries.filter((entry) => (
    entry.status === 'actual' && entry.sourceTemplateId && entry.sourceOccurrenceDate
  )).map((entry) => `${entry.sourceTemplateId}:${entry.sourceOccurrenceDate}`))
  for (const template of domain.recurringCostTemplates) {
    for (const occurrence of recurringOccurrences(template, range)) {
      if (overriddenOccurrences.has(`${template.id}:${occurrence.date}`)) continue
      if (add(template.categoryId, 'estimated', template.amount, occurrence.range, template.recognitionMode === 'spread_daily')) {
        estimatedEntryCount += 1
      }
    }
  }
  return { costs, actualEntryCount, estimatedEntryCount }
}

function trendBuckets(period: ProfitReportPeriod, range: DateRange) {
  if (period === 'day' || period === 'week') {
    return datesBetween(range.startDate, range.endDate).map((date) => ({
      key: date,
      label: date,
      range: { startDate: date, endDate: date },
    }))
  }
  if (period === 'month') {
    const result: Array<{ key: string; label: string; range: DateRange }> = []
    for (let startDate = range.startDate; startDate <= range.endDate; startDate = shiftDateKey(startDate, 7)) {
      const naturalEnd = shiftDateKey(startDate, 6)
      const endDate = naturalEnd < range.endDate ? naturalEnd : range.endDate
      result.push({
        key: startDate,
        label: `${Number(startDate.slice(-2))}-${Number(endDate.slice(-2))}日`,
        range: { startDate, endDate },
      })
    }
    return result
  }
  const result: Array<{ key: string; label: string; range: DateRange }> = []
  for (let date = range.startDate; date <= range.endDate;) {
    const monthEnd = endOfMonth(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1)
    result.push({
      key: date.slice(0, 7),
      label: `${Number(date.slice(5, 7))}月`,
      range: { startDate: date, endDate: monthEnd < range.endDate ? monthEnd : range.endDate },
    })
    date = shiftDateKey(monthEnd, 1)
  }
  return result
}

function sumMapInside(map: Map<string, number>, range: DateRange) {
  let total = 0
  for (const [date, amount] of map) if (date >= range.startDate && date <= range.endDate) total += amount
  return total
}

export function buildProfitCenterReport(
  state: RuntimeState,
  period: ProfitReportPeriod,
  anchorDate: string,
  now: Date | number = Date.now(),
): ProfitCenterReport {
  const range = profitPeriodRange(period, anchorDate)
  const revenue = revenueByDate(state, range)
  const goods = goodsCostsByDate(state, range)
  const operating = operatingCostsByDate(state, range)
  const paymentAmount = [...revenue.rows.values()].reduce((sum, row) => sum + row.paymentAmount, 0)
  const voucherSettlementAmount = [...revenue.rows.values()].reduce((sum, row) => sum + row.voucherSettlementAmount, 0)
  const refundAmount = [...revenue.rows.values()].reduce((sum, row) => sum + row.refundAmount, 0)
  const pendingPosAmount = [...revenue.rows.values()].reduce((sum, row) => sum + row.pendingPosAmount, 0)
  const netAmount = paymentAmount + voucherSettlementAmount - refundAmount
  const goodsCostAmount = sumMapInside(goods.actual, range)
  const estimatedGoodsCostAmount = sumMapInside(goods.estimated, range)
  const inventoryLossAmount = sumMapInside(goods.losses, range)
  const actualOperatingExpenseAmount = operating.costs.reduce((sum, cost) => sum + cost.actualAmount, 0)
  const estimatedOperatingExpenseAmount = operating.costs.reduce((sum, cost) => sum + cost.estimatedAmount, 0)
  const totalAmount = goodsCostAmount + estimatedGoodsCostAmount + inventoryLossAmount
    + actualOperatingExpenseAmount + estimatedOperatingExpenseAmount

  const categoryMap = new Map<ProfitCategoryRow['categoryId'], ProfitCategoryRow>()
  const addCategory = (
    categoryId: ProfitCategoryRow['categoryId'],
    actualAmount: number,
    estimatedAmount: number,
    source: ProfitCategoryRow['source'],
  ) => {
    if (actualAmount === 0 && estimatedAmount === 0) return
    const row = categoryMap.get(categoryId) ?? { categoryId, actualAmount: 0, estimatedAmount: 0, totalAmount: 0, source }
    row.actualAmount += actualAmount
    row.estimatedAmount += estimatedAmount
    row.totalAmount = row.actualAmount + row.estimatedAmount
    if (row.source !== source) row.source = 'mixed'
    categoryMap.set(categoryId, row)
  }
  addCategory('goods_cogs', goodsCostAmount, estimatedGoodsCostAmount, 'automatic')
  addCategory('inventory_loss', inventoryLossAmount, 0, 'automatic')
  for (const cost of operating.costs) addCategory(cost.categoryId, cost.actualAmount, cost.estimatedAmount, cost.source)

  const trendRows: ProfitTrendRow[] = trendBuckets(period, range).map((bucket) => {
    let revenueAmount = 0
    for (const [date, row] of revenue.rows) {
      if (date >= bucket.range.startDate && date <= bucket.range.endDate) {
        revenueAmount += row.paymentAmount + row.voucherSettlementAmount - row.refundAmount
      }
    }
    const costAmount = sumMapInside(goods.actual, bucket.range) + sumMapInside(goods.estimated, bucket.range)
      + sumMapInside(goods.losses, bucket.range)
      + operating.costs.filter((cost) => cost.date >= bucket.range.startDate && cost.date <= bucket.range.endDate)
        .reduce((sum, cost) => sum + cost.actualAmount + cost.estimatedAmount, 0)
    return { key: bucket.key, label: bucket.label, revenueAmount, costAmount, profitAmount: revenueAmount - costAmount }
  })

  const grossProfitAmount = netAmount - goodsCostAmount - estimatedGoodsCostAmount
  const confirmedOperatingProfitAmount = netAmount - goodsCostAmount - inventoryLossAmount - actualOperatingExpenseAmount
  const projectedOperatingProfitAmount = netAmount - totalAmount
  return {
    period,
    anchorDate,
    startDate: range.startDate,
    endDate: range.endDate,
    generatedAt: new Date(now).toISOString(),
    revenue: { paymentAmount, voucherSettlementAmount, refundAmount, netAmount, pendingPosAmount },
    costs: {
      goodsCostAmount,
      estimatedGoodsCostAmount,
      inventoryLossAmount,
      actualOperatingExpenseAmount,
      estimatedOperatingExpenseAmount,
      totalAmount,
    },
    profit: {
      grossProfitAmount,
      confirmedOperatingProfitAmount,
      projectedOperatingProfitAmount,
      projectedMarginBps: netAmount > 0 ? Math.round(projectedOperatingProfitAmount / netAmount * 10_000) : 0,
    },
    categoryRows: [...categoryMap.values()].toSorted((left, right) => right.totalAmount - left.totalAmount),
    trendRows,
    quality: {
      pendingPosCount: revenue.pendingPosCount,
      estimatedEntryCount: operating.estimatedEntryCount,
      actualEntryCount: operating.actualEntryCount,
      estimatedGoodsOrderItemCount: goods.estimatedGoodsOrderItemCount,
      excludedDuplicateVoucherCount: revenue.excludedDuplicateVoucherCount,
    },
  }
}

export function costEntryAmountInRange(entry: OperatingCostEntry, range: DateRange) {
  return amountInsideRange(
    entry.amount,
    { startDate: entry.recognitionStartDate, endDate: entry.recognitionEndDate },
    range,
    entry.recognitionMode === 'spread_daily',
  )
}

export function recurringCycleEnd(frequency: RecurringCostFrequency, occurrenceDate: string) {
  const template = {
    startDate: occurrenceDate,
    frequency,
  } as RecurringCostTemplate
  return shiftDateKey(recurringDate(template, 1), -1)
}
