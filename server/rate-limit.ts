import { createHmac } from 'node:crypto'
import type { PostgresPool, PostgresPoolClient } from './postgres-repository.js'

export interface RateLimitConsumeInput {
  scope: string
  key: string
  limit: number
  windowMs: number
}

export interface RateLimitKey {
  scope: string
  key: string
}

export interface RateLimitDecision {
  allowed: boolean
  count: number
  limit: number
  resetAt: number
}

export interface RateLimitStore {
  consume(input: RateLimitConsumeInput): Promise<RateLimitDecision>
  clear(input: RateLimitKey): Promise<void>
  cleanupExpired(batchSize?: number): Promise<number>
}

interface RateLimitNamespace {
  tenantId: string
  storeId: string
  hashSecret: string
}

export interface PostgresRateLimitStoreOptions extends RateLimitNamespace {
  pool: PostgresPool
}

export interface MemoryRateLimitStoreOptions extends RateLimitNamespace {
  usage: 'test'
  now?: () => number
}

interface RateLimitRow extends Record<string, unknown> {
  hit_count: number | string
  expires_at: Date | string
}

interface CleanupRow extends Record<string, unknown> {
  deleted_count: number | string
}

interface MemoryWindow {
  count: number
  resetAt: number
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SCOPE_PATTERN = /^[a-z][a-z0-9_.:-]{2,63}$/
const MAX_LIMIT = 1_000_000
const MAX_WINDOW_MS = 30 * 24 * 60 * 60_000
const MAX_CLEANUP_BATCH_SIZE = 10_000

const SQL = {
  begin: 'BEGIN ISOLATION LEVEL READ COMMITTED',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  setContext: `
    /* rate-limit:set-context */
    SELECT
      set_config('app.tenant_id', $1, true) AS tenant_id,
      set_config('app.store_id', $2, true) AS store_id
  `,
  consume: `
    /* rate-limit:consume */
    WITH rate_limit_clock AS MATERIALIZED (
      SELECT clock_timestamp() AS current_at, $5::bigint AS window_ms
    ), rate_limit_bucket AS (
      SELECT
        to_timestamp(
          (floor(extract(epoch FROM current_at) * 1000 / window_ms) * window_ms / 1000)::double precision
        ) AS window_started_at,
        make_interval(secs => window_ms::double precision / 1000) AS window_interval
      FROM rate_limit_clock
    )
    INSERT INTO mbox.rate_limit_windows (
      tenant_id, store_id, scope, key_hash, window_started_at, hit_count, expires_at
    )
    SELECT
      $1::uuid, $2::uuid, $3, $4, window_started_at, 1,
      window_started_at + window_interval
    FROM rate_limit_bucket
    ON CONFLICT (tenant_id, store_id, scope, key_hash) DO UPDATE
    SET
      hit_count = CASE
        WHEN mbox.rate_limit_windows.window_started_at = EXCLUDED.window_started_at
          THEN LEAST(mbox.rate_limit_windows.hit_count + 1, $6::bigint)
        ELSE 1
      END,
      window_started_at = EXCLUDED.window_started_at,
      expires_at = EXCLUDED.expires_at,
      updated_at = clock_timestamp()
    RETURNING hit_count, expires_at
  `,
  clear: `
    /* rate-limit:clear */
    DELETE FROM mbox.rate_limit_windows
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND scope = $3
      AND key_hash = $4
  `,
  cleanup: `
    /* rate-limit:cleanup */
    SELECT mbox.cleanup_expired_rate_limits($1::integer) AS deleted_count
  `,
} as const

export class PostgresRateLimitStore implements RateLimitStore {
  private readonly pool: PostgresPool
  private readonly tenantId: string
  private readonly storeId: string
  private readonly hashSecret: string

  constructor(options: PostgresRateLimitStoreOptions) {
    assertUuid(options.tenantId, 'tenantId')
    assertUuid(options.storeId, 'storeId')
    assertHashSecret(options.hashSecret)
    this.pool = options.pool
    this.tenantId = options.tenantId
    this.storeId = options.storeId
    this.hashSecret = options.hashSecret
  }

  async consume(input: RateLimitConsumeInput): Promise<RateLimitDecision> {
    validateConsumeInput(input)
    const keyHash = hashKey({
      tenantId: this.tenantId, storeId: this.storeId, hashSecret: this.hashSecret,
    }, input)
    return this.withTransaction(async (client) => {
      const result = await client.query<RateLimitRow>(SQL.consume, [
        this.tenantId,
        this.storeId,
        input.scope,
        keyHash,
        input.windowMs,
        input.limit + 1,
      ])
      const row = result.rows[0]
      if (result.rowCount !== 1 || !row) throw new Error('Rate-limit UPSERT did not return a row')
      const count = parsePositiveInteger(row.hit_count, 'rate-limit hit count')
      const resetAt = new Date(row.expires_at).getTime()
      if (!Number.isFinite(resetAt)) throw new Error('Rate-limit expiry is invalid')
      return { allowed: count <= input.limit, count, limit: input.limit, resetAt }
    })
  }

