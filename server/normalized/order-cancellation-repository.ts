import { createHash } from 'node:crypto'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export type UnpaidOrderCancellationReason = 'duplicate_order' | 'guest_left' | 'test_cleanup' | 'other'

export interface CancelUnpaidOrderInput {
  scope: Readonly<StoreScope>
  orderId: string
  employeeId: string
  businessDate: string
  reasonCode: UnpaidOrderCancellationReason
  reasonNote: string
  idempotencyKey: string
}

export interface CancelUnpaidOrderResult {
  eventId: string
  orderPublicId: string
  sourceBusinessDate: string
  actionBusinessDate: string
  deliveredItemCount: number
  cancelledItemCount: number
  cancelledKdsTaskCount: number
  releasedInventoryReservationCount: number
  occurredAt: string
  replayed: boolean
}

interface CancellationRow extends Record<string, unknown> {
  event_id: string
  order_public_id: string
  source_business_date: string
  action_business_date: string
  delivered_item_count: number
  cancelled_item_count: number
  cancelled_kds_task_count: number
  released_inventory_reservation_count: number
  occurred_at: string
  replayed: boolean
}

export class UnpaidOrderCancellationNotFoundError extends Error {}
export class UnpaidOrderCancellationConflictError extends Error {}
export class UnpaidOrderCancellationForbiddenError extends Error {}

export class PostgresOrderCancellationRepository {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  async cancel(input: Readonly<CancelUnpaidOrderInput>): Promise<CancelUnpaidOrderResult> {
    try {
      return await this.transactions.run(input.scope, async (transaction) => {
        // Use the permanent event's original date for legacy fingerprint compatibility.
        // The database function still checks current permission and operating date.
        await transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[
          `${input.scope.tenantId}:${input.scope.storeId}:order.cancel_unpaid:${input.idempotencyKey}`,
        ])
        const original=(await transaction.query<{action_business_date:string}>(`
          SELECT action_business_date::text FROM mbox.order_cancellation_events
          WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3`,[
          input.scope.tenantId,input.scope.storeId,input.idempotencyKey,
        ])).rows[0]
    const fingerprint = createHash('sha256').update(JSON.stringify({
      orderId: input.orderId,
      employeeId: input.employeeId,
      businessDate: original?.action_business_date ?? input.businessDate,
      reasonCode: input.reasonCode,
      reasonNote: input.reasonNote.trim(),
    }), 'utf8').digest('hex')
        const result = await transaction.query<CancellationRow>(`
          SELECT event_id,order_public_id,source_business_date::text,action_business_date::text,
            delivered_item_count,cancelled_item_count,cancelled_kds_task_count,
            released_inventory_reservation_count,occurred_at::text,replayed
          FROM mbox.cancel_unpaid_order(
            $1::uuid,$2::uuid,$3::date,$4,$5,$6,$7::char(64)
          )
        `, [
          input.orderId,
          input.employeeId,
          input.businessDate,
          input.reasonCode,
          input.reasonNote.trim(),
          input.idempotencyKey,
          fingerprint,
        ])
        const row = result.rows[0]
        if (row === undefined) throw new Error('Unpaid order cancellation did not return a result')
        return {
          eventId: row.event_id,
          orderPublicId: row.order_public_id,
          sourceBusinessDate: row.source_business_date,
          actionBusinessDate: row.action_business_date,
          deliveredItemCount: Number(row.delivered_item_count),
          cancelledItemCount: Number(row.cancelled_item_count),
          cancelledKdsTaskCount: Number(row.cancelled_kds_task_count),
          releasedInventoryReservationCount: Number(row.released_inventory_reservation_count),
          occurredAt: row.occurred_at,
          replayed: row.replayed,
        }
      }, { isolation: 'serializable', retryOnConflict: 2 })
    } catch (error) {
      const code = databaseErrorCode(error)
      const message = error instanceof Error ? error.message : 'Unpaid order cancellation failed'
      if (code === 'P0002') throw new UnpaidOrderCancellationNotFoundError(message)
      if (code === '42501') throw new UnpaidOrderCancellationForbiddenError(message)
      if (code === '22023' || code === '23505' || code === '55000' || code === '40001') {
        throw new UnpaidOrderCancellationConflictError(message)
      }
      throw error
    }
  }
}

function databaseErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}
