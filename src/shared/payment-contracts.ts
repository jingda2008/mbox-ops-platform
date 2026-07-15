import type { MoneyAmount } from './order-contracts.js'

export const PHYSICAL_POS_CHANNEL = 'physical_pos'
export const CASH_PAYMENT_CHANNEL = 'cash'
export const SETTLEMENT_CHANNELS = ['cash', 'physical_pos', 'wechat', 'alipay'] as const

export type PaymentAllocationMode = 'all' | 'items' | 'amount'
export type SettlementChannel = typeof SETTLEMENT_CHANNELS[number]

export type PaymentIntentStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'closed'
  | 'reported_pending_reconciliation'

export type ChannelPaymentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'closed'
export type PaymentQueryStatus = 'requested' | 'completed'
export type PhysicalPosReportStatus = 'reported_pending_reconciliation'
export type RefundStatus = 'requested' | 'approved' | 'rejected' | 'processing' | 'succeeded' | 'failed'

export interface PaymentLineAllocation {
  orderId: string
  orderItemId: string
  quantity: number
  unitPaidAmount: MoneyAmount
  paidAmount: MoneyAmount
  allocationMode?: PaymentAllocationMode
  sourceUnitPriceAmount?: MoneyAmount
}

export interface PaymentIntent {
  id: string
  tableSessionId: string
  orderIds: string[]
  lineAllocations: PaymentLineAllocation[]
  amount: MoneyAmount
  currency: string
  channel: string
  settlementChannel?: Extract<SettlementChannel, 'wechat' | 'alipay'>
  merchantId: string
  status: PaymentIntentStatus
  channelTransactionId: string | null
  createdBy: string
  deviceId: string
  createdAt: string
  expiresAt: string
  paidAt: string | null
  failedAt: string | null
  closedAt: string | null
  failureReason: string | null
  businessDate?: string
  allocationMode?: PaymentAllocationMode
  requestSelectionFingerprint?: string
  providerPaymentPayload?: Readonly<Record<string, unknown>>
  providerOrderCreatedAt?: string
}

export interface CashPaymentConfirmation {
  id: string
  paymentIntentId: string
  tableSessionId: string
  amount: MoneyAmount
  currency: string
  confirmedBy: string
  deviceId: string
  confirmedAt: string
}

export interface PaymentNotification {
  id: string
  channel: string
  notificationId: string
  paymentIntentId: string
  channelTransactionId: string
  status: ChannelPaymentStatus
  amount: MoneyAmount
  currency: string
  merchantId: string
  channelOccurredAt: string
  receivedAt: string
  fingerprint: string
}

export interface PaymentStatusQuery {
  id: string
  paymentIntentId: string
  status: PaymentQueryStatus
  requestedBy: string
  requestedAt: string
  completedAt: string | null
  resultStatus: ChannelPaymentStatus | null
  channelTransactionId: string | null
}

export interface PhysicalPosReport {
  id: string
  paymentIntentId: string
  tableSessionId: string
  orderIds: string[]
  terminalId: string
  terminalTransactionId: string
  paymentMethod: string
  amount: MoneyAmount
  currency: string
  paidAt: string
  reportedBy: string
  deviceId: string
  receiptReference: string | null
  status: PhysicalPosReportStatus
  reportedAt: string
}

export interface RefundItem {
  orderId: string
  orderItemId: string
  quantity: number
  unitPaidAmount: MoneyAmount
  amount: MoneyAmount
}

export interface Refund {
  id: string
  paymentIntentId: string
  tableSessionId: string
  items: RefundItem[]
  amount: MoneyAmount
  currency: string
  reason: string
  status: RefundStatus
  requestedBy: string
  requestedAt: string
  decidedBy: string | null
  decidedAt: string | null
  decisionReason: string | null
  channelRefundId: string | null
  processingAt: string | null
  channelRefundTransactionId: string | null
  succeededAt: string | null
  failedAt: string | null
  failureReason: string | null
}

export interface SettlementChannelSummary {
  channel: SettlementChannel
  systemReceivableAmount: MoneyAmount
  confirmedActualAmount: MoneyAmount
  pendingReconciliationAmount: MoneyAmount
  differenceAmount: MoneyAmount
}

export interface CashierHandoverIssue {
  channel: SettlementChannel
  amount: MoneyAmount
  reason: string
  nextDayOwnerId: string
}

export type CashierHandoverStatus = 'submitted' | 'approved' | 'rejected' | 'closed'

export interface CashierHandover {
  id: string
  businessDate: string
  shiftId: string
  submittedBy: string
  submittedAt: string
  deviceId: string
  note: string | null
  status: CashierHandoverStatus
  channels: SettlementChannelSummary[]
  issues: CashierHandoverIssue[]
  reviewedBy: string | null
  reviewedAt: string | null
  reviewNote: string | null
  closedAt: string | null
}

export interface PaymentSettlementView {
  businessDate: string
  channels: SettlementChannelSummary[]
  latestHandover: CashierHandover | null
  canClose: boolean
}

export type PaymentDomainResultType =
  | 'payment_intent'
  | 'payment_query'
  | 'physical_pos_report'
  | 'cash_payment_confirmation'
  | 'refund'
  | 'cashier_handover'

export interface PaymentIdempotencyRecord {
  key: string
  operation: string
  fingerprint: string
  resultType: PaymentDomainResultType
  resultId: string
}

export interface PaymentDomainState {
  paymentIntents: PaymentIntent[]
  paymentNotifications: PaymentNotification[]
  paymentStatusQueries: PaymentStatusQuery[]
  physicalPosReports: PhysicalPosReport[]
  cashPaymentConfirmations?: CashPaymentConfirmation[]
  refunds: Refund[]
  cashierHandovers?: CashierHandover[]
  idempotencyRecords: PaymentIdempotencyRecord[]
}

