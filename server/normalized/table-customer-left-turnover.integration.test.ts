import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  PostgresTableCustomerLeftTurnoverRepository,
} from './table-customer-left-turnover-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('customer-left table turnover', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const employeeId = randomUUID()
  const approverId = randomUUID()
  const roleId = randomUUID()
  let pool: Pool
  let businessDate: string

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Customer left tenant')`, [
      tenantId, `customer-left-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Customer left store')`, [
      storeId, tenantId, `customer-left-${storeId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
      VALUES($1,$2,$3,'MAIN','主区','indoor')`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,'L01','L01',4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,'manager','店长')`, [employeeId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,'approver','复核人')`, [approverId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name)
      VALUES($1,$2,$3,'MANAGER','店长')`, [roleId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id)
      VALUES($1,$2,$3,$4)`, [tenantId, storeId, employeeId, roleId])
    for (const permission of ['table.close', 'table.turnover_unsettled']) {
      await pool.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,status)
        VALUES($1,$2,$3,$3,'active')
        ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET status='active'`, [tenantId, storeId, permission])
      await pool.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
        SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions
        WHERE tenant_id=$1 AND store_id=$2 AND code=$4
        ON CONFLICT DO NOTHING`, [tenantId, storeId, roleId, permission])
    }
    const date = await pool.query<{ business_date: string }>(`
      SELECT ((clock_timestamp() AT TIME ZONE timezone)-business_day_cutoff)::date::text AS business_date
      FROM mbox.stores WHERE tenant_id=$1 AND id=$2`, [tenantId, storeId])
    businessDate = date.rows[0]!.business_date
  })

  afterAll(async () => { await pool?.end() })

  it('cancels only unfulfilled work, preserves pending collection evidence, and permits an auditable table turnover', async () => {
    const fixture = await createFixture()
    const runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    const input = {
      scope: { tenantId, storeId }, tableSessionId: fixture.sessionId, employeeId, businessDate,
      reasonNote: '顾客离店，现场未收到明确成功收款，取消未制作项目',
      idempotencyKey: `customer-left-turnover:${randomUUID()}`,
    }
    const first = await runner.run(input.scope, async (transaction) =>
      new PostgresTableCustomerLeftTurnoverRepository(transaction).close(input))
    const replay = await runner.run(input.scope, async (transaction) =>
      new PostgresTableCustomerLeftTurnoverRepository(transaction).close(input))

    expect(first).toMatchObject({
      tableSessionId: fixture.sessionId, tableCode: 'L01', cancelledOrderCount: 1,
      pendingPaymentCount: 1, deliveredUnpaidAmountMinor: 100, cancelledServiceTaskCount: 1,
      replayed: false,
    })
    expect(replay).toEqual({ ...first, replayed: true })
    await expect(pool.query(`SELECT status FROM mbox.table_sessions WHERE id=$1`, [fixture.sessionId]))
      .resolves.toMatchObject({ rows: [{ status: 'closed' }] })
    await expect(pool.query(`SELECT status,payment_status FROM mbox.orders WHERE id=$1`, [fixture.orderId]))
      .resolves.toMatchObject({ rows: [{ status: 'cancelled', payment_status: 'unpaid' }] })
    const itemStates = await pool.query<{ status: string }>(`
      SELECT status FROM mbox.order_items WHERE order_id=$1 ORDER BY id`, [fixture.orderId])
    expect(itemStates.rows.map((row) => row.status).sort()).toEqual(['cancelled', 'delivered'])
    await expect(pool.query(`SELECT status FROM mbox.inventory_order_reservations WHERE order_id=$1`, [fixture.orderId]))
      .resolves.toMatchObject({ rows: [{ status: 'released' }] })
    await expect(pool.query(`SELECT status FROM mbox.payments WHERE id=$1`, [fixture.paymentId]))
      .resolves.toMatchObject({ rows: [{ status: 'pending' }] })
    await expect(pool.query(`SELECT reason_code,settled_amount_minor::text FROM mbox.order_settlement_exception_events
      WHERE order_id=$1`, [fixture.orderId]))
      .resolves.toMatchObject({ rows: [{ reason_code: 'customer_left', settled_amount_minor: '100' }] })
  })

  it('closes the physical table while preserving a paid order with an approved refund', async () => {
    const fixture = await createFixture()
    const settled = await createSettledHistory(fixture.sessionId)
    const runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    const input = {
      scope: { tenantId, storeId }, tableSessionId: fixture.sessionId, employeeId, businessDate,
      reasonNote: '顾客离店，财务后续处理不阻断物理翻台',
      idempotencyKey: `customer-left-settled-history:${randomUUID()}`,
    }

    const result = await runner.run(input.scope, async (transaction) =>
      new PostgresTableCustomerLeftTurnoverRepository(transaction).close(input))

    expect(result).toMatchObject({
      tableSessionId: fixture.sessionId,
      cancelledOrderCount: 1,
      pendingPaymentCount: 1,
    })
    await expect(pool.query(`SELECT status FROM mbox.table_sessions WHERE id=$1`, [fixture.sessionId]))
      .resolves.toMatchObject({ rows: [{ status: 'closed' }] })
    await expect(pool.query(`SELECT status,payment_status FROM mbox.orders WHERE id=$1`, [settled.orderId]))
      .resolves.toMatchObject({ rows: [{ status: 'submitted', payment_status: 'paid' }] })
    await expect(pool.query(`SELECT status FROM mbox.payments WHERE id=$1`, [settled.paymentId]))
      .resolves.toMatchObject({ rows: [{ status: 'succeeded' }] })
    await expect(pool.query(`SELECT status FROM mbox.refunds WHERE id=$1`, [settled.refundId]))
      .resolves.toMatchObject({ rows: [{ status: 'approved' }] })
    await expect(pool.query(`SELECT status FROM mbox.order_items WHERE id=$1`, [settled.deliveredItemId]))
      .resolves.toMatchObject({ rows: [{ status: 'delivered' }] })
    await expect(pool.query(`SELECT status FROM mbox.order_items WHERE id=$1`, [settled.unfulfilledItemId]))
      .resolves.toMatchObject({ rows: [{ status: 'cancelled' }] })
    await expect(pool.query(`SELECT status FROM mbox.kds_tasks WHERE id=$1`, [settled.taskId]))
      .resolves.toMatchObject({ rows: [{ status: 'cancelled' }] })
    await expect(pool.query(`SELECT count(*)::integer AS count FROM mbox.order_cancellation_events WHERE order_id=$1`, [settled.orderId]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] })
  })

  async function createSettledHistory(sessionId: string) {
    const orderId = randomUUID()
    const paymentId = randomUUID()
    const refundId = randomUUID()
    const deliveredItemId = randomUUID()
    const unfulfilledItemId = randomUUID()
    const taskId = randomUUID()
    const productId = randomUUID()
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_snapshot
    ) VALUES($1,$2,$3,$4,'已退款的旧桌酒水','drink','bar','{}')`, [
      productId, tenantId, storeId, `SETTLED-${randomUUID().slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,created_by_employee_id,submitted_at
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','paid',200,0,200,$6,clock_timestamp())`, [
      orderId, tenantId, storeId, sessionId, `settled-history-order-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,total_amount_minor,
      currency,fulfillment_station,product_snapshot,status
    ) VALUES
      ($1,$3,$4,$5,$6,1,100,0,100,'CNY','bar','{}','delivered'),
      ($2,$3,$4,$5,$6,1,100,0,100,'CNY','bar','{}','submitted')`, [
      deliveredItemId, unfulfilledItemId, tenantId, storeId, orderId, productId,
    ])
    await pool.query(`INSERT INTO mbox.kds_tasks(
      id,tenant_id,store_id,order_item_id,station_code,status,quantity,ready_at
    ) VALUES($1,$2,$3,$4,'bar','ready',1,clock_timestamp())`, [
      taskId, tenantId, storeId, unfulfilledItemId,
    ])
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,
      method,amount_minor,currency,status,succeeded_at
    ) VALUES($1,$2,$3,$4,$5,'cash',$6,'cash',200,'CNY','succeeded',clock_timestamp())`, [
      paymentId, tenantId, storeId, orderId, `settled-history-payment-${randomUUID()}`,
      `settled-history-transaction-${randomUUID()}`,
    ])
    await pool.query(`INSERT INTO mbox.refunds(
      id,tenant_id,store_id,payment_id,public_id,amount_minor,currency,status,reason,
      requested_by_employee_id,approved_by_employee_id,decision_reason
    ) VALUES($1,$2,$3,$4,$5,200,'CNY','approved','顾客离店后的待执行退款',$6,$7,'现场复核已通过')`, [
      refundId, tenantId, storeId, paymentId, `settled-history-refund-${randomUUID()}`,
      employeeId, approverId,
    ])
    return { orderId, paymentId, refundId, deliveredItemId, unfulfilledItemId, taskId }
  }

  async function createFixture() {
    const sessionId = randomUUID()
    const orderId = randomUUID()
    const deliveredProductId = randomUUID()
    const pendingProductId = randomUUID()
    const deliveredItemId = randomUUID()
    const pendingItemId = randomUUID()
    const inventoryItemId = randomUUID()
    const paymentId = randomUUID()
    const serviceTaskId = randomUUID()
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id
    ) VALUES($1,$2,$3,$4,$5,$6::date,2,4,'open',$7)`, [
      sessionId, tenantId, storeId, tableId, `customer-left-session-${randomUUID()}`, businessDate, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_snapshot
    ) VALUES
      ($1,$3,$4,$5,'已交付酒水','drink','bar','{}'),
      ($2,$3,$4,$6,'未制作酒水','drink','bar','{}')`, [
      deliveredProductId, pendingProductId, tenantId, storeId,
      `DEL-${randomUUID().slice(0, 8)}`, `PEND-${randomUUID().slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor,created_by_employee_id,submitted_at
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','unpaid',200,0,200,$6,clock_timestamp())`, [
      orderId, tenantId, storeId, sessionId, `customer-left-order-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,total_amount_minor,
      currency,fulfillment_station,product_snapshot,status
    ) VALUES
      ($1,$3,$4,$5,$6,1,100,0,100,'CNY','bar','{}','delivered'),
      ($2,$3,$4,$5,$7,1,100,0,100,'CNY','bar','{}','submitted')`, [
      deliveredItemId, pendingItemId, tenantId, storeId, orderId, deliveredProductId, pendingProductId,
    ])
    await pool.query(`INSERT INTO mbox.kds_tasks(tenant_id,store_id,order_item_id,station_code,status,quantity)
      VALUES($1,$2,$3,'bar', 'pending', 1)`, [tenantId, storeId, pendingItemId])
    await pool.query(`INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit)
      VALUES($1,$2,$3,$4,'Customer-left 库存','bottle','bottle')`, [
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
    await pool.query(`INSERT INTO mbox.payments(
      id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status
    ) VALUES($1,$2,$3,$4,$5,'postar','native_qr',200,'CNY','pending')`, [
      paymentId, tenantId, storeId, orderId, `customer-left-payment-${randomUUID()}`,
    ])
    await pool.query(`INSERT INTO mbox.service_tasks(
      id,tenant_id,store_id,table_id,table_session_id,public_id,task_type,title,status,source,created_by_employee_id
    ) VALUES($1,$2,$3,$4,$5,$6,'call_staff','顾客服务请求','pending','employee',$7)`, [
      serviceTaskId, tenantId, storeId, tableId, sessionId, `customer-left-task-${randomUUID()}`, employeeId,
    ])
    return { sessionId, orderId, paymentId }
  }
})
