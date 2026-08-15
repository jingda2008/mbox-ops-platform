import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { PostgresCashierWorkbenchQuery } from './cashier-workbench-query.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type ScopedTransaction,
} from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const orderId = '44444444-4444-4444-8444-444444444444'
const itemId = '55555555-5555-4555-8555-555555555555'
const paymentId = '66666666-6666-4666-8666-666666666666'
const refundId = '77777777-7777-4777-8777-777777777777'

describe('PostgresCashierWorkbenchQuery', () => {
  it('returns current-day orders with payment and per-item remaining refundable amounts', async () => {
    const runner = new QueryRunner([
      [orderRow()],
      [itemRow()],
      [paymentRow()],
      [refundRow()],
      [allocationRow()],
    ])
    const query = new PostgresCashierWorkbenchQuery(
      runner as unknown as ScopedPostgresTransactionRunner,
    )

    const view = await query.get({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-13',
      capabilities: ['refund.request', 'refund.approve', 'refund.execute'],
      query: ' VIP1 ',
      limit: 20,
    })

    expect(view.businessDate).toBe('2026-08-13')
    expect(view.query).toBe('VIP1')
    expect(view.actions).toEqual({
      canRequestRefund: true,
      canApproveRefund: true,
      canExecuteRefund: true,
      canViewReconciliation: false,
    })
    expect(view.summary).toEqual({
      orderCount: 1,
      capturedPaymentCount: 1,
      requestedRefundCount: 1,
      processingRefundCount: 0,
    })
    expect(view.orders[0]).toMatchObject({ publicId: 'ORDER-VIP1-0001', tableCode: 'VIP1' })
    expect(view.orders[0]?.payments[0]).toMatchObject({
      id: paymentId,
      reservedRefundAmountMinor: 1_000,
      remainingRefundableMinor: 7_800,
    })
    expect(view.orders[0]?.payments[0]?.refundableItems[0]).toMatchObject({
      id: itemId,
      productName: '精酿啤酒',
      reservedRefundAmountMinor: 1_000,
      remainingRefundableMinor: 7_800,
    })
    expect(view.orders[0]?.payments[0]?.refunds[0]).toMatchObject({
      id: refundId,
      requestedByEmployeeName: 'Tom',
      receiptReference: null,
      allocations: [{ orderItemId: itemId, amountMinor: 1_000 }],
    })
    expect(runner.calls[0]?.sql).toContain('session.business_date = $3::date')
    expect(runner.calls[0]?.values).toEqual([
      tenantId,
      storeId,
      '2026-08-13',
      'VIP1',
      20,
    ])
    expect(runner.readOnly).toBe(true)
  })

  it('returns an empty workbench without running detail queries', async () => {
    const runner = new QueryRunner([[]])
    const query = new PostgresCashierWorkbenchQuery(
      runner as unknown as ScopedPostgresTransactionRunner,
    )
    const view = await query.get({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-13',
      capabilities: ['reconciliation.view'],
      limit: 50,
    })

    expect(view.orders).toEqual([])
    expect(view.summary.orderCount).toBe(0)
    expect(runner.calls).toHaveLength(1)
  })

  it('rejects callers without a financial capability before opening the database', () => {
    const runner = new QueryRunner([])
    const query = new PostgresCashierWorkbenchQuery(
      runner as unknown as ScopedPostgresTransactionRunner,
    )

    expect(() => query.get({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-13',
      capabilities: ['dashboard.view'],
      limit: 50,
    })).toThrow('requires a financial capability')
    expect(runner.runCalls).toBe(0)
  })

  it('allows a manager with only refund request permission to open the workbench', async () => {
    const runner = new QueryRunner([[]])
    const query = new PostgresCashierWorkbenchQuery(
      runner as unknown as ScopedPostgresTransactionRunner,
    )
    await expect(query.get({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-13',
      capabilities: ['refund.request'],
      limit: 20,
    })).resolves.toMatchObject({ actions: { canRequestRefund: true, canApproveRefund: false } })
  })

  it('does not treat payment initiation alone as permission to read the store-wide workbench', () => {
    const runner = new QueryRunner([])
    const query = new PostgresCashierWorkbenchQuery(
      runner as unknown as ScopedPostgresTransactionRunner,
    )

    expect(() => query.get({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-13',
      capabilities: ['payment.initiate.staff'],
      limit: 50,
    })).toThrow('requires a financial capability')
    expect(runner.runCalls).toBe(0)
  })
})

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('PostgresCashierWorkbenchQuery PostgreSQL integration', () => {
  const suffix = randomUUID().slice(0, 8)
  const integrationTenantId = randomUUID()
  const integrationStoreId = randomUUID()
  const integrationAreaId = randomUUID()
  const integrationTableId = randomUUID()
  const integrationSessionId = randomUUID()
  const integrationEmployeeId = randomUUID()
  const integrationApproverId = randomUUID()
  const integrationProductId = randomUUID()
  const integrationOrderId = randomUUID()
  const integrationItemId = randomUUID()
  const integrationPaymentId = randomUUID()
  const integrationRefundId = randomUUID()
  let pool: Pool
  let query: PostgresCashierWorkbenchQuery

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    query = new PostgresCashierWorkbenchQuery(new ScopedPostgresTransactionRunner(asPool(pool)))
    await pool.query(`INSERT INTO mbox.tenants (id, code, name)
      VALUES ($1, $2, 'Cashier Workbench Tenant')`, [integrationTenantId, `cw-${suffix}`])
    await pool.query(`INSERT INTO mbox.stores (id, tenant_id, code, name)
      VALUES ($1, $2, $3, 'Cashier Workbench Store')`, [integrationStoreId, integrationTenantId, `cw-store-${suffix}`])
    await pool.query(`INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
      VALUES ($1, $2, $3, 'VIP', 'VIP区', 'indoor')`, [integrationAreaId, integrationTenantId, integrationStoreId])
    await pool.query(`INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES ($1, $2, $3, $4, 'VIP1', 'VIP1', 6)`, [integrationTableId, integrationTenantId, integrationStoreId, integrationAreaId])
    await pool.query(`INSERT INTO mbox.employees (id, tenant_id, store_id, employee_code, display_name)
      VALUES ($1, $2, $3, $4, 'Tom'), ($5, $2, $3, $6, '李艳')`, [
      integrationEmployeeId,
      integrationTenantId,
      integrationStoreId,
      `cw-request-${suffix}`,
      integrationApproverId,
      `cw-approve-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.table_sessions (
      id, tenant_id, store_id, table_id, public_id, business_date, guest_count
    ) VALUES ($1, $2, $3, $4, $5, '2026-08-13', 2)`, [
      integrationSessionId,
      integrationTenantId,
      integrationStoreId,
      integrationTableId,
      `cw-session-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.products (
      id, tenant_id, store_id, code, name, category_code, fulfillment_station, product_snapshot
    ) VALUES ($1, $2, $3, $4, '精酿啤酒', 'beer', 'bar', '{}')`, [
      integrationProductId,
      integrationTenantId,
      integrationStoreId,
      `CW-BEER-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.orders (
      id, tenant_id, store_id, table_session_id, public_id, channel, status,
      payment_status, subtotal_amount_minor, total_amount_minor, currency,
      created_by_employee_id, submitted_at
    ) VALUES ($1, $2, $3, $4, $5, 'staff_assisted', 'completed',
      'partially_refunded', 8800, 8800, 'CNY', $6, '2026-08-13T12:00:00Z')`, [
      integrationOrderId,
      integrationTenantId,
      integrationStoreId,
      integrationSessionId,
      `cw-order-${suffix}`,
      integrationEmployeeId,
    ])
    await pool.query(`INSERT INTO mbox.order_items (
      id, tenant_id, store_id, order_id, product_id, quantity, unit_price_minor,
      total_amount_minor, currency, fulfillment_station, product_snapshot, status
    ) VALUES ($1, $2, $3, $4, $5, 1, 8800, 8800, 'CNY', 'bar',
      '{"name":"精酿啤酒"}', 'delivered')`, [
      integrationItemId,
      integrationTenantId,
      integrationStoreId,
      integrationOrderId,
      integrationProductId,
    ])
    await pool.query(`INSERT INTO mbox.payments (
      id, tenant_id, store_id, order_id, public_id, provider, provider_transaction_id,
      method, amount_minor, currency, status, succeeded_at
    ) VALUES ($1, $2, $3, $4, $5, 'postar', $6, 'native_qr', 8800, 'CNY',
      'partially_refunded', '2026-08-13T12:02:00Z')`, [
      integrationPaymentId,
      integrationTenantId,
      integrationStoreId,
      integrationOrderId,
      `cw-payment-${suffix}`,
      `cw-provider-tx-${suffix}`,
    ])
    await pool.query(`INSERT INTO mbox.refunds (
      id, tenant_id, store_id, payment_id, public_id, amount_minor, currency, status,
      reason, requested_by_employee_id, approved_by_employee_id, decision_reason
    ) VALUES ($1, $2, $3, $4, $5, 1000, 'CNY', 'approved', '商品未出品', $6, $7, '核对无误')`, [
      integrationRefundId,
      integrationTenantId,
      integrationStoreId,
      integrationPaymentId,
      `cw-refund-${suffix}`,
      integrationEmployeeId,
      integrationApproverId,
    ])
    await pool.query(`INSERT INTO mbox.refund_items (
      tenant_id, store_id, refund_id, order_item_id, amount_minor, currency
    ) VALUES ($1, $2, $3, $4, 1000, 'CNY')`, [
      integrationTenantId,
      integrationStoreId,
      integrationRefundId,
      integrationItemId,
    ])
  })

  afterAll(async () => pool?.end())

  it('executes the read model SQL and isolates the trusted business date', async () => {
    const current = await query.get({
      scope: { tenantId: integrationTenantId, storeId: integrationStoreId },
      employeeId: integrationApproverId,
      businessDate: '2026-08-13',
      capabilities: ['refund.request', 'refund.approve', 'refund.execute'],
      query: 'VIP1',
      limit: 20,
    })
    const stale = await query.get({
      scope: { tenantId: integrationTenantId, storeId: integrationStoreId },
      employeeId: integrationApproverId,
      businessDate: '2026-08-12',
      capabilities: ['reconciliation.view'],
      limit: 20,
    })

    expect(current.orders).toHaveLength(1)
    expect(current.orders[0]?.payments[0]).toMatchObject({
      reservedRefundAmountMinor: 1_000,
      remainingRefundableMinor: 7_800,
    })
    expect(current.orders[0]?.payments[0]?.refundableItems[0]).toMatchObject({
      productName: '精酿啤酒',
      remainingRefundableMinor: 7_800,
    })
    expect(current.summary.processingRefundCount).toBe(1)
    expect(stale.orders).toEqual([])
  })
})

class QueryRunner {
  runCalls = 0
  readOnly = false
  calls: { sql: string; values: readonly unknown[] }[] = []

  constructor(private readonly resultSets: Record<string, unknown>[][]) {}

  async run<Result>(
    scope: { tenantId: string; storeId: string },
    handler: (transaction: ScopedTransaction) => Promise<Result>,
    options?: { readOnly?: boolean },
  ): Promise<Result> {
    this.runCalls += 1
    this.readOnly = options?.readOnly === true
    expect(scope).toEqual({ tenantId, storeId })
    return handler({
      scope,
      query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        this.calls.push({ sql: text.replace(/\s+/g, ' ').trim(), values })
        const rows = this.resultSets.shift() ?? []
        return { rows: rows as Row[], rowCount: rows.length }
      },
    })
  }
}

