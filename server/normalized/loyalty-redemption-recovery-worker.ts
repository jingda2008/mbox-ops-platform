import {
  LoyaltyRedemptionRepository,
  type RedemptionExpiryBatch,
} from './loyalty-redemption-repository.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export interface LoyaltyRedemptionRecoveryBatch extends RedemptionExpiryBatch {
  workerId: string
  evaluatedAt: string
}

export class LoyaltyRedemptionRecoveryWorker {
  constructor(
    private readonly transactions: ScopedPostgresTransactionRunner,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    batchSize = 100,
  ): Promise<LoyaltyRedemptionRecoveryBatch> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)) throw new TypeError('workerId is invalid')
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new TypeError('batchSize is invalid')
    }
    const evaluatedAt = this.now()
    if (!Number.isFinite(Date.parse(evaluatedAt))) throw new TypeError('worker time is invalid')
    return this.transactions.run(scope, async (transaction) => ({
      workerId,
      evaluatedAt,
      ...await new LoyaltyRedemptionRepository(transaction).expireDue(evaluatedAt, workerId, batchSize),
    }), { isolation: 'serializable', retryOnConflict: 2 })
  }
}
