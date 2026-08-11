import { describe, expect, it } from 'vitest'
import {
  hashRequestFingerprint,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  NormalizedCommandExecutor,
  ScopedPostgresTransactionRunner,
  type JsonCodec,
  type PostgresPool,
  type PostgresPoolClient,
  type PostgresQueryResult,
} from './index.js'
import { OutboxMessageConflictError } from './command-executor.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const aggregateId = '33333333-3333-4333-8333-333333333333'

interface StoredIdempotency {
  requestHash: string
  status: 'processing' | 'completed' | 'failed'
  responseBody: unknown
}

interface FakeDatabaseState {
  domainRows: string[]
  audits: number
  outboxMessages: number
  outbox: Map<string, StoredOutbox>
  idempotency: Map<string, StoredIdempotency>
}

interface StoredOutbox {
  aggregateType: string
  aggregateId: string
  aggregateVersion: number
  eventType: string
  payload: Record<string, unknown>
  headers: Record<string, unknown>
}

interface QueryRecord {
  sql: string
  values: unknown[]
}

class FakePool implements PostgresPool {
  state: FakeDatabaseState = createState()
  readonly queries: QueryRecord[] = []
  releases = 0
  failOutbox = false

  async connect(): Promise<PostgresPoolClient> {
    return new FakeClient(this)
  }

  async end(): Promise<void> {}
}

class FakeClient implements PostgresPoolClient {
  private transaction: FakeDatabaseState | null = null
  private contextSet = false

  constructor(private readonly pool: FakePool) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    const sql = normalizeSql(text)
    this.pool.queries.push({ sql, values: structuredClone(values) })

    if (sql.startsWith('BEGIN ISOLATION LEVEL')) {
      this.transaction = cloneState(this.pool.state)
      this.contextSet = false
      return result<Row>([])
    }
    if (sql.startsWith("SELECT set_config('app.tenant_id'")) {
      expect(values).toEqual([tenantId, storeId])
      this.requireTransaction()
      this.contextSet = true
      return result<Row>([{ tenant_id: tenantId, store_id: storeId } as unknown as Row])
    }
    if (sql === 'COMMIT') {
      this.requireContext()
      this.pool.state = cloneState(this.requireTransaction())
      this.transaction = null
      this.contextSet = false
      return result<Row>([])
    }
    if (sql === 'ROLLBACK') {
      this.transaction = null
      this.contextSet = false
      return result<Row>([])
    }

    const state = this.requireContext()
    if (sql.startsWith('INSERT INTO test.domain_rows')) {
      state.domainRows.push(String(values[0]))
      return result<Row>([{ id: values[0] } as unknown as Row])
    }
    if (sql.startsWith('INSERT INTO mbox.idempotency_records')) {
      const key = idempotencyMapKey(values)
      if (state.idempotency.has(key)) return result<Row>([])
      state.idempotency.set(key, {
        requestHash: String(values[4]),
        status: 'processing',
        responseBody: null,
      })
      return result<Row>([{ id: '44444444-4444-4444-8444-444444444444' } as unknown as Row])
    }
    if (sql.startsWith('SELECT id, request_sha256, status, response_snapshot')) {
      const record = state.idempotency.get(idempotencyMapKey(values))
      return record === undefined
        ? result<Row>([])
        : result<Row>([{
            id: '44444444-4444-4444-8444-444444444444',
            request_sha256: record.requestHash,
            status: record.status,
            response_snapshot: structuredClone(record.responseBody),
            is_expired: false,
          } as unknown as Row])
    }
    if (sql.startsWith('UPDATE mbox.idempotency_records')) {
      const record = state.idempotency.get(idempotencyMapKey(values))
      if (record === undefined || record.status !== 'processing') return result<Row>([])
      record.status = 'completed'
      record.responseBody = JSON.parse(String(values[4])) as unknown
      return result<Row>([{ id: '44444444-4444-4444-8444-444444444444' } as unknown as Row])
    }
    if (sql.startsWith('INSERT INTO mbox.audit_events')) {
      state.audits += 1
      return result<Row>([{ id: '55555555-5555-4555-8555-555555555555' } as unknown as Row])
    }
    if (sql.startsWith('INSERT INTO mbox.outbox_messages')) {
      if (this.pool.failOutbox) throw new Error('outbox unavailable')
      const messageKey = String(values[2])
      if (state.outbox.has(messageKey)) return result<Row>([])
      state.outbox.set(messageKey, {
        aggregateType: String(values[3]),
        aggregateId: String(values[4]),
        aggregateVersion: Number(values[5]),
        eventType: String(values[6]),
        payload: JSON.parse(String(values[7])) as Record<string, unknown>,
        headers: JSON.parse(String(values[8])) as Record<string, unknown>,
      })
      state.outboxMessages += 1
      return result<Row>([{ message_key: messageKey } as unknown as Row])
    }
    if (sql.startsWith('SELECT message_key, aggregate_type, aggregate_id, aggregate_version')) {
      const messageKey = String(values[2])
      const message = state.outbox.get(messageKey)
      return message === undefined
        ? result<Row>([])
        : result<Row>([{
            message_key: messageKey,
            aggregate_type: message.aggregateType,
            aggregate_id: message.aggregateId,
            aggregate_version: message.aggregateVersion,
            message_type: message.eventType,
            payload: structuredClone(message.payload),
            headers: structuredClone(message.headers),
          } as unknown as Row])
    }
    throw new Error(`Unexpected SQL in fake database: ${sql}`)
  }

  release(): void {
    this.pool.releases += 1
  }

  private requireTransaction(): FakeDatabaseState {
    if (this.transaction === null) throw new Error('transaction required')
    return this.transaction
  }

  private requireContext(): FakeDatabaseState {
    if (!this.contextSet) throw new Error('tenant/store context required')
    return this.requireTransaction()
  }
}

