export type InventoryCountMode = 'integer' | 'decimal'
export type ScanCodeSymbology = 'qr' | 'ean13' | 'code128' | 'custom'
export type ScanCodeTargetType = 'product' | 'ingredient'

export interface OrderSafetyConfig {
  enabled: boolean
  duplicateWindowSeconds: number
  maxOrdersPerMinute: number
  requireSubmitConfirmation: boolean
  requireContinuationConfirmationSeconds: number
}

export interface InventoryControlConfig {
  cocktailAllowedLossBps: number
  snackCountMode: InventoryCountMode
}

export interface ScanCodeBinding {
  id: string
  code: string
  symbology: ScanCodeSymbology
  targetType: ScanCodeTargetType
  targetId: string
  countMode: InventoryCountMode
  enabled: boolean
  updatedAt: string
  updatedBy: string
}

export type PrinterConnectionMode = 'network' | 'android_bridge' | 'browser'
export type PrinterJobStatus = 'queued' | 'printed' | 'failed'

export interface PrinterDeviceConfig {
  id: string
  name: string
  connectionMode: PrinterConnectionMode
  endpointReference: string
  enabled: boolean
}

export interface PrinterRouteConfig {
  id: string
  name: string
  stationIds: string[]
  categoryIds: string[]
  printerId: string
  copies: number
  enabled: boolean
}

export interface PrintJob {
  id: string
  orderId: string
  orderItemIds: string[]
  /** Order-note snapshot printed with this routed production ticket. */
  fulfillmentNote?: string
  printerId: string
  routeId: string
  status: PrinterJobStatus
  attempts: number
  queuedAt: string
  updatedAt: string
  lastError: string | null
}

export interface ProcurementBatch {
  id: string
  targetType: ScanCodeTargetType
  targetId: string
  scanCode: string | null
  supplierName: string
  supplierReference: string
  quantity: number
  unitCode: string
  unitCostAmount: number
  totalCostAmount: number
  receivedAt: string
  receivedBy: string
  reason: string
  idempotencyKey: string
}

export const operatingCostCategoryIds = [
  'staff',
  'performer',
  'band',
  'rent',
  'utilities',
  'goods_adjustment',
  'marketing',
  'payment_fee',
  'maintenance',
  'tax',
  'other',
] as const

export type OperatingCostCategoryId = typeof operatingCostCategoryIds[number]
export type OperatingCostStatus = 'estimated' | 'actual' | 'voided'
export type CostRecognitionMode = 'on_start' | 'spread_daily'
export type RecurringCostFrequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly'

/**
 * Expense records are never deleted. A late actual bill replaces an estimate
 * by reference; corrections use an audited logical void and a new record.
 */
export interface OperatingCostEntry {
  id: string
  name: string
  categoryId: OperatingCostCategoryId
  amount: number
  currency: string
  status: OperatingCostStatus
  recognitionMode: CostRecognitionMode
  recognitionStartDate: string
  recognitionEndDate: string
  counterparty: string
  reference: string
  note: string
  replacesEntryId: string | null
  sourceTemplateId: string | null
  sourceOccurrenceDate: string | null
  createdAt: string
  createdBy: string
  voidedAt: string | null
  voidedBy: string | null
  voidReason: string | null
  idempotencyKey: string
}

export interface RecurringCostTemplate {
  id: string
  name: string
  categoryId: OperatingCostCategoryId
  amount: number
  currency: string
  frequency: RecurringCostFrequency
  recognitionMode: CostRecognitionMode
  startDate: string
  endDate: string | null
  counterparty: string
  note: string
  enabled: boolean
  revision: number
  createdAt: string
  createdBy: string
  updatedAt: string
  updatedBy: string
}

export type ProfitReportPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year'

export interface ProfitCategoryRow {
  categoryId: OperatingCostCategoryId | 'goods_cogs' | 'inventory_loss'
  actualAmount: number
  estimatedAmount: number
  totalAmount: number
  source: 'automatic' | 'manual' | 'mixed'
}

export interface ProfitTrendRow {
  key: string
  label: string
  revenueAmount: number
  costAmount: number
  profitAmount: number
}

