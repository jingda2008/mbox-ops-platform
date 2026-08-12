import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'
import { loadGuestTableOrders } from './guest-table-orders-query.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const tableSessionId = '33333333-3333-4333-8333-333333333333'
const customerId = '44444444-4444-4444-8444-444444444444'

describe('loadGuestTableOrders', () => {
  it('returns table-safe order rounds without payer or payment details', async () => {
    let capturedSql = ''
    let capturedValues: readonly unknown[] = []
    const transaction = {
      scope: { tenantId, storeId },
      query: async (sql: string, values: readonly unknown[]) => {
        capturedSql = sql
        capturedValues = values
        return { rows: [{
          public_id: 'order-shared-0001', round_number: 2, channel: 'guest_qr',
          order_status: 'submitted', visibility: 'shared', is_mine: false,
          order_created_at: '2026-08-12T12:00:00.000Z',
          product_id: '55555555-5555-4555-8555-555555555555', product_name: '精酿啤酒',
          quantity: 2, item_status: 'preparing',
        }], rowCount: 1 }
      },
    } as unknown as ScopedTransaction

    await expect(loadGuestTableOrders(transaction, tableSessionId, customerId)).resolves.toEqual([{
      publicId: 'order-shared-0001', round: 2, channel: 'guest_qr', status: 'submitted',
      visibility: 'shared', isMine: false, createdAt: '2026-08-12T12:00:00.000Z',
      items: [{
        productId: '55555555-5555-4555-8555-555555555555', name: '精酿啤酒', quantity: 2,
        status: 'preparing',
      }],
    }])
    expect(capturedValues).toEqual([tenantId, storeId, tableSessionId, customerId])
    expect(capturedSql).toContain("ordering.created_by_customer_id = $4::uuid")
    expect(capturedSql).toContain("ordering.payment_status IN ('paid', 'partially_refunded', 'refunded')")
    expect(capturedSql.indexOf('row_number() OVER')).toBeGreaterThan(capturedSql.indexOf('visible_orders_unbounded'))
    expect(capturedSql).not.toMatch(/provider|amount_minor|customer_name|contact/i)
  })
})

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('loadGuestTableOrders PostgreSQL privacy and turnover isolation', () => {
  const integrationTenantId = '74000000-0000-4000-8000-000000000001'
  const integrationStoreId = '74000000-0000-4000-8000-000000000002'
  const areaId = '74000000-0000-4000-8000-000000000003'
  const tableId = '74000000-0000-4000-8000-000000000004'
  const firstSessionId = '74000000-0000-4000-8000-000000000005'
  const secondSessionId = '74000000-0000-4000-8000-000000000006'
  const customerOneId = '74000000-0000-4000-8000-000000000007'
  const customerTwoId = '74000000-0000-4000-8000-000000000008'
  const productId = '74000000-0000-4000-8000-000000000009'
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await seedSharedOrderFixture(pool, {
      tenantId: integrationTenantId,
      storeId: integrationStoreId,
      areaId,
      tableId,
      firstSessionId,
      secondSessionId,
      customerOneId,
      customerTwoId,
      productId,
    })
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('shares paid rounds but keeps each guest unpaid round private', async () => {
    const scope = { tenantId: integrationTenantId, storeId: integrationStoreId }
    const customerOne = await transactions.run(scope, (transaction) => (
      loadGuestTableOrders(transaction, firstSessionId, customerOneId)
    ), { readOnly: true })
    const customerTwo = await transactions.run(scope, (transaction) => (
      loadGuestTableOrders(transaction, firstSessionId, customerTwoId)
    ), { readOnly: true })

    expect(customerOne.map((order) => order.publicId)).toEqual([
      'shared-private-one', 'shared-paid-two',
    ])
    expect(customerOne.map((order) => order.round)).toEqual([1, 2])
    expect(customerOne.map((order) => order.visibility)).toEqual(['private_pending', 'shared'])
    expect(customerTwo.map((order) => order.publicId)).toEqual([
      'shared-private-two', 'shared-paid-two',
    ])
    expect(customerTwo.map((order) => order.round)).toEqual([1, 2])
  })

  it('does not expose a prior table session after turnover', async () => {
    const orders = await transactions.run(
      { tenantId: integrationTenantId, storeId: integrationStoreId },
      (transaction) => loadGuestTableOrders(transaction, secondSessionId, customerOneId),
      { readOnly: true },
    )
    expect(orders).toEqual([])
  })
})

