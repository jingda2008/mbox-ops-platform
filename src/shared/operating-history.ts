export interface OperatingHistory {
  summary?: OperatingDaySummary
  businessDate: string; endDate?: string; generatedAt: string; page: number; hasMore: boolean
  receipts: Array<{ provider: string; receivedMinor: number; refundedMinor: number; netMinor: number }>
  orders: Array<{
    id: string; businessDate?: string; publicId: string; tableCode: string; employeeName: string | null
    submittedAt: string; status: string; paymentStatus: string; totalMinor: number
    items: Array<{ id: string; name: string; quantity: number; unitPriceMinor: number; totalMinor: number; status: string; note: string | null; deliveredAt?:string|null; deliveredBy?:string|null }>
  }>
}
export interface OperatingDaySummary {orderCount:number;orderAmountMinor:string;unsettledCount:number;outstandingMinor:string;pendingPaymentCount:number;pendingRefundCount:number}
