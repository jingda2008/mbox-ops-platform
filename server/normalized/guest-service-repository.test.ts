import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  GuestServiceRepository,
  GuestServiceSessionUnavailableError,
  serviceMergeKey,
} from './guest-service-repository.js'
import { ServiceTaskRepository } from './service-task-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type PostgresPoolClient,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

describe('guest service merge identity', () => {
  it('normalizes whitespace and case for custom request merging', () => {
    expect(serviceMergeKey('custom', ' 两 杯  温水 '))
      .toBe(serviceMergeKey('custom', '两 杯 温水'))
    expect(serviceMergeKey('custom', '两杯温水'))
      .not.toBe(serviceMergeKey('custom', '需要生日服务'))
  })
})

integration('normalized guest service requests with PostgreSQL', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let tenantId: string
  let storeId: string
  let tableSessionId: string
  let customerId: string
  let otherCustomerId: string

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 12 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    tenantId = randomUUID()
    storeId = randomUUID()
    customerId = randomUUID()
    otherCustomerId = randomUUID()
    const areaId = randomUUID()
    const tableId = randomUUID()
    tableSessionId = randomUUID()
    await pool.query(
      `INSERT INTO mbox.tenants (id, code, name) VALUES ($1::uuid, $2, 'Guest service tenant')`,
      [tenantId, `gs-tenant-${tenantId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.stores (id, tenant_id, code, name, timezone, business_day_cutoff)
       VALUES ($1::uuid, $2::uuid, $3, 'Guest service store', 'Asia/Shanghai', '06:00')`,
      [storeId, tenantId, `gs-store-${storeId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'GS', 'Guest service', 'indoor')`,
      [areaId, tenantId, storeId],
    )
    await pool.query(
      `INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity, qr_version)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'VIP2', 'VIP 2', 6, 1)`,
      [tableId, tenantId, storeId, areaId],
    )
    await pool.query(
      `INSERT INTO mbox.customers (id, tenant_id, store_id, public_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      [customerId, tenantId, storeId, `gs-customer-${customerId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.customers (id, tenant_id, store_id, public_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      [otherCustomerId, tenantId, storeId, `gs-customer-${otherCustomerId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.table_sessions (
         id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, DATE '2026-08-11', 2, 'open')`,
      [tableSessionId, tenantId, storeId, tableId, `gs-session-${tableSessionId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.table_session_customers (
         tenant_id, store_id, table_session_id, customer_id, relationship
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'primary')`,
      [tenantId, storeId, tableSessionId, customerId],
    )
    await pool.query(
      `INSERT INTO mbox.table_session_customers (
         tenant_id, store_id, table_session_id, customer_id, relationship
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'guest')`,
      [tenantId, storeId, tableSessionId, otherCustomerId],
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('merges concurrent duplicate clicks into one service task', async () => {
    const request = (requestCustomerId: string) => transactions.run({ tenantId, storeId }, (transaction) => (
      new GuestServiceRepository(transaction, {
        deviceLimitPerMinute: 20,
        tableLimitPerMinute: 40,
      }).request({
        tableSessionId,
        customerId: requestCustomerId,
        actorRef: 'guest-session:service-concurrency-test',
        deviceFingerprint: 'wechat-device-service-concurrency-0001',
        requestType: 'call_staff',
      })
    ), { isolation: 'serializable', retryOnConflict: 3 })
    const results = await Promise.all([request(customerId), request(otherCustomerId), request(customerId)])
    expect(results.filter((result) => result.status === 'created')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'merged')).toHaveLength(2)

    const counts = await pool.query<{ tasks: string; groups: string; requests: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.service_tasks
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND table_session_id = $3::uuid AND task_type = 'guest.call_staff') AS tasks,
        (SELECT count(*)::text FROM mbox.guest_service_request_groups
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND table_session_id = $3::uuid) AS groups,
        (SELECT request_count::text FROM mbox.guest_service_request_groups
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND table_session_id = $3::uuid LIMIT 1) AS requests
    `, [tenantId, storeId, tableSessionId])
    expect(counts.rows[0]).toEqual({ tasks: '1', groups: '1', requests: '3' })
  })

  it('creates a new task after the prior merged task is completed', async () => {
    const first = await transactions.run({ tenantId, storeId }, (transaction) => (
      new ServiceTaskRepository(transaction).findActiveByTableSession(tableSessionId)
    ), { readOnly: true })
    expect(first).toHaveLength(1)
    await transactions.run({ tenantId, storeId }, (transaction) => (
      new ServiceTaskRepository(transaction).complete({
        taskId: first[0]!.id,
        actor: { type: 'system' },
        note: '现场已完成',
        eventIdempotencyKey: 'guest-service-complete-0001',
      })
    ))
    const next = await transactions.run({ tenantId, storeId }, (transaction) => (
      new GuestServiceRepository(transaction, {
        deviceLimitPerMinute: 20,
        tableLimitPerMinute: 40,
      }).request({
        tableSessionId,
        customerId,
        actorRef: 'guest-session:service-concurrency-test',
        deviceFingerprint: 'wechat-device-service-concurrency-0001',
        requestType: 'call_staff',
      })
    ))
    expect(next.status).toBe('created')
    const count = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM mbox.service_tasks
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND table_session_id = $3::uuid AND task_type = 'guest.call_staff'
    `, [tenantId, storeId, tableSessionId])
    expect(count.rows[0]?.count).toBe('2')
  })

  it('enforces both persisted device limits and table-session invalidation', async () => {
    const limitedDevice = 'wechat-device-service-limited-0002'
    const request = () => transactions.run({ tenantId, storeId }, (transaction) => (
      new GuestServiceRepository(transaction, {
        deviceLimitPerMinute: 1,
        tableLimitPerMinute: 40,
      }).request({
        tableSessionId,
        customerId,
        actorRef: 'guest-session:service-limit-test',
        deviceFingerprint: limitedDevice,
        requestType: 'custom',
        detail: '需要两杯温水',
      })
    ))
    await expect(request()).resolves.toMatchObject({ status: 'created' })
    await expect(request()).resolves.toMatchObject({ status: 'rate_limited', dimension: 'device' })

    await pool.query(`
      UPDATE mbox.table_sessions SET status = 'closing'
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [tenantId, storeId, tableSessionId])
    await expect(transactions.run({ tenantId, storeId }, (transaction) => (
      new GuestServiceRepository(transaction).request({
        tableSessionId,
        customerId,
        actorRef: 'guest-session:service-after-close',
        deviceFingerprint: 'wechat-device-service-after-close',
        requestType: 'complaint',
      })
    ))).rejects.toBeInstanceOf(GuestServiceSessionUnavailableError)

    const history = await pool.query<{ groups: string; rate_windows: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.guest_service_request_groups
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND table_session_id = $3::uuid) AS groups,
        (SELECT count(*)::text FROM mbox.guest_request_rate_limits
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS rate_windows
    `, [tenantId, storeId, tableSessionId])
    expect(Number(history.rows[0]?.groups)).toBeGreaterThan(0)
    expect(Number(history.rows[0]?.rate_windows)).toBeGreaterThan(0)
  })
})

function asPool(pool: Pool): PostgresPool {
  return {
    connect: async () => asClient(await pool.connect()),
    end: async () => pool.end(),
  }
}

function asClient(client: PoolClient): PostgresPoolClient {
  return {
    query: (text, values) => client.query(text, values === undefined ? undefined : [...values]),
    release: (error) => client.release(error),
  }
}
