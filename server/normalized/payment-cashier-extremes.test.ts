import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor, type AuditActor } from './command-executor.js'
import { PaymentCommandService } from './payment-command-service.js'
import type { PaymentCapabilityAuthorizationPort } from './payment-security-policy.js'
import {
  NormalizedProviderObservationAuthority,
  VerifiedProviderObservationService,
} from './provider-verification-observation.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const tenantId = 'ca500000-0000-4000-8000-000000000001'
const storeId = 'ca500000-0000-4000-8000-000000000002'
const requesterId = 'ca500000-0000-4000-8000-000000000003'
const approverId = 'ca500000-0000-4000-8000-000000000004'
const cashierId = 'ca500000-0000-4000-8000-000000000005'
const areaId = 'ca500000-0000-4000-8000-000000000006'
const productId = 'ca500000-0000-4000-8000-000000000007'
const businessDate = '2026-08-12'
let providerObservationRecorder: VerifiedProviderObservationService

const allowAll: PaymentCapabilityAuthorizationPort = {
  assertEmployeeCapability: async () => undefined,
  assertEmployeeOrderAccess: async () => undefined,
  assertRefundRequestLimit: async () => undefined,
  assertRefundApproval: async () => undefined,
}

interface CashierFixture {
  orderId: string
  itemIds: string[]
  totals: number[]
  total: number
  sessionId: string
}

interface FinancialSnapshot {
  order_status: string
  payment_status: string
  gross_paid_minor: string
  refunded_minor: string
  net_minor: string
  pending_payments: string
  payment_entries: string
  refund_entries: string
  refund_entry_minor: string
}

