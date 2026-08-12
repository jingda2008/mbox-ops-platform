import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { PerformanceCommandService } from './performance-command-service.js'
import { ScheduleRepository } from './schedule-repository.js'
import {
  SongRequestCustomerSessionError,
  SongRequestEligibilityError,
  SongRequestPaymentEvidenceError,
} from './song-request-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = randomUUID()
const storeId = randomUUID()
const areaId = randomUUID()
const tableId = randomUUID()
const tableSessionId = randomUUID()
const employeeId = randomUUID()
const customerId = randomUUID()
const businessDate = '2026-08-11'

integration('PerformanceCommandService PostgreSQL integration', () => {
  let pool: Pool
  let service: PerformanceCommandService
  let runner: ScopedPostgresTransactionRunner
  let performerId: string
  let nextPerformerId: string
  let currentScheduleId: string
  let nextScheduleId: string

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 12 })
    runner = new ScopedPostgresTransactionRunner(asPool(pool))
    service = new PerformanceCommandService(new NormalizedCommandExecutor(runner))
    await seed(pool)
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('creates editable performer profiles and today schedule with idempotent evidence', async () => {
    const create = performerCommand('NATALIE', 'Natalie', 'performer-create-natalie-0001')
    const first = await service.createPerformer(create)
    const replay = await service.createPerformer(create)
    expect(replay).toEqual({ value: first.value, replayed: true })
    performerId = first.value.id

    const next = await service.createPerformer(
      performerCommand('ZHOUCHEN', '周奕辰', 'performer-create-zhouchen-0001'),
    )
    nextPerformerId = next.value.id
    const updated = await service.updatePerformer({
      ...metadata('performer-update-natalie-0001'),
      performerId,
      profileSnapshot: { bio: 'Soul, pop and warm interaction', imageUrl: '/performers/natalie.jpg' },
      songCatalog: [
        { code: 'SONG-HOULAI', title: '后来', aliases: ['Hou Lai'] },
        { code: 'SONG-MOON', title: '月亮代表我的心' },
      ],
    })
    expect(updated.value.songCatalog).toHaveLength(2)

    const current = await service.createSchedule({
      ...metadata('schedule-current-create-0001'),
      performerId,
      startsAt: '2026-08-11T12:30:00.000Z',
      endsAt: '2026-08-11T13:15:00.000Z',
    })
    const following = await service.createSchedule({
      ...metadata('schedule-next-create-0001'),
      performerId: nextPerformerId,
      startsAt: '2026-08-11T13:35:00.000Z',
      endsAt: '2026-08-11T14:20:00.000Z',
    })
    currentScheduleId = current.value.id
    nextScheduleId = following.value.id

    const evidence = await pool.query<{ performers: string; create_audits: string; create_outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.performers WHERE tenant_id = $1 AND store_id = $2) AS performers,
        (SELECT count(*)::text FROM mbox.audit_events WHERE tenant_id = $1 AND store_id = $2 AND action = 'performer.created') AS create_audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE tenant_id = $1 AND store_id = $2 AND message_type = 'performer.created.v1') AS create_outbox
    `, [tenantId, storeId])
    expect(evidence.rows[0]).toEqual({ performers: '2', create_audits: '2', create_outbox: '2' })
  })

  it('uses Asia/Shanghai for today and exposes current remaining time plus next performer', async () => {
    const view = await runner.run({ tenantId, storeId }, (transaction) => (
      new ScheduleRepository(transaction).getDailyView(businessDate, '2026-08-11T13:00:00.000Z')
    ), { readOnly: true })
    expect(view).toMatchObject({
      timezone: 'Asia/Shanghai',
      localDate: '2026-08-11',
      phase: 'live',
      current: { id: currentScheduleId, performerStageName: 'Natalie' },
      next: { id: nextScheduleId, performerStageName: '周奕辰' },
      remainingSeconds: 900,
      startsInSeconds: 2100,
    })
  })

  it('submits a near-end extension once and preserves audit/outbox atomically', async () => {
    const input = {
      ...metadata('song-extension-submit-0001', { type: 'guest' as const, ref: 'table-guest' }),
      tableSessionId,
      customerId,
      scheduleId: currentScheduleId,
      songTitle: 'hou lai',
      requestType: 'catalog' as const,
      requestedAt: '2026-08-11T13:14:30.000Z',
      requestExtension: true,
    }
    const first = await service.submitSongRequest(input)
    const replay = await service.submitSongRequest(input)
    expect(replay).toEqual({ value: first.value, replayed: true })
    expect(first.value).toMatchObject({
      slot: 'current',
      extensionRequested: true,
      request: { songTitle: '后来', status: 'confirming' },
    })

    const evidence = await pool.query<{ requests: string; audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.song_requests WHERE id = $1) AS requests,
        (SELECT count(*)::text FROM mbox.audit_events WHERE object_id = $1::text AND action = 'song_request.extension_requested') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE aggregate_id = $1 AND message_type = 'song_request.extension_requested.v1') AS outbox
    `, [first.value.request.id])
    expect(evidence.rows[0]).toEqual({ requests: '1', audits: '1', outbox: '1' })
  })

  it('allows a custom request for the next performer and rejects any other schedule', async () => {
    const custom = await service.submitSongRequest({
      ...metadata('song-custom-next-submit-0001', { type: 'guest' as const }),
      tableSessionId,
      customerId,
      scheduleId: nextScheduleId,
      songTitle: '给朋友的一首歌',
      requestType: 'custom',
      requestedAt: '2026-08-11T13:00:00.000Z',
    })
    expect(custom.value).toMatchObject({ slot: 'next', request: { status: 'confirming', requestType: 'custom' } })

    const tomorrow = await service.createSchedule({
      ...metadata('schedule-tomorrow-create-0001'),
      performerId,
      startsAt: '2026-08-12T12:30:00.000Z',
      endsAt: '2026-08-12T13:15:00.000Z',
    })
    await expect(service.submitSongRequest({
      ...metadata('song-tomorrow-rejected-0001', { type: 'guest' as const }),
      tableSessionId,
      customerId,
      scheduleId: tomorrow.value.id,
      songTitle: '后来',
      requestType: 'catalog',
      requestedAt: '2026-08-11T13:00:00.000Z',
    })).rejects.toBeInstanceOf(SongRequestEligibilityError)
  })

  it('serializes concurrent employee confirmations and emits one accepted event', async () => {
    const submitted = await service.submitSongRequest({
      ...metadata('song-confirm-race-submit-0001', { type: 'guest' as const }),
      tableSessionId,
      customerId,
      scheduleId: currentScheduleId,
      songTitle: '后来',
      requestType: 'catalog',
      requestedAt: '2026-08-11T13:00:00.000Z',
    })
    const confirm = (idempotencyKey: string) => service.confirmSongRequest({
      ...metadata(idempotencyKey, { type: 'employee' as const, employeeId }),
      requestId: submitted.value.request.id,
      actorEmployeeId: employeeId,
      quotedAmountMinor: 20000,
      currency: 'CNY',
    })
    const [first, second] = await Promise.all([
      confirm('song-confirm-race-a-0001'),
      confirm('song-confirm-race-b-0001'),
    ])
    expect(first.value.status).toBe('accepted')
    expect(second.value.status).toBe('accepted')

    const evidence = await pool.query<{ audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.audit_events WHERE object_id = $1::text AND action = 'song_request.accepted') AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE aggregate_id = $1::uuid AND message_type = 'song_request.accepted.v1') AS outbox
    `, [submitted.value.request.id])
    expect(evidence.rows[0]).toEqual({ audits: '1', outbox: '1' })
  })

  it('uses the supplied business day across midnight until the 06:00 cutoff', async () => {
    const latePerformer = await service.createPerformer(
      performerCommand('MIDNIGHT', '午夜歌手', 'performer-create-midnight-0001'),
    )
    const late = await service.createSchedule({
      ...metadata('schedule-after-midnight-create-0001'),
      performerId: latePerformer.value.id,
      startsAt: '2026-08-11T16:30:00.000Z',
      endsAt: '2026-08-11T17:30:00.000Z',
    })
    const view = await runner.run({ tenantId, storeId }, (transaction) => (
      new ScheduleRepository(transaction).getDailyView(businessDate, '2026-08-11T17:00:00.000Z')
    ), { readOnly: true })

    expect(view).toMatchObject({
      localDate: businessDate,
      phase: 'live',
      current: { id: late.value.id, performerStageName: '午夜歌手' },
      remainingSeconds: 1800,
    })
  })

  it('requires the authenticated customer to belong to the open table session', async () => {
    await expect(service.submitSongRequest({
      ...metadata('song-customer-mismatch-0001', { type: 'guest' as const }),
      tableSessionId,
      customerId: randomUUID(),
      scheduleId: currentScheduleId,
      songTitle: '后来',
      requestType: 'catalog',
      requestedAt: '2026-08-11T13:00:00.000Z',
    })).rejects.toBeInstanceOf(SongRequestCustomerSessionError)
  })

  it('marks a song paid only with matching payment and reconciliation evidence', async () => {
    const submitted = await service.submitSongRequest({
      ...metadata('song-paid-submit-0001', { type: 'guest' as const }),
      tableSessionId,
      customerId,
      scheduleId: nextScheduleId,
      songTitle: '后来',
      requestType: 'catalog',
      requestedAt: '2026-08-11T13:00:00.000Z',
    })
    await service.confirmSongRequest({
      ...metadata('song-paid-confirm-0001'),
      requestId: submitted.value.request.id,
      actorEmployeeId: employeeId,
      quotedAmountMinor: 20000,
      currency: 'CNY',
    })
    const evidence = await seedPaymentEvidence(pool, 20000)

    await expect(service.markSongRequestPaid({
      ...metadata('song-paid-invalid-evidence-0001'),
      requestId: submitted.value.request.id,
      actorEmployeeId: employeeId,
      paymentId: evidence.paymentId,
      reconciliationEntryId: randomUUID(),
    })).rejects.toBeInstanceOf(SongRequestPaymentEvidenceError)

    const paid = await service.markSongRequestPaid({
      ...metadata('song-paid-valid-evidence-0001'),
      requestId: submitted.value.request.id,
      actorEmployeeId: employeeId,
      paymentId: evidence.paymentId,
      reconciliationEntryId: evidence.reconciliationEntryId,
    })
    expect(paid.value.status).toBe('paid')
    const stored = await pool.query<{ evidence_count: string; paid_events: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.song_request_payment_evidence
          WHERE song_request_id = $1::uuid) AS evidence_count,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE aggregate_id = $1::uuid AND message_type = 'song_request.paid.v1') AS paid_events
    `, [submitted.value.request.id])
    expect(stored.rows[0]).toEqual({ evidence_count: '1', paid_events: '1' })
  })
})

