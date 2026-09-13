export interface StockReturnCapability {remainingQuantity:number;canReturnUnmade:boolean;canReturnUnopened:boolean;reason:string}
export interface OperatingHistory {
  financialSummaryVisible?:boolean
  financialStartDate?:string
  summary?: OperatingDaySummary
  businessDate: string; endDate?: string; generatedAt: string; page: number; hasMore: boolean
  receipts: Array<{ provider: string; receivedMinor: number; refundedMinor: number; netMinor: number }>
  orders: Array<{
    id: string; businessDate?: string; publicId: string; tableCode: string; employeeName: string | null
    tableSessionId?:string;sessionPublicId?:string;areaName?:string
    submittedAt: string; status: string; paymentStatus: string; totalMinor: number; effectiveAmountMinor?:number; receivableIncreaseMinor?:number; stoppedAmountMinor?:number
    items: Array<{ productId?:string; categoryLabel?:string|null; unitLabel?:string|null; bundleParentId?:string|null; id: string; name: string; quantity: number; returnedQuantity?:number; stockReturn?:StockReturnCapability; quantities?:{total:number;held:number;stopped:number;ready:number;delivered:number;usedLoss:number}; unitPriceMinor: number; totalMinor: number; includedInBundle?:boolean; status: string; note: string | null; deliveredAt?:string|null; deliveredBy?:string|null; preparedAt?:string|null;preparedBy?:string|null }>
  }>
}
export interface OperatingDaySummary {orderCount:number;orderAmountMinor:string;unsettledCount:number;outstandingMinor:string;pendingPaymentCount:number;pendingRefundCount:number}
