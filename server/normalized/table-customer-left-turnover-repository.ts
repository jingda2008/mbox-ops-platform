import { createHash } from 'node:crypto'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

export interface CloseTableAfterCustomerLeftInput {
  scope: Readonly<StoreScope>
  tableSessionId: string
  employeeId: string
  businessDate: string
  reasonNote: string
  idempotencyKey: string
}

export interface CloseTableAfterCustomerLeftResult {
  eventId: string
  tableSessionId: string
  tableCode: string
  sourceBusinessDate: string
  actionBusinessDate: string
  cancelledOrderCount: number
  pendingPaymentCount: number
  deliveredUnpaidAmountMinor: number
  cancelledServiceTaskCount: number
  occurredAt: string
  replayed: boolean
}

interface TurnoverRow extends Record<string, unknown> {
  event_id: string
  table_session_id: string
  table_code: string
  source_business_date: string
  action_business_date: string
  cancelled_order_count: number | string
  pending_payment_count: number | string
  delivered_unpaid_amount_minor: number | string
  cancelled_service_task_count: number | string
  occurred_at: string
  replayed: boolean
}

export class CustomerLeftTableTurnoverNotFoundError extends Error {}
export class CustomerLeftTableTurnoverConflictError extends Error {}
export class CustomerLeftTableTurnoverForbiddenError extends Error {}

export class PostgresTableCustomerLeftTurnoverRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async close(
    input: Readonly<CloseTableAfterCustomerLeftInput>,
  ): Promise<CloseTableAfterCustomerLeftResult> {
    const requestSha256 = createHash('sha256').update(JSON.stringify({
      tableSessionId: input.tableSessionId,
      employeeId: input.employeeId,
      businessDate: input.businessDate,
      reasonNote: input.reasonNote.trim(),
    }), 'utf8').digest('hex')
    try {
      const result = await this.transaction.query<TurnoverRow>(`
          SELECT event_id,table_session_id,table_code,
            source_business_date::text,action_business_date::text,
            cancelled_order_count,pending_payment_count,
            delivered_unpaid_amount_minor,cancelled_service_task_count,
            occurred_at::text,replayed
          FROM mbox.close_table_after_customer_left(
            $1::uuid,$2::uuid,$3::date,$4,$5,$6::char(64)
          )
      `, [
        input.tableSessionId,
        input.employeeId,
        input.businessDate,
        input.reasonNote.trim(),
        input.idempotencyKey,
        requestSha256,
      ])
      const row = result.rows[0]
      if (row === undefined) throw new Error('Customer-left table turnover did not return a result')
      const deliveredUnpaidAmountMinor = Number(row.delivered_unpaid_amount_minor)
      if (!Number.isSafeInteger(deliveredUnpaidAmountMinor) || deliveredUnpaidAmountMinor < 0) {
        throw new Error('Customer-left table turnover returned an invalid delivered amount')
      }
      return {
        eventId: row.event_id,
        tableSessionId: row.table_session_id,
        tableCode: row.table_code,
        sourceBusinessDate: row.source_business_date,
        actionBusinessDate: row.action_business_date,
        cancelledOrderCount: Number(row.cancelled_order_count),
        pendingPaymentCount: Number(row.pending_payment_count),
        deliveredUnpaidAmountMinor,
        cancelledServiceTaskCount: Number(row.cancelled_service_task_count),
        occurredAt: row.occurred_at,
        replayed: row.replayed,
      }
    } catch (error) {
      const code = databaseErrorCode(error)
      const message = error instanceof Error ? error.message : 'Customer-left table turnover failed'
      if (code === 'P0002') throw new CustomerLeftTableTurnoverNotFoundError(message)
      if (code === '42501') throw new CustomerLeftTableTurnoverForbiddenError(message)
      if (code === '22023' || code === '23505' || code === '55000' || code === '40001') {
        throw new CustomerLeftTableTurnoverConflictError(message)
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
