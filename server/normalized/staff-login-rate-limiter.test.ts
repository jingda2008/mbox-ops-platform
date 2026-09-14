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
    expect(stored.rows).toHaveLength(3)
    expect(stored.rows[0]?.attempt_count).toBe(6)
    expect(stored.rows[0]?.principal_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.rows[0]?.principal_hash).not.toContain(attempt.principalKey)
  })

  const attemptFor = (index: number, kind: 'employee_pin' | 'daily_store_credential' = 'employee_pin') => ({
    scope: { tenantId, storeId }, kind, principalKey: kind === 'employee_pin' ? `employee-${index}` : '2026-09-14',
    deviceKeyHash: hashDeviceKey(`device-${index}`), sourceKey: '203.0.113.7',
  })

  it('blocks account guessing across rotated devices and sources, including concurrent attempts', async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => limiter.consume({
      ...attemptFor(index), principalKey: 'tom', sourceKey: `203.0.113.${index + 1}`,
    })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(8)
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(StaffLoginRateLimitError)
  })

  it('bounds source attempts even with rotating devices and employee names', async () => {
    for (let index = 0; index < 40; index++) await limiter.consume(attemptFor(index))
    await expect(limiter.consume(attemptFor(40))).rejects.toBeInstanceOf(StaffLoginRateLimitError)
    await expect(limiter.consume({ ...attemptFor(41), sourceKey: '203.0.113.8' })).resolves.toBeUndefined()
  })

  it('bounds daily credentials despite device rotation and normalizes mapped IPv4', async () => {
    for (let index = 0; index < 40; index++) await limiter.consume(attemptFor(index, 'daily_store_credential'))
    await expect(limiter.consume({ ...attemptFor(41, 'daily_store_credential'), sourceKey: '::ffff:203.0.113.7' }))
      .rejects.toBeInstanceOf(StaffLoginRateLimitError)
  })

  it('bounds distributed store attempts before creating more per-device rows', async () => {
    for (let index = 0; index < 200; index++) await limiter.consume({ ...attemptFor(index), sourceKey: `10.0.0.${index + 1}` })
    await expect(limiter.consume({ ...attemptFor(201), sourceKey: '10.0.1.1' })).rejects.toBeInstanceOf(StaffLoginRateLimitError)
    const before = await pool.query('SELECT count(*) FROM mbox.staff_login_rate_limits WHERE store_id=$1', [storeId])
    await expect(limiter.consume({ ...attemptFor(202), sourceKey: '10.0.1.2' })).rejects.toBeInstanceOf(StaffLoginRateLimitError)
    const after = await pool.query('SELECT count(*) FROM mbox.staff_login_rate_limits WHERE store_id=$1', [storeId])
    expect(after.rows).toEqual(before.rows)
  })

  it('successful shared-source logins release only their own attempt, once', async () => {
    for (let index = 0; index < 39; index++) await limiter.consume(attemptFor(index))
    for (let index = 0; index < 60; index++) {
      const success = attemptFor(100 + index)
      await limiter.consume(success)
      await limiter.recordResult(success, true)
      await limiter.recordResult(success, true)
    }
    await limiter.consume(attemptFor(300))
    await expect(limiter.consume(attemptFor(301))).rejects.toBeInstanceOf(StaffLoginRateLimitError)
  })

  it('does not let a late success decrement a newer window', async () => {
    const old = attemptFor(1)
    await limiter.consume(old)
    await pool.query("UPDATE mbox.staff_login_rate_limits SET expires_at=expires_at + interval '10 minutes' WHERE store_id=$1", [storeId])
    await limiter.recordResult(old, true)
    const counts = await pool.query('SELECT attempt_count FROM mbox.staff_login_rate_limits WHERE store_id=$1', [storeId])
    expect(counts.rows.every(row => row.attempt_count === 1)).toBe(true)
  })

  it('resets expired failure windows', async () => {
    const attempt = attemptFor(1)
    for (let index = 0; index < 8; index++) await limiter.consume(attempt)
    await expect(limiter.consume(attempt)).rejects.toBeInstanceOf(StaffLoginRateLimitError)
    await pool.query("UPDATE mbox.staff_login_rate_limits SET window_started_at=clock_timestamp()-interval '20 minutes', expires_at=clock_timestamp()-interval '10 minutes' WHERE store_id=$1", [storeId])
    await expect(limiter.consume(attempt)).resolves.toBeUndefined()
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
