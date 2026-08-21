import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { BenefitCommandService } from './benefit-repository.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { CustomerCommandService } from './customer-repository.js'
import { ReservationCommandService } from './reservation-command-service.js'
import {
  ReservationCancellationPolicyError,
  ReservationConflictError,
  ReservationTransitionError,
} from './reservation-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

integration('normalized reservation, customer and benefit transactions', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const areaId = randomUUID()
  const tableOneId = randomUUID()
  const tableTwoId = randomUUID()
  const tableThreeId = randomUUID()
  const tableFourId = randomUUID()
  const paymentTableSessionId = randomUUID()
  const benefitProductId = randomUUID()
  const reservationWindow = nextShanghaiCrossMidnightWindow()
  let nativePool: Pool
  let commands: NormalizedCommandExecutor
  let reservations: ReservationCommandService
  let customers: CustomerCommandService
  let benefits: BenefitCommandService

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    nativePool = new Pool({ connectionString: databaseUrl, max: 8 })
    commands = new NormalizedCommandExecutor(new ScopedPostgresTransactionRunner(asPool(nativePool)))
    reservations = new ReservationCommandService(commands)
    customers = new CustomerCommandService(commands)
    benefits = new BenefitCommandService(commands, {
      createGiftOrder: async (_transaction, input) => ({
        reference: `gift-order:${input.benefitReservationId}`,
      }),
    })
    await nativePool.query(`
      INSERT INTO mbox.tenants (id, code, name)
      VALUES ($1::uuid, $2, 'Reservation Test Tenant')
    `, [tenantId, `reservation-${tenantId.slice(0, 8)}`])
    await nativePool.query(`
      INSERT INTO mbox.stores (id, tenant_id, code, name)
      VALUES ($1::uuid, $2::uuid, $3, 'Reservation Test Store')
    `, [storeId, tenantId, `store-${storeId.slice(0, 8)}`])
    await nativePool.query(`
      INSERT INTO mbox.products (
        id, tenant_id, store_id, code, name, category_code, fulfillment_station
      ) VALUES ($1, $2, $3, 'RESERVATION-GIFT', 'Reservation Gift Product', 'drink', 'bar')
    `, [benefitProductId, tenantId, storeId])
    await nativePool.query(`
      INSERT INTO mbox.public_reservation_policies (
        tenant_id, store_id, hold_minutes, arrival_grace_minutes
      ) VALUES ($1::uuid, $2::uuid, 20, 10)
    `, [tenantId, storeId])
    await nativePool.query(`
      INSERT INTO mbox.areas (id, tenant_id, store_id, code, name, area_type)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'RESERVE', 'Reservation Area', 'indoor')
    `, [areaId, tenantId, storeId])
    await nativePool.query(`
      INSERT INTO mbox.tables (id, tenant_id, store_id, area_id, code, display_name, capacity)
      VALUES
        ($1::uuid, $5::uuid, $6::uuid, $7::uuid, 'R01', 'Reservation 01', 4),
        ($2::uuid, $5::uuid, $6::uuid, $7::uuid, 'R02', 'Reservation 02', 4),
        ($3::uuid, $5::uuid, $6::uuid, $7::uuid, 'R03', 'Reservation 03', 4),
        ($4::uuid, $5::uuid, $6::uuid, $7::uuid, 'R04', 'Reservation 04', 4)
    `, [tableOneId, tableTwoId, tableThreeId, tableFourId, tenantId, storeId, areaId])
    await nativePool.query(`
      INSERT INTO mbox.table_sessions(
        id, tenant_id, store_id, table_id, public_id, business_date, guest_count, status
      ) VALUES ($1, $2, $3, $4, $5, '2026-08-11', 2, 'open')
    `, [
      paymentTableSessionId,
      tenantId,
      storeId,
      tableOneId,
      `reservation-payment-session-${paymentTableSessionId}`,
    ])
  })

  afterAll(async () => {
    await nativePool?.end()
  })

  it('allows only one overlapping cross-midnight reservation and rolls back the loser', async () => {
    const create = (suffix: string) => reservations.create({
      scope: { tenantId, storeId },
      actor: { type: 'guest', ref: `guest-${suffix}` },
      businessDate: '2026-08-11',
      publicId: `reservation-cross-midnight-${suffix}`,
      customerName: `Guest ${suffix}`,
      contactToken: `contact-${suffix}`,
      guestCount: 2,
      arrivalAt: reservationWindow.arrivalAt,
      expectedEndAt: reservationWindow.expectedEndAt,
      source: 'wechat',
      tableIds: [tableOneId],
      holdExpiresAt: reservationWindow.holdExpiresAt,
      anonymousCustomer: {
        publicId: `anonymous-cross-midnight-${suffix}`,
        identityHash: suffix.repeat(64),
        profile: { displayName: `Guest ${suffix}`, tags: ['new'], preferences: { scene: 'friends' } },
      },
      idempotencyKey: `reservation-cross-midnight-${suffix}-key`,
      requestFingerprint: JSON.stringify({ tableOneId, suffix }),
    })

    const outcomes = await Promise.allSettled([create('a'), create('b')])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected' })
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(ReservationConflictError)

    const evidence = await nativePool.query<{
      reservations: string
      locks: string
      customers: string
      audits: string
      outbox: string
      idempotency: string
      leakedContact: boolean
    }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.reservations WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS reservations,
        (SELECT count(*)::text FROM mbox.reservation_table_locks WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS locks,
        (SELECT count(*)::text FROM mbox.customers WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS customers,
        (SELECT count(*)::text FROM mbox.audit_events WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS outbox,
        (SELECT count(*)::text FROM mbox.idempotency_records WHERE tenant_id = $1::uuid AND store_id = $2::uuid) AS idempotency,
        EXISTS (
          SELECT 1 FROM mbox.outbox_messages
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND message_type = 'reservation.created.v1'
            AND payload ? 'contactToken'
        ) AS "leakedContact"
    `, [tenantId, storeId])
    expect(evidence.rows[0]).toEqual({
      reservations: '1',
      locks: '1',
      customers: '1',
      audits: '2',
      outbox: '2',
      idempotency: '1',
      leakedContact: false,
    })
  })

  it('cancels and releases the lock so the same table can be booked again', async () => {
    const current = await nativePool.query<{ id: string }>(`
      SELECT id FROM mbox.reservations
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      ORDER BY created_at LIMIT 1
    `, [tenantId, storeId])
    const reservationId = current.rows[0]!.id
    const cancelled = await reservations.cancel({
      scope: { tenantId, storeId },
      actor: { type: 'system', ref: 'test' },
      businessDate: '2026-08-11',
      reservationId,
      reason: 'customer cancelled',
      idempotencyKey: 'reservation-cancel-release-key-0001',
      requestFingerprint: JSON.stringify({ reservationId, action: 'cancel' }),
    })
    expect(cancelled.value.status).toBe('cancelled')
    expect(cancelled.value.tableLocks.map((lock) => lock.status)).toEqual(['cancelled'])

    const replacement = await reservations.create({
      scope: { tenantId, storeId },
      actor: { type: 'system', ref: 'test' },
      businessDate: '2026-08-11',
      publicId: 'reservation-after-cancel-release',
      customerName: 'Replacement Guest',
      contactToken: 'replacement-contact',
      guestCount: 2,
      arrivalAt: new Date(Date.parse(reservationWindow.arrivalAt) + 15 * 60_000).toISOString(),
      expectedEndAt: new Date(Date.parse(reservationWindow.expectedEndAt) - 30 * 60_000).toISOString(),
      source: 'phone',
      tableIds: [tableOneId],
      initialStatus: 'confirmed',
      idempotencyKey: 'reservation-after-cancel-key-0001',
      requestFingerprint: JSON.stringify({ tableOneId, action: 'replace' }),
    })
    expect(replacement.value.tableLocks[0]?.status).toBe('confirmed')
  })

  it('marks a held table confirmed when the guest arrives', async () => {
    const now = Date.now()
    const created = await reservations.create({
      scope: { tenantId, storeId },
      actor: { type: 'guest', ref: 'arrival-test' },
      businessDate: '2026-08-11',
      publicId: 'reservation-arrival-lock-update',
      customerName: 'Arrival Guest',
      contactToken: 'arrival-contact',
      guestCount: 2,
      arrivalAt: new Date(now + 30 * 60_000).toISOString(),
      expectedEndAt: new Date(now + 150 * 60_000).toISOString(),
      source: 'wechat',
      tableIds: [tableTwoId],
      holdExpiresAt: new Date(now + 20 * 60_000).toISOString(),
      idempotencyKey: 'reservation-arrival-create-key-0001',
      requestFingerprint: JSON.stringify({ tableTwoId, action: 'create' }),
    })
    const arrived = await reservations.arrive({
      scope: { tenantId, storeId },
      actor: { type: 'employee', employeeId: await seedEmployee(nativePool, tenantId, storeId) },
      businessDate: '2026-08-11',
      reservationId: created.value.id,
      idempotencyKey: 'reservation-arrival-update-key-0001',
      requestFingerprint: JSON.stringify({ reservationId: created.value.id, action: 'arrive' }),
    })
    expect(arrived.value.status).toBe('arrived')
    expect(arrived.value.tableLocks[0]).toMatchObject({ status: 'confirmed', holdExpiresAt: null })
  })

  it('archives an arrived reservation exactly once, releases its table, and rejects a premature completion', async () => {
    const now = Date.now()
    const employeeId = await seedEmployee(nativePool, tenantId, storeId)
    const created = await reservations.create({
      scope: { tenantId, storeId },
      actor: { type: 'guest', ref: 'completion-test' },
      businessDate: '2026-08-11',
      publicId: 'reservation-completion-release',
      customerName: 'Completion Guest',
      contactToken: 'completion-contact',
      guestCount: 2,
      arrivalAt: new Date(now + 30 * 60_000).toISOString(),
      expectedEndAt: new Date(now + 150 * 60_000).toISOString(),
      source: 'wechat',
      tableIds: [tableThreeId],
      holdExpiresAt: new Date(now + 20 * 60_000).toISOString(),
      idempotencyKey: 'reservation-completion-create-key-0001',
      requestFingerprint: JSON.stringify({ tableThreeId, action: 'create-completion' }),
    })

    await expect(reservations.complete({
      scope: { tenantId, storeId },
      actor: { type: 'employee', employeeId },
      businessDate: '2026-08-12',
      reservationId: created.value.id,
      reason: '不能在客人到店前归档',
      idempotencyKey: 'reservation-completion-premature-key-0001',
      requestFingerprint: JSON.stringify({ reservationId: created.value.id, action: 'complete-premature' }),
    })).rejects.toBeInstanceOf(ReservationTransitionError)

    await reservations.arrive({
      scope: { tenantId, storeId },
      actor: { type: 'employee', employeeId },
      businessDate: '2026-08-11',
      reservationId: created.value.id,
      idempotencyKey: 'reservation-completion-arrive-key-0001',
      requestFingerprint: JSON.stringify({ reservationId: created.value.id, action: 'arrive' }),
    })

    const outcomes = await Promise.all([
      reservations.complete({
        scope: { tenantId, storeId },
        actor: { type: 'employee', employeeId },
        businessDate: '2026-08-12',
        reservationId: created.value.id,
        reason: '跨营业日人工完成接待',
        idempotencyKey: 'reservation-completion-concurrent-key-0001',
        requestFingerprint: JSON.stringify({ reservationId: created.value.id, action: 'complete', request: 1 }),
      }),
      reservations.complete({
        scope: { tenantId, storeId },
        actor: { type: 'employee', employeeId },
        businessDate: '2026-08-12',
        reservationId: created.value.id,
        reason: '跨营业日人工完成接待',
        idempotencyKey: 'reservation-completion-concurrent-key-0002',
        requestFingerprint: JSON.stringify({ reservationId: created.value.id, action: 'complete', request: 2 }),
      }),
    ])
    expect(outcomes.map((outcome) => outcome.value.status)).toEqual(['completed', 'completed'])

    const evidence = await nativePool.query<{
      lock_status: string
      completed_audits: string
      completed_outbox: string
    }>(`
      SELECT
        (SELECT status FROM mbox.reservation_table_locks
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND reservation_id=$3::uuid) AS lock_status,
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND object_id=$3::text
            AND action='reservation.completed') AS completed_audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND aggregate_id=$3::uuid
            AND message_type='reservation.completed.v1') AS completed_outbox
    `, [tenantId, storeId, created.value.id])
    expect(evidence.rows[0]).toEqual({ lock_status: 'released', completed_audits: '1', completed_outbox: '1' })

    const replacement = await reservations.create({
      scope: { tenantId, storeId },
      actor: { type: 'system', ref: 'completion-release-check' },
      businessDate: '2026-08-12',
      publicId: 'reservation-after-completion-release',
      customerName: 'Replacement Completion Guest',
      contactToken: 'replacement-completion-contact',
      guestCount: 2,
      arrivalAt: new Date(now + 45 * 60_000).toISOString(),
      expectedEndAt: new Date(now + 120 * 60_000).toISOString(),
      source: 'phone',
      tableIds: [tableThreeId],
      initialStatus: 'confirmed',
      idempotencyKey: 'reservation-after-completion-key-0001',
      requestFingerprint: JSON.stringify({ tableThreeId, action: 'replacement-after-complete' }),
    })
    expect(replacement.value.status).toBe('confirmed')
  })

  it('increments aggregate version under the row lock and uses it for every outbox event', async () => {
    const now = Date.now()
    const created = await reservations.create({
      scope: { tenantId, storeId },
      actor: { type: 'guest', ref: 'version-test' },
      businessDate: '2026-08-11',
      publicId: 'reservation-version-monotonic',
      customerName: 'Version Guest',
      contactToken: 'version-private-contact',
      guestCount: 2,
      arrivalAt: new Date(now + 180 * 60_000).toISOString(),
      expectedEndAt: new Date(now + 300 * 60_000).toISOString(),
      source: 'wechat',
      note: 'private note',
      reservationSnapshot: { privatePreference: 'hidden' },
      tableIds: [tableThreeId],
      holdExpiresAt: new Date(now + 20 * 60_000).toISOString(),
      idempotencyKey: 'reservation-version-create-0001',
      requestFingerprint: 'reservation-version-create-fingerprint',
    })
    const confirmed = await reservations.confirm({
      scope: { tenantId, storeId },
      actor: { type: 'system', ref: 'version-test' },
      businessDate: '2026-08-11',
      reservationId: created.value.id,
      idempotencyKey: 'reservation-version-confirm-0001',
      requestFingerprint: 'reservation-version-confirm-fingerprint',
    })
    const cancelled = await reservations.cancel({
      scope: { tenantId, storeId },
      actor: { type: 'system', ref: 'version-test' },
      businessDate: '2026-08-11',
      reservationId: created.value.id,
      reason: 'version sequence complete',
      idempotencyKey: 'reservation-version-cancel-0001',
      requestFingerprint: 'reservation-version-cancel-fingerprint',
    })

    expect([created.value.aggregateVersion, confirmed.value.aggregateVersion, cancelled.value.aggregateVersion])
      .toEqual([1, 2, 3])
    const evidence = await nativePool.query<{
      versions: string[]
      leaked_private_data: boolean
    }>(`
      SELECT
        array_agg(aggregate_version::text ORDER BY aggregate_version) AS versions,
        bool_or(
          payload ?| ARRAY[
            'customerId', 'customerName', 'contactToken', 'ownerEmployeeId', 'note',
            'reservationSnapshot', 'cancellationPolicySnapshot', 'tableLocks'
          ]
        ) AS leaked_private_data
      FROM mbox.outbox_messages
      WHERE aggregate_type = 'reservation' AND aggregate_id = $1::uuid
    `, [created.value.id])
    expect(evidence.rows[0]).toEqual({ versions: ['1', '2', '3'], leaked_private_data: false })
  })

  it('blocks customer cancellation for a paid deposit and allows an audited staff exception', async () => {
    const employeeId = await seedEmployee(nativePool, tenantId, storeId)
    const now = Date.now()
    const created = await reservations.create({
      scope: { tenantId, storeId },
      actor: { type: 'employee', employeeId },
      businessDate: '2026-08-11',
      publicId: 'reservation-paid-deposit-policy',
      customerName: 'Deposit Guest',
      contactToken: 'deposit-contact',
      guestCount: 4,
      arrivalAt: new Date(now + 360 * 60_000).toISOString(),
      expectedEndAt: new Date(now + 540 * 60_000).toISOString(),
      source: 'phone',
      tableIds: [tableFourId],
      initialStatus: 'confirmed',
      customerCancelUntil: new Date(now + 180 * 60_000).toISOString(),
      cancellationPolicySnapshot: { paidDepositRequiresStaffException: true },
      idempotencyKey: 'reservation-deposit-create-0001',
      requestFingerprint: 'reservation-deposit-create-fingerprint',
    })
    const paymentId = await seedReservationDeposit(
      nativePool,
      tenantId,
      storeId,
      paymentTableSessionId,
      created.value.id,
      employeeId,
    )

    await expect(reservations.cancel({
      scope: { tenantId, storeId },
      actor: { type: 'guest', ref: 'deposit-guest' },
      businessDate: '2026-08-11',
      reservationId: created.value.id,
      reason: 'customer self cancellation',
      idempotencyKey: 'reservation-deposit-cancel-denied-0001',
      requestFingerprint: 'reservation-deposit-cancel-denied-fingerprint',
    })).rejects.toMatchObject<Partial<ReservationCancellationPolicyError>>({
      name: 'ReservationCancellationPolicyError',
      reason: 'paid_deposit',
    })

    const exception = await reservations.cancel({
      scope: { tenantId, storeId },
      actor: { type: 'employee', employeeId },
      businessDate: '2026-08-11',
      reservationId: created.value.id,
      reason: '经理核对定金后例外取消',
      overridePolicy: true,
      idempotencyKey: 'reservation-deposit-cancel-override-0001',
      requestFingerprint: 'reservation-deposit-cancel-override-fingerprint',
    })
    expect(exception.value).toMatchObject({ status: 'cancelled', aggregateVersion: 2 })
    const link = await nativePool.query<{
      payment_id: string
      reason: string
      policy_override: boolean
    }>(`
      SELECT reservation_payment.payment_id, audit.reason,
        (audit.after_snapshot->>'policyOverride')::boolean AS policy_override
      FROM mbox.reservation_payments AS reservation_payment
      JOIN mbox.audit_events AS audit
        ON audit.tenant_id = reservation_payment.tenant_id
        AND audit.store_id = reservation_payment.store_id
        AND audit.object_id = reservation_payment.reservation_id::text
        AND audit.action = 'reservation.cancelled'
      WHERE reservation_payment.reservation_id = $1::uuid
    `, [created.value.id])
    expect(link.rows[0]).toEqual({
      payment_id: paymentId,
      reason: '经理核对定金后例外取消',
      policy_override: true,
    })
  })

  it('merges anonymous customers idempotently without rewriting prior behavior ownership', async () => {
    const source = await customers.createAnonymous(customerCreate('source', 'c'))
    const target = await customers.createAnonymous(customerCreate('target', 'd'))
    const oldBenefit = await benefits.issue(benefitIssue(source.value.customer.id, 'before-merge'))

    const mergeCommand = {
      scope: { tenantId, storeId },
      actor: { type: 'system' as const, ref: 'identity-link' },
      businessDate: '2026-08-11',
      sourceCustomerId: source.value.customer.id,
      targetCustomerId: target.value.customer.id,
      reason: 'same guest linked accounts',
      idempotencyKey: 'customer-merge-idempotent-key-0001',
      requestFingerprint: JSON.stringify({ source: source.value.customer.id, target: target.value.customer.id }),
    }
    const first = await customers.merge(mergeCommand)
    const replay = await customers.merge(mergeCommand)
    expect(first.value.id).toBe(target.value.customer.id)
    expect(replay).toMatchObject({ replayed: true })

    const newBenefit = await benefits.issue(benefitIssue(source.value.customer.id, 'after-merge'))
    expect(oldBenefit.value.customerId).toBe(source.value.customer.id)
    expect(newBenefit.value.customerId).toBe(target.value.customer.id)
    const sourceRow = await nativePool.query<{ status: string; merged_into_customer_id: string }>(`
      SELECT status, merged_into_customer_id
      FROM mbox.customers WHERE id = $1::uuid
    `, [source.value.customer.id])
    expect(sourceRow.rows[0]).toEqual({ status: 'merged', merged_into_customer_id: target.value.customer.id })
    expect(first.value.profile).toMatchObject({
      displayName: 'Guest target',
      tags: ['source', 'target', 'test'],
      preferences: { drinkStyle: 'target' },
    })
    expect(first.value.profile).not.toHaveProperty('consentSnapshot')
  })

  it('redeems a benefit once, replays duplicates, retains authorization, and rolls back audit failure', async () => {
    const customer = await customers.createAnonymous(customerCreate('redeem', 'e'))
    const issued = await benefits.issue(benefitIssue(customer.value.customer.id, 'redeem-once'))
    await nativePool.query(`
      INSERT INTO mbox.table_session_customers(
        tenant_id, store_id, table_session_id, customer_id, relationship
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'primary')
      ON CONFLICT (tenant_id, store_id, table_session_id, customer_id) DO NOTHING
    `, [tenantId, storeId, paymentTableSessionId, customer.value.customer.id])
    const reserved = await benefits.reserve({
      scope: { tenantId, storeId },
      actor: { type: 'system', ref: 'cashier-test' },
      businessDate: '2026-08-11',
      benefitId: issued.value.id,
      customerId: customer.value.customer.id,
      tableSessionId: paymentTableSessionId,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      reservationIdempotencyKey: 'benefit-reservation-once-0001',
      reservationFingerprint: 'benefit-reservation-fingerprint-1',
    })
    const redeemCommand = {
      scope: { tenantId, storeId },
      actor: { type: 'system' as const, ref: 'cashier-test' },
      businessDate: '2026-08-11',
      benefitId: issued.value.id,
      benefitReservationId: reserved.value.id,
      customerId: customer.value.customer.id,
      tableSessionId: paymentTableSessionId,
      authorizationSource: { kind: 'role', role: 'cashier', policy: 'benefit.redeem' },
      redemptionIdempotencyKey: 'benefit-redemption-once-0001',
      redemptionFingerprint: 'redeem-fingerprint-1',
    }
    const redeemed = await benefits.redeem(redeemCommand)
    const replay = await benefits.redeem(redeemCommand)
    expect(redeemed.value.redeemedAt).toEqual(expect.any(String))
    expect(replay).toMatchObject({ replayed: true })
    expect(redeemed.value.authorizationSource).toEqual({ kind: 'role', role: 'cashier', policy: 'benefit.redeem' })
    const authorization = await nativePool.query<{
      benefit_status: string
      reservation_status: string
      issuance_authorization: Record<string, unknown>
      redemption_authorization: Record<string, unknown>
    }>(`
      SELECT benefit.status AS benefit_status, reservation.status AS reservation_status,
        benefit.authorization_source AS issuance_authorization,
        redemption.authorization_source AS redemption_authorization
      FROM mbox.benefit_redemptions AS redemption
      JOIN mbox.benefits AS benefit ON benefit.id = redemption.benefit_id
      JOIN mbox.benefit_reservations AS reservation ON reservation.id = redemption.benefit_reservation_id
      WHERE redemption.id = $1::uuid
    `, [redeemed.value.id])
    expect(authorization.rows[0]).toEqual({
      benefit_status: 'redeemed',
      reservation_status: 'redeemed',
      issuance_authorization: { kind: 'role', role: 'manager', policy: 'benefit.issue' },
      redemption_authorization: { kind: 'role', role: 'cashier', policy: 'benefit.redeem' },
    })
    await expect(benefits.redeem({
      ...redeemCommand,
      redemptionIdempotencyKey: 'benefit-redemption-second-0001',
      redemptionFingerprint: 'redeem-fingerprint-2',
    })).rejects.toThrow('already redeemed by another request')
    const redemptionEvents = await nativePool.query<{ audits: string; outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.audit_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND action = 'benefit.redeemed' AND object_type = 'benefit_redemption'
            AND object_id = $3) AS audits,
        (SELECT count(*)::text FROM mbox.outbox_messages
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND message_type = 'benefit.redeemed.v1' AND aggregate_id = $4::uuid) AS outbox
    `, [tenantId, storeId, redeemed.value.id, issued.value.id])
    expect(redemptionEvents.rows[0]).toEqual({ audits: '1', outbox: '1' })

    const invalidEmployeeId = randomUUID()
    const rollbackIssuanceKey = 'benefit-rollback-issuance-0001'
    await expect(benefits.issue({
      ...benefitIssue(customer.value.customer.id, 'rollback'),
      actor: { type: 'employee', employeeId: invalidEmployeeId },
      issuanceIdempotencyKey: rollbackIssuanceKey,
      issuanceFingerprint: 'benefit-rollback-command-fingerprint',
    })).rejects.toThrow()
    const rollbackEvidence = await nativePool.query<{ benefits: string; idempotency: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.benefits
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND benefit_snapshot->>'issuanceIdempotencyKey' = $3) AS benefits,
        (SELECT count(*)::text FROM mbox.idempotency_records
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND idempotency_key = $3) AS idempotency
    `, [tenantId, storeId, rollbackIssuanceKey])
    expect(rollbackEvidence.rows[0]).toEqual({ benefits: '0', idempotency: '0' })
  })

  function customerCreate(suffix: string, hashCharacter: string) {
    return {
      scope: { tenantId, storeId },
      actor: { type: 'system' as const, ref: 'customer-test' },
      businessDate: '2026-08-11',
      publicId: `anonymous-customer-${suffix}`,
      identityHash: hashCharacter.repeat(64),
      profile: {
        displayName: `Guest ${suffix}`,
        tags: [suffix, 'test'],
        preferences: { drinkStyle: suffix },
      },
      idempotencyKey: `customer-create-${suffix}-key-0001`,
      requestFingerprint: JSON.stringify({ suffix }),
    }
  }

  function benefitIssue(customerId: string, suffix: string) {
    return {
      scope: { tenantId, storeId },
      actor: { type: 'system' as const, ref: 'manager-test' },
      businessDate: '2026-08-11',
      customerId,
      benefitCode: `gift.${suffix}`,
      benefitType: 'gift_product' as const,
      allowedProductIds: [benefitProductId],
      benefitSnapshot: { productCode: 'BEER-001' },
      validFrom: '2026-08-01T00:00:00+08:00',
      validUntil: '2027-08-01T00:00:00+08:00',
      authorizationSource: { kind: 'role', role: 'manager', policy: 'benefit.issue' },
      issuanceIdempotencyKey: `benefit-issue-${suffix}-0001`,
      issuanceFingerprint: `benefit-fingerprint-${suffix}`,
    }
  }
})

function nextShanghaiCrossMidnightWindow() {
  const now = Date.now()
  const shanghaiNow = new Date(now + 8 * 60 * 60_000)
  let arrival = Date.UTC(
    shanghaiNow.getUTCFullYear(),
    shanghaiNow.getUTCMonth(),
    shanghaiNow.getUTCDate(),
    15,
    30,
  )
  if (arrival <= now + 30 * 60_000) arrival += 24 * 60 * 60_000
  return {
    arrivalAt: new Date(arrival).toISOString(),
    expectedEndAt: new Date(arrival + 2.5 * 60 * 60_000).toISOString(),
    holdExpiresAt: new Date(now + 10 * 60_000).toISOString(),
  }
}

function asPool(nativePool: Pool): PostgresPool {
  return {
    connect: async () => nativePool.connect(),
    end: async () => nativePool.end(),
  }
}

async function seedEmployee(nativePool: Pool, tenantId: string, storeId: string): Promise<string> {
  const employeeId = randomUUID()
  await nativePool.query(`
    INSERT INTO mbox.employees (id, tenant_id, store_id, employee_code, display_name)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'Arrival Employee')
  `, [employeeId, tenantId, storeId, `employee-${employeeId.slice(0, 8)}`])
  return employeeId
}

async function seedReservationDeposit(
  pool: Pool,
  tenantId: string,
  storeId: string,
  tableSessionId: string,
  reservationId: string,
  employeeId: string,
): Promise<string> {
  const orderId = randomUUID()
  const paymentId = randomUUID()
  await pool.query(`
    INSERT INTO mbox.orders(
      id, tenant_id, store_id, table_session_id, public_id, channel, status,
      payment_status, subtotal_amount_minor, discount_amount_minor, total_amount_minor, currency
    ) VALUES ($1, $2, $3, $4, $5, 'reservation', 'confirmed', 'paid', 50000, 0, 50000, 'CNY')
  `, [orderId, tenantId, storeId, tableSessionId, `deposit-order-${orderId}`])
  await pool.query(`
    INSERT INTO mbox.payments(
      id, tenant_id, store_id, order_id, public_id, provider, provider_transaction_id,
      method, amount_minor, currency, status, succeeded_at
    ) VALUES ($1, $2, $3, $4, $5, 'simulation', $6, 'native_qr', 50000, 'CNY', 'succeeded', clock_timestamp())
  `, [
    paymentId,
    tenantId,
    storeId,
    orderId,
    `deposit-payment-${paymentId}`,
    `simulation-deposit-${paymentId}`,
  ])
  await pool.query(`
    INSERT INTO mbox.reservation_payments(
      tenant_id, store_id, reservation_id, payment_id, purpose, linked_by_employee_id
    ) VALUES ($1, $2, $3, $4, 'deposit', $5)
  `, [tenantId, storeId, reservationId, paymentId, employeeId])
  return paymentId
}
