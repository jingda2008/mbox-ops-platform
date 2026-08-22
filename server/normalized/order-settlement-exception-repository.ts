import { createHash } from 'node:crypto'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export type OrderSettlementExceptionReason = 'manager_comp' | 'uncollectible' | 'test_cleanup'

export interface SettleCancelledUnpaidOrderInput {
  scope: Readonly<StoreScope>
  orderId: string
  employeeId: string
  businessDate: string
  reasonCode: OrderSettlementExceptionReason
  reasonNote: string
  idempotencyKey: string
}

export interface SettleCancelledUnpaidOrderResult {
  eventId: string
  orderPublicId: string
  sourceBusinessDate: string
  actionBusinessDate: string
  settledAmountMinor: number
  occurredAt: string
  replayed: boolean
}

interface SettlementRow extends Record<string, unknown> {
  event_id: string
  order_public_id: string
  source_business_date: string
  action_business_date: string
  settled_amount_minor: string | number
  occurred_at: string
  replayed: boolean
}

export class OrderSettlementExceptionNotFoundError extends Error {}
export class OrderSettlementExceptionConflictError extends Error {}
export class OrderSettlementExceptionForbiddenError extends Error {}

export class PostgresOrderSettlementExceptionRepository {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  async settle(input: Readonly<SettleCancelledUnpaidOrderInput>): Promise<SettleCancelledUnpaidOrderResult> {
    const fingerprint = createHash('sha256').update(JSON.stringify({
      orderId: input.orderId,
      employeeId: input.employeeId,
      businessDate: input.businessDate,
      reasonCode: input.reasonCode,
      reasonNote: input.reasonNote.trim(),
    }), 'utf8').digest('hex')
    try {
      return await this.transactions.run(input.scope, async (transaction) => {
        const result = await transaction.query<SettlementRow>(`
          SELECT event_id,order_public_id,source_business_date::text,action_business_date::text,
            settled_amount_minor,occurred_at::text,replayed
          FROM mbox.settle_cancelled_unpaid_order_exception(
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
        if (row === undefined) throw new Error('Order settlement exception did not return a result')
        const settledAmountMinor = Number(row.settled_amount_minor)
        if (!Number.isSafeInteger(settledAmountMinor) || settledAmountMinor <= 0) {
          throw new Error('Order settlement exception returned an invalid amount')
        }
        return {
          eventId: row.event_id,
          orderPublicId: row.order_public_id,
          sourceBusinessDate: row.source_business_date,
          actionBusinessDate: row.action_business_date,
          settledAmountMinor,
          occurredAt: row.occurred_at,
          replayed: row.replayed,
        }
      }, { isolation: 'serializable', retryOnConflict: 2 })
    } catch (error) {
      const code = databaseErrorCode(error)
      const message = error instanceof Error ? error.message : 'Order settlement exception failed'
      if (code === 'P0002') throw new OrderSettlementExceptionNotFoundError(message)
      if (code === '42501') throw new OrderSettlementExceptionForbiddenError(message)
      if (code === '22023' || code === '23505' || code === '55000' || code === '40001') {
        throw new OrderSettlementExceptionConflictError(message)
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
