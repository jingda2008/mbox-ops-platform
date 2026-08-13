import { performance } from 'node:perf_hooks'

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
  on?(event: 'error', listener: (error: unknown) => void): unknown
  readonly totalCount?: number
  readonly idleCount?: number
  readonly waitingCount?: number
}

export interface StoreScope {
  tenantId: string
  storeId: string
}

export interface ScopedTransaction {
  readonly scope: Readonly<StoreScope>
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>
}

export type TransactionIsolation = 'read-committed' | 'repeatable-read' | 'serializable'

export interface TransactionOptions {
  isolation?: TransactionIsolation
  readOnly?: boolean
  retryOnConflict?: number
}

export interface NormalizedDatabaseTelemetrySnapshot {
  pool: Readonly<{
    acquisitions: number
    acquisitionFailures: number
    acquisitionWaitMs: Readonly<DurationSummary>
    totalConnections: number | null
    idleConnections: number | null
    waitingClients: number | null
  }>
  transactions: Readonly<{
    completed: number
    failed: number
    durationMs: Readonly<DurationSummary>
  }>
  queries: Readonly<{
    completed: number
    failed: number
    durationMs: Readonly<DurationSummary>
  }>
}

export interface DurationSummary {
  samples: number
  p50: number
  p95: number
  p99: number
  max: number
}

const TELEMETRY_SAMPLE_LIMIT = 10_000

export class NormalizedDatabaseTelemetry {
  private readonly acquisitionWaitMs = new BoundedDurationSamples()
  private readonly transactionDurationMs = new BoundedDurationSamples()
  private readonly queryDurationMs = new BoundedDurationSamples()
  private acquisitions = 0
  private acquisitionFailures = 0
  private completedTransactions = 0
  private failedTransactions = 0
  private completedQueries = 0
  private failedQueries = 0

  recordPoolAcquisition(durationMs: number, succeeded: boolean): void {
    this.acquisitions += 1
    if (!succeeded) this.acquisitionFailures += 1
    this.acquisitionWaitMs.add(durationMs)
  }

  recordTransaction(durationMs: number, succeeded: boolean): void {
    if (succeeded) this.completedTransactions += 1
    else this.failedTransactions += 1
    this.transactionDurationMs.add(durationMs)
  }

  recordQuery(durationMs: number, succeeded: boolean): void {
    if (succeeded) this.completedQueries += 1
    else this.failedQueries += 1
    this.queryDurationMs.add(durationMs)
  }

  snapshot(pool?: Readonly<PostgresPool>): NormalizedDatabaseTelemetrySnapshot {
    return Object.freeze({
      pool: Object.freeze({
        acquisitions: this.acquisitions,
        acquisitionFailures: this.acquisitionFailures,
        acquisitionWaitMs: summarizeDurations(this.acquisitionWaitMs.values()),
        totalConnections: finiteIntegerOrNull(pool?.totalCount),
        idleConnections: finiteIntegerOrNull(pool?.idleCount),
        waitingClients: finiteIntegerOrNull(pool?.waitingCount),
      }),
      transactions: Object.freeze({
        completed: this.completedTransactions,
        failed: this.failedTransactions,
        durationMs: summarizeDurations(this.transactionDurationMs.values()),
      }),
      queries: Object.freeze({
        completed: this.completedQueries,
        failed: this.failedQueries,
        durationMs: summarizeDurations(this.queryDurationMs.values()),
      }),
    })
  }
}

const BEGIN_SQL: Record<TransactionIsolation, string> = {
  'read-committed': 'BEGIN ISOLATION LEVEL READ COMMITTED',
  'repeatable-read': 'BEGIN ISOLATION LEVEL REPEATABLE READ',
  serializable: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
}

const SET_SCOPE_SQL = `
  SELECT
    set_config('app.tenant_id', $1::text, true) AS tenant_id,
    set_config('app.store_id', $2::text, true) AS store_id
`

export class ScopedPostgresTransactionRunner {
  readonly telemetry: NormalizedDatabaseTelemetry

  constructor(
    private readonly pool: PostgresPool,
    telemetry: NormalizedDatabaseTelemetry = new NormalizedDatabaseTelemetry(),
  ) {
    this.telemetry = telemetry
  }

  telemetrySnapshot(): NormalizedDatabaseTelemetrySnapshot {
    return this.telemetry.snapshot(this.pool)
  }

