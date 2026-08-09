import { createHash } from 'node:crypto'
import type { Pool as PgPool } from 'pg'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { RuntimeStaffDirectorySnapshot } from './repository.js'
import { migrateRuntimeState } from './runtime-state-migrations.js'
import type {
  OperationalProjectionEntityIds,
  OperationalProjectionTable,
  RuntimeStateProjector,
} from './operational-projection.js'

export interface PostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[]
  rowCount: number | null
}

export interface PostgresPoolClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PostgresQueryResult<Row>>
  release(error?: Error | boolean): void
}

export interface PostgresPool {
  connect(): Promise<PostgresPoolClient>
  end(): Promise<void>
  totalCount?: number
  idleCount?: number
  waitingCount?: number
  metricsSnapshot?(): PostgresPoolMetrics
  resetMetrics?(): void
}

export interface PostgresPoolMetrics {
  acquisitionCount: number
  acquisitionFailedTotal: number
  acquisitionWaitP50Ms: number
  acquisitionWaitP95Ms: number
  acquisitionWaitP99Ms: number
}

export function asPostgresPool(pool: PgPool): PostgresPool {
  const waits: number[] = []
  let acquisitionCount = 0
  let acquisitionFailedTotal = 0
  const percentile = (fraction: number) => {
    if (waits.length === 0) return 0
    const ordered = waits.toSorted((left, right) => left - right)
    return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? 0
  }
  return {
    connect: async () => {
      const startedAt = performance.now()
      try {
        const client = await pool.connect()
        acquisitionCount += 1
        waits.push(Math.max(0, performance.now() - startedAt))
        if (waits.length > 2_048) waits.splice(0, waits.length - 2_048)
        return client
      } catch (error) {
        acquisitionFailedTotal += 1
        throw error
      }
    },
    end: () => pool.end(),
    get totalCount() { return pool.totalCount },
    get idleCount() { return pool.idleCount },
    get waitingCount() { return pool.waitingCount },
    metricsSnapshot: () => ({
      acquisitionCount,
      acquisitionFailedTotal,
      acquisitionWaitP50Ms: percentile(0.5),
      acquisitionWaitP95Ms: percentile(0.95),
      acquisitionWaitP99Ms: percentile(0.99),
    }),
    resetMetrics: () => {
      waits.length = 0
      acquisitionCount = 0
      acquisitionFailedTotal = 0
    },
  }
}

export interface PostgresTenantContext {
  tenantId: string
  storeId: string
}

export interface PostgresMutationIdempotency {
  operationScope: string
  idempotencyKey: string
  requestFingerprint: string
  ttlMs?: number
  lockMs?: number
}

export interface PostgresMutationOptions<T = unknown> {
  idempotency?: PostgresMutationIdempotency
  projectionTables?: OperationalProjectionTable[]
  projectionEntityIds?: (result: T) => OperationalProjectionEntityIds
  metricLabel?: 'kds' | 'scheduler' | 'other'
  minimumGlobalIdleMs?: number
}

export interface PostgresRepositoryOptions extends PostgresTenantContext {
  pool: PostgresPool
  seedState?: (() => RuntimeState) | null
  clock?: () => Date
  defaultIdempotencyTtlMs?: number
  defaultIdempotencyLockMs?: number
  healthCheckTimeoutMs?: number
  maxDatabaseClockSkewMs?: number
  readCacheValidationTtlMs?: number
  maxPendingMutations?: number
  mutationQueueTimeoutMs?: number
  projector?: RuntimeStateProjector
}

export interface PostgresRepositoryHealth {
  ready: boolean
  repository: 'postgres'
  healthy: boolean
  latencyMs: number
  revision: number | null
  pool: {
    total: number | null
    idle: number | null
    waiting: number | null
    acquisitionCount: number
    acquisitionFailedTotal: number
    acquisitionWaitP50Ms: number
    acquisitionWaitP95Ms: number
    acquisitionWaitP99Ms: number
  }
  mutationQueue: {
    pending: number
    highWatermark: number
    active: boolean
    maxPending: number
    rejectedTotal: number
    timeoutTotal: number
    waitSamples: number
    waitP95Ms: number
    waitP99Ms: number
    waitMaxMs: number
    serviceSamples: number
    serviceP95Ms: number
    serviceP99Ms: number
    serviceMaxMs: number
    revisionLockP95Ms: number
    revisionLockMaxMs: number
    cloneP95Ms: number
    cloneMaxMs: number
    domainP95Ms: number
    domainMaxMs: number
    serializationP95Ms: number
    serializationMaxMs: number
    stateWriteP95Ms: number
    stateWriteMaxMs: number
    projectionP95Ms: number
    projectionMaxMs: number
    sourceSamples: Record<'kds' | 'scheduler' | 'other', number>
    sourceServiceP95Ms: Record<'kds' | 'scheduler' | 'other', number>
    initialSerializedStateBytes: number
    serializedStateBytes: number
    maxSerializedStateBytes: number
  }
  error?: string
  projectionReady?: boolean
  projectionRevision?: number | null
  projectionCountsMatch?: boolean
  projectionError?: string
  databaseClockSkewMs: number
}

export class PostgresRepositoryError extends Error {}

export class PostgresMutationNotIdleError extends PostgresRepositoryError {
  constructor() {
    super('A foreground mutation is active or the global quiet window has not elapsed')
  }
}

export class PostgresRepositoryClosedError extends PostgresRepositoryError {
  constructor() {
    super('PostgreSQL repository is closing or closed')
  }
}

export class PostgresRepositoryNotInitializedError extends PostgresRepositoryError {
  constructor() {
    super('PostgreSQL repository must be initialized before use')
  }
}

export class PostgresSchemaError extends PostgresRepositoryError {}

export class PostgresStateCorruptionError extends PostgresRepositoryError {}

export class PostgresRuntimeStateNotInitializedError extends PostgresRepositoryError {
  constructor() {
    super('Runtime state is not initialized for this tenant and store; provision it explicitly before startup')
  }
}

