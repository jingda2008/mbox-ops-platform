import { createHash, randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { hashRequestFingerprint, NormalizedCommandExecutor } from './command-executor.js'
import { publicReservationApiPlugin } from './public-reservation-api.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { WaitlistCommandService } from './waitlist-repository.js'

const adminUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = adminUrl && runtimeUrl ? describe : describe.skip
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

integration('public reservation durable recovery and receipt ownership', () => {
  let admin: Pool, runtime: Pool, app: FastifyInstance
  let tenantId: string, storeId: string, owner: string, outsider: string, actor: string
  let now: Date, publicIdsGenerated: number
  let payload: { publicId?: string; mode: string; customerName: string; contact: string; guestCount: number; arrivalAt: string; expectedEndAt?: string; reservationPolicyVersion: number }

  beforeAll(async () => {
    await runNormalizedMigrations(adminUrl!)
    admin = new Pool({ connectionString: adminUrl, max: 4 })
    runtime = new Pool({ connectionString: runtimeUrl, max: 4 })
  }, 30_000)
  afterAll(async () => { await runtime?.end(); await admin?.end() })
  afterEach(async () => { await app?.close() })

  beforeEach(async () => {
    tenantId = randomUUID(); storeId = randomUUID(); owner = randomUUID(); outsider = randomUUID(); actor = owner
    now = new Date(); publicIdsGenerated = 0
    const area = randomUUID()
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Reservation recovery')", [tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'reservation-recovery','Reservation recovery')", [storeId, tenantId])
    await admin.query("INSERT INTO mbox.public_reservation_policies(tenant_id,store_id) VALUES($1,$2)", [tenantId, storeId])
    await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$3,$4,$1::text),($2::uuid,$3,$4,$2::text)", [owner, outsider, tenantId, storeId])
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')", [area, tenantId, storeId])
    await admin.query("INSERT INTO mbox.tables(tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,'A1','A1',4)", [tenantId, storeId, area])
    payload = { publicId: `reservation-${randomUUID()}`, mode: 'direct', customerName: '预约顾客', contact: '13800138000', guestCount: 4,
      arrivalAt: new Date(now.getTime() + 2 * 86_400_000).toISOString(), reservationPolicyVersion: 1 }
    const transactions = new ScopedPostgresTransactionRunner(runtime)
    const commands = new NormalizedCommandExecutor(transactions)
    app = Fastify()
    await app.register(publicReservationApiPlugin, {
      transactions, commands, waitlists: new WaitlistCommandService(commands),
      reservationSessions: { issue: async () => { throw new Error('not used') } },
      resolveTrustedScope: () => ({ tenantId, storeId }),
      resolveGuest: () => ({ scope: { tenantId, storeId }, sessionId: 'test-session', customerId: actor,
        actorRef: `reservation-customer:${actor}`, businessDate: '2026-10-05',
        capabilities: ['guest.reservation.read', 'guest.reservation.update', 'guest.waitlist.manage'] }),
      resolveStaff: () => { throw new Error('not used') },
      protectContact: contact => ({ hash: fingerprint(contact), encryptedBase64: Buffer.from(`encrypted-contact:${contact}`).toString('base64'), keyId: 'test', masked: '138****8000' }),
      currentBusinessDate: () => '2026-10-05', now: () => now,
      createPublicId: () => `generated-${++publicIdsGenerated}-${randomUUID()}`,
    })
    await app.ready()
  })

  const create = (key: string, body = payload) => app.inject({ method: 'POST', url: '/public/reservations', headers: { 'idempotency-key': key }, payload: body })
  const mutate = (method: 'PATCH' | 'DELETE', key: string, body?: Record<string, unknown>) => app.inject({ method,
    url: `/public/reservations/${payload.publicId}`, headers: { 'idempotency-key': key }, ...(body ? { payload: body } : {}) })
  const removeReceipt = (operation = 'create', key?: string) => admin.query(`DELETE FROM mbox.idempotency_records
    WHERE tenant_id=$1 AND store_id=$2 AND operation_scope=$3 AND ($4::text IS NULL OR idempotency_key=$4)`,
  [tenantId, storeId, `public.reservation.${operation}`, key ?? null])
  const counts = async () => (await admin.query(`SELECT
    (SELECT count(*)::integer FROM mbox.reservations WHERE tenant_id=$1 AND store_id=$2) AS reservations,
    (SELECT count(*)::integer FROM mbox.audit_events WHERE tenant_id=$1 AND store_id=$2 AND action='reservation.created') AS audits,
    (SELECT count(*)::integer FROM mbox.outbox_messages WHERE tenant_id=$1 AND store_id=$2 AND message_type='reservation.created.v1') AS outbox`, [tenantId, storeId])).rows[0]
  const legacyCreateFingerprint = () => fingerprint({ mode: payload.mode, customerName: payload.customerName, contact: fingerprint(payload.contact),
    guestCount: payload.guestCount, arrivalAt: payload.arrivalAt, note: null, seatPreference: 'no_preference', acknowledgedPolicyVersion: 1, preferredScheduleId: null })
  const downgradeReceipt = (operation: string, key: string, oldFingerprint: string) => admin.query(`UPDATE mbox.idempotency_records
    SET request_sha256=$5,response_snapshot=jsonb_set(response_snapshot,'{result,reservationSnapshot}',(response_snapshot#>'{result,reservationSnapshot}')-'requestFingerprint')
    WHERE tenant_id=$1 AND store_id=$2 AND operation_scope=$3 AND idempotency_key=$4`,
  [tenantId, storeId, `public.reservation.${operation}`, key, hashRequestFingerprint(oldFingerprint)])

  it('keeps generated defaults outside the fingerprint and replays the same result', async () => {
    delete payload.publicId
    const key = randomUUID(), first = await create(key), replay = await create(key)
    expect(first.statusCode, first.body).toBe(201)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().data.publicId).toBe(first.json().data.publicId)
    expect(replay.json().meta.replayed).toBe(true)
    expect(publicIdsGenerated).toBe(1)
    expect(await counts()).toEqual({ reservations: 1, audits: 1, outbox: 1 })
  })

  it.each(['publicId', 'expectedEndAt', 'customer'] as const)('binds %s to the original create receipt', async field => {
    const key = randomUUID(), first = await create(key)
    expect(first.statusCode, first.body).toBe(201)
    const changed = { ...payload }
    if (field === 'publicId') changed.publicId = randomUUID()
    if (field === 'expectedEndAt') changed.expectedEndAt = new Date(Date.parse(payload.arrivalAt) + 3_600_000).toISOString()
    if (field === 'customer') actor = outsider
    const response = await create(key, changed)
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error.code).toBe('IDEMPOTENCY_CONFLICT')
    expect(response.json()).not.toHaveProperty('data')
    expect(await counts()).toEqual({ reservations: 1, audits: 1, outbox: 1 })
  })

  it.each(['expired', 'deleted'] as const)('recovers after the %s receipt before policy, time and capacity checks', async state => {
    const key = randomUUID(), first = await create(key)
    expect(first.statusCode, first.body).toBe(201)
    if (state === 'deleted') await removeReceipt()
    else await admin.query("UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 minute' WHERE tenant_id=$1 AND store_id=$2", [tenantId, storeId])
    await admin.query('UPDATE mbox.public_reservation_policies SET default_duration_minutes=300 WHERE tenant_id=$1 AND store_id=$2', [tenantId, storeId])
    now = new Date(now.getTime() + 4 * 86_400_000)
    const replay = await create(key)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().meta.replayed).toBe(true)
    expect(replay.json().data.publicId).toBe(first.json().data.publicId)
    expect(await counts()).toEqual({ reservations: 1, audits: 1, outbox: 1 })
  })

  it('recovers the latest booking after edits while retaining the original create contract', async () => {
    const key = randomUUID(), first = await create(key)
    expect(first.statusCode, first.body).toBe(201)
    const update = await mutate('PATCH', randomUUID(), { note: '已修改备注', reservationPolicyVersion: 1 })
    expect(update.statusCode, update.body).toBe(200)
    await removeReceipt()
    const changed = await create(key, { ...payload, guestCount: 3 })
    expect(changed.statusCode, changed.body).toBe(409)
    const replay = await create(key)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().data.note).toBe('已修改备注')
    expect(await counts()).toEqual({ reservations: 1, audits: 1, outbox: 1 })
  })

  it('serializes different request keys for one public ID without a second capacity claim', async () => {
    const responses = await Promise.all([create(randomUUID()), create(randomUUID())])
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 201])
    expect(responses[0].json().data.publicId).toBe(responses[1].json().data.publicId)
    expect(await counts()).toEqual({ reservations: 1, audits: 1, outbox: 1 })
    await removeReceipt()
    actor = outsider
    const inaccessible = await create(randomUUID())
    expect(inaccessible.statusCode, inaccessible.body).toBe(404)
    expect(inaccessible.json().error.code).toBe('RESERVATION_NOT_FOUND')
  })

  it('validates omitted legacy fields and ownership before upgrading an old create receipt', async () => {
    payload.expectedEndAt = new Date(Date.parse(payload.arrivalAt) + 2 * 3_600_000).toISOString()
    const key = randomUUID(), first = await create(key)
    expect(first.statusCode, first.body).toBe(201)
    await downgradeReceipt('create', key, legacyCreateFingerprint())
    const changedId = await create(key, { ...payload, publicId: randomUUID() })
    expect(changedId.statusCode, changedId.body).toBe(409)
    const changedEnd = await create(key, { ...payload, expectedEndAt: new Date(Date.parse(payload.arrivalAt) + 3 * 3_600_000).toISOString() })
    expect(changedEnd.statusCode, changedEnd.body).toBe(409)
    actor = outsider
    const foreign = await create(key)
    expect(foreign.statusCode, foreign.body).toBe(404)
    actor = owner
    const replay = await create(key)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().data.publicId).toBe(first.json().data.publicId)
    expect(await counts()).toEqual({ reservations: 1, audits: 1, outbox: 1 })
  })

  it('replays an old server-generated public ID and refuses to guess after its receipt is gone', async () => {
    delete payload.publicId
    const key = randomUUID(), first = await create(key)
    expect(first.statusCode, first.body).toBe(201)
    const publicId = first.json().data.publicId as string
    await downgradeReceipt('create', key, legacyCreateFingerprint())
    await admin.query("UPDATE mbox.reservations SET reservation_snapshot=reservation_snapshot-'requestFingerprint' WHERE tenant_id=$1 AND store_id=$2", [tenantId, storeId])
    const replay = await create(key)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().data.publicId).toBe(publicId)
    expect(publicIdsGenerated).toBe(1)
    await removeReceipt()
    const unbound = await create(randomUUID(), { ...payload, publicId })
    expect(unbound.statusCode, unbound.body).toBe(409)
    expect(await counts()).toEqual({ reservations: 1, audits: 1, outbox: 1 })
  })

  it('returns a cancelled booking after receipt cleanup without reopening capacity', async () => {
    const key = randomUUID(), first = await create(key)
    expect(first.statusCode, first.body).toBe(201)
    const cancelled = await mutate('DELETE', randomUUID())
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    await removeReceipt()
    const replay = await create(key)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().data.status).toBe('cancelled')
    expect(replay.json().meta.replayed).toBe(true)
    expect(await counts()).toEqual({ reservations: 1, audits: 1, outbox: 1 })
  })

  it.each(['PATCH', 'DELETE'] as const)('%s rechecks receipt ownership, including legacy unbound receipts', async method => {
    const first = await create(randomUUID())
    expect(first.statusCode, first.body).toBe(201)
    const key = randomUUID(), body = method === 'PATCH' ? { note: '本人修改', reservationPolicyVersion: 1 } : undefined
    const result = await mutate(method, key, body)
    expect(result.statusCode, result.body).toBe(200)
    const replay = await mutate(method, key, body)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().meta.replayed).toBe(true)
    const legacy = method === 'PATCH'
      ? fingerprint({ publicId: payload.publicId, body, acknowledgedPolicyVersion: 1 })
      : fingerprint({ publicId: payload.publicId })
    await downgradeReceipt(method === 'PATCH' ? 'update' : 'cancel', key, legacy)
    actor = outsider
    const foreign = await mutate(method, key, body)
    expect(foreign.statusCode, foreign.body).toBe(404)
    expect(foreign.json()).not.toHaveProperty('data')
    actor = owner
    const oldReplay = await mutate(method, key, body)
    expect(oldReplay.statusCode, oldReplay.body).toBe(200)
    expect(oldReplay.json().meta.replayed).toBe(true)
  })

  it.each(['new', 'legacy'] as const)('protects %s waitlist receipts from payload changes and another customer', async kind => {
    const key = randomUUID()
    const body = { customerName: '候位顾客', contact: '13800138000', guestCount: 2, desiredArrivalAt: payload.arrivalAt }
    const send = (input = body) => app.inject({ method: 'POST', url: '/public/waitlist', headers: { 'idempotency-key': key }, payload: input })
    const first = await send()
    expect(first.statusCode, first.body).toBe(201)
    if (kind === 'legacy') {
      await admin.query(`UPDATE mbox.idempotency_records SET request_sha256=$4
        WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='waitlist.create' AND idempotency_key=$3`,
      [tenantId, storeId, key, hashRequestFingerprint(fingerprint({ ...body, contact: fingerprint(body.contact), annualPriorityRuleId: null }))])
    }
    const changed = await send({ ...body, guestCount: 3 })
    expect(changed.statusCode, changed.body).toBe(409)
    actor = outsider
    const foreign = await send()
    expect(foreign.statusCode, foreign.body).toBe(kind === 'legacy' ? 404 : 409)
    expect(foreign.json()).not.toHaveProperty('data')
    actor = owner
    const replay = await send()
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().meta.replayed).toBe(true)
    expect(replay.json().data.publicId).toBe(first.json().data.publicId)
    // A stored response never grants read access after ownership changes.
    await admin.query('UPDATE mbox.waitlist_entries SET customer_id=$3 WHERE tenant_id=$1 AND store_id=$2', [tenantId, storeId, outsider])
    const transferred = await send()
    expect(transferred.statusCode, transferred.body).toBe(404)
    const facts = await admin.query('SELECT count(*)::integer AS count FROM mbox.waitlist_entries WHERE tenant_id=$1 AND store_id=$2', [tenantId, storeId])
    expect(facts.rows[0].count).toBe(1)
  })
})
