import { describe, expect, it } from 'vitest'
import { IdempotencyCleanupWorker } from './idempotency-cleanup-worker.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
}

class ScriptedTransactions {
  calls: Array<{ sql: string; values: readonly unknown[] }> = []

  async run<Result>(
    currentScope: Readonly<StoreScope>,
    operation: (transaction: ScopedTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({
      scope: currentScope,
      query: async <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
        this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
        return {
          rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] as Row[],
          rowCount: 1,
        }
      },
    })
  }
}

describe('IdempotencyCleanupWorker', () => {
  it('deletes only expired terminal records in a bounded SKIP LOCKED batch', async () => {
    const transactions = new ScriptedTransactions()
    const result = await new IdempotencyCleanupWorker(transactions).runBatch(scope, { limit: 50 })

    expect(result).toEqual({
      deleted: 1,
      ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    })
    expect(transactions.calls).toHaveLength(1)
    expect(transactions.calls[0]?.sql).toContain("status IN ('completed', 'failed')")
    expect(transactions.calls[0]?.sql).not.toContain("status IN ('processing'")
    expect(transactions.calls[0]?.sql).toContain('expires_at <= clock_timestamp()')
    expect(transactions.calls[0]?.sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(transactions.calls[0]?.sql).toContain('LIMIT $3')
    expect(transactions.calls[0]?.values).toEqual([scope.tenantId, scope.storeId, 50])
  })

  it('rejects unsafe batch sizes before opening a transaction', async () => {
    const transactions = new ScriptedTransactions()
    await expect(new IdempotencyCleanupWorker(transactions).runBatch(scope, { limit: 51 }))
      .rejects.toThrow('limit must be an integer between 1 and 50')
    expect(transactions.calls).toHaveLength(0)
  })
})
