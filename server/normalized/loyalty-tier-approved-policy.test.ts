import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { LoyaltyTierReviewWorker } from './loyalty-tier-review-worker.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

function fixtureIds() { return {
  tenant: randomUUID(), store: randomUUID(), drafter: randomUUID(), approver: randomUUID(),
  publisher: randomUUID(),
  silverCustomer: randomUUID(), silverMembership: randomUUID(), silverAccount: randomUUID(), silverPeriod: randomUUID(),
  goldCustomer: randomUUID(), goldMembership: randomUUID(), goldAccount: randomUUID(), goldPeriod: randomUUID(),
  policy: randomUUID(),
} as const }


integration('approved 12-month 10000/20000 tier policy PostgreSQL acceptance', () => {
  let pool: Pool
  let worker: LoyaltyTierReviewWorker
  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({connectionString:databaseUrl,max:3})
    worker = new LoyaltyTierReviewWorker(new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool))
  })
  afterAll(async () => pool?.end())
  it.each([[0,'member'],[9999,'member'],[10000,'silver'],[19999,'silver'],[20000,'gold']] as const)(
    'regrades expired silver and gold with %s valid growth as %s, excluding expired growth', async (growth,expected) => {
      const ids = fixtureIds()
      await seed(pool,ids)
      for (const [membership,customer] of [[ids.silverMembership,ids.silverCustomer],[ids.goldMembership,ids.goldCustomer]]) {
        for (const [amount,months] of [[50000,13],[growth,1]]) {
          if(!amount) continue
          await pool.query(`INSERT INTO mbox.loyalty_growth_ledger
            (tenant_id,store_id,membership_id,customer_id,entry_type,growth_delta,balance_after,source_id,reason,idempotency_key,occurred_at)
            VALUES($1,$2,$3,$4,'adjust',$5,$5,$6,'隔离数据库等级规则验收',$6,clock_timestamp()-make_interval(months=>$7))`,
            [ids.tenant,ids.store,membership,customer,amount,randomUUID(),months])
        }
      }
      const scope={tenantId:ids.tenant,storeId:ids.store}
      expect(await worker.runBatch(scope,'approved-tier-policy')).toMatchObject({claimed:2,graceStarted:0,reviewed:2})
      const result=await pool.query('SELECT current_tier FROM mbox.loyalty_accounts WHERE tenant_id=$1 AND store_id=$2',[ids.tenant,ids.store])
      expect(result.rows.map(row=>row.current_tier)).toEqual([expected,expected])
      const reviews=await pool.query(`SELECT review_growth FROM mbox.membership_tier_periods WHERE tenant_id=$1 AND store_id=$2 AND status='completed'`,[ids.tenant,ids.store])
      expect(reviews.rows.map(row=>Number(row.review_growth))).toEqual([growth,growth])
      const active=await pool.query(`SELECT ends_at=starts_at+interval '12 months' AS twelve_months,grace_ends_at=ends_at AS no_grace FROM mbox.membership_tier_periods WHERE tenant_id=$1 AND store_id=$2 AND status='active'`,[ids.tenant,ids.store])
      expect(active.rows).toEqual(expected==='member'?[]:[{twelve_months:true,no_grace:true},{twelve_months:true,no_grace:true}])
      expect(await worker.runBatch(scope,'approved-tier-replay')).toMatchObject({claimed:0,reviewed:0})
    })
})
async function seed(pool: Pool, ids: ReturnType<typeof fixtureIds>): Promise<void> {
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
    ) VALUES($1,$2,$3,1,'published',12,12,0,10000,10000,20000,20000,1,1,1,1,
      clock_timestamp()-interval '1 year',$4,$5,clock_timestamp()-interval '1 year',
      $6,clock_timestamp()-interval '1 year'+'1 minute'::interval,'separated','等级周期自动复核测试')
  `, [ids.policy, ids.tenant, ids.store, ids.drafter, ids.approver, ids.publisher])
  await pool.query(`
    INSERT INTO mbox.membership_tier_periods(
      id,tenant_id,store_id,membership_id,policy_version_id,tier,starts_at,ends_at,grace_ends_at,status,qualification_growth
    ) VALUES
      ($1,$3,$4,$5,$7,'silver',clock_timestamp()-interval '13 months',clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day','active',120),
      ($2,$3,$4,$6,$7,'gold',clock_timestamp()-interval '14 months',clock_timestamp()-interval '8 days',clock_timestamp()-interval '8 days','active',320)
  `, [ids.silverPeriod, ids.goldPeriod, ids.tenant, ids.store, ids.silverMembership, ids.goldMembership, ids.policy])
}
