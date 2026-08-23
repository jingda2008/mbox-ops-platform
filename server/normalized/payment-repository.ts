import type { JsonObject } from './command-executor.js'
import type { ChannelPaymentStatus, SettlementChannel } from '../../src/shared/payment-contracts.js'
import { sanitizeProviderSnapshot } from './payment-security-policy.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { lockBoundGuestTablePosition } from './guest-table-authority.js'

export type PaymentProvider = 'wechat' | 'postar' | 'cash' | 'physical_pos' | 'simulation'
export type PaymentMethod = 'jsapi' | 'native_qr' | 'auth_code' | 'cash' | 'card' | 'manual'
export type AuthoritativeSettlementChannel = Extract<SettlementChannel, 'wechat' | 'alipay' | 'unionpay'>
export type PaymentStatus =
  | 'created'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'closed'
  | 'partially_refunded'
  | 'refunded'

export interface Payment {
  id: string
  payableKind: 'order' | 'activity_registration'
  orderId: string | null
  activityRegistrationId: string | null
  publicId: string
  provider: PaymentProvider
  providerTransactionId: string | null
  settlementChannel: AuthoritativeSettlementChannel | null
  method: PaymentMethod
  amountMinor: number
  currency: string
  status: PaymentStatus
  providerSnapshot: JsonObject
  succeededAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreatePaymentForActivityRegistrationInput {
  activityRegistrationId: string
  publicId: string
  method: Extract<PaymentMethod, 'jsapi' | 'native_qr'>
  amountMinor: number
  currency: string
}

export interface CreatePaymentForOrderInput {
  orderId: string
  publicId: string
  provider: PaymentProvider
  method: PaymentMethod
  providerTransactionId?: string | null
  evidence?: JsonObject
  initialStatus?: 'created' | 'pending' | 'succeeded'
  principal:
    | { type: 'employee'; employeeId: string }
    | { type: 'guest'; tableSessionId: string; customerId: string; guestSessionId: string }
}

export interface ApplyPaymentCallbackInput {
  paymentPublicId: string
  provider: Extract<PaymentProvider, 'wechat' | 'postar' | 'simulation'>
  providerTransactionId: string
  reportedAmountMinor: number
  reportedCurrency: string
  providerSnapshot?: JsonObject
  settlementChannel?: AuthoritativeSettlementChannel
  succeededAt?: string | null
}

export interface PaymentCallbackApplication {
  payment: Payment
  applied: boolean
}

export interface ApplyPaymentQueryResultInput extends ApplyPaymentCallbackInput {
  status: ChannelPaymentStatus
}

interface PaymentRow extends Record<string, unknown> {
  id: string
  payable_kind: Payment['payableKind']
  order_id: string | null
  activity_registration_id: string | null
  public_id: string
  provider: PaymentProvider
  provider_transaction_id: string | null
  settlement_channel: AuthoritativeSettlementChannel | null
  method: PaymentMethod
  amount_minor: string | number
  currency: string
  status: PaymentStatus
  provider_snapshot: JsonObject
  succeeded_at: string | null
  created_at: string
  updated_at: string
}

interface OrderRow extends Record<string, unknown> {
  id: string
  table_session_id: string
  total_amount_minor: string | number
  currency: string
  status: string
}

interface SettlementRow extends Record<string, unknown> {
  gross_paid_minor: string | number
  refunded_minor: string | number
  has_pending: boolean
}

interface PendingOnlinePaymentRow extends Record<string, unknown> {
  id: string
  public_id: string
  provider: Extract<PaymentProvider, 'wechat' | 'postar'>
  provider_transaction_id: string | null
  provider_action_state: 'creating' | 'ready' | 'unknown' | 'failed' | 'consumed' | null
  provider_order_created: boolean
}

export interface ClosedUnpresentedOnlinePayment {
  id: string
  publicId: string
  provider: Extract<PaymentProvider, 'wechat' | 'postar'>
}

const CAPTURED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'succeeded',
  'partially_refunded',
  'refunded',
]

export class PaymentNotFoundError extends Error {
  constructor(id: string) {
    super(`Payment was not found: ${id}`)
    this.name = 'PaymentNotFoundError'
  }
}

