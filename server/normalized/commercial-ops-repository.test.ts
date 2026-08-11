import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor, type JsonCodec } from './command-executor.js'
import {
  CommercialOpsRepository,
  CostAlreadyCorrectedError,
  SalesAttributionNotAllowedError,
  VoucherAlreadyRedeemedError,
} from './commercial-ops-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('CommercialOpsRepository PostgreSQL integrity', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const tableSessionId = randomUUID()
  const managerId = randomUUID()
  const salespersonId = randomUUID()
  const approverId = randomUUID()
  const productId = randomUUID()
  const orderId = randomUUID()
  const orderItemId = randomUUID()
  const paymentId = randomUUID()
  const paymentReconciliationId = randomUUID()
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let commands: NormalizedCommandExecutor

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 16 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    commands = new NormalizedCommandExecutor(transactions)
    await seedStore()
  })

  afterAll(async () => pool?.end())

  it('writes a cost, audit and outbox atomically and allows only one immutable correction', async () => {
    const created = await commands.execute({
      scope: { tenantId, storeId }, operationScope: 'commercial.test.cost',
      idempotencyKey: 'commercial-cost-create-test-0001', requestFingerprint: 'cost-v1',
      resultCodec: stringCodec,
    }, async (transaction) => {
      const cost = await new CommercialOpsRepository(transaction).createCost(costInput('base'))
      return {
        result: cost.id,
        auditEvents: [{
          actor: { type: 'employee' as const, employeeId: managerId },
          action: 'commercial.test.cost_created', objectType: 'operating_cost', objectId: cost.id,
          businessDate: '2026-08-11', afterData: { grossAmountMinor: cost.grossAmountMinor },
        }],
        outboxMessages: [{
          aggregateType: 'operating_cost', aggregateId: cost.id, aggregateVersion: 1,
          eventType: 'commercial.test.cost_created.v1', payload: { amountMinor: cost.grossAmountMinor },
        }],
      }
    })
    const correction = (suffix: string) => transactions.run({ tenantId, storeId }, async (transaction) => (
      new CommercialOpsRepository(transaction).correctCost(
        created.value,
        { ...costInput(`correction-${suffix}`), netAmountMinor: suffix === 'one' ? 32_000 : 33_000 },
        `发票复核更正 ${suffix}`,
      )
    ))
    const outcomes = await Promise.allSettled([correction('one'), correction('two')])
    expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((value) => value.status === 'rejected')
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(CostAlreadyCorrectedError)

    const evidence = await pool.query<{ costs: string; audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.operating_cost_entries
          WHERE tenant_id = $1 AND store_id = $2) AS costs,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE tenant_id = $1 AND store_id = $2 AND action = 'commercial.test.cost_created') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE tenant_id = $1 AND store_id = $2 AND message_type = 'commercial.test.cost_created.v1') AS outbox
    `, [tenantId, storeId])
    expect(evidence.rows[0]).toEqual({ costs: '2', audits: '1', outbox: '1' })
    await expect(pool.query(`UPDATE mbox.operating_cost_entries SET net_amount_minor = 1 WHERE id = $1`,
      [created.value])).rejects.toMatchObject({ code: '55000' })
  })

  it('allows only one concurrent redemption of the same voucher code', async () => {
    const redeem = (suffix: string) => commands.execute({
      scope: { tenantId, storeId }, operationScope: 'commercial.test.voucher',
      idempotencyKey: `commercial-voucher-${suffix}-0001`, requestFingerprint: `voucher-${suffix}`,
      resultCodec: stringCodec,
    }, async (transaction) => {
      const redemption = await new CommercialOpsRepository(transaction).redeemVoucher({
        publicId: `voucher-public-${suffix}-0001`, platform: '美团', campaignName: '双人组合',
        voucherCode: 'MT-7788-9900', faceValueMinor: 20_000, settlementAmountMinor: 18_800,
        currency: 'CNY', orderId, tableSessionId,
        redeemedByEmployeeId: managerId, redeemedBusinessDate: '2026-08-11',
      })
      return {
        result: redemption.id,
        auditEvents: [{
          actor: { type: 'employee' as const, employeeId: managerId },
          action: 'commercial.test.voucher_redeemed', objectType: 'group_voucher',
          objectId: redemption.id, businessDate: '2026-08-11',
          afterData: { platform: redemption.platform },
        }],
        outboxMessages: [{
          aggregateType: 'group_voucher', aggregateId: redemption.id, aggregateVersion: 1,
          eventType: 'commercial.test.voucher_redeemed.v1', payload: { platform: redemption.platform },
        }],
      }
    })
    const outcomes = await Promise.allSettled([redeem('one'), redeem('two')])
    const failures = outcomes
      .filter((value) => value.status === 'rejected')
      .map((value) => value.status === 'rejected' ? String(value.reason) : '')
    expect(outcomes.filter((value) => value.status === 'fulfilled'), failures.join('\n')).toHaveLength(1)
    const rejected = outcomes.find((value) => value.status === 'rejected')
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(VoucherAlreadyRedeemedError)
    const evidence = await pool.query<{ redemptions: string; audits: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.group_voucher_redemptions
          WHERE tenant_id = $1 AND store_id = $2) AS redemptions,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE tenant_id = $1 AND store_id = $2 AND action = 'commercial.test.voucher_redeemed') AS audits
    `, [tenantId, storeId])
    expect(evidence.rows[0]).toEqual({ redemptions: '1', audits: '1' })
  })

  it('snapshots configured item ownership and reverses partial then final refunds exactly', async () => {
    await transactions.run({ tenantId, storeId }, async (transaction) => {
      await new CommercialOpsRepository(transaction).createSalesRule({
        productId, attributionMode: 'explicit', salesCreditBps: 10_000,
        costSource: 'order_item_snapshot', effectiveFrom: '2026-08-01T00:00:00.000Z',
        effectiveUntil: '2026-09-01T00:00:00.000Z', reason: '测试指定单品业绩',
        configuredByEmployeeId: managerId,
      })
    })
    const sale = await transactions.run({ tenantId, storeId }, async (transaction) => (
      new CommercialOpsRepository(transaction).recordSaleAttribution({
        orderItemId, explicitEmployeeId: salespersonId, recordedByEmployeeId: managerId,
      })
    ))
    expect(sale).toMatchObject({
      employeeId: salespersonId, salesAmountDeltaMinor: 10_000,
      costAmountDeltaMinor: 4_000, quantityDelta: '2.000000',
    })
    await expect(transactions.run({ tenantId, storeId }, async (transaction) => (
      new CommercialOpsRepository(transaction).recordSaleAttribution({
        orderItemId, explicitEmployeeId: managerId, recordedByEmployeeId: managerId,
      })
    ))).rejects.toBeInstanceOf(SalesAttributionNotAllowedError)

    const firstRefundId = await seedRefund(2_500, 'one', '2026-08-12')
    const first = await transactions.run({ tenantId, storeId }, async (transaction) => (
      new CommercialOpsRepository(transaction).reverseSalesForRefund(firstRefundId, managerId)
    ))
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      salesAmountDeltaMinor: -2_500, costAmountDeltaMinor: -1_000,
      quantityDelta: '-0.500000',
    })

    const secondRefundId = await seedRefund(7_500, 'two', '2026-08-13')
    const second = await transactions.run({ tenantId, storeId }, async (transaction) => (
      new CommercialOpsRepository(transaction).reverseSalesForRefund(secondRefundId, managerId)
    ))
    expect(second[0]).toMatchObject({
      salesAmountDeltaMinor: -7_500, costAmountDeltaMinor: -3_000,
      quantityDelta: '-1.500000',
    })
    const replay = await transactions.run({ tenantId, storeId }, async (transaction) => (
      new CommercialOpsRepository(transaction).reverseSalesForRefund(secondRefundId, managerId)
    ))
    expect(replay).toEqual(second)

    const totals = await pool.query<{
      sales: string; cost: string; quantity: string; reversals: string
    }>(`
      SELECT SUM(sales_amount_delta_minor)::text AS sales,
        SUM(cost_amount_delta_minor)::text AS cost,
        SUM(quantity_delta)::text AS quantity,
        count(*) FILTER (WHERE event_type = 'refund_reversal')::text AS reversals
      FROM mbox.employee_sales_attribution_events
      WHERE tenant_id = $1 AND store_id = $2 AND order_item_id = $3
    `, [tenantId, storeId, orderItemId])
    expect(totals.rows[0]).toEqual({ sales: '0', cost: '0', quantity: '0.000000', reversals: '2' })
  })

  function costInput(suffix: string) {
    return {
      publicId: `cost-${suffix}-0001`, category: 'rent' as const,
      recognitionState: 'actual' as const, allocationPeriod: 'month' as const,
      serviceStartDate: '2026-08-01', serviceEndDate: '2026-08-31', cashPaidOn: '2026-08-01',
      netAmountMinor: 31_000, taxAmountMinor: 3_100, currency: 'CNY',
      sourceType: 'lease' as const, sourceReference: 'LEASE-2026-08',
      sourceSnapshot: { confidentialLeaseReference: 'not-for-api' },
      recordedBusinessDate: '2026-08-11', recordedByEmployeeId: managerId,
    }
  }

  async function seedRefund(amountMinor: number, suffix: string, businessDate: string): Promise<string> {
    const refundId = randomUUID()
    await pool.query(`
      INSERT INTO mbox.refunds (
        id, tenant_id, store_id, payment_id, public_id, provider_refund_id,
        amount_minor, currency, status, reason, requested_by_employee_id,
        approved_by_employee_id, decision_reason, completed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, 'CNY', 'succeeded', '客人部分退单',
        $8, $9, '店长审批并核对原支付', clock_timestamp()
      )
    `, [
      refundId, tenantId, storeId, paymentId, `refund-public-${suffix}-0001`,
      `provider-refund-${suffix}`, amountMinor, managerId, approverId,
    ])
    await pool.query(`
      INSERT INTO mbox.refund_items (
        tenant_id, store_id, refund_id, order_item_id, amount_minor, currency
      ) VALUES ($1, $2, $3, $4, $5, 'CNY')
    `, [tenantId, storeId, refundId, orderItemId, amountMinor])
    await pool.query(`
      INSERT INTO mbox.reconciliation_entries (
        tenant_id, store_id, payment_id, refund_id, entry_type, provider,
        provider_reference, amount_minor, currency, business_date, occurred_at
      ) VALUES ($1, $2, $3, $4, 'refund', 'simulation', $5, $6, 'CNY', $7, clock_timestamp())
    `, [tenantId, storeId, paymentId, refundId, `refund-recon-${suffix}`, -amountMinor, businessDate])
    return refundId
  }

  async function seedStore(): Promise<void> {
    await pool.query(`INSERT INTO mbox.tenants (id, code, name) VALUES ($1, $2, 'Commercial Tenant')`,
      [tenantId, `commercial-${tenantId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.stores (id, tenant_id, code, name)
      VALUES ($1, $2, $3, 'Commercial Store')`, [storeId, tenantId, `store-${storeId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
      VALUES ($1, $2, $3, 'OPS', 'Operations', 'indoor')`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES ($1, $2, $3, $4, 'OPS1', 'Operations 1', 4)`, [tableId, tenantId, storeId, areaId])
    for (const [id, code, name] of [
      [managerId, 'MANAGER', 'Manager'],
      [salespersonId, 'SALES', 'Salesperson'],
      [approverId, 'APPROVER', 'Approver'],
    ]) {
      await pool.query(`INSERT INTO mbox.employees (id, tenant_id, store_id, employee_code, display_name)
        VALUES ($1, $2, $3, $4, $5)`, [id, tenantId, storeId, code, name])
    }
    await pool.query(`INSERT INTO mbox.table_sessions (
      id, tenant_id, store_id, table_id, public_id, business_date, guest_count
    ) VALUES ($1, $2, $3, $4, 'commercial-session-0001', '2026-08-11', 2)`,
    [tableSessionId, tenantId, storeId, tableId])
    await pool.query(`INSERT INTO mbox.products (
      id, tenant_id, store_id, code, name, category_code, fulfillment_station, product_snapshot
    ) VALUES ($1, $2, $3, 'WINE-001', '测试红酒', 'wine', 'bar', '{}')`,
    [productId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.orders (
      id, tenant_id, store_id, table_session_id, public_id, channel, status,
      payment_status, subtotal_amount_minor, total_amount_minor, currency,
      created_by_employee_id, submitted_at
    ) VALUES (
      $1, $2, $3, $4, 'commercial-order-0001', 'staff_assisted', 'completed',
      'paid', 10000, 10000, 'CNY', $5, '2026-08-11T12:00:00Z'
    )`, [orderId, tenantId, storeId, tableSessionId, salespersonId])
    await pool.query(`INSERT INTO mbox.order_items (
      id, tenant_id, store_id, order_id, product_id, quantity, unit_price_minor,
      total_amount_minor, currency, fulfillment_station, product_snapshot,
      cost_snapshot, status
    ) VALUES (
      $1, $2, $3, $4, $5, 2, 5000, 10000, 'CNY', 'bar',
      '{"code":"WINE-001","name":"测试红酒"}', '{"totalCostMinor":4000}', 'delivered'
    )`, [orderItemId, tenantId, storeId, orderId, productId])
    await pool.query(`INSERT INTO mbox.payments (
      id, tenant_id, store_id, order_id, public_id, provider,
      provider_transaction_id, method, amount_minor, currency, status, succeeded_at
    ) VALUES (
      $1, $2, $3, $4, 'commercial-payment-0001', 'simulation',
      'simulation-payment-0001', 'native_qr', 10000, 'CNY', 'succeeded', clock_timestamp()
    )`, [paymentId, tenantId, storeId, orderId])
    await pool.query(`INSERT INTO mbox.reconciliation_entries (
      id, tenant_id, store_id, payment_id, entry_type, provider, provider_reference,
      amount_minor, currency, business_date, occurred_at
    ) VALUES ($1, $2, $3, $4, 'payment', 'simulation', 'payment-recon-0001',
      10000, 'CNY', '2026-08-11', clock_timestamp())`,
    [paymentReconciliationId, tenantId, storeId, paymentId])
  }
})

const stringCodec: JsonCodec<string> = {
  encode: (value) => value,
  decode: (value) => {
    if (typeof value !== 'string') throw new TypeError('stored value is not a string')
    return value
  },
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
