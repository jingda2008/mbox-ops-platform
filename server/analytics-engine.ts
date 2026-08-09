import { randomUUID } from 'node:crypto'
import {
  analyticsQuerySchema,
  type AnalyticsDimensionId,
  type AnalyticsMetricId,
  type AnalyticsQuery,
  type AnalyticsResult,
  type AnalyticsResultRow,
  type AnalyticsValueUnit,
} from '../src/shared/analytics-contracts.js'
import type { RuntimeState, ServiceTask } from '../src/shared/contracts.js'
import type { Order, OrderItem } from '../src/shared/order-contracts.js'
import {
  effectiveDataScopeForEmployee,
  effectivePermissionIdsForEmployee,
} from '../src/shared/staff-access.js'
import { venueBusinessDateKey } from '../src/shared/venue-time.js'
import { tableSessionBusinessDate } from './table-sessions.js'

interface AnalyticsActor {
  actorId: string
}

interface PeriodBounds {
  from: string
  to: string
  label: string
}

interface GroupKey {
  key: string
  label: string
}

interface OrderFact {
  order: Order
  businessDate: string
  tableId: string
  tableCode: string
  areaId: string
  employeeId: string | null
  employeeName: string
  partySize: number | null
  hour: number
}

interface ServiceFact {
  task: ServiceTask
  businessDate: string
  tableId: string
  tableCode: string
  areaId: string
  employeeId: string | null
  employeeName: string
  serviceTypeId: string
  serviceTypeName: string
  hour: number
}

interface NumericBucket {
  key: string
  label: string
  sum: number
  numerator: number
  denominator: number
  values: number[]
  sampleSize: number
}

const metricDefinitions: Record<AnalyticsMetricId, {
  label: string
  unit: AnalyticsValueUnit
  definition: string
  allowedDimensions: AnalyticsDimensionId[]
  requiresFinance?: boolean
}> = {
  sales_amount: {
    label: '商品销售额',
    unit: 'amount_minor',
    definition: '统计已提交订单中商品实际售价乘数量的合计；不包含草稿单，金额单位为人民币。',
    allowedDimensions: ['none', 'product', 'category', 'table', 'employee', 'party_size', 'business_date', 'hour'],
  },
  sales_quantity: {
    label: '售出数量',
    unit: 'count',
    definition: '统计已提交订单的商品数量合计；不包含草稿单。',
    allowedDimensions: ['none', 'product', 'category', 'table', 'employee', 'party_size', 'business_date', 'hour'],
  },
  estimated_gross_profit: {
    label: '预估商品毛利',
    unit: 'amount_minor',
    definition: '按已提交订单商品实际售价减下单时记录的单位成本计算；属于经营估算，不替代财务结账。',
    allowedDimensions: ['none', 'product', 'category', 'table', 'employee', 'party_size', 'business_date', 'hour'],
    requiresFinance: true,
  },
  order_count: {
    label: '订单数',
    unit: 'count',
    definition: '统计已提交、制作中或已完成的订单数量；不包含草稿单。',
    allowedDimensions: ['none', 'table', 'employee', 'party_size', 'business_date', 'hour'],
  },
  average_check: {
    label: '桌均消费',
    unit: 'amount_minor',
    definition: '商品销售额除以产生已提交订单的有效桌次；按桌次计算，不按下单次数计算。',
    allowedDimensions: ['none', 'table', 'employee', 'party_size', 'business_date', 'hour'],
  },
  guest_count: {
    label: '到店人数',
    unit: 'count',
    definition: '按开台时保存的人数快照统计，每个有效桌次只计算一次；加桌不会重复计算人数。',
    allowedDimensions: ['none', 'table', 'employee', 'party_size', 'business_date', 'hour'],
  },
  service_request_count: {
    label: '服务需求数',
    unit: 'count',
    definition: '统计服务任务总数，包括客人、员工和SOP发起的需求。',
    allowedDimensions: ['none', 'table', 'employee', 'business_date', 'hour', 'service_type'],
  },
  service_completion_rate: {
    label: '服务完成率',
    unit: 'percent',
    definition: '已完成或已确认的服务任务数除以非取消服务任务数。',
    allowedDimensions: ['none', 'table', 'employee', 'business_date', 'hour', 'service_type'],
  },
  median_service_response_seconds: {
    label: '服务响应中位数',
    unit: 'seconds',
    definition: '服务任务从创建到首次接单的耗时中位数；尚未接单的任务不进入耗时样本。',
    allowedDimensions: ['none', 'table', 'employee', 'business_date', 'hour', 'service_type'],
  },
  complaint_count: {
    label: '投诉需求数',
    unit: 'count',
    definition: '统计服务类型配置为投诉的服务任务数量。',
    allowedDimensions: ['none', 'table', 'employee', 'business_date', 'hour'],
  },
}

