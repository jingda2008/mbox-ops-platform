import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  hashRequestFingerprint,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  NormalizedCommandExecutor,
  type JsonCodec,
} from './command-executor.js'
import { IdempotencyCleanupWorker } from './idempotency-cleanup-worker.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = '81000000-0000-4000-8000-000000000001'
const storeId = '81000000-0000-4000-8000-000000000002'
const scope = { tenantId, storeId }

const stringCodec: JsonCodec<string> = {
  encode: (value) => value,
  decode: (value) => {
    if (typeof value !== 'string') throw new TypeError('stored result is not a string')
    return value
  },
}

integration('normalized command idempotency expiry', () => {
  let pool: Pool
  let executor: NormalizedCommandExecutor
  let cleanup: IdempotencyCleanupWorker

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    const transactionPool = asPool(pool)
    const transactions = new ScopedPostgresTransactionRunner(transactionPool)
    executor = new NormalizedCommandExecutor(transactions)
    cleanup = new IdempotencyCleanupWorker(transactions)
    await pool.query(`
      INSERT INTO mbox.tenants(id, code, name)
      VALUES ($1::uuid, 'idempotency-test', 'Idempotency Test')
      ON CONFLICT (id) DO NOTHING
    `, [tenantId])
    await pool.query(`
      INSERT INTO mbox.stores(id, tenant_id, code, name)
      VALUES ($1::uuid, $2::uuid, 'idempotency-store', 'Idempotency Store')
      ON CONFLICT (id) DO NOTHING
    `, [storeId, tenantId])
  })

  beforeEach(async () => {
    await pool.query(`
      DELETE FROM mbox.idempotency_records
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [tenantId, storeId])
  })

  afterAll(async () => {
    await pool?.end()
  })

  it.each(['completed', 'failed', 'processing'] as const)(
    'reclaims an expired %s record and clears its old response',
    async (status) => {
      const key = `expired-${status}-record-0001`
      await seedRecord(key, status, 'old-fingerprint', true, status === 'completed' ? 'sensitive-old-value' : null)
      let calls = 0

      const execution = await executor.execute(command(key, 'new-fingerprint'), async () => {
        calls += 1
        return { result: 'fresh-result', auditEvents: [], outboxMessages: [] }
      })

      expect(execution).toEqual({ value: 'fresh-result', replayed: false })
      expect(calls).toBe(1)
      const stored = await pool.query<{
        status: string
        request_sha256: string
        response_snapshot: { result: string }
      }>(`
        SELECT status, request_sha256, response_snapshot
        FROM mbox.idempotency_records
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND idempotency_key = $3
      `, [tenantId, storeId, key])
      expect(stored.rows[0]).toEqual({
        status: 'completed',
        request_sha256: hashRequestFingerprint('new-fingerprint'),
        response_snapshot: { result: 'fresh-result' },
      })
      expect(JSON.stringify(stored.rows[0])).not.toContain('sensitive-old-value')
    },
  )

  it('keeps an unexpired processing record in conflict even when its short lock elapsed', async () => {
    const key = 'active-processing-record-0001'
    await seedRecord(key, 'processing', 'same-fingerprint', false, null, true)
    let calls = 0

    await expect(executor.execute(command(key, 'same-fingerprint'), async () => {
      calls += 1
      return { result: 'must-not-run', auditEvents: [], outboxMessages: [] }
    })).rejects.toBeInstanceOf(IdempotencyInProgressError)
    expect(calls).toBe(0)
  })

  it('replays an unexpired completed record and rejects a different fingerprint', async () => {
    const key = 'active-completed-record-0001'
    await seedRecord(key, 'completed', 'same-fingerprint', false, 'stored-result')

    await expect(executor.execute(command(key, 'same-fingerprint'), async () => ({
      result: 'must-not-run', auditEvents: [], outboxMessages: [],
    }))).resolves.toEqual({ value: 'stored-result', replayed: true })
    await expect(executor.execute(command(key, 'different-fingerprint'), async () => ({
      result: 'must-not-run', auditEvents: [], outboxMessages: [],
    }))).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  it('lets concurrent identical requests reclaim one expired row exactly once', async () => {
    const key = 'expired-concurrent-same-0001'
    await seedRecord(key, 'completed', 'old-fingerprint', true, 'old-result')
    let calls = 0
    const run = () => executor.execute(command(key, 'new-fingerprint'), async () => {
      calls += 1
      await delay(120)
      return { result: 'new-result', auditEvents: [], outboxMessages: [] }
    })

    const results = await Promise.all([run(), run()])
    expect(calls).toBe(1)
    expect(results.toSorted((left, right) => Number(left.replayed) - Number(right.replayed)))
      .toEqual([
        { value: 'new-result', replayed: false },
        { value: 'new-result', replayed: true },
      ])
  })

  it('allows only one fingerprint to win concurrent reuse of an expired key', async () => {
    const key = 'expired-concurrent-conflict-0001'
    await seedRecord(key, 'failed', 'old-fingerprint', true, null)
    let calls = 0
    const run = (fingerprint: string) => executor.execute(command(key, fingerprint), async () => {
      calls += 1
      await delay(120)
      return { result: fingerprint, auditEvents: [], outboxMessages: [] }
    })

    const results = await Promise.allSettled([run('new-fingerprint-a'), run('new-fingerprint-b')])
    expect(calls).toBe(1)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.any(IdempotencyConflictError) })
  })

  it('cleans expired terminal snapshots concurrently without deleting valid or processing rows', async () => {
    await pool.query(`
      INSERT INTO mbox.idempotency_records (
        tenant_id, store_id, operation_scope, idempotency_key, request_sha256,
        status, response_status, response_snapshot, locked_until, expires_at,
        created_at, updated_at
      )
      SELECT $1::uuid, $2::uuid, 'idempotency.cleanup',
        'cleanup-expired-' || lpad(value::text, 4, '0'), repeat('a', 64),
        CASE WHEN value % 2 = 0 THEN 'completed' ELSE 'failed' END,
        CASE WHEN value % 2 = 0 THEN 200 ELSE NULL END,
        CASE WHEN value % 2 = 0 THEN jsonb_build_object('result', 'sensitive-' || value) ELSE NULL END,
        NULL, clock_timestamp() - interval '1 hour',
        clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours'
      FROM generate_series(1, 75) value
    `, [tenantId, storeId])
    await seedRecord('cleanup-expired-processing', 'processing', 'processing', true, null)
    await seedRecord('cleanup-valid-completed', 'completed', 'valid-completed', false, 'keep-me')
    await seedRecord('cleanup-valid-failed', 'failed', 'valid-failed', false, null)

    const batches = await Promise.all([
      cleanup.runBatch(scope, { limit: 50 }),
      cleanup.runBatch(scope, { limit: 50 }),
    ])
    expect(batches.reduce((sum, batch) => sum + batch.deleted, 0)).toBe(75)

    const remaining = await pool.query<{ idempotency_key: string; status: string }>(`
      SELECT idempotency_key, status
      FROM mbox.idempotency_records
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      ORDER BY idempotency_key
    `, [tenantId, storeId])
    expect(remaining.rows).toEqual([
      { idempotency_key: 'cleanup-expired-processing', status: 'processing' },
      { idempotency_key: 'cleanup-valid-completed', status: 'completed' },
      { idempotency_key: 'cleanup-valid-failed', status: 'failed' },
    ])
    const leaked = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM mbox.idempotency_records
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND response_snapshot::text LIKE '%sensitive-%'
    `, [tenantId, storeId])
    expect(leaked.rows[0]?.count).toBe('0')
  })

  async function seedRecord(
    key: string,
    status: 'processing' | 'completed' | 'failed',
    fingerprint: string,
    expired: boolean,
    result: string | null,
    lockExpired = false,
  ): Promise<void> {
    await pool.query(`
      INSERT INTO mbox.idempotency_records (
        tenant_id, store_id, operation_scope, idempotency_key, request_sha256,
        status, response_status, response_snapshot, locked_until, expires_at,
        created_at, updated_at
      ) VALUES (
        $1::uuid, $2::uuid, 'idempotency.expiry', $3, $4,
        $5, $6, $7::jsonb,
        CASE WHEN $8::boolean THEN clock_timestamp() - interval '1 minute'
          ELSE clock_timestamp() + interval '5 minutes' END,
        CASE WHEN $9::boolean THEN clock_timestamp() - interval '1 hour'
          ELSE clock_timestamp() + interval '1 hour' END,
        clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours'
      )
    `, [
      tenantId,
      storeId,
      key,
      hashRequestFingerprint(fingerprint),
      status,
      status === 'completed' ? 200 : null,
      status === 'completed' ? JSON.stringify({ result }) : null,
      lockExpired,
      expired,
    ])
  }
})

function command(idempotencyKey: string, requestFingerprint: string) {
  return {
    scope,
    operationScope: 'idempotency.expiry',
    idempotencyKey,
    requestFingerprint,
    resultCodec: stringCodec,
  }
}

function asPool(pool: Pool): PostgresPool {
  return {
    connect: async () => pool.connect(),
    end: async () => pool.end(),
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
