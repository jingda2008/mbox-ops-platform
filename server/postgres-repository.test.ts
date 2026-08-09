import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import {
  POSTGRES_RUNTIME_STATE_MIGRATION_SQL,
  PostgresIdempotencyConflictError,
  PostgresInvalidRevisionError,
  PostgresMutationNotIdleError,
  PostgresMutationQueueFullError,
  PostgresMutationQueueTimeoutError,
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
  updated_at?: string
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
  databaseNow = new Date(now)
  advisoryLeaseHeld = false
  failNextAdvisoryUnlock = false
  foregroundMutationGateHeld = false
  readonly releaseErrors: Array<Error | boolean | undefined> = []

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

    if (sql.startsWith('SELECT pg_try_advisory_lock')) {
      if (this.pool.advisoryLeaseHeld) return result([{ acquired: false }])
      this.pool.advisoryLeaseHeld = true
      return result([{ acquired: true }])
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock_shared')) {
      this.requireContext()
      return result([{ pg_advisory_xact_lock_shared: null }])
    }
    if (sql.startsWith('SELECT pg_try_advisory_xact_lock')) {
      this.requireContext()
      return result([{ acquired: !this.pool.foregroundMutationGateHeld }])
    }
    if (sql.startsWith('SELECT pg_advisory_unlock')) {
      if (this.pool.failNextAdvisoryUnlock) {
        this.pool.failNextAdvisoryUnlock = false
        throw new Error('advisory unlock failed')
      }
      this.pool.advisoryLeaseHeld = false
      return result([{ pg_advisory_unlock: true }])
    }

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
    if (sql.startsWith('SELECT revision, clock_timestamp() AS database_now')) {
      const transaction = this.requireContext()
      return transaction.runtime ? result([{ revision: transaction.runtime.revision, database_now: this.pool.databaseNow.toISOString() }]) : result([])
    }
    if (sql.startsWith("SELECT revision, state #>> '{store,id}' AS store_id")) {
      const transaction = this.requireContext()
      if (!transaction.runtime) return result([])
      const state = JSON.parse(transaction.runtime.state)
      return result([{
        revision: transaction.runtime.revision,
        store_id: state.store.id,
        business_date: state.store.businessDate,
        employees: state.employees,
      }])
    }
    if (sql.startsWith('SELECT revision FROM mbox.runtime_states')) {
      const transaction = this.requireContext()
      return transaction.runtime ? result([{ revision: transaction.runtime.revision }]) : result([])
    }
    if (sql.startsWith('SELECT revision, EXTRACT(EPOCH FROM (clock_timestamp() - updated_at))')) {
      const transaction = this.requireContext()
      if (!transaction.runtime) return result([])
      const updatedAt = Date.parse(
        transaction.runtime.updated_at
          ?? new Date(this.pool.databaseNow.getTime() - 1_000).toISOString(),
      )
      return result([{
        revision: transaction.runtime.revision,
        idle_ms: this.pool.databaseNow.getTime() - updatedAt,
      }])
    }
    if (sql.startsWith('SELECT EXTRACT(EPOCH FROM (clock_timestamp() - updated_at))')) {
      const transaction = this.requireContext()
      if (!transaction.runtime) return result([])
      const updatedAt = Date.parse(
        transaction.runtime.updated_at
          ?? new Date(this.pool.databaseNow.getTime() - 1_000).toISOString(),
      )
      return result([{ idle_ms: this.pool.databaseNow.getTime() - updatedAt }])
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
        updated_at: this.pool.databaseNow.toISOString(),
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

  release(error?: Error | boolean): void {
    this.pool.releases += 1
    this.pool.releaseErrors.push(error)
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

function createRepository(pool = new FakePool(), options: { maxPendingMutations?: number; mutationQueueTimeoutMs?: number } = {}) {
  return {
    pool,
    repository: new PostgresRepository({
      pool,
      tenantId,
      storeId,
      clock: () => new Date(now),
      seedState: createSeedState,
      ...options,
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

    const stateReadsBefore = pool.queries.filter(({ sql }) => sql.startsWith('SELECT revision, state, state_sha256')).length
    const first = await repository.read()
    first.store.name = 'changed outside the repository'
    const second = await repository.read()

    expect(second.revision).toBe(1)
    expect(second.store.name).not.toBe(first.store.name)
    expect(pool.queries.filter(({ sql }) => sql.startsWith('SELECT revision, state, state_sha256'))).toHaveLength(stateReadsBefore + 1)
    expect(pool.queries.filter(({ sql }) => sql.startsWith('INSERT INTO mbox.runtime_states'))).toHaveLength(1)
    const transactions = pool.queries.filter(({ sql }) => sql.startsWith('BEGIN ISOLATION LEVEL'))
    const contexts = pool.queries.filter(({ sql }) => sql.startsWith("SELECT set_config('app.tenant_id'"))
    expect(contexts).toHaveLength(transactions.length)
  })

  it('coalesces concurrent full-state cache refreshes', async () => {
    const { pool, repository } = createRepository()
    await repository.init()
    const stateReadsBefore = pool.queries.filter(({ sql }) => sql.startsWith('SELECT revision, state, state_sha256')).length
    const revisionReadsBefore = pool.queries.filter(({ sql }) => sql.startsWith('SELECT revision FROM mbox.runtime_states')).length

    const reads = await Promise.all(Array.from({ length: 20 }, () => repository.read()))
    reads[0]!.store.name = 'detached concurrent result'

    expect(reads.every((state) => state.revision === 1)).toBe(true)
    expect(reads[1]!.store.name).not.toBe(reads[0]!.store.name)
    expect(pool.queries.filter(({ sql }) => sql.startsWith('SELECT revision, state, state_sha256'))).toHaveLength(stateReadsBefore + 1)
    expect(pool.queries.filter(({ sql }) => sql.startsWith('SELECT revision FROM mbox.runtime_states'))).toHaveLength(revisionReadsBefore + 1)
  })

  it('reads the staff authorization directory without loading the full aggregate', async () => {
    const { pool, repository } = createRepository()
    await repository.init()
    const fullReadsBefore = pool.queries.filter(({ sql }) => sql.startsWith('SELECT revision, state, state_sha256')).length

    const directory = await repository.readStaffDirectory()

    expect(directory.storeId).toBe('mbox-lujiazui')
    expect(directory.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(directory.employees).toContainEqual({ id: 'emp-chen', roleId: 'manager', status: 'active' })
    expect(pool.queries.filter(({ sql }) => sql.startsWith('SELECT revision, state, state_sha256'))).toHaveLength(fullReadsBefore)
    expect(pool.queries.some(({ sql }) => sql.includes("state #>> '{store,id}'"))).toBe(true)
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
    expect(pool.queries.some(({ sql }) => (
      sql.startsWith('SELECT revision FROM mbox.runtime_states') && sql.endsWith('FOR UPDATE')
    ))).toBe(true)

    pool.failNextCompareAndSwap = true
    await expect(repository.mutate((state) => {
      state.store.name = 'lost update'
      state.revision += 1
    })).rejects.toBeInstanceOf(PostgresOptimisticConcurrencyError)
    expect((await repository.read()).store.name).toBe('Production store')
    expect(pool.queries.some(({ sql }) => sql === 'ROLLBACK')).toBe(true)
  })

  it('serves the committed state from memory without an immediate database reread', async () => {
    const { pool, repository } = createRepository()
    await repository.init()
    await repository.read()

    await repository.mutate((state) => {
      state.store.name = 'Committed cache state'
      state.revision += 1
    })
    const fullReadsAfterCommit = pool.queries.filter(({ sql }) => (
      sql.startsWith('SELECT revision, state, state_sha256 FROM mbox.runtime_states')
    )).length
    const revisionReadsAfterCommit = pool.queries.filter(({ sql }) => (
      sql.startsWith('SELECT revision FROM mbox.runtime_states')
    )).length

    const state = await repository.read()

    expect(state.store.name).toBe('Committed cache state')
    expect(state.revision).toBe(2)
    expect(pool.queries.filter(({ sql }) => (
      sql.startsWith('SELECT revision, state, state_sha256 FROM mbox.runtime_states')
    ))).toHaveLength(fullReadsAfterCommit)
    expect(pool.queries.filter(({ sql }) => (
      sql.startsWith('SELECT revision FROM mbox.runtime_states')
    ))).toHaveLength(revisionReadsAfterCommit)
  })

  it('serializes concurrent mutations and keeps aggregate state reads out of the hot write path', async () => {
    const { pool, repository } = createRepository()
    await repository.init()
    await repository.read()
    const fullReadsBefore = pool.queries.filter(({ sql }) => (
      sql.startsWith('SELECT revision, state, state_sha256 FROM mbox.runtime_states')
    )).length
    let active = 0
    let maximumActive = 0
    let releaseFirst!: () => void
    let firstEntered!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const entered = new Promise<void>((resolve) => { firstEntered = resolve })
    const mutation = async (state: ReturnType<typeof createSeedState>, block = false) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (block) {
        firstEntered()
        await firstBlocked
      }
      state.revision += 1
      active -= 1
      return state.revision
    }

    const first = repository.mutate((state) => mutation(state, true))
    await entered
    const second = repository.mutate((state) => mutation(state))
    expect((await repository.healthCheck()).mutationQueue).toMatchObject({ pending: 2, active: true })
    releaseFirst()

    await expect(Promise.all([first, second])).resolves.toEqual([2, 3])
    expect(maximumActive).toBe(1)
    const completedQueue = (await repository.healthCheck()).mutationQueue
    expect(completedQueue).toMatchObject({
      pending: 0,
      active: false,
      serializedStateBytes: expect.any(Number),
      initialSerializedStateBytes: expect.any(Number),
      maxSerializedStateBytes: expect.any(Number),
      waitSamples: expect.any(Number),
      waitP95Ms: expect.any(Number),
      waitP99Ms: expect.any(Number),
      serviceSamples: expect.any(Number),
      serviceP95Ms: expect.any(Number),
      serviceP99Ms: expect.any(Number),
    })
    expect(completedQueue.serializedStateBytes).toBeGreaterThan(0)
    expect(completedQueue.maxSerializedStateBytes).toBeGreaterThanOrEqual(completedQueue.serializedStateBytes)
    expect(completedQueue.waitSamples).toBeGreaterThanOrEqual(2)
    expect(completedQueue.serviceSamples).toBeGreaterThanOrEqual(2)
    expect(completedQueue.serviceP95Ms).toBeGreaterThan(0)
    expect(pool.queries.filter(({ sql }) => (
      sql.startsWith('SELECT revision, state, state_sha256 FROM mbox.runtime_states')
    ))).toHaveLength(fullReadsBefore)
  })

  it('starts a fresh performance window from the current authoritative state', async () => {
    const { repository } = createRepository()
    await repository.init()
    await repository.mutate((state) => {
      state.store.name = 'Measured baseline'
      state.revision += 1
    })
    expect((await repository.healthCheck()).mutationQueue.serviceSamples).toBeGreaterThan(0)

    await repository.resetPerformanceMetrics()

    const reset = (await repository.healthCheck()).mutationQueue
    expect(reset).toMatchObject({
      highWatermark: 0,
      rejectedTotal: 0,
      timeoutTotal: 0,
      waitSamples: 0,
      serviceSamples: 0,
    })
    expect(reset.initialSerializedStateBytes).toBeGreaterThan(0)
    expect(reset.serializedStateBytes).toBe(reset.initialSerializedStateBytes)
    expect(reset.maxSerializedStateBytes).toBe(reset.initialSerializedStateBytes)
  })

  it('runs singleton background work under a session advisory lease', async () => {
    const { pool, repository } = createRepository()
    await repository.init()
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })

    const first = repository.runWithDistributedLease('operational-scheduler', async () => {
      entered()
      await blocked
      return 7
    })
    await started
    await expect(repository.runWithDistributedLease('operational-scheduler', async () => 8))
      .resolves.toEqual({ acquired: false })
    release()
    await expect(first).resolves.toEqual({ acquired: true, value: 7 })
    expect(pool.advisoryLeaseHeld).toBe(false)
    expect(pool.queries.filter(({ sql }) => sql.startsWith('SELECT pg_try_advisory_lock'))).toHaveLength(2)
    expect(pool.queries.filter(({ sql }) => sql.startsWith('SELECT pg_advisory_unlock'))).toHaveLength(1)
  })

  it('destroys a leased connection when advisory unlock fails', async () => {
    const { pool, repository } = createRepository()
    await repository.init()
    pool.failNextAdvisoryUnlock = true

    await expect(repository.runWithDistributedLease('operational-scheduler', async () => 7))
      .rejects.toThrow('advisory unlock failed')
    expect(pool.releaseErrors.at(-1)).toBeInstanceOf(Error)
  })

  it('preserves the business failure when both the operation and advisory unlock fail', async () => {
    const { pool, repository } = createRepository()
    await repository.init()
    pool.failNextAdvisoryUnlock = true

    await expect(repository.runWithDistributedLease('operational-scheduler', async () => {
      throw new Error('scheduled operation failed')
    })).rejects.toThrow('scheduled operation failed')
    expect(pool.releaseErrors.at(-1)).toMatchObject({ message: 'advisory unlock failed' })
  })

  it('lets background work wait for a quiet mutation window without blocking forever', async () => {
    const { repository, pool } = createRepository()
    await repository.init()
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const mutation = repository.mutate(async (state) => {
      entered()
      await blocked
      state.revision += 1
    })
    await started

    await expect(repository.waitForMutationIdle(1, 5)).resolves.toBe(false)
    release()
    await mutation
    pool.databaseNow = new Date(pool.databaseNow.getTime() + 2)
    await expect(repository.waitForMutationIdle(1, 100)).resolves.toBe(true)
  })

  it('does not report a global idle window when another instance just committed', async () => {
    const pool = new FakePool()
    const { repository } = createRepository(pool)
    await repository.init()
    pool.runtime = { ...pool.runtime!, updated_at: pool.databaseNow.toISOString() }

    await expect(repository.waitForMutationIdle(1, 0)).resolves.toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 2))
    pool.databaseNow = new Date(pool.databaseNow.getTime() + 2)
    await expect(repository.waitForMutationIdle(1, 0)).resolves.toBe(true)
  })

  it('skips a background mutation when a foreground instance holds the mutation gate', async () => {
    const { pool, repository } = createRepository()
    await repository.init()
    pool.foregroundMutationGateHeld = true

    await expect(repository.mutate((state) => {
      state.revision += 1
    }, { metricLabel: 'scheduler', minimumGlobalIdleMs: 750 }))
      .rejects.toBeInstanceOf(PostgresMutationNotIdleError)
    expect((await repository.read()).revision).toBe(1)
  })

  it('checks the committed quiet window while holding the exclusive mutation gate', async () => {
    const { pool, repository } = createRepository()
    await repository.init()
    pool.runtime = { ...pool.runtime!, updated_at: pool.databaseNow.toISOString() }

    await expect(repository.mutate((state) => {
      state.revision += 1
    }, { metricLabel: 'scheduler', minimumGlobalIdleMs: 750 }))
      .rejects.toBeInstanceOf(PostgresMutationNotIdleError)

    pool.databaseNow = new Date(pool.databaseNow.getTime() + 751)
    await expect(repository.mutate((state) => {
      state.revision += 1
    }, { metricLabel: 'scheduler', minimumGlobalIdleMs: 750 })).resolves.toBeUndefined()
    expect((await repository.read()).revision).toBe(2)
  })

  it('rejects excess or stale queued mutations before they consume database connections', async () => {
    const full = createRepository(new FakePool(), { maxPendingMutations: 2 })
    await full.repository.init()
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const first = full.repository.mutate(async (state) => {
      entered()
      await blocked
      state.revision += 1
    })
    await started
    const second = full.repository.mutate((state) => { state.revision += 1 })
    await expect(full.repository.mutate((state) => { state.revision += 1 }))
      .rejects.toBeInstanceOf(PostgresMutationQueueFullError)
    expect((await full.repository.healthCheck()).mutationQueue).toMatchObject({ rejectedTotal: 1, timeoutTotal: 0, maxPending: 2 })
    release()
    await Promise.all([first, second])

    const timed = createRepository(new FakePool(), { mutationQueueTimeoutMs: 1 })
    await timed.repository.init()
    let releaseTimed!: () => void
    let enteredTimed!: () => void
    const timedBlock = new Promise<void>((resolve) => { releaseTimed = resolve })
    const timedStarted = new Promise<void>((resolve) => { enteredTimed = resolve })
    const timedFirst = timed.repository.mutate(async (state) => {
      enteredTimed()
      await timedBlock
      state.revision += 1
    })
    await timedStarted
    const timedSecond = timed.repository.mutate((state) => { state.revision += 1 })
    await expect(timedSecond).rejects.toBeInstanceOf(PostgresMutationQueueTimeoutError)
    expect((await timed.repository.healthCheck()).mutationQueue).toMatchObject({ pending: 1, active: true, rejectedTotal: 0, timeoutTotal: 1 })
    releaseTimed()
    await timedFirst
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
      databaseClockSkewMs: expect.any(Number),
      pool: { total: 4, idle: 3, waiting: 0 },
    })
  })

  it('fails readiness when the application and PostgreSQL clocks drift beyond the safety threshold', async () => {
    const { pool, repository } = createRepository()
    pool.databaseNow = new Date(now.getTime() + 6_000)
    await repository.init()

    await expect(repository.healthCheck()).resolves.toMatchObject({
      ready: false,
      healthy: false,
      databaseClockSkewMs: 6_000,
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
