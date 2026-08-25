import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { PaymentRepository } from './payment-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('unresolved payment retry release', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const employeeId = randomUUID()
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Payment retry tenant')`, [
      tenantId, `retry-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Payment retry store')`, [
      storeId, tenantId, `retry-${storeId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
      VALUES($1,$2,$3,'MAIN','主区','indoor')`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,'P01','P01',4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,'cashier','收银员')`, [employeeId, tenantId, storeId])
  })

  afterAll(async () => { await pool?.end() })

  it('keeps the first unresolved online attempt, then permits exactly one replacement attempt', async () => {
    const sessionId = randomUUID()
    const orderId = randomUUID()
    const firstPaymentId = randomUUID()
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id
    ) SELECT $1,$2,$3,$4,$5,
      ((clock_timestamp() AT TIME ZONE timezone)-business_day_cutoff)::date,
      2,4,'open',$6 FROM mbox.stores WHERE tenant_id=$2 AND id=$3`, [
      sessionId, tenantId, storeId, tableId, `retry-session-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_employee_id,submitted_at
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','pending',8800,0,8800,'CNY',$6,clock_timestamp())`, [
      orderId, tenantId, storeId, sessionId, `retry-order-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status
    ) VALUES($1,$2,$3,$4,$5,'postar','native_qr',8800,'CNY','pending')`, [
      firstPaymentId, tenantId, storeId, orderId, `retry-original-${randomUUID()}`,
    ])

    const released = await runner.run({ tenantId, storeId }, (transaction) =>
      new PaymentRepository(transaction).releaseUnresolvedForRetry({
        paymentId: firstPaymentId,
        employeeId,
        reason: '顾客未确认到账，重新出示付款二维码',
        idempotencyKey: `retry-release:${randomUUID()}`,
      }))
    const replacement = await runner.run({ tenantId, storeId }, (transaction) =>
      new PaymentRepository(transaction).createForOrder({
        orderId,
        publicId: `retry-replacement-${randomUUID()}`,
        provider: 'postar',
        method: 'native_qr',
        principal: { type: 'employee', employeeId },
      }))
    await expect(runner.run({ tenantId, storeId }, (transaction) =>
      new PaymentRepository(transaction).releaseUnresolvedForRetry({
        paymentId: firstPaymentId,
        employeeId,
        reason: '重复释放同一笔未到账支付',
        idempotencyKey: `retry-release-again:${randomUUID()}`,
      }))).rejects.toThrow('already released')

    expect(released.retryReleasedAt).toBeTruthy()
    expect(released.status).toBe('pending')
    expect(replacement.status).toBe('created')
    const payments = await pool.query<{
      id: string; status: string; retry_released_at: string | null
    }>(`SELECT id,status,retry_released_at::text FROM mbox.payments WHERE order_id=$1 ORDER BY created_at,id`, [orderId])
    expect(payments.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstPaymentId, status: 'pending', retry_released_at: expect.any(String) }),
      expect.objectContaining({ id: replacement.id, status: 'created', retry_released_at: null }),
    ]))
  })
})
