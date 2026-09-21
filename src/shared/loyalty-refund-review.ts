export interface LoyaltyRefundReviewAllocation {
  orderItemId: string
  salesRefundAmountMinor: number
}

export interface LoyaltyRefundReviewHistoricalAllocation {
  refundId: string
  allocations: LoyaltyRefundReviewAllocation[]
}

export interface LoyaltyRefundReviewItem {
  orderItemId: string
  productName: string
  quantity: number
  refundAllocatedAmountMinor: number
  maxSalesReturnAmountMinor: number
  loyaltyEligible: boolean
}

export interface LoyaltyRefundReviewRequestView {
  requestId: string
  requestedByEmployeeId: string
  requestedByName: string
  reason: string
  createdAt: string
  basisVersion: string
  status: 'requested' | 'approved' | 'rejected' | 'stale' | 'superseded'
  allocations: LoyaltyRefundReviewAllocation[]
  historicalAllocations: LoyaltyRefundReviewHistoricalAllocation[]
  decisionReason: string | null
  decidedByName: string | null
}

export interface LoyaltyRefundReviewView {
  refundId: string
  refundPublicId: string
  orderPublicId: string
  currency: string
  refundAmountMinor: number
  excessAmountMinor: number
  salesRefundAmountMinor: number
  basisVersion: string
  status: 'pending' | 'resolved'
  blockingRefundPublicId: string | null
  items: LoyaltyRefundReviewItem[]
  historicalRefunds: Array<{
    refundId: string
    refundPublicId: string
    refundAmountMinor: number
    excessAmountMinor: number
    salesRefundAmountMinor: number
    items: LoyaltyRefundReviewItem[]
  }>
  requests: LoyaltyRefundReviewRequestView[]
}

export interface LoyaltyRefundReviewRequestInput {
  basisVersion: string
  allocations: LoyaltyRefundReviewAllocation[]
  historicalAllocations?: LoyaltyRefundReviewHistoricalAllocation[]
  reason: string
}

export interface LoyaltyRefundReviewDecisionInput {
  basisVersion: string
  decision: 'approve' | 'reject'
  reason: string
}

export interface LoyaltyRefundReviewCommandResult {
  requestId: string
  refundId: string
  status: 'requested' | 'approved' | 'rejected'
  pointsDelta: number
  growthDelta: number
}
