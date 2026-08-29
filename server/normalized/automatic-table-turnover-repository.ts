import { createHash } from 'node:crypto'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

export interface AutomaticTableTurnoverInput {
  scope: Readonly<StoreScope>
  tableSessionId: string
  businessDate: string
  reasonNote: string
  idempotencyKey: string
}

export interface AutomaticTableTurnoverResult {
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

export class AutomaticTableTurnoverNotFoundError extends Error {}
export class AutomaticTableTurnoverConflictError extends Error {}
export class AutomaticTableTurnoverDisabledError extends Error {}

/**
 * Dedicated system command for stale sessions. It deliberately has no employee
 * input: a human must use the separately permissioned customer-left command.
 */
export class PostgresAutomaticTableTurnoverRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async close(
    input: Readonly<AutomaticTableTurnoverInput>,
  ): Promise<AutomaticTableTurnoverResult> {
    const requestSha256 = createHash('sha256').update(JSON.stringify({
      tableSessionId: input.tableSessionId,
      businessDate: input.businessDate,
      reasonNote: input.reasonNote.trim(),
      command: 'automatic-cutoff-table-turnover-v1',
    }), 'utf8').digest('hex')
    try {
      const result = await this.transaction.query<TurnoverRow>(`
        SELECT event_id,table_session_id,table_code,
          source_business_date::text,action_business_date::text,
          cancelled_order_count,pending_payment_count,
          delivered_unpaid_amount_minor,cancelled_service_task_count,
          occurred_at::text,replayed
        FROM mbox.close_table_after_automatic_cutoff(
          $1::uuid,NULL::uuid,$2::date,$3,$4,$5::char(64)
        )
      `, [
        input.tableSessionId,
        input.businessDate,
        input.reasonNote.trim(),
        input.idempotencyKey,
        requestSha256,
      ])
      const row = result.rows[0]
      if (row === undefined) throw new Error('Automatic table turnover did not return a result')
      const deliveredUnpaidAmountMinor = Number(row.delivered_unpaid_amount_minor)
      if (!Number.isSafeInteger(deliveredUnpaidAmountMinor) || deliveredUnpaidAmountMinor < 0) {
        throw new Error('Automatic table turnover returned an invalid delivered amount')
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
      const message = error instanceof Error ? error.message : 'Automatic table turnover failed'
      if (code === 'P0002') throw new AutomaticTableTurnoverNotFoundError(message)
      if (code === '42501') throw new AutomaticTableTurnoverDisabledError(message)
      if (code === '22023' || code === '23505' || code === '55000' || code === '40001') {
        throw new AutomaticTableTurnoverConflictError(message)
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
