import { PaymentFulfillmentRepository } from './payment-fulfillment-repository.js'
import { PaymentRepository } from './payment-repository.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

interface ExpiredPaymentReservationRow extends Record<string, unknown> {
  id: string
  public_id: string
  payment_state: 'none' | 'terminal' | 'unknown' | 'captured'
}

export interface PaymentReservationExpiryBatch {
  workerId: string
  claimed: number
  releasedOrderIds: readonly string[]
  activatedOrderIds: readonly string[]
  reviewOrderIds: readonly string[]
}

/**
 * Resolves expired inventory reservations without guessing a remote payment result.
 *
 * Orders without a payment, or whose payments are all definitively failed/closed,
 * are safe to release. Created/pending payments remain reserved for provider query.
 * Captured payments are recovered into fulfillment instead of being released.
 */
export class PaymentReservationExpiryWorker {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    batchSize = 50,
  ): Promise<PaymentReservationExpiryBatch> {
    validateWorkerId(workerId)
    validateBatchSize(batchSize)
    return this.transactions.run(scope, async (transaction) => {
      const due = await claimExpiredPaymentReservations(transaction, batchSize)
      const releasedOrderIds: string[] = []
      const activatedOrderIds: string[] = []
      const reviewOrderIds: string[] = []
      const fulfillment = new PaymentFulfillmentRepository(transaction)

      for (const order of due) {
        if (order.payment_state === 'unknown') {
          reviewOrderIds.push(order.id)
          continue
        }
        if (order.payment_state === 'captured') {
          await new PaymentRepository(transaction).syncOrderPaymentStatus(order.id)
          const result = await fulfillment.activatePaidOrder(order.id, {
            metadata: { recoveryWorkerId: workerId },
          })
          if (result.activated) {
            activatedOrderIds.push(order.id)
            await recordResolution(transaction, order, workerId, 'activated', result.kdsTasks.length)
          }
          continue
        }
        const result = await fulfillment.releaseAfterDefinitiveFailure(
          order.id,
          order.payment_state === 'none'
            ? 'payment reservation expired before a payment was created'
            : 'payment reservation expired after all payment attempts were definitively closed',
        )
        if (result.released) {
          releasedOrderIds.push(order.id)
          await recordResolution(transaction, order, workerId, 'released', result.reservationCount)
        }
      }

      return {
        workerId,
        claimed: due.length,
        releasedOrderIds,
        activatedOrderIds,
        reviewOrderIds,
      }
    })
  }
}

async function claimExpiredPaymentReservations(
  transaction: ScopedTransaction,
  batchSize: number,
): Promise<ExpiredPaymentReservationRow[]> {
  const result = await transaction.query<ExpiredPaymentReservationRow>(`
    SELECT order_row.id, order_row.public_id,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM mbox.payments AS payment
          WHERE payment.tenant_id = order_row.tenant_id
            AND payment.store_id = order_row.store_id
            AND payment.order_id = order_row.id
            AND payment.status IN ('succeeded', 'partially_refunded', 'refunded')
        ) THEN 'captured'
        WHEN EXISTS (
          SELECT 1 FROM mbox.payments AS payment
          WHERE payment.tenant_id = order_row.tenant_id
            AND payment.store_id = order_row.store_id
            AND payment.order_id = order_row.id
            AND payment.status IN ('created', 'pending')
        ) THEN 'unknown'
        WHEN EXISTS (
          SELECT 1 FROM mbox.payments AS payment
          WHERE payment.tenant_id = order_row.tenant_id
            AND payment.store_id = order_row.store_id
            AND payment.order_id = order_row.id
        ) THEN 'terminal'
        ELSE 'none'
      END AS payment_state
    FROM mbox.orders AS order_row
    WHERE order_row.tenant_id = $1::uuid
      AND order_row.store_id = $2::uuid
      AND order_row.settlement_mode = 'immediate_payment'
      AND order_row.fulfillment_state = 'awaiting_payment'
      AND order_row.fulfillment_expires_at <= clock_timestamp()
    ORDER BY
      CASE WHEN EXISTS (
        SELECT 1 FROM mbox.payments AS pending_payment
        WHERE pending_payment.tenant_id = order_row.tenant_id
          AND pending_payment.store_id = order_row.store_id
          AND pending_payment.order_id = order_row.id
          AND pending_payment.status IN ('created', 'pending')
      ) THEN 1 ELSE 0 END,
      order_row.fulfillment_expires_at, order_row.id
    FOR UPDATE OF order_row SKIP LOCKED
    LIMIT $3
  `, [transaction.scope.tenantId, transaction.scope.storeId, batchSize])
  return result.rows
}

async function recordResolution(
  transaction: ScopedTransaction,
  order: Readonly<Pick<ExpiredPaymentReservationRow, 'id' | 'public_id'>>,
  workerId: string,
  resolution: 'released' | 'activated',
  affectedCount: number,
): Promise<void> {
  const action = resolution === 'released'
    ? 'order.payment_reservation_expired'
    : 'order.payment_fulfillment_recovered'
  const eventType = resolution === 'released'
    ? 'order.payment_reservation_expired.v1'
    : 'order.payment_fulfillment_recovered.v1'
  const audit = await transaction.query(`
    INSERT INTO mbox.audit_events (
      tenant_id, store_id, actor_type, actor_ref, action,
      object_type, object_id, business_date, metadata
    )
    SELECT $1::uuid, $2::uuid, 'system', $4::text, $5,
      'order', $3::uuid::text,
      (
        (clock_timestamp() AT TIME ZONE store.timezone)
        - make_interval(secs => extract(epoch FROM store.business_day_cutoff))
      )::date,
      jsonb_build_object(
        'workerId', $4::text,
        'resolution', $6::text,
        'affectedCount', $7::integer
      )
    FROM mbox.stores AS store
    WHERE store.tenant_id = $1::uuid AND store.id = $2::uuid
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    order.id,
    workerId,
    action,
    resolution,
    affectedCount,
  ])
  if (audit.rowCount !== 1) throw new Error(`Payment fulfillment audit was not recorded: ${order.id}`)

  const outbox = await transaction.query(`
    INSERT INTO mbox.outbox_messages (
      tenant_id, store_id, message_key, aggregate_type, aggregate_id,
      aggregate_version, message_type, payload
    ) VALUES (
      $1::uuid, $2::uuid, $3, 'order', $4::uuid,
      $5::bigint, $6,
      jsonb_build_object(
        'orderId', $4::uuid,
        'publicId', $7::text,
        'workerId', $8::text,
        'resolution', $9::text,
        'affectedCount', $10::integer
      )
    )
    ON CONFLICT (tenant_id, store_id, message_key) DO NOTHING
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    `payment-fulfillment-${resolution}:${order.id}`,
    order.id,
    resolution === 'released' ? 1 : 2,
    eventType,
    order.public_id,
    workerId,
    resolution,
    affectedCount,
  ])
  if (outbox.rowCount !== 1) throw new Error(`Payment fulfillment outbox was not recorded: ${order.id}`)
}

function validateWorkerId(workerId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(workerId)) {
    throw new TypeError('workerId must be a stable internal identifier between 3 and 128 characters')
  }
}

function validateBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    throw new TypeError('batchSize must be an integer between 1 and 50')
  }
}
