import { randomUUID } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import type { ChannelPaymentStatus, SettlementChannel } from '../../src/shared/payment-contracts.js'
import { sanitizeProviderSnapshot } from './payment-security-policy.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { lockBoundGuestTablePosition } from './guest-table-authority.js'
import { RecollectionAuthorizationRepository } from './recollection-authorization-repository.js'
import {
  ActivityRecollectionAuthorizationConflictError,
  ActivityRecollectionAuthorizationRepository,
} from './activity-recollection-authorization-repository.js'

export type PaymentProvider = 'wechat' | 'postar' | 'cash' | 'physical_pos' | 'external_manual' | 'simulation'
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
  /** Immutable activity-registration cycle; null for table orders. */
  activityRegistrationCycle: number | null
  publicId: string
  provider: PaymentProvider
  providerTransactionId: string | null
  settlementChannel: AuthoritativeSettlementChannel | null
  method: PaymentMethod
  amountMinor: number
  currency: string
  status: PaymentStatus
  providerSnapshot: JsonObject
  retryReleasedAt: string | null
  retryReleaseReason: string | null
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

export interface RecordManualPaymentForActivityRegistrationInput {
  registrationPublicId: string
  publicId: string
  provider: Extract<PaymentProvider, 'cash' | 'physical_pos' | 'external_manual'>
  method: Extract<PaymentMethod, 'cash' | 'card' | 'manual'>
  evidence: JsonObject
  collectedByEmployeeId: string
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

export interface ReleaseUnresolvedPaymentForRetryInput {
  paymentId: string
  employeeId: string
  reason: string
  idempotencyKey: string
}

interface PaymentRow extends Record<string, unknown> {
  id: string
  payable_kind: Payment['payableKind']
  order_id: string | null
  activity_registration_id: string | null
  activity_registration_cycle: number | null
  public_id: string
  provider: PaymentProvider
  provider_transaction_id: string | null
  settlement_channel: AuthoritativeSettlementChannel | null
  method: PaymentMethod
  amount_minor: string | number
  currency: string
  status: PaymentStatus
  provider_snapshot: JsonObject
  retry_released_at: string | null
  retry_release_reason: string | null
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

export interface ClosedUnpresentedOnlineActivityPayment extends ClosedUnpresentedOnlinePayment {
  activityRegistrationId: string
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

/**
 * A provider may confirm an older activity payment after the registration was
 * reopened.  That money is real, but it must be refunded before the newer
 * cycle can collect another payment.  Treating it as merely a UI warning
 * would allow a cashier to create a second collection fact.
 */
export class ActivityPaymentLateSuccessRefundRequiredError extends Error {
  constructor(registrationId: string) {
    super(`Activity registration ${registrationId} has an earlier successful payment awaiting refund`)
    this.name = 'ActivityPaymentLateSuccessRefundRequiredError'
  }
}

export class PaymentRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async findOrderIdForRetry(paymentId: string): Promise<string> {
    const selected = await this.transaction.query<{ order_id: string | null }>(`
      SELECT order_id
      FROM mbox.payments
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const row = selected.rows[0]
    if (row === undefined) throw new PaymentNotFoundError(paymentId)
    if (row.order_id === null) {
      throw new OrderNotPayableError(paymentId, 'only a table-order payment can be released for retry')
    }
    return row.order_id
  }

  /**
   * Locks the one online order payment that a staff member intends to query
   * and close before changing collection method.  This does not itself mark
   * the payment failed or make the order collectable: the provider result is
   * still the authority for that transition.
   */
  async prepareOrderPaymentForProviderClose(paymentId: string): Promise<Payment> {
    const selected = await this.transaction.query<PaymentRow>(`
      SELECT ${PAYMENT_COLUMNS}
      FROM mbox.payments
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const row = selected.rows[0]
    if (row === undefined) throw new PaymentNotFoundError(paymentId)
    if (row.order_id === null) {
      throw new OrderNotPayableError(paymentId, 'only a table-order payment can be closed before changing collection method')
    }
    if (!['postar', 'wechat'].includes(row.provider) || !['created', 'pending'].includes(row.status)) {
      throw new OrderNotPayableError(paymentId, 'payment already has a final result or is not an online payment')
    }
    return mapPayment(row)
  }

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