export class OrderNotPayableError extends Error {
  constructor(orderId: string, reason: string) {
    super(`Order ${orderId} cannot be paid: ${reason}`)
    this.name = 'OrderNotPayableError'
  }
}

export class PaymentEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentEvidenceError'
  }
}

export class PaymentCallbackMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentCallbackMismatchError'
  }
}

export class PaymentTransitionError extends Error {
  constructor(id: string, status: PaymentStatus) {
    super(`Payment ${id} cannot be marked succeeded from status ${status}`)
    this.name = 'PaymentTransitionError'
  }
}

export class PaymentRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  /**
   * Closes only payment rows that never left M-BOX. Once a provider action was
   * started, or a provider order/reference exists, the remote rail may still
   * capture money and must be queried or explicitly closed by that provider
   * before an in-person collection is allowed.
   */
  async closeUnpresentedOnlinePaymentsForManualCollection(
    orderId: string,
    employeeId: string,
  ): Promise<ClosedUnpresentedOnlinePayment[]> {
    const order = await this.lockOrder(orderId)
    if (order.status === 'draft' || order.status === 'cancelled') {
      throw new OrderNotPayableError(order.id, `status is ${order.status}`)
    }
    const selected = await this.transaction.query<PendingOnlinePaymentRow>(`
      SELECT payment.id, payment.public_id, payment.provider,
        payment.provider_transaction_id,
        provider_action.state AS provider_action_state,
        (payment.provider_snapshot ? 'providerOrderCreatedAt'
          OR payment.provider_snapshot ? 'providerOrderId') AS provider_order_created
      FROM mbox.payments payment
      LEFT JOIN mbox.payment_provider_actions provider_action
        ON provider_action.tenant_id = payment.tenant_id
       AND provider_action.store_id = payment.store_id
       AND provider_action.payment_id = payment.id
      WHERE payment.tenant_id = $1::uuid
        AND payment.store_id = $2::uuid
        AND payment.order_id = $3::uuid
        AND payment.provider IN ('wechat', 'postar')
        AND payment.status IN ('created', 'pending')
      ORDER BY payment.created_at, payment.id
      FOR UPDATE OF payment
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    if (selected.rows.length === 0) return []
    const unsafe = selected.rows.find((payment) => (
      payment.provider_transaction_id !== null
      || payment.provider_order_created
      || (payment.provider_action_state !== null && payment.provider_action_state !== 'failed')
    ))
    if (unsafe !== undefined) {
      throw new OrderNotPayableError(
        orderId,
        'online payment was presented or its provider result is unknown; query or close it before manual collection',
      )
    }
    const ids = selected.rows.map((payment) => payment.id)
    const closed = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.payments
      SET status = 'closed',
          provider_snapshot = provider_snapshot || jsonb_build_object(
            'providerStatus', 'closed',
            'closeReason', 'replaced_by_manual_collection_before_provider_submission',
            'closedByEmployeeId', $4::uuid,
            'closedAt', clock_timestamp()::text
          ),
          updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = ANY($3::uuid[])
        AND status IN ('created', 'pending')
      RETURNING id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, ids, employeeId])
    if (closed.rowCount !== ids.length) {
      throw new OrderNotPayableError(orderId, 'online payment changed while switching to manual collection')
    }
    return selected.rows.map((payment) => ({
      id: payment.id,
      publicId: payment.public_id,
      provider: payment.provider,
    }))
  }

  async createForOrder(input: Readonly<CreatePaymentForOrderInput>): Promise<Payment> {
    validateCreateInput(input)
    const order = await this.lockOrder(input.orderId)
    await this.assertOrderAccess(order, input.principal)
    if (order.status === 'draft' || order.status === 'cancelled') {
      throw new OrderNotPayableError(order.id, `status is ${order.status}`)
    }

    const settlement = await this.readSettlement(order.id)
    if (settlement.has_pending) {
      throw new OrderNotPayableError(order.id, 'another payment is already pending')
    }
    const outstandingMinor = toSafeMinor(order.total_amount_minor, 'order total')
      - (toSafeMinor(settlement.gross_paid_minor, 'gross paid')
        - toSafeMinor(settlement.refunded_minor, 'refunded'))
    if (outstandingMinor <= 0) {
      throw new OrderNotPayableError(order.id, 'the order has no outstanding balance')
    }

    const status = input.initialStatus ?? 'created'
    const inserted = await this.transaction.query<PaymentRow>(`
      INSERT INTO mbox.payments (
        tenant_id, store_id, payable_kind, order_id, public_id, provider,
        provider_transaction_id, method, amount_minor, currency, status,
        provider_snapshot, succeeded_at
      ) VALUES (
        $1::uuid, $2::uuid, 'order', $3::uuid, $4, $5,
        $6, $7, $8::bigint, $9, $10,
        $11::jsonb,
        CASE WHEN $10 = 'succeeded' THEN clock_timestamp() ELSE NULL END
      )
      RETURNING ${PAYMENT_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      order.id,
      input.publicId,
      input.provider,
      input.providerTransactionId ?? null,
      input.method,
      outstandingMinor,
      order.currency,
      status,
      JSON.stringify(sanitizeProviderSnapshot(input.evidence)),
    ])
    return onePayment(inserted, 'Creating a payment did not insert exactly one row')
  }

  async createForActivityRegistration(
    input: Readonly<CreatePaymentForActivityRegistrationInput>,
  ): Promise<Payment> {
    nonBlank('activityRegistrationId', input.activityRegistrationId)
    if (input.publicId.length < 8 || input.publicId.length > 128) {
      throw new TypeError('publicId must contain between 8 and 128 characters')
    }
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new TypeError('activity payment amount must be a positive safe integer')
    }
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new TypeError('activity payment currency is invalid')
    const registration = await this.transaction.query<{
      id: string; amount_due_minor: string | number; currency: string; status: string; payment_id: string | null
    }>(`
      SELECT id, amount_due_minor, currency, status, payment_id
      FROM mbox.community_activity_registrations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.activityRegistrationId])
    const row = registration.rows[0]
    if (row === undefined || row.status !== 'payment_pending' || row.payment_id !== null) {
      throw new OrderNotPayableError(input.activityRegistrationId, 'activity registration is not awaiting a new payment')
    }
    if (toSafeMinor(row.amount_due_minor, 'activity amount due') !== input.amountMinor
      || row.currency !== input.currency) {
      throw new OrderNotPayableError(input.activityRegistrationId, 'activity amount or currency changed')
    }
    const inserted = await this.transaction.query<PaymentRow>(`
      INSERT INTO mbox.payments (
        tenant_id, store_id, payable_kind, order_id, activity_registration_id,
        public_id, provider, method, amount_minor, currency, status, provider_snapshot
      ) VALUES (
        $1::uuid, $2::uuid, 'activity_registration', NULL, $3::uuid,
        $4, 'postar', $5, $6::bigint, $7, 'pending',
        jsonb_build_object('source', 'community_activity_registration')
      )
      RETURNING ${PAYMENT_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.activityRegistrationId,
      input.publicId,
      input.method,
      input.amountMinor,
      input.currency,
    ])
    const payment = onePayment(inserted, 'Creating an activity payment did not insert exactly one row')
    const linked = await this.transaction.query(`
      UPDATE mbox.community_activity_registrations
      SET payment_id=$4::uuid, updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='payment_pending' AND payment_status='pending' AND payment_id IS NULL
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.activityRegistrationId, payment.id])
    if (linked.rowCount !== 1) throw new Error('Activity registration lost its payment link transition')
    return payment
  }

  async applySucceededCallback(
    input: Readonly<ApplyPaymentCallbackInput>,
  ): Promise<PaymentCallbackApplication> {
    validateCallbackInput(input)
    const paymentOrder = await this.transaction.query<{
      id: string; payable_kind: Payment['payableKind']; order_id: string | null; activity_registration_id: string | null
    }>(`
      SELECT id, payable_kind, order_id, activity_registration_id
      FROM mbox.payments
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND public_id = $3
        AND provider = $4
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.paymentPublicId,
      input.provider,
    ])
    const reference = paymentOrder.rows[0]
    const paymentId = reference?.id
    if (reference === undefined || paymentId === undefined) {
      throw new PaymentNotFoundError(input.paymentPublicId)
    }
    await this.lockPayable(reference)
    const selected = await this.transaction.query<PaymentRow>(`
      SELECT ${PAYMENT_COLUMNS}
      FROM mbox.payments
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const payment = selected.rows[0]
    if (payment === undefined) throw new PaymentNotFoundError(input.paymentPublicId)
    verifyCallback(payment, input)
    if (CAPTURED_PAYMENT_STATUSES.includes(payment.status)) {
      return { payment: await this.enrichSettlementChannel(payment, input.settlementChannel), applied: false }
    }
    if (payment.status === 'failed' || payment.status === 'closed') {
      throw new PaymentTransitionError(payment.id, payment.status)
    }

    const updated = await this.transaction.query<PaymentRow>(`
      UPDATE mbox.payments
      SET status = 'succeeded',
          provider_transaction_id = $4,
          provider_snapshot = provider_snapshot || $5::jsonb,
          succeeded_at = COALESCE($6::timestamptz, clock_timestamp()),
          settlement_channel = COALESCE(settlement_channel, $7),
          updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
        AND status IN ('created', 'pending')
      RETURNING ${PAYMENT_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      payment.id,
      input.providerTransactionId,
      JSON.stringify(sanitizeProviderSnapshot(input.providerSnapshot)),
      input.succeededAt ?? null,
      input.settlementChannel ?? null,
    ])
    return {
      payment: onePayment(updated, `Payment ${payment.id} lost its callback transition`),
      applied: true,
    }
  }

  async applyProviderQueryResult(
    input: Readonly<ApplyPaymentQueryResultInput>,
  ): Promise<PaymentCallbackApplication> {
    validateCallbackInput(input)
    const paymentOrder = await this.transaction.query<{
      id: string; payable_kind: Payment['payableKind']; order_id: string | null; activity_registration_id: string | null
    }>(`
      SELECT id, payable_kind, order_id, activity_registration_id
      FROM mbox.payments
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND public_id = $3 AND provider = $4
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.paymentPublicId,
      input.provider,
    ])
    const reference = paymentOrder.rows[0]
    const paymentId = reference?.id
    if (reference === undefined || paymentId === undefined) {
      throw new PaymentNotFoundError(input.paymentPublicId)
    }
    await this.lockPayable(reference)
    const selected = await this.transaction.query<PaymentRow>(`
      SELECT ${PAYMENT_COLUMNS}
      FROM mbox.payments
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const stored = selected.rows[0]
    if (stored === undefined) throw new PaymentNotFoundError(input.paymentPublicId)
    verifyCallback(stored, input)
    if (CAPTURED_PAYMENT_STATUSES.includes(stored.status)) {
      return { payment: await this.enrichSettlementChannel(stored, input.settlementChannel), applied: false }
    }

    const nextStatus: PaymentStatus = input.status === 'succeeded'
      ? 'succeeded'
      : input.status === 'failed'
        ? 'failed'
        : input.status === 'closed'
          ? 'closed'
          : 'pending'
    if (stored.status === 'failed' || stored.status === 'closed') {
      if (stored.status !== nextStatus) throw new PaymentTransitionError(stored.id, stored.status)
      return { payment: mapPayment(stored), applied: false }
    }
    const snapshot = sanitizeProviderSnapshot({
      ...input.providerSnapshot,
      providerStatus: input.status,
      queryObservedAt: input.succeededAt ?? null,
    })
    const updated = await this.transaction.query<PaymentRow>(`
      UPDATE mbox.payments
      SET status = $4,
          provider_transaction_id = $5,
          provider_snapshot = provider_snapshot || $6::jsonb,
          succeeded_at = CASE
            WHEN $4 = 'succeeded' THEN COALESCE($7::timestamptz, clock_timestamp())
            ELSE succeeded_at
          END,
          settlement_channel = COALESCE(settlement_channel, $8),
          updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status IN ('created', 'pending')
      RETURNING ${PAYMENT_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      stored.id,
      nextStatus,
      input.providerTransactionId,
      JSON.stringify(snapshot),
      input.succeededAt ?? null,
      input.settlementChannel ?? null,
    ])
    const payment = onePayment(updated, `Payment ${stored.id} lost its provider query transition`)
    if (nextStatus === 'succeeded') {
      await this.consumeProviderAction(payment.id)
    } else if (nextStatus === 'failed' || nextStatus === 'closed') {
      await this.transaction.query(`
        UPDATE mbox.payment_provider_actions
        SET state = 'failed', ciphertext = NULL, nonce = NULL, auth_tag = NULL,
            last_error_code = $4, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND payment_id = $3::uuid
          AND state IN ('creating', 'ready', 'unknown')
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        payment.id,
        `provider-query:${input.status}`,
      ])
    }
    return { payment, applied: true }
  }

  async consumeProviderAction(paymentId: string): Promise<void> {
    await this.transaction.query(`
      UPDATE mbox.payment_provider_actions
      SET state = 'consumed', ciphertext = NULL, nonce = NULL, auth_tag = NULL,
          consumed_at = COALESCE(consumed_at, clock_timestamp()),
          last_error_code = NULL, updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND payment_id = $3::uuid
        AND state IN ('creating', 'ready', 'unknown', 'consumed')
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
  }

  private async enrichSettlementChannel(
    payment: PaymentRow,
    settlementChannel: AuthoritativeSettlementChannel | undefined,
  ): Promise<Payment> {
    if (settlementChannel === undefined || payment.settlement_channel !== null) return mapPayment(payment)
    const updated = await this.transaction.query<PaymentRow>(`
      UPDATE mbox.payments
      SET settlement_channel=$4, updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND settlement_channel IS NULL
      RETURNING ${PAYMENT_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      payment.id,
      settlementChannel,
    ])
    return onePayment(updated, `Payment ${payment.id} lost its settlement-channel enrichment`)
  }

  async syncOrderPaymentStatus(orderId: string): Promise<string> {
    const order = await this.lockOrder(orderId)
    const settlement = await this.readSettlement(order.id)
    const total = toSafeMinor(order.total_amount_minor, 'order total')
    const grossPaid = toSafeMinor(settlement.gross_paid_minor, 'gross paid')
    const refunded = toSafeMinor(settlement.refunded_minor, 'refunded')
    const netPaid = grossPaid - refunded
    const paymentStatus = settlement.has_pending && netPaid < total
      ? 'pending'
      : netPaid >= total
        ? 'paid'
        : refunded > 0 && netPaid <= 0
          ? 'refunded'
          : refunded > 0
            ? 'partially_refunded'
            : netPaid > 0
              ? 'partially_paid'
              : 'unpaid'

    const updated = await this.transaction.query<{ payment_status: string }>(`
      UPDATE mbox.orders
      SET payment_status = $4
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
      RETURNING payment_status
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, order.id, paymentStatus])
    const row = updated.rows[0]
    if (updated.rowCount !== 1 || row === undefined) {
      throw new Error(`Order ${order.id} payment status was not updated`)
    }
    return row.payment_status
  }

  async syncActivityRegistrationPaymentStatus(payment: Readonly<Payment>): Promise<void> {
    if (payment.payableKind !== 'activity_registration' || payment.activityRegistrationId === null) {
      throw new TypeError('payment does not target an activity registration')
    }
    if (payment.status === 'succeeded' || payment.status === 'partially_refunded') {
      const updated = await this.transaction.query(`
        UPDATE mbox.community_activity_registrations
        SET status='confirmed', payment_status='paid',
          paid_amount_minor=LEAST(fee_amount_minor, $4::bigint), amount_due_minor=0,
          payment_due_at=NULL, seat_hold_expires_at=NULL, updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='payment_pending' AND payment_status='pending' AND payment_id=$5::uuid
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        payment.activityRegistrationId,
        payment.amountMinor,
        payment.id,
      ])
      if (updated.rowCount !== 1) {
        const current = await this.transaction.query<{ payment_status: string }>(`
          SELECT payment_status FROM mbox.community_activity_registrations
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND payment_id=$4::uuid
        `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, payment.activityRegistrationId, payment.id])
        if (current.rows[0]?.payment_status !== 'paid') {
          throw new Error('Activity registration lost its payment confirmation transition')
        }
      }
      return
    }
    if (payment.status === 'failed' || payment.status === 'closed') {
      await this.transaction.query(`
        UPDATE mbox.community_activity_registrations
        SET status='cancelled', payment_status='expired', amount_due_minor=0,
          payment_due_at=NULL, seat_hold_expires_at=NULL,
          cancelled_at=COALESCE(cancelled_at, clock_timestamp()), updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='payment_pending' AND payment_status='pending' AND payment_id=$4::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, payment.activityRegistrationId, payment.id])
    }
  }

  async syncActivityRegistrationRefundStatus(paymentId: string): Promise<void> {
    const result = await this.transaction.query<{ activity_registration_id: string | null; status: PaymentStatus }>(`
      SELECT activity_registration_id, status FROM mbox.payments
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const payment = result.rows[0]
    if (payment?.activity_registration_id === null || payment?.activity_registration_id === undefined) {
      throw new TypeError('payment does not target an activity registration')
    }
    if (payment.status !== 'refunded') return
    await this.transaction.query(`
      UPDATE mbox.community_activity_registrations
      SET status='refunded', payment_status='refunded', amount_due_minor=0,
        cancelled_at=COALESCE(cancelled_at, clock_timestamp()), updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND payment_id=$4::uuid AND payment_status='paid'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, payment.activity_registration_id, paymentId])
  }

  private async lockPayable(reference: Readonly<{
    payable_kind: Payment['payableKind']; order_id: string | null; activity_registration_id: string | null
  }>): Promise<void> {
    if (reference.payable_kind === 'order' && reference.order_id !== null) {
      await this.lockOrder(reference.order_id)
      return
    }
    if (reference.payable_kind === 'activity_registration' && reference.activity_registration_id !== null) {
      const locked = await this.transaction.query(`
        SELECT id FROM mbox.community_activity_registrations
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, reference.activity_registration_id])
      if (locked.rowCount !== 1) throw new PaymentNotFoundError(reference.activity_registration_id)
      return
    }
    throw new PaymentNotFoundError('invalid payable target')
  }

  private async lockOrder(orderId: string): Promise<OrderRow> {
    const result = await this.transaction.query<OrderRow>(`
      SELECT id, table_session_id, total_amount_minor, currency, status
      FROM mbox.orders
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    const row = result.rows[0]
    if (row === undefined) throw new OrderNotPayableError(orderId, 'order was not found')
    return row
  }

  private async assertOrderAccess(
    order: Readonly<OrderRow>,
    principal: Readonly<CreatePaymentForOrderInput['principal']>,
  ): Promise<void> {
    if (principal.type === 'employee') return
    if (order.table_session_id !== principal.tableSessionId) {
      throw new OrderNotPayableError(order.id, 'order does not belong to the authenticated table session')
    }
    if (!await lockBoundGuestTablePosition(this.transaction,{
      tableSessionId:principal.tableSessionId,customerId:principal.customerId,
      actorRef:`guest-session:${principal.guestSessionId}`,
    })) {
      throw new OrderNotPayableError(order.id, 'customer is not linked to the authenticated table session')
    }
  }

  private async readSettlement(orderId: string): Promise<SettlementRow> {
    const result = await this.transaction.query<SettlementRow>(`
      SELECT
        COALESCE(SUM(p.amount_minor) FILTER (
          WHERE p.status IN ('succeeded', 'partially_refunded', 'refunded')
        ), 0)::text AS gross_paid_minor,
        COALESCE((
          SELECT SUM(r.amount_minor)
          FROM mbox.refunds AS r
          JOIN mbox.payments AS paid
            ON paid.tenant_id = r.tenant_id
           AND paid.store_id = r.store_id
           AND paid.id = r.payment_id
          WHERE paid.tenant_id = $1::uuid
            AND paid.store_id = $2::uuid
            AND paid.order_id = $3::uuid
            AND r.status = 'succeeded'
        ), 0)::text AS refunded_minor,
        COALESCE(BOOL_OR(p.status IN ('created', 'pending')), false) AS has_pending
      FROM mbox.payments AS p
      WHERE p.tenant_id = $1::uuid
        AND p.store_id = $2::uuid
        AND p.order_id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    return result.rows[0] ?? { gross_paid_minor: '0', refunded_minor: '0', has_pending: false }
  }
}

