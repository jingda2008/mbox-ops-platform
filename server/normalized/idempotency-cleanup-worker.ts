import type { StoreScope } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'

export interface IdempotencyCleanupResult {
  deleted: number
  ids: string[]
}

type TransactionExecutor = Pick<ScopedPostgresTransactionRunner, 'run'>

export class IdempotencyCleanupWorker {
  constructor(private readonly transactions: TransactionExecutor) {}

  async runBatch(
    scope: Readonly<StoreScope>,
    options: Readonly<{ limit?: number }> = {},
  ): Promise<IdempotencyCleanupResult> {
    const limit = boundedLimit(options.limit ?? 50)
    const ids = await this.transactions.run(scope, async (transaction) => {
      const deleted = await transaction.query<{ id: string }>(`
        WITH candidates AS (
          SELECT id
          FROM mbox.idempotency_records
          WHERE tenant_id = $1::uuid
            AND store_id = $2::uuid
            AND expires_at <= clock_timestamp()
            AND status IN ('completed', 'failed')
          ORDER BY expires_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $3
        )
        DELETE FROM mbox.idempotency_records record
        USING candidates
        WHERE record.tenant_id = $1::uuid
          AND record.store_id = $2::uuid
          AND record.id = candidates.id
          AND record.expires_at <= clock_timestamp()
          AND record.status IN ('completed', 'failed')
        RETURNING record.id
      `, [transaction.scope.tenantId, transaction.scope.storeId, limit])
      return deleted.rows.map((row) => row.id)
    })
    return { deleted: ids.length, ids }
  }
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new TypeError('limit must be an integer between 1 and 50')
  }
  return value
}
