export interface ItemAfterSalesPricing {
 policy:'captured_payment'|'broken_bundle';refundAmountMinor:number;receivableDeltaMinor:number;effectiveAmountMinor:number;availablePaidMinor:number
 components:Array<{itemId:string;retainedQuantity:number;originalSinglePriceMinor:number|null}>
}
export interface ItemAfterSalesCase {
  pricing?:ItemAfterSalesPricing
  caseId:string;orderId:string;kind:string;status:string;businessDate:string;amountMinor:number|null
  selectedQuantity:number;heldQuantity:number;stoppedQuantity:number;madeQuantity:number;inventoryReviewQuantity:number
  physicalComplete:boolean;moneyComplete:boolean;succeededMinor:number;refundFailed:boolean;refundNeedsReview:boolean;awaitingCashPayout:boolean
  closedByOrderCancellationId?:string|null
  revisesCaseId?:string|null;revisedByCaseId?:string|null;canRevise?:boolean
  replacementOrder?:{orderId:string;publicId:string;status:string;sourceCaseId:string}|null;canReplace?:boolean
  canDisposeMade?:boolean
  canDisposeHeldUnmade?:boolean
  unconfirmedNoticeCount:number
  notices:Array<{id:string;stationCode:string;instruction:string;createdAt:string;printState:string}>
  refunds:Array<{id:string;status:string;amountMinor:number;provider:string;replacedByRefundId?:string|null;canRetry?:boolean}>
  canResolveUnpaid:boolean
  requiresFundingChoice?:boolean
  paymentAllocationReview?:boolean
  unpaidPaymentChanged?:boolean
  reason:string;createdAt:string;canApprove:boolean;canReject:boolean;canWithdraw:boolean;canResume:boolean;resumeUnavailableReason?:string|null
}
export interface ItemAfterSalesWorkspace {
  quantityEntryUnavailableReason?:string|null
  item:{id:string;orderId:string;name:string;quantity:number;originalAmountMinor:number;unitPriceMinor:number;status:string;orderPublicId:string;tableCode:string;tableSessionId?:string;guestCount?:number;bundle:boolean;includedInBundle?:boolean}
  fundingSources:Array<{paymentId:string;provider:string;originalOrderAmountMinor:number;availableMinor:number}>
  canManageRemake?:boolean;firstRemakeAvailableQuantity?:number;originalKdsTaskId?:string|null
  remakes?:Array<{id:string;taskId:string;reason:string;createdAt:string;total:number;unmade:number;started:number;ready:number;delivered:number;cancelled:number;held:number;successorAvailableQuantity:number}>
  redeliveryAvailableQuantity?:number;canRequestRedelivery?:boolean;canConfirmRedelivery?:boolean;canCancelRedelivery?:boolean
  redeliveries?:Array<{id:string;taskId:string;status:string;reason:string;pendingQuantity:number;pausedQuantity:number;deliveredQuantity:number;cancelledQuantity:number;selectedQuantity:number}>
  canRequest:boolean;canExecuteRefund:boolean;canReceive:boolean;canRecordUsed:boolean;canAcknowledgeNotices:boolean
  units:Array<{id:string;index:number;productionState:string;heldByCaseId:string|null;stoppedByCaseId:string|null;operationallyStopped?:boolean;inventoryEvidence:string}>
  cases:ItemAfterSalesCase[]
}

export interface ItemAfterSalesPending {
  items:Array<Pick<ItemAfterSalesCase,'caseId'|'businessDate'|'selectedQuantity'|'heldQuantity'|'status'|'amountMinor'|'awaitingCashPayout'|'refundFailed'|'refundNeedsReview'|'unconfirmedNoticeCount'>&{orderItemId:string;productName:string;tableCode:string;requesterName:string;physicalOnly?:boolean;orderPublicId?:string;orderBusinessDate?:string;createdAt?:string}>
  nextCursor:{id:string;createdAt:string}|null
}

export interface RemakePhysicalHandover {
  items:Array<{batchId:string;itemId:string;taskId:string;createdAt:string;tableCode:string;productName:string;orderPublicId:string;pendingQuantity:number;unitIds:string[];canReceive:boolean;canRecordUsed:boolean}>
  nextCursor:{id:string;createdAt:string}|null
}