const PAYMENT_COLUMNS = `
  id, payable_kind, order_id, activity_registration_id, public_id,
  provider, provider_transaction_id, settlement_channel, method,
  amount_minor, currency, status, provider_snapshot,
  succeeded_at::text, created_at::text, updated_at::text
`

function verifyCallback(payment: PaymentRow, input: Readonly<ApplyPaymentCallbackInput>): void {
  if (payment.provider !== input.provider) {
    throw new PaymentCallbackMismatchError('Payment callback provider does not match the payment')
  }
  if (toSafeMinor(payment.amount_minor, 'stored payment amount') !== input.reportedAmountMinor) {
    throw new PaymentCallbackMismatchError('Payment callback amount does not match the order-derived payment amount')
  }
  if (payment.currency !== input.reportedCurrency) {
    throw new PaymentCallbackMismatchError('Payment callback currency does not match the payment')
  }
  if (payment.provider_transaction_id !== null
    && payment.provider_transaction_id !== input.providerTransactionId) {
    throw new PaymentCallbackMismatchError('Payment callback transaction id conflicts with the stored transaction')
  }
  if (input.settlementChannel !== undefined
    && payment.settlement_channel !== null
    && payment.settlement_channel !== input.settlementChannel) {
    throw new PaymentCallbackMismatchError('Payment callback settlement channel conflicts with the stored payment')
  }
}