export class PostgresSeedDisabledError extends PostgresRepositoryError {
  constructor() {
    super('Runtime state reset is disabled because no seedState factory was configured')
  }
}

export class PostgresOptimisticConcurrencyError extends PostgresRepositoryError {
  constructor(readonly expectedRevision: number) {
    super(`Runtime state revision ${expectedRevision} was changed by another transaction`)
  }
}

export class PostgresInvalidRevisionError extends PostgresRepositoryError {
  constructor(readonly previousRevision: number, readonly nextRevision: number) {
    super(`Runtime state revision must advance (${previousRevision} -> ${nextRevision})`)
  }
}

export class PostgresIdempotencyConflictError extends PostgresRepositoryError {
  constructor(readonly operationScope: string, readonly idempotencyKey: string) {
    super(`Idempotency key ${operationScope}/${idempotencyKey} was used with a different request`)
  }
}

export class PostgresIdempotencyInProgressError extends PostgresRepositoryError {
  constructor(readonly operationScope: string, readonly idempotencyKey: string) {
    super(`Idempotent operation ${operationScope}/${idempotencyKey} is already in progress`)
  }
}

export class PostgresMutationQueueFullError extends PostgresRepositoryError {
  constructor(readonly maxPending: number) {
    super(`PostgreSQL mutation queue is full (${maxPending})`)
  }
}

export class PostgresMutationQueueTimeoutError extends PostgresRepositoryError {
  constructor(readonly waitedMs: number) {
    super(`PostgreSQL mutation queue wait exceeded ${waitedMs}ms`)
  }
}

export const POSTGRES_RUNTIME_STATE_MIGRATION_SQL = `
BEGIN;

CREATE TABLE mbox.runtime_states (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  state_sha256 char(64) NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  CONSTRAINT runtime_states_revision_matches_document CHECK (
    (state ->> 'revision') ~ '^[1-9][0-9]*$'
    AND (state ->> 'revision')::bigint = revision
  )
);

ALTER TABLE mbox.runtime_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.runtime_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.runtime_states
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

COMMENT ON TABLE mbox.runtime_states IS
  'Compatibility aggregate for the current RuntimeState contract. Revision is updated with optimistic compare-and-swap.';

COMMIT;
`.trim()

type Lifecycle = 'new' | 'initializing' | 'ready' | 'closing' | 'closed'

interface RuntimeStateRow extends Record<string, unknown> {
  revision: number | string
  state: RuntimeState | string
  state_sha256: string
}

interface IdempotencyRow extends Record<string, unknown> {
  request_sha256: string
  status: 'processing' | 'completed' | 'failed'
  response_body: unknown
  locked_until: Date | string | null
}

interface IdempotencyEnvelope<T> {
  hasValue: boolean
  value: T | null
}

interface StaffDirectoryRow extends Record<string, unknown> {
  revision: number | string
  store_id: string
  business_date: string
  employees: unknown
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPERATION_SCOPE_PATTERN = /^[a-z][a-z0-9_.-]{2,127}$/
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_IDEMPOTENCY_LOCK_MS = 30 * 1000
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000
const DEFAULT_MAX_DATABASE_CLOCK_SKEW_MS = 5_000
const DEFAULT_READ_CACHE_VALIDATION_TTL_MS = 3_000

const SQL = {
  // Repository reads often compare the aggregate revision with a normalized
  // projection in a later statement. A repeatable snapshot prevents a
  // concurrent writer from making those two statements observe different
  // commits and incorrectly reporting the service as not ready.
  beginRead: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  beginWrite: 'BEGIN ISOLATION LEVEL READ COMMITTED',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  setContext: `
    SELECT
      set_config('app.tenant_id', $1, true) AS tenant_id,
      set_config('app.store_id', $2, true) AS store_id
  `,
  setStatementTimeout: `SELECT set_config('statement_timeout', $1, true) AS statement_timeout`,
  schemaCheck: `
    SELECT n.nspname || '.' || c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'mbox' AND c.relname = 'runtime_states' AND c.relkind = 'r'
  `,
  seedState: `
    INSERT INTO mbox.runtime_states (
      tenant_id, store_id, revision, state, state_sha256
    ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, $5)
    ON CONFLICT (tenant_id, store_id) DO NOTHING
  `,
  selectState: `
    SELECT revision, state, state_sha256
    FROM mbox.runtime_states
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
  `,
  selectStateForUpdate: `
    SELECT revision, state, state_sha256
    FROM mbox.runtime_states
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    FOR UPDATE
  `,
  selectRevisionForUpdate: `
    SELECT revision
    FROM mbox.runtime_states
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    FOR UPDATE
  `,
  selectRevisionAndIdleForUpdate: `
    SELECT
      revision,
      EXTRACT(EPOCH FROM (clock_timestamp() - updated_at)) * 1000 AS idle_ms
    FROM mbox.runtime_states
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    FOR UPDATE
  `,
  selectRevision: `
    SELECT revision
    FROM mbox.runtime_states
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
  `,
  selectMutationIdle: `
    SELECT EXTRACT(EPOCH FROM (clock_timestamp() - updated_at)) * 1000 AS idle_ms
    FROM mbox.runtime_states
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
  `,
  selectStaffDirectory: `
    SELECT
      revision,
      state #>> '{store,id}' AS store_id,
      state #>> '{store,businessDate}' AS business_date,
      COALESCE(state -> 'employees', '[]'::jsonb) AS employees
    FROM mbox.runtime_states
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
  `,
  selectHealth: `
    SELECT revision, clock_timestamp() AS database_now
    FROM mbox.runtime_states
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
  `,
  compareAndSwapState: `
    UPDATE mbox.runtime_states
    SET revision = $3::bigint,
        state = $4::jsonb,
        state_sha256 = $5,
        updated_at = clock_timestamp()
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND revision = $6::bigint
    RETURNING revision
  `,
  insertIdempotency: `
    INSERT INTO mbox.idempotency_records (
      tenant_id, store_id, operation_scope, idempotency_key, request_sha256,
      status, locked_until, expires_at
    ) VALUES (
      $1::uuid, $2::uuid, $3, $4, $5, 'processing', $6::timestamptz, $7::timestamptz
    )
    ON CONFLICT (tenant_id, store_id, operation_scope, idempotency_key) DO NOTHING
  `,
  selectIdempotency: `
    SELECT request_sha256, status, response_body, locked_until
    FROM mbox.idempotency_records
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND operation_scope = $3
      AND idempotency_key = $4
    FOR UPDATE
  `,
  reclaimIdempotency: `
    UPDATE mbox.idempotency_records
    SET status = 'processing', response_status = NULL, response_body = NULL,
        resource_type = NULL, resource_id = NULL, locked_until = $5::timestamptz,
        expires_at = $6::timestamptz, updated_at = clock_timestamp()
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND operation_scope = $3
      AND idempotency_key = $4
  `,
  completeIdempotency: `
    UPDATE mbox.idempotency_records
    SET status = 'completed', response_status = 200, response_body = $5::jsonb,
        locked_until = NULL, updated_at = clock_timestamp()
    WHERE tenant_id = $1::uuid
      AND store_id = $2::uuid
      AND operation_scope = $3
      AND idempotency_key = $4
  `,
} as const

export class PostgresRepository {
  private readonly pool: PostgresPool
  private readonly tenantId: string
  private readonly storeId: string
  private readonly seedState: (() => RuntimeState) | null
  private readonly clock: () => Date
  private readonly defaultIdempotencyTtlMs: number
  private readonly defaultIdempotencyLockMs: number
  private readonly healthCheckTimeoutMs: number
  private readonly maxDatabaseClockSkewMs: number
  private readonly readCacheValidationTtlMs: number
  private readonly maxPendingMutations: number
  private readonly mutationQueueTimeoutMs: number
  private readonly projector: RuntimeStateProjector | null
  private lifecycle: Lifecycle = 'new'
  private initPromise: Promise<void> | null = null
  private closePromise: Promise<void> | null = null
  private readonly inFlight = new Set<Promise<unknown>>()
  private cachedState: RuntimeState | null = null
  private cacheRefreshPromise: Promise<RuntimeState> | null = null
  private readPromise: Promise<RuntimeState> | null = null
  private cacheValidatedAt = 0
  private mutationTail: Promise<void> = Promise.resolve()
  private pendingMutations = 0
  private mutationQueueHighWatermark = 0
  private activeMutations = 0
  private lastMutationCompletedAt = 0
  private mutationQueueRejectedTotal = 0
  private mutationQueueTimeoutTotal = 0
  private readonly mutationQueueWaits: number[] = []
  private readonly mutationServiceDurations: number[] = []
  private readonly mutationRevisionLockDurations: number[] = []
  private readonly mutationCloneDurations: number[] = []
  private readonly mutationDomainDurations: number[] = []
  private readonly mutationSerializationDurations: number[] = []
  private readonly mutationStateWriteDurations: number[] = []
  private readonly mutationProjectionDurations: number[] = []
  private readonly mutationServiceBySource = new Map<'kds' | 'scheduler' | 'other', number[]>([
    ['kds', []],
    ['scheduler', []],
    ['other', []],
  ])
  private initialSerializedStateBytes: number | null = null
  private serializedStateBytes = 0
  private maxSerializedStateBytes = 0

