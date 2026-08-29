import { appendAuditEvent, appendOutboxMessage } from './command-executor.js'
import {
  AutomaticTableTurnoverConflictError,
  AutomaticTableTurnoverDisabledError,
  AutomaticTableTurnoverNotFoundError,
  PostgresAutomaticTableTurnoverRepository,
} from './automatic-table-turnover-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type ScopedTransaction,
  type StoreScope,
} from './transaction-runner.js'

interface AutomaticTurnoverClockRow extends Record<string, unknown> {
  business_date: string
  cutoff: string
  operating_starts_at: string
}

interface DueTableSessionRow extends Record<string, unknown> {
  id: string
}

export interface AutomaticTableTurnoverBatch {
  workerId: string
  enabled: boolean
  businessDate: string | null
  cutoff: string | null
  operatingStartsAt: string | null
  claimed: number
  closedSessionIds: readonly string[]
  replayedSessionIds: readonly string[]
  skippedSessionIds: readonly string[]
  failedSessionIds: readonly string[]
}

const AUTOMATIC_CUTOFF_REASON = '营业日截止自动收工翻台；财务、退款与晚到支付事实保留待核对'

/**
 * Releases physical tables only after their business date has elapsed. It never
 * changes payment/refund status and processes each table in its own transaction,
 * so a malformed historic table cannot prevent the rest of the venue reopening.
 */
export class AutomaticTableTurnoverWorker {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  async runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    batchSize = 50,
  ): Promise<AutomaticTableTurnoverBatch> {
    assertWorkerId(workerId)
    assertBatchSize(batchSize)
    const clock = await this.transactions.run(scope, (transaction) => readAutomaticTurnoverClock(transaction))
    if (clock === null) {
      return {
        workerId, enabled: false, businessDate: null, cutoff: null, operatingStartsAt: null,
        claimed: 0, closedSessionIds: [], replayedSessionIds: [], skippedSessionIds: [], failedSessionIds: [],
      }
    }
    const due = await this.transactions.run(scope, (transaction) => (
      readDueTableSessions(transaction, clock.business_date, batchSize)
    ))
    const closedSessionIds: string[] = []
    const replayedSessionIds: string[] = []
    const skippedSessionIds: string[] = []
    const failedSessionIds: string[] = []

    for (const session of due) {
      try {
        const turnover = await this.transactions.run(scope, async (transaction) => {
          const result = await new PostgresAutomaticTableTurnoverRepository(transaction).close({
            scope,
            tableSessionId: session.id,
            businessDate: clock.business_date,
            reasonNote: AUTOMATIC_CUTOFF_REASON,
            idempotencyKey: `automatic-cutoff:${session.id}`,
          })
          if (!result.replayed) {
            await appendAuditEvent(transaction, {
              actor: { type: 'system', ref: workerId },
              action: 'table_session.automatic_cutoff_turnover',
              objectType: 'table_session',
              objectId: result.tableSessionId,
              businessDate: result.actionBusinessDate,
              beforeData: { status: 'open', businessDate: result.sourceBusinessDate },
              afterData: {
                status: 'closed', cancelledOrderCount: result.cancelledOrderCount,
                pendingPaymentCount: result.pendingPaymentCount,
                deliveredUnpaidAmountMinor: result.deliveredUnpaidAmountMinor,
                cancelledServiceTaskCount: result.cancelledServiceTaskCount,
              },
              reason: AUTOMATIC_CUTOFF_REASON,
              metadata: {
                workerId,
                cutoff: clock.cutoff,
                operatingStartsAt: clock.operating_starts_at,
                turnoverEventId: result.eventId,
              },
            })
            await appendOutboxMessage(transaction, {
              businessEventKey: `table-session-automatic-cutoff:${result.eventId}`,
              aggregateType: 'table_session',
              aggregateId: result.tableSessionId,
              aggregateVersion: 1,
              eventType: 'table_session.automatic_cutoff_turnover.v1',
              payload: {
                tableSessionId: result.tableSessionId,
                tableCode: result.tableCode,
                sourceBusinessDate: result.sourceBusinessDate,
                actionBusinessDate: result.actionBusinessDate,
                cancelledOrderCount: result.cancelledOrderCount,
                pendingPaymentCount: result.pendingPaymentCount,
                deliveredUnpaidAmountMinor: result.deliveredUnpaidAmountMinor,
                cancelledServiceTaskCount: result.cancelledServiceTaskCount,
                workerId,
              },
            })
          }
          return result
        }, { isolation: 'serializable', retryOnConflict: 2 })
        if (turnover.replayed) replayedSessionIds.push(session.id)
        else closedSessionIds.push(session.id)
      } catch (error) {
        if (error instanceof AutomaticTableTurnoverNotFoundError
          || error instanceof AutomaticTableTurnoverConflictError
          || error instanceof AutomaticTableTurnoverDisabledError) {
          skippedSessionIds.push(session.id)
          continue
        }
        failedSessionIds.push(session.id)
      }
    }
    return {
      workerId,
      enabled: true,
      businessDate: clock.business_date,
      cutoff: clock.cutoff,
      operatingStartsAt: clock.operating_starts_at,
      claimed: due.length,
      closedSessionIds,
      replayedSessionIds,
      skippedSessionIds,
      failedSessionIds,
    }
  }
}

async function readAutomaticTurnoverClock(
  transaction: ScopedTransaction,
): Promise<AutomaticTurnoverClockRow | null> {
  const result = await transaction.query<AutomaticTurnoverClockRow>(`
    SELECT
      (((clock_timestamp() AT TIME ZONE store.timezone) - store.business_day_cutoff)::date)::text
        AS business_date,
      store.business_day_cutoff::text AS cutoff,
      policy.operating_starts_at::text AS operating_starts_at
    FROM mbox.stores AS store
    JOIN mbox.store_automatic_table_turnover_policies AS policy
      ON policy.tenant_id=store.tenant_id AND policy.store_id=store.id
    WHERE store.tenant_id=$1::uuid AND store.id=$2::uuid AND store.status='active'
      AND policy.enabled=true
    FOR KEY SHARE OF store,policy
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  return result.rows[0] ?? null
}

async function readDueTableSessions(
  transaction: ScopedTransaction,
  currentBusinessDate: string,
  batchSize: number,
): Promise<DueTableSessionRow[]> {
  const result = await transaction.query<DueTableSessionRow>(`
    SELECT session.id
    FROM mbox.table_sessions AS session
    WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
      AND session.status IN ('open','closing')
      AND session.business_date < $3::date
    ORDER BY session.business_date,session.opened_at,session.id
    LIMIT $4
  `, [transaction.scope.tenantId, transaction.scope.storeId, currentBusinessDate, batchSize])
  return result.rows
}

function assertWorkerId(workerId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(workerId)) {
    throw new TypeError('workerId must be a stable internal identifier between 3 and 128 characters')
  }
}

function assertBatchSize(batchSize: number): void {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    throw new TypeError('batchSize must be an integer between 1 and 50')
  }
}
