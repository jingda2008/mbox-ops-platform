export type OnlinePaymentPresentation = 'jsapi' | 'alipay_jsapi' | 'qr' | 'barcode'

export interface OnlinePaymentAction {
  paymentId: string
  paymentPublicId: string
  payableKind?: 'order' | 'activity_registration'
  orderPublicId: string | null
  activityRegistrationPublicId?: string | null
  status: 'pending' | 'unknown' | 'failed'
  presentation: OnlinePaymentPresentation
  expiresAt: string
  payload: Readonly<Record<string, unknown>> | null
}
