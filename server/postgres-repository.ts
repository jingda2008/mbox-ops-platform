import { createHash } from 'node:crypto'
import type { Pool as PgPool } from 'pg'
import type { RuntimeState } from '../src/shared/contracts.js'
import { migrateRuntimeState } from './runtime-state-migrations.js'

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
}

export function asPostgresPool(pool: PgPool): PostgresPool {
  return pool
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

export interface PostgresMutationOptions {
  idempotency?: PostgresMutationIdempotency
}

export interface PostgresRepositoryOptions extends PostgresTenantContext {
  pool: PostgresPool
  seedState?: (() => RuntimeState) | null
  clock?: () => Date
  defaultIdempotencyTtlMs?: number
  defaultIdempotencyLockMs?: number
  healthCheckTimeoutMs?: number
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
  }
  error?: string
}

export class PostgresRepositoryError extends Error {}

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPERATION_SCOPE_PATTERN = /^[a-z][a-z0-9_.-]{2,127}$/
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_IDEMPOTENCY_LOCK_MS = 30 * 1000
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000

const SQL = {
  beginRead: 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
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
  selectRevision: `
    SELECT revision
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
  private lifecycle: Lifecycle = 'new'
  private initPromise: Promise<void> | null = null
  private closePromise: Promise<void> | null = null
  private readonly inFlight = new Set<Promise<unknown>>()

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
    return this.track(() => this.withTransaction(true, async (client) => this.loadState(client)))
  }

  async mutate<T>(
    mutation: (state: RuntimeState) => T | Promise<T>,
    options: PostgresMutationOptions = {},
  ): Promise<T> {
    return this.track(() => this.withTransaction(false, async (client) => {
      const replay = options.idempotency
        ? await this.claimIdempotency<T>(client, options.idempotency)
        : null
      if (replay?.replayed) return replay.value as T

      const current = await this.loadState(client)
      const expectedRevision = current.revision
      const workingCopy = structuredClone(current)
      const result = await mutation(workingCopy)

      if (workingCopy.revision !== expectedRevision) {
        if (!Number.isSafeInteger(workingCopy.revision) || workingCopy.revision <= expectedRevision) {
          throw new PostgresInvalidRevisionError(expectedRevision, workingCopy.revision)
        }
        const serialized = serializeJson(workingCopy, 'runtime state')
        const update = await client.query<{ revision: number | string }>(SQL.compareAndSwapState, [
          this.tenantId,
          this.storeId,
          workingCopy.revision,
          serialized,
          sha256(serialized),
          expectedRevision,
        ])
        if (update.rowCount !== 1) throw new PostgresOptimisticConcurrencyError(expectedRevision)
      }

      if (options.idempotency) {
        await this.completeIdempotency(client, options.idempotency, result)
      }
      return result
    }))
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
      const revision = await this.track(() => this.withTransaction(true, async (client) => {
        await client.query(SQL.setStatementTimeout, [`${this.healthCheckTimeoutMs}ms`])
        const result = await client.query<{ revision: number | string }>(SQL.selectRevision, [
          this.tenantId,
          this.storeId,
        ])
        if (result.rowCount !== 1 || !result.rows[0]) {
          throw new PostgresRuntimeStateNotInitializedError()
        }
        return parseRevision(result.rows[0].revision)
      }))
      return {
        ready: true,
        repository: 'postgres',
        healthy: true,
        latencyMs: performance.now() - startedAt,
        revision,
        pool,
      }
    } catch (error) {
      return {
        ready: false,
        repository: 'postgres',
        healthy: false,
        latencyMs: performance.now() - startedAt,
        revision: null,
        pool,
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
      await this.loadState(transactionClient)
    })
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

  private async loadState(client: PostgresPoolClient): Promise<RuntimeState> {
    const result = await client.query<RuntimeStateRow>(SQL.selectState, [this.tenantId, this.storeId])
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
    if (sha256(serialized) !== row.state_sha256.trim()) {
      throw new PostgresStateCorruptionError('Runtime state checksum mismatch')
    }
    return migrateRuntimeState(state)
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
    return {
      total: this.pool.totalCount ?? null,
      idle: this.pool.idleCount ?? null,
      waiting: this.pool.waitingCount ?? null,
    }
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

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Non-finite numbers are not valid JSON')
    if (['bigint', 'function', 'symbol', 'undefined'].includes(typeof value)) {
      throw new TypeError(`${typeof value} is not valid JSON`)
    }
    return value
  }
  if (value instanceof Date) return value.toJSON()
  const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key]
    sorted[key] = sortJson(child)
  }
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
