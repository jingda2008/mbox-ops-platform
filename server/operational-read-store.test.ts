import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import {
  hydrateRuntimeStateFromOperationalTables,
  OperationalReadRevisionError,
  PostgresOperationalReadStore,
  resolveOperationalRuntimeState,
  type OperationalReadSnapshot,
} from './operational-read-store.js'
import {
  APP_CANONICAL_STATE_CHECKSUM_ALGORITHM,
  runtimeStateValueChecksum,
  type PostgresPool,
  type PostgresPoolClient,
  type PostgresQueryResult,
} from './postgres-repository.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'

function snapshotForState(state: ReturnType<typeof createSeedState>): OperationalReadSnapshot {
  return {
    revision: state.revision,
    tables: structuredClone(state.tables),
    tableSessions: structuredClone(state.songState.tableSessions),
    serviceTasks: structuredClone(state.tasks),
    orders: structuredClone(state.orderDomain.orders),
    kdsTasks: structuredClone(state.orderDomain.kdsTasks),
    paymentIntents: structuredClone(state.paymentDomain.paymentIntents),
    inventoryBalances: structuredClone(state.inventoryDomain?.balances ?? []),
  }
}

function result<Row extends Record<string, unknown>>(rows: Row[]): PostgresQueryResult<Row> {
  return { rows, rowCount: rows.length }
}

class OperationalReadPool implements PostgresPool {
  readonly queries: string[] = []
  releases = 0

  constructor(private readonly snapshot: OperationalReadSnapshot) {}

