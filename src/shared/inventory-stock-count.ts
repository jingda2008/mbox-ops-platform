export interface StockCountReview {
  id: string
  publicId: string
  status: 'submitted' | 'approved' | 'rejected'
  createdByEmployeeId: string
  createdByName: string
  submittedAt: string
  decidedByName: string | null
  decidedAt: string | null
  decisionReason: string | null
  note: string | null
  canReview: boolean
  lines: Array<{
    inventoryItemId: string
    itemName: string
    baseUnit: string
    categoryCode: string
    packageVolumeMl: string | null
    systemQuantity: string
    countedQuantity: string
    varianceQuantity: string
    currentQuantity: string
    stale: boolean
    reason: string | null
  }>
}

export interface StockCountReviewPage {
  counts: StockCountReview[]
  canApprove: boolean
  page: number
  hasMore: boolean
}