  /**
   * Leaves an already-presented online attempt in place for late provider
   * callbacks, but releases it as the active collection attempt.  This is the
   * low-friction staff action used when the venue has no explicit success and
   * needs to switch method or try again.  It is deliberately not a failure,
   * cancellation, refund, or success assertion.
   */
  async releaseUnresolvedForRetry(
    input: Readonly<ReleaseUnresolvedPaymentForRetryInput>,
  ): Promise<Payment> {
    const reason = input.reason.trim()
    if (reason.length < 4 || reason.length > 500) {
      throw new TypeError('retry release reason must contain between 4 and 500 characters')
    }
    const selected = await this.transaction.query<PaymentRow>(`
      SELECT ${PAYMENT_COLUMNS}
      FROM mbox.payments
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.paymentId])
    const payment = selected.rows[0]
    if (payment === undefined) throw new PaymentNotFoundError(input.paymentId)
    if (payment.order_id === null) {
      throw new OrderNotPayableError(payment.id, 'only a table-order payment can be released for retry')
    }
    const order = await this.lockOrder(payment.order_id)
    const session = await this.transaction.query<{ id: string }>(`
      SELECT id
      FROM mbox.table_sessions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      FOR SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, order.table_session_id])
    if (session.rowCount !== 1) throw new OrderNotPayableError(order.id, 'table session is unavailable')
    if (order.status === 'draft' || order.status === 'cancelled') {
      throw new OrderNotPayableError(order.id, `status is ${order.status}`)
    }
    if (!['wechat', 'postar', 'simulation'].includes(payment.provider)
      || !['created', 'pending'].includes(payment.status)) {
      throw new OrderNotPayableError(order.id, 'payment is already final or is not an online payment')
    }
    if (payment.retry_released_at !== null) {
      throw new OrderNotPayableError(order.id, 'payment was already released for a replacement collection')
    }
    const updated = await this.transaction.query<PaymentRow>(`
      UPDATE mbox.payments
      SET retry_released_at=clock_timestamp(),
          retry_released_by_employee_id=$4::uuid,
          retry_release_reason=$5::text,
          retry_release_idempotency_key=$6::text,
          provider_snapshot=provider_snapshot || jsonb_build_object(
            'retryReleasedAt',clock_timestamp()::text,
            'retryReleaseReason',$5::text
          ),
          updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND retry_released_at IS NULL AND status IN ('created','pending')
      RETURNING ${PAYMENT_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      payment.id,
      input.employeeId,
      reason,
      input.idempotencyKey,
    ])
    const released = onePayment(updated, `Payment ${payment.id} changed while releasing it for retry`)
    await this.syncOrderPaymentStatus(order.id)
    return released
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
    // A refund records money leaving the venue. It must not by itself reopen a
    // customer payment link: an explicit, short-lived cashier authorization is
    // locked and consumed together with the replacement payment below.
    const recollection = await new RecollectionAuthorizationRepository(this.transaction).prepareForPayment({
      orderId: order.id,
      outstandingMinor,
      refundedMinor: toSafeMinor(settlement.refunded_minor, 'refunded'),
      currency: order.currency,
    })

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
    const payment = onePayment(inserted, 'Creating a payment did not insert exactly one row')
    await new RecollectionAuthorizationRepository(this.transaction).consume(recollection.authorizationId, payment.id)
    return payment
  }

  /**
   * Records an in-store activity collection without turning the registration
   * into a synthetic order. A provider action that might already have reached
   * the rail is never replaced by cash/POS/manual collection.
   */
  async recordManualForActivityRegistration(
    input: Readonly<RecordManualPaymentForActivityRegistrationInput>,
  ): Promise<{ payment: Payment; supersededOnlinePayments: readonly ClosedUnpresentedOnlineActivityPayment[] }> {
    validateManualActivityInput(input)
    const registrationResult = await this.transaction.query<{
      id: string
      status: string
      payment_status: string
      payment_id: string | null
      amount_due_minor: string | number
      paid_amount_minor: string | number
      currency: string
      activity_id: string
      activity_package_id: string | null
      party_size: number
      registration_cycle: number
    }>(`
      SELECT id,status,payment_status,payment_id,amount_due_minor,paid_amount_minor,currency,
        activity_id,activity_package_id,party_size,registration_cycle
      FROM mbox.community_activity_registrations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.registrationPublicId])
    const registration = registrationResult.rows[0]
    if (registration === undefined) throw new OrderNotPayableError(input.registrationPublicId, 'activity registration was not found')