const dimensionLabels: Record<AnalyticsDimensionId, string> = {
  none: '总计',
  product: '商品',
  category: '品类',
  table: '桌台',
  employee: '员工',
  party_size: '到店人数',
  business_date: '营业日',
  hour: '时段',
  service_type: '服务类型',
}

function shiftDate(date: string, offsetDays: number) {
  const value = new Date(`${date}T12:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + offsetDays)
  return value.toISOString().slice(0, 10)
}

function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`
}

function previousMonth(date: string) {
  const value = new Date(`${monthStart(date)}T12:00:00.000Z`)
  value.setUTCMonth(value.getUTCMonth() - 1)
  return value.toISOString().slice(0, 10)
}

function periodBounds(state: RuntimeState, query: AnalyticsQuery): PeriodBounds {
  const current = state.store.businessDate
  if (query.period === 'current_business_day') return { from: current, to: current, label: `本营业日 ${current}` }
  if (query.period === 'previous_business_day') {
    const date = shiftDate(current, -1)
    return { from: date, to: date, label: `上一营业日 ${date}` }
  }
  if (query.period === 'last_7_business_days') {
    return { from: shiftDate(current, -6), to: current, label: '最近7个营业日' }
  }
  if (query.period === 'this_month') return { from: monthStart(current), to: current, label: `${current.slice(0, 7)}月` }
  if (query.period === 'last_month') {
    const from = previousMonth(current)
    return { from, to: shiftDate(monthStart(current), -1), label: `${from.slice(0, 7)}月` }
  }
  const from = query.dateFrom!
  const to = query.dateTo!
  if (from > to) throw new Error('统计开始营业日不能晚于结束营业日')
  if (to > current) throw new Error('不能统计未来营业日')
  const days = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1
  if (days > 366) throw new Error('单次统计范围最多366个营业日')
  return { from, to, label: `${from} 至 ${to}` }
}

function inPeriod(date: string, bounds: PeriodBounds) {
  return date >= bounds.from && date <= bounds.to
}

function localHour(timestamp: string, timezone: string) {
  const value = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(timestamp))
  return Number(value)
}

function latestSalesEmployeeId(state: RuntimeState, tableSessionId: string) {
  return (state.salesAttributionRecords ?? [])
    .findLast((record) => record.subjectType === 'table_session' && record.subjectId === tableSessionId)
    ?.salesEmployeeId ?? null
}

function sessionPartySize(state: RuntimeState, tableSessionId: string) {
  const operation = state.tableSessionOperations?.find((item) => item.tableSessionId === tableSessionId)
  if (operation?.guestCount !== undefined) return operation.guestCount
  const audit = state.auditEntries.findLast((entry) => (
    entry.details.tableSessionId === tableSessionId && typeof entry.details.guestCount === 'number'
  ))
  if (audit && typeof audit.details.guestCount === 'number') return audit.details.guestCount
  const session = state.songState.tableSessions.find((item) => item.id === tableSessionId)
  if (!session) return null
  const table = state.tables.find((item) => item.id === session.tableId)
  return session.status === 'open' && table ? table.guestCount : null
}

