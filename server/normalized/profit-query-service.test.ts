import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { CommercialOpsRepository } from './commercial-ops-repository.js'
import { ProfitQueryService, profitPeriodRange } from './profit-query-service.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

describe('profitPeriodRange', () => {
  it('uses Monday weeks and calendar day, month, quarter and year boundaries', () => {
    expect(profitPeriodRange('day', '2026-08-11')).toEqual({ startDate: '2026-08-11', endDate: '2026-08-11' })
    expect(profitPeriodRange('week', '2026-08-11')).toEqual({ startDate: '2026-08-10', endDate: '2026-08-16' })
    expect(profitPeriodRange('month', '2026-02-11')).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' })
    expect(profitPeriodRange('quarter', '2026-08-11')).toEqual({ startDate: '2026-07-01', endDate: '2026-09-30' })
    expect(profitPeriodRange('year', '2026-08-11')).toEqual({ startDate: '2026-01-01', endDate: '2026-12-31' })
  })
})

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('ProfitQueryService PostgreSQL accounting correctness', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const sessionId = randomUUID()
  const managerId = randomUUID()
  const sellerId = randomUUID()
  const productId = randomUUID()
  const orderId = randomUUID()
  const orderItemId = randomUUID()
  const paymentId = randomUUID()
  const refundId = randomUUID()
  const saleEventId = randomUUID()
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let query: ProfitQueryService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    query = new ProfitQueryService(transactions)
    await seed()
  })

  afterAll(async () => pool?.end())

  it('separates cash and accrual profit and marks unmeasurable or unsettled gaps', async () => {
    const report = await query.getProfitReport({ tenantId, storeId }, 'day', '2026-08-15')
    expect(report.revenue.cash).toMatchObject({
      paymentReceiptsMinor: 10_000,
      refundsMinor: 0,
      providerFeesMinor: -100,
      netReceiptsMinor: 9_900,
    })
    expect(report.revenue.accrual.reconciledRevenueMinor).toBe(7_400)
    expect(report.costs).toMatchObject({
      cashPaidMinor: 0,
      accrualAllocatedMinor: 1_200,
      taxIncludedMinor: 100,
    })
    expect(report.profit).toEqual({ cashBasisMinor: 9_900, accrualBasisMinor: 6_200 })
    expect(report.gaps).toMatchObject({
      unsettledVoucherSettlementMinor: 18_800,
      unactualizedAccrualMinor: 100,
      unknownUnrecordedCostsMeasurable: false,
    })
    expect(report.status).toBe('provisional')
    expect(report.caveats.join(' ')).toContain('未知成本无法被量化')
  })

  it('allocates integer minor units exactly across a full month', async () => {
    const report = await query.getProfitReport({ tenantId, storeId }, 'month', '2026-08-15')
    expect(report.costs.accrualAllocatedMinor).toBe(37_200)
    expect(report.costs.taxIncludedMinor).toBe(3_100)
    expect(report.costs.cashPaidMinor).toBe(34_100)
  })

  it('aggregates employee sales with refund reversal and contribution cost coverage', async () => {
    const rows = await query.listEmployeeSales({ tenantId, storeId }, {
      startDate: '2026-08-01', endDate: '2026-08-31', employeeIds: [sellerId],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      employeeCode: 'SELLER', employeeDisplayName: 'Seller', productCode: 'WINE-STAT',
      quantity: '1.500000', salesAmountMinor: 7_500, costAmountMinor: 3_000,
      contributionProfitMinor: 4_500, refundReversalAmountMinor: 2_500,
      costCoverageComplete: true,
    })
  })

  it('lists only display-safe cost and voucher fields', async () => {
    const costs = await query.listCosts({ tenantId, storeId }, '2026-08-01', '2026-08-31')
    const vouchers = await query.listVouchers({ tenantId, storeId }, '2026-08-01', '2026-08-31')
    expect(costs).toHaveLength(2)
    expect(JSON.stringify(costs)).not.toMatch(/secretSupplier|sourceSnapshot|employeeId/)
    expect(vouchers[0]).toMatchObject({ voucherCodeMasked: 'MT********00', isSettled: false })
    expect(JSON.stringify(vouchers)).not.toContain('MT-7788-9900')
  })

  async function seed(): Promise<void> {
    await pool.query(`INSERT INTO mbox.tenants (id, code, name) VALUES ($1, $2, 'Profit Tenant')`,
      [tenantId, `profit-${tenantId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.stores (id, tenant_id, code, name)
      VALUES ($1, $2, $3, 'Profit Store')`, [storeId, tenantId, `store-${storeId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
      VALUES ($1, $2, $3, 'P', 'Profit', 'indoor')`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES ($1, $2, $3, $4, 'P1', 'Profit 1', 4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`INSERT INTO mbox.employees (id, tenant_id, store_id, employee_code, display_name)
      VALUES ($1, $2, $3, 'MANAGER', 'Manager'), ($4, $2, $3, 'SELLER', 'Seller')`,
    [managerId, tenantId, storeId, sellerId])
    await pool.query(`INSERT INTO mbox.table_sessions (
      id, tenant_id, store_id, table_id, public_id, business_date, guest_count
    ) VALUES ($1, $2, $3, $4, 'profit-session-0001', '2026-08-15', 2)`,
    [sessionId, tenantId, storeId, tableId])
    await pool.query(`INSERT INTO mbox.products (
      id, tenant_id, store_id, code, name, category_code, fulfillment_station, product_snapshot
    ) VALUES ($1, $2, $3, 'WINE-STAT', '统计红酒', 'wine', 'bar', '{}')`,
    [productId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.orders (
      id, tenant_id, store_id, table_session_id, public_id, channel, status,
      payment_status, subtotal_amount_minor, total_amount_minor, currency,
      created_by_employee_id, submitted_at
    ) VALUES ($1, $2, $3, $4, 'profit-order-0001', 'staff_assisted', 'completed',
      'partially_refunded', 10000, 10000, 'CNY', $5, '2026-08-15T12:00:00Z')`,
    [orderId, tenantId, storeId, sessionId, sellerId])
    await pool.query(`INSERT INTO mbox.order_items (
      id, tenant_id, store_id, order_id, product_id, quantity, unit_price_minor,
      total_amount_minor, currency, fulfillment_station, product_snapshot, cost_snapshot, status
    ) VALUES ($1, $2, $3, $4, $5, 2, 5000, 10000, 'CNY', 'bar', '{}',
      '{"totalCostMinor":4000}', 'delivered')`, [orderItemId, tenantId, storeId, orderId, productId])
    await pool.query(`INSERT INTO mbox.payments (
      id, tenant_id, store_id, order_id, public_id, provider, provider_transaction_id,
      method, amount_minor, currency, status, succeeded_at
    ) VALUES ($1, $2, $3, $4, 'profit-payment-0001', 'simulation', 'profit-tx-0001',
      'native_qr', 10000, 'CNY', 'partially_refunded', clock_timestamp())`,
    [paymentId, tenantId, storeId, orderId])
    await pool.query(`INSERT INTO mbox.refunds (
      id, tenant_id, store_id, payment_id, public_id, provider_refund_id, amount_minor,
      currency, status, reason, requested_by_employee_id, approved_by_employee_id,
      decision_reason, completed_at
    ) VALUES ($1, $2, $3, $4, 'profit-refund-0001', 'profit-refund-provider-0001', 2500,
      'CNY', 'succeeded', '部分退款', $5, $6, '审批通过', clock_timestamp())`,
    [refundId, tenantId, storeId, paymentId, sellerId, managerId])
    await pool.query(`INSERT INTO mbox.refund_items (
      tenant_id, store_id, refund_id, order_item_id, amount_minor, currency
    ) VALUES ($1, $2, $3, $4, 2500, 'CNY')`, [tenantId, storeId, refundId, orderItemId])
    await pool.query(`INSERT INTO mbox.reconciliation_entries (
      tenant_id, store_id, payment_id, entry_type, provider, provider_reference,
      amount_minor, currency, business_date, occurred_at
    ) VALUES
      ($1, $2, $3, 'payment', 'simulation', 'profit-pay-recon', 10000, 'CNY', '2026-08-15', clock_timestamp()),
      ($1, $2, $3, 'fee', 'simulation', 'profit-fee-recon', -100, 'CNY', '2026-08-15', clock_timestamp())`,
    [tenantId, storeId, paymentId])
    await pool.query(`INSERT INTO mbox.reconciliation_entries (
      tenant_id, store_id, payment_id, refund_id, entry_type, provider, provider_reference,
      amount_minor, currency, business_date, occurred_at
    ) VALUES ($1, $2, $3, $4, 'refund', 'simulation', 'profit-refund-recon',
      -2500, 'CNY', '2026-08-16', clock_timestamp())`, [tenantId, storeId, paymentId, refundId])

    await transactions.run({ tenantId, storeId }, async (transaction) => {
      const repository = new CommercialOpsRepository(transaction)
      await repository.createCost({
        publicId: 'profit-rent-cost-0001', category: 'rent', recognitionState: 'actual',
        allocationPeriod: 'month', serviceStartDate: '2026-08-01', serviceEndDate: '2026-08-31',
        cashPaidOn: '2026-08-01', netAmountMinor: 31_000, taxAmountMinor: 3_100,
        currency: 'CNY', sourceType: 'lease', sourceReference: 'LEASE-AUG',
        sourceSnapshot: { secretSupplier: 'landlord-private' },
        recordedBusinessDate: '2026-08-01', recordedByEmployeeId: managerId,
      })
      await repository.createCost({
        publicId: 'profit-accrual-cost-0001', category: 'personnel', recognitionState: 'accrual',
        allocationPeriod: 'month', serviceStartDate: '2026-08-01', serviceEndDate: '2026-08-31',
        netAmountMinor: 3_100, currency: 'CNY', sourceType: 'payroll', employeeId: sellerId,
        sourceSnapshot: { secretPayroll: 3100 }, recordedBusinessDate: '2026-08-01',
        recordedByEmployeeId: managerId,
      })
      await repository.redeemVoucher({
        publicId: 'profit-voucher-0001', platform: '美团', campaignName: '双人组合',
        voucherCode: 'MT-7788-9900', faceValueMinor: 20_000, settlementAmountMinor: 18_800,
        currency: 'CNY', orderId, tableSessionId: sessionId, redeemedByEmployeeId: managerId,
        redeemedBusinessDate: '2026-08-15',
      })
    })

    await pool.query(`INSERT INTO mbox.employee_sales_attribution_events (
      id, tenant_id, store_id, event_type, order_id, order_item_id, employee_id,
      business_date, quantity_delta, sales_amount_delta_minor, cost_amount_delta_minor,
      currency, product_snapshot, attribution_snapshot, recorded_by_employee_id
    ) VALUES ($1, $2, $3, 'sale', $4, $5, $6, '2026-08-15', 2, 10000, 4000,
      'CNY', '{"code":"WINE-STAT","name":"统计红酒","categoryCode":"wine"}', '{}', $7)`,
    [saleEventId, tenantId, storeId, orderId, orderItemId, sellerId, managerId])
    await pool.query(`INSERT INTO mbox.employee_sales_attribution_events (
      tenant_id, store_id, event_type, order_id, order_item_id, employee_id,
      source_sale_event_id, refund_id, business_date, quantity_delta,
      sales_amount_delta_minor, cost_amount_delta_minor, currency,
      product_snapshot, attribution_snapshot, recorded_by_employee_id
    ) VALUES ($1, $2, 'refund_reversal', $3, $4, $5, $6, $7, '2026-08-16',
      -0.5, -2500, -1000, 'CNY',
      '{"code":"WINE-STAT","name":"统计红酒","categoryCode":"wine"}', '{}', $8)`,
    [tenantId, storeId, orderId, orderItemId, sellerId, saleEventId, refundId, managerId])
  }
})

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
