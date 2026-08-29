import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { CommercialOpsRepository } from './commercial-ops-repository.js'
import { OrderRepository } from './order-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type ScopedTransaction,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('order submission cost authority PostgreSQL integration', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const tableSessionId = randomUUID()
  const managerId = randomUUID()
  const salespersonId = randomUUID()
  const productId = randomUUID()
  const missingCostProductId = randomUUID()
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    await seed()
  })

  afterAll(async () => pool?.end())

  it('freezes locked catalog cost and ignores later product and JSON changes in attribution', async () => {
    const order = await transactions.run({ tenantId, storeId }, async (transaction) => (
      new OrderRepository(transaction).createSubmitted({
        tableSessionId,
        publicId: 'strong-cost-order-0001',
        channel: 'staff_assisted',
        createdByEmployeeId: salespersonId,
        lines: [{ productId, quantity: 2 }],
      })
    ))
    expect(order.items[0]).toMatchObject({
      unitCostMinorAtSubmission: 1050,
      totalCostMinorAtSubmission: 2100,
      costSource: 'catalog_product',
      costReferenceProductId: productId,
    })
    expect(order.items[0]?.costReferenceProductUpdatedAt).toMatch(/T|\s/)

    await expect(pool.query(`UPDATE mbox.order_items
      SET total_cost_minor_at_submission=2101
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,
    [tenantId, storeId, order.items[0]!.id])).rejects.toMatchObject({ code: '23514' })

    await pool.query(`UPDATE mbox.products
      SET cost_amount_minor=999999, updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [tenantId, storeId, productId])
    await pool.query(`UPDATE mbox.order_items
      SET cost_snapshot='{"unitCostMinor":777777,"totalCostMinor":1555554,"source":"forged"}'::jsonb
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [tenantId, storeId, order.items[0]!.id])
    await pool.query(`UPDATE mbox.orders SET payment_status='paid'
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [tenantId, storeId, order.id])

    await transactions.run({ tenantId, storeId }, async (transaction) => {
      await new CommercialOpsRepository(transaction).createSalesRule({
        productId,
        attributionMode: 'explicit',
        salesCreditBps: 10_000,
        costSource: 'order_item_snapshot',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        effectiveUntil: '2035-01-01T00:00:00.000Z',
        reason: '验证订单提交成本冻结',
        configuredByEmployeeId: managerId,
      })
    })
    const attribution = await transactions.run({ tenantId, storeId }, async (transaction) => (
      new CommercialOpsRepository(transaction).recordSaleAttribution({
        orderItemId: order.items[0]!.id,
        explicitEmployeeId: salespersonId,
        recordedByEmployeeId: managerId,
      })
    ))
    expect(attribution.costAmountDeltaMinor).toBe(2100)
    expect(attribution.attributionSnapshot).toMatchObject({
      costSource: 'order_item_snapshot',
      orderItemCostSource: 'catalog_product',
    })

    const stored = await pool.query<{
      unit_cost: string
      total_cost: string
      cost_source: string
      reference_product_id: string
      reference_version: string
    }>(`
      SELECT unit_cost_minor_at_submission::text AS unit_cost,
        total_cost_minor_at_submission::text AS total_cost,
        cost_source, cost_reference_product_id::text AS reference_product_id,
        cost_reference_product_updated_at::text AS reference_version
      FROM mbox.order_items
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3
    `, [tenantId, storeId, order.items[0]!.id])
    expect(stored.rows[0]).toMatchObject({
      unit_cost: '1050',
      total_cost: '2100',
      cost_source: 'catalog_product',
      reference_product_id: productId,
    })
    expect(stored.rows[0]?.reference_version).toBeTruthy()
  })

  it('records an incomplete cost snapshot without blocking an otherwise sellable order', async () => {
    const order = await transactions.run({ tenantId, storeId }, async (transaction) => (
      new OrderRepository(transaction).createSubmitted({
        tableSessionId,
        publicId: 'missing-cost-order-0001',
        channel: 'guest_qr',
        lines: [{ productId: missingCostProductId, quantity: 1 }],
      })
    ))
    expect(order.items[0]).toMatchObject({
      unitCostMinorAtSubmission: null,
      totalCostMinorAtSubmission: null,
      costSource: 'unavailable',
      costReferenceProductId: null,
      costSnapshot: {
        source: 'unavailable',
        authority: 'strong_order_item_columns',
      },
    })
    const stored = await pool.query<{
      unit_cost: string | null
      total_cost: string | null
      cost_source: string
    }>(`
      SELECT unit_cost_minor_at_submission::text AS unit_cost,
        total_cost_minor_at_submission::text AS total_cost,
        cost_source
      FROM mbox.order_items
      WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3::uuid
    `, [tenantId, storeId, order.id])
    expect(stored.rows[0]).toEqual({
      unit_cost: null,
      total_cost: null,
      cost_source: 'unavailable',
    })
  })

  it('holds the catalog product lock until the order cost is committed', async () => {
    await pool.query(`UPDATE mbox.products SET cost_amount_minor=1234
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [tenantId, storeId, productId])
    const orderClient = await pool.connect()
    let committed = false
    try {
      await orderClient.query('BEGIN')
      const transaction: ScopedTransaction = {
        scope: { tenantId, storeId },
        query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await orderClient.query<Row>(text, values as unknown[] | undefined)
          return { rows: result.rows, rowCount: result.rowCount }
        },
      }
      const order = await new OrderRepository(transaction).createSubmitted({
        tableSessionId,
        publicId: 'strong-cost-lock-order-0001',
        channel: 'integration',
        lines: [{ productId, quantity: 1 }],
      })
      expect(order.items[0]?.unitCostMinorAtSubmission).toBe(1234)

      const updater = await pool.connect()
      try {
        await updater.query('BEGIN')
        await updater.query(`SET LOCAL lock_timeout='150ms'`)
        await expect(updater.query(`UPDATE mbox.products SET cost_amount_minor=4321
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [tenantId, storeId, productId]))
          .rejects.toMatchObject({ code: '55P03' })
        await updater.query('ROLLBACK')
      } finally {
        updater.release()
      }

      await orderClient.query('COMMIT')
      committed = true
      await pool.query(`UPDATE mbox.products SET cost_amount_minor=4321
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [tenantId, storeId, productId])
    } finally {
      if (!committed) await orderClient.query('ROLLBACK').catch(() => undefined)
      orderClient.release()
    }
  })

  async function seed() {
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Cost Authority Tenant')`,
      [tenantId, `cost-${tenantId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name)
      VALUES($1,$2,$3,'Cost Authority Store')`, [storeId, tenantId, `cost-${storeId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
      VALUES($1,$2,$3,'COST','Cost Area','indoor')`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,'COST1','Cost Table',4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status
    ) VALUES($1,$2,$3,$4,'cost-session-0001','2026-08-16',2,'open')`,
    [tableSessionId, tenantId, storeId, tableId])
    await pool.query(`INSERT INTO mbox.employees(
      id,tenant_id,store_id,employee_code,display_name
    ) VALUES($1,$3,$4,'COST_MANAGER','Cost Manager'),($2,$3,$4,'COST_SALES','Cost Sales')`,
    [managerId, salespersonId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,
      product_snapshot,status,cost_amount_minor
    ) VALUES
      ($1,$3,$4,'COST-001','Strong Cost Product','test','none','{}','active',1050),
      ($2,$3,$4,'COST-MISSING','Missing Cost Product','test','none','{}','active',NULL)`,
    [productId, missingCostProductId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.product_prices(
      tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from
    ) VALUES
      ($1,$2,$3,'standard',8800,'CNY','2020-01-01T00:00:00Z'),
      ($1,$2,$4,'standard',6600,'CNY','2020-01-01T00:00:00Z')`,
    [tenantId, storeId, productId, missingCostProductId])
  }
})

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
