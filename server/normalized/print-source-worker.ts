import { PrintTicketSourceRepository } from './print-ticket-source.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

export interface PrintSourceBatch { examined: number; completed: number; skipped: number; retrying: number; dead: number }
interface SourceRow extends Record<string, unknown> {
  id: string; source_outbox_message_id: string; aggregate_id: string; attempts: number
  ticket_kind: 'production' | 'settlement' | 'payment' | 'activity_payment' | 'refund' | 'activity_refund'
}

/** No device I/O. A rendering/routing failure is retained after rolling back
 * only the print work, never a payment, inventory movement or KDS task. */
export class PrintSourceWorker {
  constructor(private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>) {}

  async runBatch(scope: Readonly<StoreScope>, _workerId: string, limit = 10): Promise<PrintSourceBatch> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Invalid print source batch')
    const result: PrintSourceBatch = { examined: 0, completed: 0, skipped: 0, retrying: 0, dead: 0 }
    const rows = await this.transactions.run(scope, async tx => (await tx.query<{id: string}>(`
      SELECT id FROM mbox.print_source_jobs WHERE tenant_id=$1 AND store_id=$2
        AND status IN ('pending','retry') AND next_attempt_at<=clock_timestamp()
      ORDER BY next_attempt_at,id LIMIT $3`, [scope.tenantId, scope.storeId, limit])).rows, { readOnly: true })
    for (const row of rows) {
      const outcome = await this.transactions.run(scope, tx => materialize(tx, row.id))
      if (outcome !== null) { result.examined++; result[outcome]++ }
    }
    return result
  }
}

async function materialize(tx: ScopedTransaction, id: string): Promise<Exclude<keyof PrintSourceBatch, 'examined'> | null> {
  await tx.query("SET LOCAL lock_timeout='100ms'")
  await tx.query("SET LOCAL statement_timeout='2s'")
  const source = (await tx.query<SourceRow>(`
    SELECT id,source_outbox_message_id,aggregate_id,ticket_kind,attempts FROM mbox.print_source_jobs
    WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status IN ('pending','retry')
      AND next_attempt_at<=clock_timestamp() FOR UPDATE SKIP LOCKED`, [tx.scope.tenantId, tx.scope.storeId, id])).rows[0]
  if (!source) return null
  await tx.query('SAVEPOINT print_materialization')
  try {
    const repository = new PrintTicketSourceRepository(tx)
    const method = {
      production: 'materializeOrderProduction', settlement: 'materializeCashierSettlement',
      payment: 'materializeCashierPayment', activity_payment: 'materializeActivityCashierPayment',
      refund: 'materializeCashierRefund', activity_refund: 'materializeActivityCashierRefund',
    } as const
    const jobs = await repository[method[source.ticket_kind]](source.source_outbox_message_id, source.aggregate_id)
    const status = jobs.length > 0 ? 'completed' : 'skipped'
    await tx.query(`UPDATE mbox.print_source_jobs SET status=$4,attempts=attempts+1,
      job_count=$5,completed_at=clock_timestamp(),last_error_code=NULL
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [tx.scope.tenantId, tx.scope.storeId, id, status, jobs.length])
    await tx.query('RELEASE SAVEPOINT print_materialization')
    return status
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT print_materialization')
    const dead = Number(source.attempts) + 1 >= 8
    await tx.query(`UPDATE mbox.print_source_jobs SET status=$4,attempts=attempts+1,
      next_attempt_at=clock_timestamp() + ($5::integer * interval '1 second'),
      last_error_code='print_source_materialization_failed'
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [tx.scope.tenantId, tx.scope.storeId, id,
      dead ? 'dead' : 'retry', Math.min(3600, 30 * 2 ** Number(source.attempts))])
    await tx.query('RELEASE SAVEPOINT print_materialization')
    return dead ? 'dead' : 'retrying'
  }
}
