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
  items: CashierWorkbenchItem[]
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
  }
  summary: {
    orderCount: number
    capturedPaymentCount: number
    requestedRefundCount: number
    processingRefundCount: number
    carryoverOrderCount?: number
  }
  orders: CashierWorkbenchOrder[]
}