export interface ProfitCenterReport {
  period: ProfitReportPeriod
  anchorDate: string
  startDate: string
  endDate: string
  generatedAt: string
  revenue: {
    paymentAmount: number
    voucherSettlementAmount: number
    refundAmount: number
    netAmount: number
    pendingPosAmount: number
  }
  costs: {
    goodsCostAmount: number
    estimatedGoodsCostAmount: number
    inventoryLossAmount: number
    actualOperatingExpenseAmount: number
    estimatedOperatingExpenseAmount: number
    totalAmount: number
  }
  profit: {
    grossProfitAmount: number
    confirmedOperatingProfitAmount: number
    projectedOperatingProfitAmount: number
    projectedMarginBps: number
  }
  categoryRows: ProfitCategoryRow[]
  trendRows: ProfitTrendRow[]
  quality: {
    pendingPosCount: number
    estimatedEntryCount: number
    actualEntryCount: number
    estimatedGoodsOrderItemCount: number
    excludedDuplicateVoucherCount: number
  }
}

export interface ProfitCenterWorkspace {
  report: ProfitCenterReport
  costEntries: OperatingCostEntry[]
  recurringCostTemplates: RecurringCostTemplate[]
}

export interface GroupVoucherRedemption {
  id: string
  platform: string
  campaignName: string
  voucherCodeMasked: string
  voucherCodeHash: string
  faceValueAmount: number
  settlementAmount: number
  tableSessionId: string | null
  orderId: string | null
  status: 'redeemed' | 'voided'
  redeemedAt: string
  redeemedBy: string
  voidedAt: string | null
  voidedBy: string | null
  reason: string
  idempotencyKey: string
}

export interface TipConfig {
  enabled: boolean
  recipientModes: Array<'team' | 'singer' | 'staff'>
  presetAmounts: number[]
  customAmountEnabled: boolean
  minimumAmount: number
  maximumAmount: number
}

export interface TipRecord {
  id: string
  tableSessionId: string
  recipientMode: 'team' | 'singer' | 'staff'
  recipientId: string | null
  amount: number
  currency: string
  status: 'pending_payment' | 'paid' | 'cancelled'
  paymentIntentId: string | null
  createdAt: string
  createdBy: string
  paidAt: string | null
  note: string
  idempotencyKey: string
}

export interface CustomerTagDefinition {
  id: string
  name: string
  kind: 'lifecycle' | 'spend' | 'preference' | 'service' | 'manual'
  color: string
  enabled: boolean
  automaticRule: 'new_guest' | 'returning_guest' | 'spend_mid' | 'spend_high' | null
}

export interface CommercialOpsConfig {
  version: number
  orderSafety: OrderSafetyConfig
  inventoryControl: InventoryControlConfig
  printers: PrinterDeviceConfig[]
  printerRoutes: PrinterRouteConfig[]
  tipping: TipConfig
  updatedAt: string
  updatedBy: string
}

export interface CommercialOpsAuditEvent {
  id: string
  action: string
  objectType: string
  objectId: string
  actorId: string
  reason: string
  occurredAt: string
  details: Record<string, unknown>
}

export interface CommercialOpsState {
  config: CommercialOpsConfig
  scanCodeBindings: ScanCodeBinding[]
  procurementBatches: ProcurementBatch[]
  costEntries: OperatingCostEntry[]
  recurringCostTemplates: RecurringCostTemplate[]
  printJobs: PrintJob[]
  voucherRedemptions: GroupVoucherRedemption[]
  tipRecords: TipRecord[]
  customerTagDefinitions: CustomerTagDefinition[]
  auditEvents: CommercialOpsAuditEvent[]
  idempotencyRecords: Array<{
    key: string
    operation: string
    fingerprint: string
    resultId: string
  }>
}

export interface StaffCategorySalesRow {
  employeeId: string
  employeeName: string
  categoryId: string
  categoryName: string
  quantity: number
  salesAmount: number
  costAmount: number
  grossProfitAmount: number
  orderCount: number
}

export interface CommercialOpsWorkspace {
  state: CommercialOpsState
  salesByEmployeeCategory: StaffCategorySalesRow[]
}
