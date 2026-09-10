import { expireRecollectionAuthorizations } from './recollection-expiry.js'
import { synchronizeRefundedCancelledItem } from './refunded-fulfillment-repair.js'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { KdsRepository } from './kds-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('closed-session KDS terminalization', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const sessionId = randomUUID()
  const employeeId = randomUUID()
  const roleId = randomUUID()
  const productId = randomUUID()
  const orderId = randomUUID()
  const orderItemId = randomUUID()
  const taskId = randomUUID()
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Closed KDS Tenant')`, [
      tenantId, `closed-kds-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Closed KDS Store')`, [
      storeId, tenantId, `closed-kds-${storeId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type,sort_order)
      VALUES($1,$2,$3,'MAIN','主区','indoor',1)`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,'K01','K01',4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,'manager','值班经理')`, [employeeId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name)
      VALUES($1,$2,$3,'MANAGER','值班经理')`, [roleId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id)
      VALUES($1,$2,$3,$4)`, [tenantId, storeId, employeeId, roleId])
    await pool.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name)
      VALUES($1,$2,'kds.exception.manage','处理出品异常')
      ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET status='active'`, [tenantId, storeId])
    await pool.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
      SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions
      WHERE tenant_id=$1 AND store_id=$2 AND code='kds.exception.manage'`, [tenantId, storeId, roleId])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,
      guest_profile_snapshot,status,opened_by_employee_id
    ) VALUES($1,$2,$3,$4,$5,current_date-1,2,4,'{}','open',$6)`, [
      sessionId, tenantId, storeId, tableId, `session-${randomUUID()}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_snapshot
    ) VALUES($1,$2,$3,$4,'历史测试品项','food','kitchen','{}')`, [
      productId, tenantId, storeId, `P-${randomUUID().slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.orders(
      id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
      subtotal_amount_minor,discount_amount_minor,total_amount_minor
    ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','unpaid',100,0,100)`, [
      orderId, tenantId, storeId, sessionId, `order-${randomUUID()}`,
    ])
    await pool.query(`INSERT INTO mbox.order_items(
      id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,
      total_amount_minor,fulfillment_station,product_snapshot,status
    ) VALUES($1,$2,$3,$4,$5,1,100,0,100,'kitchen','{}','submitted')`, [
      orderItemId, tenantId, storeId, orderId, productId,
    ])
    await pool.query(`INSERT INTO mbox.kds_tasks(
      id,tenant_id,store_id,order_item_id,station_code,status,quantity
    ) VALUES($1,$2,$3,$4,'kitchen','pending',1)`, [taskId, tenantId, storeId, orderItemId])
    await pool.query(`UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp()
      WHERE id=$1`, [sessionId])
  })

  afterAll(async () => { await pool?.end() })

  it('rejects ordinary closed-table writes but permits the exact manager-bound cancellation', async () => {
    await expect(transactions.run({ tenantId, storeId }, async (transaction) => (
      new KdsRepository(transaction).cancel({
        taskId, actorEmployeeId: employeeId, eventIdempotencyKey: `ordinary-${taskId}`,
      })
    ))).rejects.toMatchObject({ code: '55000' })

    await expect(transactions.run({ tenantId, storeId }, async (transaction) => {
      await transaction.query(`SELECT set_config('app.kds_manager_cancel_task_id',$1,true)`, [randomUUID()])
      return new KdsRepository(transaction).cancel({
        taskId, actorEmployeeId: employeeId, eventIdempotencyKey: `wrong-task-${taskId}`,
      })
    })).rejects.toMatchObject({ code: '55000' })

    const cancelled = await transactions.run({ tenantId, storeId }, async (transaction) => {
      await transaction.query(`SELECT set_config('app.kds_manager_cancel_task_id',$1,true)`, [taskId])
      return new KdsRepository(transaction).cancel({
        taskId, actorEmployeeId: employeeId, eventIdempotencyKey: `manager-${taskId}`,
        metadata: { source: 'manager_exception_api', reasonNote: '历史遗留不再出品' },
      })
    })
    expect(cancelled.status).toBe('cancelled')

    const evidence = await pool.query(`SELECT event_type,from_status,to_status,actor_employee_id
      FROM mbox.kds_task_events WHERE kds_task_id=$1 ORDER BY occurred_at,id`, [taskId])
    expect(evidence.rows.at(-1)).toMatchObject({
      event_type: 'task.cancelled', from_status: 'pending', to_status: 'cancelled',
      actor_employee_id: employeeId,
    })
  })
  it('keeps unpaid history unchanged, then terminalizes refunded cancelled items idempotently', async () => {
    expect(await transactions.run({ tenantId, storeId }, tx => synchronizeRefundedCancelledItem(tx, orderItemId))).toEqual([])
    await pool.query(`UPDATE mbox.orders SET payment_status='paid' WHERE id=$1`, [orderId])
    await pool.query(`UPDATE mbox.orders SET payment_status='refunded' WHERE id=$1`, [orderId])
    await expect(pool.query(`UPDATE mbox.order_items SET status='cancelled',total_amount_minor=99 WHERE id=$1`, [orderItemId]))
      .rejects.toBeDefined()
    expect(await transactions.run({ tenantId, storeId }, tx => synchronizeRefundedCancelledItem(tx, orderItemId))).toEqual([orderItemId])
    expect(await transactions.run({ tenantId, storeId }, tx => synchronizeRefundedCancelledItem(tx, orderItemId))).toEqual([])
    expect((await pool.query(`SELECT status,total_amount_minor FROM mbox.order_items WHERE id=$1`, [orderItemId])).rows[0])
      .toMatchObject({status:'cancelled',total_amount_minor:'100'})
    expect((await pool.query(`SELECT fulfillment_state FROM mbox.orders WHERE id=$1`, [orderId])).rows[0].fulfillment_state).toBe('cancelled')
    expect((await pool.query(`SELECT count(*) FROM mbox.audit_events WHERE object_id=$1 AND action='order_item.refunded_cancellation_synchronized'`, [orderItemId])).rows[0].count).toBe('1')
  })

  it('expires only due authorizations and writes one audit across concurrent runs', async () => {
    const expiredId = randomUUID()
    const futureId = randomUUID()
    // The one-active-per-order invariant also applies to expired-but-active rows.
    await pool.query(`INSERT INTO mbox.order_recollection_authorizations(
      id,tenant_id,store_id,public_id,order_id,amount_minor,currency,status,reason,authorized_by_employee_id,expires_at
    ) VALUES($1::uuid,$2,$3,$1::uuid::text,$4,100,'CNY','active','test expired authorization',$5,clock_timestamp()-interval '1 day')`,
      [expiredId,tenantId,storeId,orderId,employeeId])
    await Promise.all([1,2].map(() => transactions.run({tenantId,storeId}, tx => expireRecollectionAuthorizations(tx))))
    expect((await pool.query(`SELECT status FROM mbox.order_recollection_authorizations WHERE id=$1`,[expiredId])).rows[0].status).toBe('expired')
    expect((await pool.query(`SELECT count(*) FROM mbox.audit_events WHERE object_id=$1 AND action='payment.recollection_expired'`,[expiredId])).rows[0].count).toBe('1')
    await pool.query(`INSERT INTO mbox.order_recollection_authorizations(
      id,tenant_id,store_id,public_id,order_id,amount_minor,currency,status,reason,authorized_by_employee_id,expires_at
    ) VALUES($1::uuid,$2,$3,$1::uuid::text,$4,100,'CNY','active','test future authorization',$5,clock_timestamp()+interval '1 hour')`,
      [futureId,tenantId,storeId,orderId,employeeId])
    await transactions.run({tenantId,storeId}, tx => expireRecollectionAuthorizations(tx))
    expect((await pool.query(`SELECT status FROM mbox.order_recollection_authorizations WHERE id=$1`,[futureId])).rows[0].status).toBe('active')
  })

})
