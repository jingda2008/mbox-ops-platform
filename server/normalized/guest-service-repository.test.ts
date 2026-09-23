import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  GuestServiceFeedbackStateError,
  GuestServiceRepository,
  GuestServiceRequestNotFoundError,
  GuestServiceSessionUnavailableError,
  serviceMergeKey,
} from './guest-service-repository.js'
import { ServiceTaskRepository } from './service-task-repository.js'
import { seedActiveGuestTableAuthority } from './guest-table-authority.test-helper.js'
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
  const guestActorRefs=new Map<string,string>()
  const relatedOrderId = randomUUID()
  const relatedOrderPublicId = `gs-order-${relatedOrderId.slice(0,8)}`

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
    guestActorRefs.set(customerId,await seedActiveGuestTableAuthority(pool,{
      tenantId,storeId,tableSessionId,customerId,
    }))
    guestActorRefs.set(otherCustomerId,await seedActiveGuestTableAuthority(pool,{
      tenantId,storeId,tableSessionId,customerId:otherCustomerId,
    }))
    await pool.query(`
      INSERT INTO mbox.orders(
        id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
        subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency
      ) VALUES ($1,$2,$3,$4,$5,'guest_qr','submitted','unpaid',0,0,0,'CNY')
    `, [relatedOrderId,tenantId,storeId,tableSessionId,relatedOrderPublicId])
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
        actorRef: guestActorRefs.get(requestCustomerId)!,
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
        actorRef: guestActorRefs.get(customerId)!,
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

  it('lists only the current table service state and records idempotent guest feedback', async () => {
    const employeeId = randomUUID()
    const approverEmployeeId = randomUUID()
    await pool.query(`
      INSERT INTO mbox.employees (id, tenant_id, store_id, employee_code, display_name)
      VALUES
        ($1::uuid, $2::uuid, $3::uuid, $4, '李艳'),
        ($5::uuid, $2::uuid, $3::uuid, $6, '服务名审批人')
    `, [
      employeeId, tenantId, storeId, `GS-${employeeId.slice(0, 8)}`,
      approverEmployeeId, `GS-APPROVER-${approverEmployeeId.slice(0, 8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.employee_customer_public_profiles(
        tenant_id,store_id,employee_id,public_display_name,status,
        drafted_by_employee_id,approved_by_employee_id,approved_at,effective_at,approval_reference
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,'李艳','published',$3::uuid,$4::uuid,clock_timestamp(),clock_timestamp(),$5)
    `, [tenantId, storeId, employeeId, approverEmployeeId, 'HR-TEST-APPROVAL-001'])
    await pool.query(`
      UPDATE mbox.service_tasks
      SET assigned_employee_id = $4::uuid, detail = '内部备注不得对客显示'
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND table_session_id = $3::uuid AND status = 'pending'
    `, [tenantId, storeId, tableSessionId, employeeId])

    const visible = await transactions.run({ tenantId, storeId }, (transaction) => (
      new GuestServiceRepository(transaction).listOwned(tableSessionId, otherCustomerId)
    ), { readOnly: true })
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({
      requestType: 'call_staff',
      status: 'pending',
      publicServiceName: '李艳',
      requestCount: 4,
    })
    expect(visible[0]).not.toHaveProperty('detail')
    const publicId = visible[0]!.publicId

    const escalate = () => transactions.run({ tenantId, storeId }, (transaction) => (
      new GuestServiceRepository(transaction).feedback({
        tableSessionId,
        customerId: otherCustomerId,
        actorRef:guestActorRefs.get(otherCustomerId)!,
        publicId,
        action: 'escalate',
      })
    ))
    await expect(escalate()).resolves.toMatchObject({ action: 'escalate', changed: true })
    await expect(escalate()).resolves.toMatchObject({ action: 'escalate', changed: false })
    await expect(transactions.run({ tenantId, storeId }, (transaction) => (
      new GuestServiceRepository(transaction).feedback({
        tableSessionId,
        customerId,
        actorRef:guestActorRefs.get(customerId)!,
        publicId,
        action: 'confirm',
      })
    ))).rejects.toBeInstanceOf(GuestServiceFeedbackStateError)

    const active = await transactions.run({ tenantId, storeId }, (transaction) => (
      new ServiceTaskRepository(transaction).findActiveByTableSession(tableSessionId)
    ), { readOnly: true })
    expect(active[0]).toMatchObject({ publicId, priority: 'urgent' })
    await transactions.run({ tenantId, storeId }, (transaction) => (
      new ServiceTaskRepository(transaction).complete({
        taskId: active[0]!.id,
        actor: { type: 'system' },
        eventIdempotencyKey: 'guest-feedback-complete-0001',
      })
    ))
    const confirm = () => transactions.run({ tenantId, storeId }, (transaction) => (
      new GuestServiceRepository(transaction).feedback({
        tableSessionId,
        customerId,
        actorRef:guestActorRefs.get(customerId)!,
        publicId,
        action: 'confirm',
      })
    ))
    await expect(confirm()).resolves.toMatchObject({ action: 'confirm', changed: true, taskStatus: 'completed' })
    await expect(confirm()).resolves.toMatchObject({ action: 'confirm', changed: false })

    await expect(transactions.run({ tenantId, storeId }, (transaction) => (
      new GuestServiceRepository(transaction).feedback({
        tableSessionId,
        customerId: randomUUID(),
        actorRef:guestActorRefs.get(customerId)!,
        publicId,
        action: 'confirm',
      })
    ))).rejects.toBeInstanceOf(GuestServiceRequestNotFoundError)

    const evidence = await pool.query<{ escalations: string; confirmations: string }>(`
      SELECT
        count(*) FILTER (WHERE event_type = 'guest.escalated')::text AS escalations,
        count(*) FILTER (WHERE event_type = 'guest.confirmed')::text AS confirmations
      FROM mbox.service_task_events AS event
      JOIN mbox.service_tasks AS task ON task.id = event.service_task_id
      WHERE event.tenant_id = $1::uuid AND event.store_id = $2::uuid
        AND task.public_id = $3
    `, [tenantId, storeId, publicId])
    expect(evidence.rows[0]).toEqual({ escalations: '1', confirmations: '1' })
  })

  it('binds a complaint to an authoritative order from the same table only', async () => {
    const result = await transactions.run({ tenantId,storeId }, (transaction) => (
      new GuestServiceRepository(transaction, { deviceLimitPerMinute:20,tableLimitPerMinute:40 }).request({
        tableSessionId,customerId,actorRef:guestActorRefs.get(customerId)!,
        deviceFingerprint:'wechat-device-order-complaint',requestType:'complaint',
        detail:'这笔订单需要值班经理协助',relatedOrderPublicId,
      })
    ))
    expect(result).toMatchObject({ status:'created',workflow:'manager_attention' })
    const stored = await pool.query<{ related_order_id:string; request_type:string }>(`
      SELECT related_order_id::text,request_type FROM mbox.guest_service_request_groups
      WHERE tenant_id=$1 AND store_id=$2 AND current_service_task_id=$3
    `, [tenantId,storeId,result.status==='rate_limited'?null:result.task.id])
    expect(stored.rows[0]).toEqual({ related_order_id:relatedOrderId,request_type:'complaint' })

    await expect(transactions.run({ tenantId,storeId }, (transaction) => (
      new GuestServiceRepository(transaction).request({
        tableSessionId,customerId,actorRef:guestActorRefs.get(customerId)!,
        deviceFingerprint:'wechat-device-forged-order-complaint',requestType:'complaint',
        detail:'伪造订单关联',relatedOrderPublicId:'order-does-not-exist',
      })
    ))).rejects.toBeInstanceOf(GuestServiceRequestNotFoundError)
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
        actorRef: guestActorRefs.get(customerId)!,
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
        actorRef: guestActorRefs.get(customerId)!,
        deviceFingerprint: 'wechat-device-service-after-close',
        requestType: 'complaint',
      })
    ))).rejects.toBeInstanceOf(GuestServiceRequestNotFoundError)

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
