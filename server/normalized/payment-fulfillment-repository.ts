import type { JsonObject } from './command-executor.js'
import {
  InventoryRepository,
  type InventoryConsumption,
  type InventoryOrderReservation,
} from './inventory-repository.js'
import { KdsRepository, type KdsTask } from './kds-repository.js'
import { FulfillmentCapacityRepository } from './fulfillment-capacity-repository.js'
import { OrderRepository, type OrderItem, type SubmittedOrder } from './order-repository.js'
import { OrderNotPayableError } from './payment-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'
import {
  ExperiencePlanActivationRepository,
  type ExperiencePlanActivationResult,
} from './experience-plan-activation-repository.js'

interface FulfillmentOrderRow extends Record<string, unknown> {
  id: string
  settlement_mode: 'immediate_payment' | 'table_tab'
  payment_status: string
  fulfillment_state: 'awaiting_payment' | 'active' | 'released' | 'cancelled'
  fulfillment_expires_at: string | null
}

interface PlannedItemRow extends Record<string, unknown> {
  order_item_id: string
  fulfillment_priority: number
  fulfillment_due_at: string | null
}

export interface PaymentFulfillmentActivation {
  activated: boolean
  orderId: string
  inventoryConsumptions: readonly InventoryConsumption[]
  kdsTasks: readonly KdsTask[]
  experiencePlan: ExperiencePlanActivationResult
}

export interface PaymentFulfillmentRelease {
  released: boolean
  orderId: string
  reservationCount: number
}

