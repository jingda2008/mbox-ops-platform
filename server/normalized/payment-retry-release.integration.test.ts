import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { listTablePaymentOrdersForSession } from './commerce-kds-api.js'
import { PaymentCommandService } from './payment-command-service.js'
import { PaymentRepository } from './payment-repository.js'
import type { PaymentCapabilityAuthorizationPort } from './payment-security-policy.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const allowRetryRelease: PaymentCapabilityAuthorizationPort = {
  assertEmployeeCapability: async () => undefined,
  assertEmployeeOrderAccess: async () => undefined,
  assertRefundRequestLimit: async () => undefined,
  assertRefundApproval: async () => undefined,
}

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

  it('keeps a legacy unresolved online attempt auditable but does not let it unlock a replacement payment', async () => {
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
    await expect(runner.run({ tenantId, storeId }, (transaction) =>
      new PaymentRepository(transaction).createForOrder({
        orderId,
        publicId: `retry-replacement-${randomUUID()}`,
        provider: 'postar',
        method: 'native_qr',
        principal: { type: 'employee', employeeId },
      }))).rejects.toThrow('another payment is already pending')
    await expect(runner.run({ tenantId, storeId }, (transaction) =>
      new PaymentRepository(transaction).releaseUnresolvedForRetry({
        paymentId: firstPaymentId,
        employeeId,
        reason: '重复释放同一笔未到账支付',
        idempotencyKey: `retry-release-again:${randomUUID()}`,
      }))).rejects.toThrow('already released')

    expect(released.retryReleasedAt).toBeTruthy()
    expect(released.status).toBe('pending')
    const payments = await pool.query<{
      id: string; status: string; retry_released_at: string | null
    }>(`SELECT id,status,retry_released_at::text FROM mbox.payments WHERE order_id=$1 ORDER BY created_at,id`, [orderId])
    expect(payments.rows).toEqual(expect.arrayContaining([
      { id: firstPaymentId, status: 'pending', retry_released_at: expect.any(String) },
    ]))
  })

  it('returns the exact unresolved payment id used by the table collection sheet', async () => {
    const sessionId = randomUUID()
    const routeTableId = randomUUID()
    const orderId = randomUUID()
    const paymentId = randomUUID()
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,$5,$5,4)`, [
      routeTableId, tenantId, storeId, areaId, `PV${randomUUID().slice(0, 6)}`,
    ])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id
    ) SELECT $1,$2,$3,$4,$5,
      ((clock_timestamp() AT TIME ZONE timezone)-business_day_cutoff)::date,
      2,4,'open',$6 FROM mbox.stores WHERE tenant_id=$2 AND id=$3`, [
      sessionId, tenantId, storeId, routeTableId, `payment-view-session-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_employee_id,submitted_at
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','pending',2000,0,2000,'CNY',$6,clock_timestamp())`, [
      orderId, tenantId, storeId, sessionId, `payment-view-order-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status
    ) VALUES($1,$2,$3,$4,$5,'postar','native_qr',2000,'CNY','pending')`, [
      paymentId, tenantId, storeId, orderId, `payment-view-attempt-${randomUUID()}`,
    ])

    const result = await runner.run({ tenantId, storeId }, (transaction) => (
      listTablePaymentOrdersForSession(transaction, sessionId)
    ), { readOnly: true })

    expect(result).toEqual([expect.objectContaining({
      id: orderId,
      outstandingAmountMinor: 2_000,
      hasOnlinePaymentInProgress: true,
      unresolvedOnlinePaymentId: paymentId,
    })])
  })

  it('shows a fully refunded order only after an explicit recollection authorization', async () => {
    const sessionId = randomUUID()
    const routeTableId = randomUUID()
    const orderId = randomUUID()
    const paymentId = randomUUID()
    const refundId = randomUUID()
    const approverId = randomUUID()
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,$4,'退款复核员')`, [
      approverId, tenantId, storeId, `refund-approver-${randomUUID().slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,$5,$5,4)`, [
      routeTableId, tenantId, storeId, areaId, `RV${randomUUID().slice(0, 6)}`,
    ])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id
    ) SELECT $1,$2,$3,$4,$5,
      ((clock_timestamp() AT TIME ZONE timezone)-business_day_cutoff)::date,
      2,4,'open',$6 FROM mbox.stores WHERE tenant_id=$2 AND id=$3`, [
      sessionId, tenantId, storeId, routeTableId, `recollect-view-session-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_employee_id,submitted_at
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','refunded',2000,0,2000,'CNY',$6,clock_timestamp())`, [
      orderId, tenantId, storeId, sessionId, `recollect-view-order-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,
      amount_minor,currency,status,succeeded_at
    ) VALUES($1,$2,$3,$4,$5,'postar',$6,'native_qr',2000,'CNY','refunded',clock_timestamp())`, [
      paymentId, tenantId, storeId, orderId, `recollect-view-payment-${randomUUID()}`,
      `provider-payment-${randomUUID()}`,
    ])
    await pool.query(`INSERT INTO mbox.refunds(
      id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,status,
      reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at
    ) VALUES($1,$2,$3,$4,$5,$6,2000,'CNY','succeeded','顾客更换支付方式',$7,$8,'同意退款',clock_timestamp())`, [
      refundId, tenantId, storeId, paymentId, `recollect-view-refund-${randomUUID()}`,
      `provider-refund-${randomUUID()}`, employeeId, approverId,
    ])

    const beforeAuthorization = await runner.run({ tenantId, storeId }, (transaction) => (
      listTablePaymentOrdersForSession(transaction, sessionId)
    ), { readOnly: true })
    expect(beforeAuthorization).toEqual([])

    await pool.query(`INSERT INTO mbox.order_recollection_authorizations(
      tenant_id,store_id,public_id,order_id,amount_minor,currency,status,reason,
      authorized_by_employee_id,expires_at
    ) VALUES($1,$2,$3,$4,2000,'CNY','active','退款后仍需重新收款',$5,clock_timestamp()+interval '15 minutes')`, [
      tenantId, storeId, `recollect-view-auth-${randomUUID()}`, orderId, employeeId,
    ])
    const afterAuthorization = await runner.run({ tenantId, storeId }, (transaction) => (
      listTablePaymentOrdersForSession(transaction, sessionId)
    ), { readOnly: true })

    expect(afterAuthorization).toEqual([expect.objectContaining({
      id: orderId,
      paymentStatus: 'refunded',
      outstandingAmountMinor: 2_000,
      hasOnlinePaymentInProgress: false,
      unresolvedOnlinePaymentId: null,
    })])
  })

  it('commits a bounded outbox key when a maximum-length idempotency key releases an unresolved payment', async () => {
    const sessionId = randomUUID()
    const retryTableId = randomUUID()
    const orderId = randomUUID()
    const paymentId = randomUUID()
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,$5,$5,4)`, [
      retryTableId, tenantId, storeId, areaId, `PR${randomUUID().slice(0, 6)}`,
    ])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id
    ) SELECT $1,$2,$3,$4,$5,
      ((clock_timestamp() AT TIME ZONE timezone)-business_day_cutoff)::date,
      2,4,'open',$6 FROM mbox.stores WHERE tenant_id=$2 AND id=$3`, [
      sessionId, tenantId, storeId, retryTableId, `retry-command-session-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_employee_id,submitted_at
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','pending',8800,0,8800,'CNY',$6,clock_timestamp())`, [
      orderId, tenantId, storeId, sessionId, `retry-command-order-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status
    ) VALUES($1,$2,$3,$4,$5,'postar','native_qr',8800,'CNY','pending')`, [
      paymentId, tenantId, storeId, orderId, `retry-command-payment-${randomUUID()}`,
    ])

    const service = new PaymentCommandService(
      new NormalizedCommandExecutor(runner),
      allowRetryRelease,
    )
    const idempotencyKey = `retry-${'x'.repeat(122)}`
    const execution = await service.releaseUnresolvedForRetry({
      scope: { tenantId, storeId },
      actor: { type: 'employee', employeeId },
      businessDate: '2026-08-26',
      idempotencyKey,
      requestFingerprint: JSON.stringify({ paymentId, reason: '顾客未确认到账，重新发起收款' }),
      paymentId,
      reason: '顾客未确认到账，重新发起收款',
    })

    expect(execution.replayed).toBe(false)
    const outbox = await pool.query<{ message_key: string; aggregate_id: string; message_type: string }>(`
      SELECT message_key, aggregate_id, message_type
      FROM mbox.outbox_messages
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND aggregate_id=$3::uuid
        AND message_type='payment.unresolved_retry_released.v1'
    `, [tenantId, storeId, paymentId])
    expect(outbox.rows).toEqual([{
      message_key: `payment:unresolved-retry-release:${paymentId}`,
      aggregate_id: paymentId,
      message_type: 'payment.unresolved_retry_released.v1',
    }])
    expect(outbox.rows[0]?.message_key.length).toBeLessThanOrEqual(160)
  })
})
