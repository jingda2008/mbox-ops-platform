import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { LoyaltyTierReviewWorker } from './loyalty-tier-review-worker.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const ids = {
  tenant: randomUUID(), store: randomUUID(), drafter: randomUUID(), approver: randomUUID(),
  publisher: randomUUID(),
  silverCustomer: randomUUID(), silverMembership: randomUUID(), silverAccount: randomUUID(), silverPeriod: randomUUID(),
  goldCustomer: randomUUID(), goldMembership: randomUUID(), goldAccount: randomUUID(), goldPeriod: randomUUID(),
  policy: randomUUID(),
} as const

integration('loyalty tier review worker PostgreSQL integration', () => {
  let pool: Pool
  let worker: LoyaltyTierReviewWorker

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 3 })
    const runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    worker = new LoyaltyTierReviewWorker(runner)
    await seed(pool)
  })

  afterAll(async () => pool?.end())

  it('starts the configured grace period and downgrades only after grace has ended', async () => {
    const first = await worker.runBatch({ tenantId: ids.tenant, storeId: ids.store }, 'tier-review-test')
    expect(first).toMatchObject({ claimed: 2, graceStarted: 1, reviewed: 1 })

    const periods = await pool.query(`
      SELECT id::text,status,review_result,reviewed_at IS NOT NULL AS reviewed
      FROM mbox.membership_tier_periods
      WHERE tenant_id=$1 AND store_id=$2 ORDER BY id
    `, [ids.tenant, ids.store])
    const byId = new Map(periods.rows.map((row) => [row.id, row]))
    expect(byId.get(ids.silverPeriod)).toMatchObject({ status: 'grace', review_result: null, reviewed: false })
    expect(byId.get(ids.goldPeriod)).toMatchObject({ status: 'completed', review_result: 'downgraded', reviewed: true })

    const tiers = await pool.query(`
      SELECT membership_id::text,current_tier FROM mbox.loyalty_accounts
      WHERE tenant_id=$1 AND store_id=$2 ORDER BY membership_id
    `, [ids.tenant, ids.store])
    const tierByMembership = new Map(tiers.rows.map((row) => [row.membership_id, row.current_tier]))
    expect(tierByMembership.get(ids.silverMembership)).toBe('silver')
    expect(tierByMembership.get(ids.goldMembership)).toBe('member')

    const events = await pool.query(`
      SELECT membership_id::text,event_type,from_tier,to_tier,source_type,source_id
      FROM mbox.membership_tier_events
      WHERE tenant_id=$1 AND store_id=$2 ORDER BY event_type,membership_id
    `, [ids.tenant, ids.store])
    expect(events.rows).toEqual([
      {
        membership_id: ids.goldMembership, event_type: 'downgraded', from_tier: 'gold', to_tier: 'member',
        source_type: 'period_review', source_id: ids.goldPeriod,
      },
      {
        membership_id: ids.silverMembership, event_type: 'grace_started', from_tier: 'silver', to_tier: 'silver',
        source_type: 'period_review', source_id: ids.silverPeriod,
      },
    ])

    const replay = await worker.runBatch({ tenantId: ids.tenant, storeId: ids.store }, 'tier-review-test-replay')
    expect(replay).toMatchObject({ claimed: 1, graceStarted: 0, reviewed: 0 })
    const replayEvents = await pool.query(`
      SELECT count(*)::integer AS count FROM mbox.membership_tier_events
      WHERE tenant_id=$1 AND store_id=$2
    `, [ids.tenant, ids.store])
    expect(replayEvents.rows[0]?.count).toBe(2)
  })

  it('rejects invalid worker identifiers before opening a transaction', () => {
    expect(() => worker.runBatch({ tenantId: ids.tenant, storeId: ids.store }, 'x')).toThrow('workerId is invalid')
  })
})

async function seed(pool: Pool): Promise<void> {
  const suffix = ids.tenant.replaceAll('-', '').slice(0, 10)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Tier Review Tenant')`, [ids.tenant, `tier-${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Tier Review Store')`, [ids.store, ids.tenant, `tier-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
      ($1,$4,$5,$6,'Tier Drafter','active'),($2,$4,$5,$7,'Tier Approver','active'),
      ($3,$4,$5,$8,'Tier Publisher','active')
  `, [ids.drafter, ids.approver, ids.publisher, ids.tenant, ids.store,
    `TD-${suffix}`, `TA-${suffix}`, `TP-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES
      ($1,$3,$4,$5,'active'),($2,$3,$4,$6,'active')
  `, [ids.silverCustomer, ids.goldCustomer, ids.tenant, ids.store, `tier-silver-${suffix}`, `tier-gold-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status) VALUES
      ($1,$3,$4,$5,$6,'silver','active'),($2,$3,$4,$7,$8,'gold','active')
  `, [
    ids.silverMembership, ids.goldMembership, ids.tenant, ids.store,
    ids.silverCustomer, `MBXSR${suffix.toUpperCase()}`, ids.goldCustomer, `MBXGD${suffix.toUpperCase()}`,
  ])
  await pool.query(`
    INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id,current_tier) VALUES
      ($1,$3,$4,$5,$6,'silver'),($2,$3,$4,$7,$8,'gold')
  `, [ids.silverAccount, ids.goldAccount, ids.tenant, ids.store, ids.silverMembership, ids.silverCustomer, ids.goldMembership, ids.goldCustomer])
  await pool.query(`
    INSERT INTO mbox.loyalty_tier_policy_versions(
      id,tenant_id,store_id,version,status,evaluation_window_months,tier_period_months,downgrade_grace_days,
      silver_upgrade_growth,silver_retain_growth,gold_upgrade_growth,gold_retain_growth,
      silver_points_multiplier_numerator,silver_points_multiplier_denominator,
      gold_points_multiplier_numerator,gold_points_multiplier_denominator,
      effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,
      published_by_employee_id,published_at,publication_mode,reason
    ) VALUES($1,$2,$3,1,'published',12,12,7,100,80,300,240,11,10,12,10,
      clock_timestamp()-interval '1 year',$4,$5,clock_timestamp()-interval '1 year',
      $6,clock_timestamp()-interval '1 year'+'1 minute'::interval,'separated','等级周期自动复核测试')
  `, [ids.policy, ids.tenant, ids.store, ids.drafter, ids.approver, ids.publisher])
  await pool.query(`
    INSERT INTO mbox.membership_tier_periods(
      id,tenant_id,store_id,membership_id,policy_version_id,tier,starts_at,ends_at,grace_ends_at,status,qualification_growth
    ) VALUES
      ($1,$3,$4,$5,$7,'silver',clock_timestamp()-interval '13 months',clock_timestamp()-interval '1 day',clock_timestamp()+interval '6 days','active',120),
      ($2,$3,$4,$6,$7,'gold',clock_timestamp()-interval '14 months',clock_timestamp()-interval '8 days',clock_timestamp()-interval '1 day','grace',320)
  `, [ids.silverPeriod, ids.goldPeriod, ids.tenant, ids.store, ids.silverMembership, ids.goldMembership, ids.policy])
}