  async clear(input: RateLimitKey): Promise<void> {
    validateKey(input)
    const keyHash = hashKey({
      tenantId: this.tenantId, storeId: this.storeId, hashSecret: this.hashSecret,
    }, input)
    await this.withTransaction(async (client) => {
      await client.query(SQL.clear, [this.tenantId, this.storeId, input.scope, keyHash])
    })
  }

  async cleanupExpired(batchSize = 1_000): Promise<number> {
    validateCleanupBatchSize(batchSize)
    return this.withTransaction(async (client) => {
      const result = await client.query<CleanupRow>(SQL.cleanup, [batchSize])
      const value = result.rows[0]?.deleted_count
      if (value === undefined) throw new Error('Rate-limit cleanup did not return a count')
      return parseNonNegativeInteger(value, 'rate-limit cleanup count')
    })
  }

  private async withTransaction<T>(operation: (client: PostgresPoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    let transactionStarted = false
    let releaseError: Error | boolean | undefined
    try {
      await client.query(SQL.begin)
      transactionStarted = true
      await client.query(SQL.setContext, [this.tenantId, this.storeId])
      const result = await operation(client)
      await client.query(SQL.commit)
      return result
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query(SQL.rollback)
        } catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : true
          throw new AggregateError([error, rollbackError], 'Rate-limit transaction and rollback both failed')
        }
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }
}

/** Deterministic process-local adapter for unit tests. Never wire this in Cloud Run. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, MemoryWindow>()
  private readonly now: () => number

  constructor(private readonly options: MemoryRateLimitStoreOptions) {
    assertHashSecret(options.hashSecret)
    this.now = options.now ?? Date.now
  }

  async consume(input: RateLimitConsumeInput): Promise<RateLimitDecision> {
    validateConsumeInput(input)
    const current = this.now()
    const windowStartedAt = Math.floor(current / input.windowMs) * input.windowMs
    const resetAt = windowStartedAt + input.windowMs
    const mapKey = `${input.scope}:${hashKey(this.options, input)}`
    const existing = this.windows.get(mapKey)
    const count = existing?.resetAt === resetAt ? Math.min(existing.count + 1, input.limit + 1) : 1
    this.windows.set(mapKey, { count, resetAt })
    return { allowed: count <= input.limit, count, limit: input.limit, resetAt }
  }

  async clear(input: RateLimitKey): Promise<void> {
    validateKey(input)
    this.windows.delete(`${input.scope}:${hashKey(this.options, input)}`)
  }

  async cleanupExpired(batchSize = 1_000): Promise<number> {
    validateCleanupBatchSize(batchSize)
    const current = this.now()
    let deleted = 0
    for (const [key, window] of this.windows) {
      if (deleted >= batchSize) break
      if (window.resetAt <= current) {
        this.windows.delete(key)
        deleted += 1
      }
    }
    return deleted
  }
}

function hashKey(namespace: RateLimitNamespace, input: RateLimitKey) {
  return createHmac('sha256', namespace.hashSecret)
    .update('mbox-rate-limit-v1\0')
    .update(namespace.tenantId)
    .update('\0')
    .update(namespace.storeId)
    .update('\0')
    .update(input.scope)
    .update('\0')
    .update(input.key)
    .digest('hex')
}

function validateConsumeInput(input: RateLimitConsumeInput) {
  validateKey(input)
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT) {
    throw new Error(`rate-limit limit must be between 1 and ${MAX_LIMIT}`)
  }
  if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1 || input.windowMs > MAX_WINDOW_MS) {
    throw new Error(`rate-limit windowMs must be between 1 and ${MAX_WINDOW_MS}`)
  }
}

function validateKey(input: RateLimitKey) {
  if (!SCOPE_PATTERN.test(input.scope)) throw new Error('rate-limit scope is invalid')
  if (!input.key || input.key.length > 2_048) throw new Error('rate-limit key is invalid')
}

function validateCleanupBatchSize(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CLEANUP_BATCH_SIZE) {
    throw new Error(`rate-limit cleanup batch size must be between 1 and ${MAX_CLEANUP_BATCH_SIZE}`)
  }
}

function assertUuid(value: string, name: string) {
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`)
}

function assertHashSecret(value: string) {
  if (value.length < 32) throw new Error('rate-limit hashSecret must contain at least 32 characters')
}

function parsePositiveInteger(value: number | string, name: string) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} is invalid`)
  return parsed
}

function parseNonNegativeInteger(value: number | string, name: string) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`)
  return parsed
}
