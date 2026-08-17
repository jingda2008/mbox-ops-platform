import { LoyaltyTierBenefitRepository } from './loyalty-tier-benefit-repository.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export interface LoyaltyTierBenefitExpiryBatch {
  workerId: string
  expiredBenefits: number
  evaluatedAt: string
}

export class LoyaltyTierBenefitExpiryWorker {
  constructor(
    private readonly transactions: ScopedPostgresTransactionRunner,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    batchSize = 100,
  ): Promise<LoyaltyTierBenefitExpiryBatch> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)) throw new TypeError('workerId is invalid')
    if (!Number.isSafeInteger(batchSize) || batchSize<1 || batchSize>500) throw new TypeError('batchSize is invalid')
    const evaluatedAt = this.now()
    if (!Number.isFinite(Date.parse(evaluatedAt))) throw new TypeError('worker time is invalid')
    return this.transactions.run(scope, async (transaction) => {
      const expiredBenefits = await new LoyaltyTierBenefitRepository(transaction).expireDue(evaluatedAt, batchSize)
      if (expiredBenefits>0) await transaction.query(`
        INSERT INTO mbox.audit_events(
          tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,business_date,metadata
        ) SELECT $1::uuid,$2::uuid,'system',$3,'loyalty.tier-benefits.expired',
          'loyalty_tier_benefit_expiry_batch',$3,
          (($4::timestamptz AT TIME ZONE store.timezone)
            -make_interval(secs=>extract(epoch FROM store.business_day_cutoff)))::date,
          jsonb_build_object('expiredBenefits',$5::integer,'evaluatedAt',$4::timestamptz)
        FROM mbox.stores store WHERE store.tenant_id=$1::uuid AND store.id=$2::uuid
      `, [transaction.scope.tenantId, transaction.scope.storeId, workerId, evaluatedAt, expiredBenefits])
      return { workerId, expiredBenefits, evaluatedAt }
    })
  }
}
