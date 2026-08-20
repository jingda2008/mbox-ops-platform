import { LoyaltyAccrualRepository } from './loyalty-accrual-repository.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

interface DuePeriod extends Record<string, unknown> {
  id: string
  membership_id: string
  policy_version_id: string
  tier: 'silver' | 'gold'
  status: 'active' | 'grace'
  ends_at: string
  grace_ends_at: string
}

export interface LoyaltyTierReviewBatch {
  workerId: string
  claimed: number
  graceStarted: number
  reviewed: number
}

export class LoyaltyTierReviewWorker {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  runBatch(scope: Readonly<StoreScope>, workerId: string, batchSize = 100): Promise<LoyaltyTierReviewBatch> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)) throw new TypeError('workerId is invalid')
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new TypeError('batchSize is invalid')
    return this.transactions.run(scope, async (transaction) => {
      const due = await transaction.query<DuePeriod>(`
        SELECT id,membership_id,policy_version_id,tier,status,ends_at::text,grace_ends_at::text
        FROM mbox.membership_tier_periods
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status IN ('active','grace')
          AND ends_at IS NOT NULL AND ends_at<=clock_timestamp()
        ORDER BY ends_at,id FOR UPDATE SKIP LOCKED LIMIT $3
      `, [transaction.scope.tenantId, transaction.scope.storeId, batchSize])
      let graceStarted = 0; let reviewed = 0
      for (const period of due.rows) {
        const now = new Date().toISOString()
        if (period.status === 'active' && Date.parse(period.grace_ends_at) > Date.parse(now)) {
          await transaction.query(`
            UPDATE mbox.membership_tier_periods SET status='grace',updated_at=clock_timestamp()
            WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active'
          `, [transaction.scope.tenantId, transaction.scope.storeId, period.id])
          await transaction.query(`
            INSERT INTO mbox.membership_tier_events(
              tenant_id,store_id,membership_id,policy_version_id,event_type,from_tier,to_tier,
              evaluated_growth,reason,source_type,source_id,occurred_at
            ) SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,'grace_started',$5,$5,
              account.growth_value,'等级周期结束，进入已发布规则规定的降级宽限期',
              'period_review',$6,$7::timestamptz
            FROM mbox.loyalty_accounts account
            WHERE account.tenant_id=$1::uuid AND account.store_id=$2::uuid
              AND account.membership_id=$3::uuid
            ON CONFLICT (tenant_id,store_id,membership_id,source_type,source_id,event_type) DO NOTHING
          `, [
            transaction.scope.tenantId, transaction.scope.storeId, period.membership_id,
            period.policy_version_id, period.tier, period.id, now,
          ])
          graceStarted += 1
          continue
        }
        if (Date.parse(period.grace_ends_at) <= Date.parse(now)) {
          await new LoyaltyAccrualRepository(transaction).evaluateMembershipTier(
            period.membership_id, now, period.id, 'period_review',
          )
          reviewed += 1
        }
      }
      return { workerId, claimed: due.rows.length, graceStarted, reviewed }
    })
  }
}
