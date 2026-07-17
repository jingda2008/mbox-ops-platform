import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { PostgresPool, PostgresPoolClient, PostgresQueryResult } from './postgres-repository.js'
import { MemoryRateLimitStore, PostgresRateLimitStore } from './rate-limit.js'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const STORE_ID = '22222222-2222-4222-8222-222222222222'
const HASH_SECRET = 'h'.repeat(32)
const WINDOW_MS = 10 * 60_000

interface FakeWindow {
  count: number
  windowStartedAt: number
  expiresAt: number
}

class SharedRateLimitPool implements PostgresPool {
  readonly windows = new Map<string, FakeWindow>()
  readonly queries: Array<{ sql: string; values: unknown[] }> = []
  now = Date.parse('2030-07-14T10:00:00.000Z')

  async connect(): Promise<PostgresPoolClient> {
    return new SharedRateLimitClient(this)
  }

  async end() {}
}

class SharedRateLimitClient implements PostgresPoolClient {
  private transactionStarted = false
  private contextSet = false

  constructor(private readonly pool: SharedRateLimitPool) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    this.pool.queries.push({ sql: normalized, values: structuredClone(values) })
    if (normalized.startsWith('BEGIN')) {
      this.transactionStarted = true
      return result([])
    }
    if (normalized.includes('rate-limit:set-context')) {
      expect(this.transactionStarted).toBe(true)
      expect(values).toEqual([TENANT_ID, STORE_ID])
      this.contextSet = true
      return result([{ tenant_id: TENANT_ID, store_id: STORE_ID }])
    }
    if (normalized.includes('rate-limit:consume')) {
      this.requireContext()
      const mapKey = values.slice(0, 4).join(':')
      const windowMs = Number(values[4])
      const cap = Number(values[5])
      const windowStartedAt = Math.floor(this.pool.now / windowMs) * windowMs
      const expiresAt = windowStartedAt + windowMs
      const existing = this.pool.windows.get(mapKey)
      const count = existing?.windowStartedAt === windowStartedAt ? Math.min(existing.count + 1, cap) : 1
      this.pool.windows.set(mapKey, { count, windowStartedAt, expiresAt })
      return result([{ hit_count: String(count), expires_at: new Date(expiresAt) }])
    }
    if (normalized.includes('rate-limit:clear')) {
      this.requireContext()
      this.pool.windows.delete(values.slice(0, 4).join(':'))
      return result([], 1)
    }
    if (normalized.includes('rate-limit:cleanup')) {
      this.requireContext()
      const batchSize = Number(values[0])
      let deleted = 0
      for (const [key, window] of this.pool.windows) {
        if (deleted >= batchSize) break
        if (window.expiresAt <= this.pool.now) {
          this.pool.windows.delete(key)
          deleted += 1
        }
      }
      return result([{ deleted_count: deleted }])
    }
    if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      this.transactionStarted = false
      this.contextSet = false
      return result([])
    }
    throw new Error(`Unexpected SQL: ${normalized}`)
  }

  release() {}

  private requireContext() {
    expect(this.transactionStarted).toBe(true)
    expect(this.contextSet).toBe(true)
  }
}

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): PostgresQueryResult<Row> {
  return { rows, rowCount }
}

function postgresStore(pool: SharedRateLimitPool) {
  return new PostgresRateLimitStore({
    pool,
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    hashSecret: HASH_SECRET,
  })
}

describe('distributed fixed-window rate limits', () => {
  it('allows five attempts, blocks the sixth, and opens a new fixed window after expiry', async () => {
    let now = Date.parse('2030-07-14T10:00:00.000Z')
    const store = new MemoryRateLimitStore({
      usage: 'test', tenantId: 'tenant-test', storeId: 'store-test', hashSecret: HASH_SECRET, now: () => now,
    })
    const input = { scope: 'pilot.login', key: '203.0.113.8', limit: 5, windowMs: WINDOW_MS }

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(store.consume(input)).resolves.toMatchObject({ allowed: true, count: attempt })
    }
    await expect(store.consume(input)).resolves.toMatchObject({ allowed: false, count: 6 })

    now += WINDOW_MS
    await expect(store.consume(input)).resolves.toMatchObject({ allowed: true, count: 1 })
  })

  it('shares PostgreSQL counters across store instances without persisting raw keys', async () => {
    const pool = new SharedRateLimitPool()
    const firstInstance = postgresStore(pool)
    const secondInstance = postgresStore(pool)
    const rawKey = 'ip=203.0.113.8;pin=1001'
    const input = { scope: 'pilot.login', key: rawKey, limit: 5, windowMs: WINDOW_MS }

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const store = attempt % 2 === 0 ? firstInstance : secondInstance
      await expect(store.consume(input)).resolves.toMatchObject({ allowed: true, count: attempt })
    }
    await expect(firstInstance.consume(input)).resolves.toMatchObject({ allowed: false, count: 6 })
    expect(pool.windows).toHaveLength(1)

    const queryValues = JSON.stringify(pool.queries.map((query) => query.values))
    expect(queryValues).not.toContain('203.0.113.8')
    expect(queryValues).not.toContain('1001')
    expect([...pool.windows.keys()][0]).toMatch(/[0-9a-f]{64}$/)
    expect(pool.queries.some((query) => query.sql.includes('ON CONFLICT'))).toBe(true)

    await secondInstance.clear({ scope: input.scope, key: rawKey })
    await expect(firstInstance.consume(input)).resolves.toMatchObject({ allowed: true, count: 1 })

    pool.now += WINDOW_MS
    await expect(secondInstance.consume(input)).resolves.toMatchObject({ allowed: true, count: 1 })
    pool.now += WINDOW_MS
    await expect(firstInstance.cleanupExpired()).resolves.toBe(1)
    expect(pool.windows).toHaveLength(0)
  })

  it('defines forced tenant/store RLS and bounded expiry cleanup in migration 013', async () => {
    const sql = await readFile(new URL('../database/migrations/013_distributed_rate_limits.sql', import.meta.url), 'utf8')
    expect(sql).toContain('PRIMARY KEY (tenant_id, store_id, scope, key_hash)')
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('tenant_id = mbox.current_tenant_id()')
    expect(sql).toContain('store_id = mbox.current_store_id()')
    expect(sql).toContain('cleanup_expired_rate_limits')
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
  })
})
