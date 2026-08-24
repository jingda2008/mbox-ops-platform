import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  GuestSharedCartRepository,
  GuestSharedCartVersionConflictError,
} from './guest-shared-cart-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('GuestSharedCartRepository PostgreSQL authority', () => {
  const tenantId = '10600000-0000-4000-8000-000000000001'
  const storeId = '10600000-0000-4000-8000-000000000002'
  const areaId = '10600000-0000-4000-8000-000000000003'
  const tableId = '10600000-0000-4000-8000-000000000004'
  const tableSessionId = '10600000-0000-4000-8000-000000000005'
  const productId = '10600000-0000-4000-8000-000000000006'
  const scope = { tenantId, storeId }
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES ($1,'shared-cart','Shared Cart')`, [tenantId])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES ($1,$2,'shared-cart','Shared Cart')`, [storeId, tenantId])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES ($1,$2,$3,'SC','共享购物车区','indoor')`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES ($1,$2,$3,$4,'SC01','SC01',4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`
      INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)
      VALUES ($1,$2,$3,$4,'shared-cart-session',CURRENT_DATE,2,'open')
    `, [tableSessionId, tenantId, storeId, tableId])
    await pool.query(`
      INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station)
      VALUES ($1,$2,$3,'SC-DRINK','共享购物车测试饮品','drink','bar')
    `, [productId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from)
      VALUES ($1,$2,$3,'standard',2800,'CNY',clock_timestamp()-interval '1 minute')
    `, [tenantId, storeId, productId])
  })

  afterAll(async () => { await pool?.end() })

  it('uses table-session-scoped server versions and replays an identical operation safely', async () => {
    const protocol = await pool.query<{ guest_cart_protocol_version: number }>(`
      SELECT guest_cart_protocol_version FROM mbox.table_sessions WHERE id=$1::uuid
    `, [tableSessionId])
    expect(protocol.rows[0]?.guest_cart_protocol_version).toBe(2)
    const initial = await transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).readOpen(tableSessionId, 'GSC10600000000040008000000000000001')
    ))
    expect(initial).toMatchObject({ tableSessionId, generation: 1, version: 0, status: 'open', lines: [] })

    const changed = await transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).adjust(tableSessionId, 'GSC10600000000040008000000000000001', {
        productId, delta: 2, expectedVersion: 0, operationId: 'shared-cart-adjust-0001',
        actorSessionRef: 'guest-session:shared-cart-test',
      })
    ))
    expect(changed).toMatchObject({
      version: 1,
      totalAmountMinor: 5600,
      currency: 'CNY',
      lines: [{ productId, quantity: 2, unitPriceMinor: 2800, subtotalAmountMinor: 5600, available: true }],
    })

    const replay = await transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).adjust(tableSessionId, 'GSC10600000000040008000000000000001', {
        productId, delta: 2, expectedVersion: 0, operationId: 'shared-cart-adjust-0001',
        actorSessionRef: 'guest-session:shared-cart-test',
      })
    ))
    expect(replay).toMatchObject({ version: 1, lines: [{ productId, quantity: 2 }] })

    await expect(transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).adjust(tableSessionId, 'GSC10600000000040008000000000000001', {
        productId, delta: 1, expectedVersion: 0, operationId: 'shared-cart-adjust-0002',
        actorSessionRef: 'guest-session:shared-cart-test',
      })
    ))).rejects.toBeInstanceOf(GuestSharedCartVersionConflictError)
  })

  it('expires the open cart when the table session leaves its active state', async () => {
    await pool.query(`UPDATE mbox.table_sessions SET status='closing' WHERE id=$1::uuid`, [tableSessionId])
    const cart = await pool.query<{ status: string; expired_at: string | null }>(`
      SELECT status,expired_at::text
      FROM mbox.guest_shared_carts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND table_session_id=$3::uuid
      ORDER BY generation DESC
      LIMIT 1
    `, [tenantId, storeId, tableSessionId])
    expect(cart.rows[0]).toMatchObject({ status: 'expired' })
    expect(cart.rows[0]?.expired_at).toBeTruthy()
  })
})