integration('normalized cashier payment and refund extreme scenarios', () => {
  let pool: Pool
  let service: PaymentCommandService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 12 })
    const runner = new ScopedPostgresTransactionRunner(asPool(pool))
    providerObservationRecorder = new VerifiedProviderObservationService(runner)
    service = new PaymentCommandService(
      new NormalizedCommandExecutor(runner),
      allowAll,
      new NormalizedProviderObservationAuthority(),
    )
    await seedFoundation(pool)
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('refunds one selected product without changing the other product amounts', async () => {
    const fixture = await createOrder(pool, [8800, 6800, 9800])
    const payment = await captureOnlinePayment(service, fixture.orderId)
    await succeedOnlineRefund(service, payment, [allocation(fixture, 1, 6800)])

    const snapshot = await financialSnapshot(pool, fixture.orderId)
    expect(snapshot).toMatchObject({
      order_status: 'submitted',
      payment_status: 'partially_refunded',
      gross_paid_minor: '25400',
      refunded_minor: '6800',
      net_minor: '18600',
      payment_entries: '1',
      refund_entries: '1',
      refund_entry_minor: '-6800',
    })
  })

  it('supports a total-amount partial refund while preserving item-level allocation evidence', async () => {
    const fixture = await createOrder(pool, [10000, 8000])
    const payment = await captureOnlinePayment(service, fixture.orderId)
    const refund = await succeedOnlineRefund(service, payment, [
      allocation(fixture, 0, 3000),
      allocation(fixture, 1, 2000),
    ])

    expect(refund.amountMinor).toBe(5000)
    expect(refund.allocations).toEqual([
      allocation(fixture, 0, 3000),
      allocation(fixture, 1, 2000),
    ].toSorted((left, right) => left.orderItemId.localeCompare(right.orderItemId)))
    expect(await financialSnapshot(pool, fixture.orderId)).toMatchObject({
      payment_status: 'partially_refunded',
      refunded_minor: '5000',
      net_minor: '13000',
    })
  })

  it('fully refunds every order item and marks both payment and order refunded', async () => {
    const fixture = await createOrder(pool, [1, 6800, 9800])
    const payment = await captureOnlinePayment(service, fixture.orderId)
    await succeedOnlineRefund(service, payment, fixture.itemIds.map((_, index) => (
      allocation(fixture, index, fixture.totals[index]!)
    )))

    const snapshot = await financialSnapshot(pool, fixture.orderId)
    expect(snapshot).toMatchObject({
      payment_status: 'refunded',
      gross_paid_minor: String(fixture.total),
      refunded_minor: String(fixture.total),
      net_minor: '0',
    })
    const paymentStatus = await pool.query<{ status: string }>(
      'SELECT status FROM mbox.payments WHERE id=$1::uuid',
      [payment.id],
    )
    expect(paymentStatus.rows[0]?.status).toBe('refunded')
  })

  it('allows successive partial refunds to reach the exact full amount but rejects one cent over', async () => {
    const fixture = await createOrder(pool, [10000])
    const payment = await captureOnlinePayment(service, fixture.orderId)
    await succeedOnlineRefund(service, payment, [allocation(fixture, 0, 3000)])

    await expect(requestRefund(service, payment.id, [allocation(fixture, 0, 7001)]))
      .rejects.toThrow(/Cumulative refunds cannot exceed|Cumulative refund exceeds/)
    await succeedOnlineRefund(service, payment, [allocation(fixture, 0, 7000)])

    expect(await financialSnapshot(pool, fixture.orderId)).toMatchObject({
      payment_status: 'refunded',
      refunded_minor: '10000',
      net_minor: '0',
      refund_entries: '2',
      refund_entry_minor: '-10000',
    })
  })

  it('re-collects exactly the refunded amount after a partial refund and returns the order to paid', async () => {
    const fixture = await createOrder(pool, [8800, 6800])
    const original = await captureOnlinePayment(service, fixture.orderId)
    await succeedOnlineRefund(service, original, [allocation(fixture, 1, 6800)])

    const replacement = await initiateOnlinePayment(service, fixture.orderId)
    expect(replacement.amountMinor).toBe(6800)
    expect((await financialSnapshot(pool, fixture.orderId)).payment_status).toBe('pending')
    await succeedPaymentCallback(service, replacement)

    expect(await financialSnapshot(pool, fixture.orderId)).toMatchObject({
      payment_status: 'paid',
      gross_paid_minor: '22400',
      refunded_minor: '6800',
      net_minor: '15600',
      pending_payments: '0',
      payment_entries: '2',
      refund_entries: '1',
    })
  })

  it('re-collects the whole order after a full refund and blocks a second pending collection', async () => {
    const fixture = await createOrder(pool, [8800, 6800])
    const original = await captureOnlinePayment(service, fixture.orderId)
    await succeedOnlineRefund(service, original, fixture.itemIds.map((_, index) => (
      allocation(fixture, index, fixture.totals[index]!)
    )))

    const attempts = await Promise.allSettled([
      initiateOnlinePayment(service, fixture.orderId),
      initiateOnlinePayment(service, fixture.orderId),
    ])
    const succeeded = attempts.filter((attempt) => attempt.status === 'fulfilled')
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected')
    expect(succeeded).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining('already pending') }) })
    expect((succeeded[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof initiateOnlinePayment>>>).value.amountMinor)
      .toBe(fixture.total)
    expect(await financialSnapshot(pool, fixture.orderId)).toMatchObject({
      payment_status: 'pending',
      pending_payments: '1',
    })
  })

  it('returns a fully refunded order to paid after the replacement payment callback succeeds', async () => {
    const fixture = await createOrder(pool, [8800, 6800])
    const original = await captureOnlinePayment(service, fixture.orderId)
    await succeedOnlineRefund(service, original, fixture.itemIds.map((_, index) => (
      allocation(fixture, index, fixture.totals[index]!)
    )))

    const replacement = await initiateOnlinePayment(service, fixture.orderId)
    await succeedPaymentCallback(service, replacement)

    expect(await financialSnapshot(pool, fixture.orderId)).toMatchObject({
      payment_status: 'paid',
      gross_paid_minor: '31200',
      refunded_minor: '15600',
      net_minor: '15600',
      pending_payments: '0',
      payment_entries: '2',
      refund_entries: '1',
    })
  })

  it('replays an identical payment request once and rejects the same key with another fingerprint', async () => {
    const fixture = await createOrder(pool, [8800])
    const idempotencyKey = `payment-replay-${randomUUID()}`
    const input = {
      ...metadata(idempotencyKey, actor(cashierId)),
      orderId: fixture.orderId,
      publicId: `pay-${randomUUID()}`,
      provider: 'postar' as const,
      method: 'native_qr' as const,
      principal: { type: 'employee' as const, employeeId: cashierId },
    }

    const first = await service.initiate(input)
    const replay = await service.initiate(input)
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(replay.value.id).toBe(first.value.id)
    expect((await financialSnapshot(pool, fixture.orderId)).pending_payments).toBe('1')

    await expect(service.initiate({
      ...input,
      requestFingerprint: JSON.stringify({ key: idempotencyKey, changed: true }),
    })).rejects.toThrow(/Idempotency key conflicts/)
  })

  it('enforces one active payment intent at the database boundary', async () => {
    const fixture = await createOrder(pool, [8800])
    await initiateOnlinePayment(service, fixture.orderId)

    await expect(pool.query(`
      INSERT INTO mbox.payments(
        tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'postar','native_qr',8800,'CNY','pending')
    `, [tenantId, storeId, fixture.orderId, `pay-${randomUUID()}`]))
      .rejects.toMatchObject({ code: '23505', constraint: 'payments_one_active_intent_per_order_uq' })
    expect((await financialSnapshot(pool, fixture.orderId)).pending_payments).toBe('1')
  })

  it('serializes concurrent refund requests so reserved refunds cannot exceed payment or item value', async () => {
    const fixture = await createOrder(pool, [10000])
    const payment = await captureOnlinePayment(service, fixture.orderId)
    const attempts = await Promise.allSettled([
      requestRefund(service, payment.id, [allocation(fixture, 0, 7000)]),
      requestRefund(service, payment.id, [allocation(fixture, 0, 7000)]),
    ])

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    const reserved = await pool.query<{ amount: string; count: string }>(`
      SELECT COALESCE(SUM(amount_minor),0)::text AS amount, count(*)::text AS count
      FROM mbox.refunds WHERE payment_id=$1::uuid AND status='requested'
    `, [payment.id])
    expect(reserved.rows[0]).toEqual({ amount: '7000', count: '1' })
  })

  it('releases a rejected request, but keeps an approved or processing refund reserved', async () => {
    const fixture = await createOrder(pool, [10000])
    const payment = await captureOnlinePayment(service, fixture.orderId)
    const rejected = await requestRefund(service, payment.id, [allocation(fixture, 0, 7000)])
    await rejectRefund(service, rejected.id)
    const replacement = await requestRefund(service, payment.id, [allocation(fixture, 0, 10000)])
    await approveRefund(service, replacement.id)

    await expect(requestRefund(service, payment.id, [allocation(fixture, 0, 1)]))
      .rejects.toThrow(/Cumulative refunds cannot exceed|Cumulative refund exceeds/)
  })

  it('does not write money evidence for a failed provider refund and permits a fresh request', async () => {
    const fixture = await createOrder(pool, [10000])
    const payment = await captureOnlinePayment(service, fixture.orderId)
    const failed = await requestRefund(service, payment.id, [allocation(fixture, 0, 4000)])
    await approveRefund(service, failed.id)
    await executeRefund(service, failed.id)
    await recordProviderRefund(service, payment, failed, false)

    expect(await financialSnapshot(pool, fixture.orderId)).toMatchObject({
      payment_status: 'paid',
      refunded_minor: '0',
      refund_entries: '0',
    })
    await expect(executeRefund(service, failed.id)).rejects.toThrow(/requires human approval/)
    const fresh = await requestRefund(service, payment.id, [allocation(fixture, 0, 4000)])
    expect(fresh.status).toBe('requested')
  })

  it('treats duplicate successful refund callbacks as a no-op and rejects conflicting evidence', async () => {
    const fixture = await createOrder(pool, [10000])
    const payment = await captureOnlinePayment(service, fixture.orderId)
    const refund = await requestRefund(service, payment.id, [allocation(fixture, 0, 2500)])
    await approveRefund(service, refund.id)
    await executeRefund(service, refund.id)
    const providerRefundId = randomReference('postar-refund-replay')
    const first = await recordProviderRefund(service, payment, refund, true, { providerRefundId })
    const replay = await recordProviderRefund(service, payment, refund, true, { providerRefundId })
    expect(first.status).toBe('succeeded')
    expect(replay.status).toBe('succeeded')
    expect((await financialSnapshot(pool, fixture.orderId)).refund_entries).toBe('1')

    await expect(recordProviderRefund(service, payment, refund, false, { providerRefundId: randomReference('conflict') }))
      .rejects.toThrow(/terminal result conflicts|callback/)
  })

  it('rejects wrong provider amount, currency and original transaction without changing processing state', async () => {
    const fixture = await createOrder(pool, [10000])
    const payment = await captureOnlinePayment(service, fixture.orderId)
    const refund = await requestRefund(service, payment.id, [allocation(fixture, 0, 2500)])
    await approveRefund(service, refund.id)
    await executeRefund(service, refund.id)

    await expect(recordProviderRefund(service, payment, refund, true, { amountMinor: 2499 }))
      .rejects.toThrow(/amount/)
    await expect(recordProviderRefund(service, payment, refund, true, { currency: 'USD' }))
      .rejects.toThrow(/currency/)
    await expect(recordProviderRefund(service, payment, refund, true, { originalTransactionId: 'WRONG-TX' }))
      .rejects.toThrow(/original transaction/)

    const state = await pool.query<{ status: string; provider_refund_id: string | null }>(
      'SELECT status, provider_refund_id FROM mbox.refunds WHERE id=$1::uuid',
      [refund.id],
    )
    expect(state.rows[0]).toEqual({ status: 'processing', provider_refund_id: null })
    expect((await financialSnapshot(pool, fixture.orderId)).refund_entries).toBe('0')
  })

  it('records cash refund and physical-POS recollection with separate immutable references', async () => {
    const fixture = await createOrder(pool, [12800])
    const cash = await recordManualPayment(service, fixture.orderId, 'cash')
    const refund = await requestRefund(service, cash.id, [allocation(fixture, 0, 2800)])
    await approveRefund(service, refund.id)
    await executeRefund(service, refund.id)
    await service.recordManualRefundResult({
      ...metadata(`manual-refund-${randomUUID()}`, actor(approverId)),
      refundId: refund.id,
      succeeded: true,
      receiptReference: randomReference('cash-refund'),
      occurredAt: '2026-08-12T13:00:00.000Z',
    })
    const replacement = await recordManualPayment(service, fixture.orderId, 'physical_pos')

    expect(replacement.amountMinor).toBe(2800)
    expect(await financialSnapshot(pool, fixture.orderId)).toMatchObject({
      payment_status: 'paid',
      gross_paid_minor: '15600',
      refunded_minor: '2800',
      net_minor: '12800',
      payment_entries: '2',
      refund_entries: '1',
    })
    const references = await pool.query<{ provider_reference: string }>(`
      SELECT provider_reference FROM mbox.reconciliation_entries
      WHERE payment_id IN ($1::uuid,$2::uuid) ORDER BY occurred_at,id
    `, [cash.id, replacement.id])
    expect(new Set(references.rows.map((row) => row.provider_reference)).size).toBe(3)
  })

  it('rolls back a duplicate cash or POS receipt reference instead of inventing a second payment', async () => {
    const first = await createOrder(pool, [8800])
    const second = await createOrder(pool, [6800])
    const receiptReference = randomReference('physical-pos-receipt')
    await recordManualPayment(service, first.orderId, 'physical_pos', { receiptReference })

    await expect(recordManualPayment(service, second.orderId, 'physical_pos', { receiptReference }))
      .rejects.toMatchObject({ code: '23505' })
    expect(await financialSnapshot(pool, second.orderId)).toMatchObject({
      payment_status: 'unpaid',
      gross_paid_minor: '0',
      payment_entries: '0',
    })
  })

  it('books a later-day refund on the actual refund business date without rewriting the sale day', async () => {
    const fixture = await createOrder(pool, [10000])
    const payment = await captureOnlinePayment(service, fixture.orderId)
    const refund = await requestRefund(service, payment.id, [allocation(fixture, 0, 4000)])
    await approveRefund(service, refund.id)
    await executeRefund(service, refund.id)
    await recordProviderRefund(service, payment, refund, true, {
      businessDate: '2026-08-13',
      occurredAt: '2026-08-13T04:00:00.000Z',
    })

    const entries = await pool.query<{ entry_type: string; business_date: string }>(`
      SELECT entry_type, business_date::text
      FROM mbox.reconciliation_entries
      WHERE payment_id=$1::uuid
      ORDER BY occurred_at,id
    `, [payment.id])
    expect(entries.rows).toEqual([
      { entry_type: 'payment', business_date: '2026-08-12' },
      { entry_type: 'refund', business_date: '2026-08-13' },
    ])
  })

  it('rejects zero, negative, cross-order and cancelled-item refund allocations', async () => {
    const first = await createOrder(pool, [10000])
    const second = await createOrder(pool, [5000])
    const payment = await captureOnlinePayment(service, first.orderId)

    await expect(requestRefund(service, payment.id, [{ orderItemId: first.itemIds[0]!, amountMinor: 0 }]))
      .rejects.toThrow(/positive/)
    await expect(requestRefund(service, payment.id, [{ orderItemId: first.itemIds[0]!, amountMinor: -1 }]))
      .rejects.toThrow(/positive/)
    await expect(requestRefund(service, payment.id, [{ orderItemId: second.itemIds[0]!, amountMinor: 1 }]))
      .rejects.toThrow(/do not belong/)
    await pool.query('UPDATE mbox.order_items SET status=\'cancelled\' WHERE id=$1::uuid', [first.itemIds[0]])
    await expect(requestRefund(service, payment.id, [{ orderItemId: first.itemIds[0]!, amountMinor: 1 }]))
      .rejects.toThrow(/cancelled/)
  })

  it('supports a historical closed-table refund without touching the new table session', async () => {
    const historical = await createOrder(pool, [8800])
    const payment = await captureOnlinePayment(service, historical.orderId)
    await pool.query('UPDATE mbox.table_sessions SET status=\'closed\', closed_at=clock_timestamp() WHERE id=$1::uuid', [historical.sessionId])
    const current = await createOrder(pool, [6800])
    await succeedOnlineRefund(service, payment, [allocation(historical, 0, 8800)])

    expect((await financialSnapshot(pool, historical.orderId)).payment_status).toBe('refunded')
    expect(await financialSnapshot(pool, current.orderId)).toMatchObject({
      payment_status: 'unpaid',
      gross_paid_minor: '0',
      refunded_minor: '0',
    })
  })
})

