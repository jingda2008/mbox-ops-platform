import { createHash, randomUUID } from 'node:crypto'
import type {
  CommercialOpsConfig,
  CommercialOpsState,
  PrintJob,
  StaffCategorySalesRow,
} from '../src/shared/commercial-ops-contracts.js'
import type { Order } from '../src/shared/order-contracts.js'
import type { RuntimeState } from '../src/shared/contracts.js'

export const DEFAULT_COMMERCIAL_OPS_CONFIG: CommercialOpsConfig = {
  version: 1,
  orderSafety: {
    enabled: true,
    duplicateWindowSeconds: 45,
    maxOrdersPerMinute: 5,
    requireSubmitConfirmation: true,
    requireContinuationConfirmationSeconds: 120,
  },
  inventoryControl: {
    cocktailAllowedLossBps: 800,
    snackCountMode: 'integer',
  },
  printers: [
    { id: 'printer-bar', name: '吧台出单机', connectionMode: 'android_bridge', endpointReference: '', enabled: true },
    { id: 'printer-kitchen', name: '后厨出单机', connectionMode: 'android_bridge', endpointReference: '', enabled: true },
  ],
  printerRoutes: [
    { id: 'route-bar', name: '酒水单', stationIds: ['bar-main'], categoryIds: ['drinks'], printerId: 'printer-bar', copies: 1, enabled: true },
    { id: 'route-kitchen', name: '小吃单', stationIds: ['kitchen-cold', 'kitchen-hot'], categoryIds: ['food'], printerId: 'printer-kitchen', copies: 1, enabled: true },
  ],
  tipping: {
    enabled: false,
    recipientModes: ['team', 'singer'],
    presetAmounts: [2000, 5000, 10000],
    customAmountEnabled: true,
    minimumAmount: 100,
    maximumAmount: 100_000,
  },
  updatedAt: '1970-01-01T00:00:00.000Z',
  updatedBy: 'system',
}

export function createCommercialOpsState(): CommercialOpsState {
  return {
    config: structuredClone(DEFAULT_COMMERCIAL_OPS_CONFIG),
    scanCodeBindings: [],
    procurementBatches: [],
    costEntries: [],
    recurringCostTemplates: [],
    printJobs: [],
    voucherRedemptions: [],
    tipRecords: [],
    customerTagDefinitions: [
      { id: 'tag-new', name: '新客', kind: 'lifecycle', color: '#2f7d65', enabled: true, automaticRule: 'new_guest' },
      { id: 'tag-returning', name: '老客', kind: 'lifecycle', color: '#356f9f', enabled: true, automaticRule: 'returning_guest' },
      { id: 'tag-mid-spend', name: '中高消费', kind: 'spend', color: '#a67c2f', enabled: true, automaticRule: 'spend_mid' },
      { id: 'tag-high-spend', name: '高消费', kind: 'spend', color: '#b4474d', enabled: true, automaticRule: 'spend_high' },
    ],
    auditEvents: [],
    idempotencyRecords: [],
  }
}

export function normalizeCommercialOpsState(value?: CommercialOpsState): CommercialOpsState {
  const defaults = createCommercialOpsState()
  if (!value) return defaults
  const config = value.config ?? defaults.config
  return {
    config: {
      ...defaults.config,
      ...config,
      orderSafety: { ...defaults.config.orderSafety, ...config.orderSafety },
      inventoryControl: { ...defaults.config.inventoryControl, ...config.inventoryControl },
      printers: config.printers ?? defaults.config.printers,
      printerRoutes: config.printerRoutes ?? defaults.config.printerRoutes,
      tipping: { ...defaults.config.tipping, ...config.tipping },
    },
    scanCodeBindings: value.scanCodeBindings ?? [],
    procurementBatches: value.procurementBatches ?? [],
    costEntries: value.costEntries ?? [],
    recurringCostTemplates: value.recurringCostTemplates ?? [],
    printJobs: value.printJobs ?? [],
    voucherRedemptions: value.voucherRedemptions ?? [],
    tipRecords: value.tipRecords ?? [],
    customerTagDefinitions: value.customerTagDefinitions ?? defaults.customerTagDefinitions,
    auditEvents: value.auditEvents ?? [],
    idempotencyRecords: value.idempotencyRecords ?? [],
  }
}

export function commercialOpsFor(state: RuntimeState) {
  state.commercialOps = normalizeCommercialOpsState(state.commercialOps)
  return state.commercialOps
}

export function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function idempotentResult(
  state: CommercialOpsState,
  key: string,
  operation: string,
  inputFingerprint: string,
) {
  const record = state.idempotencyRecords.find((candidate) => candidate.key === key)
  if (!record) return null
  if (record.operation !== operation || record.fingerprint !== inputFingerprint) {
    throw new Error('这个操作编号已经用于不同内容，请刷新后重试')
  }
  return record.resultId
}

