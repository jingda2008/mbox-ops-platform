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
  let scheduleId: string
  let staffEmployeeId: string
  let publicSequence = 0
  let staffPermissions = ['reservation.view', 'reservation.view.all', 'reservation.manage']
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
    scheduleId = randomUUID()
    staffEmployeeId = randomUUID()
    const areaId = randomUUID()
    const performerId = randomUUID()

    await pool.query(`INSERT INTO mbox.tenants (id, code, name) VALUES ($1, $2, 'Public reservation tenant')`, [
      tenantId,
      `public-reservation-${tenantId.slice(0, 8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.stores (id, tenant_id, code, name, timezone, business_day_cutoff)
      VALUES ($1, $2, $3, 'Public reservation store', 'Asia/Shanghai', '06:00')
    `, [storeId, tenantId, `public-store-${storeId.slice(0, 8)}`])
    await pool.query(`
      INSERT INTO mbox.employees (id, tenant_id, store_id, employee_code, display_name)
      VALUES ($1, $2, $3, $4, '预约测试员工')
    `, [staffEmployeeId, tenantId, storeId, `reservation-staff-${staffEmployeeId.slice(0, 8)}`])
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
    await pool.query(`
      INSERT INTO mbox.performers (id, tenant_id, store_id, code, stage_name)
      VALUES ($1, $2, $3, 'PUBLIC_TEST', '预约测试歌手')
    `, [performerId, tenantId, storeId])
    await pool.query(`
      INSERT INTO mbox.schedules (id, tenant_id, store_id, performer_id, starts_at, ends_at)
      VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)
    `, [scheduleId, tenantId, storeId, performerId, crossMidnight.arrivalAt, crossMidnight.expectedEndAt])

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
        employeeId: staffEmployeeId,
        permissions: staffPermissions,
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

  it('scopes the HttpOnly session cookie to the public reservation API', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/public/reservation/session',
      headers: { 'idempotency-key': 'public-reservation-session-cookie-0001' },
      payload: {
        provider: 'anonymous',
        providerAssertion: 'anonymous-reservation-identity',
        deviceFingerprint: 'reservation-device-fingerprint',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.headers['set-cookie']).toContain('Path=/api/public')
    expect(response.headers['set-cookie']).toContain('HttpOnly')
    expect(response.headers['set-cookie']).toContain('Secure')
    expect(response.json()).toMatchObject({
      data: {
        status: 'active',
        sessionToken: 'reservation-test-session-token'.padEnd(48, 's'),
      },
    })
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
    expect(body.data.acceptingReservations).toBe(true)
    expect(body.data.depositRule.policyVersion).toBe(1)
    expect(body.data).not.toHaveProperty('holdMinutes')
  })

  it('rejects exact table selection because public reservations only record a seat preference', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/public/reservations',
      headers: { 'idempotency-key': 'public-reservation-no-table-selection-0001' },
      payload: {
        mode: 'self_select', customerName: '王女士', contact: rawContact, guestCount: 2,
        arrivalAt: crossMidnight.arrivalAt, expectedEndAt: crossMidnight.expectedEndAt,
        tableCodes: ['VIP1'], seatPreference: 'stage_atmosphere',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('PUBLIC_RESERVATION_REQUEST_INVALID')
  })

  it('rejects a reservation when the policy version changed after the confirmation screen', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/public/reservations',
      headers: { 'idempotency-key': 'public-reservation-stale-policy-0001' },
      payload: {
        mode: 'direct', customerName: '王女士', contact: rawContact, guestCount: 2,
        arrivalAt: crossMidnight.arrivalAt, expectedEndAt: crossMidnight.expectedEndAt,
        seatPreference: 'stage_atmosphere', reservationPolicyVersion: 999,
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('RESERVATION_POLICY_CHANGED')
    expect(response.json().error.message).toContain('预约规则刚刚更新')
  })

  it('reserves shared guest capacity atomically without binding any exact table', async () => {
    const submit = (suffix: string) => app.inject({
      method: 'POST',
      url: '/public/reservations',
      headers: { 'idempotency-key': `public-reservation-concurrent-${suffix}` },
      payload: {
        mode: 'direct',
        customerName: '王女士',
        contact: rawContact,
        guestCount: 2,
        arrivalAt: crossMidnight.arrivalAt,
        expectedEndAt: crossMidnight.expectedEndAt,
        seatPreference: 'stage_atmosphere',
        reservationPolicyVersion: 1,
        preferredScheduleId: scheduleId,
        note: '靠近舞台即可',
      },
    })
    const responses = await Promise.all([submit('A'), submit('B'), submit('C'), submit('D')])
    expect(responses.map((response) => response.statusCode).toSorted()).toEqual([201, 201, 201, 409])
    const success = responses.find((response) => response.statusCode === 201)!
    const body = success.json()
    expect(body.data).toMatchObject({
      customerName: '王女士',
      maskedContact,
      status: 'pending',
      preferredScheduleId: scheduleId,
      arrivalGraceEndsAt: new Date(Date.parse(crossMidnight.arrivalAt) + 10 * 60_000).toISOString(),
    })
    expect(body.data).not.toHaveProperty('tableCodes')
    expect(body.data).not.toHaveProperty('holdExpiresAt')
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
      reservations: '3',
      locks: '0',
      private_contacts: '3',
      raw_contact_tokens: '0',
      raw_encrypted_text: '0',
      audits: '3',
      outbox: '3',
    })

    const availability = await app.inject({
      method: 'GET',
      url: `/public/reservation/availability?arrivalAt=${encodeURIComponent(crossMidnight.arrivalAt)}&expectedEndAt=${encodeURIComponent(crossMidnight.expectedEndAt)}&guestCount=2`,
    })
    expect(availability.statusCode).toBe(200)
    expect(availability.json().data).toMatchObject({ acceptingReservations: false })
    expect(availability.json().data.areas[0].tables[0]).toMatchObject({
      code: 'VIP1',
      available: true,
      status: 'available',
    })
    expect(availability.body).not.toContain('王女士')
    expect(availability.body).not.toContain(maskedContact)
  })

  it('lists future staff reservation intake without leaking the protected contact', async () => {
    const from = new Date(Date.parse(crossMidnight.arrivalAt) - 60 * 60_000).toISOString()
    const to = new Date(Date.parse(crossMidnight.arrivalAt) + 60 * 60_000).toISOString()
    const waitlist = await app.inject({
      method: 'POST',
      url: '/public/waitlist',
      headers: { 'idempotency-key': 'public-waitlist-intake-0001' },
      payload: {
        customerName: '候位王女士', contact: rawContact, guestCount: 2,
        desiredArrivalAt: crossMidnight.arrivalAt,
      },
    })
    expect(waitlist.statusCode).toBe(201)
    const waitlistPublicId = waitlist.json().data.publicId as string
    const override = await app.inject({
      method: 'POST',
      url: `/staff/reservation-intake/waitlist/${encodeURIComponent(waitlistPublicId)}/priority-override`,
      headers: { 'idempotency-key': 'staff-waitlist-priority-override-0001' },
      payload: { mode: 'promote', reason: '现场确认优先安排' },
    })
    expect(override.statusCode).toBe(200)
    staffPermissions = ['reservation.view']
    const forbiddenOverride = await app.inject({
      method: 'POST',
      url: `/staff/reservation-intake/waitlist/${encodeURIComponent(waitlistPublicId)}/priority-override`,
      headers: { 'idempotency-key': 'staff-waitlist-priority-override-forbidden-0001' },
      payload: { mode: 'demote', reason: '无权限不应保存' },
    })
    expect(forbiddenOverride.statusCode).toBe(403)
    expect(forbiddenOverride.json().error.code).toBe('RESERVATION_PERMISSION_DENIED')
    staffPermissions = ['reservation.view', 'reservation.view.all', 'reservation.manage']

    const response = await app.inject({
      method: 'GET',
      url: `/staff/reservation-intake?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    })

    expect(response.statusCode).toBe(200)
    const intake = response.json().data as Array<Record<string, unknown>>
    const entry = intake.find((item) => (
      item.kind === 'reservation' && item.customerName === '王女士'
    ))
    expect(entry).toMatchObject({ kind: 'reservation', customerName: '王女士', maskedContact, status: 'pending' })
    expect(Date.parse(String(entry?.arrivalAt))).toBe(Date.parse(crossMidnight.arrivalAt))
    const waitlistEntry = intake.find((item) => (
      item.kind === 'waitlist' && item.publicId === waitlistPublicId
    ))
    expect(waitlistEntry).toMatchObject({
      kind: 'waitlist', customerName: '候位王女士', maskedContact,
      queueOverride: { mode: 'promote', reason: '现场确认优先安排' },
    })
    expect(intake.indexOf(waitlistEntry!)).toBeLessThan(intake.indexOf(entry!))
    expect(response.body).not.toContain(rawContact)
    expect(response.body).not.toContain(customerId)
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

  it('requires the current policy acknowledgement and an explicit performance decision when arrival changes', async () => {
    const selected = await pool.query<{
      id: string
      public_id: string
      arrival_at: string
      expected_end_at: string
      aggregate_version: number
    }>(`
      SELECT id,public_id,arrival_at::text,expected_end_at::text,aggregate_version
      FROM mbox.reservations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND customer_id=$3::uuid
      ORDER BY created_at,id LIMIT 1
    `, [tenantId, storeId, customerId])
    const reservation = selected.rows[0]!
    await pool.query(`
      UPDATE mbox.public_reservation_policies
      SET arrival_grace_minutes=arrival_grace_minutes+1
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
    `, [tenantId, storeId])
    const policy = await pool.query<{ policy_version: number }>(`
      SELECT policy_version FROM mbox.public_reservation_policies
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
    `, [tenantId, storeId])
    const policyVersion = Number(policy.rows[0]!.policy_version)
    expect(policyVersion).toBeGreaterThan(1)

    const missingPolicy = await app.inject({
      method: 'PATCH', url: `/public/reservations/${encodeURIComponent(reservation.public_id)}`,
      headers: { 'idempotency-key': 'reservation-update-policy-required-0001' },
      payload: { note: '不能在未确认新规则时修改' },
    })
    expect(missingPolicy.statusCode).toBe(400)

    const stalePolicy = await app.inject({
      method: 'PATCH', url: `/public/reservations/${encodeURIComponent(reservation.public_id)}`,
      headers: { 'idempotency-key': 'reservation-update-policy-stale-0001' },
      payload: { note: '旧规则版本', reservationPolicyVersion: 1 },
    })
    expect(stalePolicy.statusCode).toBe(409)
    expect(stalePolicy.json().error.code).toBe('RESERVATION_POLICY_CHANGED')

    const nextArrivalAt = new Date(Date.parse(reservation.arrival_at) + 86_400_000).toISOString()
    const nextExpectedEndAt = new Date(Date.parse(reservation.expected_end_at) + 86_400_000).toISOString()
    const missingPerformanceDecision = await app.inject({
      method: 'PATCH', url: `/public/reservations/${encodeURIComponent(reservation.public_id)}`,
      headers: { 'idempotency-key': 'reservation-update-performance-required-0001' },
      payload: {
        arrivalAt: nextArrivalAt, expectedEndAt: nextExpectedEndAt,
        reservationPolicyVersion: policyVersion,
      },
    })
    expect(missingPerformanceDecision.statusCode).toBe(400)
    expect(missingPerformanceDecision.json().error.message).toContain('重新选择演出或明确清空')

    const stalePerformance = await app.inject({
      method: 'PATCH', url: `/public/reservations/${encodeURIComponent(reservation.public_id)}`,
      headers: { 'idempotency-key': 'reservation-update-performance-stale-0001' },
      payload: {
        arrivalAt: nextArrivalAt, expectedEndAt: nextExpectedEndAt,
        reservationPolicyVersion: policyVersion, preferredScheduleId: scheduleId,
      },
    })
    expect(stalePerformance.statusCode).toBe(400)
    expect(stalePerformance.json().error.message).toContain('已改期或取消')

    const updated = await app.inject({
      method: 'PATCH', url: `/public/reservations/${encodeURIComponent(reservation.public_id)}`,
      headers: { 'idempotency-key': 'reservation-update-performance-clear-0001' },
      payload: {
        arrivalAt: nextArrivalAt, expectedEndAt: nextExpectedEndAt,
        reservationPolicyVersion: policyVersion, preferredScheduleId: null,
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().data).toMatchObject({
      arrivalAt: nextArrivalAt,
      preferredScheduleId: null,
      reservationPolicyVersion: policyVersion,
    })
    const stored = await pool.query<{
      reservation_policy_version: number
      reservation_policy_acknowledged_version: number
      preferred_schedule_id: string | null
      aggregate_version: number
    }>(`
      SELECT reservation_policy_version,reservation_policy_acknowledged_version,
        preferred_schedule_id,aggregate_version::integer
      FROM mbox.reservations WHERE id=$1::uuid
    `, [reservation.id])
    expect(stored.rows[0]).toMatchObject({
      reservation_policy_version: policyVersion,
      reservation_policy_acknowledged_version: policyVersion,
      preferred_schedule_id: null,
      aggregate_version: Number(reservation.aggregate_version) + 1,
    })
  })

  it('lists recent reservations across the canonical customer family without leaking another customer', async () => {
    const mergedCustomerId = randomUUID()
    const outsiderCustomerId = randomUUID()
    await pool.query(`
      INSERT INTO mbox.customers (
        id, tenant_id, store_id, public_id, status, merged_into_customer_id
      ) VALUES
        ($1::uuid, $3::uuid, $4::uuid, $5, 'merged', $2::uuid),
        ($6::uuid, $3::uuid, $4::uuid, $7, 'active', NULL)
    `, [
      mergedCustomerId,
      customerId,
      tenantId,
      storeId,
      `merged-customer-${mergedCustomerId}`,
      outsiderCustomerId,
      `outsider-customer-${outsiderCustomerId}`,
    ])
    const rows = await pool.query<{ id: string; public_id: string }>(`
      SELECT id, public_id FROM mbox.reservations
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      ORDER BY id
    `, [tenantId, storeId])
    expect(rows.rows).toHaveLength(3)
    await pool.query(`
      UPDATE mbox.reservations
      SET customer_id = CASE
        WHEN id = $3::uuid THEN $4::uuid
        WHEN id = $5::uuid THEN $6::uuid
        ELSE customer_id
      END
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    `, [
      tenantId,
      storeId,
      rows.rows[0]!.id,
      mergedCustomerId,
      rows.rows[1]!.id,
      outsiderCustomerId,
    ])

    const response = await app.inject({ method: 'GET', url: '/public/reservations/mine' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: { reservations: expect.any(Array) },
      meta: { count: 2 },
    })
    const publicIds = response.json().data.reservations
      .map((reservation: { publicId: string }) => reservation.publicId)
    expect(publicIds).toContain(rows.rows[0]!.public_id)
    expect(publicIds).not.toContain(rows.rows[1]!.public_id)

    const detail = await app.inject({
      method: 'GET', url: `/public/reservations/${encodeURIComponent(rows.rows[0]!.public_id)}`,
    })
    expect(detail.statusCode).toBe(200)
    const currentPolicy = await pool.query<{ policy_version: number }>(`
      SELECT policy_version FROM mbox.public_reservation_policies
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
    `, [tenantId, storeId])
    const changed = await app.inject({
      method: 'PATCH', url: `/public/reservations/${encodeURIComponent(rows.rows[0]!.public_id)}`,
      headers: { 'idempotency-key': 'reservation-canonical-family-update-0001' },
      payload: {
        note: '合并身份仍可修改本人预约',
        reservationPolicyVersion: Number(currentPolicy.rows[0]!.policy_version),
      },
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json().data.note).toBe('合并身份仍可修改本人预约')
    const cancelled = await app.inject({
      method: 'DELETE', url: `/public/reservations/${encodeURIComponent(rows.rows[0]!.public_id)}`,
      headers: { 'idempotency-key': 'reservation-canonical-family-cancel-0001' },
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().data.status).toBe('cancelled')
    expect(response.body).not.toContain(customerId)
    expect(response.body).not.toContain(mergedCustomerId)
    expect(response.body).not.toContain(outsiderCustomerId)
    expect(response.body).not.toContain(rawContact)
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