async function seedFoundation(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO mbox.tenants(id,code,name) VALUES ($1::uuid,'cashier_extremes','Cashier Extremes')
    ON CONFLICT (id) DO NOTHING
  `, [tenantId])
  await pool.query(`
    INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES ($1::uuid,$2::uuid,'cashier_store','Cashier Store')
    ON CONFLICT (id) DO NOTHING
  `, [storeId, tenantId])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES
      ($1::uuid,$4::uuid,$5::uuid,'REFUND_REQUESTER','退款申请人'),
      ($2::uuid,$4::uuid,$5::uuid,'REFUND_APPROVER','退款审批人'),
      ($3::uuid,$4::uuid,$5::uuid,'CASHIER','收银员')
    ON CONFLICT (id) DO UPDATE SET status='active'
  `, [requesterId, approverId, cashierId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
    VALUES ($1::uuid,$2::uuid,$3::uuid,'CASHIER','收银测试区','indoor')
    ON CONFLICT (id) DO NOTHING
  `, [areaId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station)
    VALUES ($1::uuid,$2::uuid,$3::uuid,'CASHIER_PRODUCT','收银测试商品','test','bar')
    ON CONFLICT (id) DO NOTHING
  `, [productId, tenantId, storeId])
}

async function createOrder(pool: Pool, totals: number[]): Promise<CashierFixture> {
  const tableId = randomUUID()
  const sessionId = randomUUID()
  const orderId = randomUUID()
  const itemIds = totals.map(() => randomUUID())
  const total = totals.reduce((sum, amount) => sum + amount, 0)
  const code = `C${randomUUID().slice(0, 8)}`
  await pool.query(`
    INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$5,8)
  `, [tableId, tenantId, storeId, areaId, code])
  await pool.query(`
    INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::date,2,'open')
  `, [sessionId, tenantId, storeId, tableId, `session-${randomUUID()}`, businessDate])
  await pool.query(`
    INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,payment_status)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'staff_assisted','submitted',
      $6::bigint,0,$6::bigint,'CNY','unpaid')
  `, [orderId, tenantId, storeId, sessionId, `order-${randomUUID()}`, total])
  for (let index = 0; index < totals.length; index += 1) {
    await pool.query(`
      INSERT INTO mbox.order_items(
        id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,
        discount_amount_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,status)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,1,$6::bigint,
        0,$6::bigint,'CNY','bar',$7::jsonb,'delivered')
    `, [
      itemIds[index], tenantId, storeId, orderId, productId, totals[index],
      JSON.stringify({ name: `测试商品${index + 1}`, originalUnitPriceMinor: totals[index] }),
    ])
  }
  return { orderId, itemIds, totals, total, sessionId }
}