function validateCreateInput(input: Readonly<CreatePaymentForOrderInput>): void {
  nonBlank('orderId', input.orderId)
  if (input.publicId.length < 8 || input.publicId.length > 128) {
    throw new TypeError('publicId must contain between 8 and 128 characters')
  }
  const evidence = input.evidence ?? {}
  if (input.principal.type === 'guest') {
    nonBlank('tableSessionId', input.principal.tableSessionId)
    nonBlank('customerId', input.principal.customerId)
  } else {
    nonBlank('employeeId', input.principal.employeeId)
  }
  if (input.provider === 'cash') {
    if (input.method !== 'cash') throw new PaymentEvidenceError('Cash payments must use the cash method')
    requireEvidence(evidence, ['receiptReference', 'collectedByEmployeeId'], 'cash')
    if (input.initialStatus !== 'succeeded') {
      throw new PaymentEvidenceError('Cash payments must be recorded as already collected')
    }
  } else if (input.provider === 'physical_pos') {
    if (input.method !== 'card' && input.method !== 'manual') {
      throw new PaymentEvidenceError('Physical POS payments must use card or manual method')
    }
    requireEvidence(
      evidence,
      ['terminalId', 'receiptReference', 'collectedByEmployeeId'],
      'physical POS',
    )
    if (input.initialStatus !== 'succeeded') {
      throw new PaymentEvidenceError('Physical POS payments must be recorded as already collected')
    }
  } else if (input.method === 'cash' || input.method === 'card') {
    throw new PaymentEvidenceError('Online providers cannot use cash or card manual methods')
  }
}

