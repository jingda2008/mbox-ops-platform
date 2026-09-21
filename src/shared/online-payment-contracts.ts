export type OnlinePaymentPresentation = 'jsapi' | 'alipay_jsapi' | 'qr' | 'barcode'
export type TerminalOnlinePaymentStatus = 'succeeded' | 'partially_refunded' | 'refunded' | 'failed' | 'closed'

export interface OnlinePaymentAction {
  paymentId: string
  paymentPublicId: string
  payableKind?: 'order' | 'activity_registration' | 'order_batch'
  orderPublicId: string | null
  activityRegistrationPublicId?: string | null
  status: 'pending' | 'unknown' | 'failed' | 'resolved'
  /** Current local payment state recovered after checkout; no new payment presentation. */
  terminalPaymentStatus?: TerminalOnlinePaymentStatus
  presentation: OnlinePaymentPresentation
  expiresAt: string
  payload: Readonly<Record<string, unknown>> | null
  failureCode?: 'network_rejected' | 'identity_rejected' | 'configuration_unavailable' | 'provider_rejected'
}