async function initiateOnlinePayment(service: PaymentCommandService, orderId: string) {
  const publicId = `pay-${randomUUID()}`
  const key = `init-${randomUUID()}`
  return (await service.initiate({
    ...metadata(key, actor(cashierId)),
    orderId,
    publicId,
    provider: 'postar',
    method: 'native_qr',
    principal: { type: 'employee', employeeId: cashierId },
  })).value
}

async function captureOnlinePayment(service: PaymentCommandService, orderId: string) {
  const payment = await initiateOnlinePayment(service, orderId)
  return succeedPaymentCallback(service, payment)
}

async function succeedPaymentCallback(
  service: PaymentCommandService,
  payment: { publicId: string; amountMinor: number },
) {
  const transaction = randomReference('postar-payment')
  const integrationRef = 'postar-test'
  const occurredAt = '2026-08-12T12:00:00.000Z'
  const providerSnapshot = { signatureVerified: true, tradeState: 'SUCCESS' }
  const verifiedObservationId = await providerObservationRecorder.recordPayment({
    scope: { tenantId, storeId },
    provider: 'postar',
    verificationKind: 'callback_signature',
    providerEventId: randomReference('postar-payment-event'),
    integrationRef,
    paymentPublicId: payment.publicId,
    providerTransactionId: transaction,
    reportedAmountMinor: payment.amountMinor,
    reportedCurrency: 'CNY',
    status: 'succeeded',
    settlementChannel: 'wechat',
    occurredAt,
    evidence: providerSnapshot,
  })
  return (await service.recordSucceededCallback({
    ...metadata(`pay-callback-${randomUUID()}`, { type: 'integration', ref: integrationRef }),
    verifiedObservationId,
    paymentPublicId: payment.publicId,
    provider: 'postar',
    providerTransactionId: transaction,
    reportedAmountMinor: payment.amountMinor,
    reportedCurrency: 'CNY',
    settlementChannel: 'wechat',
    providerSnapshot,
    occurredAt,
  })).value
}