function orderFacts(state: RuntimeState, bounds: PeriodBounds): OrderFact[] {
  const sessions = new Map(state.songState.tableSessions.map((session) => [session.id, session]))
  return state.orderDomain.orders.flatMap((order) => {
    if (order.status === 'draft') return []
    const session = sessions.get(order.tableSessionId)
    if (!session) return []
    const businessDate = tableSessionBusinessDate(state, session)
    if (!inPeriod(businessDate, bounds)) return []
    const table = state.tables.find((item) => item.id === session.tableId)
    const employeeId = latestSalesEmployeeId(state, session.id)
    return [{
      order,
      businessDate,
      tableId: session.tableId,
      tableCode: table?.code ?? session.tableCode,
      areaId: table?.areaId ?? '',
      employeeId,
      employeeName: state.employees.find((item) => item.id === employeeId)?.displayName ?? '未分配',
      partySize: sessionPartySize(state, session.id),
      hour: localHour(order.submittedAt ?? order.createdAt, state.store.timezone),
    }]
  })
}

function serviceFacts(state: RuntimeState, bounds: PeriodBounds): ServiceFact[] {
  const rolloverHour = state.tableOperationsConfig?.businessDayRolloverHour ?? 6
  return state.tasks.flatMap((task) => {
    const businessDate = venueBusinessDateKey(task.createdAt, state.store.timezone, rolloverHour)
    if (!inPeriod(businessDate, bounds)) return []
    const table = state.tables.find((item) => item.id === task.tableId)
    const serviceType = state.config.serviceTypes.find((item) => item.id === task.serviceTypeId)
    return [{
      task,
      businessDate,
      tableId: task.tableId,
      tableCode: table?.code ?? task.tableId,
      areaId: table?.areaId ?? '',
      employeeId: task.ownerId,
      employeeName: state.employees.find((item) => item.id === task.ownerId)?.displayName ?? '未接单',
      serviceTypeId: task.serviceTypeId,
      serviceTypeName: serviceType?.name ?? task.serviceTypeId,
      hour: localHour(task.createdAt, state.store.timezone),
    }]
  })
}

function scopeLabel(state: RuntimeState, actorId: string) {
  const scope = effectiveDataScopeForEmployee(state, actorId)
  if (scope === 'own') return '仅本人负责数据'
  if (scope === 'assigned_areas') return '本人当班负责区域'
  if (scope === 'store') return '本门店'
  return '获授权门店范围'
}

function visibleOrderFact(state: RuntimeState, actorId: string, fact: OrderFact) {
  const scope = effectiveDataScopeForEmployee(state, actorId)
  if (scope === 'store' || scope === 'all_stores') return true
  if (scope === 'own') return fact.employeeId === actorId
  const employee = state.employees.find((item) => item.id === actorId)
  const shiftAreas = state.shiftAssignments
    .filter((shift) => shift.employeeId === actorId && shift.businessDate === state.store.businessDate && shift.status === 'active')
    .flatMap((shift) => shift.areaIds)
  return new Set([...(employee?.areaIds ?? []), ...shiftAreas]).has(fact.areaId)
}

function visibleServiceFact(state: RuntimeState, actorId: string, fact: ServiceFact) {
  const scope = effectiveDataScopeForEmployee(state, actorId)
  if (scope === 'store' || scope === 'all_stores') return true
  if (scope === 'own') {
    return fact.employeeId === actorId
      || fact.task.notifiedEmployeeIds.includes(actorId)
      || fact.task.targetEmployeeIdsSnapshot?.includes(actorId) === true
  }
  const employee = state.employees.find((item) => item.id === actorId)
  const shiftAreas = state.shiftAssignments
    .filter((shift) => shift.employeeId === actorId && shift.businessDate === state.store.businessDate && shift.status === 'active')
    .flatMap((shift) => shift.areaIds)
  return new Set([...(employee?.areaIds ?? []), ...shiftAreas]).has(fact.areaId)
}

