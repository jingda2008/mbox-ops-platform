import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { LoyaltyPointsExpiryWorker } from './loyalty-points-expiry-worker.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('loyalty point expiry worker', () => {
  const tenantId = randomUUID(); const storeId = randomUUID(); const customerId = randomUUID()
  const membershipId = randomUUID(); const accountId = randomUUID(); const lotId = randomUUID()
  let pool: Pool; let worker: LoyaltyPointsExpiryWorker

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 3 })
    worker = new LoyaltyPointsExpiryWorker(new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool))
    const suffix = tenantId.replaceAll('-', '').slice(0, 10)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Expiry tenant')`, [tenantId, `exp-${suffix}`])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Expiry store')`, [storeId, tenantId, `exp-${suffix}`])
    await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES($1,$2,$3,$4,'active')`, [customerId, tenantId, storeId, `exp-customer-${suffix}`])
    await pool.query(`INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status,points_balance) VALUES($1,$2,$3,$4,$5,'member','active',100)`, [membershipId, tenantId, storeId, customerId, `MBXEXP${suffix.toUpperCase()}`])
    await pool.query(`INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id,available_points) VALUES($1,$2,$3,$4,$5,100)`, [accountId, tenantId, storeId, membershipId, customerId])
    await pool.query(`INSERT INTO mbox.loyalty_point_lots(id,tenant_id,store_id,membership_id,customer_id,source_type,source_id,original_points,remaining_points,available_at,expires_at,status) VALUES($1,$2,$3,$4,$5,'legacy_balance','expiry-test',100,100,'2026-01-01T00:00:00Z','2026-02-01T00:00:00Z','available')`, [lotId, tenantId, storeId, membershipId, customerId])
  })
  afterAll(async () => pool?.end())

  it('expires each lot once and keeps account, member balance, ledger and movement consistent', async () => {
    const first = await worker.runBatch({ tenantId, storeId }, 'expiry-worker-test')
    const replay = await worker.runBatch({ tenantId, storeId }, 'expiry-worker-test')
    expect(first).toEqual({ workerId: 'expiry-worker-test', expiredLots: 1, expiredPoints: 100 })
    expect(replay).toEqual({ workerId: 'expiry-worker-test', expiredLots: 0, expiredPoints: 0 })
    const facts = await pool.query(`
      SELECT account.available_points,membership.points_balance,lot.remaining_points,lot.status,
        (SELECT count(*)::integer FROM mbox.loyalty_point_ledger WHERE source_type='expiration' AND source_id=$3::uuid::text) AS ledger_count,
        (SELECT count(*)::integer FROM mbox.loyalty_point_lot_movements WHERE lot_id=$3 AND movement_type='expire') AS movement_count
      FROM mbox.loyalty_accounts account
      JOIN mbox.customer_memberships membership ON membership.id=account.membership_id
      JOIN mbox.loyalty_point_lots lot ON lot.id=$3
      WHERE account.id=$1 AND membership.id=$2
    `, [accountId, membershipId, lotId])
    expect(facts.rows[0]).toEqual({
      available_points: 0, points_balance: 0, remaining_points: 0, status: 'expired',
      ledger_count: 1, movement_count: 1,
    })
  })
})