async function recordManualPayment(
  service: PaymentCommandService,
  orderId: string,
  provider: 'cash' | 'physical_pos',
  options: { receiptReference?: string } = {},
) {
  const key = `manual-pay-${randomUUID()}`
  return (await service.recordManual({
    ...metadata(key, actor(cashierId)),
    orderId,
    publicId: `manual-${randomUUID()}`,
    provider,
    method: provider === 'cash' ? 'cash' : 'card',
    evidence: {
      receiptReference: options.receiptReference ?? randomReference(provider),
      collectedByEmployeeId: cashierId,
      ...(provider === 'physical_pos' ? { terminalId: 'POS-TEST-01' } : {}),
    },
    occurredAt: '2026-08-12T12:00:00.000Z',
  })).value
}

async function requestRefund(
  service: PaymentCommandService,
  paymentId: string,
  allocations: { orderItemId: string; amountMinor: number }[],
) {
  const key = `refund-request-${randomUUID()}`
  return (await service.requestRefund({
    ...metadata(key, actor(requesterId)),
    paymentId,
    publicId: `refund-${randomUUID()}`,
    reason: '收银极端场景验收',
    allocations,
    requestEvidence: { source: 'cashier_extreme_acceptance' },
  })).value
}

async function approveRefund(service: PaymentCommandService, refundId: string) {
  return (await service.approveRefund({
    ...metadata(`refund-approve-${randomUUID()}`, actor(approverId)),
    refundId,
    decisionReason: '核对订单、支付和商品后同意退款',
  })).value
}