function orderGroup(
  dimension: AnalyticsDimensionId,
  fact: OrderFact,
  item?: OrderItem,
  state?: RuntimeState,
): GroupKey {
  if (dimension === 'product') return { key: item?.skuId ?? 'unknown', label: item?.name ?? '未知商品' }
  if (dimension === 'category') {
    const product = state?.products.find((candidate) => candidate.id === item?.skuId)
    return { key: product?.categoryId ?? 'uncategorized', label: product?.categoryName ?? '未分类' }
  }
  if (dimension === 'table') return { key: fact.tableId, label: fact.tableCode }
  if (dimension === 'employee') return { key: fact.employeeId ?? 'unassigned', label: fact.employeeName }
  if (dimension === 'party_size') {
    return fact.partySize === null
      ? { key: 'unknown', label: '人数未留存' }
      : { key: String(fact.partySize), label: `${fact.partySize}人` }
  }
  if (dimension === 'business_date') return { key: fact.businessDate, label: fact.businessDate }
  if (dimension === 'hour') return { key: String(fact.hour).padStart(2, '0'), label: `${String(fact.hour).padStart(2, '0')}:00` }
  return { key: 'total', label: '总计' }
}

function serviceGroup(dimension: AnalyticsDimensionId, fact: ServiceFact): GroupKey {
  if (dimension === 'table') return { key: fact.tableId, label: fact.tableCode }
  if (dimension === 'employee') return { key: fact.employeeId ?? 'unassigned', label: fact.employeeName }
  if (dimension === 'business_date') return { key: fact.businessDate, label: fact.businessDate }
  if (dimension === 'hour') return { key: String(fact.hour).padStart(2, '0'), label: `${String(fact.hour).padStart(2, '0')}:00` }
  if (dimension === 'service_type') return { key: fact.serviceTypeId, label: fact.serviceTypeName }
  return { key: 'total', label: '总计' }
}

function bucket(map: Map<string, NumericBucket>, group: GroupKey) {
  const existing = map.get(group.key)
  if (existing) return existing
  const created: NumericBucket = {
    ...group,
    sum: 0,
    numerator: 0,
    denominator: 0,
    values: [],
    sampleSize: 0,
  }
  map.set(group.key, created)
  return created
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = values.toSorted((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[midpoint - 1]! + sorted[midpoint]!) / 2)
    : sorted[midpoint]!
}

