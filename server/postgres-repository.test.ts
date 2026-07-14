import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import {
  POSTGRES_RUNTIME_STATE_MIGRATION_SQL,
  PostgresIdempotencyConflictError,
  PostgresInvalidRevisionError,
  PostgresOptimisticConcurrencyError,
  PostgresRepository,
  PostgresRepositoryClosedError,
  PostgresRuntimeStateNotInitializedError,
  PostgresSchemaError,
  PostgresSeedDisabledError,
  type PostgresPool,
  type PostgresPoolClient,
  type PostgresQueryResult,
} from './postgres-repository.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const now = new Date('2026-07-14T12:00:00.000Z')

interface FakeRuntimeRow {
  revision: number
  state: string
  state_sha256: string
}

interface FakeIdempotencyRow {
  request_sha256: string
  status: 'processing' | 'completed' | 'failed'
  response_body: unknown
  locked_until: string | null
  expires_at: string
}

class FakePool implements PostgresPool {
  runtime: FakeRuntimeRow | null = null
  idempotency = new Map<string, FakeIdempotencyRow>()
  readonly queries: Array<{ sql: string; values: unknown[] }> = []
  schemaExists = true
  failNextCompareAndSwap = false
  ended = false
  releases = 0
  totalCount = 4
  idleCount = 3
  waitingCount = 0

  async connect(): Promise<PostgresPoolClient> {
    if (this.ended) throw new Error('pool ended')
    return new FakeClient(this)
  }

  async end(): Promise<void> {
    this.ended = true
  }
}

class FakeClient implements PostgresPoolClient {
  private transaction: {
    readOnly: boolean
    runtime: FakeRuntimeRow | null
    idempotency: Map<string, FakeIdempotencyRow>
    runtimeDirty: boolean
    idempotencyDirty: boolean
    contextSet: boolean
  } | null = null

  constructor(private readonly pool: FakePool) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    const sql = normalizeSql(text)
    this.pool.queries.push({ sql, values: structuredClone(values) })

    if (sql.startsWith("SELECT n.nspname || '.' || c.relname AS table_name")) {
      return this.pool.schemaExists ? result([{ table_name: 'mbox.runtime_states' }]) : result([])
    }
    if (sql.startsWith('BEGIN ISOLATION LEVEL')) {
      this.transaction = {
        readOnly: sql.endsWith('READ ONLY'),
        runtime: structuredClone(this.pool.runtime),
        idempotency: cloneMap(this.pool.idempotency),
        runtimeDirty: false,
        idempotencyDirty: false,
        contextSet: false,
      }
      return result([])
    }
    if (sql.startsWith("SELECT set_config('app.tenant_id'")) {
      const transaction = this.requireTransaction()
      expect(values).toEqual([tenantId, storeId])
      transaction.contextSet = true
      return result([{ tenant_id: tenantId, store_id: storeId }])
    }
    if (sql.startsWith("SELECT set_config('statement_timeout'")) {
      this.requireContext()
      return result([{ statement_timeout: values[0] }])
    }
    if (sql.startsWith('INSERT INTO mbox.runtime_states')) {
      const transaction = this.requireWritableContext()
      if (transaction.runtime) return result([], 0)
      transaction.runtime = {
        revision: Number(values[2]),
        state: String(values[3]),
        state_sha256: String(values[4]),
      }
      transaction.runtimeDirty = true
      return result([], 1)
    }
    if (sql.startsWith('SELECT revision, state, state_sha256 FROM mbox.runtime_states')) {
      const transaction = this.requireContext()
      return transaction.runtime ? result([structuredClone(transaction.runtime)]) : result([])
    }
    if (sql.startsWith('SELECT revision FROM mbox.runtime_states')) {
      const transaction = this.requireContext()
      return transaction.runtime ? result([{ revision: transaction.runtime.revision }]) : result([])
    }
    if (sql.startsWith('UPDATE mbox.runtime_states SET revision')) {
      const transaction = this.requireWritableContext()
      if (this.pool.failNextCompareAndSwap) {
        this.pool.failNextCompareAndSwap = false
        return result([], 0)
      }
      if (!transaction.runtime || transaction.runtime.revision !== Number(values[5])) return result([], 0)
      transaction.runtime = {
        revision: Number(values[2]),
        state: String(values[3]),
        state_sha256: String(values[4]),
      }
      transaction.runtimeDirty = true
      return result([{ revision: transaction.runtime.revision }], 1)
    }
    if (sql.startsWith('INSERT INTO mbox.idempotency_records')) {
      const transaction = this.requireWritableContext()
      const key = idempotencyMapKey(values)
      if (transaction.idempotency.has(key)) return result([], 0)
      transaction.idempotency.set(key, {
        request_sha256: String(values[4]),
        status: 'processing',
        response_body: null,
        locked_until: String(values[5]),
        expires_at: String(values[6]),
      })
      transaction.idempotencyDirty = true
      return result([], 1)
    }
    if (sql.startsWith('SELECT request_sha256, status, response_body, locked_until')) {
      const transaction = this.requireWritableContext()
      const record = transaction.idempotency.get(idempotencyMapKey(values))
      return record ? result([structuredClone(record)]) : result([])
    }
    if (sql.startsWith("UPDATE mbox.idempotency_records SET status = 'processing'")) {
      const transaction = this.requireWritableContext()
      const record = transaction.idempotency.get(idempotencyMapKey(values))
      if (!record) return result([], 0)
      Object.assign(record, {
        status: 'processing',
        response_body: null,
        locked_until: String(values[4]),
        expires_at: String(values[5]),
      })
      transaction.idempotencyDirty = true
      return result([], 1)
    }
    if (sql.startsWith("UPDATE mbox.idempotency_records SET status = 'completed'")) {
      const transaction = this.requireWritableContext()
      const record = transaction.idempotency.get(idempotencyMapKey(values))
      if (!record) return result([], 0)
      Object.assign(record, {
        status: 'completed',
        response_body: JSON.parse(String(values[4])),
        locked_until: null,
      })
      transaction.idempotencyDirty = true
      return result([], 1)
    }
    if (sql === 'COMMIT') {
      const transaction = this.requireContext()
      if (transaction.runtimeDirty) this.pool.runtime = structuredClone(transaction.runtime)
      if (transaction.idempotencyDirty) this.pool.idempotency = cloneMap(transaction.idempotency)
      this.transaction = null
      return result([])
    }
    if (sql === 'ROLLBACK') {
      this.requireTransaction()
      this.transaction = null
      return result([])
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  }

