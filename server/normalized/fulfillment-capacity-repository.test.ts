import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  FulfillmentCapacityRepository,
  FulfillmentCapacityUnavailableError,
} from './fulfillment-capacity-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'

const scope = {
  tenantId: 'a1000000-0000-4000-8000-000000000001',
  storeId: 'a1000000-0000-4000-8000-000000000002',
}
const orderId = 'a1000000-0000-4000-8000-000000000003'

describe('FulfillmentCapacityRepository', () => {
  it('calls only the strong capacity functions with the scoped order identity', async () => {
    const transaction = new CapacityTransaction([{ affected_count: '2' }, { affected_count: 2 }, { affected_count: 1 }])
    const repository = new FulfillmentCapacityRepository(transaction)

    await expect(repository.reserveForImmediatePaymentOrder(orderId)).resolves.toBe(2)
    await expect(repository.activateForPaidOrder(orderId)).resolves.toBe(2)
    await expect(repository.releaseReservedForOrder(orderId, 'provider failed')).resolves.toBe(1)

    expect(transaction.calls).toEqual([
      expect.stringContaining('reserve_order_fulfillment_capacity'),
      expect.stringContaining('activate_order_fulfillment_capacity'),
      expect.stringContaining('release_reserved_order_fulfillment_capacity'),
    ])
    expect(transaction.values[0]).toEqual([scope.tenantId, scope.storeId, orderId])
    expect(transaction.values[2]).toEqual([scope.tenantId, scope.storeId, orderId, 'provider failed'])
  })

  it('maps capacity exhaustion and incomplete published coverage to stable business errors', async () => {
    const exceeded = new FulfillmentCapacityRepository(new CapacityTransaction([], {
      code: '23514', message: 'fulfillment capacity exceeded for station bar',
    }))
    await expect(exceeded.reserveForImmediatePaymentOrder(orderId)).rejects.toMatchObject({
      code: 'FULFILLMENT_CAPACITY_EXCEEDED',
    })

    const incomplete = new FulfillmentCapacityRepository(new CapacityTransaction([], {
      code: '23514', message: 'published capacity policy has no window for station bar',
    }))
    await expect(incomplete.reserveForImmediatePaymentOrder(orderId)).rejects.toMatchObject({
      code: 'FULFILLMENT_CAPACITY_CONFIGURATION_INCOMPLETE',
    })
  })

  it('rejects invalid identities and release reasons before querying', () => {
    const repository = new FulfillmentCapacityRepository(new CapacityTransaction([]))
    expect(() => repository.reserveForImmediatePaymentOrder('not-an-id')).toThrow(TypeError)
    expect(() => repository.releaseReservedForOrder(orderId, '   ')).toThrow(TypeError)
  })
})

class CapacityTransaction implements ScopedTransaction {
  readonly scope = scope
  readonly calls: string[] = []
  readonly values: unknown[][] = []

  constructor(
    private readonly responses: Array<{ affected_count: string | number }>,
    private readonly failure?: { code: string; message: string },
  ) {}

