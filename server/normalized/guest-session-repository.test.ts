import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { CustomerRepository } from './customer-repository.js'
import {
  GuestSessionInvalidError,
  GuestSessionService,
  GuestTableSessionEndedError,
  hashGuestSessionToken,
  hashTableQrCredential,
  type GuestAnonymousIdentityPort,
} from './guest-session-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type PostgresPoolClient,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const secret = 'guest-session-test-hmac-secret-at-least-32-characters'
const fixedQr = 'permanent_table_qr_'.padEnd(48, 'q')
const deviceKey = 'wechat-device-guest-integration-001'

describe('guest session credential hashing', () => {
  it('uses a one-way token digest and store-scoped HMAC table credential', () => {
    const scopeOne = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      storeId: '22222222-2222-4222-8222-222222222222',
    }
    const scopeTwo = { ...scopeOne, storeId: '33333333-3333-4333-8333-333333333333' }
    const token = 'guest_session_'.padEnd(48, 's')
    expect(hashGuestSessionToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashGuestSessionToken(token)).not.toContain(token)
    expect(hashTableQrCredential(secret, scopeOne, fixedQr))
      .not.toBe(hashTableQrCredential(secret, scopeTwo, fixedQr))
  })
})

integration('normalized guest sessions with PostgreSQL', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let service: GuestSessionService
  let tenantId: string
  let storeId: string
  let areaId: string
  let tableId: string
  let tableSessionId: string | null
  let customerCreates: number

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 12 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    tenantId = randomUUID()
    storeId = randomUUID()
    areaId = randomUUID()
    tableId = randomUUID()
    tableSessionId = null
    customerCreates = 0

    const identities: GuestAnonymousIdentityPort = {
      resolveAnonymous: async (input) => {
        const result = await new CustomerRepository(input.transaction).createAnonymous({
          publicId: input.publicId,
          identityHash: input.identityHash,
          profile: {},
        })
        if (result.created) customerCreates += 1
        return { customerId: result.customer.id }
      },
    }
    service = new GuestSessionService(transactions, identities, secret, {
      sessionTtlMs: 30 * 60_000,
      now: () => new Date(),
    })

    await pool.query(`
      INSERT INTO mbox.tenants (id, code, name)
      VALUES ($1::uuid, $2, 'Guest session tenant')
    `, [tenantId, `guest-tenant-${tenantId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.stores (
        id, tenant_id, code, name, timezone, business_day_cutoff
      ) VALUES (
        $1::uuid, $2::uuid, $3, 'Guest session store', 'Asia/Shanghai', '06:00'
      )
    `, [storeId, tenantId, `guest-store-${storeId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'GUEST', 'Guest area', 'indoor')
    `, [areaId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.tables (
        id, tenant_id, store_id, area_id, code, display_name, capacity, qr_version
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'VIP1', 'VIP 1', 6, 1
      )
    `, [tableId, tenantId, storeId, areaId])
    await pool.query(`
      INSERT INTO mbox.table_qr_credentials (
        tenant_id, store_id, table_id, qr_version, credential_hash
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4)
    `, [
      tenantId,
      storeId,
      tableId,
      hashTableQrCredential(secret, { tenantId, storeId }, fixedQr),
    ])
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('returns a waiting state without creating a customer or guest session before opening', async () => {
    const result = await service.scanTable({
      scope: { tenantId, storeId },
      tableQrToken: fixedQr,
      deviceFingerprint: deviceKey,
      businessDate: '2026-08-11',
    })
    expect(result).toEqual({
      status: 'waiting_for_table',
      tableCode: 'VIP1',
      tableDisplayName: 'VIP 1',
    })

    const counts = await pool.query<{ customers: string; sessions: string; waiting_events: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.customers
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS customers,
        (SELECT count(*)::text FROM mbox.guest_sessions
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS sessions,
        (SELECT count(*)::text FROM mbox.guest_session_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND reason_code = 'TABLE_NOT_OPEN') AS waiting_events
    `, [tenantId, storeId])
    expect(counts.rows[0]).toEqual({ customers: '0', sessions: '0', waiting_events: '1' })
  })

  it('creates one anonymous customer and one active session under concurrent rescans', async () => {
    tableSessionId = randomUUID()
    await pool.query(`
      INSERT INTO mbox.table_sessions (
        id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid,
        'guest-table-session-0001', DATE '2026-08-11', 2, 'open'
      )
    `, [tableSessionId, tenantId, storeId, tableId])

    const scan = () => service.scanTable({
      scope: { tenantId, storeId },
      tableQrToken: fixedQr,
      deviceFingerprint: deviceKey,
      businessDate: '2026-08-11',
    })
    const results = await Promise.all([scan(), scan()])
    expect(results.map((result) => result.status).toSorted())
      .toEqual(['active', 'already_active'])
    expect(customerCreates).toBe(1)

    const stored = await pool.query<{
      active_sessions: string
      customers: string
      memberships: string
      raw_qr_matches: string
      raw_device_matches: string
    }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.guest_sessions
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND revoked_at IS NULL)
          AS active_sessions,
        (SELECT count(*)::text FROM mbox.customers
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS customers,
        (SELECT count(*)::text FROM mbox.table_session_customers
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND table_session_id = $3::uuid) AS memberships,
        (SELECT count(*)::text FROM mbox.table_qr_credentials
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND credential_hash::text = $4) AS raw_qr_matches,
        (SELECT count(*)::text FROM mbox.guest_sessions
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND device_hash::text = $5) AS raw_device_matches
    `, [tenantId, storeId, tableSessionId, fixedQr, deviceKey])
    expect(stored.rows[0]).toEqual({
      active_sessions: '1',
      customers: '1',
      memberships: '1',
      raw_qr_matches: '0',
      raw_device_matches: '0',
    })

    const activeResults = results.filter((result) => result.status === 'active')
    expect(activeResults).toHaveLength(1)
    const authentication = await Promise.allSettled(activeResults.map((result) => (
      result.status === 'active'
        ? service.authenticate({
            scope: { tenantId, storeId },
            sessionToken: result.sessionToken,
            deviceFingerprint: deviceKey,
          })
        : Promise.reject(new Error('unexpected result'))
    )))
    expect(authentication.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(authentication.filter((result) => result.status === 'rejected')).toHaveLength(0)
  })

  it('enforces the per-device fixed-table scan limit in PostgreSQL', async () => {
    const scan = () => service.scanTable({
      scope: { tenantId, storeId },
      tableQrToken: fixedQr,
      deviceFingerprint: deviceKey,
      businessDate: '2026-08-11',
    })
    // One waiting scan and two concurrent active scans already consumed three attempts.
    for (let index = 0; index < 7; index += 1) {
      await expect(scan()).resolves.toMatchObject({ status: 'already_active' })
    }
    const limited = await scan()
    expect(limited).toMatchObject({
      status: 'rate_limited',
      retryAt: expect.any(String),
    })
    const events = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM mbox.guest_session_events
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND reason_code = 'SCAN_RATE_LIMITED'
    `, [tenantId, storeId])
    expect(events.rows[0]?.count).toBe('1')
  })

  it('invalidates the old token immediately when the table begins closing', async () => {
    const scan = await service.scanTable({
      scope: { tenantId, storeId },
      tableQrToken: fixedQr,
      deviceFingerprint: 'wechat-device-guest-integration-002',
      businessDate: '2026-08-11',
    })
    expect(scan.status).toBe('active')
    if (scan.status !== 'active' || !tableSessionId) throw new Error('guest session was not issued')

    await pool.query(`
      UPDATE mbox.table_sessions
      SET status = 'closing'
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [tenantId, storeId, tableSessionId])

    await expect(service.authenticate({
      scope: { tenantId, storeId },
      sessionToken: scan.sessionToken,
      deviceFingerprint: 'wechat-device-guest-integration-002',
    })).rejects.toBeInstanceOf(GuestTableSessionEndedError)

    const evidence = await pool.query<{ active: string; revoked_events: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.guest_sessions
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND table_session_id = $3::uuid AND revoked_at IS NULL) AS active,
        (SELECT count(*)::text FROM mbox.guest_session_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND table_session_id = $3::uuid
            AND event_type = 'guest_session.revoked') AS revoked_events
    `, [tenantId, storeId, tableSessionId])
    expect(evidence.rows[0]?.active).toBe('0')
    expect(Number(evidence.rows[0]?.revoked_events)).toBeGreaterThanOrEqual(2)
  })

  it('rejects cross-store QR reuse and records only hashed denial evidence', async () => {
    const secondStoreId = randomUUID()
    await pool.query(`
      INSERT INTO mbox.stores (id, tenant_id, code, name)
      VALUES ($1::uuid, $2::uuid, $3, 'Other store')
    `, [secondStoreId, tenantId, `other-store-${secondStoreId.slice(0, 8)}`])
    const result = await service.scanTable({
      scope: { tenantId, storeId: secondStoreId },
      tableQrToken: fixedQr,
      deviceFingerprint: deviceKey,
      businessDate: '2026-08-11',
    })
    expect(result).toEqual({ status: 'invalid_qr' })
  })

  it('prevents a table session from receiving reservation or member scopes', async () => {
    const customer = await pool.query<{ id: string }>(`
      SELECT customer_id AS id
      FROM mbox.table_session_customers
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      LIMIT 1
    `, [tenantId, storeId])
    await expect(pool.query(`
      INSERT INTO mbox.guest_sessions (
        tenant_id, store_id, session_kind, customer_id, table_session_id,
        token_hash, device_hash, scopes, issued_at, expires_at
      ) VALUES (
        $1::uuid, $2::uuid, 'table', $3::uuid, $4::uuid,
        $5, $6, ARRAY['guest.reservation.update'],
        clock_timestamp(), clock_timestamp() + interval '30 minutes'
      )
    `, [
      tenantId,
      storeId,
      customer.rows[0]?.id,
      tableSessionId,
      'a'.repeat(64),
      'b'.repeat(64),
    ])).rejects.toMatchObject({ code: '23514' })
  })

  it('does not authenticate a bearer token on another device', async () => {
    await expect(service.authenticate({
      scope: { tenantId, storeId },
      sessionToken: 'unknown_guest_session_'.padEnd(48, 'x'),
      deviceFingerprint: 'different-device-001',
    })).rejects.toBeInstanceOf(GuestSessionInvalidError)
  })
})

function asPool(pool: Pool): PostgresPool {
  return {
    connect: async () => asPoolClient(await pool.connect()),
    end: async () => pool.end(),
  }
}

function asPoolClient(client: PoolClient): PostgresPoolClient {
  return {
    query: (text, values) => client.query(text, values),
    release: (error) => client.release(error),
  }
}