    const isRefunded = registration.status === 'refunded' || registration.payment_status === 'refunded'
    const amountMinor = isRefunded
      ? toSafeMinor(registration.paid_amount_minor, 'refunded activity payment')
      : toSafeMinor(registration.amount_due_minor, 'activity amount due')
    if (amountMinor <= 0 || registration.currency.length !== 3) {
      throw new OrderNotPayableError(registration.id, 'activity registration has no collectible balance')
    }
    if (!isRefunded && (registration.status !== 'payment_pending' || registration.payment_status !== 'pending')) {
      throw new OrderNotPayableError(registration.id, 'activity registration is not awaiting payment')
    }

    await this.assertNoUnrefundedHistoricalActivityPayment(
      registration.id,
      registration.registration_cycle,
    )

    const recollection = await new ActivityRecollectionAuthorizationRepository(this.transaction).prepareForPayment({
      activityRegistrationId: registration.id,
      amountMinor,
      currency: registration.currency,
    })
    const supersededOnlinePayments = isRefunded
      ? []
      : await this.closeUnpresentedOnlineActivityPaymentsForManualCollection(
          registration.id,
          input.collectedByEmployeeId,
        )

    // A refund releases activity-package stock. Re-collecting the old price is
    // therefore not enough: the original activity/package capacity and every
    // package component must be held again before a new payment fact exists.
    // This all runs in the same transaction, so any capacity or stock failure
    // leaves both the authorization and registration safely refunded.
    if (isRefunded) await this.reserveActivityRecoveryCapacityAndInventory(registration)

    const reference = requiredEvidenceString(input.evidence, 'receiptReference')
    const inserted = await this.transaction.query<PaymentRow>(`
      INSERT INTO mbox.payments(
        tenant_id,store_id,payable_kind,order_id,activity_registration_id,activity_registration_cycle,public_id,
        provider,provider_transaction_id,method,amount_minor,currency,status,provider_snapshot,succeeded_at
      ) VALUES (
        $1::uuid,$2::uuid,'activity_registration',NULL,$3::uuid,$4,$5,$6,$7,$8,$9::bigint,$10,
        'succeeded',$11::jsonb,clock_timestamp()
      )
      RETURNING ${PAYMENT_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      registration.id,
      registration.registration_cycle,
      input.publicId,
      input.provider,
      reference,
      input.method,
      amountMinor,
      registration.currency,
      JSON.stringify(sanitizeProviderSnapshot(input.evidence)),
    ])
    const payment = onePayment(inserted, 'Creating an activity manual payment did not insert exactly one row')
    const linked = await this.transaction.query(`
      UPDATE mbox.community_activity_registrations
      SET payment_id=$4::uuid,status='confirmed',payment_status='paid',
        paid_amount_minor=$5::bigint,amount_due_minor=0,payment_due_at=NULL,
        seat_hold_expires_at=NULL,cancelled_at=NULL,
        updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND (
          (status='payment_pending' AND payment_status='pending')
          OR (status='refunded' AND payment_status='refunded')
        )
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      registration.id,
      payment.id,
      amountMinor,
    ])
    if (linked.rowCount !== 1) throw new OrderNotPayableError(registration.id, 'activity registration changed while collecting')
    await this.extendPaidActivityPackageReservationToActivityEnd(registration.id, payment.id)
    if (isRefunded) {
      await this.restoreActivityRegistrationContactForRecollection({
        registrationId: registration.id,
        registrationCycle: registration.registration_cycle,
        paymentId: payment.id,
      })
    }
    await new ActivityRecollectionAuthorizationRepository(this.transaction).consume(recollection.authorizationId, payment.id)
    return { payment, supersededOnlinePayments }
  }

