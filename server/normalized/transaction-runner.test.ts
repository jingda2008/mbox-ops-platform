import { describe, expect, it, vi } from 'vitest'
import {
  NormalizedDatabaseTelemetry,
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type PostgresPoolClient,
} from './transaction-runner.js'

const scope = {
  tenantId: 'a1000000-0000-4000-8000-000000000001',
  storeId: 'a1000000-0000-4000-8000-000000000002',
}

describe('ScopedPostgresTransactionRunner conflict retry', () => {
  it('retries a serialization failure on a fresh transaction when explicitly enabled', async () => {
    const firstClient = fakeClient()
    const secondClient = fakeClient()
    const pool = fakePool([firstClient, secondClient])
    const runner = new ScopedPostgresTransactionRunner(pool)
    let calls = 0
    const result = await runner.run(scope, async () => {
      calls += 1
      if (calls === 1) throw postgresError('40001')
      return 'committed'
    }, { isolation: 'serializable', retryOnConflict: 1 })

    expect(result).toBe('committed')
    expect(calls).toBe(2)
    expect(pool.connect).toHaveBeenCalledTimes(2)
    expect(firstClient.queries).toContain('ROLLBACK')
    expect(firstClient.queries).not.toContain('COMMIT')
    expect(secondClient.queries).toContain('COMMIT')
    expect(firstClient.release).toHaveBeenCalledOnce()
    expect(secondClient.release).toHaveBeenCalledOnce()
  })

  it('does not retry ordinary errors or conflicts unless the caller opts in', async () => {
    const firstPool = fakePool([fakeClient()])
    await expect(new ScopedPostgresTransactionRunner(firstPool).run(
      scope,
      async () => { throw postgresError('40001') },
    )).rejects.toMatchObject({ code: '40001' })
    expect(firstPool.connect).toHaveBeenCalledTimes(1)

    const secondPool = fakePool([fakeClient(), fakeClient()])
    await expect(new ScopedPostgresTransactionRunner(secondPool).run(
      scope,
      async () => { throw postgresError('23505') },
      { retryOnConflict: 1 },
    )).rejects.toMatchObject({ code: '23505' })
    expect(secondPool.connect).toHaveBeenCalledTimes(1)
  })

  it('rejects an unsafe retry count before acquiring a database connection', async () => {
    const pool = fakePool([])
    await expect(new ScopedPostgresTransactionRunner(pool).run(
      scope,
      async () => 'unused',
      { retryOnConflict: 4 },
    )).rejects.toThrow('retryOnConflict')
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('records bounded pool, transaction and domain-query telemetry without exposing SQL text', async () => {
    const pool = Object.assign(fakePool([fakeClient()]), {
      totalCount: 3,
      idleCount: 2,
      waitingCount: 0,
    })
    const runner = new ScopedPostgresTransactionRunner(pool)
    await runner.run(scope, (transaction) => transaction.query('SELECT secret FROM private_table'))

    const snapshot = runner.telemetrySnapshot()
    expect(snapshot.pool).toMatchObject({
      acquisitions: 1,
      acquisitionFailures: 0,
      totalConnections: 3,
      idleConnections: 2,
      waitingClients: 0,
    })
    expect(snapshot.pool.acquisitionWaitMs.samples).toBe(1)
    expect(snapshot.transactions).toMatchObject({ completed: 1, failed: 0 })
    expect(snapshot.queries).toMatchObject({ completed: 1, failed: 0 })
    expect(JSON.stringify(snapshot)).not.toContain('private_table')
    expect(JSON.stringify(snapshot)).not.toContain('secret')
  })

  it('counts failed acquisitions and failed domain queries', async () => {
    const acquisitionTelemetry = new NormalizedDatabaseTelemetry()
    const failingPool: PostgresPool = {
      connect: async () => { throw new Error('database unavailable') },
      end: async () => undefined,
    }
    await expect(new ScopedPostgresTransactionRunner(failingPool, acquisitionTelemetry).run(
      scope,
      async () => 'unused',
    )).rejects.toThrow('database unavailable')
    expect(acquisitionTelemetry.snapshot().pool).toMatchObject({ acquisitions: 1, acquisitionFailures: 1 })

    const queryClient = fakeClient()
    queryClient.query.mockImplementation(async (text: string) => {
      queryClient.queries.push(text)
      if (text === 'SELECT broken') throw new Error('query failed')
      return { rows: [], rowCount: 0 }
    })
    const runner = new ScopedPostgresTransactionRunner(fakePool([queryClient]))
    await expect(runner.run(scope, (transaction) => transaction.query('SELECT broken'))).rejects.toThrow('query failed')
    expect(runner.telemetrySnapshot()).toMatchObject({
      transactions: { completed: 0, failed: 1 },
      queries: { completed: 0, failed: 1 },
    })
  })

  it('runs a scoped read in one database statement and records its query telemetry', async () => {
    const client = fakeClient()
    const runner = new ScopedPostgresTransactionRunner(fakePool([client]))
    await runner.singleScopedQuery(scope, `
      WITH request_scope AS MATERIALIZED (
        SELECT set_config('app.tenant_id', $1::text, true),
          set_config('app.store_id', $2::text, true)
      )
      SELECT 1 FROM request_scope
    `)

    expect(client.queries).toHaveLength(1)
    expect(client.queries[0]).not.toContain('BEGIN')
    expect(client.release).toHaveBeenCalledOnce()
    expect(runner.telemetrySnapshot()).toMatchObject({
      pool: { acquisitions: 1, acquisitionFailures: 0 },
      transactions: { completed: 0, failed: 0 },
      queries: { completed: 1, failed: 0 },
    })
    await expect(runner.singleScopedQuery(scope, 'SELECT 1')).rejects.toThrow('request-scope')
  })

  it('keeps only a fixed telemetry sample window while preserving lifetime counters', () => {
    const telemetry = new NormalizedDatabaseTelemetry()
    for (let index = 0; index < 10_001; index += 1) telemetry.recordQuery(index, true)

    const snapshot = telemetry.snapshot()
    expect(snapshot.queries.completed).toBe(10_001)
    expect(snapshot.queries.durationMs.samples).toBe(10_000)
    expect(snapshot.queries.durationMs.max).toBe(10_000)
  })
})

function fakePool(clients: ReturnType<typeof fakeClient>[]): PostgresPool & { connect: ReturnType<typeof vi.fn> } {
  return {
    connect: vi.fn(async () => {
      const client = clients.shift()
      if (!client) throw new Error('Unexpected database connection')
      return client
    }),
    end: vi.fn(async () => undefined),
  }
}

function fakeClient(): PostgresPoolClient & { queries: string[]; release: ReturnType<typeof vi.fn> } {
  const queries: string[] = []
  return {
    queries,
    query: vi.fn(async (text: string) => {
      queries.push(text)
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
}

function postgresError(code: string): Error & { code: string } {
  return Object.assign(new Error(`PostgreSQL ${code}`), { code })
}
