export type OnlinePaymentPresentation = 'jsapi' | 'qr' | 'barcode'

export interface OnlinePaymentAction {
  paymentId: string
  paymentPublicId: string
  orderPublicId: string
  status: 'pending' | 'unknown' | 'failed'
  presentation: OnlinePaymentPresentation
  expiresAt: string
  payload: Readonly<Record<string, unknown>> | null
}
