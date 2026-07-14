/** Money is represented in the currency's smallest unit, for example fen. */
export type ReservationMoneyAmount = number

export interface ReservationScope {
  tenantId: string
  storeId: string
}

export type ReservationStatus =
  | 'requested'
  | 'confirmed'
  | 'arrived'
  | 'seated'
  | 'cancelled'
  | 'no_show'

export type ReservationOccasionCode = 'birthday' | 'anniversary' | 'business' | 'other'

export type ReservationDepositStatus =
  | 'not_required'
  | 'payment_required'
  | 'payment_intent_recorded'
  | 'payment_confirmed'
  | 'refund_required'
  | 'refund_processing'
  | 'refunded'
  | 'refund_failed'

export interface ReservationSourceConfig {
  code: string
  name: string
  enabled: boolean
  sortOrder: number
}

export interface ReservationAreaPreferenceConfig {
  code: string
  name: string
  enabled: boolean
  sortOrder: number
}

export interface ReservationOccasionConfig {
  code: ReservationOccasionCode
  name: string
  enabled: boolean
  serviceScript: string[]
}

export interface ReservationConfig {
  version: number
  minimumPartySize: number
  maximumPartySize: number
  sources: ReservationSourceConfig[]
  areaPreferences: ReservationAreaPreferenceConfig[]
  occasions: ReservationOccasionConfig[]
}

export interface ReservationDeposit {
  requiredAmount: ReservationMoneyAmount
  currency: string
  status: ReservationDepositStatus
  paymentIntentReference: string | null
  paymentIntentRecordedAt: string | null
  paymentConfirmationReference: string | null
  paymentConfirmedAt: string | null
  refundRequestReference: string | null
  refundRequestedAt: string | null
  refundConfirmationReference: string | null
  refundedAt: string | null
  refundFailureReason: string | null
}

export interface Reservation extends ReservationScope {
  id: string
  customerReference: string
  customerName: string
  contactReference: string
  sourceCode: string
  partySize: number
  areaPreferenceCode: string | null
  occasionCode: ReservationOccasionCode | null
  occasionNote: string
  scheduledAt: string
  status: ReservationStatus
  deposit: ReservationDeposit
  tableId: string | null
  tableCode: string | null
  tableSessionId: string | null
  requestedAt: string
  confirmedAt: string | null
  arrivedAt: string | null
  seatedAt: string | null
  cancelledAt: string | null
  noShowAt: string | null
  cancellationReason: string | null
  createdBy: string
  updatedAt: string
  revision: number
  configVersion: number
}

export type ReservationAuditEventType =
  | 'reservation.requested.v1'
  | 'reservation.confirmed.v1'
  | 'reservation.arrived.v1'
  | 'reservation.seated.v1'
  | 'reservation.cancelled.v1'
  | 'reservation.no_show.v1'
  | 'reservation.deposit_intent_recorded.v1'
  | 'reservation.deposit_confirmed.v1'
  | 'reservation.deposit_refund_required.v1'
  | 'reservation.deposit_refund_started.v1'
  | 'reservation.deposit_refunded.v1'
  | 'reservation.deposit_refund_failed.v1'

export interface ReservationAuditEvent extends ReservationScope {
  id: string
  reservationId: string
  type: ReservationAuditEventType
  actorId: string
  fromStatus: ReservationStatus | null
  toStatus: ReservationStatus
  depositFromStatus: ReservationDepositStatus | null
  depositToStatus: ReservationDepositStatus
  occurredAt: string
  reason: string | null
  details: Record<string, string | number | boolean | null>
}

export interface ReservationIdempotencyRecord {
  key: string
  operation: string
  fingerprint: string
  reservationId: string
}

export interface ReservationState extends ReservationScope {
  config: ReservationConfig
  reservations: Reservation[]
  auditEvents: ReservationAuditEvent[]
  idempotencyRecords: ReservationIdempotencyRecord[]
}

export interface CreateReservationCommand {
  reservationId: string
  customerReference: string
  customerName: string
  contactReference: string
  sourceCode: string
  partySize: number
  areaPreferenceCode?: string
  occasionCode?: ReservationOccasionCode
  occasionNote?: string
  scheduledAt: string
  depositRequiredAmount: ReservationMoneyAmount
  depositCurrency: string
  actorId: string
  occurredAt: string
  idempotencyKey: string
}

export interface ReservationActionCommand {
  reservationId: string
  actorId: string
  occurredAt: string
  idempotencyKey: string
}

export interface RecordReservationDepositIntentCommand extends ReservationActionCommand {
  paymentIntentReference: string
}

export interface ConfirmReservationDepositCommand extends ReservationActionCommand {
  paymentIntentReference: string
  paymentConfirmationReference: string
  confirmedAmount: ReservationMoneyAmount
  currency: string
}

export interface SeatReservationCommand extends ReservationActionCommand {
  tableId: string
  tableCode: string
  tableSessionId: string
}

export interface CancelReservationCommand extends ReservationActionCommand {
  reason: string
}

export interface MarkReservationNoShowCommand extends ReservationActionCommand {
  reason: string
}

export interface StartReservationDepositRefundCommand extends ReservationActionCommand {
  refundRequestReference: string
}

export interface CompleteReservationDepositRefundCommand extends ReservationActionCommand {
  refundRequestReference: string
  refundConfirmationReference: string
  refundedAmount: ReservationMoneyAmount
  currency: string
}

export interface FailReservationDepositRefundCommand extends ReservationActionCommand {
  refundRequestReference: string
  reason: string
}
