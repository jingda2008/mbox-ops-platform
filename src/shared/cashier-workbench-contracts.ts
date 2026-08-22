export type CashierPaymentProvider = 'wechat' | 'postar' | 'cash' | 'physical_pos' | 'simulation'
export type CashierPaymentMethod = 'jsapi' | 'native_qr' | 'auth_code' | 'cash' | 'card' | 'manual'
export type CashierPaymentStatus =
  | 'created'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'closed'
  | 'partially_refunded'
  | 'refunded'
export type CashierRefundStatus =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type CashierWorkbenchKdsStatus =
  | 'pending'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'cancelled'
  | 'failed'

export interface CashierWorkbenchItem {
  id: string
  productName: string
  quantity: number
  totalAmountMinor: number
  status: string
}

export interface CashierWorkbenchRefundAllocation {
  orderItemId: string
  amountMinor: number
}

export interface CashierWorkbenchRefund {
  id: string
  publicId: string
  paymentId: string
  providerRefundId: string | null
  amountMinor: number
  currency: string
  status: CashierRefundStatus
  reason: string
  requestedByEmployeeId: string
  requestedByEmployeeName: string
  approvedByEmployeeId: string | null
  approvedByEmployeeName: string | null
  decisionReason: string | null
  receiptReference: string | null
  completedAt: string | null
  createdAt: string
  allocations: CashierWorkbenchRefundAllocation[]
}

export interface CashierWorkbenchRefundableItem extends CashierWorkbenchItem {
  reservedRefundAmountMinor: number
  remainingRefundableMinor: number
}

/**
 * A fulfillment task associated with the order. `succeededRefundAmountMinor`
 * is derived only from provider-confirmed refund allocations; it is not an
 * instruction to automatically cancel production.
 */
export interface CashierWorkbenchKdsTask {
  id: string
  orderItemId: string
  stationCode: 'bar' | 'kitchen'
  status: CashierWorkbenchKdsStatus
  quantity: number
  succeededRefundAmountMinor: number
}

export interface CashierWorkbenchPayment {
  id: string
  publicId: string
  provider: CashierPaymentProvider
  method: CashierPaymentMethod
  providerTransactionId: string | null
  amountMinor: number
  currency: string
  status: CashierPaymentStatus
  succeededAt: string | null
  createdAt: string
  reservedRefundAmountMinor: number
  remainingRefundableMinor: number
  refundableItems: CashierWorkbenchRefundableItem[]
  refunds: CashierWorkbenchRefund[]
}

export interface CashierWorkbenchOrder {
  id: string
  publicId: string
  tableCode: string
  channel: string
  status: string
  paymentStatus: string
  totalAmountMinor: number
  currency: string
  submittedAt: string | null
  createdAt: string
  /** Source business day; older unresolved refunds remain visible for handover. */
  businessDate?: string
  carryover?: boolean
  settlementException?: {
    reasonCode: 'manager_comp' | 'uncollectible' | 'test_cleanup'
    settledAmountMinor: number
    occurredAt: string
  } | null
  items: CashierWorkbenchItem[]
  kdsTasks: CashierWorkbenchKdsTask[]
  payments: CashierWorkbenchPayment[]
}

export interface CashierWorkbenchView {
  businessDate: string
  query: string
  actions: {
    canRequestRefund: boolean
    canApproveRefund: boolean
    canExecuteRefund: boolean
    canViewReconciliation: boolean
    canManageKdsException: boolean
  }
  summary: {
    orderCount: number
    capturedPaymentCount: number
    requestedRefundCount: number
    processingRefundCount: number
    carryoverOrderCount?: number
    /** Older initiated payments that still require a provider result query. */
    carryoverPendingPaymentCount?: number
  }
  orders: CashierWorkbenchOrder[]
}