  async connect(): Promise<PostgresPoolClient> {
    return {
      query: async <Row extends Record<string, unknown>>(text: string, values: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim()
        this.queries.push(sql)
        if (sql.startsWith('BEGIN ')) return result([]) as PostgresQueryResult<Row>
        if (sql.startsWith("SELECT set_config('app.tenant_id'")) {
          expect(values).toEqual([tenantId, storeId])
          return result([{ tenant_id: tenantId, store_id: storeId }]) as PostgresQueryResult<Row>
        }
        if (sql.startsWith('SELECT checkpoint.runtime_revision')) {
          expect(values.slice(0, 2)).toEqual([tenantId, storeId])
          expect(['2026-07-21', null]).toContain(values[2])
          const aggregateState = stateForSnapshot(this.snapshot)
          const checksum = runtimeStateValueChecksum(aggregateState)
          return result([{
            runtime_revision: this.snapshot.revision,
            aggregate_state: aggregateState,
            state_sha256: checksum,
            state_checksum_algorithm: APP_CANONICAL_STATE_CHECKSUM_ALGORITHM,
            checkpoint_state_sha256: checksum,
            checkpoint_checksum_algorithm: APP_CANONICAL_STATE_CHECKSUM_ALGORITHM,
            tables: this.snapshot.tables,
            table_sessions: this.snapshot.tableSessions,
            service_tasks: this.snapshot.serviceTasks,
            orders: this.snapshot.orders,
            kds_tasks: this.snapshot.kdsTasks,
            payment_intents: this.snapshot.paymentIntents,
            inventory_balances: this.snapshot.inventoryBalances,
          }]) as PostgresQueryResult<Row>
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') return result([]) as PostgresQueryResult<Row>
        throw new Error(`Unexpected SQL: ${sql}`)
      },
      release: () => { this.releases += 1 },
    }
  }

  async end() {}
}

function stateForSnapshot(snapshot: OperationalReadSnapshot) {
  const state = createSeedState(new Date('2026-07-21T12:00:00.000Z'))
  state.revision = snapshot.revision
  state.tables = structuredClone(snapshot.tables)
  state.songState.tableSessions = structuredClone(snapshot.tableSessions)
  state.tasks = structuredClone(snapshot.serviceTasks)
  state.orderDomain.orders = structuredClone(snapshot.orders)
  state.orderDomain.kdsTasks = structuredClone(snapshot.kdsTasks)
  state.paymentDomain.paymentIntents = structuredClone(snapshot.paymentIntents)
  if (state.inventoryDomain) state.inventoryDomain.balances = structuredClone(snapshot.inventoryBalances)
  return state
}

describe('normalized operational read store', () => {
  it('reads all high-frequency entities with one indexed snapshot statement', async () => {
    const state = createSeedState(new Date('2026-07-21T12:00:00.000Z'))
    const pool = new OperationalReadPool(snapshotForState(state))
    const store = new PostgresOperationalReadStore(pool, { tenantId, storeId })

    const snapshot = await store.read(state.revision, '2026-07-21')

    expect(snapshot).toEqual(snapshotForState(state))
    expect(pool.queries.filter((query) => query.startsWith('SELECT checkpoint.runtime_revision'))).toHaveLength(1)
    expect(pool.queries.find((query) => query.startsWith('SELECT checkpoint.runtime_revision'))).not.toContain(
      'snapshot_revision = checkpoint.runtime_revision',
    )
    expect(pool.releases).toBe(1)
  })

  it('reads the aggregate and normalized entities from one coherent latest snapshot', async () => {
    const state = createSeedState(new Date('2026-07-21T12:00:00.000Z'))
    const pool = new OperationalReadPool(snapshotForState(state))
    const store = new PostgresOperationalReadStore(pool, { tenantId, storeId })

    const result = await store.readLatestRuntimeState()

    expect(result.source).toBe('normalized_tables')
    expect(result.revisionMismatches).toBe(0)
    expect(result.state.revision).toBe(state.revision)
    expect(result.state.tasks).toEqual(state.tasks)
    expect(pool.queries.filter((query) => query.startsWith('SELECT checkpoint.runtime_revision'))).toHaveLength(1)
  })

  it('keeps unchanged rows visible when another entity advances the checkpoint revision', async () => {
    const state = createSeedState(new Date('2026-07-21T12:00:00.000Z'))
    const pool = new OperationalReadPool(snapshotForState(state))
    const store = new PostgresOperationalReadStore(pool, { tenantId, storeId })

    const snapshot = await store.read(state.revision, '2026-07-21')

    expect(snapshot.tables).toHaveLength(state.tables.length)
    expect(pool.queries.find((query) => query.startsWith('SELECT checkpoint.runtime_revision'))).toContain(
      'runtime.revision = checkpoint.runtime_revision',
    )
  })

  it('rejects a mixed aggregate and table revision instead of serving stale entities', async () => {
    const state = createSeedState(new Date('2026-07-21T12:00:00.000Z'))
    const pool = new OperationalReadPool({ ...snapshotForState(state), revision: state.revision + 1 })
    const store = new PostgresOperationalReadStore(pool, { tenantId, storeId })

    await expect(store.read(state.revision, '2026-07-21')).rejects.toBeInstanceOf(OperationalReadRevisionError)
    expect(pool.queries).toContain('ROLLBACK')
  })

  it('hydrates only high-frequency domains and keeps configuration in the compatibility aggregate', () => {
    const aggregate = createSeedState(new Date('2026-07-21T12:00:00.000Z'))
    const snapshot = snapshotForState(aggregate)
    snapshot.tables = snapshot.tables.map((table) => table.id === 'table-l01'
      ? { ...table, guestCount: 9 }
      : table)
    snapshot.serviceTasks = snapshot.serviceTasks.slice(0, 1)

    const hydrated = hydrateRuntimeStateFromOperationalTables(aggregate, snapshot)

    expect(hydrated.tables.find((table) => table.id === 'table-l01')?.guestCount).toBe(9)
    expect(hydrated.tasks).toEqual(snapshot.serviceTasks)
    expect(hydrated.config).toEqual(aggregate.config)
    expect(aggregate.tables.find((table) => table.id === 'table-l01')?.guestCount).not.toBe(9)
  })

  it('recovers when a concurrent heartbeat advances the operational revision', async () => {
    const initial = createSeedState(new Date('2026-07-21T12:00:00.000Z'))
    const fresh = structuredClone(initial)
    fresh.revision += 1
    const readSnapshot = async (revision: number) => {
      if (revision === initial.revision) {
        throw new OperationalReadRevisionError(initial.revision, fresh.revision)
      }
      return snapshotForState(fresh)
    }

    const result = await resolveOperationalRuntimeState({
      initialState: initial,
      readFresh: async () => structuredClone(fresh),
      readSnapshot,
    })

    expect(result.source).toBe('normalized_tables')
    expect(result.state.revision).toBe(fresh.revision)
    expect(result.revisionMismatches).toBe(1)
  })

  it('serves the freshest aggregate instead of returning 503 during sustained revision churn', async () => {
    const initial = createSeedState(new Date('2026-07-21T12:00:00.000Z'))
    let latest = structuredClone(initial)
    let snapshotCalls = 0

    const result = await resolveOperationalRuntimeState({
      initialState: initial,
      readFresh: async () => {
        latest = { ...structuredClone(latest), revision: latest.revision + 1 }
        return latest
      },
      readSnapshot: async (revision) => {
        snapshotCalls += 1
        throw new OperationalReadRevisionError(revision, revision + 1)
      },
      maxAttempts: 3,
    })

    expect(snapshotCalls).toBe(3)
    expect(result.source).toBe('aggregate_compatibility')
    expect(result.state.revision).toBe(initial.revision + 3)
    expect(result.revisionMismatches).toBe(3)
  })
})
