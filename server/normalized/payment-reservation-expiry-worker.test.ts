import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { PaymentReservationExpiryWorker } from './payment-reservation-expiry-worker.js'
import type { PostgresPoolClient, PostgresQueryResult } from './transaction-runner.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
}
const orderId = '33333333-3333-4333-8333-333333333333'
const orderItemId = '44444444-4444-4444-8444-444444444444'
const inventoryItemId = '55555555-5555-4555-8555-555555555555'
const reservationId = '66666666-6666-4666-8666-666666666666'

class ExpiryClient implements PostgresPoolClient {
  readonly calls: string[] = []

  constructor(private readonly paymentState: 'none' | 'unknown') {}

  async query<Row extends Record<string, unknown>>(sql: string): Promise<PostgresQueryResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    this.calls.push(normalized)
    if (normalized.startsWith('SELECT order_row.id')) {
      return result([{
        id: orderId,
        public_id: 'expired-payment-order-0001',
        payment_state: this.paymentState,
      }])
    }
    if (normalized.startsWith('SELECT id, settlement_mode')) {
      return result([{
        id: orderId,
        settlement_mode: 'immediate_payment',
        payment_status: 'unpaid',
        fulfillment_state: 'awaiting_payment',
        fulfillment_expires_at: '2026-08-15T00:00:00.000Z',
      }])
    }
    if (normalized.startsWith('SELECT reservation.id')) {
      return result([{
        id: reservationId,
        order_id: orderId,
        order_item_id: orderItemId,
        inventory_item_id: inventoryItemId,
        sku: 'TEST-INGREDIENT',
        quantity: '1.000000',
        status: 'reserved',
        expires_at: '2026-08-15T00:00:00.000Z',
        movement_id: null,
      }])
    }
    if (normalized.startsWith('SELECT inventory_item_id FROM mbox.inventory_balances')) {
      return result([{ inventory_item_id: inventoryItemId }])
    }
    if (normalized.startsWith('SELECT mbox.release_reserved_order_fulfillment_capacity')) {
      return result([{ affected_count: 0 }])
    }
    if (normalized.startsWith('UPDATE mbox.inventory_balances')) return result([{}])
    if (normalized.startsWith('UPDATE mbox.inventory_order_reservations')) return result([{}])
    if (normalized.startsWith('UPDATE mbox.orders')) return result([{}])
    if (normalized.startsWith('INSERT INTO mbox.audit_events')) return result([{}])
    if (normalized.startsWith('INSERT INTO mbox.outbox_messages')) return result([{}])
    return result([])
  }

  release(): void {}
}

describe('PaymentReservationExpiryWorker', () => {
  it('releases stock only when no payment attempt exists and records recovery evidence atomically', async () => {
    const client = new ExpiryClient('none')
    const worker = workerFor(client)

    await expect(worker.runBatch(scope, 'payment-expiry-worker-1')).resolves.toEqual({
      workerId: 'payment-expiry-worker-1',
      claimed: 1,
      releasedOrderIds: [orderId],
      activatedOrderIds: [],
      reviewOrderIds: [],
    })
    expect(client.calls).toEqual(expect.arrayContaining([
      expect.stringContaining('FOR UPDATE OF order_row SKIP LOCKED'),
      expect.stringContaining('reserved_quantity = reserved_quantity -'),
      expect.stringContaining("SET status = 'released'"),
      expect.stringContaining("SET fulfillment_state = 'released'"),
      expect.stringContaining('INSERT INTO mbox.audit_events'),
      expect.stringContaining('INSERT INTO mbox.outbox_messages'),
    ]))
    expect(client.calls.at(-1)).toBe('COMMIT')
  })

  it('does not release an expired reservation while a payment result is unknown', async () => {
    const client = new ExpiryClient('unknown')
    const worker = workerFor(client)

    await expect(worker.runBatch(scope, 'payment-expiry-worker-1')).resolves.toEqual({
      workerId: 'payment-expiry-worker-1',
      claimed: 1,
      releasedOrderIds: [],
      activatedOrderIds: [],
      reviewOrderIds: [orderId],
    })
    expect(client.calls.some((sql) => sql.startsWith('UPDATE mbox.inventory_balances'))).toBe(false)
    expect(client.calls.some((sql) => sql.startsWith('UPDATE mbox.orders'))).toBe(false)
    expect(client.calls.at(-1)).toBe('COMMIT')
  })

  it('rejects an unsafe batch size', () => {
    expect(() => workerFor(new ExpiryClient('none')).runBatch(scope, 'payment-expiry-worker-1', 51))
      .toThrow('batchSize must be an integer between 1 and 50')
  })
})