async function rejectRefund(service: PaymentCommandService, refundId: string) {
  return (await service.rejectRefund({
    ...metadata(`refund-reject-${randomUUID()}`, actor(approverId)),
    refundId,
    decisionReason: '退款金额或商品选择有误，退回更正',
  })).value
}

async function executeRefund(service: PaymentCommandService, refundId: string) {
  return (await service.beginRefundExecution({
    ...metadata(`refund-execute-${randomUUID()}`, actor(approverId)),
    refundId,
  })).value
}

async function succeedOnlineRefund(
  service: PaymentCommandService,
  payment: { id: string; publicId: string; providerTransactionId: string | null; amountMinor: number },
  allocations: { orderItemId: string; amountMinor: number }[],
) {
  const refund = await requestRefund(service, payment.id, allocations)
  await approveRefund(service, refund.id)
  await executeRefund(service, refund.id)
  return recordProviderRefund(service, payment, refund, true)
}

async function recordProviderRefund(
  service: PaymentCommandService,
  payment: { providerTransactionId: string | null },
  refund: { publicId: string; amountMinor: number },
  succeeded: boolean,
  override: {
    providerRefundId?: string
    originalTransactionId?: string
    amountMinor?: number
    currency?: string
    businessDate?: string
    occurredAt?: string
  } = {},
) {
  const integrationRef = 'postar-test'
  const providerRefundId = override.providerRefundId ?? randomReference('postar-refund')
  const originalProviderTransactionId = override.originalTransactionId ?? payment.providerTransactionId!
  const reportedAmountMinor = override.amountMinor ?? refund.amountMinor
  const reportedCurrency = override.currency ?? 'CNY'
  const occurredAt = override.occurredAt ?? '2026-08-12T13:00:00.000Z'
  const providerSnapshot = { signatureVerified: true, refundState: succeeded ? 'SUCCESS' : 'FAILED' }
  const verifiedObservationId = await providerObservationRecorder.recordRefund({
    scope: { tenantId, storeId },
    provider: 'postar',
    verificationKind: 'callback_signature',
    providerEventId: randomReference('postar-refund-event'),
    integrationRef,
    refundPublicId: refund.publicId,
    providerTransactionId: providerRefundId,
    originalProviderTransactionId,
    reportedAmountMinor,
    reportedCurrency,
    status: succeeded ? 'succeeded' : 'failed',
    occurredAt,
    evidence: providerSnapshot,
  })
  return (await service.recordProviderRefundResult({
    ...metadata(
      `refund-result-${randomUUID()}`,
      { type: 'integration', ref: integrationRef },
      override.businessDate,
    ),
    verifiedObservationId,
    refundPublicId: refund.publicId,
    provider: 'postar',
    providerRefundId,
    originalProviderTransactionId,
    reportedAmountMinor,
    reportedCurrency,
    succeeded,
    providerSnapshot,
    occurredAt,
  })).value
}