function formatValue(value: number, unit: AnalyticsValueUnit) {
  if (unit === 'amount_minor') return `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (unit === 'percent') return `${value.toFixed(1)}%`
  if (unit === 'seconds') return value < 60 ? `${Math.round(value)}秒` : `${Math.floor(value / 60)}分${Math.round(value % 60)}秒`
  return Math.round(value).toLocaleString('zh-CN')
}

function bucketValue(metric: AnalyticsMetricId, item: NumericBucket) {
  if (metric === 'service_completion_rate') {
    return item.denominator === 0 ? 0 : Math.round(item.numerator / item.denominator * 1000) / 10
  }
  if (metric === 'median_service_response_seconds') return median(item.values)
  if (metric === 'average_check') return item.denominator === 0 ? 0 : Math.round(item.sum / item.denominator)
  return item.sum
}

function rowsFromBuckets(
  metric: AnalyticsMetricId,
  unit: AnalyticsValueUnit,
  buckets: Map<string, NumericBucket>,
  query: AnalyticsQuery,
) {
  return [...buckets.values()]
    .map<AnalyticsResultRow>((item) => {
      const value = bucketValue(metric, item)
      return {
        key: item.key,
        label: item.label,
        value,
        formattedValue: formatValue(value, unit),
        sampleSize: item.sampleSize,
      }
    })
    .toSorted((left, right) => (
      query.sort === 'asc' ? left.value - right.value : right.value - left.value
    ) || left.label.localeCompare(right.label, 'zh-CN'))
    .slice(0, query.limit)
}

function calculateOrderMetric(
  state: RuntimeState,
  query: AnalyticsQuery,
  facts: OrderFact[],
) {
  const buckets = new Map<string, NumericBucket>()
  if (['sales_amount', 'sales_quantity', 'estimated_gross_profit'].includes(query.metric)) {
    for (const fact of facts) {
      for (const item of fact.order.items) {
        const target = bucket(buckets, orderGroup(query.dimension, fact, item, state))
        if (query.metric === 'sales_amount') target.sum += item.unitSalePriceAmount * item.quantity
        else if (query.metric === 'sales_quantity') target.sum += item.quantity
        else target.sum += (item.unitSalePriceAmount - item.unitCostAmount) * item.quantity
        target.sampleSize += 1
      }
    }
    return buckets
  }
  if (query.metric === 'order_count') {
    for (const fact of facts) {
      const target = bucket(buckets, orderGroup(query.dimension, fact))
      target.sum += 1
      target.sampleSize += 1
    }
    return buckets
  }
  if (query.metric === 'average_check') {
    const sessions = new Map<string, { fact: OrderFact; amount: number }>()
    for (const fact of facts) {
      const current = sessions.get(fact.order.tableSessionId) ?? { fact, amount: 0 }
      current.amount += fact.order.items.reduce((sum, item) => sum + item.unitSalePriceAmount * item.quantity, 0)
      sessions.set(fact.order.tableSessionId, current)
    }
    for (const session of sessions.values()) {
      const target = bucket(buckets, orderGroup(query.dimension, session.fact))
      target.sum += session.amount
      target.denominator += 1
      target.sampleSize += 1
    }
    return buckets
  }
  throw new Error('当前指标不是订单指标')
}

function calculateGuestMetric(state: RuntimeState, query: AnalyticsQuery, bounds: PeriodBounds, actorId: string) {
  const buckets = new Map<string, NumericBucket>()
  let missing = 0
  for (const session of state.songState.tableSessions) {
    if (!inPeriod(tableSessionBusinessDate(state, session), bounds)) continue
    const operation = state.tableSessionOperations?.find((item) => item.tableSessionId === session.id)
    if (operation?.source === 'added_table') continue
    const table = state.tables.find((item) => item.id === session.tableId)
    const employeeId = latestSalesEmployeeId(state, session.id)
    const fact: OrderFact = {
      order: {} as Order,
      businessDate: tableSessionBusinessDate(state, session),
      tableId: session.tableId,
      tableCode: table?.code ?? session.tableCode,
      areaId: table?.areaId ?? '',
      employeeId,
      employeeName: state.employees.find((item) => item.id === employeeId)?.displayName ?? '未分配',
      partySize: sessionPartySize(state, session.id),
      hour: localHour(session.openedAt, state.store.timezone),
    }
    if (!visibleOrderFact(state, actorId, fact)) continue
    if (fact.partySize === null) {
      missing += 1
      continue
    }
    const target = bucket(buckets, orderGroup(query.dimension, fact))
    target.sum += fact.partySize
    target.sampleSize += 1
  }
  return { buckets, missing }
}

function calculateServiceMetric(state: RuntimeState, query: AnalyticsQuery, facts: ServiceFact[]) {
  const buckets = new Map<string, NumericBucket>()
  const complaintTypeIds = new Set(state.config.serviceTypes
    .filter((item) => item.icon === 'complaint' || /complaint|投诉/iu.test(`${item.id} ${item.code} ${item.name}`))
    .map((item) => item.id))
  for (const fact of facts) {
    if (query.metric === 'complaint_count' && !complaintTypeIds.has(fact.serviceTypeId)) continue
    if (query.metric === 'service_completion_rate' && fact.task.status === 'cancelled') continue
    if (query.metric === 'median_service_response_seconds' && !fact.task.acceptedAt) continue
    const target = bucket(buckets, serviceGroup(query.dimension, fact))
    if (query.metric === 'service_request_count' || query.metric === 'complaint_count') target.sum += 1
    else if (query.metric === 'service_completion_rate') {
      target.denominator += 1
      if (['completed', 'confirmed'].includes(fact.task.status)) target.numerator += 1
    } else if (query.metric === 'median_service_response_seconds') {
      const acceptedAt = fact.task.acceptedAt
      if (acceptedAt) {
        target.values.push(Math.max(0, (Date.parse(acceptedAt) - Date.parse(fact.task.createdAt)) / 1000))
      }
    }
    target.sampleSize += 1
  }
  return buckets
}

function summarize(result: AnalyticsResult) {
  if (result.sampleSize === 0) return `${result.periodLabel}在${result.scopeLabel}内暂无“${result.metricLabel}”有效数据。`
  if (result.query.dimension === 'none') {
    return `${result.periodLabel}，${result.scopeLabel}的${result.metricLabel}为${result.formattedTotal}。`
  }
  const leaders = result.rows.slice(0, 3).map((row) => `${row.label} ${row.formattedValue}`).join('，')
  return `${result.periodLabel}，${result.scopeLabel}按${result.dimensionLabel}统计：${leaders || '暂无有效数据'}。`
}

export function executeAnalyticsQuery(
  state: RuntimeState,
  actor: AnalyticsActor,
  rawQuery: unknown,
  now = Date.now(),
) {
  const query = analyticsQuerySchema.parse(rawQuery)
  const permissions = new Set(effectivePermissionIdsForEmployee(state, actor.actorId))
  if (!permissions.has('dashboard.view')) throw new Error('当前岗位没有查看经营分析的权限')
  const definition = metricDefinitions[query.metric]
  if (definition.requiresFinance && !permissions.has('finance.view')) {
    throw new Error('预估毛利只对有财务查看权限的岗位开放')
  }
  if (!definition.allowedDimensions.includes(query.dimension)) {
    throw new Error(`${definition.label}不能按${dimensionLabels[query.dimension]}统计，请换一个分析维度`)
  }
  const bounds = periodBounds(state, query)
  const scopedOrders = orderFacts(state, bounds).filter((fact) => visibleOrderFact(state, actor.actorId, fact))
  const scopedServices = serviceFacts(state, bounds).filter((fact) => visibleServiceFact(state, actor.actorId, fact))
  let buckets: Map<string, NumericBucket>
  let missingPartySizeSessions = 0
  if (query.metric === 'guest_count') {
    const guest = calculateGuestMetric(state, query, bounds, actor.actorId)
    buckets = guest.buckets
    missingPartySizeSessions = guest.missing
  } else if (['service_request_count', 'service_completion_rate', 'median_service_response_seconds', 'complaint_count'].includes(query.metric)) {
    buckets = calculateServiceMetric(state, query, scopedServices)
  } else {
    buckets = calculateOrderMetric(state, query, scopedOrders)
    missingPartySizeSessions = new Set(scopedOrders
      .filter((fact) => fact.partySize === null)
      .map((fact) => fact.order.tableSessionId)).size
  }
  const rows = rowsFromBuckets(query.metric, definition.unit, buckets, query)
  const aggregate = [...buckets.values()].reduce<NumericBucket>((total, current) => ({
    ...total,
    sum: total.sum + current.sum,
    numerator: total.numerator + current.numerator,
    denominator: total.denominator + current.denominator,
    values: [...total.values, ...current.values],
    sampleSize: total.sampleSize + current.sampleSize,
  }), { key: 'total', label: '总计', sum: 0, numerator: 0, denominator: 0, values: [], sampleSize: 0 })
  const total = bucketValue(query.metric, aggregate)
  const result: AnalyticsResult = {
    query,
    metricLabel: definition.label,
    dimensionLabel: dimensionLabels[query.dimension],
    periodLabel: bounds.label,
    dateFrom: bounds.from,
    dateTo: bounds.to,
    scopeLabel: scopeLabel(state, actor.actorId),
    unit: definition.unit,
    total,
    formattedTotal: formatValue(total, definition.unit),
    rows,
    sampleSize: aggregate.sampleSize,
    definition: definition.definition,
    dataAsOf: new Date(now).toISOString(),
    completeness: missingPartySizeSessions > 0 && ['guest_count', 'average_check'].includes(query.metric) ? 'partial' : 'complete',
    missingPartySizeSessions,
  }
  return {
    id: `analytics_query_${randomUUID()}`,
    result,
    message: summarize(result),
  }
}