function workerFor(client: PostgresPoolClient): PaymentReservationExpiryWorker {
  return new PaymentReservationExpiryWorker(new ScopedPostgresTransactionRunner({
    connect: async () => client,
    end: async () => undefined,
  }))
}

function result<Row extends Record<string, unknown>>(rows: Row[]): PostgresQueryResult<Row> {
  return { rows, rowCount: rows.length }
}

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('PaymentReservationExpiryWorker PostgreSQL integration', () => {
  let pool: Pool
  let worker: PaymentReservationExpiryWorker
  const integrationTenantId = randomUUID()
  const integrationStoreId = randomUUID()
  const areaId = randomUUID()
  const tableId = randomUUID()
  const sessionId = randomUUID()
  const productId = randomUUID()
  const integrationInventoryId = randomUUID()
  const safeOrderId = randomUUID()
  const pendingOrderId = randomUUID()
  const safeOrderItemId = randomUUID()
  const pendingOrderItemId = randomUUID()

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    worker = new PaymentReservationExpiryWorker(new ScopedPostgresTransactionRunner({
      connect: async () => pool.connect(),
      end: async () => pool.end(),
    }))
    await pool.query(`INSERT INTO mbox.tenants (id, code, name) VALUES ($1, $2, 'Payment expiry tenant')`, [
      integrationTenantId, `payment-expiry-${integrationTenantId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.stores (id, tenant_id, code, name) VALUES ($1, $2, $3, 'Payment expiry store')`, [
      integrationStoreId, integrationTenantId, `payment-expiry-${integrationStoreId.slice(0, 8)}`,
    ])
    await pool.query(`INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type) VALUES ($1, $2, $3, 'PAY', 'Pay', 'indoor')`, [
      areaId, integrationTenantId, integrationStoreId,
    ])
    await pool.query(`INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity) VALUES ($1, $2, $3, $4, 'P01', 'P01', 4)`, [
      tableId, integrationTenantId, integrationStoreId, areaId,
    ])
    await pool.query(`INSERT INTO mbox.table_sessions (id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status) VALUES ($1, $2, $3, $4, 'payment-expiry-session', '2026-08-15', 2, 'open')`, [
      sessionId, integrationTenantId, integrationStoreId, tableId,
    ])
    await pool.query(`INSERT INTO mbox.products (id, tenant_id, store_id, code, name, category_code, fulfillment_station) VALUES ($1, $2, $3, 'PAY-PRODUCT', 'Payment product', 'drink', 'bar')`, [
      productId, integrationTenantId, integrationStoreId,
    ])
    await pool.query(`INSERT INTO mbox.inventory_items (id, tenant_id, store_id, sku, name, item_type, base_unit) VALUES ($1, $2, $3, 'PAY-ING', 'Payment ingredient', 'ingredient', 'ml')`, [
      integrationInventoryId, integrationTenantId, integrationStoreId,
    ])
    await pool.query(`INSERT INTO mbox.inventory_balances (tenant_id, store_id, inventory_item_id, on_hand_quantity, reserved_quantity) VALUES ($1, $2, $3, 10, 2)`, [
      integrationTenantId, integrationStoreId, integrationInventoryId,
    ])
    await pool.query(`
      INSERT INTO mbox.orders (
        id, tenant_id, store_id, table_session_id, public_id, channel,
        settlement_mode, status, subtotal_amount_minor, total_amount_minor,
        fulfillment_state, fulfillment_expires_at, fulfillment_activated_at
      ) VALUES
        ($1, $3, $4, $5, 'payment-expiry-safe', 'integration', 'immediate_payment', 'submitted', 100, 100, 'awaiting_payment', clock_timestamp() - interval '1 minute', NULL),
        ($2, $3, $4, $5, 'payment-expiry-pending', 'integration', 'immediate_payment', 'submitted', 100, 100, 'awaiting_payment', clock_timestamp() - interval '1 minute', NULL)
    `, [safeOrderId, pendingOrderId, integrationTenantId, integrationStoreId, sessionId])
    await pool.query(`
      INSERT INTO mbox.order_items (
        id, tenant_id, store_id, order_id, product_id, quantity,
        unit_price_minor, total_amount_minor, fulfillment_station, product_snapshot
      ) VALUES
        ($1, $3, $4, $5, $7, 1, 100, 100, 'bar', '{}'::jsonb),
        ($2, $3, $4, $6, $7, 1, 100, 100, 'bar', '{}'::jsonb)
    `, [safeOrderItemId, pendingOrderItemId, integrationTenantId, integrationStoreId, safeOrderId, pendingOrderId, productId])
    await pool.query(`
      INSERT INTO mbox.inventory_order_reservations (
        tenant_id, store_id, order_id, order_item_id, inventory_item_id,
        quantity, status, expires_at
      ) VALUES
        ($1, $2, $3, $5, $7, 1, 'reserved', clock_timestamp() - interval '1 minute'),
        ($1, $2, $4, $6, $7, 1, 'reserved', clock_timestamp() - interval '1 minute')
    `, [integrationTenantId, integrationStoreId, safeOrderId, pendingOrderId, safeOrderItemId, pendingOrderItemId, integrationInventoryId])
    await pool.query(`
      INSERT INTO mbox.payments (
        tenant_id, store_id, order_id, public_id, provider, method,
        amount_minor, status
      ) VALUES ($1, $2, $3, 'payment-expiry-pending-intent', 'simulation', 'native_qr', 100, 'pending')
    `, [integrationTenantId, integrationStoreId, pendingOrderId])
  })

  afterAll(async () => pool?.end())

  it('releases only the no-payment order and preserves stock for an unknown provider result', async () => {
    const batch = await worker.runBatch(
      { tenantId: integrationTenantId, storeId: integrationStoreId },
      'payment-expiry-postgres',
    )
    expect(batch.releasedOrderIds).toEqual([safeOrderId])
    expect(batch.reviewOrderIds).toEqual([pendingOrderId])

    const evidence = await pool.query<{
      safe_state: string
      pending_state: string
      safe_reservation: string
      pending_reservation: string
      reserved_quantity: string
      audits: string
      outbox: string
    }>(`
      SELECT
        (SELECT fulfillment_state FROM mbox.orders WHERE id = $1::uuid) AS safe_state,
        (SELECT fulfillment_state FROM mbox.orders WHERE id = $2::uuid) AS pending_state,
        (SELECT status FROM mbox.inventory_order_reservations WHERE order_id = $1::uuid) AS safe_reservation,
        (SELECT status FROM mbox.inventory_order_reservations WHERE order_id = $2::uuid) AS pending_reservation,
        (SELECT reserved_quantity::text FROM mbox.inventory_balances
          WHERE tenant_id = $3::uuid AND store_id = $4::uuid AND inventory_item_id = $5::uuid) AS reserved_quantity,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE object_id = $1::uuid::text AND action = 'order.payment_reservation_expired') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE aggregate_id = $1::uuid AND message_type = 'order.payment_reservation_expired.v1') AS outbox
    `, [safeOrderId, pendingOrderId, integrationTenantId, integrationStoreId, integrationInventoryId])
    expect(evidence.rows[0]).toEqual({
      safe_state: 'released', pending_state: 'awaiting_payment',
      safe_reservation: 'released', pending_reservation: 'reserved',
      reserved_quantity: '1.000000', audits: '1', outbox: '1',
    })
  })
})