function orderRow(): Record<string, unknown> {
  return {
    id: orderId,
    public_id: 'ORDER-VIP1-0001',
    table_code: 'VIP1',
    channel: 'staff_assisted',
    status: 'submitted',
    payment_status: 'paid',
    total_amount_minor: '8800',
    currency: 'CNY',
    submitted_at: '2026-08-13T12:00:00.000Z',
    created_at: '2026-08-13T11:59:00.000Z',
  }
}

function itemRow(): Record<string, unknown> {
  return {
    id: itemId,
    order_id: orderId,
    product_name: '精酿啤酒',
    quantity: 1,
    total_amount_minor: '8800',
    status: 'delivered',
  }
}

function paymentRow(): Record<string, unknown> {
  return {
    id: paymentId,
    order_id: orderId,
    public_id: 'PAYMENT-VIP1-0001',
    provider: 'postar',
    method: 'native_qr',
    provider_transaction_id: 'POSTAR-TX-0001',
    amount_minor: '8800',
    currency: 'CNY',
    status: 'succeeded',
    succeeded_at: '2026-08-13T12:02:00.000Z',
    created_at: '2026-08-13T12:01:00.000Z',
  }
}

function refundRow(): Record<string, unknown> {
  return {
    id: refundId,
    payment_id: paymentId,
    public_id: 'REFUND-VIP1-0001',
    provider_refund_id: null,
    amount_minor: '1000',
    currency: 'CNY',
    status: 'requested',
    reason: '商品未出品',
    requested_by_employee_id: employeeId,
    requested_by_employee_name: 'Tom',
    approved_by_employee_id: null,
    approved_by_employee_name: null,
    decision_reason: null,
    receipt_reference: null,
    completed_at: null,
    created_at: '2026-08-13T12:05:00.000Z',
  }
}

function allocationRow(): Record<string, unknown> {
  return { refund_id: refundId, order_item_id: itemId, amount_minor: '1000' }
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
