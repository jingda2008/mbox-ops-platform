import type { RuntimeState } from '../src/shared/contracts.js'
import type { PostgresPool, PostgresTenantContext } from './postgres-repository.js'

export interface OperationalReadSnapshot {
  revision: number
  tables: RuntimeState['tables']
  tableSessions: RuntimeState['songState']['tableSessions']
  serviceTasks: RuntimeState['tasks']
  orders: RuntimeState['orderDomain']['orders']
  kdsTasks: RuntimeState['orderDomain']['kdsTasks']
  paymentIntents: RuntimeState['paymentDomain']['paymentIntents']
  inventoryBalances: NonNullable<RuntimeState['inventoryDomain']>['balances']
}

export interface OperationalRuntimeStateResult {
  state: RuntimeState
  source: 'normalized_tables' | 'aggregate_compatibility'
  revisionMismatches: number
}

interface OperationalReadRow extends Record<string, unknown> {
  runtime_revision: number | string
  tables: unknown
  table_sessions: unknown
  service_tasks: unknown
  orders: unknown
  kds_tasks: unknown
  payment_intents: unknown
  inventory_balances: unknown
}

export class OperationalReadStoreError extends Error {}

export class OperationalReadRevisionError extends OperationalReadStoreError {
  constructor(readonly expectedRevision: number, readonly actualRevision: number | null) {
    super(`Operational read model revision mismatch (${actualRevision ?? 'missing'} != ${expectedRevision})`)
  }
}

function parseRevision(value: number | string) {
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new OperationalReadStoreError(`Invalid operational read revision: ${String(value)}`)
  }
  return revision
}

function parsePayloadArray(value: unknown, name: string): Record<string, unknown>[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new OperationalReadStoreError(`${name} read model payload is invalid`)
  }
  return parsed as Record<string, unknown>[]
}

function assertUniqueIds(rows: Record<string, unknown>[], name: string, key: (row: Record<string, unknown>) => string) {
  const ids = rows.map(key)
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new OperationalReadStoreError(`${name} read model contains missing or duplicate identifiers`)
  }
}

function snapshotFromRow(row: OperationalReadRow, expectedRevision: number): OperationalReadSnapshot {
  const revision = parseRevision(row.runtime_revision)
  if (revision !== expectedRevision) throw new OperationalReadRevisionError(expectedRevision, revision)
  const tables = parsePayloadArray(row.tables, 'tables')
  const tableSessions = parsePayloadArray(row.table_sessions, 'table sessions')
  const serviceTasks = parsePayloadArray(row.service_tasks, 'service tasks')
  const orders = parsePayloadArray(row.orders, 'orders')
  const kdsTasks = parsePayloadArray(row.kds_tasks, 'KDS tasks')
  const paymentIntents = parsePayloadArray(row.payment_intents, 'payment intents')
  const inventoryBalances = parsePayloadArray(row.inventory_balances, 'inventory balances')

  assertUniqueIds(tables, 'tables', (item) => String(item.id ?? ''))
  assertUniqueIds(tableSessions, 'table sessions', (item) => String(item.id ?? ''))
  assertUniqueIds(serviceTasks, 'service tasks', (item) => String(item.id ?? ''))
  assertUniqueIds(orders, 'orders', (item) => String(item.id ?? ''))
  assertUniqueIds(kdsTasks, 'KDS tasks', (item) => String(item.id ?? ''))
  assertUniqueIds(paymentIntents, 'payment intents', (item) => String(item.id ?? ''))
  assertUniqueIds(inventoryBalances, 'inventory balances', (item) => `${String(item.productId ?? '')}\u001f${String(item.unitCode ?? '')}`)

  return {
    revision,
    tables: tables as unknown as OperationalReadSnapshot['tables'],
    tableSessions: tableSessions as unknown as OperationalReadSnapshot['tableSessions'],
    serviceTasks: serviceTasks as unknown as OperationalReadSnapshot['serviceTasks'],
    orders: orders as unknown as OperationalReadSnapshot['orders'],
    kdsTasks: kdsTasks as unknown as OperationalReadSnapshot['kdsTasks'],
    paymentIntents: paymentIntents as unknown as OperationalReadSnapshot['paymentIntents'],
    inventoryBalances: inventoryBalances as unknown as OperationalReadSnapshot['inventoryBalances'],
  }
}

export function hydrateRuntimeStateFromOperationalTables(
  aggregate: RuntimeState,
  snapshot: OperationalReadSnapshot,
): RuntimeState {
  if (aggregate.revision !== snapshot.revision) {
    throw new OperationalReadRevisionError(aggregate.revision, snapshot.revision)
  }
  const hydrated = structuredClone(aggregate)
  hydrated.tables = structuredClone(snapshot.tables)
  hydrated.tasks = structuredClone(snapshot.serviceTasks)
  hydrated.songState.tableSessions = structuredClone(snapshot.tableSessions)
  hydrated.orderDomain.orders = structuredClone(snapshot.orders)
  hydrated.orderDomain.kdsTasks = structuredClone(snapshot.kdsTasks)
  hydrated.paymentDomain.paymentIntents = structuredClone(snapshot.paymentIntents)
  if (hydrated.inventoryDomain) {
    hydrated.inventoryDomain.balances = structuredClone(snapshot.inventoryBalances)
  } else if (snapshot.inventoryBalances.length > 0) {
    throw new OperationalReadStoreError('Inventory balances exist without an inventory domain')
  }
  return hydrated
}