  constructor(options: PostgresRepositoryOptions) {
    assertUuid('tenantId', options.tenantId)
    assertUuid('storeId', options.storeId)
    this.pool = options.pool
    this.tenantId = options.tenantId
    this.storeId = options.storeId
    this.seedState = options.seedState ?? null
    this.clock = options.clock ?? (() => new Date())
    this.defaultIdempotencyTtlMs = positiveInteger(
      'defaultIdempotencyTtlMs',
      options.defaultIdempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
    )
    this.defaultIdempotencyLockMs = positiveInteger(
      'defaultIdempotencyLockMs',
      options.defaultIdempotencyLockMs ?? DEFAULT_IDEMPOTENCY_LOCK_MS,
    )
    this.healthCheckTimeoutMs = positiveInteger(
      'healthCheckTimeoutMs',
      options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
    )
    this.maxDatabaseClockSkewMs = positiveInteger(
      'maxDatabaseClockSkewMs',
      options.maxDatabaseClockSkewMs ?? DEFAULT_MAX_DATABASE_CLOCK_SKEW_MS,
    )
    this.readCacheValidationTtlMs = positiveInteger(
      'readCacheValidationTtlMs',
      options.readCacheValidationTtlMs ?? DEFAULT_READ_CACHE_VALIDATION_TTL_MS,
    )
    this.maxPendingMutations = positiveInteger('maxPendingMutations', options.maxPendingMutations ?? 100)
    this.mutationQueueTimeoutMs = positiveInteger('mutationQueueTimeoutMs', options.mutationQueueTimeoutMs ?? 15_000)
    this.projector = options.projector ?? null
  }

  async init(): Promise<void> {
    if (this.lifecycle === 'ready') return
    if (this.lifecycle === 'initializing') return this.initPromise!
    if (this.lifecycle === 'closing' || this.lifecycle === 'closed') {
      throw new PostgresRepositoryClosedError()
    }

    this.lifecycle = 'initializing'
    this.initPromise = this.initialize()
    try {
      await this.initPromise
      if (this.lifecycle === 'initializing') this.lifecycle = 'ready'
    } catch (error) {
      if (this.lifecycle === 'initializing') this.lifecycle = 'new'
      throw error
    }
  }

  async read(): Promise<RuntimeState> {
    if (this.cachedState && Date.now() - this.cacheValidatedAt < this.readCacheValidationTtlMs) {
      return structuredClone(this.cachedState)
    }
    if (!this.readPromise) {
      this.readPromise = this.track(() => this.withTransaction(true, async (client) => this.loadStateCached(client)))
        .then((state) => {
          this.cacheValidatedAt = Date.now()
          return state
        })
    }
    const pending = this.readPromise
    try {
      return structuredClone(await pending)
    } finally {
      if (this.readPromise === pending) this.readPromise = null
    }
  }

