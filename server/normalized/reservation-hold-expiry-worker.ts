import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'
import { expireReservationHold } from './reservation-hold-expiry.js'

interface ExpiredReservationRow extends Record<string, unknown> {
  id: string
  public_id: string
}

export interface ReservationHoldExpiryBatch {
  workerId: string
  claimed: number
  expiredReservationIds: readonly string[]
}

export class ReservationHoldExpiryWorker {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    batchSize = 50,
  ): Promise<ReservationHoldExpiryBatch> {
    validateWorkerId(workerId)
    validateBatchSize(batchSize)
    return this.transactions.run(scope, async (transaction) => {
      const due = await claimExpiredReservations(transaction, batchSize)
      const expiredReservationIds: string[] = []
      for (const reservation of due) {
        await expireReservationHold(transaction, {
          id: reservation.id,
          publicId: reservation.public_id,
        }, workerId)
        expiredReservationIds.push(reservation.id)
      }
      return { workerId, claimed: due.length, expiredReservationIds }
    })
  }
}

async function claimExpiredReservations(
  transaction: ScopedTransaction,
  batchSize: number,
): Promise<ExpiredReservationRow[]> {
  const result = await transaction.query<ExpiredReservationRow>(`
    SELECT reservation.id, reservation.public_id
    FROM mbox.reservations AS reservation
    WHERE reservation.tenant_id = $1::uuid
      AND reservation.store_id = $2::uuid
      AND reservation.status = 'pending'
      AND EXISTS (
        SELECT 1
        FROM mbox.reservation_table_locks AS table_lock
        WHERE table_lock.tenant_id = reservation.tenant_id
          AND table_lock.store_id = reservation.store_id
          AND table_lock.reservation_id = reservation.id
          AND table_lock.status = 'held'
          AND table_lock.hold_expires_at <= clock_timestamp()
      )
    ORDER BY reservation.created_at ASC, reservation.id ASC
    FOR UPDATE OF reservation SKIP LOCKED
    LIMIT $3
  `, [transaction.scope.tenantId, transaction.scope.storeId, batchSize])
  return result.rows
}

function validateWorkerId(workerId: string): void {
  if (workerId.trim().length < 3 || workerId.length > 128) {
    throw new TypeError('workerId must contain between 3 and 128 characters')
  }
}

function validateBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    throw new TypeError('batchSize must be an integer between 1 and 50')
  }
}