  async singleScopedQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
    scope: Readonly<StoreScope>,
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    validateScope(scope)
    if (!text.includes("set_config('app.tenant_id'") || !text.includes("set_config('app.store_id'")) {
      throw new TypeError('singleScopedQuery must establish both normalized request-scope settings')
    }
    const acquisitionStartedAt = performance.now()
    let client: PostgresPoolClient
    try {
      client = await this.pool.connect()
      this.telemetry.recordPoolAcquisition(performance.now() - acquisitionStartedAt, true)
    } catch (error) {
      this.telemetry.recordPoolAcquisition(performance.now() - acquisitionStartedAt, false)
      throw error
    }
    const queryStartedAt = performance.now()
    try {
      const result = await client.query<Row>(text, [scope.tenantId, scope.storeId, ...values])
      this.telemetry.recordQuery(performance.now() - queryStartedAt, true)
      return result
    } catch (error) {
      this.telemetry.recordQuery(performance.now() - queryStartedAt, false)
      throw error
    } finally {
      client.release()
    }
  }

  async run<Result>(
    scope: Readonly<StoreScope>,
    operation: (transaction: ScopedTransaction) => Promise<Result>,
    options: Readonly<TransactionOptions> = {},
  ): Promise<Result> {
    validateScope(scope)
    const retryLimit = validateRetryLimit(options.retryOnConflict ?? 0)
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.runOnce(scope, operation, options)
      } catch (error) {
        if (attempt >= retryLimit || !isRetryableTransactionConflict(error)) throw error
      }
    }
  }

  private async runOnce<Result>(
    scope: Readonly<StoreScope>,
    operation: (transaction: ScopedTransaction) => Promise<Result>,
    options: Readonly<TransactionOptions>,
  ): Promise<Result> {
    const acquisitionStartedAt = performance.now()
    let client: PostgresPoolClient
    try {
      client = await this.pool.connect()
      this.telemetry.recordPoolAcquisition(performance.now() - acquisitionStartedAt, true)
    } catch (error) {
      this.telemetry.recordPoolAcquisition(performance.now() - acquisitionStartedAt, false)
      throw error
    }
    const transactionStartedAt = performance.now()
    let transactionStarted = false
    let transactionSucceeded = false
    let releaseError: Error | boolean | undefined

    try {
      const isolation = options.isolation ?? 'read-committed'
      const readOnlySuffix = options.readOnly === true ? ' READ ONLY' : ''
      await client.query(`${BEGIN_SQL[isolation]}${readOnlySuffix}`)
      transactionStarted = true

      // set_config(..., true) is PostgreSQL's parameterized equivalent of SET LOCAL.
      await client.query(SET_SCOPE_SQL, [scope.tenantId, scope.storeId])

      const transaction = createScopedTransaction(client, scope, this.telemetry)
      const result = await operation(transaction)
      await client.query('COMMIT')
      transactionSucceeded = true
      return result
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError) {
          const normalizedRollbackError = toError(rollbackError)
          releaseError = normalizedRollbackError
          throw new AggregateError(
            [toError(error), normalizedRollbackError],
            'PostgreSQL transaction failed and rollback also failed',
          )
        }
      }
      throw error
    } finally {
      this.telemetry.recordTransaction(performance.now() - transactionStartedAt, transactionSucceeded)
      client.release(releaseError)
    }
  }
}

function validateRetryLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 3) {
    throw new TypeError('retryOnConflict must be an integer between 0 and 3')
  }
  return value
}

function isRetryableTransactionConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === '40001' || error.code === '40P01'
}

function createScopedTransaction(
  client: PostgresPoolClient,
  scope: Readonly<StoreScope>,
  telemetry: NormalizedDatabaseTelemetry,
): ScopedTransaction {
  const immutableScope = Object.freeze({ tenantId: scope.tenantId, storeId: scope.storeId })
  return Object.freeze({
    scope: immutableScope,
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => {
      const startedAt = performance.now()
      try {
        const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
        telemetry.recordQuery(performance.now() - startedAt, true)
        return result
      } catch (error) {
        telemetry.recordQuery(performance.now() - startedAt, false)
        throw error
      }
    },
  })
}

class BoundedDurationSamples {
  private readonly samples: number[] = []
  private cursor = 0

  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return
    if (this.samples.length < TELEMETRY_SAMPLE_LIMIT) {
      this.samples.push(value)
      return
    }
    this.samples[this.cursor] = value
    this.cursor = (this.cursor + 1) % TELEMETRY_SAMPLE_LIMIT
  }

  values(): readonly number[] {
    return this.samples
  }
}

function summarizeDurations(values: readonly number[]): Readonly<DurationSummary> {
  if (values.length === 0) return Object.freeze({ samples: 0, p50: 0, p95: 0, p99: 0, max: 0 })
  const ordered = values.toSorted((left, right) => left - right)
  return Object.freeze({
    samples: values.length,
    p50: roundedPercentile(ordered, 0.5),
    p95: roundedPercentile(ordered, 0.95),
    p99: roundedPercentile(ordered, 0.99),
    max: roundDuration(ordered.at(-1) ?? 0),
  })
}

function roundedPercentile(ordered: readonly number[], fraction: number): number {
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))
  return roundDuration(ordered[index] ?? 0)
}

function roundDuration(value: number): number {
  return Math.round(value * 100) / 100
}

function finiteIntegerOrNull(value: number | undefined): number | null {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return null
  return value
}

function validateScope(scope: Readonly<StoreScope>): void {
  if (scope.tenantId.trim().length === 0) throw new TypeError('tenantId must not be blank')
  if (scope.storeId.trim().length === 0) throw new TypeError('storeId must not be blank')
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
