import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'
import { loadGuestTableOrders, loadGuestCustomerOrderHistory } from './guest-table-orders-query.js'

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
          paid_at: null, total_amount_minor: '6800', subtotal_amount_minor: '6800', discount_amount_minor: '0',
          payment_status: 'unpaid', payment_access: 'available', payable_amount_minor: '6800', currency: 'CNY',
          pricing_kind: 'gift',
          product_id: '55555555-5555-4555-8555-555555555555', product_name: '精酿啤酒',
          quantity: 2, item_status: 'preparing', item_note: '少冰',
          item_id: 'item-one', unit_price_minor: '3400', item_total_amount_minor: '6800', components: [],
        }], rowCount: 1 }
      },
    } as unknown as ScopedTransaction

    await expect(loadGuestTableOrders(transaction, tableSessionId, customerId)).resolves.toEqual([{
      publicId: 'order-shared-0001', round: 2, channel: 'guest_qr', sourceText: '顾客扫码点单', status: 'submitted',
      visibility: 'shared', isMine: false, createdAt: '2026-08-12T12:00:00.000Z',
      paidAt: null, totalAmountMinor: 6800, subtotalAmountMinor: 6800, discountAmountMinor: 0,
      paymentStatus: 'unpaid', paymentAccess: 'available', payableAmountMinor: 6800, currency: 'CNY',
      pricingKind: 'gift', pricingLabel: '门店赠送',
      items: [{
        productId: '55555555-5555-4555-8555-555555555555', name: '精酿啤酒', quantity: 2,
        status: 'preparing',
        id: 'item-one', unitPriceMinor: 3400, totalAmountMinor: 6800, components: [], note: '少冰',
      }],
    }])
    expect(capturedValues).toEqual([tenantId, storeId, tableSessionId, customerId])
    expect(capturedSql).toContain("COALESCE(ordering.created_by_customer_id = $4::uuid, false)")
    expect(capturedSql).toContain("payment.status IN ('succeeded', 'partially_refunded', 'refunded')")
    expect(capturedSql).toContain("WHEN active_payment.method = 'auth_code' THEN 'staff_collecting'")
    expect(capturedSql).toContain("WHEN active_payment.id IS NOT NULL THEN 'payment_in_progress'")
    expect(capturedSql).toContain("pricing_authorization.status = 'consumed'")
    expect(capturedSql).not.toContain("pricing_authorization.authorization_snapshot")
    expect(capturedSql.indexOf('row_number() OVER')).toBeGreaterThan(capturedSql.indexOf('visible_orders_unbounded'))
    expect(capturedSql).not.toMatch(/provider_transaction|customer_name|contact/i)
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

  it('shares every submitted table round while keeping payer identity private', async () => {
    const scope = { tenantId: integrationTenantId, storeId: integrationStoreId }
    const customerOne = await transactions.run(scope, (transaction) => (
      loadGuestTableOrders(transaction, firstSessionId, customerOneId)
    ), { readOnly: true })
    const customerTwo = await transactions.run(scope, (transaction) => (
      loadGuestTableOrders(transaction, firstSessionId, customerTwoId)
    ), { readOnly: true })

    expect(customerOne.map((order) => order.publicId)).toEqual([
      'shared-private-one', 'shared-private-two', 'shared-paid-two', 'staff-assisted-unpaid',
    ])
    expect(customerOne.map((order) => order.round)).toEqual([1, 2, 3, 4])
    expect(customerOne.map((order) => order.visibility)).toEqual(['shared', 'shared', 'shared', 'shared'])
    expect(customerTwo.map((order) => order.publicId)).toEqual([
      'shared-private-one', 'shared-private-two', 'shared-paid-two', 'staff-assisted-unpaid',
    ])
    expect(customerTwo.map((order) => order.round)).toEqual([1, 2, 3, 4])
    expect(customerTwo.at(-1)).toMatchObject({
      channel: 'staff_assisted', sourceText: '服务员协助点单', paymentAccess: 'staff_collecting', payableAmountMinor: 6800,
    })
  })

  it('shows an employee barcode collection as busy instead of allowing a second guest payment', async () => {
    const scope = { tenantId: integrationTenantId, storeId: integrationStoreId }
    const [customerOne, customerTwo] = await Promise.all([
      transactions.run(scope, (transaction) => loadGuestTableOrders(transaction, firstSessionId, customerOneId), { readOnly: true }),
      transactions.run(scope, (transaction) => loadGuestTableOrders(transaction, firstSessionId, customerTwoId), { readOnly: true }),
    ])

    expect(customerOne.find((order) => order.publicId === 'staff-assisted-unpaid')?.paymentAccess)
      .toBe('staff_collecting')
    expect(customerTwo.find((order) => order.publicId === 'staff-assisted-unpaid')?.paymentAccess)
      .toBe('staff_collecting')
  })

  it('keeps a pending QR payment under review when the provider action is missing and in progress when it is ready',async()=>{
    const paymentId='74000000-0000-4000-8000-000000000032'
    const orderId='74000000-0000-4000-8000-000000000033'
    const orderItemId='74000000-0000-4000-8000-000000000034'
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,total_amount_minor,created_by_customer_id,submitted_at
    ) VALUES($1,$2,$3,$4,'shared-payment-window','guest_qr','submitted','unpaid',
      6800,6800,$5,clock_timestamp())`,
    [orderId,integrationTenantId,integrationStoreId,secondSessionId,customerOneId])
    await pool.query(`INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,
      fulfillment_station,product_snapshot,status
    ) VALUES($1,$2,$3,$4,$5,1,6800,6800,'bar','{"name":"精酿啤酒"}'::jsonb,'submitted')`,
    [orderItemId,integrationTenantId,integrationStoreId,orderId,productId])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status,provider_snapshot
    ) VALUES($1,$2,$3,$4,'PQRFAILWINDOW001','postar','native_qr',6800,'CNY','pending','{}'::jsonb)`,
    [paymentId,integrationTenantId,integrationStoreId,orderId])
    const scope={tenantId:integrationTenantId,storeId:integrationStoreId}
    const missingAction=await transactions.run(scope,(transaction)=>(
      loadGuestTableOrders(transaction,secondSessionId,customerOneId)
    ),{readOnly:true})
    expect(missingAction.find((order)=>order.publicId==='shared-payment-window')?.paymentAccess).toBe('status_review')

    await pool.query(`INSERT INTO mbox.payment_provider_actions(
      payment_id,tenant_id,store_id,presentation,initiated_by_type,initiated_by_ref,state,
      ciphertext,nonce,auth_tag,expires_at
    ) VALUES($1,$2,$3,'qr','guest',$4,'ready',decode('aa','hex'),
      decode(repeat('aa',12),'hex'),decode(repeat('bb',16),'hex'),clock_timestamp()+interval '5 minutes')`,
    [paymentId,integrationTenantId,integrationStoreId,customerOneId])
    const readyAction=await transactions.run(scope,(transaction)=>(
      loadGuestTableOrders(transaction,secondSessionId,customerTwoId)
    ),{readOnly:true})
    expect(readyAction.find((order)=>order.publicId==='shared-payment-window')?.paymentAccess).toBe('payment_in_progress')
    await pool.query('DELETE FROM mbox.payment_provider_actions WHERE payment_id=$1::uuid',[paymentId])
    await pool.query('DELETE FROM mbox.payments WHERE id=$1::uuid',[paymentId])
    await pool.query('DELETE FROM mbox.order_items WHERE id=$1::uuid',[orderItemId])
    await pool.query('DELETE FROM mbox.orders WHERE id=$1::uuid',[orderId])
  })

  it('does not expose a prior table session after turnover', async () => {
    const orders = await transactions.run(
      { tenantId: integrationTenantId, storeId: integrationStoreId },
      (transaction) => loadGuestTableOrders(transaction, secondSessionId, customerOneId),
      { readOnly: true },
    )
    expect(orders).toEqual([])
  })

  it('retains only personally created paid history, independent of table participation', async () => {
    const scope = { tenantId: integrationTenantId, storeId: integrationStoreId }
    const own = await transactions.run(scope, async tx => {
      await tx.query('SET LOCAL ROLE mbox_runtime')
      return loadGuestCustomerOrderHistory(tx, customerTwoId)
    }, { readOnly: true })
    expect(own.map(order => order.publicId)).toEqual(['shared-paid-two'])
    expect(own[0]).toMatchObject({ visibility: 'private', totalAmountMinor: 13600 })
    const other = await transactions.run(scope, tx => loadGuestCustomerOrderHistory(tx, customerOneId), { readOnly: true })
    expect(other).toEqual([])
    const foreign = await transactions.run({ ...scope, storeId: '74000000-0000-4000-8000-000000000099' },
      tx => loadGuestCustomerOrderHistory(tx, customerTwoId), { readOnly: true })
    expect(foreign).toEqual([])
  })

  it('keeps cancelled but financially settled orders in personal history, never in the live table list', async () => {
    const scope = { tenantId: integrationTenantId, storeId: integrationStoreId }
    // The old fixture round is already closed and correctly rejects changing
    // its business state. Create this separate scenario in the open round.
    const orderId = randomUUID()
    await pool.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,total_amount_minor,created_by_customer_id,cancelled_at)
      VALUES($1,$2,$3,$4,'cancelled-refunded-history','guest_qr','cancelled','refunded',13600,13600,$5,clock_timestamp())`,
      [orderId,integrationTenantId,integrationStoreId,secondSessionId,customerTwoId])
    await pool.query(`INSERT INTO mbox.order_items(tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status)
      SELECT item.tenant_id,item.store_id,$1,item.product_id,item.quantity,item.unit_price_minor,item.total_amount_minor,item.fulfillment_station,item.product_snapshot,'cancelled'
      FROM mbox.order_items item JOIN mbox.orders ordering ON ordering.id=item.order_id
      WHERE ordering.tenant_id=$2 AND ordering.public_id='shared-paid-two' AND item.parent_order_item_id IS NULL`,[orderId,integrationTenantId])
    const own = await transactions.run(scope, tx => loadGuestCustomerOrderHistory(tx, customerTwoId), { readOnly: true })
    expect(own).toHaveLength(2)
    expect(own[0]).toMatchObject({ publicId:'cancelled-refunded-history',status:'cancelled',paymentStatus:'refunded',visibility:'private',paymentAccess:'not_required' })
    expect(own[0]!.items.length).toBeGreaterThan(0)
    const live = await transactions.run(scope, tx => loadGuestTableOrders(tx, secondSessionId, customerTwoId), { readOnly: true })
    expect(live.some(order => order.publicId==='cancelled-refunded-history')).toBe(false)
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
      ($1, $2, $3, $4, 'shared-session-old', CURRENT_DATE - 1, 2, 'open',
        clock_timestamp() - interval '1 day', NULL)
  `, [id.firstSessionId, id.tenantId, id.storeId, id.tableId])
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
      ,('74000000-0000-4000-8000-000000000013', $1, $2, $3, 'staff-assisted-unpaid', 'staff_assisted', 'submitted', 'unpaid', 6800, 6800, NULL, clock_timestamp(), clock_timestamp())
  `, [id.tenantId, id.storeId, id.firstSessionId, id.customerOneId, id.customerTwoId])
  await pool.query(`
    INSERT INTO mbox.order_items(
      id, tenant_id, store_id, order_id, product_id, quantity, unit_price_minor,
      total_amount_minor, fulfillment_station, product_snapshot, status
    ) VALUES
      ('74000000-0000-4000-8000-000000000020', $1, $2, '74000000-0000-4000-8000-000000000010', $3, 1, 6800, 6800, 'bar', '{"name":"精酿啤酒"}', 'submitted'),
      ('74000000-0000-4000-8000-000000000021', $1, $2, '74000000-0000-4000-8000-000000000011', $3, 1, 6800, 6800, 'bar', '{"name":"精酿啤酒"}', 'submitted'),
      ('74000000-0000-4000-8000-000000000022', $1, $2, '74000000-0000-4000-8000-000000000012', $3, 2, 6800, 13600, 'bar', '{"name":"精酿啤酒"}', 'preparing')
      ,('74000000-0000-4000-8000-000000000023', $1, $2, '74000000-0000-4000-8000-000000000013', $3, 1, 6800, 6800, 'bar', '{"name":"精酿啤酒"}', 'submitted')
  `, [id.tenantId, id.storeId, id.productId])
  await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,method,
      amount_minor,currency,status,provider_snapshot
    ) VALUES(
      '74000000-0000-4000-8000-000000000030',$1,$2,
      '74000000-0000-4000-8000-000000000013','PSTAFFBARCODE0001',
      'postar','auth_code',6800,'CNY','pending','{}'::jsonb
    )`,[id.tenantId,id.storeId])
  await pool.query(`INSERT INTO mbox.payment_provider_actions(
      payment_id,tenant_id,store_id,presentation,initiated_by_type,
      initiated_by_ref,state,expires_at
    ) VALUES(
      '74000000-0000-4000-8000-000000000030',$1,$2,'barcode','employee',
      '74000000-0000-4000-8000-000000000031','creating',clock_timestamp()+interval '5 minutes'
    )`,[id.tenantId,id.storeId])
  await pool.query(`UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp()
    WHERE id=$1`,[id.firstSessionId])
  await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status,opened_at
    ) VALUES($1,$2,$3,$4,'shared-session-new',CURRENT_DATE,2,'open',clock_timestamp())`,
  [id.secondSessionId,id.tenantId,id.storeId,id.tableId])
}