export class PaymentFulfillmentRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async prepareSubmittedOrder(
    order: Readonly<SubmittedOrder>,
    options: Readonly<{
      priorityByOrderItemId: ReadonlyMap<string, number>
      dueAtByOrderItemId: ReadonlyMap<string, string | null>
      overrideReason?: string | null
      allowMissingRecipes?: boolean
    }>,
  ): Promise<readonly InventoryOrderReservation[]> {
    await this.persistPlan(order, options)
    if (order.settlementMode !== 'immediate_payment') return []
    await new FulfillmentCapacityRepository(this.transaction)
      .reserveForImmediatePaymentOrder(order.id)
    return new InventoryRepository(this.transaction).reserveForImmediatePaymentOrder(
      order.id,
      order.items,
      { allowMissingRecipes: options.allowMissingRecipes },
    )
  }

  async ensureReservationBeforePayment(orderId: string): Promise<void> {
    let order = await this.lockOrder(orderId)
    if (order.settlement_mode !== 'immediate_payment' || order.fulfillment_state === 'active') return
    if (order.fulfillment_state === 'cancelled') {
      throw new OrderNotPayableError(orderId, 'fulfillment was cancelled')
    }
    if (order.fulfillment_state === 'awaiting_payment'
      && order.fulfillment_expires_at !== null
      && Date.parse(order.fulfillment_expires_at) > Date.now()) return

    if (order.fulfillment_state === 'awaiting_payment' && await this.hasUnknownPayment(orderId)) {
      throw new OrderNotPayableError(orderId, 'payment result is unknown; query the provider before retrying')
    }
    if (order.fulfillment_state === 'awaiting_payment') {
      await this.release(orderId, 'payment reservation expired before an intent was active')
      order = await this.lockOrder(orderId)
    }
    if (order.fulfillment_state !== 'released') {
      throw new OrderNotPayableError(orderId, `fulfillment state is ${order.fulfillment_state}`)
    }
    const restored = await this.transaction.query(`
      UPDATE mbox.orders AS order_row
      SET fulfillment_state = 'awaiting_payment', fulfillment_released_at = NULL,
          fulfillment_expires_at = clock_timestamp() + make_interval(mins => COALESCE((
            SELECT policy.payment_reservation_minutes
            FROM mbox.store_commerce_policies AS policy
            WHERE policy.tenant_id = order_row.tenant_id AND policy.store_id = order_row.store_id
          ), 10)),
          updated_at = clock_timestamp()
      WHERE order_row.tenant_id = $1::uuid AND order_row.store_id = $2::uuid
        AND order_row.id = $3::uuid AND order_row.fulfillment_state = 'released'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    if (restored.rowCount !== 1) throw new OrderNotPayableError(orderId, 'reservation restore lost a concurrent update')
    const submitted = await new OrderRepository(this.transaction).getSubmittedForFulfillment(orderId)
    await new FulfillmentCapacityRepository(this.transaction)
      .reserveForImmediatePaymentOrder(orderId)
    await new InventoryRepository(this.transaction).reserveForImmediatePaymentOrder(orderId, submitted.items)
  }

  async activatePaidOrder(
    orderId: string,
    options: Readonly<{
      createdByEmployeeId?: string | null
      metadata?: JsonObject
      paymentId?: string | null
    }> = {},
  ): Promise<PaymentFulfillmentActivation> {
    const state = await this.lockOrder(orderId)
    if (state.settlement_mode !== 'immediate_payment') {
      return { activated: false, orderId, inventoryConsumptions: [], kdsTasks: [], experiencePlan: absentPlan() }
    }
    if (state.fulfillment_state === 'active') {
      const experiencePlan = await new ExperiencePlanActivationRepository(this.transaction)
        .activatePaidNonCritical(orderId, options.paymentId ?? null)
      return { activated: false, orderId, inventoryConsumptions: [], kdsTasks: [], experiencePlan }
    }
    if (state.fulfillment_state !== 'awaiting_payment' || state.payment_status !== 'paid') {
      throw new OrderNotPayableError(orderId, 'trusted full payment is required before fulfillment')
    }
    const activated = await this.transaction.query(`
      UPDATE mbox.orders
      SET fulfillment_state = 'active', fulfillment_expires_at = NULL,
          fulfillment_activated_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND id = $3::uuid AND fulfillment_state = 'awaiting_payment' AND payment_status = 'paid'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    if (activated.rowCount !== 1) throw new Error(`Order ${orderId} lost its fulfillment activation transition`)
    await new FulfillmentCapacityRepository(this.transaction).activateForPaidOrder(orderId)
    const order = await new OrderRepository(this.transaction).getSubmittedForFulfillment(orderId)
    const inventoryConsumptions = await new InventoryRepository(this.transaction)
      .consumeImmediatePaymentReservations(orderId, {
        createdByEmployeeId: options.createdByEmployeeId ?? null,
        reason: 'trusted payment succeeded',
        metadata: options.metadata,
      })
    const planned = await this.readPlans(orderId)
    const planByItem = new Map(planned.map((row) => [row.order_item_id, row]))
    const kds = new KdsRepository(this.transaction)
    const kdsTasks: KdsTask[] = []
    for (const item of order.items) {
      if (item.fulfillmentStation === 'none') continue
      const plan = planByItem.get(item.id)
      if (plan === undefined) throw new Error(`Fulfillment plan is missing for order item ${item.id}`)
      kdsTasks.push(await kds.create({
        orderItemId: item.id,
        stationCode: item.fulfillmentStation,
        quantity: item.quantity,
        priority: Number(plan.fulfillment_priority),
        dueAt: plan.fulfillment_due_at,
        eventIdempotencyKey: `payment-activated:${item.id}:${item.fulfillmentStation}`,
      }))
    }
    const experiencePlan = await new ExperiencePlanActivationRepository(this.transaction)
      .activatePaidNonCritical(orderId, options.paymentId ?? null)
    return { activated: true, orderId, inventoryConsumptions, kdsTasks, experiencePlan }
  }

  async releaseAfterDefinitiveFailure(orderId: string, reason: string): Promise<PaymentFulfillmentRelease> {
    const order = await this.lockOrder(orderId)
    if (order.settlement_mode !== 'immediate_payment' || order.fulfillment_state !== 'awaiting_payment') {
      return { released: false, orderId, reservationCount: 0 }
    }
    return this.release(orderId, reason)
  }

  private async release(orderId: string, reason: string): Promise<PaymentFulfillmentRelease> {
    await new FulfillmentCapacityRepository(this.transaction).releaseReservedForOrder(orderId, reason)
    const reservationCount = await new InventoryRepository(this.transaction)
      .releaseImmediatePaymentReservations(orderId, reason)
    const released = await this.transaction.query(`
      UPDATE mbox.orders
      SET fulfillment_state = 'released', fulfillment_expires_at = NULL,
          fulfillment_activated_at = NULL, fulfillment_released_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND id = $3::uuid AND fulfillment_state = 'awaiting_payment'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    if (released.rowCount !== 1) throw new Error(`Order ${orderId} lost its fulfillment release transition`)
    await new ExperiencePlanActivationRepository(this.transaction)
      .cancelAfterDefinitivePaymentFailure(orderId)
    return { released: true, orderId, reservationCount }
  }

  private async persistPlan(
    order: Readonly<SubmittedOrder>,
    options: Readonly<{
      priorityByOrderItemId: ReadonlyMap<string, number>
      dueAtByOrderItemId: ReadonlyMap<string, string | null>
      overrideReason?: string | null
    }>,
  ): Promise<void> {
    for (const item of order.items) {
      const priority = options.priorityByOrderItemId.get(item.id)
      const dueAt = options.dueAtByOrderItemId.get(item.id)
      if (priority === undefined || dueAt === undefined) {
        throw new Error(`Fulfillment plan is incomplete for order item ${item.id}`)
      }
      const updated = await this.transaction.query(`
        UPDATE mbox.order_items
        SET fulfillment_priority = $4, fulfillment_due_at = $5::timestamptz,
            updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, item.id, priority, dueAt])
      if (updated.rowCount !== 1) throw new Error(`Order item ${item.id} fulfillment plan was not stored`)
    }
    await this.transaction.query(`
      UPDATE mbox.orders
      SET fulfillment_priority = $4, fulfillment_due_at = $5::timestamptz,
          fulfillment_override_reason = $6, updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      order.id,
      Math.max(...options.priorityByOrderItemId.values()),
      earliest(options.dueAtByOrderItemId.values()),
      options.overrideReason ?? null,
    ])
  }

  private async lockOrder(orderId: string): Promise<FulfillmentOrderRow> {
    const result = await this.transaction.query<FulfillmentOrderRow>(`
      SELECT id, settlement_mode, payment_status, fulfillment_state,
        fulfillment_expires_at::text
      FROM mbox.orders
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    const row = result.rows[0]
    if (row === undefined) throw new OrderNotPayableError(orderId, 'order was not found')
    return row
  }

  private async hasUnknownPayment(orderId: string): Promise<boolean> {
    const result = await this.transaction.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM mbox.payments
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
          AND status IN ('created', 'pending')
      ) AS exists
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    return result.rows[0]?.exists === true
  }

  private async readPlans(orderId: string): Promise<PlannedItemRow[]> {
    const result = await this.transaction.query<PlannedItemRow>(`
      SELECT id AS order_item_id, fulfillment_priority, fulfillment_due_at::text
      FROM mbox.order_items
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
      ORDER BY created_at, id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    return result.rows
  }
}

function absentPlan(): ExperiencePlanActivationResult {
  return { planPublicId: null, state: 'absent', changed: false, cueCount: 0 }
}

function earliest(values: Iterable<string | null>): string | null {
  const timestamps = [...values].filter((value): value is string => value !== null).sort()
  return timestamps[0] ?? null
}

export function buildFulfillmentPlan(
  orderItems: readonly OrderItem[],
  override?: Readonly<{ priority?: number; dueAt?: string | null }>,
): {
  priorityByOrderItemId: ReadonlyMap<string, number>
  dueAtByOrderItemId: ReadonlyMap<string, string | null>
} {
  const priorityByOrderItemId = new Map<string, number>()
  const dueAtByOrderItemId = new Map<string, string | null>()
  for (const item of orderItems) {
    const defaultPriority = boundedInteger(item.fulfillmentPriority, 0, 1_000) ?? 100
    priorityByOrderItemId.set(item.id, override?.priority ?? defaultPriority)
    dueAtByOrderItemId.set(
      item.id,
      override?.dueAt !== undefined
        ? override.dueAt
        : item.fulfillmentStation === 'none'
          ? null
          : item.fulfillmentDueAt ?? new Date(Date.now() + defaultSlaSeconds(item.fulfillmentStation) * 1_000).toISOString(),
    )
  }
  return { priorityByOrderItemId, dueAtByOrderItemId }
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null
}

function defaultSlaSeconds(station: OrderItem['fulfillmentStation']): number {
  if (station === 'bar') return 5 * 60
  if (station === 'kitchen') return 10 * 60
  return 2 * 60
}