function metadata(idempotencyKey: string, actor = { type: 'employee' as const, employeeId }) {
  return {
    scope: { tenantId, storeId },
    actor,
    businessDate,
    idempotencyKey,
    requestFingerprint: JSON.stringify({ idempotencyKey }),
  }
}

function performerCommand(code: string, stageName: string, idempotencyKey: string) {
  return {
    ...metadata(idempotencyKey),
    code,
    stageName,
    profileSnapshot: { bio: `${stageName} profile` },
    songCatalog: [{ code: `${code}-SONG-1`, title: '后来', aliases: ['Hou Lai'] }],
  }
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}

async function seed(pool: Pool): Promise<void> {
  const suffix = tenantId.slice(0, 8)
  await pool.query(`INSERT INTO mbox.tenants(id, code, name) VALUES ($1, $2, 'Performance Tenant')`, [tenantId, `performance-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.stores(id, tenant_id, code, name, timezone)
    VALUES ($1, $2, $3, 'M-BOX Performance Store', 'Asia/Shanghai')
  `, [storeId, tenantId, `performance-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type)
    VALUES ($1, $2, $3, 'PERFORMANCE', 'Performance Area', 'stage')
  `, [areaId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity)
    VALUES ($1, $2, $3, $4, 'L01', 'L01', 4)
  `, [tableId, tenantId, storeId, areaId])
  await pool.query(`
    INSERT INTO mbox.table_sessions(
      id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status
    ) VALUES ($1, $2, $3, $4, 'performance-session-l01', $5, 2, 'open')
  `, [tableSessionId, tenantId, storeId, tableId, businessDate])
  await pool.query(`
    INSERT INTO mbox.customers(id, tenant_id, store_id, public_id, status)
    VALUES ($1, $2, $3, $4, 'active')
  `, [customerId, tenantId, storeId, `performance-customer-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.customer_identities(
      tenant_id, store_id, customer_id, identity_kind, identity_hash
    ) VALUES ($1, $2, $3, 'anonymous', $4)
  `, [tenantId, storeId, customerId, 'a'.repeat(64)])
  await pool.query(`
    INSERT INTO mbox.table_session_customers(
      tenant_id, store_id, table_session_id, customer_id, relationship
    ) VALUES ($1, $2, $3, $4, 'primary')
  `, [tenantId, storeId, tableSessionId, customerId])
  await pool.query(`
    INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name, status)
    VALUES ($1, $2, $3, 'PERF01', 'Performance Manager', 'active')
  `, [employeeId, tenantId, storeId])
}

async function seedPaymentEvidence(pool: Pool, amountMinor: number) {
  const orderId = randomUUID()
  const paymentId = randomUUID()
  const reconciliationEntryId = randomUUID()
  await pool.query(`
    INSERT INTO mbox.orders(
      id, tenant_id, store_id, table_session_id, public_id, channel, status,
      payment_status, subtotal_amount_minor, discount_amount_minor, total_amount_minor, currency
    ) VALUES ($1, $2, $3, $4, $5, 'cashier', 'confirmed', 'paid', $6, 0, $6, 'CNY')
  `, [orderId, tenantId, storeId, tableSessionId, `song-order-${orderId}`, amountMinor])
  await pool.query(`
    INSERT INTO mbox.payments(
      id, tenant_id, store_id, order_id, public_id, provider, provider_transaction_id,
      method, amount_minor, currency, status, succeeded_at
    ) VALUES ($1, $2, $3, $4, $5, 'simulation', $6, 'native_qr', $7, 'CNY', 'succeeded', clock_timestamp())
  `, [
    paymentId,
    tenantId,
    storeId,
    orderId,
    `song-payment-${paymentId}`,
    `simulation-song-${paymentId}`,
    amountMinor,
  ])
  await pool.query(`
    INSERT INTO mbox.reconciliation_entries(
      id, tenant_id, store_id, payment_id, entry_type, provider, provider_reference,
      amount_minor, currency, business_date, occurred_at
    ) VALUES ($1, $2, $3, $4, 'payment', 'simulation', $5, $6, 'CNY', $7, clock_timestamp())
  `, [
    reconciliationEntryId,
    tenantId,
    storeId,
    paymentId,
    `song-reconciliation-${reconciliationEntryId}`,
    amountMinor,
    businessDate,
  ])
  return { paymentId, reconciliationEntryId }
}
