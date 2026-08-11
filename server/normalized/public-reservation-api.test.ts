import { createHash, randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { publicReservationApiPlugin } from './public-reservation-api.js'
import { WaitlistCommandService } from './waitlist-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type PostgresPoolClient,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('public reservation API with PostgreSQL', () => {
  let pool: Pool
  let app: FastifyInstance
  let tenantId: string
  let storeId: string
  let customerId: string
  let tableId: string
  let publicSequence = 0
  const fixedNow = new Date()
  const crossMidnight = futureCrossMidnight(fixedNow)

  const rawContact = '13800138000'
  const maskedContact = '138****8000'

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 16 })
    const transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    const commands = new NormalizedCommandExecutor(transactions)
    tenantId = randomUUID()
    storeId = randomUUID()
    customerId = randomUUID()
    tableId = randomUUID()
    const areaId = randomUUID()

    await pool.query(`INSERT INTO mbox.tenants (id, code, name) VALUES ($1, $2, 'Public reservation tenant')`, [
      tenantId,
      `public-reservation-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.stores (id, tenant_id, code, name, timezone, business_day_cutoff)
      VALUES ($1, $2, $3, 'Public reservation store', 'Asia/Shanghai', '06:00')
    `, [storeId, tenantId, `public-store-${storeId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.public_reservation_policies (
        tenant_id, store_id, hold_minutes, deposit_mode, deposit_minor, deposit_rule_text
      ) VALUES ($1, $2, 20, 'flat', 50000, '定金可抵扣当日消费')
    `, [tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.customers (id, tenant_id, store_id, public_id)
      VALUES ($1, $2, $3, $4)
    `, [customerId, tenantId, storeId, `customer-${customerId}`])
    await pool.query(`
      INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type, sort_order)
      VALUES ($1, $2, $3, 'VIP', '舞台前区', 'vip', 1)
    `, [areaId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.tables (
        id, tenant_id, store_id, area_id, code, display_name, capacity, minimum_spend_minor
      ) VALUES ($1, $2, $3, $4, 'VIP1', 'VIP 1', 6, 188800)
    `, [tableId, tenantId, storeId, areaId])

    app = Fastify()
    await app.register(publicReservationApiPlugin, {
      transactions,
      commands,
      waitlists: new WaitlistCommandService(commands),
      reservationSessions: {
        issue: async () => ({
          replayed: false,
          value: {
            sessionToken: 'reservation-test-session-token'.padEnd(48, 's'),
            session: {
              id: randomUUID(),
              customerId,
              actorRef: 'guest-test',
              scopes: ['guest.reservation.read', 'guest.reservation.update', 'guest.waitlist.manage'],
              expiresAt: '2026-08-11T13:00:00.000Z',
            },
          },
        }),
      },
      resolveTrustedScope: () => ({ tenantId, storeId }),
      resolveGuest: () => ({
        scope: { tenantId, storeId },
        sessionId: 'reservation-session-test',
        customerId,
        actorRef: 'reservation-session:test',
        businessDate: '2026-08-11',
        capabilities: ['guest.reservation.read', 'guest.reservation.update', 'guest.waitlist.manage'],
      }),
      resolveStaff: () => ({
        scope: { tenantId, storeId },
        employeeId: randomUUID(),
        permissions: ['reservation.view', 'reservation.view.all'],
        visibleOwnerEmployeeIds: [],
      }),
      protectContact: () => ({
        hash: createHash('sha256').update(rawContact).digest('hex'),
        encryptedBase64: Buffer.from(`encrypted-contact:${rawContact}`).toString('base64'),
        keyId: 'test-key-v1',
        masked: maskedContact,
      }),
      currentBusinessDate: () => '2026-08-11',
      now: () => fixedNow,
      createPublicId: (kind) => `${kind}-中文编号-${String(++publicSequence).padStart(4, '0')}`,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await pool?.end()
  })

  it('publishes only area, table, capacity and minimum-spend availability fields', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/public/reservation/availability?arrivalAt=${encodeURIComponent(crossMidnight.arrivalAt)}&expectedEndAt=${encodeURIComponent(crossMidnight.expectedEndAt)}&guestCount=2`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.data.areas[0]).toMatchObject({
      code: 'VIP',
      name: '舞台前区',
      tables: [{
        code: 'VIP1',
        capacity: 6,
        minimumSpendMinor: 188800,
        available: true,
        status: 'available',
      }],
    })
    expect(JSON.stringify(body)).not.toContain(tableId)
    expect(JSON.stringify(body)).not.toContain(customerId)
  })

  it('allows one cross-midnight self-selected hold and rejects the concurrent collision', async () => {
    const submit = (suffix: string) => app.inject({
      method: 'POST',
      url: '/public/reservations',
      headers: { 'idempotency-key': `public-reservation-concurrent-${suffix}` },
      payload: {
        mode: 'self_select',
        customerName: '王女士',
        contact: rawContact,
        guestCount: 2,
        arrivalAt: crossMidnight.arrivalAt,
        expectedEndAt: crossMidnight.expectedEndAt,
        tableCodes: ['VIP1'],
        note: '靠近舞台即可',
      },
    })
    const responses = await Promise.all([submit('A'), submit('B')])
    expect(responses.map((response) => response.statusCode).toSorted()).toEqual([201, 409])
    const success = responses.find((response) => response.statusCode === 201)!
    const body = success.json()
    expect(body.data).toMatchObject({
      customerName: '王女士',
      maskedContact,
      tableCodes: ['VIP1'],
      status: 'pending',
    })
    expect(JSON.stringify(body)).not.toContain(rawContact)
    expect(JSON.stringify(body)).not.toContain(customerId)
    expect(JSON.stringify(body)).not.toContain(tableId)

    const stored = await pool.query<{
      reservations: string
      locks: string
      private_contacts: string
      raw_contact_tokens: string
      raw_encrypted_text: string
      audits: string
      outbox: string
    }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.reservations
          WHERE tenant_id = $1 AND store_id = $2) AS reservations,
        (SELECT count(*)::text FROM mbox.reservation_table_locks
          WHERE tenant_id = $1 AND store_id = $2 AND status = 'held') AS locks,
        (SELECT count(*)::text FROM mbox.reservation_private_contacts
          WHERE tenant_id = $1 AND store_id = $2) AS private_contacts,
        (SELECT count(*)::text FROM mbox.reservations
          WHERE tenant_id = $1 AND store_id = $2 AND contact_token = $3) AS raw_contact_tokens,
        (SELECT count(*)::text FROM mbox.reservation_private_contacts
          WHERE tenant_id = $1 AND store_id = $2
            AND convert_from(encrypted_contact, 'UTF8') = $3) AS raw_encrypted_text,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE tenant_id = $1 AND store_id = $2 AND action = 'reservation.created') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE tenant_id = $1 AND store_id = $2 AND message_type = 'reservation.created.v1') AS outbox
    `, [tenantId, storeId, rawContact])
    expect(stored.rows[0]).toEqual({
      reservations: '1',
      locks: '1',
      private_contacts: '1',
      raw_contact_tokens: '0',
      raw_encrypted_text: '0',
      audits: '1',
      outbox: '1',
    })

    const availability = await app.inject({
      method: 'GET',
      url: `/public/reservation/availability?arrivalAt=${encodeURIComponent(crossMidnight.arrivalAt)}&expectedEndAt=${encodeURIComponent(crossMidnight.expectedEndAt)}&guestCount=2`,
    })
    expect(availability.statusCode).toBe(200)
    expect(availability.json().data.areas[0].tables[0]).toMatchObject({
      code: 'VIP1',
      available: false,
      status: 'locked',
    })
    expect(availability.body).not.toContain('王女士')
    expect(availability.body).not.toContain(maskedContact)
  })

  it('returns only the signed-in customer reservation and masks contact details', async () => {
    const publicId = (await pool.query<{ public_id: string }>(`
      SELECT public_id FROM mbox.reservations WHERE tenant_id = $1 AND store_id = $2 LIMIT 1
    `, [tenantId, storeId])).rows[0]?.public_id
    const response = await app.inject({ method: 'GET', url: `/public/reservations/${encodeURIComponent(publicId!)}` })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.maskedContact).toBe(maskedContact)
    expect(response.body).not.toContain(rawContact)
    expect(response.body).not.toContain(customerId)
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

function futureCrossMidnight(now: Date): { arrivalAt: string; expectedEndAt: string } {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60_000)
  const arrivalDate = new Date(Date.UTC(
    shanghai.getUTCFullYear(),
    shanghai.getUTCMonth(),
    shanghai.getUTCDate() + 1,
  ))
  const endDate = new Date(arrivalDate.getTime() + 24 * 60 * 60_000)
  const dateText = arrivalDate.toISOString().slice(0, 10)
  const endText = endDate.toISOString().slice(0, 10)
  return {
    arrivalAt: `${dateText}T23:30:00+08:00`,
    expectedEndAt: `${endText}T02:00:00+08:00`,
  }
}