  async readFresh(): Promise<RuntimeState> {
    const loaded = await this.track(() => this.withTransaction(true, async (client) => this.loadState(client)))
    if (!this.cachedState || loaded.revision >= this.cachedState.revision) {
      this.cachedState = structuredClone(loaded)
    }
    this.cacheValidatedAt = Date.now()
    return structuredClone(this.cachedState)
  }

  async readRevision(): Promise<number> {
    return this.track(() => this.withTransaction(true, async (client) => {
      const result = await client.query<{ revision: number | string }>(SQL.selectRevision, [this.tenantId, this.storeId])
      if (result.rowCount !== 1 || !result.rows[0]) throw new PostgresRuntimeStateNotInitializedError()
      return parseRevision(result.rows[0].revision)
    }))
  }

  async readStaffDirectory(): Promise<RuntimeStaffDirectorySnapshot> {
    return this.track(() => this.withTransaction(true, async (client) => {
      const result = await client.query<StaffDirectoryRow>(SQL.selectStaffDirectory, [this.tenantId, this.storeId])
      const row = result.rows[0]
      if (result.rowCount !== 1 || !row) throw new PostgresRuntimeStateNotInitializedError()
      const rawEmployees = typeof row.employees === 'string' ? JSON.parse(row.employees) : row.employees
      if (!Array.isArray(rawEmployees)) throw new PostgresStateCorruptionError('Staff directory employees must be an array')
      const employees = rawEmployees.map((employee, index) => {
        if (!employee || typeof employee !== 'object') {
          throw new PostgresStateCorruptionError(`Staff directory employee ${index} is invalid`)
        }
        const candidate = employee as Record<string, unknown>
        if (typeof candidate.id !== 'string' || typeof candidate.roleId !== 'string' || typeof candidate.status !== 'string') {
          throw new PostgresStateCorruptionError(`Staff directory employee ${index} is incomplete`)
        }
        return { id: candidate.id, roleId: candidate.roleId, status: candidate.status }
      })
      if (typeof row.store_id !== 'string' || typeof row.business_date !== 'string') {
        throw new PostgresStateCorruptionError('Staff directory store identity is incomplete')
      }
      return {
        storeId: row.store_id,
        businessDate: row.business_date,
        revision: parseRevision(row.revision),
        employees,
      }
    }))
  }

  async mutate<T>(
    mutation: (state: RuntimeState) => T | Promise<T>,
    options: PostgresMutationOptions<T> = {},
  ): Promise<T> {
    return this.track(() => this.enqueueMutation(async () => {
      let stateChanged = false
      let committedState: RuntimeState | null = null
      const result = await this.withTransaction(false, async (client) => {
        const replay = options.idempotency
          ? await this.claimIdempotency<T>(client, options.idempotency)
          : null
        if (replay?.replayed) return replay.value as T

        const mutationGateName = `mbox:${this.tenantId}:${this.storeId}:foreground-mutation-gate`
        const requiredIdleMs = options.minimumGlobalIdleMs === undefined
          ? null
          : Math.max(0, options.minimumGlobalIdleMs)
        if (requiredIdleMs === null) {
          await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [mutationGateName])
        } else {
          const gate = await client.query<{ acquired: boolean }>(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
            [mutationGateName],
          )
          if (gate.rows[0]?.acquired !== true) throw new PostgresMutationNotIdleError()
        }

        // Lock only the lightweight revision first. If this process already has
        // the same verified revision, avoid fetching and parsing the 1MB+ state
        // document again before every serialized write.
        const revisionLockStartedAt = performance.now()
        const locked = requiredIdleMs === null
          ? await client.query<{ revision: number | string }>(SQL.selectRevisionForUpdate, [this.tenantId, this.storeId])
          : await client.query<{ revision: number | string; idle_ms: number | string }>(
            SQL.selectRevisionAndIdleForUpdate,
            [this.tenantId, this.storeId],
          )
        this.recordMutationMetric(this.mutationRevisionLockDurations, performance.now() - revisionLockStartedAt)
        if (locked.rowCount !== 1 || !locked.rows[0]) throw new PostgresRuntimeStateNotInitializedError()
        const lockedRow = locked.rows[0] as { revision: number | string; idle_ms?: number | string }
        if (requiredIdleMs !== null) {
          const idleMs = Number(lockedRow.idle_ms)
          if (!Number.isFinite(idleMs) || idleMs < requiredIdleMs) throw new PostgresMutationNotIdleError()
        }
        const expectedRevision = parseRevision(lockedRow.revision)
        // cachedState is never exposed directly. The mutation receives its own
        // clone below, so cloning the verified cache once more only adds CPU
        // and event-loop pressure on every hot write.
        const current = this.cachedState?.revision === expectedRevision
          ? this.cachedState
          : await this.loadState(client)
        const cloneStartedAt = performance.now()
        const workingCopy = parseState(current)
        this.recordMutationMetric(this.mutationCloneDurations, performance.now() - cloneStartedAt)
        // End the clone turn before canonical serialization. Otherwise both
        // CPU stages can combine into one long event-loop stall.
        await yieldToEventLoop()
        const domainStartedAt = performance.now()
        const result = await mutation(workingCopy)
        this.recordMutationMetric(this.mutationDomainDurations, performance.now() - domainStartedAt)

        if (workingCopy.revision !== expectedRevision) {
          if (!Number.isSafeInteger(workingCopy.revision) || workingCopy.revision <= expectedRevision) {
            throw new PostgresInvalidRevisionError(expectedRevision, workingCopy.revision)
          }
          const serializationStartedAt = performance.now()
          const serialized = serializeJson(workingCopy, 'runtime state')
          this.recordSerializedStateSize(Buffer.byteLength(serialized))
          const stateSha256 = sha256(serialized)
          this.recordMutationMetric(this.mutationSerializationDurations, performance.now() - serializationStartedAt)
          const stateWriteStartedAt = performance.now()
          const update = await client.query<{ revision: number | string }>(SQL.compareAndSwapState, [
            this.tenantId,
            this.storeId,
            workingCopy.revision,
            serialized,
            stateSha256,
            expectedRevision,
          ])
          this.recordMutationMetric(this.mutationStateWriteDurations, performance.now() - stateWriteStartedAt)
          if (update.rowCount !== 1) throw new PostgresOptimisticConcurrencyError(expectedRevision)
          if (this.projector) {
            const projectionStartedAt = performance.now()
            await this.projector.project(
              client,
              this.tenantContext(),
              current,
              workingCopy,
              options.projectionTables,
              stateSha256,
              options.projectionEntityIds?.(result),
            )
            this.recordMutationMetric(this.mutationProjectionDurations, performance.now() - projectionStartedAt)
          }
          stateChanged = true
          // The mutation already runs against a detached JSON clone. Reuse it
          // as the private cache and clone only the usually-small return value
          // below, rather than cloning the whole venue aggregate a second time.
          committedState = workingCopy
        }

        if (options.idempotency) {
          await this.completeIdempotency(client, options.idempotency, result)
        }
        return result
      })
      if (stateChanged && committedState) {
        this.cachedState = committedState
        this.cacheValidatedAt = Date.now()
      }
      return stateChanged ? structuredClone(result) : result
    }, options.metricLabel ?? 'other'))
  }

