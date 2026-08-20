import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { ReservationPerformanceNotificationRepository } from './reservation-performance-notification-repository.js'
import { ReservationPerformanceNotificationWorker } from './reservation-performance-notification-worker.js'
import { ReservationPerformanceRevisionRepository } from './reservation-performance-revision-repository.js'
import { ReservationPerformanceRevisionService } from './reservation-performance-revision-service.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = randomUUID()
const storeId = randomUUID()
const otherStoreId = randomUUID()
const employeeId = randomUUID()
const canonicalCustomerId = randomUUID()
const mergedCustomerId = randomUUID()
const outsiderCustomerId = randomUUID()
const performerId = randomUUID()
const alternatePerformerId = randomUUID()
const sourceScheduleId = randomUUID()
const alternateScheduleId = randomUUID()
const concurrentScheduleId = randomUUID()
const reservationId = randomUUID()
const concurrentReservationId = randomUUID()
const policyId = randomUUID()
const suffix = tenantId.replaceAll('-', '').slice(0, 12)

integration('reservation performance revision PostgreSQL integration', () => {
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner
  let service: ReservationPerformanceRevisionService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    runner = new ScopedPostgresTransactionRunner(asPool(pool))
    service = new ReservationPerformanceRevisionService(runner, new NormalizedCommandExecutor(runner))
    await seed(pool)
  })

  afterAll(async () => { await pool?.end() })

  it('requires an exact append-only revision and keeps the affected reservation active', async () => {
    await expect(pool.query(`
      UPDATE mbox.schedules SET status='cancelled'
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [tenantId, storeId, sourceScheduleId])).rejects.toMatchObject({ code: '23514' })

    const result = await service.revise(staffContext, {
      scheduleId: sourceScheduleId,
      kind: 'rescheduled',
      startsAt: '2026-09-10T09:00:00.000Z',
      endsAt: '2026-09-10T12:00:00.000Z',
      replacementScheduleId: null,
      reason: '舞台安排调整，演出提前两小时',
      idempotencyKey: 'performance-revision-reschedule-0001',
    })
    expect(result.replayed).toBe(false)
    expect(result.value).toMatchObject({
      scheduleId: sourceScheduleId,
      revisionNumber: 1,
      affectedReservations: 1,
      resultingScheduleId: sourceScheduleId,
    })

    const replay = await service.revise(staffContext, {
      scheduleId: sourceScheduleId,
      kind: 'rescheduled',
      startsAt: '2026-09-10T09:00:00.000Z',
      endsAt: '2026-09-10T12:00:00.000Z',
      replacementScheduleId: null,
      reason: '舞台安排调整，演出提前两小时',
      idempotencyKey: 'performance-revision-reschedule-0001',
    })
    expect(replay.replayed).toBe(true)

    const state = await pool.query<{
      reservation_status: string
      preferred_schedule_id: string | null
      revisions: string
      impacts: string
      jobs: string
    }>(`
      SELECT
        (SELECT status FROM mbox.reservations WHERE id=$1::uuid) AS reservation_status,
        (SELECT preferred_schedule_id FROM mbox.reservations WHERE id=$1::uuid) AS preferred_schedule_id,
        (SELECT count(*)::text FROM mbox.performance_schedule_revisions
          WHERE tenant_id=$2::uuid AND store_id=$3::uuid AND schedule_id=$4::uuid) AS revisions,
        (SELECT count(*)::text FROM mbox.reservation_performance_impacts
          WHERE tenant_id=$2::uuid AND store_id=$3::uuid AND reservation_id=$1::uuid) AS impacts,
        (SELECT count(*)::text FROM mbox.reservation_performance_notification_jobs
          WHERE tenant_id=$2::uuid AND store_id=$3::uuid AND reservation_id=$1::uuid) AS jobs
    `, [reservationId, tenantId, storeId, sourceScheduleId])
    expect(state.rows[0]).toEqual({
      reservation_status: 'confirmed',
      preferred_schedule_id: sourceScheduleId,
      revisions: '1', impacts: '1', jobs: '1',
    })
  })

  it('allows either customer identity in the canonical family but never another customer', async () => {
    const canonical = await listCustomer(canonicalCustomerId)
    const merged = await listCustomer(mergedCustomerId)
    const outsider = await listCustomer(outsiderCustomerId)
    expect(canonical).toHaveLength(1)
    expect(merged.map((impact) => impact.publicId)).toEqual(canonical.map((impact) => impact.publicId))
    expect(outsider).toEqual([])

    await expect(acknowledge(outsiderCustomerId, canonical[0]!.publicId, 'keep', null, 'outsider-ack-0001'))
      .rejects.toMatchObject({ code: 'RESERVATION_PERFORMANCE_IMPACT_NOT_FOUND', statusCode: 404 })

    const acknowledged = await acknowledge(
      mergedCustomerId, canonical[0]!.publicId, 'reselect', alternateScheduleId, 'family-ack-0001',
    )
    expect(acknowledged.value).toMatchObject({
      reservationStatus: 'confirmed',
      acknowledgement: {
        decision: 'reselect', selectedScheduleId: alternateScheduleId,
        resultingPreferredScheduleId: alternateScheduleId,
      },
    })
    const reservation = await pool.query<{ status: string; preferred_schedule_id: string; aggregate_version: string }>(`
      SELECT status,preferred_schedule_id,aggregate_version::text
      FROM mbox.reservations WHERE id=$1::uuid
    `, [reservationId])
    expect(reservation.rows[0]).toEqual({
      status: 'confirmed', preferred_schedule_id: alternateScheduleId, aggregate_version: '2',
    })
  })

  it('serializes competing acknowledgements and preserves append-only evidence', async () => {
    const revised = await service.revise(staffContext, {
      scheduleId: concurrentScheduleId,
      kind: 'cancelled',
      startsAt: null,
      endsAt: null,
      replacementScheduleId: null,
      reason: '现场设备故障，本场演出取消',
      idempotencyKey: 'performance-revision-cancel-0002',
    })
    const impacts = await listCustomer(canonicalCustomerId)
    const impact = impacts.find((candidate) => candidate.revision.publicId === revised.value.publicId)
    expect(impact).toBeDefined()

    const attempts = await Promise.allSettled([
      acknowledge(canonicalCustomerId, impact!.publicId, 'clear', null, 'concurrent-clear-0001'),
      acknowledge(mergedCustomerId, impact!.publicId, 'keep', null, 'concurrent-keep-0002'),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)

    const stored = await pool.query<{ status: string; preferred_schedule_id: string | null; acknowledgements: string }>(`
      SELECT reservation.status,reservation.preferred_schedule_id,
        (SELECT count(*)::text FROM mbox.reservation_performance_acknowledgements acknowledgement
          WHERE acknowledgement.tenant_id=reservation.tenant_id
            AND acknowledgement.store_id=reservation.store_id
            AND acknowledgement.reservation_id=reservation.id) AS acknowledgements
      FROM mbox.reservations reservation WHERE reservation.id=$1::uuid
    `, [concurrentReservationId])
    expect(stored.rows[0]).toEqual({ status: 'confirmed', preferred_schedule_id: null, acknowledgements: '1' })

    await expect(pool.query(`
      UPDATE mbox.reservation_performance_acknowledgements SET decision='keep'
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND reservation_id=$3::uuid
    `, [tenantId, storeId, concurrentReservationId])).rejects.toMatchObject({ code: '55000' })
  })

  it('binds one-use WeChat authority to the exact reservation, context, policy and template', async () => {
    const jobs = await pool.query<{ authorization_context: string; template_id: string; status: string }>(`
      SELECT authorization_context,template_id,status
      FROM mbox.reservation_performance_notification_jobs
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND reservation_id=$3::uuid
    `, [tenantId, storeId, reservationId])
    expect(jobs.rows).toEqual([{
      authorization_context: 'reservation', template_id: 'reservation-change-template-001', status: 'pending',
    }])

    const options = await run((transaction) => (
      new ReservationPerformanceNotificationRepository(transaction)
        .authorizationOptions(mergedCustomerId, true)
    ))
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ reservationPublicId: 'reservation-revision-main', policyId, usesRemaining: 1 }),
    ]))
    await expect(recordAuthorization({
      customerId: canonicalCustomerId,
      reservationPublicId: 'reservation-revision-main',
      policyVersion: 1,
      templateId: 'wrong-template-identifier',
      expectedVersion: 1,
      platformResult: 'accept',
      platformEventReference: 'wrong-template-event-0001',
    })).rejects.toMatchObject({ code: 'RESERVATION_NOTIFICATION_POLICY_STALE' })
    await expect(pool.query(`
      INSERT INTO mbox.reservation_performance_notification_policies(
        tenant_id,store_id,notification_type,authorization_context,policy_version,status,
        template_id,page_path,change_type_data_key,performance_time_data_key,
        reservation_time_data_key,effective_from,reason,published_at
      ) VALUES(
        $1::uuid,$2::uuid,'reservation_performance_revised','member',2,'published',
        'invalid-context-template','pages/reservations/index','change_type','performance_time',
        'reservation_time',clock_timestamp()-interval '1 day','错误上下文反测试',clock_timestamp()
      )
    `, [tenantId, storeId])).rejects.toMatchObject({ code: '23514' })

    const deliveries: unknown[] = []
    const worker = new ReservationPerformanceNotificationWorker(
      runner,
      { resolveMiniProgramNotificationRecipient: async () => ({
        identityExternalId: 'revision-wechat-identity', openId: 'openid-reservation-owner',
      }) },
      {
        preflight: async () => undefined,
        sendTemplate: async (message) => {
          deliveries.push(message)
          return { outcome: 'accepted' as const, providerReference: 'provider-reservation-reference-001' }
        },
      },
    )
    const first = await worker.runBatch({ tenantId, storeId }, 'reservation-revision-worker-001')
    expect(first).toMatchObject({
      claimed: 2, accepted: [expect.any(String), expect.any(String)], rejected: [], unknown: [], suppressed: 0,
    })
    expect(deliveries).toHaveLength(2)
    expect(deliveries).toEqual(expect.arrayContaining([expect.objectContaining({
      templateId: 'reservation-change-template-001',
      pagePath: 'pages/reservations/index',
    })]))
    const replay = await worker.runBatch({ tenantId, storeId }, 'reservation-revision-worker-002')
    expect(replay).toMatchObject({ claimed: 0, accepted: [], rejected: [], unknown: [] })
    const terminal = await pool.query<{
      status: string
      uses: string
      receipts: string
      raw_provider_reference: string
    }>(`
      SELECT job.status,
        (SELECT count(*)::text FROM mbox.reservation_performance_notification_authorization_uses used
          WHERE used.notification_job_id=job.id) AS uses,
        (SELECT count(*)::text FROM mbox.reservation_performance_notification_receipts receipt
          WHERE receipt.notification_job_id=job.id) AS receipts,
        (SELECT count(*)::text FROM mbox.reservation_performance_notification_receipts receipt
          WHERE receipt.notification_job_id=job.id
            AND receipt.provider_reference_hash='provider-reservation-reference-001') AS raw_provider_reference
      FROM mbox.reservation_performance_notification_jobs job
      WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid AND job.reservation_id=$3::uuid
    `, [tenantId, storeId, reservationId])
    expect(terminal.rows[0]).toEqual({ status: 'sent', uses: '1', receipts: '1', raw_provider_reference: '0' })
  })

  it('keeps strong authority free of JSON and enforces tenant-store RLS', async () => {
    const columns = await pool.query<{ table_name: string; data_type: string }>(`
      SELECT table_name,data_type FROM information_schema.columns
      WHERE table_schema='mbox' AND table_name IN(
        'performance_schedule_revisions','reservation_performance_impacts',
        'reservation_performance_acknowledgements',
        'reservation_performance_notification_policies',
        'reservation_performance_notification_authorizations',
        'reservation_performance_notification_jobs'
      )
    `)
    expect(columns.rows.some((column) => ['json','jsonb'].includes(column.data_type))).toBe(false)
    expect(await runtimeRevisionCount(storeId)).toBe(2)
    expect(await runtimeRevisionCount(otherStoreId)).toBe(0)
  })

  async function listCustomer(customerId: string) {
    return run((transaction) => new ReservationPerformanceRevisionRepository(transaction).listCustomerImpacts(customerId))
  }

  async function acknowledge(
    customerId: string,
    impactPublicId: string,
    decision: 'keep' | 'reselect' | 'clear',
    selectedScheduleId: string | null,
    idempotencyKey: string,
  ) {
    return service.acknowledge({
      scope: { tenantId, storeId }, customerId, actorRef: `guest:${customerId}`, businessDate: '2026-09-10',
    }, { impactPublicId, decision, selectedScheduleId, idempotencyKey })
  }

  async function recordAuthorization(input: {
    customerId: string
    reservationPublicId: string
    policyVersion: number
    templateId: string
    expectedVersion: number
    platformResult: 'accept' | 'reject' | 'ban' | 'revoke'
    platformEventReference: string
  }) {
    return run((transaction) => new ReservationPerformanceNotificationRepository(transaction)
      .recordAuthorization({ ...input, policyId }))
  }

  async function run<Result>(operation: Parameters<ScopedPostgresTransactionRunner['run']>[1]) {
    return runner.run({ tenantId, storeId }, operation) as Promise<Result>
  }

  async function runtimeRevisionCount(scopedStoreId: string): Promise<number> {
    return runner.run({ tenantId, storeId: scopedStoreId }, async (transaction) => {
      await transaction.query('SET LOCAL ROLE mbox_runtime')
      const result = await transaction.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM mbox.performance_schedule_revisions
      `)
      return Number(result.rows[0]?.count ?? -1)
    }, { readOnly: true })
  }
})