interface SharedOrderFixtureIds {
  tenantId: string
  storeId: string
  areaId: string
  tableId: string
  firstSessionId: string
  secondSessionId: string
  customerOneId: string
  customerTwoId: string
  productId: string
}

async function seedSharedOrderFixture(pool: Pool, id: SharedOrderFixtureIds): Promise<void> {
  await pool.query(`INSERT INTO mbox.tenants(id, code, name) VALUES ($1, 'shared-orders', 'Shared Orders')`, [id.tenantId])
  await pool.query(`INSERT INTO mbox.stores(id, tenant_id, code, name) VALUES ($1, $2, 'shared-order-store', 'Shared Order Store')`, [id.storeId, id.tenantId])
  await pool.query(`INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type) VALUES ($1, $2, $3, 'SO', '共享桌', 'indoor')`, [id.areaId, id.tenantId, id.storeId])
  await pool.query(`INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity) VALUES ($1, $2, $3, $4, 'W01', 'W01', 4)`, [id.tableId, id.tenantId, id.storeId, id.areaId])
  await pool.query(`
    INSERT INTO mbox.table_sessions(
      id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status, opened_at, closed_at
    ) VALUES
      ($1, $3, $4, $5, 'shared-session-old', CURRENT_DATE - 1, 2, 'closed',
        clock_timestamp() - interval '1 day', clock_timestamp() - interval '12 hours'),
      ($2, $3, $4, $5, 'shared-session-new', CURRENT_DATE, 2, 'open', clock_timestamp(), NULL)
  `, [id.firstSessionId, id.secondSessionId, id.tenantId, id.storeId, id.tableId])
  await pool.query(`
    INSERT INTO mbox.customers(id, tenant_id, store_id, public_id) VALUES
      ($1, $3, $4, 'shared-customer-one'),
      ($2, $3, $4, 'shared-customer-two')
  `, [id.customerOneId, id.customerTwoId, id.tenantId, id.storeId])
  await pool.query(`INSERT INTO mbox.products(id, tenant_id, store_id, code, name, category_code, fulfillment_station) VALUES ($1, $2, $3, 'SO-DRINK', '精酿啤酒', 'drink', 'bar')`, [id.productId, id.tenantId, id.storeId])
  await pool.query(`
    INSERT INTO mbox.orders(
      id, tenant_id, store_id, table_session_id, public_id, channel, status,
      payment_status, subtotal_amount_minor, total_amount_minor,
      created_by_customer_id, created_at, submitted_at
    ) VALUES
      ('74000000-0000-4000-8000-000000000010', $1, $2, $3, 'shared-private-one', 'guest_qr', 'submitted', 'unpaid', 6800, 6800, $4, clock_timestamp() - interval '3 minutes', clock_timestamp()),
      ('74000000-0000-4000-8000-000000000011', $1, $2, $3, 'shared-private-two', 'guest_qr', 'submitted', 'unpaid', 6800, 6800, $5, clock_timestamp() - interval '2 minutes', clock_timestamp()),
      ('74000000-0000-4000-8000-000000000012', $1, $2, $3, 'shared-paid-two', 'guest_qr', 'fulfilling', 'paid', 13600, 13600, $5, clock_timestamp() - interval '1 minute', clock_timestamp())
  `, [id.tenantId, id.storeId, id.firstSessionId, id.customerOneId, id.customerTwoId])
  await pool.query(`
    INSERT INTO mbox.order_items(
      id, tenant_id, store_id, order_id, product_id, quantity, unit_price_minor,
      total_amount_minor, fulfillment_station, product_snapshot, status
    ) VALUES
      ('74000000-0000-4000-8000-000000000020', $1, $2, '74000000-0000-4000-8000-000000000010', $3, 1, 6800, 6800, 'bar', '{"name":"精酿啤酒"}', 'submitted'),
      ('74000000-0000-4000-8000-000000000021', $1, $2, '74000000-0000-4000-8000-000000000011', $3, 1, 6800, 6800, 'bar', '{"name":"精酿啤酒"}', 'submitted'),
      ('74000000-0000-4000-8000-000000000022', $1, $2, '74000000-0000-4000-8000-000000000012', $3, 2, 6800, 13600, 'bar', '{"name":"精酿啤酒"}', 'preparing')
  `, [id.tenantId, id.storeId, id.productId])
}