  async waitForMutationIdle(idleMs: number, maxWaitMs: number) {
    const normalizedIdleMs = Math.max(0, idleMs)
    const deadline = performance.now() + Math.max(0, maxWaitMs)
    while (true) {
      const now = performance.now()
      if (this.pendingMutations === 0 && this.activeMutations === 0 && now - this.lastMutationCompletedAt >= normalizedIdleMs) {
        break
      }
      if (now >= deadline) return false
      const remainingIdle = Math.max(1, normalizedIdleMs - (now - this.lastMutationCompletedAt))
      const remainingDeadline = Math.max(1, deadline - now)
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remainingIdle, remainingDeadline)))
    }
    if (normalizedIdleMs === 0) return true

    // Local queue state is insufficient with more than one API instance. A
    // sibling can still hold or have just released the aggregate row lock.
    // The row timestamp is the shared source of truth for the last committed
    // mutation across the store.
    return this.track(() => this.withTransaction(true, async (client) => {
      const result = await client.query<{ idle_ms: number | string }>(SQL.selectMutationIdle, [
        this.tenantId,
        this.storeId,
      ])
      const value = result.rows[0]?.idle_ms
      if (result.rowCount !== 1 || value === undefined) throw new PostgresRuntimeStateNotInitializedError()
      const globalIdleMs = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(globalIdleMs) && globalIdleMs >= normalizedIdleMs
    }))
  }

  async runWithDistributedLease<T>(name: string, operation: () => Promise<T>) {
    return this.track(async () => {
      const client = await this.pool.connect()
      const leaseName = `mbox:${this.tenantId}:${this.storeId}:${name}`
      let acquired: boolean
      try {
        const result = await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
          [leaseName],
        )
        acquired = result.rows[0]?.acquired === true
      } catch (error) {
        client.release(error instanceof Error ? error : true)
        throw error
      }
      if (!acquired) {
        client.release()
        return { acquired: false }
      }

      let value: T | undefined
      let operationError: unknown
      try {
        value = await operation()
      } catch (error) {
        operationError = error
      }

      let unlockError: unknown
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [leaseName])
      } catch (error) {
        unlockError = error
      }
      // A session advisory lock survives until this connection closes. Never
      // return a client with an uncertain lock state to the shared pool.
      client.release(unlockError instanceof Error ? unlockError : unlockError ? true : undefined)
      if (operationError !== undefined) throw operationError
      if (unlockError !== undefined) throw unlockError
      return { acquired: true, value: value as T }
    })
  }

  async reset(): Promise<RuntimeState> {
    const seedState = this.seedState
    if (!seedState) throw new PostgresSeedDisabledError()
    return this.mutate((state) => {
      const next = seedState()
      next.revision = state.revision + 1
      Object.assign(state, next)
      return state
    })
  }

  async healthCheck(): Promise<PostgresRepositoryHealth> {
    const startedAt = performance.now()
    const pool = this.poolHealth()
    try {
      const health = await this.track(() => this.withTransaction(true, async (client) => {
        await client.query(SQL.setStatementTimeout, [`${this.healthCheckTimeoutMs}ms`])
        const appClockBefore = this.clock().getTime()
        const result = await client.query<{ revision: number | string; database_now: string | Date }>(SQL.selectHealth, [
          this.tenantId,
          this.storeId,
        ])
        const appClockAfter = this.clock().getTime()
        if (result.rowCount !== 1 || !result.rows[0]) {
          throw new PostgresRuntimeStateNotInitializedError()
        }
        const revision = parseRevision(result.rows[0].revision)
        const databaseNow = new Date(result.rows[0].database_now).getTime()
        if (!Number.isFinite(databaseNow)) throw new Error('PostgreSQL未返回有效数据库时间')
        const databaseClockSkewMs = Math.abs(databaseNow - ((appClockBefore + appClockAfter) / 2))
        const projection = this.projector
          ? await this.projector.healthCheck(client, this.tenantContext(), revision)
          : null
        return { revision, projection, databaseClockSkewMs }
      }))
      const clocksSynchronized = health.databaseClockSkewMs <= this.maxDatabaseClockSkewMs
      const projectionReady = health.projection?.ready ?? true
      return {
        ready: projectionReady && clocksSynchronized,
        repository: 'postgres',
        healthy: projectionReady && clocksSynchronized,
        latencyMs: performance.now() - startedAt,
        revision: health.revision,
        databaseClockSkewMs: health.databaseClockSkewMs,
        pool,
        mutationQueue: this.mutationQueueHealth(),
        projectionReady: health.projection?.ready,
        projectionRevision: health.projection?.projectedRevision,
        projectionCountsMatch: health.projection?.countsMatch,
        projectionError: health.projection?.error,
      }
    } catch (error) {
      return {
        ready: false,
        repository: 'postgres',
        healthy: false,
        latencyMs: performance.now() - startedAt,
        revision: null,
        databaseClockSkewMs: -1,
        pool,
        mutationQueue: this.mutationQueueHealth(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (this.lifecycle === 'closed') return

    const pendingInit = this.initPromise
    this.lifecycle = 'closing'
    this.closePromise = (async () => {
      if (pendingInit) await pendingInit.catch(() => undefined)
      await Promise.allSettled([...this.inFlight])
      await this.pool.end()
      this.lifecycle = 'closed'
    })()
    return this.closePromise
  }

  private async initialize(): Promise<void> {
    const client = await this.pool.connect()
    try {
      const schema = await client.query<{ table_name: string | null }>(SQL.schemaCheck)
      if (schema.rows[0]?.table_name !== 'mbox.runtime_states') {
        throw new PostgresSchemaError(
          'mbox.runtime_states is missing; apply POSTGRES_RUNTIME_STATE_MIGRATION_SQL as the next database migration',
        )
      }
    } finally {
      client.release()
    }

    await this.withTransaction(false, async (transactionClient) => {
      if (this.seedState) {
        const seed = this.seedState()
        assertRuntimeState(seed)
        const serialized = serializeJson(seed, 'seed runtime state')
        await transactionClient.query(SQL.seedState, [
          this.tenantId,
          this.storeId,
          seed.revision,
          serialized,
          sha256(serialized),
        ])
      }
      // Serialize startup rebuilds with live writers. Without this row lock a
      // newly starting revision could project an older snapshot after a live
      // instance had already committed a newer one.
      const state = await this.loadState(transactionClient, true)
      if (this.projector) {
        await this.projector.project(transactionClient, this.tenantContext(), null, state)
      }
    })
  }

  private tenantContext(): PostgresTenantContext {
    return { tenantId: this.tenantId, storeId: this.storeId }
  }

  private async withTransaction<T>(
    readOnly: boolean,
    operation: (client: PostgresPoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect()
    let transactionStarted = false
    let releaseError: Error | boolean | undefined
    try {
      await client.query(readOnly ? SQL.beginRead : SQL.beginWrite)
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
          throw new AggregateError([error, rollbackError], 'PostgreSQL transaction and rollback both failed')
        }
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }

  private async loadState(client: PostgresPoolClient, forUpdate = false): Promise<RuntimeState> {
    const result = await client.query<RuntimeStateRow>(forUpdate ? SQL.selectStateForUpdate : SQL.selectState, [
      this.tenantId,
      this.storeId,
    ])
    if (result.rowCount !== 1 || !result.rows[0]) {
      throw new PostgresRuntimeStateNotInitializedError()
    }

    const row = result.rows[0]
    const state = parseState(row.state)
    const revision = parseRevision(row.revision)
    if (state.revision !== revision) {
      throw new PostgresStateCorruptionError(
        `Runtime state document revision ${state.revision} does not match row revision ${revision}`,
      )
    }
    const serialized = serializeJson(state, 'persisted runtime state')
    this.recordSerializedStateSize(Buffer.byteLength(serialized))
    if (sha256(serialized) !== row.state_sha256.trim()) {
      throw new PostgresStateCorruptionError('Runtime state checksum mismatch')
    }
    return migrateRuntimeState(state)
  }

  private async loadStateCached(client: PostgresPoolClient): Promise<RuntimeState> {
    const revisionResult = await client.query<{ revision: number | string }>(SQL.selectRevision, [
      this.tenantId,
      this.storeId,
    ])
    const revisionValue = revisionResult.rows[0]?.revision
    if (revisionResult.rowCount !== 1 || revisionValue === undefined) {
      throw new PostgresRuntimeStateNotInitializedError()
    }
    const revision = parseRevision(revisionValue)
    if (this.cachedState?.revision === revision) return this.cachedState

    if (this.cacheRefreshPromise) {
      const shared = await this.cacheRefreshPromise
      if (shared.revision >= revision) return shared
    }

    const refresh = this.loadState(client).then((loaded) => {
      if (!this.cachedState || loaded.revision >= this.cachedState.revision) {
        this.cachedState = loaded
      }
      return this.cachedState
    })
    this.cacheRefreshPromise = refresh
    try {
      return await refresh
    } finally {
      if (this.cacheRefreshPromise === refresh) this.cacheRefreshPromise = null
    }
  }

  private async claimIdempotency<T>(
    client: PostgresPoolClient,
    idempotency: PostgresMutationIdempotency,
  ): Promise<{ replayed: false } | { replayed: true; value: T | undefined }> {
    const normalized = this.normalizeIdempotency(idempotency)
    const inserted = await client.query(SQL.insertIdempotency, [
      this.tenantId,
      this.storeId,
      normalized.operationScope,
      normalized.idempotencyKey,
      normalized.requestHash,
      normalized.lockedUntil,
      normalized.expiresAt,
    ])
    const selected = await client.query<IdempotencyRow>(SQL.selectIdempotency, [
      this.tenantId,
      this.storeId,
      normalized.operationScope,
      normalized.idempotencyKey,
    ])
    const record = selected.rows[0]
    if (selected.rowCount !== 1 || !record) {
      throw new PostgresStateCorruptionError('Idempotency record disappeared during mutation')
    }
    if (record.request_sha256 !== normalized.requestHash) {
      throw new PostgresIdempotencyConflictError(normalized.operationScope, normalized.idempotencyKey)
    }
    if (record.status === 'completed') {
      return { replayed: true, value: readIdempotencyEnvelope<T>(record.response_body) }
    }

    const lockExpiresAt = record.locked_until === null ? Number.NEGATIVE_INFINITY : new Date(record.locked_until).getTime()
    if (Number.isNaN(lockExpiresAt)) {
      throw new PostgresStateCorruptionError('Idempotency record contains an invalid lock expiry')
    }
    const recordWasJustInserted = inserted.rowCount === 1
    if (record.status === 'processing' && !recordWasJustInserted && lockExpiresAt > this.clock().getTime()) {
      throw new PostgresIdempotencyInProgressError(normalized.operationScope, normalized.idempotencyKey)
    }
    if (record.status === 'failed' || !recordWasJustInserted) {
      await client.query(SQL.reclaimIdempotency, [
        this.tenantId,
        this.storeId,
        normalized.operationScope,
        normalized.idempotencyKey,
        normalized.lockedUntil,
        normalized.expiresAt,
      ])
    }
    return { replayed: false }
  }

  private async completeIdempotency<T>(
    client: PostgresPoolClient,
    idempotency: PostgresMutationIdempotency,
    result: T,
  ): Promise<void> {
    const envelope: IdempotencyEnvelope<T> = {
      hasValue: result !== undefined,
      value: result === undefined ? null : result,
    }
    const responseBody = serializeJson(envelope, 'idempotency response')
    const completed = await client.query(SQL.completeIdempotency, [
      this.tenantId,
      this.storeId,
      idempotency.operationScope,
      idempotency.idempotencyKey,
      responseBody,
    ])
    if (completed.rowCount !== 1) {
      throw new PostgresStateCorruptionError('Idempotency record could not be completed')
    }
  }

  private normalizeIdempotency(idempotency: PostgresMutationIdempotency) {
    if (!OPERATION_SCOPE_PATTERN.test(idempotency.operationScope)) {
      throw new TypeError('operationScope must match the database idempotency scope format')
    }
    if (idempotency.idempotencyKey.length < 8 || idempotency.idempotencyKey.length > 128) {
      throw new TypeError('idempotencyKey must contain between 8 and 128 characters')
    }
    if (!idempotency.requestFingerprint) throw new TypeError('requestFingerprint must not be empty')

    const ttlMs = positiveInteger('idempotency ttlMs', idempotency.ttlMs ?? this.defaultIdempotencyTtlMs)
    const lockMs = positiveInteger('idempotency lockMs', idempotency.lockMs ?? this.defaultIdempotencyLockMs)
    const now = this.clock().getTime()
    return {
      operationScope: idempotency.operationScope,
      idempotencyKey: idempotency.idempotencyKey,
      requestHash: sha256(idempotency.requestFingerprint),
      lockedUntil: new Date(now + lockMs).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    }
  }

  private async enqueueMutation<T>(
    operation: () => Promise<T>,
    metricLabel: 'kds' | 'scheduler' | 'other',
  ): Promise<T> {
    if (this.pendingMutations >= this.maxPendingMutations) {
      this.mutationQueueRejectedTotal += 1
      throw new PostgresMutationQueueFullError(this.maxPendingMutations)
    }
    this.pendingMutations += 1
    this.mutationQueueHighWatermark = Math.max(this.mutationQueueHighWatermark, this.pendingMutations)
    const queuedAt = performance.now()
    const previous = this.mutationTail.catch(() => undefined)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    this.mutationTail = previous.then(() => gate)
    let timeout: ReturnType<typeof setTimeout> | undefined
    let acquired = false
    try {
      await Promise.race([
        previous,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new PostgresMutationQueueTimeoutError(Math.round(performance.now() - queuedAt)))
          }, this.mutationQueueTimeoutMs)
        }),
      ])
      if (timeout) clearTimeout(timeout)
      timeout = undefined
      acquired = true
      this.activeMutations += 1
      this.recordMutationMetric(this.mutationQueueWaits, performance.now() - queuedAt)
      const operationStartedAt = performance.now()
      try {
        return await operation()
      } finally {
        const duration = performance.now() - operationStartedAt
        this.recordMutationMetric(this.mutationServiceDurations, duration)
        this.recordMutationMetric(this.mutationServiceBySource.get(metricLabel)!, duration)
      }
    } catch (error) {
      if (error instanceof PostgresMutationQueueTimeoutError) this.mutationQueueTimeoutTotal += 1
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
      if (acquired) this.activeMutations -= 1
      if (acquired) this.lastMutationCompletedAt = performance.now()
      this.pendingMutations -= 1
      release()
    }
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lifecycle === 'closing' || this.lifecycle === 'closed') {
      return Promise.reject(new PostgresRepositoryClosedError())
    }
    if (this.lifecycle !== 'ready') {
      return Promise.reject(new PostgresRepositoryNotInitializedError())
    }
    const promise = operation()
    this.inFlight.add(promise)
    void promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined)
    return promise
  }

  private poolHealth() {
    const acquisition = this.pool.metricsSnapshot?.() ?? {
      acquisitionCount: 0,
      acquisitionFailedTotal: 0,
      acquisitionWaitP50Ms: 0,
      acquisitionWaitP95Ms: 0,
      acquisitionWaitP99Ms: 0,
    }
    return {
      total: this.pool.totalCount ?? null,
      idle: this.pool.idleCount ?? null,
      waiting: this.pool.waitingCount ?? null,
      ...acquisition,
    }
  }


  private mutationQueueHealth() {
    return {
      pending: this.pendingMutations,
      highWatermark: this.mutationQueueHighWatermark,
      active: this.activeMutations > 0,
      maxPending: this.maxPendingMutations,
      rejectedTotal: this.mutationQueueRejectedTotal,
      timeoutTotal: this.mutationQueueTimeoutTotal,
      waitSamples: this.mutationQueueWaits.length,
      waitP95Ms: this.mutationPercentile(this.mutationQueueWaits, 0.95),
      waitP99Ms: this.mutationPercentile(this.mutationQueueWaits, 0.99),
      waitMaxMs: Math.max(0, ...this.mutationQueueWaits),
      serviceSamples: this.mutationServiceDurations.length,
      serviceP95Ms: this.mutationPercentile(this.mutationServiceDurations, 0.95),
      serviceP99Ms: this.mutationPercentile(this.mutationServiceDurations, 0.99),
      serviceMaxMs: Math.max(0, ...this.mutationServiceDurations),
      revisionLockP95Ms: this.mutationPercentile(this.mutationRevisionLockDurations, 0.95),
      revisionLockMaxMs: Math.max(0, ...this.mutationRevisionLockDurations),
      cloneP95Ms: this.mutationPercentile(this.mutationCloneDurations, 0.95),
      cloneMaxMs: Math.max(0, ...this.mutationCloneDurations),
      domainP95Ms: this.mutationPercentile(this.mutationDomainDurations, 0.95),
      domainMaxMs: Math.max(0, ...this.mutationDomainDurations),
      serializationP95Ms: this.mutationPercentile(this.mutationSerializationDurations, 0.95),
      serializationMaxMs: Math.max(0, ...this.mutationSerializationDurations),
      stateWriteP95Ms: this.mutationPercentile(this.mutationStateWriteDurations, 0.95),
      stateWriteMaxMs: Math.max(0, ...this.mutationStateWriteDurations),
      projectionP95Ms: this.mutationPercentile(this.mutationProjectionDurations, 0.95),
      projectionMaxMs: Math.max(0, ...this.mutationProjectionDurations),
      sourceSamples: {
        kds: this.mutationServiceBySource.get('kds')!.length,
        scheduler: this.mutationServiceBySource.get('scheduler')!.length,
        other: this.mutationServiceBySource.get('other')!.length,
      },
      sourceServiceP95Ms: {
        kds: this.mutationPercentile(this.mutationServiceBySource.get('kds')!, 0.95),
        scheduler: this.mutationPercentile(this.mutationServiceBySource.get('scheduler')!, 0.95),
        other: this.mutationPercentile(this.mutationServiceBySource.get('other')!, 0.95),
      },
      initialSerializedStateBytes: this.initialSerializedStateBytes ?? 0,
      serializedStateBytes: this.serializedStateBytes,
      maxSerializedStateBytes: this.maxSerializedStateBytes,
    }
  }

  async resetPerformanceMetrics() {
    if (this.pendingMutations !== 0 || this.activeMutations !== 0) {
      throw new Error('cannot reset performance metrics while mutations are active')
    }
    const current = await this.readFresh()
    if (this.pendingMutations !== 0 || this.activeMutations !== 0) {
      throw new Error('cannot reset performance metrics while mutations are active')
    }
    const currentBytes = Buffer.byteLength(serializeRuntimeState(current))
    this.pool.resetMetrics?.()
    this.mutationQueueHighWatermark = 0
    this.mutationQueueRejectedTotal = 0
    this.mutationQueueTimeoutTotal = 0
    this.mutationQueueWaits.length = 0
    this.mutationServiceDurations.length = 0
    this.mutationRevisionLockDurations.length = 0
    this.mutationCloneDurations.length = 0
    this.mutationDomainDurations.length = 0
    this.mutationSerializationDurations.length = 0
    this.mutationStateWriteDurations.length = 0
    this.mutationProjectionDurations.length = 0
    for (const samples of this.mutationServiceBySource.values()) samples.length = 0
    this.serializedStateBytes = currentBytes
    this.initialSerializedStateBytes = currentBytes
    this.maxSerializedStateBytes = currentBytes
  }

  private recordMutationMetric(samples: number[], value: number) {
    samples.push(Math.max(0, value))
    if (samples.length > 2_048) samples.splice(0, samples.length - 2_048)
  }

  private recordSerializedStateSize(bytes: number) {
    if (this.initialSerializedStateBytes === null) this.initialSerializedStateBytes = bytes
    this.serializedStateBytes = bytes
    this.maxSerializedStateBytes = Math.max(this.maxSerializedStateBytes, bytes)
  }

  private mutationPercentile(samples: number[], fraction: number) {
    if (samples.length === 0) return 0
    const ordered = samples.toSorted((left, right) => left - right)
    return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? 0
  }
}

