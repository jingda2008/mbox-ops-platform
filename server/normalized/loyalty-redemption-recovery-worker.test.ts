import { describe, expect, it, vi } from 'vitest'
import { LoyaltyRedemptionRecoveryWorker } from './loyalty-redemption-recovery-worker.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

const scope = {
  tenantId: '91000000-0000-4000-8000-000000000001',
  storeId: '91000000-0000-4000-8000-000000000002',
}

describe('LoyaltyRedemptionRecoveryWorker', () => {
  it('runs the timeout recovery in one retryable serializable transaction', async () => {
    const transaction = {
      scope,
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as unknown as ScopedTransaction
    const run = vi.fn(async (
      _scope: Readonly<typeof scope>,
      operation: (value: ScopedTransaction) => Promise<unknown>,
    ) => operation(transaction))
    const worker = new LoyaltyRedemptionRecoveryWorker(
      { run } as unknown as ScopedPostgresTransactionRunner,
      () => '2026-08-16T10:00:00.000Z',
    )

    await expect(worker.runBatch(scope, 'redemption-recovery-test', 25)).resolves.toEqual({
      workerId: 'redemption-recovery-test',
      evaluatedAt: '2026-08-16T10:00:00.000Z',
      claimed: 0,
      expired: 0,
      manualReview: 0,
      expiredPublicIds: [],
      manualReviewPublicIds: [],
    })
    expect(run).toHaveBeenCalledWith(scope, expect.any(Function), {
      isolation: 'serializable', retryOnConflict: 2,
    })
  })

  it('rejects unstable worker identifiers, invalid batch sizes and invalid clocks before touching storage', () => {
    const run = vi.fn()
    const transactions = { run } as unknown as ScopedPostgresTransactionRunner
    expect(() => new LoyaltyRedemptionRecoveryWorker(transactions).runBatch(scope, 'x')).toThrow('workerId')
    expect(() => new LoyaltyRedemptionRecoveryWorker(transactions).runBatch(scope, 'valid-worker', 0)).toThrow('batchSize')
    expect(() => new LoyaltyRedemptionRecoveryWorker(transactions, () => 'not-a-date')
      .runBatch(scope, 'valid-worker')).toThrow('worker time')
    expect(run).not.toHaveBeenCalled()
  })
})
