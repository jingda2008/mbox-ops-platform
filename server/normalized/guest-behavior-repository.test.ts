import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  GuestBehaviorRepository,
  GuestBehaviorSessionUnavailableError,
  hashGuestBehaviorPrincipal,
} from './guest-behavior-repository.js'
import { seedActiveGuestTableAuthority } from './guest-table-authority.test-helper.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type PostgresPoolClient,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

describe('guest behavior principal protection', () => {
  it('stores one-way hashes rather than actor or device identifiers', () => {
    const actor = 'guest-session:secure-random-session-id'
    const device = 'wechat-device-fingerprint-0001'
    expect(hashGuestBehaviorPrincipal(actor)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashGuestBehaviorPrincipal(actor)).not.toContain(actor)
    expect(hashGuestBehaviorPrincipal(device)).not.toBe(hashGuestBehaviorPrincipal(actor))
  })
})

integration('normalized guest behavior repository with PostgreSQL', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let tenantId: string
  let storeId: string
  let tableSessionId: string
  let customerId: string
  let guestActorRef: string

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    tenantId = randomUUID()
    storeId = randomUUID()
    customerId = randomUUID()
    const areaId = randomUUID()
    const tableId = randomUUID()
    tableSessionId = randomUUID()
    await pool.query(
      `INSERT INTO mbox.tenants (id, code, name) VALUES ($1::uuid, $2, 'Guest behavior tenant')`,
      [tenantId, `gb-tenant-${tenantId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.stores (id, tenant_id, code, name, timezone, business_day_cutoff)
       VALUES ($1::uuid, $2::uuid, $3, 'Guest behavior store', 'Asia/Shanghai', '06:00')`,
      [storeId, tenantId, `gb-store-${storeId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'GB', 'Guest behavior', 'indoor')`,
      [areaId, tenantId, storeId],
    )
    await pool.query(
      `INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity, qr_version)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'VIP1', 'VIP 1', 6, 1)`,
      [tableId, tenantId, storeId, areaId],
    )
    await pool.query(
      `INSERT INTO mbox.customers (id, tenant_id, store_id, public_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      [customerId, tenantId, storeId, `gb-customer-${customerId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.table_sessions (
         id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, DATE '2026-08-11', 2, 'open')`,
      [tableSessionId, tenantId, storeId, tableId, `gb-session-${tableSessionId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO mbox.table_session_customers (
         tenant_id, store_id, table_session_id, customer_id, relationship
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'primary')`,
      [tenantId, storeId, tableSessionId, customerId],
    )
    guestActorRef=await seedActiveGuestTableAuthority(pool,{
      tenantId,storeId,tableSessionId,customerId,
    })
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('records mood without raw credentials and preserves it after table turnover', async () => {
    const actorRef = guestActorRef
    const device = 'wechat-device-behavior-test-0001'
    const event = await transactions.run({ tenantId, storeId }, (transaction) => (
      new GuestBehaviorRepository(transaction).record({
        tableSessionId,
        customerId,
        behaviorType: 'guest.mood.selected',
        behaviorCode: 'happy',
        behaviorData: { source: 'guest_table_page' },
        actorRef,
        deviceFingerprint: device,
      })
    ))
    expect(event).toMatchObject({ behaviorCode: 'happy', tableSessionId, customerId })

    const stored = await pool.query<{
      actor_ref_hash: string
      device_hash: string
      raw_actor: string
      raw_device: string
    }>(`
      SELECT actor_ref_hash, device_hash,
        (actor_ref_hash::text = $4)::text AS raw_actor,
        (device_hash::text = $5)::text AS raw_device
      FROM mbox.guest_behavior_events
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [tenantId, storeId, event.id, actorRef, device])
    expect(stored.rows[0]).toMatchObject({ raw_actor: 'false', raw_device: 'false' })

    await pool.query(`
      UPDATE mbox.table_sessions SET status = 'closing'
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [tenantId, storeId, tableSessionId])
    await expect(transactions.run({ tenantId, storeId }, (transaction) => (
      new GuestBehaviorRepository(transaction).record({
        tableSessionId,
        customerId,
        behaviorType: 'guest.mood.selected',
        behaviorCode: 'quiet',
        actorRef,
        deviceFingerprint: device,
      })
    ))).rejects.toBeInstanceOf(GuestBehaviorSessionUnavailableError)

    const history = await transactions.run({ tenantId, storeId }, (transaction) => (
      new GuestBehaviorRepository(transaction).listForTableSession(tableSessionId)
    ), { readOnly: true })
    expect(history).toHaveLength(1)
    expect(history[0]?.behaviorCode).toBe('happy')
  })
})

function asPool(pool: Pool): PostgresPool {
  return {
    connect: async () => asClient(await pool.connect()),
    end: async () => pool.end(),
  }
}

function asClient(client: PoolClient): PostgresPoolClient {
  return {
    query: (text, values) => client.query(text, values === undefined ? undefined : [...values]),
    release: (error) => client.release(error),
  }
}
