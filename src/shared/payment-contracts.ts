import type { MoneyAmount } from './order-contracts.js'

export const PHYSICAL_POS_CHANNEL = 'physical_pos'

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
}

export interface PaymentIntent {
  id: string
  tableSessionId: string
  orderIds: string[]
  lineAllocations: PaymentLineAllocation[]
  amount: MoneyAmount
  currency: string
  channel: string
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

export type PaymentDomainResultType =
  | 'payment_intent'
  | 'payment_query'
  | 'physical_pos_report'
  | 'refund'

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
  refunds: Refund[]
  idempotencyRecords: PaymentIdempotencyRecord[]
}

export interface PaymentLineAllocationInput {
  orderId: string
  orderItemId: string
  quantity: number
  unitPaidAmount: MoneyAmount
}

export interface CreatePaymentIntentCommand {
  paymentIntentId: string
  tableSessionId: string
  lineAllocations: PaymentLineAllocationInput[]
  amount: MoneyAmount
  currency: string
  channel: string
  merchantId: string
  createdBy: string
  deviceId: string
  occurredAt: string
  expiresAt: string
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
