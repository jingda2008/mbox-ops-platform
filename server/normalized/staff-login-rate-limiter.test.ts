import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { hashDeviceKey } from './staff-session-repository.js'
import {
  PostgresStaffLoginRateLimiter,
  StaffLoginRateLimitError,
} from './staff-login-rate-limiter.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type PostgresPoolClient,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = 'd7000000-0000-4000-8000-000000000001'
const storeId = 'd7000000-0000-4000-8000-000000000002'
const secret = 'normalized-rate-limit-test-secret-32-bytes-minimum'

integration('normalized staff login rate limiter', () => {
  let pool: Pool
  let limiter: PostgresStaffLoginRateLimiter

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    limiter = new PostgresStaffLoginRateLimiter(
      new ScopedPostgresTransactionRunner(asPool(pool)),
      secret,
    )
    await pool.query(`
      INSERT INTO mbox.tenants (id, code, name)
      VALUES ($1::uuid, 'rate-limit-tenant', 'Rate limit tenant')
      ON CONFLICT (id) DO NOTHING
    `, [tenantId])
    await pool.query(`
      INSERT INTO mbox.stores (id, tenant_id, code, name, timezone, business_day_cutoff)
      VALUES ($1::uuid, $2::uuid, 'rate-limit-store', 'Rate limit store', 'Asia/Shanghai', '06:00')
      ON CONFLICT (id) DO NOTHING
    `, [storeId, tenantId])
  })

  beforeEach(async () => {
    await pool.query(`
      DELETE FROM mbox.staff_login_rate_limits
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [tenantId, storeId])
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('blocks the sixth store credential attempt and stores no plaintext principal', async () => {
    const attempt = {
      scope: { tenantId, storeId },
      kind: 'daily_store_credential' as const,
      principalKey: '2026-08-11',
      deviceKeyHash: hashDeviceKey('front-door-tablet'),
    }
    for (let index = 0; index < 5; index += 1) await limiter.consume(attempt)
    await expect(limiter.consume(attempt)).rejects.toBeInstanceOf(StaffLoginRateLimitError)

    const stored = await pool.query<{ principal_hash: string; attempt_count: number }>(`
      SELECT principal_hash, attempt_count
      FROM mbox.staff_login_rate_limits
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [tenantId, storeId])
    expect(stored.rows).toHaveLength(1)
    expect(stored.rows[0]?.attempt_count).toBe(6)
    expect(stored.rows[0]?.principal_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.rows[0]?.principal_hash).not.toContain(attempt.principalKey)
  })

  it('clears a successful principal without affecting another employee', async () => {
    const base = {
      scope: { tenantId, storeId },
      kind: 'employee_pin' as const,
      deviceKeyHash: hashDeviceKey('shared-tablet'),
    }
    await limiter.consume({ ...base, principalKey: 'tom' })
    await limiter.consume({ ...base, principalKey: 'jerry' })
    await limiter.recordResult({ ...base, principalKey: 'tom' }, true)

    const stored = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM mbox.staff_login_rate_limits
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [tenantId, storeId])
    expect(stored.rows[0]?.count).toBe('1')
  })

  it('allows distinct employees and devices to proceed concurrently', async () => {
    const attempts = Array.from({ length: 12 }, (_, index) => ({
      scope: { tenantId, storeId },
      kind: 'employee_pin' as const,
      principalKey: `employee-${index}`,
      deviceKeyHash: hashDeviceKey(`device-${index % 3}`),
    }))
    await expect(Promise.all(attempts.map((attempt) => limiter.consume(attempt)))).resolves.toHaveLength(12)
  })
})

function asPool(pool: Pool): PostgresPool {
  return {
    connect: async () => asPoolClient(await pool.connect()),
    end: async () => pool.end(),
  }
}

function asPoolClient(client: PoolClient): PostgresPoolClient {
  return {
    query: (text, values) => client.query(text, values),
    release: (error) => client.release(error),
  }
}