function validateCallbackInput(input: Readonly<ApplyPaymentCallbackInput>): void {
  nonBlank('paymentPublicId', input.paymentPublicId)
  nonBlank('providerTransactionId', input.providerTransactionId)
  if (!Number.isSafeInteger(input.reportedAmountMinor) || input.reportedAmountMinor <= 0) {
    throw new TypeError('reportedAmountMinor must be a positive safe integer')
  }
  if (!/^[A-Z]{3}$/.test(input.reportedCurrency)) {
    throw new TypeError('reportedCurrency must be a three-letter uppercase currency code')
  }
  if (input.settlementChannel !== undefined
    && !['wechat', 'alipay', 'unionpay'].includes(input.settlementChannel)) {
    throw new TypeError('settlementChannel is invalid')
  }
}

function requireEvidence(evidence: JsonObject, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (typeof evidence[key] !== 'string' || evidence[key].trim().length === 0) {
      throw new PaymentEvidenceError(`${label} evidence requires ${key}`)
    }
  }
}

function onePayment(
  result: { rows: PaymentRow[]; rowCount: number | null },
  message: string,
): Payment {
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error(message)
  return mapPayment(row)
}

function mapPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    payableKind: row.payable_kind,
    orderId: row.order_id,
    activityRegistrationId: row.activity_registration_id,
    publicId: row.public_id,
    provider: row.provider,
    providerTransactionId: row.provider_transaction_id,
    settlementChannel: row.settlement_channel ?? null,
    method: row.method,
    amountMinor: toSafeMinor(row.amount_minor, 'payment amount'),
    currency: row.currency,
    status: row.status,
    providerSnapshot: sanitizeProviderSnapshot(row.provider_snapshot),
    succeededAt: row.succeeded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSafeMinor(value: string | number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${label} exceeds safe integer range`)
  return parsed
}

function nonBlank(name: string, value: string): void {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be blank`)
}
