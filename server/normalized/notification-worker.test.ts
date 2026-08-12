import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import type { ScopedTransaction, StoreScope, PostgresPool } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { NotificationDeliveryError, NotificationWorker } from './notification-worker.js'
import { NotificationRepository } from './notification-repository.js'

const scope = {
  tenantId: '20000000-0000-4000-8000-000000000001',
  storeId: '20000000-0000-4000-8000-000000000002',
}
const employeeId = '20000000-0000-4000-8000-000000000003'

interface Response { rows: Record<string, unknown>[]; rowCount: number }

class ScriptedTransactions {
  calls: Array<{ sql: string; values: readonly unknown[] }> = []
  constructor(private readonly responses: Response[]) {}
  async run<Result>(
    currentScope: Readonly<StoreScope>,
    operation: (transaction: ScopedTransaction) => Promise<Result>,
  ) {
    const transaction: ScopedTransaction = {
      scope: currentScope,
      query: async <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
        this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
        const response = this.responses.shift()
        if (!response) throw new Error(`Unexpected query: ${sql}`)
        return response as { rows: Row[]; rowCount: number }
      },
    }
    return operation(transaction)
  }
}

describe('NotificationWorker', () => {
  it('claims no more than 50 rows with SKIP LOCKED and delivers with the business key', async () => {
    const transactions = new ScriptedTransactions([
      response([]),
      response([notificationRow()]),
      response([], 1),
    ])
    const keys: string[] = []
    const result = await new NotificationWorker(transactions).runBatch(
      scope,
      'notification-worker-1',
      async (request) => { keys.push(request.idempotencyKey) },
      { limit: 50 },
    )

    expect(result).toEqual({
      claimed: 1,
      delivered: ['30000000-0000-4000-8000-000000000001'],
      retrying: [],
      dead: [],
      lost: [],
    })
    expect(keys).toEqual(['service:task-42:completed:employee-3'])
    expect(transactions.calls[1]?.sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(transactions.calls[1]?.sql).toContain('LIMIT $4')
    expect(transactions.calls[1]?.sql).toContain("status = 'sending'")
  })

  it('stores only a stable failure code and applies exponential retry delay', async () => {
    const transactions = new ScriptedTransactions([
      response([]),
      response([notificationRow({ attempts: 3 })]),
      response([], 1),
    ])
    const result = await new NotificationWorker(transactions).runBatch(
      scope,
      'notification-worker-2',
      async () => { throw new NotificationDeliveryError('provider_timeout') },
      { baseRetryDelayMs: 2_000, maxRetryDelayMs: 30_000 },
    )

    expect(result.retrying).toEqual(['30000000-0000-4000-8000-000000000001'])
    expect(transactions.calls[2]?.values[5]).toBe(8_000)
    expect(transactions.calls[2]?.values[6]).toBe('provider_timeout')
    expect(JSON.stringify(transactions.calls[2]?.values)).not.toContain('secret provider response')
  })

  it('moves an exhausted notification to dead without another retry', async () => {
    const transactions = new ScriptedTransactions([
      response([]),
      response([notificationRow({ attempts: 5, max_attempts: 5 })]),
      response([], 1),
    ])
    const result = await new NotificationWorker(transactions).runBatch(
      scope,
      'notification-worker-3',
      async () => { throw new Error('raw upstream body with customer data') },
    )

    expect(result.dead).toEqual(['30000000-0000-4000-8000-000000000001'])
    expect(transactions.calls[2]?.values[4]).toBe(true)
    expect(transactions.calls[2]?.values[6]).toBe('delivery_failed:unknown')
    expect(JSON.stringify(transactions.calls[2]?.values)).not.toContain('customer data')
  })

  it('recovers a stale sending row already at its attempt limit as dead', async () => {
    const id = '30000000-0000-4000-8000-000000000009'
    const transactions = new ScriptedTransactions([
      response([{ id }]),
      response([]),
    ])
    let deliveryCalls = 0
    const result = await new NotificationWorker(transactions).runBatch(
      scope,
      'notification-worker-recovery',
      async () => { deliveryCalls += 1 },
    )

    expect(result).toEqual({ claimed: 0, delivered: [], retrying: [], dead: [id], lost: [] })
    expect(deliveryCalls).toBe(0)
    expect(transactions.calls[0]?.sql).toContain('attempts >= max_attempts')
    expect(transactions.calls[0]?.sql).toContain('FOR UPDATE SKIP LOCKED')
  })

  it('rejects unsafe batch size before accessing the database', async () => {
    const transactions = new ScriptedTransactions([])
    await expect(new NotificationWorker(transactions).runBatch(
      scope, 'notification-worker-4', async () => undefined, { limit: 51 },
    )).rejects.toThrow('limit must be an integer between 1 and 50')
    expect(transactions.calls).toHaveLength(0)
  })
})

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('NotificationWorker PostgreSQL concurrency', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    const postgresPool: PostgresPool = {
      connect: async () => pool.connect(),
      end: async () => pool.end(),
    }
    transactions = new ScopedPostgresTransactionRunner(postgresPool)
    await pool.query(`
      INSERT INTO mbox.tenants(id, code, name)
      VALUES ($1::uuid, 'notification-tenant', 'Notification Tenant')
    `, [scope.tenantId])
    await pool.query(`
      INSERT INTO mbox.stores(id, tenant_id, code, name)
      VALUES ($1::uuid, $2::uuid, 'notification-store', 'Notification Store')
    `, [scope.storeId, scope.tenantId])
    await pool.query(`
      INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'notify-employee', 'Notification Employee')
    `, [employeeId, scope.tenantId, scope.storeId])
    await pool.query(`
      INSERT INTO mbox.notifications (
        tenant_id, store_id, business_key, channel, recipient_type,
        recipient_id, template_code, payload, max_attempts
      )
      SELECT $1::uuid, $2::uuid, 'notification:concurrency:' || sequence,
        'in_app', 'employee', $3, 'service.ready',
        jsonb_build_object('tableCode', 'VIP1', 'sequence', sequence), 3
      FROM generate_series(1, 12) AS sequence
    `, [scope.tenantId, scope.storeId, employeeId])
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('lets concurrent workers claim disjoint rows and keeps one delivery per business key', async () => {
    const deliveredKeys: string[] = []
    const deliver = async (request: { idempotencyKey: string }) => {
      deliveredKeys.push(request.idempotencyKey)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const worker = new NotificationWorker(transactions)
    const [left, right] = await Promise.all([
      worker.runBatch(scope, 'notification-worker-left', deliver, { limit: 6 }),
      worker.runBatch(scope, 'notification-worker-right', deliver, { limit: 6 }),
    ])

    expect(left.claimed + right.claimed).toBe(12)
    expect(new Set(deliveredKeys).size).toBe(12)
    const evidence = await pool.query<{ delivered: string; duplicate_keys: string }>(`
      SELECT
        count(*) FILTER (WHERE status = 'delivered')::text AS delivered,
        (count(*) - count(DISTINCT business_key))::text AS duplicate_keys
      FROM mbox.notifications
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [scope.tenantId, scope.storeId])
    expect(evidence.rows[0]).toEqual({ delivered: '12', duplicate_keys: '0' })
  })

  it('materializes a repeated outbox event once by business key', async () => {
    const sourceOutboxId = '20000000-0000-4000-8000-000000000004'
    await pool.query(`
      INSERT INTO mbox.outbox_messages (
        id, tenant_id, store_id, message_key, aggregate_type, aggregate_id,
        aggregate_version, message_type, payload
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, 'notification-source-event-0001',
        'service_task', $3::uuid, 1, 'service.ready.v1', '{"tableCode":"VIP1"}'::jsonb
      )
    `, [sourceOutboxId, scope.tenantId, scope.storeId])
    const input = {
      sourceOutboxMessageId: sourceOutboxId,
      channel: 'in_app' as const,
      recipient: { type: 'employee' as const, id: employeeId },
      templateCode: 'service.ready',
      payload: { tableCode: 'VIP1' },
      availableAt: '2099-01-01T00:00:00.000Z',
    }
    const first = await transactions.run(scope, (transaction) => (
      new NotificationRepository(transaction).materializeFromOutbox(input)
    ))
    const replay = await transactions.run(scope, (transaction) => (
      new NotificationRepository(transaction).materializeFromOutbox(input)
    ))

    expect(replay.id).toBe(first.id)
    const evidence = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM mbox.notifications
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND business_key = $3
    `, [scope.tenantId, scope.storeId, first.businessKey])
    expect(evidence.rows[0]?.count).toBe('1')
  })

  it('persists only a stable failure code and reaches dead at the configured attempt limit', async () => {
    const id = '20000000-0000-4000-8000-000000000005'
    const sampleMobile = ['138', '0013', '8000'].join('')
    await pool.query(`
      INSERT INTO mbox.notifications (
        id, tenant_id, store_id, business_key, channel, recipient_type,
        recipient_id, template_code, payload, max_attempts
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, 'notification:dead:privacy-1',
        'in_app', 'employee', $4, 'service.failed', '{"tableCode":"VIP2"}'::jsonb, 1
      )
    `, [id, scope.tenantId, scope.storeId, employeeId])
    const result = await new NotificationWorker(transactions).runBatch(
      scope,
      'notification-worker-dead-test',
      async () => { throw new Error(`upstream exposed mobile=${sampleMobile} with private credential`) },
      { limit: 1 },
    )

    expect(result.dead).toEqual([id])
    const evidence = await pool.query<{ status: string; last_error: string; payload: string }>(`
      SELECT status, last_error, payload::text
      FROM mbox.notifications
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [scope.tenantId, scope.storeId, id])
    expect(evidence.rows[0]).toMatchObject({ status: 'dead', last_error: 'delivery_failed:unknown' })
    expect(JSON.stringify(evidence.rows[0])).not.toContain(sampleMobile)
    expect(JSON.stringify(evidence.rows[0])).not.toContain('private credential')
  })

  it('keeps delivered notification content and terminal state immutable in PostgreSQL', async () => {
    const delivered = await pool.query<{ id: string }>(`
      SELECT id
      FROM mbox.notifications
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND status = 'delivered'
      LIMIT 1
    `, [scope.tenantId, scope.storeId])
    const id = delivered.rows[0]?.id
    expect(id).toBeDefined()
    await expect(pool.query(`
      UPDATE mbox.notifications SET status = 'failed', delivered_at = NULL
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [scope.tenantId, scope.storeId, id])).rejects.toMatchObject({ code: '55000' })
    await expect(pool.query(`
      DELETE FROM mbox.notifications
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [scope.tenantId, scope.storeId, id])).rejects.toMatchObject({ code: '55000' })
  })
})

function notificationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '30000000-0000-4000-8000-000000000001',
    business_key: 'service:task-42:completed:employee-3',
    channel: 'in_app',
    recipient_type: 'employee',
    recipient_id: employeeId,
    template_code: 'service.completed',
    payload: { tableCode: 'VIP1' },
    attempts: 1,
    max_attempts: 5,
    ...overrides,
  }
}

function response(rows: Record<string, unknown>[], rowCount = rows.length): Response {
  return { rows, rowCount }
}
