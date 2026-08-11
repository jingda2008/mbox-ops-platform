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
  constructor(private readonly pool: PostgresPool) {}

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
    const client = await this.pool.connect()
    let transactionStarted = false
    let releaseError: Error | boolean | undefined

    try {
      const isolation = options.isolation ?? 'read-committed'
      const readOnlySuffix = options.readOnly === true ? ' READ ONLY' : ''
      await client.query(`${BEGIN_SQL[isolation]}${readOnlySuffix}`)
      transactionStarted = true

      // set_config(..., true) is PostgreSQL's parameterized equivalent of SET LOCAL.
      await client.query(SET_SCOPE_SQL, [scope.tenantId, scope.storeId])

      const transaction = createScopedTransaction(client, scope)
      const result = await operation(transaction)
      await client.query('COMMIT')
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
): ScopedTransaction {
  const immutableScope = Object.freeze({ tenantId: scope.tenantId, storeId: scope.storeId })
  return Object.freeze({
    scope: immutableScope,
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => client.query<Row>(text, values === undefined ? undefined : [...values]),
  })
}

function validateScope(scope: Readonly<StoreScope>): void {
  if (scope.tenantId.trim().length === 0) throw new TypeError('tenantId must not be blank')
  if (scope.storeId.trim().length === 0) throw new TypeError('storeId must not be blank')
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
