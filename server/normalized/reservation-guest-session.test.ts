import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  hashReservationGuestValue,
  ReservationGuestSessionInvalidError,
  ReservationGuestSessionService,
  type ReservationIdentityPort,
} from './reservation-guest-session.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type PostgresPoolClient,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

describe('reservation guest session privacy', () => {
  it('hashes bearer, device and identity material with one-way SHA-256', () => {
    const raw = 'wechat-identity-assertion-secret'
    expect(hashReservationGuestValue(raw)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashReservationGuestValue(raw)).not.toContain(raw)
  })
})

integration('reservation guest sessions with PostgreSQL', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let service: ReservationGuestSessionService
  let tenantId: string
  let storeId: string
  let customerId: string

  const assertion = 'wechat-validation-assertion-never-persisted'
  const device = 'reservation-device-fingerprint-001'
  const token = 'reservation_guest_token_'.padEnd(48, 't')
  const fixedNow = new Date()

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    tenantId = randomUUID()
    storeId = randomUUID()
    customerId = randomUUID()
    await pool.query(`INSERT INTO mbox.tenants (id, code, name) VALUES ($1, $2, 'Reservation session tenant')`, [
      tenantId,
      `session-tenant-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.stores (id, tenant_id, code, name, timezone, business_day_cutoff)
      VALUES ($1, $2, $3, 'Reservation session store', 'Asia/Shanghai', '06:00')
    `, [storeId, tenantId, `session-store-${storeId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.public_reservation_policies (tenant_id, store_id)
      VALUES ($1, $2)
    `, [tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.customers (id, tenant_id, store_id, public_id)
      VALUES ($1, $2, $3, $4)
    `, [customerId, tenantId, storeId, `customer-${customerId}`])
    const identities: ReservationIdentityPort = {
      resolve: async () => ({ customerId, actorRef: 'wechat:masked-identity' }),
    }
    service = new ReservationGuestSessionService(
      transactions,
      new NormalizedCommandExecutor(transactions),
      identities,
      {
        ttlMs: 30 * 60_000,
        now: () => fixedNow,
        randomToken: () => token,
      },
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('issues an idempotent short-lived session without persisting raw credentials', async () => {
    const issue = () => service.issue({
      scope: { tenantId, storeId },
      provider: 'wechat',
      providerAssertion: assertion,
      deviceFingerprint: device,
      businessDate: '2026-08-11',
      idempotencyKey: 'reservation-session-issue-0001',
      requestFingerprint: 'reservation-session-issue-fingerprint',
    })
    const first = await issue()
    const replay = await issue()
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(replay.value.sessionToken).toBe(token)
    expect(Date.parse(first.value.session.expiresAt) - fixedNow.getTime()).toBe(30 * 60_000)

    const stored = await pool.query<{
      sessions: string
      raw_token: string
      raw_device: string
      raw_assertion: string
      audits: string
      outbox: string
    }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.reservation_guest_sessions
          WHERE tenant_id = $1 AND store_id = $2) AS sessions,
        (SELECT count(*)::text FROM mbox.reservation_guest_sessions
          WHERE token_hash::text = $3) AS raw_token,
        (SELECT count(*)::text FROM mbox.reservation_guest_sessions
          WHERE device_hash::text = $4) AS raw_device,
        (SELECT count(*)::text FROM mbox.reservation_guest_sessions
          WHERE identity_subject_hash::text = $5) AS raw_assertion,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE tenant_id = $1 AND store_id = $2
            AND action = 'reservation_guest_session.issued') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE tenant_id = $1 AND store_id = $2
            AND message_type = 'reservation_guest_session.issued.v1') AS outbox
    `, [tenantId, storeId, token, device, assertion])
    expect(stored.rows[0]).toEqual({
      sessions: '1',
      raw_token: '0',
      raw_device: '0',
      raw_assertion: '0',
      audits: '1',
      outbox: '1',
    })
  })

  it('binds authentication to the same device', async () => {
    await expect(service.authenticate({
      scope: { tenantId, storeId },
      sessionToken: token,
      deviceFingerprint: device,
    })).resolves.toMatchObject({ customerId })
    await expect(service.authenticate({
      scope: { tenantId, storeId },
      sessionToken: token,
      deviceFingerprint: 'different-reservation-device',
    })).rejects.toBeInstanceOf(ReservationGuestSessionInvalidError)
  })
})

function asPool(pool: Pool): PostgresPool {
  return {
    connect: async () => asClient(await pool.connect()),
    end: () => pool.end(),
  }
}

function asClient(client: PoolClient): PostgresPoolClient {
  return {
    query: (text, values) => client.query(text, values),
    release: (error) => client.release(error),
  }
}