const staffContext = {
  scope: { tenantId, storeId }, employeeId, businessDate: '2026-09-10',
}

async function seed(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$2,'Revision Tenant')`, [tenantId, `revision_${suffix}`])
  await pool.query(`
    INSERT INTO mbox.stores(id,tenant_id,code,name,timezone) VALUES
      ($1::uuid,$3::uuid,$4,'Revision Store','Asia/Shanghai'),
      ($2::uuid,$3::uuid,$5,'Revision Other Store','Asia/Shanghai')
  `, [storeId, otherStoreId, tenantId, `revision_store_${suffix}`, `revision_other_${suffix}`])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
    VALUES($1::uuid,$2::uuid,$3::uuid,'PERFORMANCE_MANAGER','演出负责人')
  `, [employeeId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.public_reservation_policies(tenant_id,store_id)
    VALUES($1::uuid,$2::uuid)
  `, [tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status,merged_into_customer_id) VALUES
      ($1::uuid,$4::uuid,$5::uuid,'revision-canonical-customer','active',NULL),
      ($2::uuid,$4::uuid,$5::uuid,'revision-merged-customer','merged',$1::uuid),
      ($3::uuid,$4::uuid,$5::uuid,'revision-outsider-customer','active',NULL)
  `, [canonicalCustomerId, mergedCustomerId, outsiderCustomerId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.performers(id,tenant_id,store_id,code,stage_name) VALUES
      ($1::uuid,$3::uuid,$4::uuid,'REVISION_MAIN','主舞台歌手'),
      ($2::uuid,$3::uuid,$4::uuid,'REVISION_ALT','替代歌手')
  `, [performerId, alternatePerformerId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.schedules(id,tenant_id,store_id,performer_id,starts_at,ends_at,status) VALUES
      ($1::uuid,$5::uuid,$6::uuid,$4::uuid,'2026-09-10T11:00:00Z','2026-09-10T14:00:00Z','scheduled'),
      ($2::uuid,$5::uuid,$6::uuid,$7::uuid,'2026-09-10T13:00:00Z','2026-09-10T15:00:00Z','scheduled'),
      ($3::uuid,$5::uuid,$6::uuid,$4::uuid,'2026-09-11T11:00:00Z','2026-09-11T14:00:00Z','scheduled')
  `, [sourceScheduleId, alternateScheduleId, concurrentScheduleId, performerId, tenantId, storeId, alternatePerformerId])
  await pool.query(`
    INSERT INTO mbox.reservations(
      id,tenant_id,store_id,public_id,customer_id,customer_name,contact_token,
      guest_count,arrival_at,expected_end_at,status,source,preferred_schedule_id
    ) VALUES
      ($1::uuid,$3::uuid,$4::uuid,'reservation-revision-main',$5::uuid,'合并身份顾客','contact-main',
        2,'2026-09-10T12:30:00Z','2026-09-10T16:30:00Z','confirmed','wechat',$6::uuid),
      ($2::uuid,$3::uuid,$4::uuid,'reservation-revision-concurrent',$5::uuid,'并发确认顾客','contact-concurrent',
        2,'2026-09-11T12:30:00Z','2026-09-11T16:30:00Z','confirmed','wechat',$7::uuid)
  `, [reservationId, concurrentReservationId, tenantId, storeId, mergedCustomerId, sourceScheduleId, concurrentScheduleId])
  await pool.query(`
    INSERT INTO mbox.customer_identities(
      tenant_id,store_id,customer_id,identity_kind,identity_hash,status
    ) VALUES(
      $1::uuid,$2::uuid,$3::uuid,'wechat',encode(digest('wechat:revision-principal','sha256'),'hex'),'active'
    )
  `, [tenantId, storeId, canonicalCustomerId])
  await pool.query(`
    INSERT INTO mbox.wechat_identities(
      tenant_id,store_id,external_identity_id,principal_type,principal_id,channel,
      app_id,openid_sha256,openid_ciphertext,openid_key_version,consent_version,
      consented_at,last_authenticated_at
    ) VALUES(
      $1::uuid,$2::uuid,'revision-wechat-identity','guest','revision-principal','mini_program',
      'wx-revision-app',repeat('a',64),decode(repeat('ab',29),'hex'),1,'privacy-v1',
      clock_timestamp()-interval '1 day',clock_timestamp()
    )
  `, [tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.reservation_performance_notification_policies(
      id,tenant_id,store_id,notification_type,authorization_context,policy_version,status,
      template_id,page_path,change_type_data_key,performance_time_data_key,
      reservation_time_data_key,effective_from,reason,published_at
    ) VALUES(
      $1::uuid,$2::uuid,$3::uuid,'reservation_performance_revised','reservation',1,'published',
      'reservation-change-template-001','pages/reservations/index','change_type','performance_time',
      'reservation_time',clock_timestamp()-interval '1 day','预约演出调整专用模板',clock_timestamp()
    )
  `, [policyId, tenantId, storeId])
  const repository = new ReservationPerformanceNotificationRepository({
    scope: { tenantId, storeId },
    query: (sql, values) => pool.query(sql, values as unknown[]),
  })
  await repository.recordAuthorization({
    customerId: canonicalCustomerId,
    reservationPublicId: 'reservation-revision-main',
    policyId,
    policyVersion: 1,
    templateId: 'reservation-change-template-001',
    expectedVersion: 0,
    platformResult: 'accept',
    platformEventReference: 'wechat-accept-event-0001',
  })
  await repository.recordAuthorization({
    customerId: mergedCustomerId,
    reservationPublicId: 'reservation-revision-concurrent',
    policyId,
    policyVersion: 1,
    templateId: 'reservation-change-template-001',
    expectedVersion: 0,
    platformResult: 'accept',
    platformEventReference: 'wechat-accept-event-0002',
  })
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
