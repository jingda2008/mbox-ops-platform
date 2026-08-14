import type { MoneyAmount } from './order-contracts.js'
import type { ChannelPaymentStatus, RefundItem, SettlementChannel } from './payment-contracts.js'

export type PaymentProviderHeaders = Readonly<
  Record<string, string | readonly string[] | undefined>
>

export interface PaymentProviderSecretSource {
  getSecret(name: string): Promise<string | Uint8Array>
}

export interface PaymentProviderContext {
  secrets: PaymentProviderSecretSource
}

export interface RawPaymentProviderCallback {
  rawBody: Uint8Array
  headers: PaymentProviderHeaders
  receivedAt: string
}

export interface ProviderPaymentObservation {
  paymentIntentId: string
  providerTransactionId: string
  status: ChannelPaymentStatus
  amount: MoneyAmount
  currency: string
  merchantId: string
  settlementChannel?: Extract<SettlementChannel, 'wechat' | 'alipay' | 'unionpay'>
  occurredAt: string
}

export interface VerifiedProviderPaymentCallback extends ProviderPaymentObservation {
  providerEventId: string
}

export interface ProviderCreatePaymentRequest {
  paymentIntentId: string
  merchantId: string
  amount: MoneyAmount
  currency: string
  expiresAt: string
  presentation: 'jsapi' | 'qr' | 'barcode'
  payWay?: 'wechat' | 'alipay'
  payerId?: string
  customerAuthCode?: string
  clientIp: string
  callbackUrl: string
  operatorId: string
  remark: string
  wxAppid?: string
  /** 5 = WeChat official account/H5, 8 = WeChat mini program. */
  wechatTradeType?: '5' | '8'
}

export interface ProviderCreatePaymentResult {
  paymentIntentId: string
  providerTransactionId: string | null
  status: 'processing'
  amount: MoneyAmount
  currency: string
  merchantId: string
  occurredAt: string
  paymentPayload: Readonly<Record<string, unknown>>
}

export interface ProviderPaymentQueryRequest {
  paymentIntentId: string
  merchantId: string
  providerTransactionId: string | null
  /** Original payment date in the provider's merchant timezone, YYYYMMDD. */
  orderDate?: string
}

export type ProviderRefundStatus = 'processing' | 'succeeded' | 'failed'

export interface ProviderRefundRequest {
  refundId: string
  paymentIntentId: string
  providerTransactionId: string
  amount: MoneyAmount
  currency: string
  items: readonly RefundItem[]
  idempotencyKey: string
  settlementChannel?: Extract<SettlementChannel, 'wechat' | 'alipay' | 'unionpay'>
}

export interface ProviderRefundQueryRequest {
  refundId: string
  providerRefundId: string
  merchantId: string
}

export interface ProviderRefundObservation {
  refundId: string
  providerRefundId: string
  providerRefundTransactionId: string | null
  status: ProviderRefundStatus
  amount: MoneyAmount
  currency: string
  occurredAt: string
  failureReason?: string
}

export type ProviderBillEntryType = 'payment' | 'refund'
export type ProviderBillEntryStatus = 'processing' | 'succeeded' | 'failed' | 'cancelled'

export interface ProviderBillEntry {
  providerEntryId: string
  providerTransactionId: string
  type: ProviderBillEntryType
  status: ProviderBillEntryStatus
  amount: MoneyAmount
  currency: string
  occurredAt: string
}

export interface DownloadProviderBillRequest {
  merchantId: string
  businessDate: string
}

export interface PaymentProviderAdapter {
  readonly provider: string
  createPayment(
    request: ProviderCreatePaymentRequest,
    context: PaymentProviderContext,
  ): Promise<ProviderCreatePaymentResult>
  verifyPaymentCallback(
    request: RawPaymentProviderCallback,
    context: PaymentProviderContext,
  ): Promise<VerifiedProviderPaymentCallback>
  queryPayment(
    request: ProviderPaymentQueryRequest,
    context: PaymentProviderContext,
  ): Promise<ProviderPaymentObservation>
  requestRefund(
    request: ProviderRefundRequest,
    context: PaymentProviderContext,
  ): Promise<ProviderRefundObservation>
  queryRefund(
    request: ProviderRefundQueryRequest,
    context: PaymentProviderContext,
  ): Promise<ProviderRefundObservation>
  downloadBill(
    request: DownloadProviderBillRequest,
    context: PaymentProviderContext,
  ): Promise<readonly ProviderBillEntry[]>
}

export type ReconciliationDifferenceType =
  | 'matched'
  | 'provider_only'
  | 'internal_only'
  | 'duplicate_provider_entry'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'status_mismatch'

export type ReconciliationManualStatus =
  | 'not_required'
  | 'pending'
  | 'investigating'
  | 'resolved'

export type ReconciliationResolution =
  | 'provider_corrected'
  | 'internal_corrected'
  | 'accepted_exception'

export interface InternalReconciliationEntry {
  internalEntryId: string
  providerTransactionId: string
  type: ProviderBillEntryType
  status: ProviderBillEntryStatus | 'reported_pending_reconciliation'
  amount: MoneyAmount
  currency: string
  occurredAt: string
}

export interface ReconciliationManualEvent {
  status: Exclude<ReconciliationManualStatus, 'not_required'>
  actorId: string
  reason: string
  resolution: ReconciliationResolution | null
  occurredAt: string
}

export interface ReconciliationItem {
  id: string
  differenceType: ReconciliationDifferenceType
  providerTransactionId: string
  internalEntry: InternalReconciliationEntry | null
  providerEntry: ProviderBillEntry | null
  manualStatus: ReconciliationManualStatus
  resolution: ReconciliationResolution | null
  manualEvents: ReconciliationManualEvent[]
}

export interface PaymentReconciliationRun {
  id: string
  provider: string
  merchantId: string
  businessDate: string
  createdAt: string
  items: ReconciliationItem[]
}
