import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  PostgresOrderCancellationRepository,
  UnpaidOrderCancellationConflictError,
} from './order-cancellation-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('unpaid order cancellation', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const employeeId = randomUUID()
  const roleId = randomUUID()
  let pool: Pool
  let repository: PostgresOrderCancellationRepository

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    repository = new PostgresOrderCancellationRepository(
      new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool),
    )
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Cancellation Tenant')`, [
      tenantId, `cancel-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Cancellation Store')`, [
      storeId, tenantId, `cancel-${storeId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type,sort_order)
      VALUES($1,$2,$3,'MAIN','主区','indoor',1)`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,'C01','C01',4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,'cashier','收银员')`, [employeeId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name)
      VALUES($1,$2,$3,'CASHIER','收银员')`, [roleId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id)
      VALUES($1,$2,$3,$4)`, [tenantId, storeId, employeeId, roleId])
    await pool.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name)
      VALUES($1,$2,'order.cancel_unpaid','取消未付款订单')
      ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET status='active'`, [tenantId, storeId])
    await pool.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
      SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions
      WHERE tenant_id=$1 AND store_id=$2 AND code='order.cancel_unpaid'`, [tenantId, storeId, roleId])
  })

  afterAll(async () => { await pool?.end() })

  it('preserves delivered facts, cancels only unfinished work and replays the original result', async () => {
    const fixture = await createOrder('unpaid', null, true)
    const input = {
      scope: { tenantId, storeId },
      orderId: fixture.orderId,
      employeeId,
      businessDate: '2026-08-21',
      reasonCode: 'test_cleanup' as const,
      reasonNote: '跨营业日测试订单，现场确认未付款',
      idempotencyKey: `cancel-unpaid:${randomUUID()}`,
    }
    const first = await repository.cancel(input)
    const replay = await repository.cancel(input)

    expect(first).toMatchObject({
      orderPublicId: fixture.publicId,
      sourceBusinessDate: '2026-08-20',
      actionBusinessDate: '2026-08-21',
      deliveredItemCount: 1,
      cancelledItemCount: 1,
      cancelledKdsTaskCount: 1,
      releasedInventoryReservationCount: 1,
      replayed: false,
    })
    expect(replay).toEqual({ ...first, replayed: true })
    const order = await pool.query(`SELECT status,payment_status FROM mbox.orders WHERE id=$1`, [fixture.orderId])
    expect(order.rows[0]).toEqual({ status: 'cancelled', payment_status: 'unpaid' })
    const items = await pool.query(`SELECT status FROM mbox.order_items WHERE order_id=$1 ORDER BY created_at,id`, [fixture.orderId])
    expect(items.rows.map((row) => row.status).sort()).toEqual(['cancelled', 'delivered'])
    const evidence = await pool.query(`SELECT count(*)::integer AS count FROM mbox.order_cancellation_events
      WHERE order_id=$1`, [fixture.orderId])
    expect(evidence.rows[0]?.count).toBe(1)
    const inventory = await pool.query(`SELECT balance.reserved_quantity::text,reservation.status
      FROM mbox.inventory_order_reservations reservation
      JOIN mbox.inventory_balances balance
        ON balance.tenant_id=reservation.tenant_id AND balance.store_id=reservation.store_id
       AND balance.inventory_item_id=reservation.inventory_item_id
      WHERE reservation.order_id=$1`, [fixture.orderId])
    expect(inventory.rows[0]).toEqual({ reserved_quantity: '0.000000', status: 'released' })
  })

  it('fails closed while a payment outcome is still pending', async () => {
    const fixture = await createOrder('unpaid', 'pending')
    await expect(repository.cancel({
      scope: { tenantId, storeId },
      orderId: fixture.orderId,
      employeeId,
      businessDate: '2026-08-21',
      reasonCode: 'guest_left',
      reasonNote: '客人离店，但支付结果尚未明确',
      idempotencyKey: `cancel-unpaid:${randomUUID()}`,
    })).rejects.toBeInstanceOf(UnpaidOrderCancellationConflictError)
    const order = await pool.query(`SELECT status FROM mbox.orders WHERE id=$1`, [fixture.orderId])
    expect(order.rows[0]?.status).toBe('submitted')
  })

  it('serializes concurrent retries into one cancellation fact', async () => {
    const fixture = await createOrder('unpaid', null, true)
    const input = {
      scope: { tenantId, storeId },
      orderId: fixture.orderId,
      employeeId,
      businessDate: '2026-08-21',
      reasonCode: 'test_cleanup' as const,
      reasonNote: '并发重试测试订单，现场确认未付款',
      idempotencyKey: `cancel-unpaid:${randomUUID()}`,
    }
    const results = await Promise.all([repository.cancel(input), repository.cancel(input)])

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true])
    expect(results[0]?.eventId).toBe(results[1]?.eventId)
    const evidence = await pool.query(`SELECT count(*)::integer AS count
      FROM mbox.order_cancellation_events WHERE order_id=$1`, [fixture.orderId])
    expect(evidence.rows[0]?.count).toBe(1)
  })

  async function createOrder(
    paymentStatus: 'unpaid',
    paymentIntent: 'pending' | null,
    reserveInventory = false,
  ) {
    const orderTableId = randomUUID()
    const sessionId = randomUUID()
    const orderId = randomUUID()
    const publicId = `order-${randomUUID()}`
    const deliveredProductId = randomUUID()
    const pendingProductId = randomUUID()
    const deliveredItemId = randomUUID()
    const pendingItemId = randomUUID()
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,$5,$5,4)`, [
      orderTableId, tenantId, storeId, areaId, `C-${randomUUID().slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,
      guest_profile_snapshot,status,opened_by_employee_id
    ) VALUES($1,$2,$3,$4,$5,'2026-08-20',2,4,'{}','open',$6)`, [
      sessionId, tenantId, storeId, orderTableId, `session-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_snapshot
    ) VALUES
      ($1,$3,$4,$5,'已送达饮品','drink','bar','{}'),
      ($2,$3,$4,$6,'未制作饮品','drink','bar','{}')`, [
      deliveredProductId, pendingProductId, tenantId, storeId,
      `D-${randomUUID().slice(0, 8)}`, `P-${randomUUID().slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',$6,200,0,200)`, [
      orderId, tenantId, storeId, sessionId, publicId, paymentStatus,
    ])
    await pool.query(`INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,
      total_amount_minor,fulfillment_station,product_snapshot,status
    ) VALUES
      ($1,$3,$4,$5,$6,1,100,0,100,'bar','{}','delivered'),
      ($2,$3,$4,$5,$7,1,100,0,100,'bar','{}','submitted')`, [
      deliveredItemId, pendingItemId, tenantId, storeId, orderId, deliveredProductId, pendingProductId,
    ])
    await pool.query(`INSERT INTO mbox.kds_tasks(
      tenant_id,store_id,order_item_id,station_code,status,quantity
    ) VALUES($1,$2,$3,'bar','pending',1)`, [tenantId, storeId, pendingItemId])
    if (reserveInventory) {
      const inventoryItemId = randomUUID()
      await pool.query(`INSERT INTO mbox.inventory_items(
        id,tenant_id,store_id,sku,name,item_type,base_unit
      ) VALUES($1,$2,$3,$4,'测试酒水库存','bottle','bottle')`, [
        inventoryItemId, tenantId, storeId, `INV-${randomUUID().slice(0, 8)}`,
      ])
      await pool.query(`INSERT INTO mbox.inventory_balances(
        tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity
      ) VALUES($1,$2,$3,5,1)`, [tenantId, storeId, inventoryItemId])
      await pool.query(`INSERT INTO mbox.inventory_order_reservations(
        tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,status,expires_at
      ) VALUES($1,$2,$3,$4,$5,1,'reserved',clock_timestamp()+interval '10 minutes')`, [
        tenantId, storeId, orderId, pendingItemId, inventoryItemId,
      ])
    }
    if (paymentIntent !== null) {
      await pool.query(`INSERT INTO mbox.payments(
        tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status
      ) VALUES($1,$2,$3,$4,'postar','native_qr',200,$5)`, [
        tenantId, storeId, orderId, `payment-${randomUUID()}`, paymentIntent,
      ])
    }
    return { orderId, publicId }
  }
})
