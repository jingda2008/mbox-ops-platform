import { describe, expect, it, vi } from 'vitest'
import {
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