  /** Re-acquires the original promised package without creating an order. */
  private async reserveActivityRecoveryCapacityAndInventory(registration: Readonly<{
    id: string
    activity_id: string
    activity_package_id: string | null
    party_size: number
    registration_cycle: number
  }>): Promise<void> {
    const activity = await this.transaction.query<{
      id: string; capacity: number; status: string; ends_at: string; registered_count: string | number
    }>(`
      SELECT activity.id,activity.capacity,activity.status,activity.ends_at::text,
        COALESCE((
          SELECT sum(active_registration.party_size)
          FROM mbox.community_activity_registrations active_registration
          WHERE active_registration.tenant_id=activity.tenant_id AND active_registration.store_id=activity.store_id
            AND active_registration.activity_id=activity.id
            AND active_registration.status IN ('reserved','payment_pending','confirmed','checked_in')
        ),0)::text AS registered_count
      FROM mbox.community_activities activity
      WHERE activity.tenant_id=$1::uuid AND activity.store_id=$2::uuid AND activity.id=$3::uuid
      FOR UPDATE OF activity
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, registration.activity_id])
    const activityRow = activity.rows[0]
    if (activityRow === undefined || !['published', 'full'].includes(activityRow.status)
      || new Date(activityRow.ends_at).getTime() <= Date.now()) {
      throw new ActivityRecollectionAuthorizationConflictError('活动已结束或不再可履约，不能恢复收款')
    }
    if (toSafeMinor(activityRow.registered_count, 'active activity registrations') + registration.party_size > activityRow.capacity) {
      throw new ActivityRecollectionAuthorizationConflictError('活动名额已被后续报名占满，不能恢复收款')
    }
    // `registration_cycle` is part of immutable promotion trigger facts.
    // A corrected cashier collection reopens the same attendance, rather than
    // manufacturing another attendance cycle and breaking those source facts.
    if (registration.activity_package_id === null) return

    const packageResult = await this.transaction.query<{
      id: string; capacity: number; registered_count: string | number
    }>(`
      SELECT package.id,package.capacity,COALESCE((
        SELECT sum(package_registration.party_size)
        FROM mbox.community_activity_registrations package_registration
        WHERE package_registration.tenant_id=package.tenant_id AND package_registration.store_id=package.store_id
          AND package_registration.activity_package_id=package.id
          AND package_registration.status IN ('reserved','payment_pending','confirmed','checked_in')
      ),0)::text AS registered_count
      FROM mbox.community_activity_packages package
      WHERE package.tenant_id=$1::uuid AND package.store_id=$2::uuid
        AND package.id=$3::uuid AND package.activity_id=$4::uuid
      FOR UPDATE OF package
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      registration.activity_package_id,
      registration.activity_id,
    ])
    const packageRow = packageResult.rows[0]
    if (packageRow === undefined) {
      throw new ActivityRecollectionAuthorizationConflictError('原活动套餐已不存在，不能恢复收款')
    }
    if (toSafeMinor(packageRow.registered_count, 'active package registrations') + registration.party_size > packageRow.capacity) {
      throw new ActivityRecollectionAuthorizationConflictError('原活动套餐名额已被后续报名占满，不能恢复收款')
    }

