import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { InventoryRepository } from './inventory-repository.js'
import { KdsRepository } from './kds-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('KDS remake inventory timing', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const sessionId = randomUUID()
  const employeeId = randomUUID()
  const inventoryItemId = randomUUID()
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await seedBase()
  })

  afterAll(async () => { await pool?.end() })

  it('releases a pending remake reservation without deducting physical stock', async () => {
    const fixture = await createConsumedFailure('release')
    const remake = await runner.run({ tenantId, storeId }, async (transaction) => {
      const task = await new KdsRepository(transaction).create({
        orderItemId: fixture.orderItemId,
        remakeOfTaskId: fixture.failedTaskId,
        stationCode: 'bar',
        quantity: 1,
        eventIdempotencyKey: `remake-release:${fixture.orderItemId}`,
      })
      const reserved = await new InventoryRepository(transaction).reserveRemakeMaterials({
        orderItemId: fixture.orderItemId,
        originalTaskId: fixture.failedTaskId,
        remakeTaskId: task.id,
      })
      expect(reserved).toHaveLength(1)
      return task
    })
    await expect(balance()).resolves.toEqual({ on_hand: '9.000000', reserved: '1.000000' })

    await runner.run({ tenantId, storeId }, async (transaction) => {
      const released = await new InventoryRepository(transaction).releaseRemakeMaterials(
        remake.id,
        '重制尚未开做，现场取消',
      )
      expect(released).toBe(1)
    })

    expect(await balance()).toEqual({ on_hand: '9.000000', reserved: '0.000000' })
    const reservation = await pool.query<{ status: string; movement_id: string | null }>(`
      SELECT status,movement_id FROM mbox.kds_remake_inventory_reservations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND remake_task_id=$3::uuid
    `, [tenantId, storeId, remake.id])
    expect(reservation.rows).toEqual([{ status: 'released', movement_id: null }])
  })

  it('consumes a second batch exactly once only when the remake starts', async () => {
    const fixture = await createConsumedFailure('start')
    const remake = await runner.run({ tenantId, storeId }, async (transaction) => {
      const task = await new KdsRepository(transaction).create({
        orderItemId: fixture.orderItemId,
        remakeOfTaskId: fixture.failedTaskId,
        stationCode: 'bar',
        quantity: 1,
        eventIdempotencyKey: `remake-start:${fixture.orderItemId}`,
      })
      await new InventoryRepository(transaction).reserveRemakeMaterials({
        orderItemId: fixture.orderItemId,
        originalTaskId: fixture.failedTaskId,
        remakeTaskId: task.id,
      })
      return task
    })
    expect(await balance()).toEqual({ on_hand: '8.000000', reserved: '1.000000' })

    const consumed = await runner.run({ tenantId, storeId }, async (transaction) => (
      new InventoryRepository(transaction).consumeRemakeMaterials(remake.id, {
        createdByEmployeeId: employeeId,
        originalTaskId: fixture.failedTaskId,
        reason: '重新制作实际开始',
      })
    ))
    expect(consumed).toHaveLength(1)
    expect(await balance()).toEqual({ on_hand: '7.000000', reserved: '0.000000' })

    const replay = await runner.run({ tenantId, storeId }, async (transaction) => (
      new InventoryRepository(transaction).consumeRemakeMaterials(remake.id, {
        createdByEmployeeId: employeeId,
      })
    ))
    expect(replay).toEqual([])
    const movements = await pool.query<{ count: string; movement_type: string; reference_type: string }>(`
      SELECT count(*)::text AS count,min(movement_type) AS movement_type,min(reference_type) AS reference_type
      FROM mbox.inventory_movements
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND reference_id=$3::uuid
    `, [tenantId, storeId, remake.id])
    expect(movements.rows[0]).toEqual({ count: '1', movement_type: 'waste', reference_type: 'kds_remake' })
  })

  it('allows only one direct remake for the same failed task under concurrency', async () => {
    const fixture = await createConsumedFailure('concurrent')
    const create = (key: string) => runner.run({ tenantId, storeId }, async (transaction) => (
      new KdsRepository(transaction).create({
        orderItemId: fixture.orderItemId,
        remakeOfTaskId: fixture.failedTaskId,
        stationCode: 'bar',
        quantity: 1,
        eventIdempotencyKey: key,
      })
    ))
    const results = await Promise.allSettled([create('remake-concurrent-a'), create('remake-concurrent-b')])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const count = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM mbox.kds_tasks
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND remake_of_task_id=$3::uuid
    `, [tenantId, storeId, fixture.failedTaskId])
    expect(count.rows[0]?.count).toBe('1')
  })

  async function createConsumedFailure(label: string) {
    const productId = randomUUID()
    const orderId = randomUUID()
    const orderItemId = randomUUID()
    const failedTaskId = randomUUID()
    await pool.query(`
      INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_snapshot)
      VALUES($1,$2,$3,$4,$5,'drink','bar','{}')
    `, [productId, tenantId, storeId, `RM-${label}-${productId.slice(0, 6)}`, `重制库存-${label}`])
    await pool.query(`
      INSERT INTO mbox.orders(
        id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,fulfillment_state,
        subtotal_amount_minor,discount_amount_minor,total_amount_minor
      ) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted','paid','active',100,0,100)
    `, [orderId, tenantId, storeId, sessionId, `order-remake-${label}-${orderId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.order_items(
        id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,
        total_amount_minor,fulfillment_station,product_snapshot,status
      ) VALUES($1,$2,$3,$4,$5,1,100,0,100,'bar','{}','submitted')
    `, [orderItemId, tenantId, storeId, orderId, productId])
    await pool.query(`
      INSERT INTO mbox.inventory_order_reservations(
        tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,status,expires_at
      ) VALUES($1,$2,$3,$4,$5,1,'reserved',clock_timestamp()+interval '10 minutes')
    `, [tenantId, storeId, orderId, orderItemId, inventoryItemId])
    await pool.query(`
      UPDATE mbox.inventory_balances
      SET reserved_quantity=reserved_quantity+1
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid
    `, [tenantId, storeId, inventoryItemId])
    await runner.run({ tenantId, storeId }, async (transaction) => {
      await new InventoryRepository(transaction).consumeOrderItemReservations(orderItemId, {
        createdByEmployeeId: employeeId,
        reason: '原任务开始制作',
      })
    })
    await pool.query(`
      INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,status,quantity)
      VALUES($1,$2,$3,$4,'bar','failed',1)
    `, [failedTaskId, tenantId, storeId, orderItemId])
    return { orderItemId, failedTaskId }
  }

  async function balance() {
    const result = await pool.query<{ on_hand: string; reserved: string }>(`
      SELECT on_hand_quantity::text AS on_hand,reserved_quantity::text AS reserved
      FROM mbox.inventory_balances
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND inventory_item_id=$3::uuid
    `, [tenantId, storeId, inventoryItemId])
    return result.rows[0]!
  }

  async function seedBase() {
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'KDS remake tenant')`, [
      tenantId, `kds-remake-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'KDS remake store')`, [
      storeId, tenantId, `kds-remake-${storeId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type,sort_order)
      VALUES($1,$2,$3,'MAIN','主区','indoor',1)`, [areaId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,'R01','R01',4)`, [tableId, tenantId, storeId, areaId])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES($1,$2,$3,'REMAKE','重制测试员工')`, [employeeId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,guest_profile_snapshot,status,opened_by_employee_id
    ) VALUES($1,$2,$3,$4,$5,((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date),1,4,'{}','open',$6)`, [
      sessionId, tenantId, storeId, tableId, `session-remake-${sessionId.slice(0, 8)}`, employeeId,
    ])
    await pool.query(`INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit)
      VALUES($1,$2,$3,'RM-INGREDIENT','重制测试原料','ingredient','ml')`, [inventoryItemId, tenantId, storeId])
    await pool.query(`INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity)
      VALUES($1,$2,$3,10,0)`, [tenantId, storeId, inventoryItemId])
  }
})
