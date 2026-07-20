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
