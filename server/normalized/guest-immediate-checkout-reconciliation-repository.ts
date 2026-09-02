import { PaymentFulfillmentRepository } from './payment-fulfillment-repository.js'
import type { PaymentStatus } from './payment-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type GuestImmediateCheckoutAbandonmentReason =
  | 'customer_payment_exit'
  | 'stale_guest_immediate_payment'

export interface GuestImmediateCheckoutAbandonment {
  eventId: string
  paymentId: string
  orderId: string
  orderPublicId: string
  paymentPublicId: string
  sourceBusinessDate: string
  actionBusinessDate: string
  providerTerminalStatus: Extract<PaymentStatus, 'closed' | 'failed'> | 'unresolved'
  releasedInventoryReservationCount: number
  cancelledItemCount: number
  cancelledKdsTaskCount: number
  occurredAt: string
  replayed: boolean
}

export class GuestImmediateCheckoutAbandonmentConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuestImmediateCheckoutAbandonmentConflictError'
  }
}

interface PaymentRow extends Record<string, unknown> {
  payment_id: string
  payment_public_id: string
  payment_status: PaymentStatus
  payment_provider: string
  payment_method: string
  order_id: string
  order_public_id: string
  order_status: string
  order_payment_status: string
  order_channel: string
  settlement_mode: string
  fulfillment_state: string
}

interface EventRow extends Record<string, unknown> {
  id: string
  payment_id: string
  order_id: string
  order_public_id: string
  payment_public_id: string
  source_business_date: string
  action_business_date: string
  provider_terminal_status: Extract<PaymentStatus, 'closed' | 'failed'> | 'unresolved'
  released_inventory_reservation_count: string | number
  cancelled_item_count: string | number
  cancelled_kds_task_count: string | number
  occurred_at: string
}

/**
 * Owns only the operational retirement record for customer QR immediate
 * payments. It never closes a physical table and it never deletes a payment
 * fact. The caller must query/close the payment channel before a terminal
 * outcome is asserted.
 */
export class GuestImmediateCheckoutReconciliationRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async retire(input: Readonly<{
    paymentId: string
    workerRef: string
    providerOutcome: 'terminal' | 'unresolved'
    reasonCode: GuestImmediateCheckoutAbandonmentReason
  }>): Promise<GuestImmediateCheckoutAbandonment> {
    requireWorkerRef(input.workerRef)
    const existing = await this.findEvent(input.paymentId)
    if (existing !== null) return mapAbandonment(existing, true)

    const payment = await this.lockPayment(input.paymentId)
    assertEligible(payment, input.providerOutcome)
    await this.assertNoCompetingFinancialWork(payment)

    const fulfillment = await new PaymentFulfillmentRepository(this.transaction).abandonGuestSelfCheckout(
      payment.order_id,
      input.providerOutcome === 'terminal'
        ? 'provider confirmed guest immediate checkout was not paid'
        : 'guest immediate checkout payment could not be determined in time',
    )
    const cancelledTasks = await this.cancelKdsTasks(payment.order_id)
    const cancelledItems = await this.cancelOrderItems(payment.order_id)
    await this.invalidateCheckoutUpgrade(payment.order_id)
    const cancelledOrder = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.orders
      SET status='cancelled',cancelled_at=clock_timestamp(),completed_at=NULL,
          updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='submitted' AND payment_status IN ('unpaid','pending')
      RETURNING id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, payment.order_id])
    if (cancelledOrder.rowCount !== 1) {
      throw new GuestImmediateCheckoutAbandonmentConflictError('guest checkout order changed while retirement was running')
    }
    return this.record({
      paymentId: payment.payment_id,
      orderId: payment.order_id,
      orderPublicId: payment.order_public_id,
      paymentPublicId: payment.payment_public_id,
      providerTerminalStatus: input.providerOutcome === 'terminal'
        ? terminalStatus(payment.payment_status) : 'unresolved',
      reasonCode: input.reasonCode,
      releasedInventoryReservationCount: fulfillment.reservationCount,
      cancelledItemCount: cancelledItems,
      cancelledKdsTaskCount: cancelledTasks,
      workerRef: input.workerRef,
    })
  }

  /**
   * The customer exit endpoint already holds the guest/table authority and
   * has safely cancelled the operational order. Record that durable fact so a
   * later successful provider callback produces a cashier refund review.
   */
  async recordCustomerExit(input: Readonly<{
    paymentId: string
    orderId: string
    orderPublicId: string
    paymentPublicId: string
    releasedInventoryReservationCount: number
    cancelledItemCount: number
    cancelledKdsTaskCount: number
    workerRef: string
  }>): Promise<GuestImmediateCheckoutAbandonment> {
    return this.record({
      ...input,
      providerTerminalStatus: 'unresolved',
      reasonCode: 'customer_payment_exit',
    })
  }

  async hasAbandonmentEvent(paymentId: string): Promise<boolean> {
    return (await this.findEvent(paymentId)) !== null
  }

  private async record(input: Readonly<{
    paymentId: string
    orderId: string
    orderPublicId: string
    paymentPublicId: string
    providerTerminalStatus: Extract<PaymentStatus, 'closed' | 'failed'> | 'unresolved'
    reasonCode: GuestImmediateCheckoutAbandonmentReason
    releasedInventoryReservationCount: number
    cancelledItemCount: number
    cancelledKdsTaskCount: number
    workerRef: string
  }>): Promise<GuestImmediateCheckoutAbandonment> {
    requireWorkerRef(input.workerRef)
    requireCount(input.releasedInventoryReservationCount, 'released inventory reservation count')
    requireCount(input.cancelledItemCount, 'cancelled item count')
    requireCount(input.cancelledKdsTaskCount, 'cancelled KDS task count')
    // A late provider success is real money, but this order's lines have
    // already been cancelled. Persist the protected marker before recording
    // the event so refund handling can return the money without reviving
    // fulfilment or making a cancelled line permanently non-refundable.
    const marked = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.payments
      SET provider_snapshot=provider_snapshot || jsonb_build_object(
            'guestCheckoutAbandoned',true,
            'guestCheckoutAbandonedAt',clock_timestamp()::text
          ),updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      RETURNING id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,input.paymentId])
    if (marked.rowCount !== 1) {
      throw new GuestImmediateCheckoutAbandonmentConflictError('guest checkout payment changed before abandonment was recorded')
    }
    const inserted = await this.transaction.query<EventRow>(`
      INSERT INTO mbox.guest_immediate_checkout_abandonment_events (
        tenant_id,store_id,payment_id,order_id,order_public_id,payment_public_id,
        source_business_date,action_business_date,provider_terminal_status,reason_code,
        released_inventory_reservation_count,cancelled_item_count,cancelled_kds_task_count,worker_ref
      )
      SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,
        session.business_date,
        (((clock_timestamp() AT TIME ZONE store.timezone)-store.business_day_cutoff)::date),
        $7,$8,$9::integer,$10::integer,$11::integer,$12
      FROM mbox.table_sessions AS session
      JOIN mbox.stores AS store
        ON store.tenant_id=session.tenant_id AND store.id=session.store_id AND store.status='active'
      WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
        AND session.id=(
          SELECT ordering.table_session_id
          FROM mbox.orders AS ordering
          WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid AND ordering.id=$4::uuid
        )
      ON CONFLICT (tenant_id,store_id,payment_id) DO NOTHING
      RETURNING id,payment_id,order_id,order_public_id,payment_public_id,
        source_business_date::text,action_business_date::text,provider_terminal_status,
        released_inventory_reservation_count,cancelled_item_count,cancelled_kds_task_count,
        occurred_at::text
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,input.paymentId,input.orderId,
      input.orderPublicId,input.paymentPublicId,input.providerTerminalStatus,input.reasonCode,
      input.releasedInventoryReservationCount,input.cancelledItemCount,input.cancelledKdsTaskCount,input.workerRef,
    ])
    const row = inserted.rows[0]
    if (row !== undefined) return mapAbandonment(row, false)
    const existing = await this.findEvent(input.paymentId)
    if (existing === null) throw new Error('guest checkout abandonment event was not persisted')
    return mapAbandonment(existing, true)
  }

  private async findEvent(paymentId: string): Promise<EventRow | null> {
    const result = await this.transaction.query<EventRow>(`
      SELECT id,payment_id,order_id,order_public_id,payment_public_id,
        source_business_date::text,action_business_date::text,provider_terminal_status,
        released_inventory_reservation_count,cancelled_item_count,cancelled_kds_task_count,
        occurred_at::text
      FROM mbox.guest_immediate_checkout_abandonment_events
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND payment_id=$3::uuid
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,paymentId])
    return result.rows[0] ?? null
  }

  private async lockPayment(paymentId: string): Promise<PaymentRow> {
    const result = await this.transaction.query<PaymentRow>(`
      SELECT payment.id AS payment_id,payment.public_id AS payment_public_id,
        payment.status AS payment_status,payment.provider AS payment_provider,payment.method AS payment_method,
        ordering.id AS order_id,ordering.public_id AS order_public_id,
        ordering.status AS order_status,ordering.payment_status AS order_payment_status,
        ordering.channel AS order_channel,ordering.settlement_mode,ordering.fulfillment_state
      FROM mbox.payments AS payment
      JOIN mbox.orders AS ordering
        ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
       AND ordering.id=payment.order_id
      WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid AND payment.id=$3::uuid
      FOR UPDATE OF payment,ordering
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,paymentId])
    const row = result.rows[0]
    if (row === undefined) throw new GuestImmediateCheckoutAbandonmentConflictError('guest checkout payment no longer exists')
    return row
  }

  private async assertNoCompetingFinancialWork(payment: Readonly<PaymentRow>): Promise<void> {
    const competing = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.payments
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid AND id<>$4::uuid
        AND status IN ('created','pending','succeeded','partially_refunded','refunded')
      FOR UPDATE
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,payment.order_id,payment.payment_id])
    if (competing.rowCount !== 0) {
      throw new GuestImmediateCheckoutAbandonmentConflictError('guest checkout has another active or collected payment')
    }
    const delivered = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.order_items
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid AND status='delivered'
      FOR UPDATE
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,payment.order_id])
    if (delivered.rowCount !== 0) {
      throw new GuestImmediateCheckoutAbandonmentConflictError('guest checkout contains delivered items')
    }
  }

  private async cancelKdsTasks(orderId: string): Promise<number> {
    const result = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.kds_tasks AS task
      SET status='cancelled',cancelled_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM mbox.order_items AS item
      WHERE item.tenant_id=task.tenant_id AND item.store_id=task.store_id AND item.id=task.order_item_id
        AND task.tenant_id=$1::uuid AND task.store_id=$2::uuid AND item.order_id=$3::uuid
        AND task.status NOT IN ('cancelled','failed','completed')
      RETURNING task.id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,orderId])
    return result.rowCount ?? 0
  }

  private async cancelOrderItems(orderId: string): Promise<number> {
    const result = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.order_items
      SET status='cancelled',updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid AND status<>'cancelled'
      RETURNING id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,orderId])
    return result.rowCount ?? 0
  }

  private async invalidateCheckoutUpgrade(orderId: string): Promise<void> {
    await this.transaction.query(`
      UPDATE mbox.checkout_upgrade_offers
      SET status='cancelled',selected_at=NULL,converted_order_id=NULL,converted_order_item_id=NULL,
          converted_at=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND converted_order_id=$3::uuid AND status='converted'
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,orderId])
  }
}