async function financialSnapshot(pool: Pool, orderId: string): Promise<FinancialSnapshot> {
  const result = await pool.query<FinancialSnapshot>(`
    SELECT order_row.status AS order_status,
      order_row.payment_status,
      COALESCE((SELECT SUM(amount_minor) FROM mbox.payments
        WHERE order_id=order_row.id AND status IN ('succeeded','partially_refunded','refunded')),0)::text AS gross_paid_minor,
      COALESCE((SELECT SUM(refund.amount_minor) FROM mbox.refunds refund
        JOIN mbox.payments payment ON payment.id=refund.payment_id
        WHERE payment.order_id=order_row.id AND refund.status='succeeded'),0)::text AS refunded_minor,
      (COALESCE((SELECT SUM(amount_minor) FROM mbox.payments
        WHERE order_id=order_row.id AND status IN ('succeeded','partially_refunded','refunded')),0)
        - COALESCE((SELECT SUM(refund.amount_minor) FROM mbox.refunds refund
          JOIN mbox.payments payment ON payment.id=refund.payment_id
          WHERE payment.order_id=order_row.id AND refund.status='succeeded'),0))::text AS net_minor,
      (SELECT count(*)::text FROM mbox.payments
        WHERE order_id=order_row.id AND status IN ('created','pending')) AS pending_payments,
      (SELECT count(*)::text FROM mbox.reconciliation_entries entry
        JOIN mbox.payments payment ON payment.id=entry.payment_id
        WHERE payment.order_id=order_row.id AND entry.entry_type='payment') AS payment_entries,
      (SELECT count(*)::text FROM mbox.reconciliation_entries entry
        JOIN mbox.payments payment ON payment.id=entry.payment_id
        WHERE payment.order_id=order_row.id AND entry.entry_type='refund') AS refund_entries,
      COALESCE((SELECT SUM(entry.amount_minor)::text FROM mbox.reconciliation_entries entry
        JOIN mbox.payments payment ON payment.id=entry.payment_id
        WHERE payment.order_id=order_row.id AND entry.entry_type='refund'),'0') AS refund_entry_minor
    FROM mbox.orders order_row WHERE order_row.id=$1::uuid
  `, [orderId])
  if (!result.rows[0]) throw new Error(`Missing financial snapshot for ${orderId}`)
  return result.rows[0]
}

function allocation(fixture: CashierFixture, index: number, amountMinor: number) {
  return { orderItemId: fixture.itemIds[index]!, amountMinor }
}

function actor(employeeId: string): Extract<AuditActor, { type: 'employee' }> {
  return { type: 'employee', employeeId }
}

function metadata(key: string, value: AuditActor, date = businessDate) {
  return {
    scope: { tenantId, storeId },
    actor: value,
    businessDate: date,
    idempotencyKey: key,
    requestFingerprint: JSON.stringify({ key }),
  }
}

function randomReference(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

function asPool(pool: Pool): PostgresPool {
  return pool as unknown as PostgresPool
}