    const components = await this.transaction.query<{
      id: string; inventory_item_id: string; item_name: string; item_status: string; required_quantity: string
    }>(`
      SELECT component.id,component.inventory_item_id,item.name AS item_name,item.status AS item_status,
        (component.quantity * CASE WHEN component.per_participant THEN $4::numeric ELSE 1::numeric END)::text
          AS required_quantity
      FROM mbox.community_activity_package_components component
      JOIN mbox.inventory_items item
        ON item.tenant_id=component.tenant_id AND item.store_id=component.store_id
       AND item.id=component.inventory_item_id
      WHERE component.tenant_id=$1::uuid AND component.store_id=$2::uuid
        AND component.activity_package_id=$3::uuid
      ORDER BY component.inventory_item_id,component.id
      FOR KEY SHARE OF component,item
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      registration.activity_package_id,
      registration.party_size,
    ])
    for (const component of components.rows) {
      if (component.item_status !== 'active') {
        throw new ActivityRecollectionAuthorizationConflictError(`套餐物料“${component.item_name}”当前不可用，不能恢复收款`)
      }
      await this.transaction.query(`
        INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id)
        VALUES($1::uuid,$2::uuid,$3::uuid)
        ON CONFLICT(tenant_id,store_id,inventory_item_id) DO NOTHING
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, component.inventory_item_id])
      const held = await this.transaction.query(`
        UPDATE mbox.inventory_balances
        SET reserved_quantity=reserved_quantity+$4::numeric,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid
          AND on_hand_quantity-reserved_quantity>=$4::numeric
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        component.inventory_item_id,
        component.required_quantity,
      ])
      if (held.rowCount !== 1) {
        throw new ActivityRecollectionAuthorizationConflictError(`套餐物料“${component.item_name}”库存不足，不能恢复收款`)
      }
      const reservation = await this.transaction.query<{ id: string }>(`
        INSERT INTO mbox.community_activity_package_inventory_reservations(
          tenant_id,store_id,registration_id,registration_cycle,package_component_id,
          inventory_item_id,quantity,status,expires_at
        ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7::numeric,'reserved',$8::timestamptz)
        ON CONFLICT(tenant_id,store_id,registration_id,registration_cycle,package_component_id)
        DO UPDATE SET
          inventory_item_id=EXCLUDED.inventory_item_id,quantity=EXCLUDED.quantity,
          status='reserved',expires_at=EXCLUDED.expires_at,movement_id=NULL,
          release_reason=NULL,released_at=NULL,consumed_at=NULL,updated_at=clock_timestamp()
        WHERE mbox.community_activity_package_inventory_reservations.status='released'
        RETURNING id
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        registration.id,
        registration.registration_cycle,
        component.id,
        component.inventory_item_id,
        component.required_quantity,
        activityRow.ends_at,
      ])
      if (reservation.rowCount !== 1) {
        throw new ActivityRecollectionAuthorizationConflictError('原活动套餐库存预留状态异常，不能恢复收款')
      }
    }
  }

  /**
   * Refund processing deliberately inactivates the old-cycle contact purpose.
   * A confirmed recollection keeps the original attendance cycle, because that
   * cycle is referenced by immutable promotion facts. Restore the same
   * protected customer evidence as the next governed contact version; we never
   * expose or accept contact fields from the cashier request.
   */
  private async restoreActivityRegistrationContactForRecollection(input: Readonly<{
    registrationId: string
    registrationCycle: number
    paymentId: string
  }>): Promise<void> {
    const copied = await this.transaction.query<{ id: string }>(`
      WITH prior AS (
        SELECT contact.*
        FROM mbox.community_activity_registration_contact_versions contact
        WHERE contact.tenant_id=$1::uuid AND contact.store_id=$2::uuid
          AND contact.registration_id=$3::uuid AND contact.registration_cycle=$4
          AND contact.status='inactive'
        ORDER BY contact.version DESC,contact.id DESC LIMIT 1
        FOR SHARE
      )
      INSERT INTO mbox.community_activity_registration_contact_versions(
        tenant_id,store_id,public_id,registration_id,registration_cycle,version,status,
        supersedes_contact_version_id,contact_type,contact_hash,encrypted_contact,
        encryption_key_id,masked_contact,contact_source,created_by_customer_id,
        idempotency_key,request_sha256,captured_at
      )
      SELECT $1::uuid,$2::uuid,$5,$3::uuid,$4,prior.version+1,'active',
        prior.id,prior.contact_type,prior.contact_hash,prior.encrypted_contact,
        prior.encryption_key_id,prior.masked_contact,prior.contact_source,prior.created_by_customer_id,
        $6,prior.request_sha256,clock_timestamp()
      FROM prior
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.registrationId,
      input.registrationCycle,
      `ACV${randomUUID().replaceAll('-', '').toUpperCase()}`,
      `activity-recollect-${input.paymentId}`,
    ])
    if (copied.rowCount !== 1) {
      throw new ActivityRecollectionAuthorizationConflictError('原报名联系方式证据不可恢复，不能确认重新收款')
    }
  }

  private async closeUnpresentedOnlineActivityPaymentsForManualCollection(
    activityRegistrationId: string,
    employeeId: string,
  ): Promise<ClosedUnpresentedOnlineActivityPayment[]> {
    const selected = await this.transaction.query<PendingOnlinePaymentRow>(`
      SELECT payment.id,payment.public_id,payment.provider,payment.provider_transaction_id,
        provider_action.state AS provider_action_state,
        (payment.provider_snapshot ? 'providerOrderCreatedAt' OR payment.provider_snapshot ? 'providerOrderId')
          AS provider_order_created
      FROM mbox.payments payment
      LEFT JOIN mbox.payment_provider_actions provider_action
        ON provider_action.tenant_id=payment.tenant_id AND provider_action.store_id=payment.store_id
       AND provider_action.payment_id=payment.id
      WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid
        AND payment.activity_registration_id=$3::uuid
        AND payment.provider IN ('wechat','postar') AND payment.status IN ('created','pending')
      ORDER BY payment.created_at,payment.id FOR UPDATE OF payment
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, activityRegistrationId])
    if (selected.rows.length === 0) return []
    const unsafe = selected.rows.find((payment) => (
      payment.provider_transaction_id !== null || payment.provider_order_created
      || payment.provider_action_state !== null
    ))
    if (unsafe !== undefined) {
      throw new OrderNotPayableError(activityRegistrationId, 'activity payment has a provider action; query or close it before manual collection')
    }
    const ids = selected.rows.map((payment) => payment.id)
    const closed = await this.transaction.query(`
      UPDATE mbox.payments
      SET status='closed',provider_snapshot=provider_snapshot || jsonb_build_object(
        'providerStatus','closed','closeReason','replaced_by_manual_activity_collection_before_provider_submission',
        'closedByEmployeeId',$4::uuid,'closedAt',clock_timestamp()::text
      ),updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=ANY($3::uuid[])
        AND status IN ('created','pending')
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, ids, employeeId])
    if (closed.rowCount !== ids.length) {
      throw new OrderNotPayableError(activityRegistrationId, 'activity online payment changed while switching to manual collection')
    }
    return selected.rows.map((payment) => ({
      id: payment.id,
      publicId: payment.public_id,
      provider: payment.provider,
      activityRegistrationId,
    }))
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
      id: string; amount_due_minor: string | number; currency: string; status: string; payment_id: string | null; registration_cycle: number
    }>(`
      SELECT id, amount_due_minor, currency, status, payment_id, registration_cycle
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
    await this.assertNoUnrefundedHistoricalActivityPayment(row.id, row.registration_cycle)
    const inserted = await this.transaction.query<PaymentRow>(`
      INSERT INTO mbox.payments (
        tenant_id, store_id, payable_kind, order_id, activity_registration_id, activity_registration_cycle,
        public_id, provider, method, amount_minor, currency, status, provider_snapshot
      ) VALUES (
        $1::uuid, $2::uuid, 'activity_registration', NULL, $3::uuid, $4,
        $5, 'postar', $6, $7::bigint, $8, 'pending',
        jsonb_build_object('source', 'community_activity_registration')
      )
      RETURNING ${PAYMENT_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.activityRegistrationId,
      row.registration_cycle,
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

  /**
   * Do not infer that an older cycle is harmless just because the current
   * registration points at a newer payment.  A late signed success is a real
   * collection until its refund has completed; legacy rows whose cycle cannot
   * be proven during migration are deliberately handled the same way.
   */
  async assertNoUnrefundedHistoricalActivityPayment(
    registrationId: string,
    currentRegistrationCycle: number,
  ): Promise<void> {
    // Cycle one cannot have a prior collection for this registration.  Apart
    // from avoiding an unnecessary lock, this keeps the guard focused on the
    // only lifecycle in which an older payment can be mistaken for a current
    // one: a reopened registration.
    if (currentRegistrationCycle <= 1) return
    const unresolved = await this.transaction.query<{ id: string }>(`
      SELECT payment.id
      FROM mbox.payments payment
      WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid
        AND payment.activity_registration_id=$3::uuid
        AND payment.status IN ('succeeded','partially_refunded')
        AND (
          payment.activity_registration_cycle IS NULL
          OR payment.activity_registration_cycle<$4::integer
        )
        AND COALESCE((
          SELECT SUM(refund.amount_minor)
          FROM mbox.refunds refund
          WHERE refund.tenant_id=payment.tenant_id AND refund.store_id=payment.store_id
            AND refund.payment_id=payment.id AND refund.status='succeeded'
        ), 0) < payment.amount_minor
      LIMIT 1
      FOR UPDATE OF payment
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      registrationId,
      currentRegistrationCycle,
    ])
    if (unresolved.rows[0] !== undefined) {
      throw new ActivityPaymentLateSuccessRefundRequiredError(registrationId)
    }
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
    if (payment.status === 'failed') {
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
        -- A signed callback received after a successful remote close is an
        -- exceptional late capture, but it is still a real financial fact.
        -- Never throw it away: record it, reconcile it, and let the normal
        -- refund/over-collection workflow handle any replacement collection.
        AND status IN ('created', 'pending', 'closed')
      RETURNING ${PAYMENT_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      payment.id,
      input.providerTransactionId,
      JSON.stringify(sanitizeProviderSnapshot({
        ...input.providerSnapshot,
        ...(payment.status === 'closed' ? { lateSuccessAfterClose: true } : {}),
      })),
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
      if (stored.status === 'closed' && nextStatus === 'succeeded') {
        // A bound provider result wins over a previously accepted close. This
        // is rare, but rejecting it would lose a confirmed collection and can
        // leave a re-opened registration/order with an invisible overpayment.
      } else if (stored.status !== nextStatus) {
        throw new PaymentTransitionError(stored.id, stored.status)
      } else {
        return { payment: mapPayment(stored), applied: false }
      }
    }
    const snapshot = sanitizeProviderSnapshot({
      ...input.providerSnapshot,
      providerStatus: input.status,
      queryObservedAt: input.succeededAt ?? null,
      ...(stored.status === 'closed' && nextStatus === 'succeeded'
        ? { lateSuccessAfterClose: true }
        : {}),
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
        AND status IN ('created', 'pending', 'closed')
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
        AND state IN ('creating', 'ready', 'unknown', 'failed', 'consumed')
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
        const current = await this.transaction.query<{
          status: string
          payment_status: string
          payment_id: string | null
        }>(`
          SELECT status,payment_status,payment_id::text
          FROM mbox.community_activity_registrations
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, payment.activityRegistrationId])
        // A provider can exceptionally deliver a signed success after M-BOX
        // accepted a remote close and the customer reopened the same
        // registration.  The old collection must be reconciled, but it must
        // not overwrite the newer registration/payment link.  The payment
        // outcome makes that fact visible for refund/over-collection review.
        if (current.rows[0]?.payment_id !== payment.id || current.rows[0]?.status !== 'payment_pending') return
        if (current.rows[0]?.payment_status !== 'paid') {
          throw new Error('Activity registration lost its payment confirmation transition')
        }
      }
      await this.extendPaidActivityPackageReservationToActivityEnd(payment.activityRegistrationId, payment.id)
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

  /**
   * A pending registration's package stock follows its payment deadline. Once
   * paid, the same stock must remain held through the activity's fulfilment
   * window. Terminal or refund-in-flight reservations are deliberately left
   * untouched; their own workflow remains the only authority to release them.
   */
  private async extendPaidActivityPackageReservationToActivityEnd(
    registrationId: string,
    paymentId: string,
  ): Promise<void> {
    await this.transaction.query(`
      UPDATE mbox.community_activity_package_inventory_reservations reservation
      SET expires_at=activity.ends_at,updated_at=clock_timestamp()
      FROM mbox.community_activity_registrations registration
      JOIN mbox.community_activities activity
        ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
       AND activity.id=registration.activity_id
      WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
        AND reservation.registration_id=registration.id
        AND reservation.registration_cycle=registration.registration_cycle
        AND reservation.status='reserved'
        AND reservation.expires_at<activity.ends_at
        AND registration.id=$3::uuid AND registration.payment_id=$4::uuid
        AND registration.status='confirmed' AND registration.payment_status='paid'
        AND activity.ends_at>clock_timestamp()
        AND NOT EXISTS (
          SELECT 1 FROM mbox.refunds refund
          WHERE refund.tenant_id=registration.tenant_id AND refund.store_id=registration.store_id
            AND refund.payment_id=registration.payment_id
            AND refund.status IN ('requested','approved','processing')
        )
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      registrationId,
      paymentId,
    ])
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
        COALESCE(BOOL_OR(
          p.status IN ('created', 'pending')
        ), false) AS has_pending
      FROM mbox.payments AS p
      WHERE p.tenant_id = $1::uuid
        AND p.store_id = $2::uuid
        AND p.order_id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    return result.rows[0] ?? { gross_paid_minor: '0', refunded_minor: '0', has_pending: false }
  }
}