function assertEligible(row: Readonly<PaymentRow>, outcome: 'terminal' | 'unresolved'): void {
  const providerStatusValid = outcome === 'terminal'
    ? row.payment_status === 'closed' || row.payment_status === 'failed'
    : row.payment_status === 'created' || row.payment_status === 'pending'
  const orderPaymentStatusValid = outcome === 'terminal'
    ? row.order_payment_status === 'unpaid'
    : ['unpaid','pending'].includes(row.order_payment_status)
  if (row.payment_provider !== 'postar' || row.payment_method !== 'jsapi'
    || !providerStatusValid
    || row.order_channel !== 'guest_qr' || row.settlement_mode !== 'immediate_payment'
    || row.order_status === 'cancelled' || !orderPaymentStatusValid
    || !['awaiting_payment','released'].includes(row.fulfillment_state)) {
    throw new GuestImmediateCheckoutAbandonmentConflictError('payment is not an eligible guest immediate checkout')
  }
}

function terminalStatus(status: PaymentStatus): Extract<PaymentStatus, 'closed' | 'failed'> {
  if (status === 'closed' || status === 'failed') return status
  throw new GuestImmediateCheckoutAbandonmentConflictError('payment is not terminal')
}

function mapAbandonment(row: Readonly<EventRow>, replayed: boolean): GuestImmediateCheckoutAbandonment {
  return {
    eventId: row.id,paymentId: row.payment_id,orderId: row.order_id,
    orderPublicId: row.order_public_id,paymentPublicId: row.payment_public_id,
    sourceBusinessDate: row.source_business_date,actionBusinessDate: row.action_business_date,
    providerTerminalStatus: row.provider_terminal_status,
    releasedInventoryReservationCount: safeCount(row.released_inventory_reservation_count),
    cancelledItemCount: safeCount(row.cancelled_item_count),
    cancelledKdsTaskCount: safeCount(row.cancelled_kds_task_count),
    occurredAt: row.occurred_at,replayed,
  }
}

function safeCount(value: string | number): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('guest checkout abandonment count is invalid')
  return count
}

function requireCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`)
}

function requireWorkerRef(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(value)) {
    throw new TypeError('workerRef must be a stable internal identifier between 3 and 128 characters')
  }
}