export function recordCommercialMutation(
  state: CommercialOpsState,
  input: {
    key: string
    operation: string
    inputFingerprint: string
    resultId: string
    actorId: string
    action: string
    objectType: string
    reason: string
    occurredAt: string
    details?: Record<string, unknown>
  },
) {
  state.idempotencyRecords.push({
    key: input.key,
    operation: input.operation,
    fingerprint: input.inputFingerprint,
    resultId: input.resultId,
  })
  state.auditEvents.push({
    id: `commercial_audit_${randomUUID()}`,
    action: input.action,
    objectType: input.objectType,
    objectId: input.resultId,
    actorId: input.actorId,
    reason: input.reason,
    occurredAt: input.occurredAt,
    details: structuredClone(input.details ?? {}),
  })
}

function latestSalesOwner(state: RuntimeState, tableSessionId: string) {
  return (state.salesAttributionRecords ?? [])
    .findLast((record) => record.subjectType === 'table_session' && record.subjectId === tableSessionId)
    ?.salesEmployeeId ?? null
}

export function salesByEmployeeCategory(state: RuntimeState): StaffCategorySalesRow[] {
  const rows = new Map<string, StaffCategorySalesRow & { orderIds: Set<string> }>()
  for (const order of state.orderDomain.orders) {
    if (order.status === 'draft') continue
    const employeeId = latestSalesOwner(state, order.tableSessionId) ?? 'unassigned'
    const employeeName = state.employees.find((employee) => employee.id === employeeId)?.displayName ?? '未分配'
    for (const item of order.items) {
      const product = state.products.find((candidate) => candidate.id === item.skuId)
      const categoryId = product?.categoryId ?? 'uncategorized'
      const categoryName = product?.categoryName ?? '未分类'
      const key = `${employeeId}:${categoryId}`
      const row = rows.get(key) ?? {
        employeeId,
        employeeName,
        categoryId,
        categoryName,
        quantity: 0,
        salesAmount: 0,
        costAmount: 0,
        grossProfitAmount: 0,
        orderCount: 0,
        orderIds: new Set<string>(),
      }
      row.quantity += item.quantity
      row.salesAmount += item.unitSalePriceAmount * item.quantity
      row.costAmount += item.unitCostAmount * item.quantity
      row.grossProfitAmount = row.salesAmount - row.costAmount
      row.orderIds.add(order.id)
      row.orderCount = row.orderIds.size
      rows.set(key, row)
    }
  }
  return [...rows.values()].map(({ orderIds: _orderIds, ...row }) => row)
    .toSorted((left, right) => right.salesAmount - left.salesAmount)
}

export function orderFingerprint(items: Array<{ skuId?: string; productId?: string; quantity: number }>) {
  return items
    .map((item) => `${item.skuId ?? item.productId}:${item.quantity}`)
    .toSorted()
    .join('|')
}

export function recentMatchingGuestOrder(
  state: RuntimeState,
  tableSessionId: string,
  items: Array<{ productId: string; quantity: number }>,
  now: number,
) {
  const config = commercialOpsFor(state).config.orderSafety
  if (!config.enabled) return null
  const cutoff = now - config.duplicateWindowSeconds * 1000
  const target = orderFingerprint(items)
  return state.orderDomain.orders
    .filter((order) => order.tableSessionId === tableSessionId && order.createdBy.startsWith('guest-'))
    .filter((order) => Date.parse(order.createdAt) >= cutoff)
    .findLast((order) => orderFingerprint(order.items) === target) ?? null
}

export function recentGuestOrderCount(state: RuntimeState, tableSessionId: string, now: number) {
  const cutoff = now - 60_000
  return state.orderDomain.orders.filter((order) => (
    order.tableSessionId === tableSessionId
    && order.createdBy.startsWith('guest-')
    && Date.parse(order.createdAt) >= cutoff
  )).length
}

export function queuePrintJobsForOrder(state: RuntimeState, order: Order, occurredAt: string): PrintJob[] {
  const commercial = commercialOpsFor(state)
  const enabledPrinterIds = new Set(commercial.config.printers.filter((printer) => printer.enabled).map((printer) => printer.id))
  const created: PrintJob[] = []
  for (const route of commercial.config.printerRoutes.filter((candidate) => candidate.enabled && enabledPrinterIds.has(candidate.printerId))) {
    const itemIds = order.items.filter((item) => {
      if (item.requiresFulfillment === false) return false
      const product = state.products.find((candidate) => candidate.id === item.skuId)
      return route.stationIds.includes(item.stationId) || Boolean(product?.categoryId && route.categoryIds.includes(product.categoryId))
    }).map((item) => item.id)
    if (itemIds.length === 0) continue
    const existing = commercial.printJobs.find((job) => job.orderId === order.id && job.routeId === route.id)
    if (existing) {
      created.push(existing)
      continue
    }
    const job: PrintJob = {
      id: `print_job_${randomUUID()}`,
      orderId: order.id,
      orderItemIds: itemIds,
      printerId: route.printerId,
      routeId: route.id,
      status: 'queued',
      attempts: 0,
      queuedAt: occurredAt,
      updatedAt: occurredAt,
      lastError: null,
    }
    commercial.printJobs.push(job)
    created.push(job)
  }
  return created
}