  async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
    this.calls.push(sql.replace(/\s+/g, ' ').trim())
    this.values.push([...values])
    if (this.failure) throw Object.assign(new Error(this.failure.message), { code: this.failure.code })
    const row = this.responses.shift()
    if (!row) throw new Error('Unexpected capacity query')
    return { rows: [row] as Row[], rowCount: 1 }
  }
}

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('Fulfillment capacity PostgreSQL concurrency and lifecycle', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const otherStoreId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const sessionId = randomUUID()
  const policyId = randomUUID()
  const windowId = randomUUID()
  const kitchenPolicyId = randomUUID()
  const kitchenWindowId = randomUUID()
  const barProductId = randomUUID()
  const kitchenProductId = randomUUID()
  const capacityDrafterId = randomUUID()
  const capacityApproverId = randomUUID()
  const capacityPublisherId = randomUUID()
  const barOrderIds = [randomUUID(), randomUUID()]
  const barItemIds = [randomUUID(), randomUUID()]
  const kitchenOrderId = randomUUID()
  const kitchenItemId = randomUUID()

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    transactions = new ScopedPostgresTransactionRunner({
      connect: async () => pool.connect(),
      end: async () => pool.end(),
    })
    await pool.query(`INSERT INTO mbox.tenants(id, code, name) VALUES ($1, $2, 'Capacity tenant')`, [
      tenantId, `capacity-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.stores(id, tenant_id, code, name) VALUES
        ($1, $3, $4, 'Capacity store'), ($2, $3, $5, 'Other capacity store')
    `, [storeId, otherStoreId, tenantId, `capacity-${storeId.slice(0, 8)}`, `capacity-${otherStoreId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
        ($1,$4,$5,'CAPACITY_DRAFTER','Capacity Drafter','active'),
        ($2,$4,$5,'CAPACITY_APPROVER','Capacity Approver','active'),
        ($3,$4,$5,'CAPACITY_PUBLISHER','Capacity Publisher','active')
    `, [capacityDrafterId,capacityApproverId,capacityPublisherId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type) VALUES ($1,$2,$3,'CAP','Capacity','indoor')`, [
      areaId, tenantId, storeId,
    ])
    await pool.query(`INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity) VALUES ($1,$2,$3,$4,'CAP01','CAP01',4)`, [
      tableId, tenantId, storeId, areaId,
    ])
    await pool.query(`INSERT INTO mbox.table_sessions(id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status) VALUES ($1,$2,$3,$4,$5,current_date,2,'open')`, [
      sessionId, tenantId, storeId, tableId, `capacity-session-${sessionId.slice(0, 8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.products(
        id, tenant_id, store_id, code, name, category_code,
        fulfillment_station, capacity_units
      ) VALUES
        ($1,$3,$4,'CAP-BAR','Capacity bar','drink','bar',2),
        ($2,$3,$4,'CAP-KITCHEN','Capacity kitchen','food','kitchen',3)
    `, [barProductId, kitchenProductId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.fulfillment_capacity_policy_versions(
        id, tenant_id, store_id, station_code, policy_version,
        drafted_by_employee_id,publication_mode,reason
      ) VALUES ($1,$2,$3,'bar',1,$4,'separated','测试酒吧出品产能')
    `, [policyId, tenantId, storeId,capacityDrafterId])
    await pool.query(`
      INSERT INTO mbox.fulfillment_capacity_windows(
        id, tenant_id, store_id, policy_version_id,
        starts_at, ends_at, capacity_limit_units
      ) VALUES ($1,$2,$3,$4,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour',2)
    `, [windowId, tenantId, storeId, policyId])
    await pool.query(`
      UPDATE mbox.fulfillment_capacity_policy_versions
      SET status='approved',approved_by_employee_id=$4,approved_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3
    `, [tenantId, storeId, policyId,capacityApproverId])
    await pool.query(`
      UPDATE mbox.fulfillment_capacity_policy_versions
      SET status='published',published_by_employee_id=$4
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3
    `, [tenantId, storeId, policyId,capacityPublisherId])

    for (let index = 0; index < barOrderIds.length; index += 1) {
      await insertImmediateOrder(pool, {
        tenantId, storeId, sessionId,
        orderId: barOrderIds[index]!, itemId: barItemIds[index]!, productId: barProductId,
        station: 'bar', suffix: `bar-${index}`,
      })
    }
    await insertImmediateOrder(pool, {
      tenantId, storeId, sessionId,
      orderId: kitchenOrderId, itemId: kitchenItemId, productId: kitchenProductId,
      station: 'kitchen', suffix: 'kitchen',
    })
  })

  afterAll(async () => pool?.end())

  it('leaves an ordinary immediate-payment order unchanged when its station has no published policy', async () => {
    const count = await transactions.run({ tenantId, storeId }, (transaction) => (
      new FulfillmentCapacityRepository(transaction).reserveForImmediatePaymentOrder(kitchenOrderId)
    ))
    expect(count).toBe(0)
    const stored = await pool.query(`SELECT count(*)::integer AS count FROM mbox.fulfillment_capacity_reservations WHERE order_id=$1`, [kitchenOrderId])
    expect(stored.rows[0]?.count).toBe(0)
  })

  it('fails closed when a station policy is published without a window covering the final due time', async () => {
    await pool.query(`
      INSERT INTO mbox.fulfillment_capacity_policy_versions(
        id, tenant_id, store_id, station_code, policy_version,
        drafted_by_employee_id,publication_mode,reason
      ) VALUES ($1,$2,$3,'kitchen',1,$4,'separated','测试厨房出品产能')
    `, [kitchenPolicyId, tenantId, storeId,capacityDrafterId])
    await pool.query(`
      INSERT INTO mbox.fulfillment_capacity_windows(
        id, tenant_id, store_id, policy_version_id,
        starts_at, ends_at, capacity_limit_units
      ) VALUES ($1,$2,$3,$4,clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days',20)
    `, [kitchenWindowId, tenantId, storeId, kitchenPolicyId])
    await pool.query(`
      UPDATE mbox.fulfillment_capacity_policy_versions
      SET status='approved',approved_by_employee_id=$4,approved_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3
    `, [tenantId, storeId, kitchenPolicyId,capacityApproverId])
    await pool.query(`
      UPDATE mbox.fulfillment_capacity_policy_versions
      SET status='published',published_by_employee_id=$4
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3
    `, [tenantId, storeId, kitchenPolicyId,capacityPublisherId])

    await expect(transactions.run({ tenantId, storeId }, (transaction) => (
      new FulfillmentCapacityRepository(transaction).reserveForImmediatePaymentOrder(kitchenOrderId)
    ))).rejects.toMatchObject({
      code: 'FULFILLMENT_CAPACITY_CONFIGURATION_INCOMPLETE',
    })
  })

  it('serializes one window, prevents overbooking, and supports idempotent release, reacquire, activation and KDS release', async () => {
    const attempts = await Promise.allSettled(barOrderIds.map((currentOrderId) => (
      transactions.run({ tenantId, storeId }, (transaction) => (
        new FulfillmentCapacityRepository(transaction).reserveForImmediatePaymentOrder(currentOrderId)
      ))
    )))
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = attempts.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected?.reason).toBeInstanceOf(FulfillmentCapacityUnavailableError)
    expect(rejected?.reason).toMatchObject({ code: 'FULFILLMENT_CAPACITY_EXCEEDED' })

    const current = await pool.query<{ order_id: string }>(`
      SELECT order_id FROM mbox.fulfillment_capacity_reservations
      WHERE tenant_id=$1 AND store_id=$2 AND status='reserved'
    `, [tenantId, storeId])
    const winningOrderId = current.rows[0]!.order_id
    const losingOrderId = barOrderIds.find((value) => value !== winningOrderId)!
    const losingItemId = barItemIds[barOrderIds.indexOf(losingOrderId)]!

    await expect(transactions.run({ tenantId, storeId }, (transaction) => (
      new FulfillmentCapacityRepository(transaction).releaseReservedForOrder(winningOrderId, 'payment failed')
    ))).resolves.toBe(1)
    await expect(transactions.run({ tenantId, storeId }, (transaction) => (
      new FulfillmentCapacityRepository(transaction).releaseReservedForOrder(winningOrderId, 'payment failed replay')
    ))).resolves.toBe(0)
    await expect(transactions.run({ tenantId, storeId }, (transaction) => (
      new FulfillmentCapacityRepository(transaction).reserveForImmediatePaymentOrder(losingOrderId)
    ))).resolves.toBe(1)

    await pool.query(`
      UPDATE mbox.orders
      SET payment_status='paid', fulfillment_state='active',
        fulfillment_expires_at=NULL, fulfillment_activated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3
    `, [tenantId, storeId, losingOrderId])
    await expect(transactions.run({ tenantId, storeId }, (transaction) => (
      new FulfillmentCapacityRepository(transaction).activateForPaidOrder(losingOrderId)
    ))).resolves.toBe(1)
    await expect(transactions.run({ tenantId, storeId }, (transaction) => (
      new FulfillmentCapacityRepository(transaction).activateForPaidOrder(losingOrderId)
    ))).resolves.toBe(0)

    const task = await pool.query<{ id: string }>(`
      INSERT INTO mbox.kds_tasks(
        tenant_id, store_id, order_item_id, station_code, status, quantity
      ) VALUES ($1,$2,$3,'bar','pending',1)
      RETURNING id
    `, [tenantId, storeId, losingItemId])
    await pool.query(`UPDATE mbox.kds_tasks SET status='ready' WHERE id=$1`, [task.rows[0]!.id])
    await pool.query(`UPDATE mbox.kds_tasks SET status='ready' WHERE id=$1`, [task.rows[0]!.id])
    const lifecycle = await pool.query(`
      SELECT status, release_reason,
        (SELECT COALESCE(sum(capacity_units),0)::integer
         FROM mbox.fulfillment_capacity_reservations
         WHERE capacity_window_id=$2 AND status IN ('reserved','active')) AS used_units
      FROM mbox.fulfillment_capacity_reservations
      WHERE order_id=$1
    `, [losingOrderId, windowId])
    expect(lifecycle.rows[0]).toMatchObject({ status: 'released', release_reason: 'kds:ready', used_units: 0 })
  })

  it('rejects a forged reservation unit count even through direct SQL', async () => {
    const released = await pool.query<{ id: string; expires_at: string }>(`
      SELECT reservation.id, order_row.fulfillment_expires_at::text AS expires_at
      FROM mbox.fulfillment_capacity_reservations reservation
      JOIN mbox.orders order_row ON order_row.id=reservation.order_id
      WHERE reservation.tenant_id=$1 AND reservation.store_id=$2
        AND reservation.status='released'
        AND order_row.fulfillment_state='awaiting_payment'
      LIMIT 1
    `, [tenantId, storeId])
    const row = released.rows[0]
    expect(row).toBeDefined()
    await expect(pool.query(`
      UPDATE mbox.fulfillment_capacity_reservations
      SET status='reserved', capacity_units=1, expires_at=$2::timestamptz,
        activated_at=NULL, released_at=NULL, release_reason=NULL
      WHERE id=$1
    `, [row!.id, row!.expires_at])).rejects.toMatchObject({ code: '23514' })
  })

  it('enforces store RLS on policy, window and reservation facts', async () => {
    const hidden = await transactions.run({ tenantId, storeId: otherStoreId }, async (transaction) => {
      await transaction.query('SET LOCAL ROLE mbox_runtime')
      const result = await transaction.query(`
        SELECT
          (SELECT count(*)::integer FROM mbox.fulfillment_capacity_policy_versions) AS policies,
          (SELECT count(*)::integer FROM mbox.fulfillment_capacity_windows) AS windows,
          (SELECT count(*)::integer FROM mbox.fulfillment_capacity_reservations) AS reservations
      `)
      return result.rows[0]
    }, { readOnly: true })
    expect(hidden).toEqual({ policies: 0, windows: 0, reservations: 0 })
  })
})

async function insertImmediateOrder(pool: Pool, input: {
  tenantId: string
  storeId: string
  sessionId: string
  orderId: string
  itemId: string
  productId: string
  station: 'bar' | 'kitchen'
  suffix: string
}) {
  await pool.query(`
    INSERT INTO mbox.orders(
      id, tenant_id, store_id, table_session_id, public_id, channel,
      settlement_mode, status, subtotal_amount_minor, total_amount_minor
    ) VALUES ($1,$2,$3,$4,$5,'integration','immediate_payment','submitted',100,100)
  `, [input.orderId, input.tenantId, input.storeId, input.sessionId, `capacity-order-${input.suffix}`])
  await pool.query(`
    INSERT INTO mbox.order_items(
      id, tenant_id, store_id, order_id, product_id, quantity,
      unit_price_minor, total_amount_minor, fulfillment_station,
      fulfillment_due_at, product_snapshot
    ) VALUES ($1,$2,$3,$4,$5,1,100,100,$6,clock_timestamp()+interval '5 minutes','{}'::jsonb)
  `, [input.itemId, input.tenantId, input.storeId, input.orderId, input.productId, input.station])
}
