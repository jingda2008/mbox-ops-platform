import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  GuestSharedCartRepository,
  GuestSharedCartFrozenError,
  GuestSharedCartLimitError,
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
  const inventoryItemId = '10600000-0000-4000-8000-000000000007'
  const recipeId = '10600000-0000-4000-8000-000000000008'
  const secondProductId = '10600000-0000-4000-8000-000000000013'
  const secondRecipeId = '10600000-0000-4000-8000-000000000014'
  const employeeId = '10600000-0000-4000-8000-000000000009'
  const submittedOrderId = '10600000-0000-4000-8000-000000000010'
  const secondSubmittedOrderId = '10600000-0000-4000-8000-000000000011'
  const checkoutOrderId = '10600000-0000-4000-8000-000000000012'
  const scope = { tenantId, storeId }
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES ($1,'shared-cart','Shared Cart')`, [tenantId])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES ($1,$2,'shared-cart','Shared Cart')`, [storeId, tenantId])
    await pool.query(`
      INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
      VALUES ($1,$2,$3,'CART_CHECK','购物车核对员')
    `, [employeeId, tenantId, storeId])
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
    await pool.query(`
      INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit)
      VALUES ($1,$2,$3,'SC-BASE','共享购物车测试基酒','ingredient','ml')
    `, [inventoryItemId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity)
      VALUES ($1,$2,$3,100,0)
    `, [tenantId, storeId, inventoryItemId])
    await pool.query(`
      INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,yield_quantity,status,effective_at)
      VALUES ($1,$2,$3,$4,1,1,'active',clock_timestamp()-interval '1 minute')
    `, [recipeId, tenantId, storeId, productId])
    await pool.query(`
      INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity)
      VALUES ($1,$2,$3,$4,10)
    `, [tenantId, storeId, recipeId, inventoryItemId])
    await pool.query(`
      INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station)
      VALUES ($1,$2,$3,'SC-DRINK-2','共享原料测试饮品','drink','bar')
    `,[secondProductId,tenantId,storeId])
    await pool.query(`
      INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from)
      VALUES ($1,$2,$3,'standard',3000,'CNY',clock_timestamp()-interval '1 minute')
    `,[tenantId,storeId,secondProductId])
    await pool.query(`
      INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,yield_quantity,status,effective_at)
      VALUES ($1,$2,$3,$4,1,1,'active',clock_timestamp()-interval '1 minute')
    `,[secondRecipeId,tenantId,storeId,secondProductId])
    await pool.query(`
      INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity)
      VALUES ($1,$2,$3,$4,10)
    `,[tenantId,storeId,secondRecipeId,inventoryItemId])
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
        productId, delta: 2, expectedGeneration: 1, expectedVersion: 0, operationId: 'shared-cart-adjust-0001',
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
        productId, delta: 2, expectedGeneration: 1, expectedVersion: 0, operationId: 'shared-cart-adjust-0001',
        actorSessionRef: 'guest-session:shared-cart-test',
      })
    ))
    expect(replay).toMatchObject({ version: 1, lines: [{ productId, quantity: 2 }] })

    await expect(transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).adjust(tableSessionId, 'GSC10600000000040008000000000000001', {
        productId, delta: 1, expectedGeneration: 1, expectedVersion: 0, operationId: 'shared-cart-adjust-0002',
        actorSessionRef: 'guest-session:shared-cart-test',
      })
    ))).rejects.toBeInstanceOf(GuestSharedCartVersionConflictError)
  })

  it('clears the whole current cart atomically and rejects a stale clear', async () => {
    const cleared = await transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).clear(tableSessionId, 'GSC10600000000040008000000000000001', {
        expectedGeneration: 1, expectedVersion: 1, operationId: 'shared-cart-clear-0001',
        actorSessionRef: 'guest-session:shared-cart-test',
      })
    ))
    expect(cleared).toMatchObject({ generation: 1, version: 2, lines: [], totalAmountMinor: 0 })

    const replay = await transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).clear(tableSessionId, 'GSC10600000000040008000000000000001', {
        expectedGeneration: 1, expectedVersion: 1, operationId: 'shared-cart-clear-0001',
        actorSessionRef: 'guest-session:shared-cart-test',
      })
    ))
    expect(replay).toMatchObject({ generation: 1, version: 2, lines: [] })

    await expect(transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).clear(tableSessionId, 'GSC10600000000040008000000000000001', {
        expectedGeneration: 1, expectedVersion: 1, operationId: 'shared-cart-clear-0002',
        actorSessionRef: 'guest-session:shared-cart-test',
      })
    ))).rejects.toBeInstanceOf(GuestSharedCartVersionConflictError)
  })

  it('revalidates recipe and total line inventory instead of trusting an earlier cart snapshot', async () => {
    await pool.query(`UPDATE mbox.inventory_balances SET on_hand_quantity=15 WHERE inventory_item_id=$1::uuid`, [inventoryItemId])
    const insufficient = await transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).readOpen(tableSessionId, 'GSC10600000000040008000000000000001')
    ))
    expect(insufficient.lines).toEqual([])

    await pool.query(`
      INSERT INTO mbox.guest_shared_cart_lines(tenant_id,store_id,cart_id,product_id,quantity)
      SELECT $1,$2,cart.id,$3,2 FROM mbox.guest_shared_carts cart
      WHERE cart.table_session_id=$4 AND cart.status='open'
      ON CONFLICT (tenant_id,store_id,cart_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity
    `, [tenantId, storeId, productId, tableSessionId])
    const unavailable = await transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).readOpen(tableSessionId, 'GSC10600000000040008000000000000001')
    ))
    expect(unavailable.lines[0]).toMatchObject({ available: false, unavailableReason: '本桌购物车合计库存不足' })
    expect(unavailable.totalAmountMinor).toBeNull()

    await pool.query(`UPDATE mbox.inventory_balances SET on_hand_quantity=100 WHERE inventory_item_id=$1::uuid`, [inventoryItemId])
    await pool.query(`UPDATE mbox.recipes SET status='draft' WHERE id=$1::uuid`, [recipeId])
    const recipeChanged = await transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).readOpen(tableSessionId, 'GSC10600000000040008000000000000001')
    ))
    expect(recipeChanged.lines[0]).toMatchObject({ available: false, unavailableReason: '商品配方正在更新' })
    await pool.query(`UPDATE mbox.recipes SET status='active' WHERE id=$1::uuid`, [recipeId])
  })

  it('aggregates shared ingredient demand across different cart products',async () => {
    await pool.query(`UPDATE mbox.inventory_balances SET on_hand_quantity=15 WHERE inventory_item_id=$1::uuid`,[inventoryItemId])
    await pool.query(`
      UPDATE mbox.guest_shared_cart_lines SET quantity=1
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND product_id=$3::uuid
    `,[tenantId,storeId,productId])
    await pool.query(`
      INSERT INTO mbox.guest_shared_cart_lines(tenant_id,store_id,cart_id,product_id,quantity)
      SELECT $1,$2,cart.id,$3,1 FROM mbox.guest_shared_carts cart
      WHERE cart.table_session_id=$4::uuid AND cart.status='open'
    `,[tenantId,storeId,secondProductId,tableSessionId])
    const snapshot=await transactions.run(scope,(transaction) => (
      new GuestSharedCartRepository(transaction).readOpen(
        tableSessionId,'GSC10600000000040008000000000000001',
      )
    ))
    expect(snapshot.lines).toHaveLength(2)
    expect(snapshot.lines.every((line)=>!line.available&&line.unavailableReason==='本桌购物车合计库存不足')).toBe(true)
    expect(snapshot.totalAmountMinor).toBeNull()
    await pool.query(`UPDATE mbox.inventory_balances SET on_hand_quantity=100 WHERE inventory_item_id=$1::uuid`,[inventoryItemId])
    await pool.query(`DELETE FROM mbox.guest_shared_cart_lines WHERE product_id=$1::uuid`,[secondProductId])
  })

  it('keeps the shared cart readable while an employee freeze blocks guest mutations', async () => {
    await pool.query(`
      UPDATE mbox.table_sessions
      SET guest_cart_writes_frozen=true,guest_cart_frozen_by_employee_id=$2::uuid,
        guest_cart_freeze_reason='服务人员核对本桌点单',guest_cart_frozen_at=clock_timestamp()
      WHERE id=$1::uuid
    `, [tableSessionId, employeeId])
    const readable = await transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).readOpen(tableSessionId, 'GSC10600000000040008000000000000001')
    ))
    expect(readable.guestWritesFrozen).toBe(true)
    await expect(transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).adjust(tableSessionId, 'GSC10600000000040008000000000000001', {
        productId, delta: 1, expectedGeneration: readable.generation, expectedVersion: readable.version,
        operationId: 'shared-cart-frozen-0001', actorSessionRef: 'guest-session:shared-cart-test',
      })
    ))).rejects.toBeInstanceOf(GuestSharedCartFrozenError)
    await pool.query(`
      UPDATE mbox.table_sessions
      SET guest_cart_writes_frozen=false,guest_cart_frozen_by_employee_id=NULL,
        guest_cart_freeze_reason=NULL,guest_cart_frozen_at=NULL
      WHERE id=$1::uuid
    `, [tableSessionId])
  })

  it('moves a late add into the next generation but rejects a stale reduction', async () => {
    await pool.query(`
      INSERT INTO mbox.orders(
        id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
        subtotal_amount_minor,total_amount_minor
      ) VALUES($1,$2,$3,$4,'shared-cart-submitted-order','guest_qr','submitted','unpaid',5600,5600)
    `, [submittedOrderId,tenantId,storeId,tableSessionId])
    await pool.query(`
      UPDATE mbox.guest_shared_carts
      SET status='submitted',submitted_order_id=$4::uuid,submitted_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND table_session_id=$3::uuid AND status='open'
    `, [tenantId, storeId, tableSessionId, submittedOrderId])
    const current = await transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).readOpen(tableSessionId, 'GSC10600000000040008000000000000002')
    ))
    expect(current).toMatchObject({ generation: 2, version: 0, status: 'open' })

    const lateAdd = await transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).adjust(tableSessionId, 'GSC10600000000040008000000000000002', {
        productId, delta: 1, expectedGeneration: 1, expectedVersion: 0,
        operationId: 'shared-cart-stale-generation-0001', actorSessionRef: 'guest-session:shared-cart-test',
      })
    ))
    expect(lateAdd).toMatchObject({ generation: 2,version: 1,lines: [{ productId,quantity: 1 }] })

    await expect(transactions.run(scope, (transaction) => (
      new GuestSharedCartRepository(transaction).adjust(tableSessionId, 'GSC10600000000040008000000000000002', {
        productId,delta: -1,expectedGeneration: 1,expectedVersion: 0,
        operationId: 'shared-cart-stale-generation-reduce-0001',actorSessionRef: 'guest-session:shared-cart-test',
      })
    ))).rejects.toBeInstanceOf(GuestSharedCartVersionConflictError)
  })

  it('deduplicates a successful operation across later generations and atomically opens the checkout successor',async () => {
    await pool.query(`
      INSERT INTO mbox.orders(
        id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
        subtotal_amount_minor,total_amount_minor
      ) VALUES($1,$2,$3,$4,'shared-cart-second-order','guest_qr','submitted','unpaid',2800,2800)
    `,[secondSubmittedOrderId,tenantId,storeId,tableSessionId])
    await pool.query(`
      UPDATE mbox.guest_shared_carts
      SET status='submitted',submitted_order_id=$4::uuid,submitted_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND table_session_id=$3::uuid AND status='open'
    `,[tenantId,storeId,tableSessionId,secondSubmittedOrderId])
    const generation3=await transactions.run(scope,(transaction) => (
      new GuestSharedCartRepository(transaction).readOpen(
        tableSessionId,'GSC10600000000040008000000000000003',
      )
    ))
    expect(generation3).toMatchObject({ generation:3,version:0,lines:[] })
    const replay=await transactions.run(scope,(transaction) => (
      new GuestSharedCartRepository(transaction).adjust(
        tableSessionId,'GSC10600000000040008000000000000003',{
          productId,delta:1,expectedGeneration:1,expectedVersion:0,
          operationId:'shared-cart-stale-generation-0001',actorSessionRef:'guest-session:shared-cart-test',
        },
      )
    ))
    expect(replay).toMatchObject({ generation:3,version:0,lines:[] })
    const operationCount=await pool.query<{ count:string }>(`
      SELECT count(*)::text FROM mbox.guest_shared_cart_operations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND table_session_id=$3::uuid
        AND operation_id='shared-cart-stale-generation-0001'
    `,[tenantId,storeId,tableSessionId])
    expect(operationCount.rows[0]?.count).toBe('1')

    const changed=await transactions.run(scope,(transaction) => (
      new GuestSharedCartRepository(transaction).adjust(
        tableSessionId,'GSC10600000000040008000000000000003',{
          productId,delta:1,expectedGeneration:3,expectedVersion:0,
          operationId:'shared-cart-generation3-add-0001',actorSessionRef:'guest-session:shared-cart-test',
        },
      )
    ))
    const submitting=await transactions.run(scope,(transaction) => (
      new GuestSharedCartRepository(transaction).beginCheckout(
        tableSessionId,'GSC10600000000040008000000000000003',{
          expectedGeneration:3,expectedVersion:changed.version,
          operationId:'shared-cart-generation3-checkout-0001',actorSessionRef:'guest-session:shared-cart-test',
        },
      )
    ))
    await pool.query(`
      INSERT INTO mbox.orders(
        id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
        subtotal_amount_minor,total_amount_minor
      ) VALUES($1,$2,$3,$4,'shared-cart-checkout-order','guest_qr','submitted','unpaid',2800,2800)
    `,[checkoutOrderId,tenantId,storeId,tableSessionId])
    const transition=await transactions.run(scope,(transaction) => (
      new GuestSharedCartRepository(transaction).completeCheckout(submitting,{
        orderId:checkoutOrderId,expectedVersion:changed.version,
        operationId:'shared-cart-generation3-checkout-0001',actorSessionRef:'guest-session:shared-cart-test',
        nextCartPublicId:'GSC10600000000040008000000000000004',
      })
    ))
    expect(transition.submittedCart).toMatchObject({ generation:3,status:'submitted' })
    expect(transition.nextCart).toMatchObject({ generation:4,version:0,status:'open',lines:[] })
  })

  it('cannot hide an over-limit priced basket behind an unpriced line before remove or checkout',async () => {
    await pool.query(`UPDATE mbox.inventory_balances SET on_hand_quantity=1000 WHERE inventory_item_id=$1::uuid`,[inventoryItemId])
    await pool.query(`UPDATE mbox.product_prices SET amount_minor=150000 WHERE product_id=$1::uuid`,[productId])
    await pool.query(`UPDATE mbox.product_prices SET valid_until=clock_timestamp()-interval '1 second' WHERE product_id=$1::uuid`,[secondProductId])
    await pool.query(`
      INSERT INTO mbox.guest_shared_cart_lines(tenant_id,store_id,cart_id,product_id,quantity)
      SELECT $1,$2,cart.id,$3,14 FROM mbox.guest_shared_carts cart
      WHERE cart.table_session_id=$4::uuid AND cart.status='open'
    `,[tenantId,storeId,productId,tableSessionId])
    await pool.query(`
      INSERT INTO mbox.guest_shared_cart_lines(tenant_id,store_id,cart_id,product_id,quantity)
      SELECT $1,$2,cart.id,$3,1 FROM mbox.guest_shared_carts cart
      WHERE cart.table_session_id=$4::uuid AND cart.status='open'
    `,[tenantId,storeId,secondProductId,tableSessionId])

    await expect(transactions.run(scope,(transaction) => (
      new GuestSharedCartRepository(transaction).removeLine(
        tableSessionId,'GSC10600000000040008000000000000004',{
          productId:secondProductId,expectedGeneration:4,expectedVersion:0,
          operationId:'shared-cart-over-limit-remove-0001',actorSessionRef:'guest-session:shared-cart-test',
        },
      )
    ))).rejects.toBeInstanceOf(GuestSharedCartLimitError)

    await expect(transactions.run(scope,(transaction) => (
      new GuestSharedCartRepository(transaction).beginCheckout(
        tableSessionId,'GSC10600000000040008000000000000004',{
          expectedGeneration:4,expectedVersion:0,
          operationId:'shared-cart-over-limit-checkout-0001',actorSessionRef:'guest-session:shared-cart-test',
        },
      )
    ))).rejects.toBeInstanceOf(GuestSharedCartLimitError)

    const persisted=await transactions.run(scope,(transaction) => (
      new GuestSharedCartRepository(transaction).readOpen(
        tableSessionId,'GSC10600000000040008000000000000004',
      )
    ))
    expect(persisted.lines).toHaveLength(2)
    await pool.query(`DELETE FROM mbox.guest_shared_cart_lines WHERE cart_id=$1::uuid`,[persisted.id])
    await pool.query(`UPDATE mbox.product_prices SET amount_minor=2800 WHERE product_id=$1::uuid`,[productId])
  })

  it('rate-limits committed write attempts even when no cart operation succeeds',async()=>{
    const outcomes:boolean[]=[]
    for(let index=1;index<=13;index+=1){
      outcomes.push(await transactions.run(scope,transaction=>(
        new GuestSharedCartRepository(transaction).recordWriteAttempt({
          tableSessionId,actorSessionRef:'guest-session:failed-attempt-test',
          operationId:`shared-cart-failed-attempt-${String(index).padStart(4,'0')}`,
          action:'adjust',
        })
      )))
    }
    expect(outcomes.slice(0,12).every(Boolean)).toBe(true)
    expect(outcomes[12]).toBe(false)
    const evidence=await pool.query<{ attempts:string;operations:string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.guest_shared_cart_write_attempts
          WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3) AS attempts,
        (SELECT count(*)::text FROM mbox.guest_shared_cart_operations
          WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3
            AND actor_session_ref=$4) AS operations
    `,[tenantId,storeId,tableSessionId,'sha256:'+createHash('sha256').update('guest-session:failed-attempt-test').digest('hex')])
    expect(evidence.rows[0]).toEqual({attempts:'13',operations:'0'})
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