function assertUuid(name: string, value: string): void {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${name} must be a UUID`)
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  return value
}

function parseRevision(value: number | string): number {
  const revision = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new PostgresStateCorruptionError(`Invalid runtime state revision: ${String(value)}`)
  }
  return revision
}

function parseState(value: RuntimeState | string): RuntimeState {
  let parsed: unknown
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : structuredClone(value)
  } catch (error) {
    throw new PostgresStateCorruptionError(`Runtime state JSON is invalid: ${String(error)}`)
  }
  assertRuntimeState(parsed)
  return parsed
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

export function serializeRuntimeState(value: RuntimeState) {
  assertRuntimeState(value)
  return serializeJson(value, 'runtime state')
}

export function runtimeStateChecksum(serialized: string) {
  return sha256(serialized)
}

function assertRuntimeState(value: unknown): asserts value is RuntimeState {
  if (!value || typeof value !== 'object') throw new PostgresStateCorruptionError('Runtime state must be an object')
  const revision = (value as { revision?: unknown }).revision
  if (!Number.isSafeInteger(revision) || Number(revision) <= 0) {
    throw new PostgresStateCorruptionError('Runtime state must contain a positive integer revision')
  }
}

function serializeJson(value: unknown, label: string): string {
  try {
    return JSON.stringify(sortJson(value))
  } catch (error) {
    throw new PostgresRepositoryError(`${label} is not JSON serializable: ${String(error)}`)
  }
}

function sortJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return value
  if (typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Non-finite numbers are not valid JSON')
    if (['bigint', 'function', 'symbol', 'undefined'].includes(typeof value)) {
      throw new TypeError(`${typeof value} is not valid JSON`)
    }
    return value
  }
  if (value instanceof Date) {
    return value.toJSON()
  }
  if (seen.has(value)) throw new TypeError('Circular references are not valid JSON')
  seen.add(value)
  let sorted: unknown
  if (Array.isArray(value)) {
    sorted = value.map((child) => sortJson(child, seen))
  } else {
    const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value).sort()) {
      object[key] = sortJson((value as Record<string, unknown>)[key], seen)
    }
    sorted = object
  }
  seen.delete(value)
  return sorted
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function readIdempotencyEnvelope<T>(value: unknown): T | undefined {
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch (error) {
      throw new PostgresStateCorruptionError(`Idempotency response JSON is invalid: ${String(error)}`)
    }
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { hasValue?: unknown }).hasValue !== 'boolean') {
    throw new PostgresStateCorruptionError('Idempotency response envelope is invalid')
  }
  const envelope = parsed as IdempotencyEnvelope<T>
  return envelope.hasValue ? (structuredClone(envelope.value) as T) : undefined
}