  release(): void {
    this.pool.releases += 1
  }

  private requireTransaction() {
    if (!this.transaction) throw new Error('query requires a transaction')
    return this.transaction
  }

  private requireContext() {
    const transaction = this.requireTransaction()
    if (!transaction.contextSet) throw new Error('RLS context was not set')
    return transaction
  }

  private requireWritableContext() {
    const transaction = this.requireContext()
    if (transaction.readOnly) throw new Error('write attempted in a read-only transaction')
    return transaction
  }
}

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): PostgresQueryResult<any> {
  return { rows, rowCount }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function cloneMap(map: Map<string, FakeIdempotencyRow>): Map<string, FakeIdempotencyRow> {
  return new Map([...map].map(([key, value]) => [key, structuredClone(value)]))
}

function idempotencyMapKey(values: unknown[]): string {
  return `${String(values[0])}:${String(values[1])}:${String(values[2])}:${String(values[3])}`
}

function createRepository(pool = new FakePool()) {
  return {
    pool,
    repository: new PostgresRepository({
      pool,
      tenantId,
      storeId,
      clock: () => new Date(now),
      seedState: createSeedState,
    }),
  }
}

describe('PostgresRepository', () => {
  it('requires the compatibility table instead of creating production schema at startup', async () => {
    const { pool, repository } = createRepository()
    pool.schemaExists = false

    await expect(repository.init()).rejects.toBeInstanceOf(PostgresSchemaError)
    expect(pool.queries.some(({ sql }) => sql.startsWith('CREATE TABLE'))).toBe(false)
    expect(POSTGRES_RUNTIME_STATE_MIGRATION_SQL).toContain('FORCE ROW LEVEL SECURITY')
  })

  it('does not write demo state unless a seed factory is explicitly configured', async () => {
    const pool = new FakePool()
    const repository = new PostgresRepository({ pool, tenantId, storeId, clock: () => new Date(now) })

    await expect(repository.init()).rejects.toBeInstanceOf(PostgresRuntimeStateNotInitializedError)
    expect(pool.runtime).toBeNull()
    expect(pool.queries.some(({ sql }) => sql.startsWith('INSERT INTO mbox.runtime_states'))).toBe(false)
    await expect(repository.reset()).rejects.toBeInstanceOf(PostgresSeedDisabledError)
  })

  it('seeds once, applies transaction-local RLS context, and returns detached reads', async () => {
    const { pool, repository } = createRepository()
    await repository.init()
    await repository.init()

    const first = await repository.read()
    first.store.name = 'changed outside the repository'
    const second = await repository.read()

    expect(second.revision).toBe(1)
    expect(second.store.name).not.toBe(first.store.name)
    expect(pool.queries.filter(({ sql }) => sql.startsWith('INSERT INTO mbox.runtime_states'))).toHaveLength(1)
    const transactions = pool.queries.filter(({ sql }) => sql.startsWith('BEGIN ISOLATION LEVEL'))
    const contexts = pool.queries.filter(({ sql }) => sql.startsWith("SELECT set_config('app.tenant_id'"))
    expect(contexts).toHaveLength(transactions.length)
  })

  it('commits one-step revisions and rejects stale compare-and-swap writes without partial state', async () => {
    const { pool, repository } = createRepository()
    await repository.init()

    const result = await repository.mutate((state) => {
      state.store.name = 'Production store'
      state.revision += 1
      return state.revision
    })
    expect(result).toBe(2)
    expect((await repository.read()).store.name).toBe('Production store')

    pool.failNextCompareAndSwap = true
    await expect(repository.mutate((state) => {
      state.store.name = 'lost update'
      state.revision += 1
    })).rejects.toBeInstanceOf(PostgresOptimisticConcurrencyError)
    expect((await repository.read()).store.name).toBe('Production store')
    expect(pool.queries.some(({ sql }) => sql === 'ROLLBACK')).toBe(true)
  })

  it('accepts multi-event revision advances and rejects non-advancing revisions', async () => {
    const { repository } = createRepository()
    await repository.init()

    await repository.mutate((state) => {
      state.revision += 2
    })
    expect((await repository.read()).revision).toBe(3)
    await expect(repository.mutate((state) => {
      state.store.name = 'changed without revision'
    })).resolves.toBeUndefined()
    await expect(repository.mutate((state) => {
      state.revision -= 1
    })).rejects.toBeInstanceOf(PostgresInvalidRevisionError)
    await expect(repository.mutate((state) => {
      state.store.name = 'never committed'
      throw new Error('domain failure')
    })).rejects.toThrow('domain failure')
    expect((await repository.read()).revision).toBe(3)
    expect((await repository.read()).store.name).not.toBe('never committed')
  })

  it('rejects state values that cannot be represented faithfully as JSON', async () => {
    const { repository } = createRepository()
    await repository.init()

    await expect(repository.mutate((state) => {
      state.revision += 1
      state.auditEntries.push({
        id: 'audit-invalid-json',
        actorId: 'system',
        action: 'test',
        objectType: 'test',
        objectId: 'test',
        occurredAt: now.toISOString(),
        details: { invalid: Number.NaN },
      })
    })).rejects.toThrow('not JSON serializable')
    expect((await repository.read()).revision).toBe(1)
  })

  it('replays completed idempotent mutations and rejects key reuse with another fingerprint', async () => {
    const { repository } = createRepository()
    await repository.init()
    let calls = 0
    const options = {
      idempotency: {
        operationScope: 'runtime.task.create',
        idempotencyKey: 'request-0001',
        requestFingerprint: '{"table":"A01"}',
      },
    }
    const mutation = (state: ReturnType<typeof createSeedState>) => {
      calls += 1
      state.revision += 1
      return { revision: state.revision, accepted: true }
    }

    const first = await repository.mutate(mutation, options)
    const replay = await repository.mutate(mutation, options)
    expect(replay).toEqual(first)
    expect(calls).toBe(1)
    expect((await repository.read()).revision).toBe(2)

    await expect(repository.mutate(mutation, {
      idempotency: { ...options.idempotency, requestFingerprint: '{"table":"B02"}' },
    })).rejects.toBeInstanceOf(PostgresIdempotencyConflictError)
    expect((await repository.read()).revision).toBe(2)
  })

  it('reports database and pool health for the tenant state', async () => {
    const { repository } = createRepository()
    await repository.init()

    await expect(repository.healthCheck()).resolves.toMatchObject({
      ready: true,
      repository: 'postgres',
      healthy: true,
      revision: 1,
      pool: { total: 4, idle: 3, waiting: 0 },
    })
  })

  it('waits for in-flight work before ending the pool and rejects new work while closing', async () => {
    const { pool, repository } = createRepository()
    await repository.init()
    let releaseMutation!: () => void
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const blocked = new Promise<void>((resolve) => { releaseMutation = resolve })
    const mutation = repository.mutate(async (state) => {
      markEntered()
      await blocked
      state.revision += 1
      return state.revision
    })
    await entered

    const closing = repository.close()
    await expect(repository.read()).rejects.toBeInstanceOf(PostgresRepositoryClosedError)
    expect(pool.ended).toBe(false)
    releaseMutation()
    await expect(mutation).resolves.toBe(2)
    await closing
    expect(pool.ended).toBe(true)
  })
})
