import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { InventoryRepository } from './inventory-repository.js'
import { OrderStockReturnRepository } from './order-stock-return-repository.js'
import { RefundFulfillmentRepository } from './refund-fulfillment-repository.js'
import { ScopedPostgresTransactionRunner, type ScopedTransaction } from './transaction-runner.js'

const adminUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = adminUrl ? describe : describe.skip
const paths = ['physical', 'reservation_refund', 'deferred_refund'] as const
type ReturnPath = typeof paths[number]

integration('legacy returns preserve historical weighted inventory cost', () => {
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }
  const employee = randomUUID(), reviewer = randomUUID(), area = randomUUID()
  const table = randomUUID(), session = randomUUID(), product = randomUUID()
  let admin: Pool, runtime: Pool, runner: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(adminUrl!)
    admin = new Pool({ connectionString: adminUrl, max: 4 })
    runtime = new Pool({ connectionString: runtimeUrl ?? adminUrl, max: 4 })
    runner = new ScopedPostgresTransactionRunner(runtime)
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Legacy return cost')", [scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'return-cost','Legacy return cost')", [scope.storeId, scope.tenantId])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$3,$4,'RETURNER','退库员'),($2,$3,$4,'REVIEWER','复核员')", [employee, reviewer, scope.tenantId, scope.storeId])
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')", [area, scope.tenantId, scope.storeId])
    await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'A1','A1',4)", [table, scope.tenantId, scope.storeId, area])
    await admin.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,status,guest_count) VALUES($1,$2,$3,$4,'return-cost-session','2026-10-05','open',2)", [session, scope.tenantId, scope.storeId, table])
    await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'RETURN-BEER','瓶装啤酒','beer','bar')", [product, scope.tenantId, scope.storeId])
  }, 30_000)

  afterAll(async () => { await runtime?.end(); await admin?.end() })

  const run = <T>(operation: (tx: ScopedTransaction) => Promise<T>) => runner.run(scope, async tx => {
    // The normal PostgreSQL runner provides a real restricted LOGIN. Direct
    // targeted runs still execute mutations with the production runtime grants.
    if (!runtimeUrl) await tx.query('SET LOCAL ROLE mbox_runtime')
    return operation(tx)
  })

  async function fixture(path: ReturnPath, input: {
    onHand?: number; currentCost?: number | null; originalCost?: number | null; quantity?: number
  } = {}) {
    const order = randomUUID(), item = randomUUID(), payment = randomUUID(), refund = randomUUID(), inventory = randomUUID()
    const onHand = input.onHand ?? 6, quantity = input.quantity ?? 2
    const currentCost = input.currentCost === undefined ? 500 : input.currentCost
    const originalCost = input.originalCost === undefined ? 300 : input.originalCost
    const amount = quantity * 1000
    await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,submitted_at) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted','submitted','refunded',$5,$5,clock_timestamp())", [order, scope.tenantId, scope.storeId, session, amount])
    await admin.query("INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status) VALUES($1,$2,$3,$4,$5,$6,1000,$7,'bar','{}',$8)", [item, scope.tenantId, scope.storeId, order, product, quantity, amount, path === 'physical' ? 'delivered' : 'submitted'])
    await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status,succeeded_at,provider_transaction_id) VALUES($1::uuid,$2,$3,$4,$1::text,'cash','cash',$5,'CNY','refunded',clock_timestamp(),$1::text)", [payment, scope.tenantId, scope.storeId, order, amount])
    await admin.query("INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,status,purpose,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at) VALUES($1::uuid,$2,$3,$4,$1::text,$1::text,$5,'CNY','succeeded','return_goods','顾客退货',$6,$7,'实际现金退付',clock_timestamp())", [refund, scope.tenantId, scope.storeId, payment, amount, employee, reviewer])
    await admin.query("INSERT INTO mbox.refund_items(tenant_id,store_id,refund_id,order_item_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5,'CNY')", [scope.tenantId, scope.storeId, refund, item, amount])
    await admin.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1::uuid,$2,$3,$1::text,'瓶装啤酒','bottle','bottle')", [inventory, scope.tenantId, scope.storeId])
    const lots = [{ quantity, cost: originalCost }]
    const movements: string[] = []
    for (const lot of lots) {
      const movement = randomUUID()
      await admin.query("INSERT INTO mbox.inventory_movements(id,tenant_id,store_id,inventory_item_id,movement_type,quantity_delta,reference_type,reference_id,order_item_id,unit_cost_minor) VALUES($1,$2,$3,$4,'sale',$5,'order_item',$6,$6,$7)", [movement, scope.tenantId, scope.storeId, inventory, -lot.quantity, item, lot.cost])
      movements.push(movement)
    }
    await admin.query("INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,last_movement_id,weighted_unit_cost_minor,cost_status,cost_basis) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [scope.tenantId, scope.storeId, inventory, onHand, movements.at(-1), currentCost, currentCost === null ? (onHand === 0 ? 'pending' : 'needs_review') : 'complete', currentCost === null ? 'none' : 'moving_weighted_average'])
    if (path !== 'deferred_refund') await admin.query("INSERT INTO mbox.inventory_order_reservations(tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,status,movement_id,consumed_at) VALUES($1,$2,$3,$4,$5,$6,'consumed',$7,clock_timestamp())", [scope.tenantId, scope.storeId, order, item, inventory, quantity, movements[0]])
    return { path, order, item, refund, inventory, quantity }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>
  const restore = (f: Fixture, quantity = f.quantity) => run(async tx => {
    await tx.query("SELECT set_config('application_name',$1,true)", [`return-cost:${f.inventory}`])
    if (f.path === 'physical') return new OrderStockReturnRepository(tx).record({
      orderItemId: f.item, employeeId: employee, quantity, disposition: 'returned_unopened',
      reason: '顾客未开封实际退回', unopenedConfirmed: true,
    })
    return new RefundFulfillmentRepository(tx).synchronize(f.order, f.refund)
  })
  const balance = async (f: Fixture) => (await admin.query(`SELECT on_hand_quantity::text AS quantity,
    weighted_unit_cost_minor::text AS cost,cost_status AS status,cost_basis AS basis
    FROM mbox.inventory_balances WHERE inventory_item_id=$1`, [f.inventory])).rows[0]
  const returned = async (f: Fixture) => (await admin.query(`SELECT quantity_delta::text AS quantity,unit_cost_minor::text AS cost
    FROM mbox.inventory_movements WHERE order_item_id=$1 AND movement_type='return' ORDER BY occurred_at,id`, [f.item])).rows

  for (const path of paths) {
    it.each([
      { name: 'mixes known historical and current costs', onHand: 6, currentCost: 500, originalCost: 300, expected: '450.000000' },
      { name: 'restores a known lot into empty stock', onHand: 0, currentCost: null, originalCost: 300, expected: '300.000000' },
      { name: 'keeps unknown historical cost unknown', onHand: 6, currentCost: 500, originalCost: null, expected: null },
      { name: 'does not erase unknown existing-stock cost', onHand: 6, currentCost: null, originalCost: 300, expected: null },
      { name: 'does not invent cost for an unknown lot into empty stock', onHand: 0, currentCost: null, originalCost: null, expected: null },
      { name: 'preserves a known zero-cost lot', onHand: 6, currentCost: 500, originalCost: 0, expected: '375.000000' },
    ])(`${path}: $name`, async scenario => {
      const f = await fixture(path, scenario)
      await restore(f)
      const expected = {
        quantity: `${scenario.onHand + 2}.000000`, cost: scenario.expected,
        status: scenario.expected === null ? 'needs_review' : 'complete',
        basis: scenario.expected === null ? 'none' : 'moving_weighted_average',
      }
      expect(await balance(f)).toEqual(expected)
      expect(await returned(f)).toEqual([{ quantity: '2.000000', cost: scenario.originalCost === null ? null : `${scenario.originalCost}.000000` }])
      if (path === 'physical') await expect(restore(f)).rejects.toThrow('累计退回数量超过')
      else expect(await restore(f)).toEqual({ cancelledItemIds: [], restoredInventoryRecords: 0 })
      expect(await balance(f)).toEqual(expected)
      expect(await returned(f)).toHaveLength(1)
    })

    it(`${path}: serializes a concurrent receipt before valuing the returned lot`, async () => {
      const f = await fixture(path)
      const receipt = await run(tx => new InventoryRepository(tx).createPurchaseReceipt({
        publicId: randomUUID(), employeeId: employee,
        lines: [{ inventoryItemId: f.inventory, batchCode: 'new-cost-lot', quantity: '2', totalCostMinor: '1400' }],
      }))
      let unblock!: () => void, locked!: () => void
      const gate = new Promise<void>(resolve => { unblock = resolve })
      const acquired = new Promise<void>(resolve => { locked = resolve })
      const incoming = run(async tx => {
        await tx.query('SELECT inventory_item_id FROM mbox.inventory_balances WHERE tenant_id=$1 AND store_id=$2 AND inventory_item_id=$3 FOR UPDATE', [scope.tenantId, scope.storeId, f.inventory])
        locked()
        await gate
        return new InventoryRepository(tx).receivePurchaseReceipt(receipt.id, employee)
      })
      await acquired
      const returning = restore(f)
      try {
        await expect.poll(async () => (await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0) AS blocked`, [`return-cost:${f.inventory}`])).rows[0].blocked).toBe(true)
      } finally { unblock() }
      await Promise.all([incoming, returning])
      // 6×500 + purchased 2×700 + returned 2×300, all divided by 10.
      expect(await balance(f)).toEqual({ quantity: '10.000000', cost: '500.000000', status: 'complete', basis: 'moving_weighted_average' })
      expect(await returned(f)).toEqual([{ quantity: '2.000000', cost: '300.000000' }])
    })
  }

  it('weights successive partial physical returns without applying a prior lot twice', async () => {
    const f = await fixture('physical', { quantity: 4 })
    await restore(f, 2)
    expect(await balance(f)).toMatchObject({ quantity: '8.000000', cost: '450.000000' })
    const result = await Promise.allSettled([restore(f, 2), restore(f, 2)])
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(result.filter(value => value.status === 'rejected')).toHaveLength(1)
    expect(await balance(f)).toMatchObject({ quantity: '10.000000', cost: '420.000000' })
    expect(await returned(f)).toHaveLength(2)
  })

})