const PAYMENT_COLUMNS = `
  id, payable_kind, order_id, activity_registration_id, activity_registration_cycle, public_id,
  provider, provider_transaction_id, settlement_channel, method,
  amount_minor, currency, status, provider_snapshot,
  retry_released_at::text, retry_release_reason,
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
  } else if (input.provider === 'external_manual') {
    if (input.method !== 'manual') {
      throw new PaymentEvidenceError('External manual payments must use the manual method')
    }
    requireEvidence(
      evidence,
      ['externalMethodCode', 'receiptReference', 'collectionNote', 'collectedByEmployeeId'],
      'external manual payment',
    )
    if (input.initialStatus !== 'succeeded') {
      throw new PaymentEvidenceError('External manual payments must be recorded as already collected')
    }
  } else if (input.method === 'cash' || input.method === 'card') {
    throw new PaymentEvidenceError('Online providers cannot use cash or card manual methods')
  }
}

function validateManualActivityInput(input: Readonly<RecordManualPaymentForActivityRegistrationInput>): void {
  nonBlank('registrationPublicId', input.registrationPublicId)
  nonBlank('collectedByEmployeeId', input.collectedByEmployeeId)
  if (input.publicId.length < 8 || input.publicId.length > 128) {
    throw new TypeError('publicId must contain between 8 and 128 characters')
  }
  if (input.evidence.collectedByEmployeeId !== input.collectedByEmployeeId) {
    throw new PaymentEvidenceError('Activity payment collector must match the acting employee')
  }
  if (input.provider === 'cash') {
    if (input.method !== 'cash') throw new PaymentEvidenceError('Cash payments must use the cash method')
    requireEvidence(input.evidence, ['receiptReference', 'collectedByEmployeeId'], 'cash')
    return
  }
  if (input.provider === 'physical_pos') {
    if (input.method !== 'card' && input.method !== 'manual') {
      throw new PaymentEvidenceError('Physical POS payments must use card or manual method')
    }
    requireEvidence(input.evidence, ['terminalId', 'receiptReference', 'collectedByEmployeeId'], 'physical POS')
    return
  }
  if (input.method !== 'manual') {
    throw new PaymentEvidenceError('External manual payments must use the manual method')
  }
  requireEvidence(
    input.evidence,
    ['externalMethodCode', 'receiptReference', 'collectionNote', 'collectedByEmployeeId'],
    'external manual payment',
  )
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

function requiredEvidenceString(evidence: JsonObject, key: string): string {
  const value = evidence[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PaymentEvidenceError(`payment evidence requires ${key}`)
  }
  return value.trim()
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
    activityRegistrationCycle: row.activity_registration_cycle === null
      ? null
      : Number(row.activity_registration_cycle),
    publicId: row.public_id,
    provider: row.provider,
    providerTransactionId: row.provider_transaction_id,
    settlementChannel: row.settlement_channel ?? null,
    method: row.method,
    amountMinor: toSafeMinor(row.amount_minor, 'payment amount'),
    currency: row.currency,
    status: row.status,
    providerSnapshot: sanitizeProviderSnapshot(row.provider_snapshot),
    retryReleasedAt: row.retry_released_at ?? null,
    retryReleaseReason: row.retry_release_reason ?? null,
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