export async function resolveOperationalRuntimeState(options: {
  initialState: RuntimeState
  readFresh: () => Promise<RuntimeState>
  readSnapshot: (revision: number, businessDate: string) => Promise<OperationalReadSnapshot>
  maxAttempts?: number
}): Promise<OperationalRuntimeStateResult> {
  const maxAttempts = options.maxAttempts ?? 3
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer')
  }

  let currentState = options.initialState
  let revisionMismatches = 0
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const snapshot = await options.readSnapshot(currentState.revision, currentState.store.businessDate)
      return {
        state: hydrateRuntimeStateFromOperationalTables(currentState, snapshot),
        source: 'normalized_tables',
        revisionMismatches,
      }
    } catch (error) {
      if (!(error instanceof OperationalReadRevisionError)) throw error
      revisionMismatches += 1
      currentState = await options.readFresh()
    }
  }

  return {
    state: currentState,
    source: 'aggregate_compatibility',
    revisionMismatches,
  }
}

const READ_OPERATIONAL_SNAPSHOT_SQL = `
  SELECT checkpoint.runtime_revision,
    COALESCE((
      SELECT jsonb_agg(payload ORDER BY table_code)
      FROM mbox.operational_tables
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    ), '[]'::jsonb) AS tables,
    COALESCE((
      SELECT jsonb_agg(payload ORDER BY opened_at, source_id)
      FROM mbox.operational_table_sessions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND business_date = $3::date
    ), '[]'::jsonb) AS table_sessions,
    COALESCE((
      SELECT jsonb_agg(payload ORDER BY created_at, source_id)
      FROM mbox.operational_service_tasks
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND archived_at IS NULL
    ), '[]'::jsonb) AS service_tasks,
    COALESCE((
      SELECT jsonb_agg(payload ORDER BY created_at, source_id)
      FROM mbox.operational_orders
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND table_session_id IN (
          SELECT source_id FROM mbox.operational_table_sessions
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND business_date = $3::date
        )
    ), '[]'::jsonb) AS orders,
    COALESCE((
      SELECT jsonb_agg(payload ORDER BY queued_at, source_id)
      FROM mbox.operational_kds_tasks
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND table_session_id IN (
          SELECT source_id FROM mbox.operational_table_sessions
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND business_date = $3::date
        )
    ), '[]'::jsonb) AS kds_tasks,
    COALESCE((
      SELECT jsonb_agg(payload ORDER BY created_at, source_id)
      FROM mbox.operational_payment_intents
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND table_session_id IN (
          SELECT source_id FROM mbox.operational_table_sessions
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND business_date = $3::date
        )
    ), '[]'::jsonb) AS payment_intents,
    COALESCE((
      SELECT jsonb_agg(payload ORDER BY product_id, unit_code)
      FROM mbox.operational_inventory_balances
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    ), '[]'::jsonb) AS inventory_balances
  FROM mbox.operational_projection_checkpoints checkpoint
  JOIN mbox.runtime_states runtime
    ON runtime.tenant_id = checkpoint.tenant_id
   AND runtime.store_id = checkpoint.store_id
   AND runtime.revision = checkpoint.runtime_revision
  WHERE checkpoint.tenant_id = $1::uuid AND checkpoint.store_id = $2::uuid
`.trim()

export class PostgresOperationalReadStore {
  constructor(
    private readonly pool: PostgresPool,
    private readonly context: PostgresTenantContext,
  ) {}

  async read(expectedRevision: number, businessDate: string): Promise<OperationalReadSnapshot> {
    const client = await this.pool.connect()
    let transactionStarted = false
    let releaseError: Error | boolean | undefined
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY')
      transactionStarted = true
      await client.query(`
        SELECT set_config('app.tenant_id', $1, true), set_config('app.store_id', $2, true)
      `, [this.context.tenantId, this.context.storeId])
      const result = await client.query<OperationalReadRow>(READ_OPERATIONAL_SNAPSHOT_SQL, [
        this.context.tenantId,
        this.context.storeId,
        businessDate,
      ])
      if (result.rowCount !== 1 || !result.rows[0]) {
        throw new OperationalReadRevisionError(expectedRevision, null)
      }
      const snapshot = snapshotFromRow(result.rows[0], expectedRevision)
      await client.query('COMMIT')
      return snapshot
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : true
          throw new AggregateError([error, rollbackError], 'Operational read and rollback both failed')
        }
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }
}
