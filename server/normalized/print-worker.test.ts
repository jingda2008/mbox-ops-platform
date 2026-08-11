import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { PrintWorker } from './print-worker.js'
import { ScopedPostgresTransactionRunner, type PostgresPool, type ScopedTransaction, type StoreScope } from './transaction-runner.js'

const scope = {
  tenantId: '26100000-0000-4000-8000-000000000001',
  storeId: '26100000-0000-4000-8000-000000000002',
}

class ScriptedTransactions {
  readonly statements: string[] = []
  constructor(private readonly responses: Array<{ rows: Record<string, unknown>[]; rowCount: number }>) {}
  async run<Result>(
    currentScope: Readonly<StoreScope>,
    operation: (transaction: ScopedTransaction) => Promise<Result>,
  ) {
    return operation({
      scope: currentScope,
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        this.statements.push(sql.replace(/\s+/g, ' ').trim())
        const response = this.responses.shift()
        if (!response) throw new Error('Unexpected query')
        return response as { rows: Row[]; rowCount: number }
      },
    })
  }
}

describe('PrintWorker', () => {
  it('claims at most 50 jobs with SKIP LOCKED and prints the immutable snapshot', async () => {
    const transactions = new ScriptedTransactions([
      response([jobRow()]), response([], 1), response([], 1),
    ])
    const print = vi.fn().mockResolvedValue(undefined)
    const result = await new PrintWorker(transactions).runBatch(scope, 'print-worker-01', { print })

    expect(result).toEqual({
      claimed: 1,
      printed: ['26100000-0000-4000-8000-000000000010'],
      retrying: [], dead: [], lost: [],
    })
    expect(print).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'print-job-business-key-0001',
      printSnapshot: { tableCode: 'VIP1', productName: '精酿啤酒', note: '少冰' },
      containsPriorityNote: true,
    }))
    expect(transactions.statements[0]).toContain('FOR UPDATE SKIP LOCKED')
    expect(transactions.statements[0]).toContain('LIMIT $4')
  })

  it('keeps an offline-device job visible for retry without calling the adapter', async () => {
    const transactions = new ScriptedTransactions([
      response([jobRow({ connectivity_status: 'offline' })]), response([], 1), response([], 1),
    ])
    const print = vi.fn()
    const result = await new PrintWorker(transactions).runBatch(
      scope, 'print-worker-02', { print }, { retryDelayMs: 1_000 },
    )

    expect(print).not.toHaveBeenCalled()
    expect(result.retrying).toEqual(['26100000-0000-4000-8000-000000000010'])
    expect(transactions.statements[1]).toContain("'failed'")
  })
})

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('PrintWorker PostgreSQL concurrency', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id, code, name) VALUES ($1, 'print-worker-tenant', 'Print Worker Tenant')`, [scope.tenantId])
    await pool.query(`INSERT INTO mbox.stores(id, tenant_id, code, name) VALUES ($1, $2, 'print-worker-store', 'Print Worker Store')`, [scope.storeId, scope.tenantId])
    const printerId = '26100000-0000-4000-8000-000000000003'
    const routeId = '26100000-0000-4000-8000-000000000004'
    const outboxId = '26100000-0000-4000-8000-000000000005'
    await pool.query(`
      INSERT INTO mbox.devices(id, tenant_id, store_id, code, name, device_type, station_code, connectivity_status)
      VALUES ($1, $2, $3, 'worker-printer', '并发打印机', 'printer', 'bar', 'online')
    `, [printerId, scope.tenantId, scope.storeId])
    await pool.query(`
      INSERT INTO mbox.printer_routes(id, tenant_id, store_id, code, name, station_code, printer_device_id)
      VALUES ($1, $2, $3, 'worker-route', '并发路由', 'bar', $4)
    `, [routeId, scope.tenantId, scope.storeId, printerId])
    await pool.query(`
      INSERT INTO mbox.outbox_messages(
        id, tenant_id, store_id, message_key, aggregate_type, aggregate_id,
        aggregate_version, message_type, payload
      ) VALUES ($1, $2, $3, 'print-worker-outbox-0001', 'order', $4, 1,
        'order.submitted.v1', '{}'::jsonb)
    `, [outboxId, scope.tenantId, scope.storeId, printerId])
    await pool.query(`
      INSERT INTO mbox.print_jobs(
        tenant_id, store_id, business_key, source_outbox_message_id,
        printer_route_id, printer_device_id, station_code, source_type,
        source_reference, print_snapshot
      )
      SELECT $1, $2, 'print-worker-job-' || sequence, $3, $4, $5, 'bar', 'order',
        'order-' || sequence, jsonb_build_object('sequence', sequence, 'tableCode', 'VIP1')
      FROM generate_series(1, 12) AS sequence
    `, [scope.tenantId, scope.storeId, outboxId, routeId, printerId])
  })

  afterAll(async () => pool?.end())

  it('lets concurrent workers claim disjoint jobs exactly once', async () => {
    const keys: string[] = []
    const adapter = { print: async ({ idempotencyKey }: { idempotencyKey: string }) => {
      keys.push(idempotencyKey)
      await new Promise((resolve) => setTimeout(resolve, 3))
    } }
    const worker = new PrintWorker(transactions)
    const [left, right] = await Promise.all([
      worker.runBatch(scope, 'print-worker-left', adapter, { limit: 6 }),
      worker.runBatch(scope, 'print-worker-right', adapter, { limit: 6 }),
    ])
    expect(left.claimed + right.claimed).toBe(12)
    expect(new Set(keys).size).toBe(12)
    const evidence = await pool.query<{ printed: string; events: string }>(`
      SELECT
        count(*) FILTER (WHERE status = 'printed')::text AS printed,
        (SELECT count(*)::text FROM mbox.print_job_events
          WHERE tenant_id = $1 AND store_id = $2 AND event_type = 'printed') AS events
      FROM mbox.print_jobs WHERE tenant_id = $1 AND store_id = $2
    `, [scope.tenantId, scope.storeId])
    expect(evidence.rows[0]).toEqual({ printed: '12', events: '12' })
  })
})

function response(rows: Record<string, unknown>[], rowCount = rows.length) {
  return { rows, rowCount }
}

function jobRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '26100000-0000-4000-8000-000000000010',
    business_key: 'print-job-business-key-0001',
    printer_device_id: '26100000-0000-4000-8000-000000000011',
    printer_code: 'bar-printer',
    connectivity_status: 'online',
    station_code: 'bar',
    copies: 1,
    print_snapshot: { tableCode: 'VIP1', productName: '精酿啤酒', note: '少冰' },
    contains_priority_note: true,
    attempts: 1,
    max_attempts: 8,
    ...overrides,
  }
}