const stringCodec: JsonCodec<string> = {
  encode: (value) => value,
  decode: (value) => {
    if (typeof value !== 'string') throw new TypeError('stored command result is not a string')
    return value
  },
}

describe('normalized transaction foundation', () => {
  it('sets transaction-local tenant/store context before work and commits once', async () => {
    const pool = new FakePool()
    const runner = new ScopedPostgresTransactionRunner(pool)

    await runner.run({ tenantId, storeId }, async (transaction) => {
      expect(transaction.scope).toEqual({ tenantId, storeId })
      await transaction.query('INSERT INTO test.domain_rows (id) VALUES ($1)', ['domain-1'])
    })

    expect(pool.state.domainRows).toEqual(['domain-1'])
    expect(pool.queries.map((query) => query.sql)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      "SELECT set_config('app.tenant_id', $1::text, true) AS tenant_id, set_config('app.store_id', $2::text, true) AS store_id",
      'INSERT INTO test.domain_rows (id) VALUES ($1)',
      'COMMIT',
    ])
    expect(pool.releases).toBe(1)
  })

  it('rolls back domain changes and releases the client when work fails', async () => {
    const pool = new FakePool()
    const runner = new ScopedPostgresTransactionRunner(pool)

    await expect(runner.run({ tenantId, storeId }, async (transaction) => {
      await transaction.query('INSERT INTO test.domain_rows (id) VALUES ($1)', ['rolled-back'])
      throw new Error('domain failure')
    })).rejects.toThrow('domain failure')

    expect(pool.state.domainRows).toEqual([])
    expect(pool.queries.at(-1)?.sql).toBe('ROLLBACK')
    expect(pool.releases).toBe(1)
  })

  it('commits domain row, audit event, outbox message and idempotency result atomically', async () => {
    const pool = new FakePool()
    const executor = new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(pool))

    const execution = await executor.execute(command('fingerprint-a'), async (transaction) => {
      await transaction.query('INSERT INTO test.domain_rows (id) VALUES ($1)', ['order-1'])
      return {
        result: 'created',
        auditEvents: [{
          actor: { type: 'system', ref: 'test' },
          action: 'order.created',
          objectType: 'order',
          objectId: aggregateId,
          businessDate: '2026-08-11',
          afterData: { status: 'created' },
        }],
        outboxMessages: [{
          aggregateType: 'order',
          aggregateId,
          aggregateVersion: 1,
          eventType: 'order.created.v1',
          payload: { status: 'created' },
        }],
      }
    })

    expect(execution).toEqual({ value: 'created', replayed: false })
    expect(pool.state).toMatchObject({
      domainRows: ['order-1'],
      audits: 1,
      outboxMessages: 1,
    })
    expect([...pool.state.idempotency.values()]).toMatchObject([{
      status: 'completed',
      responseBody: { result: 'created' },
    }])
  })

  it('rolls back domain, audit and idempotency writes when outbox insertion fails', async () => {
    const pool = new FakePool()
    pool.failOutbox = true
    const executor = new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(pool))

    await expect(executor.execute(command('fingerprint-a'), async (transaction) => {
      await transaction.query('INSERT INTO test.domain_rows (id) VALUES ($1)', ['order-1'])
      return {
        result: 'created',
        auditEvents: [{
          actor: { type: 'system' },
          action: 'order.created',
          objectType: 'order',
          objectId: aggregateId,
          businessDate: '2026-08-11',
          afterData: { status: 'created' },
        }],
        outboxMessages: [{
          aggregateType: 'order',
          aggregateId,
          aggregateVersion: 1,
          eventType: 'order.created.v1',
          payload: { status: 'created' },
        }],
      }
    })).rejects.toThrow('outbox unavailable')

    expect(pool.state).toEqual(createState())
    expect(pool.queries.at(-1)?.sql).toBe('ROLLBACK')
  })

  it('replays a completed command without invoking the domain handler', async () => {
    const pool = new FakePool()
    const executor = new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(pool))
    const input = command('fingerprint-a')
    let calls = 0

    const handler = async () => {
      calls += 1
      return { result: 'created', auditEvents: [], outboxMessages: [] }
    }
    expect(await executor.execute(input, handler)).toEqual({ value: 'created', replayed: false })
    expect(await executor.execute(input, handler)).toEqual({ value: 'created', replayed: true })
    expect(calls).toBe(1)
  })

  it('reuses an identical business outbox event across command keys but rejects another payload', async () => {
    const pool = new FakePool()
    const executor = new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(pool))
    const execute = (idempotencyKey: string, status: string) => executor.execute({
      ...command(`fingerprint-${idempotencyKey}`),
      idempotencyKey,
    }, async () => ({
      result: status,
      auditEvents: [],
      outboxMessages: [{
        businessEventKey: 'payment:succeeded:provider-event-0001',
        aggregateType: 'payment',
        aggregateId,
        aggregateVersion: 2,
        eventType: 'payment.succeeded.v1',
        payload: { status },
      }],
    }))

    await execute('business-event-first-0001', 'succeeded')
    await expect(execute('business-event-retry-0002', 'succeeded')).resolves.toMatchObject({
      value: 'succeeded',
      replayed: false,
    })
    expect(pool.state.outboxMessages).toBe(1)

    await expect(execute('business-event-conflict-0003', 'refunded'))
      .rejects.toBeInstanceOf(OutboxMessageConflictError)
    expect(pool.state.outboxMessages).toBe(1)
    expect(pool.state.idempotency.size).toBe(2)
  })

  it('rejects a reused key with another fingerprint and a matching in-progress command', async () => {
    const pool = new FakePool()
    const executor = new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(pool))
    const key = `${tenantId}:${storeId}:order.create:request-0001`
    pool.state.idempotency.set(key, {
      requestHash: hashRequestFingerprint('fingerprint-a'),
      status: 'processing',
      responseBody: null,
    })

    await expect(executor.execute(command('fingerprint-b'), async () => ({
      result: 'unexpected', auditEvents: [], outboxMessages: [],
    }))).rejects.toBeInstanceOf(IdempotencyConflictError)

    await expect(executor.execute(command('fingerprint-a'), async () => ({
      result: 'unexpected', auditEvents: [], outboxMessages: [],
    }))).rejects.toBeInstanceOf(IdempotencyInProgressError)
  })
})

function command(requestFingerprint: string) {
  return {
    scope: { tenantId, storeId },
    operationScope: 'order.create',
    idempotencyKey: 'request-0001',
    requestFingerprint,
    resultCodec: stringCodec,
  }
}

function createState(): FakeDatabaseState {
  return {
    domainRows: [],
    audits: 0,
    outboxMessages: 0,
    outbox: new Map(),
    idempotency: new Map(),
  }
}

function cloneState(state: FakeDatabaseState): FakeDatabaseState {
  return {
    domainRows: [...state.domainRows],
    audits: state.audits,
    outboxMessages: state.outboxMessages,
    outbox: new Map(
      [...state.outbox.entries()].map(([key, value]) => [key, structuredClone(value)]),
    ),
    idempotency: new Map(
      [...state.idempotency.entries()].map(([key, value]) => [key, structuredClone(value)]),
    ),
  }
}

function idempotencyMapKey(values: readonly unknown[]): string {
  return `${String(values[0])}:${String(values[1])}:${String(values[2])}:${String(values[3])}`
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function result<Row extends Record<string, unknown>>(rows: Row[]): PostgresQueryResult<Row> {
  return { rows, rowCount: rows.length }
}