export interface PaymentLineAllocationInput {
  orderId: string
  orderItemId: string
  quantity: number
  unitPaidAmount: MoneyAmount
  allocationMode?: PaymentAllocationMode
  sourceUnitPriceAmount?: MoneyAmount
}

export interface CreatePaymentIntentCommand {
  paymentIntentId: string
  tableSessionId: string
  lineAllocations: PaymentLineAllocationInput[]
  amount: MoneyAmount
  currency: string
  channel: string
  settlementChannel?: Extract<SettlementChannel, 'wechat' | 'alipay'>
  merchantId: string
  createdBy: string
  deviceId: string
  occurredAt: string
  expiresAt: string
  idempotencyKey: string
  businessDate?: string
  allocationMode?: PaymentAllocationMode
  requestSelectionFingerprint?: string
}

export interface ConfirmCashPaymentCommand {
  confirmationId: string
  paymentIntentId: string
  amount: MoneyAmount
  currency: string
  confirmedBy: string
  deviceId: string
  occurredAt: string
  idempotencyKey: string
}

export interface HandlePaymentNotificationCommand {
  channel: string
  notificationId: string
  paymentIntentId: string
  channelTransactionId: string
  status: ChannelPaymentStatus
  amount: MoneyAmount
  currency: string
  merchantId: string
  signatureVerified: boolean
  channelOccurredAt: string
  receivedAt: string
}

export interface RequestPaymentStatusQueryCommand {
  queryId: string
  paymentIntentId: string
  requestedBy: string
  occurredAt: string
  idempotencyKey: string
}

export interface ApplyPaymentQueryResultCommand {
  queryId: string
  channelTransactionId: string
  status: ChannelPaymentStatus
  amount: MoneyAmount
  currency: string
  merchantId: string
  channelOccurredAt: string
  receivedAt: string
  idempotencyKey: string
}

export interface ReportPhysicalPosPaymentCommand {
  reportId: string
  paymentIntentId: string
  terminalId: string
  terminalTransactionId: string
  paymentMethod: string
  amount: MoneyAmount
  currency: string
  paidAt: string
  reportedBy: string
  deviceId: string
  receiptReference?: string
  occurredAt: string
  idempotencyKey: string
}

export interface SubmitCashierHandoverCommand {
  handoverId: string
  businessDate: string
  shiftId: string
  submittedBy: string
  deviceId: string
  note?: string
  channels: SettlementChannelSummary[]
  issues: Array<{
    channel: SettlementChannel
    reason: string
    nextDayOwnerId: string
  }>
  occurredAt: string
  idempotencyKey: string
}

export interface ReviewCashierHandoverCommand {
  handoverId: string
  decision: 'approve' | 'reject'
  reviewedBy: string
  note?: string
  occurredAt: string
  idempotencyKey: string
}

export interface RefundItemInput {
  orderId: string
  orderItemId: string
  quantity: number
}

export interface RequestRefundCommand {
  refundId: string
  paymentIntentId: string
  items: RefundItemInput[]
  reason: string
  requestedBy: string
  occurredAt: string
  idempotencyKey: string
}

export interface ApproveRefundCommand {
  refundId: string
  approvedBy: string
  reason: string
  occurredAt: string
  idempotencyKey: string
}

export interface RejectRefundCommand {
  refundId: string
  rejectedBy: string
  reason: string
  occurredAt: string
  idempotencyKey: string
}

export interface StartRefundCommand {
  refundId: string
  channelRefundId: string
  actorId: string
  occurredAt: string
  idempotencyKey: string
}

export interface MarkRefundSucceededCommand {
  refundId: string
  channelRefundTransactionId: string
  refundedAmount: MoneyAmount
  currency: string
  occurredAt: string
  idempotencyKey: string
}

export interface MarkRefundFailedCommand {
  refundId: string
  reason: string
  occurredAt: string
  idempotencyKey: string
}

export interface AdapterPaymentRequest {
  paymentIntentId: string
  amount: MoneyAmount
  currency: string
  expiresAt: string
}

export interface AdapterPaymentResult {
  channelOrderId: string
  status: ChannelPaymentStatus
  paymentPayload: unknown
}

export interface AdapterPaymentObservation {
  paymentIntentId: string
  channelTransactionId: string
  status: ChannelPaymentStatus
  amount: MoneyAmount
  currency: string
  merchantId: string
  occurredAt: string
}

export interface AdapterRefundRequest {
  refundId: string
  paymentIntentId: string
  channelTransactionId: string
  amount: MoneyAmount
  currency: string
  items: RefundItem[]
}

export interface AdapterRefundObservation {
  refundId: string
  channelRefundTransactionId: string
  status: 'processing' | 'succeeded' | 'failed'
  amount: MoneyAmount
  currency: string
  occurredAt: string
}

export interface PaymentChannelAdapter {
  createPayment(request: AdapterPaymentRequest): Promise<AdapterPaymentResult>
  queryPayment(paymentIntentId: string): Promise<AdapterPaymentObservation>
  closePayment(paymentIntentId: string): Promise<AdapterPaymentObservation>
  refundPayment(request: AdapterRefundRequest): Promise<AdapterRefundObservation>
  queryRefund(refundId: string): Promise<AdapterRefundObservation>
  verifyNotification(payload: unknown, headers: Readonly<Record<string, string>>): Promise<AdapterPaymentObservation>
  downloadBill(businessDate: string): Promise<unknown>
  pushToTerminal?(request: AdapterPaymentRequest, terminalId: string): Promise<AdapterPaymentResult>
}
