export type OrderFinancialRecoveryDimensions = 'attribution' | 'loyalty' | 'all'

export interface OrderRecoveryAttribution {
  eligible: boolean
  itemAmountMinor: number
  recommendationCurrentMinor: number
  recommendationExpectedMinor: number
  recommendationDeltaMinor: number
  blockReasons: string[]
  items: Array<{ orderItemId: string; productName: string; amountMinor: number; restored: boolean }>
}

export interface OrderRecoveryLoyalty {
  status: 'not_required' | 'ready' | 'rule_pending' | 'refund_review_required' | 'ineligible' | 'permission_required'
  memberNo: string | null
  policyVersionId: string | null
  eligibleAmountMinor: number
  pointsDelta: number
  growthDelta: number
  availablePointsDelta: number
  pendingRecoveryPointsDelta: number
  expiresAt: string | null
  blockReasons: string[]
}

export interface OrderRecoverySnapshot {
  attribution: OrderRecoveryAttribution
  loyalty: OrderRecoveryLoyalty
}

export interface OrderFinancialRecoveryRequestView {
  requestId: string
  orderId: string
  orderPublicId: string
  basisVersion: string
  dimensions: OrderFinancialRecoveryDimensions
  requestedByEmployeeId: string
  requestedByName: string
  reason: string
  createdAt: string
  status: 'requested' | 'approved' | 'rejected' | 'stale' | 'superseded'
  snapshot: OrderRecoverySnapshot
  decidedByName: string | null
  decisionReason: string | null
  result: OrderFinancialRecoveryResult | null
}

export interface OrderFinancialRecoveryPreview extends OrderRecoverySnapshot {
  orderId: string
  orderPublicId: string
  currency: string
  basisVersion: string
  availableDimensions: OrderFinancialRecoveryDimensions[]
  requests: OrderFinancialRecoveryRequestView[]
}

export interface OrderFinancialRecoveryPage {
  orders: OrderFinancialRecoveryPreview[]
  nextCursor: string | null
}

export interface OrderFinancialRecoveryRequestInput {
  basisVersion: string
  dimensions: OrderFinancialRecoveryDimensions
  reason: string
}

export interface OrderFinancialRecoveryDecisionInput {
  basisVersion: string
  decision: 'approve' | 'reject'
  reason: string
}

export interface OrderFinancialRecoveryResult {
  requestId: string
  orderId: string
  orderPublicId: string
  dimensions: OrderFinancialRecoveryDimensions
  status: 'requested' | 'approved' | 'rejected'
  itemAmountMinor: number
  recommendationAmountMinor: number
  pointsDelta: number
  growthDelta: number
  availablePointsDelta: number
  pendingRecoveryPointsDelta: number
}
