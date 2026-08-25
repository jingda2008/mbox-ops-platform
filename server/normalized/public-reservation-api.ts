import { createHash, randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { JsonCodec, JsonObject } from './command-executor.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  NormalizedCommandExecutor,
} from './command-executor.js'
import type {
  ReservationGuestSessionIssueResult,
  ReservationGuestSessionService,
} from './reservation-guest-session.js'
import {
  ReservationGuestRateLimitError,
  ReservationGuestSessionInvalidError,
} from './reservation-guest-session.js'
import {
  ReservationCancellationPolicyError,
  ReservationConflictError,
  ReservationHoldExpiredError,
  ReservationNotFoundError,
  ReservationRepository,
  ReservationTableUnavailableError,
  ReservationTransitionError,
  type Reservation,
} from './reservation-repository.js'
import {
  ScheduleRepository,
  type DailyPerformanceView,
} from './schedule-repository.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'
import {
  WaitlistCommandService,
  WaitlistNotFoundError,
  WaitlistRepository,
  WaitlistTransitionError,
  type ProtectedContact,
  type WaitlistEntry,
} from './waitlist-repository.js'

export interface PublicReservationGuestContext {
  scope: Readonly<StoreScope>
  sessionId: string
  customerId: string
  actorRef: string
  businessDate: string
  capabilities: readonly string[]
}

export interface PublicReservationStaffContext {
  scope: Readonly<StoreScope>
  employeeId: string
  permissions: readonly string[]
  visibleOwnerEmployeeIds: readonly string[]
}

export interface PublicReservationApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  commands: Pick<NormalizedCommandExecutor, 'execute'>
  waitlists: Pick<WaitlistCommandService, 'create' | 'transition'>
  reservationSessions: Pick<ReservationGuestSessionService, 'issue'>
  resolveTrustedScope(request: FastifyRequest): Promise<Readonly<StoreScope>> | Readonly<StoreScope>
  resolveGuest(request: FastifyRequest): Promise<PublicReservationGuestContext> | PublicReservationGuestContext
  resolveStaff(request: FastifyRequest): Promise<PublicReservationStaffContext> | PublicReservationStaffContext
  protectContact(value: string): Promise<ProtectedContact> | ProtectedContact
  currentBusinessDate(scope: Readonly<StoreScope>): Promise<string> | string
  createScheduleRepository?(transaction: ScopedTransaction): Pick<ScheduleRepository, 'getDailyView'>
  now?: () => Date
  createPublicId?: (kind: 'reservation' | 'waitlist') => string
}

interface ReservationPolicyRow extends Record<string, unknown> {
  policy_version: number
  hold_minutes: number
  arrival_grace_minutes: number
  max_advance_days: number
  default_duration_minutes: number
  customer_cancel_cutoff_minutes: number
  deposit_mode: 'disabled' | 'flat' | 'minimum_spend_ratio'
  deposit_minor: string | number | null
  deposit_ratio_bps: number | null
  deposit_rule_text: string | null
}

interface ReservationCapacityRow extends Record<string, unknown> {
  total_capacity: string | number
  committed_guests: string | number
}

interface AnnualPriorityReservationRow extends Record<string, unknown> {
  rule_id: string
  rule_code: string
  title: string
  reservation_hold_minutes: number
}

interface AvailableTableRow extends Record<string, unknown> {
  table_id: string
  table_code: string
  table_name: string
  capacity: number
  minimum_spend_minor: string | number | null
  currency: string
  area_code: string
  area_name: string
  area_type: string
  availability_status: 'available' | 'reserved' | 'locked'
}

type SeatPreference = 'no_preference' | 'stage_atmosphere' | 'quiet_chat' | 'comfortable_booth' | 'outdoor_view'

const SEAT_PREFERENCES = [
  'no_preference',
  'stage_atmosphere',
  'quiet_chat',
  'comfortable_booth',
  'outdoor_view',
] as const satisfies readonly SeatPreference[]

interface PrivateContactRow extends Record<string, unknown> {
  masked_contact: string
}

interface OwnedReservationListRow extends Record<string, unknown> {
  id: string
  masked_contact: string
}

interface IntakeRow extends Record<string, unknown> {
  kind: 'reservation' | 'waitlist'
  public_id: string
  customer_name: string
  masked_contact: string
  guest_count: number
  arrival_at: string
  status: string
  source: string
  owner_employee_id: string | null
  table_codes: string[]
  annual_priority_hold_minutes: number | null
  queue_override_mode: PriorityQueueOverrideMode | null
  queue_override_reason: string | null
  queue_override_created_at: string | null
}

type PriorityQueueTargetKind = 'reservation' | 'waitlist'
type PriorityQueueOverrideMode = 'promote' | 'demote' | 'clear'

interface PriorityQueueOverride {
  id: string
  targetKind: PriorityQueueTargetKind
  publicId: string
  mode: PriorityQueueOverrideMode
  reason: string
  createdAt: string
}

class PublicReservationRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicReservationRequestError'
  }
}

class PublicReservationCapacityUnavailableError extends Error {
  constructor() {
    super('这个时段预约已满，请换个时间或登记候补')
    this.name = 'PublicReservationCapacityUnavailableError'
  }
}

class PublicReservationPolicyVersionConflictError extends Error {
  constructor() {
    super('预约规则刚刚更新，请返回确认页重新查看定金与到店规则')
    this.name = 'PublicReservationPolicyVersionConflictError'
  }
}

class PublicReservationOwnershipError extends Error {
  constructor() {
    super('没有找到对应预约')
    this.name = 'PublicReservationOwnershipError'
  }
}

class PublicReservationStaffPermissionError extends Error {
  constructor() {
    super('当前岗位没有预约操作权限')
    this.name = 'PublicReservationStaffPermissionError'
  }
}

class PublicReservationRateLimitError extends Error {
  constructor(readonly retryAt: string) {
    super('操作有点快，请稍后再试')
    this.name = 'PublicReservationRateLimitError'
  }
}

export const publicReservationApiPlugin: FastifyPluginAsync<PublicReservationApiOptions> = async (
  app,
  options,
) => {
  const now = options.now ?? (() => new Date())
  const createPublicId = options.createPublicId ?? ((kind) => `${kind}-${randomUUID()}`)
  const createSchedules = options.createScheduleRepository ?? ((transaction) => new ScheduleRepository(transaction))

  app.post('/public/reservation/session', async (request, reply) => handle(reply, async () => {
    const body = readObject(request.body)
    const scope = await options.resolveTrustedScope(request)
    const businessDate = await options.currentBusinessDate(scope)
    const provider = readEnum(body.provider, '身份来源', ['anonymous', 'wechat'] as const)
    const providerAssertion = readString(body.providerAssertion, '身份凭据', 8, 4096)
    const deviceFingerprint = readString(body.deviceFingerprint, '设备标识', 8, 512)
    const execution = await options.reservationSessions.issue({
      scope,
      provider,
      providerAssertion,
      deviceFingerprint,
      businessDate,
      idempotencyKey: readIdempotencyKey(request),
      requestFingerprint: fingerprint({ provider, providerAssertion, deviceFingerprint }),
    })
    setSessionCookie(reply, execution.value)
    return reply.code(execution.replayed ? 200 : 201).send({
      data: {
        status: 'active',
        expiresAt: execution.value.session.expiresAt,
        capabilities: execution.value.session.scopes,
      },
      meta: { replayed: execution.replayed },
    })
  }))

  app.get('/public/reservation/availability', async (request, reply) => handle(reply, async () => {
    const scope = await options.resolveTrustedScope(request)
    const query = readQuery(request)
    const arrivalAt = readTimestamp(query.arrivalAt, '到店时间')
    const guestCount = readInteger(query.guestCount, '人数', 1, 200)
    const result = await options.transactions.run(scope, async (transaction) => {
      const policy = await readPolicy(transaction)
      const expectedEndAt = query.expectedEndAt === undefined
        ? new Date(Date.parse(arrivalAt) + policy.default_duration_minutes * 60_000).toISOString()
        : readTimestamp(query.expectedEndAt, '预计结束时间')
      validateReservationWindow(arrivalAt, expectedEndAt, now(), policy.max_advance_days)
      await enforceRateLimit(transaction, 'availability', fingerprint({ arrivalAt, expectedEndAt, guestCount }), 30, 60_000)
      const tables = await listReservationTables(transaction, arrivalAt, expectedEndAt, guestCount)
      const capacity = await readReservationCapacity(transaction, arrivalAt, expectedEndAt)
      return { policy, expectedEndAt, tables, capacity }
    })
    return reply.send({
      data: {
        arrivalAt,
        expectedEndAt: result.expectedEndAt,
        guestCount,
        acceptingReservations: capacityAccepts(result.capacity, guestCount),
        depositRule: publicDepositRule(result.policy, null),
        areas: groupPublicTables(result.tables),
      },
    })
  }))

  app.get('/public/reservation/performances', async (request, reply) => handle(reply, async () => {
    const scope = await options.resolveTrustedScope(request)
    const query = readQuery(request)
    const businessDate = readBusinessDate(query.date, '演出日期')
    const currentBusinessDate = await options.currentBusinessDate(scope)
    const view = await options.transactions.run(scope, async (transaction) => {
      const policy = await readPolicy(transaction)
      validatePublicPerformanceDate(businessDate, currentBusinessDate, policy.max_advance_days)
      return createSchedules(transaction).getDailyView(businessDate, now().toISOString())
    }, { readOnly: true })
    return reply.send({ data: publicDailyPerformance(view) })
  }))

  app.post('/public/reservations', async (request, reply) => handle(reply, async () => {
    const context = await requireGuest(options, request, 'guest.reservation.update')
    const body = readObject(request.body)
    rejectClaims(body, ['customerId', 'source', 'holdExpiresAt', 'contactToken', 'actor', 'scope'])
    const mode = readEnum(body.mode, '预约方式', ['direct'] as const)
    const customerName = readString(body.customerName, '预约姓名', 1, 128)
    const contact = await options.protectContact(readString(body.contact, '联系方式', 3, 256))
    const guestCount = readInteger(body.guestCount, '人数', 1, 200)
    const arrivalAt = readTimestamp(body.arrivalAt, '到店时间')
    const note = readOptionalString(body.note, '备注', 1000)
    const seatPreference = body.seatPreference === undefined
      ? 'no_preference'
      : readEnum(body.seatPreference, '座位偏好', SEAT_PREFERENCES)
    const acknowledgedPolicyVersion = readInteger(body.reservationPolicyVersion, '预约规则版本', 1, 2_147_483_647)
    const preferredScheduleId = readOptionalUuid(body.preferredScheduleId, '演出偏好')
    if (body.tableCodes !== undefined) throw new PublicReservationRequestError('预约只登记位置偏好，具体位置到店后由门店安排')
    const idempotencyKey = readIdempotencyKey(request)
    const publicId = readOptionalString(body.publicId, '预约编号', 128) ?? createPublicId('reservation')
    const execution = await options.commands.execute({
      scope: context.scope,
      operationScope: 'public.reservation.create',
      idempotencyKey,
      requestFingerprint: fingerprint({ mode, customerName, contact: contact.hash, guestCount, arrivalAt, note, seatPreference, acknowledgedPolicyVersion, preferredScheduleId }),
      resultCodec: reservationCodec,
    }, async (transaction) => {
      await enforceRateLimit(transaction, 'reservation', hashActor(context.actorRef), 8, 60_000)
      const policy = await readPolicy(transaction, true)
      if (policy.policy_version !== acknowledgedPolicyVersion) {
        throw new PublicReservationPolicyVersionConflictError()
      }
      await assertPreferredSchedule(transaction, preferredScheduleId, arrivalAt)
      const expectedEndAt = body.expectedEndAt === undefined
        ? new Date(Date.parse(arrivalAt) + policy.default_duration_minutes * 60_000).toISOString()
        : readTimestamp(body.expectedEndAt, '预计结束时间')
      validateReservationWindow(arrivalAt, expectedEndAt, now(), policy.max_advance_days)
      const capacity = await readReservationCapacity(transaction, arrivalAt, expectedEndAt)
      if (!capacityAccepts(capacity, guestCount)) throw new PublicReservationCapacityUnavailableError()
      const annualPriority = await readAnnualReservationPriority(transaction, context.customerId)
      const requestHoldMinutes = annualPriority?.reservation_hold_minutes ?? policy.hold_minutes
      const heldUntil = new Date(Math.min(
        Date.parse(arrivalAt),
        now().getTime() + requestHoldMinutes * 60_000,
      )).toISOString()
      const deposit = publicDepositRule(policy, null)
      const reservation = await new ReservationRepository(transaction).create({
        publicId,
        customerId: context.customerId,
        customerName,
        contactToken: contact.hash,
        guestCount,
        arrivalAt,
        expectedEndAt,
        source: 'wechat',
        note,
        reservationSnapshot: {
          bookingMode: mode,
          depositRule: deposit,
          priorityBooking: annualPriority === null ? null : {
            ruleCode: annualPriority.rule_code,
            title: annualPriority.title,
          },
        },
        seatPreference,
        tableIds: [],
        allowUnassignedTable: true,
        initialStatus: 'pending',
        holdExpiresAt: heldUntil,
        requestHoldExpiresAt: heldUntil,
        arrivalGraceEndsAt: new Date(
          Date.parse(arrivalAt) + policy.arrival_grace_minutes * 60_000,
        ).toISOString(),
        reservationPolicyVersion: policy.policy_version,
        reservationPolicyAcknowledgedVersion: acknowledgedPolicyVersion,
        preferredScheduleId,
        annualPriorityRuleId: annualPriority?.rule_id ?? null,
        annualPriorityHoldMinutes: annualPriority?.reservation_hold_minutes ?? null,
        customerCancelUntil: new Date(
          Date.parse(arrivalAt) - policy.customer_cancel_cutoff_minutes * 60_000,
        ).toISOString(),
        cancellationPolicySnapshot: {
          cutoffMinutes: policy.customer_cancel_cutoff_minutes,
          depositMode: policy.deposit_mode,
        },
      })
      await insertPrivateContact(transaction, reservation.id, contact)
      const payload = reservationEvent(reservation)
      return {
        result: reservation,
        auditEvents: [{
          actor: { type: 'guest', ref: context.actorRef },
          action: 'reservation.created',
          objectType: 'reservation',
          objectId: reservation.id,
          businessDate: context.businessDate,
          afterData: payload,
        }],
        outboxMessages: [{
          aggregateType: 'reservation',
          aggregateId: reservation.id,
          aggregateVersion: reservation.aggregateVersion,
          eventType: 'reservation.created.v1',
          payload,
        }],
      }
    })
    const maskedContact = contact.masked
    return reply.code(execution.replayed ? 200 : 201).send({
      data: publicReservation(execution.value, maskedContact),
      meta: {
        replayed: execution.replayed,
        arrivalGraceMinutes: reservationArrivalGraceMinutes(execution.value),
      },
    })
  }))

  app.get('/public/reservations/mine', async (request, reply) => handle(reply, async () => {
    const context = await requireGuest(options, request, 'guest.reservation.read')
    const reservations = await listOwnedReservations(options, context)
    return reply.send({ data: { reservations }, meta: { count: reservations.length } })
  }))

  app.get<{ Params: { publicId: string } }>('/public/reservations/:publicId', async (request, reply) => (
    handle(reply, async () => {
      const context = await requireGuest(options, request, 'guest.reservation.read')
      const result = await findOwnedReservation(options, context, readPublicId(request.params.publicId))
      return reply.send({ data: publicReservation(result.reservation, result.maskedContact) })
    })
  ))

  app.patch<{ Params: { publicId: string } }>('/public/reservations/:publicId', async (request, reply) => (
    handle(reply, async () => {
      const context = await requireGuest(options, request, 'guest.reservation.update')
      const body = readObject(request.body)
      rejectClaims(body, [
        'customerId', 'source', 'status', 'actor', 'scope', 'tableCodes',
        'reservationPolicyAcknowledgedVersion',
      ])
      const publicId = readPublicId(request.params.publicId)
      const idempotencyKey = readIdempotencyKey(request)
      const acknowledgedPolicyVersion = readInteger(
        body.reservationPolicyVersion,
        '预约规则版本',
        1,
        2_147_483_647,
      )
      const execution = await options.commands.execute({
        scope: context.scope,
        operationScope: 'public.reservation.update',
        idempotencyKey,
        requestFingerprint: fingerprint({ publicId, body, acknowledgedPolicyVersion }),
        resultCodec: reservationCodec,
      }, async (transaction) => {
        const current = await ownedReservationInTransaction(transaction, publicId, context.customerId, true)
        if (!['pending', 'confirmed'].includes(current.status)) {
          throw new PublicReservationRequestError('当前预约状态不能再修改')
        }
        const customerName = body.customerName === undefined
          ? current.customerName
          : readString(body.customerName, '预约姓名', 1, 128)
        const guestCount = body.guestCount === undefined
          ? current.guestCount
          : readInteger(body.guestCount, '人数', 1, 200)
        const arrivalAt = body.arrivalAt === undefined
          ? current.arrivalAt
          : readTimestamp(body.arrivalAt, '到店时间')
        const arrivalChanged = Date.parse(arrivalAt) !== Date.parse(current.arrivalAt)
        const preferredScheduleProvided = Object.prototype.hasOwnProperty.call(body, 'preferredScheduleId')
        if (arrivalChanged && !preferredScheduleProvided) {
          throw new PublicReservationRequestError('到店时间变化后，请重新选择演出或明确清空演出偏好')
        }
        const preferredScheduleId = preferredScheduleProvided
          ? readOptionalUuid(body.preferredScheduleId, '演出偏好')
          : current.preferredScheduleId
        const expectedEndAt = body.expectedEndAt === undefined
          ? current.expectedEndAt
          : readTimestamp(body.expectedEndAt, '预计结束时间')
        const note = body.note === undefined ? current.note : readOptionalString(body.note, '备注', 1000)
        const seatPreference = body.seatPreference === undefined
          ? current.seatPreference
          : readEnum(body.seatPreference, '座位偏好', SEAT_PREFERENCES)
        const policy = await readPolicy(transaction, true)
        if (policy.policy_version !== acknowledgedPolicyVersion) {
          throw new PublicReservationPolicyVersionConflictError()
        }
        await assertPreferredSchedule(transaction, preferredScheduleId, arrivalAt)
        validateReservationWindow(arrivalAt, expectedEndAt, now(), policy.max_advance_days)
        const capacity = await readReservationCapacity(
          transaction,
          arrivalAt,
          expectedEndAt,
          current.id,
        )
        if (!capacityAccepts(capacity, guestCount)) throw new PublicReservationCapacityUnavailableError()
        await transaction.query(`
          UPDATE mbox.reservation_table_locks SET status = 'released', hold_expires_at = NULL
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND reservation_id = $3::uuid
            AND status IN ('held', 'confirmed')
        `, [transaction.scope.tenantId, transaction.scope.storeId, current.id])
        await transaction.query(`
          UPDATE mbox.reservations
          SET customer_name = $4, guest_count = $5, arrival_at = $6::timestamptz,
            expected_end_at = $7::timestamptz, note = $8,
            seat_preference = $9,
            request_hold_expires_at = CASE WHEN status='pending'
              THEN LEAST($6::timestamptz, clock_timestamp() + make_interval(mins => $10::integer))
              ELSE NULL END,
            arrival_grace_ends_at = $6::timestamptz + make_interval(mins => $11::integer),
            reservation_policy_version = $12::integer,
            reservation_policy_acknowledged_version = $12::integer,
            preferred_schedule_id = $13::uuid,
            customer_cancel_until = $6::timestamptz - make_interval(mins => $14::integer),
            cancellation_policy_snapshot = $15::jsonb,
            aggregate_version = aggregate_version + 1
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        `, [
          transaction.scope.tenantId,
          transaction.scope.storeId,
          current.id,
          customerName,
          guestCount,
          arrivalAt,
          expectedEndAt,
          note,
          seatPreference,
          policy.hold_minutes,
          policy.arrival_grace_minutes,
          policy.policy_version,
          preferredScheduleId,
          policy.customer_cancel_cutoff_minutes,
          JSON.stringify({
            cutoffMinutes: policy.customer_cancel_cutoff_minutes,
            depositMode: policy.deposit_mode,
          }),
        ])
        const updated = await new ReservationRepository(transaction).findById(current.id)
        if (!updated) throw new ReservationNotFoundError(current.id)
        const payload = reservationEvent(updated)
        return {
          result: updated,
          auditEvents: [{
            actor: { type: 'guest', ref: context.actorRef },
            action: 'reservation.updated',
            objectType: 'reservation',
            objectId: updated.id,
            businessDate: context.businessDate,
            beforeData: reservationEvent(current),
            afterData: payload,
          }],
          outboxMessages: [{
            aggregateType: 'reservation',
            aggregateId: updated.id,
            aggregateVersion: updated.aggregateVersion,
            eventType: 'reservation.updated.v1',
            payload,
          }],
        }
      })
      const owned = await findOwnedReservation(options, context, publicId)
      return reply.send({ data: publicReservation(execution.value, owned.maskedContact), meta: { replayed: execution.replayed } })
    })
  ))

  app.delete<{ Params: { publicId: string } }>('/public/reservations/:publicId', async (request, reply) => (
    handle(reply, async () => {
      const context = await requireGuest(options, request, 'guest.reservation.update')
      const publicId = readPublicId(request.params.publicId)
      const existing = await findOwnedReservation(options, context, publicId)
      const execution = await options.commands.execute({
        scope: context.scope,
        operationScope: 'public.reservation.cancel',
        idempotencyKey: readIdempotencyKey(request),
        requestFingerprint: fingerprint({ publicId }),
        resultCodec: reservationCodec,
      }, async (transaction) => {
        const current = await ownedReservationInTransaction(transaction, publicId, context.customerId, false)
        const mutation = await new ReservationRepository(transaction).cancelWithResult(current.id)
        if (!mutation.changed) return { result: mutation.reservation, auditEvents: [], outboxMessages: [] }
        const payload = reservationEvent(mutation.reservation)
        return {
          result: mutation.reservation,
          auditEvents: [{
            actor: { type: 'guest', ref: context.actorRef },
            action: 'reservation.cancelled',
            objectType: 'reservation',
            objectId: current.id,
            businessDate: context.businessDate,
            afterData: payload,
          }],
          outboxMessages: [{
            aggregateType: 'reservation',
            aggregateId: current.id,
            aggregateVersion: mutation.reservation.aggregateVersion,
            eventType: 'reservation.cancelled.v1',
            payload,
          }],
        }
      })
      return reply.send({ data: publicReservation(execution.value, existing.maskedContact), meta: { replayed: execution.replayed } })
    })
  ))

  app.post('/public/waitlist', async (request, reply) => handle(reply, async () => {
    const context = await requireGuest(options, request, 'guest.waitlist.manage')
    const body = readObject(request.body)
    rejectClaims(body, ['customerId', 'source', 'status', 'actor', 'scope'])
    const contact = await options.protectContact(readString(body.contact, '联系方式', 3, 256))
    const annualPriority = await options.transactions.run(context.scope, (transaction) => (
      readAnnualReservationPriority(transaction, context.customerId)
    ), { readOnly: true })
    const execution = await options.waitlists.create({
      scope: context.scope,
      actor: { type: 'guest', ref: context.actorRef },
      businessDate: context.businessDate,
      idempotencyKey: readIdempotencyKey(request),
      requestFingerprint: fingerprint({ ...body, contact: contact.hash, annualPriorityRuleId: annualPriority?.rule_id ?? null }),
      publicId: createPublicId('waitlist'),
      customerId: context.customerId,
      customerName: readString(body.customerName, '候位姓名', 1, 128),
      contact,
      guestCount: readInteger(body.guestCount, '人数', 1, 200),
      desiredArrivalAt: readTimestamp(body.desiredArrivalAt, '预计到店时间'),
      source: 'wechat',
      note: readOptionalString(body.note, '备注', 1000),
      annualPriorityRuleId: annualPriority?.rule_id ?? null,
      annualPriorityHoldMinutes: annualPriority?.reservation_hold_minutes ?? null,
    })
    return reply.code(execution.replayed ? 200 : 201).send({
      data: publicWaitlist(execution.value),
      meta: { replayed: execution.replayed },
    })
  }))

  app.get<{ Params: { publicId: string } }>('/public/waitlist/:publicId', async (request, reply) => (
    handle(reply, async () => {
      const context = await requireGuest(options, request, 'guest.waitlist.manage')
      const entry = await options.transactions.run(context.scope, (transaction) => (
        new WaitlistRepository(transaction).findOwnedByPublicId(
          readPublicId(request.params.publicId),
          context.customerId,
        )
      ), { readOnly: true })
      if (!entry) throw new WaitlistNotFoundError()
      return reply.send({ data: publicWaitlist(entry) })
    })
  ))

  app.delete<{ Params: { publicId: string } }>('/public/waitlist/:publicId', async (request, reply) => (
    handle(reply, async () => {
      const context = await requireGuest(options, request, 'guest.waitlist.manage')
      const entry = await options.transactions.run(context.scope, (transaction) => (
        new WaitlistRepository(transaction).findOwnedByPublicId(
          readPublicId(request.params.publicId),
          context.customerId,
        )
      ), { readOnly: true })
      if (!entry) throw new WaitlistNotFoundError()
      const execution = await options.waitlists.transition({
        scope: context.scope,
        actor: { type: 'guest', ref: context.actorRef },
        businessDate: context.businessDate,
        idempotencyKey: readIdempotencyKey(request),
        requestFingerprint: fingerprint({ publicId: entry.publicId, to: 'cancelled' }),
        entryId: entry.id,
        to: 'cancelled',
      })
      return reply.send({ data: publicWaitlist(execution.value), meta: { replayed: execution.replayed } })
    })
  ))

  app.post<{ Params: { kind: string; publicId: string } }>('/staff/reservation-intake/:kind/:publicId/priority-override', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveStaff(request)
    requirePermission(context, 'reservation.manage')
    const body = readObject(request.body)
    const targetKind = readPriorityQueueTargetKind(request.params.kind)
    const publicId = readPublicId(request.params.publicId)
    const mode = readPriorityQueueOverrideMode(body.mode)
    const reason = readString(body.reason, '队列调整原因', 2, 500)
    const businessDate = await options.currentBusinessDate(context.scope)
    const execution = await options.commands.execute({
      scope: context.scope,
      operationScope: 'reservation.priority-queue.override',
      idempotencyKey: readIdempotencyKey(request),
      requestFingerprint: fingerprint({ targetKind, publicId, mode, reason }),
      resultCodec: priorityQueueOverrideCodec,
    }, async (transaction) => {
      const target = await findVisiblePriorityQueueTarget(transaction, context, targetKind, publicId)
      if (target === null) throw new PublicReservationOwnershipError()
      const inserted = await transaction.query<{
        id: string
        target_kind: PriorityQueueTargetKind
        mode: PriorityQueueOverrideMode
        reason: string
        created_at: string
      }>(`
        INSERT INTO mbox.reservation_priority_queue_overrides(
          tenant_id,store_id,target_kind,reservation_id,waitlist_entry_id,mode,reason,overridden_by_employee_id
        ) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6,$7,$8::uuid)
        RETURNING id,target_kind,mode,reason,created_at::text
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        targetKind,
        targetKind === 'reservation' ? target.id : null,
        targetKind === 'waitlist' ? target.id : null,
        mode,
        reason,
        context.employeeId,
      ])
      const row = inserted.rows[0]
      if (row === undefined) throw new Error('优先队列调整未保存')
      const override: PriorityQueueOverride = {
        id: row.id,
        targetKind: row.target_kind,
        publicId: target.publicId,
        mode: row.mode,
        reason: row.reason,
        createdAt: row.created_at,
      }
      const payload: JsonObject = {
        targetKind: override.targetKind,
        publicId: override.publicId,
        mode: override.mode,
        reason: override.reason,
      }
      return {
        result: override,
        auditEvents: [{
          actor: { type: 'employee', employeeId: context.employeeId },
          action: 'reservation.priority-queue.overridden',
          objectType: targetKind === 'reservation' ? 'reservation' : 'waitlist_entry',
          objectId: target.id,
          businessDate,
          reason,
          afterData: payload,
        }],
        outboxMessages: [{
          aggregateType: 'reservation_priority_queue_override',
          aggregateId: override.id,
          aggregateVersion: 1,
          eventType: 'reservation.priority-queue.overridden.v1',
          payload,
        }],
      }
    })
    return reply.send({ data: execution.value, meta: { replayed: execution.replayed } })
  }))

  app.get('/staff/reservation-intake', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveStaff(request)
    requirePermission(context, 'reservation.view')
    const query = readQuery(request)
    const from = readTimestamp(query.from, '开始时间')
    const to = readTimestamp(query.to, '结束时间')
    if (Date.parse(to) <= Date.parse(from)) throw new PublicReservationRequestError('结束时间必须晚于开始时间')
    const canViewAll = context.permissions.includes('reservation.view.all')
    const rows = await options.transactions.run(context.scope, (transaction) => (
      transaction.query<IntakeRow>(`
        SELECT 'reservation'::text AS kind, reservation.public_id,
          reservation.customer_name, COALESCE(contact.masked_contact, '已留联系方式') AS masked_contact,
          reservation.guest_count, reservation.arrival_at::text AS arrival_at,
          reservation.status, reservation.source, reservation.owner_employee_id,
          COALESCE(array_agg(venue_table.code ORDER BY venue_table.code)
            FILTER (WHERE venue_table.code IS NOT NULL), ARRAY[]::text[]) AS table_codes,
          reservation.annual_priority_hold_minutes,queue_override.mode AS queue_override_mode,
          queue_override.reason AS queue_override_reason,queue_override.created_at::text AS queue_override_created_at,
          CASE queue_override.mode
            WHEN 'promote' THEN 0
            WHEN 'demote' THEN 3
            ELSE CASE WHEN reservation.annual_priority_hold_minutes IS NULL THEN 2 ELSE 1 END
          END AS queue_priority
        FROM mbox.reservations AS reservation
        LEFT JOIN mbox.reservation_private_contacts AS contact
          ON contact.tenant_id = reservation.tenant_id AND contact.store_id = reservation.store_id
          AND contact.reservation_id = reservation.id
        LEFT JOIN mbox.reservation_table_locks AS table_lock
          ON table_lock.tenant_id = reservation.tenant_id AND table_lock.store_id = reservation.store_id
          AND table_lock.reservation_id = reservation.id
          AND table_lock.status IN ('held', 'confirmed')
        LEFT JOIN mbox.tables AS venue_table
          ON venue_table.tenant_id = table_lock.tenant_id AND venue_table.store_id = table_lock.store_id
          AND venue_table.id = table_lock.table_id
        LEFT JOIN LATERAL (
          SELECT override.mode,override.reason,override.created_at
          FROM mbox.reservation_priority_queue_overrides AS override
          WHERE override.tenant_id=reservation.tenant_id AND override.store_id=reservation.store_id
            AND override.reservation_id=reservation.id
          ORDER BY override.created_at DESC,override.id DESC
          LIMIT 1
        ) AS queue_override ON true
        WHERE reservation.tenant_id = $1::uuid AND reservation.store_id = $2::uuid
          AND reservation.arrival_at >= $3::timestamptz AND reservation.arrival_at < $4::timestamptz
          AND ($5::boolean OR reservation.owner_employee_id = ANY($6::uuid[]))
        GROUP BY reservation.id, contact.masked_contact, reservation.annual_priority_hold_minutes,
          queue_override.mode,queue_override.reason,queue_override.created_at
        UNION ALL
        SELECT 'waitlist'::text AS kind, waitlist.public_id, waitlist.customer_name,
          waitlist.masked_contact, waitlist.guest_count,
          waitlist.desired_arrival_at::text AS arrival_at, waitlist.status,
          waitlist.source, waitlist.owner_employee_id, ARRAY[]::text[] AS table_codes,
          waitlist.annual_priority_hold_minutes,queue_override.mode AS queue_override_mode,
          queue_override.reason AS queue_override_reason,queue_override.created_at::text AS queue_override_created_at,
          CASE queue_override.mode
            WHEN 'promote' THEN 0
            WHEN 'demote' THEN 3
            ELSE CASE WHEN waitlist.annual_priority_hold_minutes IS NULL THEN 2 ELSE 1 END
          END AS queue_priority
        FROM mbox.waitlist_entries AS waitlist
        LEFT JOIN LATERAL (
          SELECT override.mode,override.reason,override.created_at
          FROM mbox.reservation_priority_queue_overrides AS override
          WHERE override.tenant_id=waitlist.tenant_id AND override.store_id=waitlist.store_id
            AND override.waitlist_entry_id=waitlist.id
          ORDER BY override.created_at DESC,override.id DESC
          LIMIT 1
        ) AS queue_override ON true
        WHERE waitlist.tenant_id = $1::uuid AND waitlist.store_id = $2::uuid
          AND waitlist.desired_arrival_at >= $3::timestamptz
          AND waitlist.desired_arrival_at < $4::timestamptz
          AND ($5::boolean OR waitlist.owner_employee_id = ANY($6::uuid[]))
        ORDER BY arrival_at, queue_priority, public_id
        LIMIT 1000
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        from,
        to,
        canViewAll,
        [...context.visibleOwnerEmployeeIds],
      ])
    ), { readOnly: true })
    return reply.send({
      data: rows.rows.map((row) => ({
        kind: row.kind,
        channel: row.kind === 'waitlist' ? 'waitlist' : row.source === 'wechat' ? 'online' : row.source,
        publicId: row.public_id,
        customerName: row.customer_name,
        maskedContact: row.masked_contact,
        guestCount: Number(row.guest_count),
        arrivalAt: row.arrival_at,
        status: row.status,
        tableCodes: row.table_codes,
        priorityBooking: row.annual_priority_hold_minutes === null ? null : {
          requestHoldMinutes: Number(row.annual_priority_hold_minutes),
        },
        queueOverride: row.queue_override_mode === null ? null : {
          mode: row.queue_override_mode,
          reason: row.queue_override_reason,
          createdAt: row.queue_override_created_at,
        },
      })),
    })
  }))
}

async function listOwnedReservations(
  options: PublicReservationApiOptions,
  context: PublicReservationGuestContext,
): Promise<JsonObject[]> {
  return options.transactions.run(context.scope, async (transaction) => {
    const selected = await transaction.query<OwnedReservationListRow>(`
      WITH RECURSIVE ancestry(id, merged_into_customer_id) AS (
        SELECT customer.id, customer.merged_into_customer_id
        FROM mbox.customers AS customer
        WHERE customer.tenant_id = $1::uuid
          AND customer.store_id = $2::uuid
          AND customer.id = $3::uuid
        UNION ALL
        SELECT parent.id, parent.merged_into_customer_id
        FROM mbox.customers AS parent
        JOIN ancestry AS child ON child.merged_into_customer_id = parent.id
        WHERE parent.tenant_id = $1::uuid
          AND parent.store_id = $2::uuid
      ), canonical AS (
        SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
      ), family(id) AS (
        SELECT id FROM canonical
        UNION ALL
        SELECT child.id
        FROM mbox.customers AS child
        JOIN family AS parent ON child.merged_into_customer_id = parent.id
        WHERE child.tenant_id = $1::uuid
          AND child.store_id = $2::uuid
      )
      SELECT reservation.id,
        COALESCE(private_contact.masked_contact, '已留联系方式') AS masked_contact
      FROM mbox.reservations AS reservation
      JOIN family ON family.id = reservation.customer_id
      LEFT JOIN mbox.reservation_private_contacts AS private_contact
        ON private_contact.tenant_id = reservation.tenant_id
       AND private_contact.store_id = reservation.store_id
       AND private_contact.reservation_id = reservation.id
      WHERE reservation.tenant_id = $1::uuid
        AND reservation.store_id = $2::uuid
      ORDER BY reservation.arrival_at DESC, reservation.created_at DESC, reservation.id DESC
      LIMIT 50
    `, [transaction.scope.tenantId, transaction.scope.storeId, context.customerId])
    const output: JsonObject[] = []
    const repository = new ReservationRepository(transaction)
    for (const row of selected.rows) {
      const reservation = await repository.findById(row.id)
      if (reservation !== null) output.push(publicReservation(reservation, row.masked_contact))
    }
    return output
  }, { readOnly: true })
}

async function findOwnedReservation(
  options: PublicReservationApiOptions,
  context: PublicReservationGuestContext,
  publicId: string,
): Promise<{ reservation: Reservation; maskedContact: string }> {
  return options.transactions.run(context.scope, async (transaction) => {
    const reservation = await ownedReservationInTransaction(transaction, publicId, context.customerId, false)
    const contact = await transaction.query<PrivateContactRow>(`
      SELECT masked_contact FROM mbox.reservation_private_contacts
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND reservation_id = $3::uuid
    `, [transaction.scope.tenantId, transaction.scope.storeId, reservation.id])
    return { reservation, maskedContact: contact.rows[0]?.masked_contact ?? '已留联系方式' }
  }, { readOnly: true })
}

async function ownedReservationInTransaction(
  transaction: ScopedTransaction,
  publicId: string,
  customerId: string,
  lock: boolean,
): Promise<Reservation> {
  const selected = await transaction.query<{ id: string }>(`
    WITH RECURSIVE ancestry(id, merged_into_customer_id) AS (
      SELECT customer.id, customer.merged_into_customer_id
      FROM mbox.customers AS customer
      WHERE customer.tenant_id = $1::uuid AND customer.store_id = $2::uuid
        AND customer.id = $4::uuid
      UNION ALL
      SELECT parent.id, parent.merged_into_customer_id
      FROM mbox.customers AS parent
      JOIN ancestry AS child ON child.merged_into_customer_id = parent.id
      WHERE parent.tenant_id = $1::uuid AND parent.store_id = $2::uuid
    ), canonical AS (
      SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
    ), family(id) AS (
      SELECT id FROM canonical
      UNION ALL
      SELECT child.id
      FROM mbox.customers AS child
      JOIN family AS parent ON child.merged_into_customer_id = parent.id
      WHERE child.tenant_id = $1::uuid AND child.store_id = $2::uuid
    )
    SELECT reservation.id
    FROM mbox.reservations AS reservation
    JOIN family ON family.id = reservation.customer_id
    WHERE reservation.tenant_id = $1::uuid AND reservation.store_id = $2::uuid
      AND reservation.public_id = $3
    ${lock ? 'FOR UPDATE OF reservation' : ''}
  `, [transaction.scope.tenantId, transaction.scope.storeId, publicId, customerId])
  const id = selected.rows[0]?.id
  if (!id) throw new PublicReservationOwnershipError()
  const reservation = await new ReservationRepository(transaction).findById(id)
  if (!reservation) throw new PublicReservationOwnershipError()
  return reservation
}

async function readPolicy(transaction: ScopedTransaction, lock = false): Promise<ReservationPolicyRow> {
  const result = await transaction.query<ReservationPolicyRow>(`
    SELECT policy_version, hold_minutes, arrival_grace_minutes, max_advance_days, default_duration_minutes,
      customer_cancel_cutoff_minutes, deposit_mode, deposit_minor,
      deposit_ratio_bps, deposit_rule_text
    FROM mbox.public_reservation_policies
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    ${lock ? 'FOR UPDATE' : ''}
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const row = result.rows[0]
  if (!row) throw new Error('门店预约规则尚未配置')
  return row
}

async function readAnnualReservationPriority(
  transaction: ScopedTransaction,
  customerId: string,
): Promise<AnnualPriorityReservationRow | null> {
  const result = await transaction.query<AnnualPriorityReservationRow>(`
    WITH RECURSIVE ancestry(id,merged_into_customer_id) AS (
      SELECT customer.id,customer.merged_into_customer_id FROM mbox.customers customer
      WHERE customer.tenant_id=$1::uuid AND customer.store_id=$2::uuid AND customer.id=$3::uuid
      UNION ALL
      SELECT parent.id,parent.merged_into_customer_id FROM mbox.customers parent
      JOIN ancestry child ON child.merged_into_customer_id=parent.id
      WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
    ), canonical AS (
      SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
    )
    SELECT rule.id AS rule_id,rule.rule_code,rule.title,rule.reservation_hold_minutes
    FROM canonical
    JOIN mbox.customer_memberships membership
      ON membership.tenant_id=$1::uuid AND membership.store_id=$2::uuid
     AND membership.customer_id=canonical.id AND membership.status='active'
    JOIN mbox.loyalty_accounts account
      ON account.tenant_id=membership.tenant_id AND account.store_id=membership.store_id
     AND account.membership_id=membership.id AND account.customer_id=membership.customer_id
    JOIN mbox.loyalty_annual_benefit_policy_versions policy
      ON policy.tenant_id=membership.tenant_id AND policy.store_id=membership.store_id
     AND policy.status='published' AND policy.effective_from<=clock_timestamp()
     AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
    JOIN mbox.loyalty_annual_benefit_rules rule
      ON rule.tenant_id=policy.tenant_id AND rule.store_id=policy.store_id
     AND rule.policy_version_id=policy.id AND rule.enabled AND rule.rule_kind='priority_seating'
    WHERE (account.current_tier=rule.eligible_tier OR (
      rule.inherit_to_higher_tiers AND CASE account.current_tier WHEN 'gold' THEN 2 WHEN 'silver' THEN 1 ELSE 0 END
        > CASE rule.eligible_tier WHEN 'gold' THEN 2 WHEN 'silver' THEN 1 ELSE 0 END
    ))
    ORDER BY policy.effective_from DESC,policy.version DESC,rule.rule_code
    LIMIT 1
  `, [transaction.scope.tenantId, transaction.scope.storeId, customerId])
  return result.rows[0] ?? null
}

async function readReservationCapacity(
  transaction: ScopedTransaction,
  arrivalAt: string,
  expectedEndAt: string,
  excludeReservationId: string | null = null,
): Promise<ReservationCapacityRow> {
  const result = await transaction.query<ReservationCapacityRow>(`
    SELECT
      COALESCE((
        SELECT sum(venue_table.capacity)
        FROM mbox.tables AS venue_table
        JOIN mbox.areas AS area
          ON area.tenant_id = venue_table.tenant_id
          AND area.store_id = venue_table.store_id
          AND area.id = venue_table.area_id
        WHERE venue_table.tenant_id = $1::uuid AND venue_table.store_id = $2::uuid
          AND venue_table.status = 'available' AND area.status = 'active'
      ), 0)::text AS total_capacity,
      COALESCE((
        SELECT sum(reservation.guest_count)
        FROM mbox.reservations AS reservation
        WHERE reservation.tenant_id = $1::uuid AND reservation.store_id = $2::uuid
          AND ($5::uuid IS NULL OR reservation.id <> $5::uuid)
          AND tstzrange(reservation.arrival_at, reservation.expected_end_at, '[)')
            && tstzrange($3::timestamptz, $4::timestamptz, '[)')
          AND (
            reservation.status IN ('confirmed', 'arrived', 'seated')
            OR (
              reservation.status = 'pending'
              AND (
                reservation.source <> 'wechat'
                OR reservation.request_hold_expires_at > clock_timestamp()
              )
            )
          )
      ), 0)::text AS committed_guests
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    arrivalAt,
    expectedEndAt,
    excludeReservationId,
  ])
  return result.rows[0] ?? { total_capacity: 0, committed_guests: 0 }
}

function capacityAccepts(capacity: ReservationCapacityRow, guestCount: number): boolean {
  return Number(capacity.total_capacity) >= Number(capacity.committed_guests) + guestCount
}

async function listReservationTables(
  transaction: ScopedTransaction,
  arrivalAt: string,
  expectedEndAt: string,
  guestCount: number,
): Promise<AvailableTableRow[]> {
  const result = await transaction.query<AvailableTableRow>(`
    SELECT venue_table.id AS table_id, venue_table.code AS table_code,
      venue_table.display_name AS table_name, venue_table.capacity,
      venue_table.minimum_spend_minor, venue_table.currency,
      area.code AS area_code, area.name AS area_name, area.area_type,
      CASE active_lock.status
        WHEN 'confirmed' THEN 'reserved'
        WHEN 'held' THEN 'locked'
        ELSE 'available'
      END AS availability_status
    FROM mbox.tables AS venue_table
    JOIN mbox.areas AS area
      ON area.tenant_id = venue_table.tenant_id AND area.store_id = venue_table.store_id
      AND area.id = venue_table.area_id
    LEFT JOIN LATERAL (
      SELECT table_lock.status
      FROM mbox.reservation_table_locks AS table_lock
      WHERE table_lock.tenant_id = venue_table.tenant_id
        AND table_lock.store_id = venue_table.store_id
        AND table_lock.table_id = venue_table.id
        AND table_lock.status IN ('held', 'confirmed')
        AND table_lock.reserved_during && tstzrange($3::timestamptz, $4::timestamptz, '[)')
      ORDER BY CASE table_lock.status WHEN 'confirmed' THEN 0 ELSE 1 END, table_lock.created_at
      LIMIT 1
    ) AS active_lock ON true
    WHERE venue_table.tenant_id = $1::uuid AND venue_table.store_id = $2::uuid
      AND venue_table.status = 'available' AND area.status = 'active'
      AND venue_table.capacity >= $5
    ORDER BY area.sort_order, area.code, venue_table.minimum_spend_minor NULLS FIRST,
      venue_table.capacity, venue_table.code
  `, [transaction.scope.tenantId, transaction.scope.storeId, arrivalAt, expectedEndAt, guestCount])
  return result.rows
}

async function insertPrivateContact(
  transaction: ScopedTransaction,
  reservationId: string,
  contact: ProtectedContact,
): Promise<void> {
  await transaction.query(`
    INSERT INTO mbox.reservation_private_contacts (
      reservation_id, tenant_id, store_id, contact_hash,
      encrypted_contact, encryption_key_id, masked_contact
    ) VALUES ($3::uuid, $1::uuid, $2::uuid, $4, decode($5, 'base64'), $6, $7)
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    reservationId,
    contact.hash,
    contact.encryptedBase64,
    contact.keyId,
    contact.masked,
  ])
}

async function enforceRateLimit(
  transaction: ScopedTransaction,
  action: 'availability' | 'reservation' | 'waitlist',
  principalHash: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const result = await transaction.query<{ attempt_count: number; expires_at: string }>(`
    INSERT INTO mbox.public_reservation_rate_limits (
      tenant_id, store_id, action, principal_hash, window_started_at, attempt_count, expires_at
    ) VALUES (
      $1::uuid, $2::uuid, $3, $4, clock_timestamp(), 1,
      clock_timestamp() + ($6::bigint * interval '1 millisecond')
    )
    ON CONFLICT (tenant_id, store_id, action, principal_hash)
    DO UPDATE SET
      attempt_count = CASE WHEN mbox.public_reservation_rate_limits.expires_at <= clock_timestamp()
        THEN 1 ELSE LEAST(mbox.public_reservation_rate_limits.attempt_count + 1, $5 + 1) END,
      window_started_at = CASE WHEN mbox.public_reservation_rate_limits.expires_at <= clock_timestamp()
        THEN clock_timestamp() ELSE mbox.public_reservation_rate_limits.window_started_at END,
      expires_at = CASE WHEN mbox.public_reservation_rate_limits.expires_at <= clock_timestamp()
        THEN clock_timestamp() + ($6::bigint * interval '1 millisecond')
        ELSE mbox.public_reservation_rate_limits.expires_at END
    RETURNING attempt_count, expires_at::text
  `, [transaction.scope.tenantId, transaction.scope.storeId, action, principalHash, limit, windowMs])
  const row = result.rows[0]
  if (!row) throw new Error('预约限频状态写入失败')
  if (Number(row.attempt_count) > limit) throw new PublicReservationRateLimitError(row.expires_at)
}

function groupPublicTables(rows: readonly AvailableTableRow[]): Array<{
  code: string
  name: string
  type: string
  tables: Array<{
    code: string
    name: string
    capacity: number
    minimumSpendMinor: number | null
    currency: string
    available: boolean
    status: 'available' | 'reserved' | 'locked'
  }>
}> {
  const groups = new Map<string, ReturnType<typeof groupPublicTables>[number]>()
  for (const row of rows) {
    const group = groups.get(row.area_code) ?? {
      code: row.area_code,
      name: row.area_name,
      type: row.area_type,
      tables: [],
    }
    group.tables.push({
      code: row.table_code,
      name: row.table_name,
      capacity: Number(row.capacity),
      minimumSpendMinor: row.minimum_spend_minor === null ? null : Number(row.minimum_spend_minor),
      currency: row.currency,
      available: row.availability_status === 'available',
      status: row.availability_status,
    })
    groups.set(row.area_code, group)
  }
  return [...groups.values()]
}

async function assertPreferredSchedule(
  transaction: ScopedTransaction,
  scheduleId: string | null,
  arrivalAt: string,
): Promise<void> {
  if (scheduleId === null) return
  const result = await transaction.query<{ id: string }>(`
    SELECT schedule.id
    FROM mbox.schedules AS schedule
    JOIN mbox.stores AS store
      ON store.tenant_id = schedule.tenant_id AND store.id = schedule.store_id
    WHERE schedule.tenant_id = $1::uuid AND schedule.store_id = $2::uuid
      AND schedule.id = $3::uuid AND schedule.status IN ('scheduled', 'performing')
      AND (schedule.starts_at AT TIME ZONE store.timezone)::date
        = ($4::timestamptz AT TIME ZONE store.timezone)::date
    FOR KEY SHARE OF schedule
  `, [transaction.scope.tenantId, transaction.scope.storeId, scheduleId, arrivalAt])
  if (result.rowCount !== 1) {
    throw new PublicReservationRequestError('所选演出已改期或取消，请返回上一步重新选择')
  }
}

function publicDepositRule(policy: ReservationPolicyRow, minimumSpendMinor: number | null): JsonObject {
  const amount = policy.deposit_mode === 'flat'
    ? Number(policy.deposit_minor ?? 0)
    : policy.deposit_mode === 'minimum_spend_ratio' && minimumSpendMinor !== null
      ? Math.ceil(minimumSpendMinor * Number(policy.deposit_ratio_bps ?? 0) / 10_000)
      : 0
  return {
    enabled: policy.deposit_mode !== 'disabled',
    mode: policy.deposit_mode,
    amountMinor: amount,
    ruleText: policy.deposit_rule_text,
    policyVersion: policy.policy_version,
  }
}

function publicReservation(reservation: Reservation, maskedContact: string): JsonObject {
  return {
    publicId: reservation.publicId,
    customerName: reservation.customerName,
    maskedContact,
    guestCount: reservation.guestCount,
    arrivalAt: reservation.arrivalAt,
    expectedEndAt: reservation.expectedEndAt,
    status: reservation.status,
    arrivalState: reservation.status === 'arrived' || reservation.status === 'seated'
      ? 'arrived'
      : 'not_arrived',
    note: reservation.note,
    seatPreference: reservation.seatPreference,
    arrivalGraceEndsAt: reservation.arrivalGraceEndsAt,
    reservationPolicyVersion: reservation.reservationPolicyVersion,
    preferredScheduleId: reservation.preferredScheduleId,
    priorityBooking: reservation.annualPriorityRuleId === null || reservation.annualPriorityRuleId === undefined
      ? null : { requestHoldMinutes: reservation.annualPriorityHoldMinutes ?? null },
    cancellationPolicy: reservation.cancellationPolicySnapshot,
  }
}

function publicWaitlist(entry: WaitlistEntry): JsonObject {
  return {
    publicId: entry.publicId,
    customerName: entry.customerName,
    maskedContact: entry.maskedContact,
    guestCount: entry.guestCount,
    desiredArrivalAt: entry.desiredArrivalAt,
    status: entry.status,
    arrivalState: entry.status === 'arrived' || entry.status === 'seated' ? 'arrived' : 'not_arrived',
    note: entry.note,
    priorityBooking: entry.annualPriorityRuleId === null ? null : {
      requestHoldMinutes: entry.annualPriorityHoldMinutes,
    },
  }
}

function publicDailyPerformance(view: DailyPerformanceView): JsonObject {
  const publicSchedule = (schedule: DailyPerformanceView['schedules'][number]): JsonObject => ({
    id: schedule.id,
    performerStageName: schedule.performerStageName,
    performerProfile: publicPerformerProfile(schedule.performerProfileSnapshot),
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    status: schedule.status,
    sortOrder: schedule.sortOrder,
  })
  return {
    timezone: view.timezone,
    localDate: view.localDate,
    phase: view.phase,
    current: view.current === null ? null : publicSchedule(view.current),
    next: view.next === null ? null : publicSchedule(view.next),
    startsInSeconds: view.startsInSeconds,
    remainingSeconds: view.remainingSeconds,
    schedules: view.schedules.map(publicSchedule),
  }
}

function publicPerformerProfile(profile: Record<string, unknown>): JsonObject {
  const result: Record<string, string | string[]> = {}
  for (const key of ['bio', 'imageUrl'] as const) {
    const value = profile[key]
    if (typeof value === 'string') result[key] = value
  }
  for (const key of ['genres', 'styles', 'highlights'] as const) {
    const value = profile[key]
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) result[key] = value
  }
  return result
}

function reservationEvent(reservation: Reservation): JsonObject {
  return {
    publicId: reservation.publicId,
    guestCount: reservation.guestCount,
    arrivalAt: reservation.arrivalAt,
    expectedEndAt: reservation.expectedEndAt,
    status: reservation.status,
    source: reservation.source,
    seatPreference: reservation.seatPreference,
    preferredScheduleId: reservation.preferredScheduleId,
    reservationPolicyVersion: reservation.reservationPolicyVersion,
    reservationPolicyAcknowledgedVersion: reservation.reservationPolicyAcknowledgedVersion,
    priorityBooking: reservation.annualPriorityRuleId === null || reservation.annualPriorityRuleId === undefined
      ? null : { requestHoldMinutes: reservation.annualPriorityHoldMinutes ?? null },
    tableCodes: reservation.tableLocks.map((lock) => lock.tableCode),
  }
}

function reservationArrivalGraceMinutes(reservation: Reservation): number {
  return Math.max(1, Math.round(
    (Date.parse(reservation.arrivalGraceEndsAt) - Date.parse(reservation.arrivalAt)) / 60_000,
  ))
}

const reservationCodec: JsonCodec<Reservation> = {
  encode: (reservation) => ({
    id: reservation.id,
    publicId: reservation.publicId,
    customerId: reservation.customerId,
    customerName: reservation.customerName,
    contactToken: reservation.contactToken,
    guestCount: reservation.guestCount,
    arrivalAt: reservation.arrivalAt,
    expectedEndAt: reservation.expectedEndAt,
    status: reservation.status,
    source: reservation.source,
    ownerEmployeeId: reservation.ownerEmployeeId,
    note: reservation.note,
    seatPreference: reservation.seatPreference,
    reservationSnapshot: reservation.reservationSnapshot,
    createdAt: reservation.createdAt,
    updatedAt: reservation.updatedAt,
    aggregateVersion: reservation.aggregateVersion,
    customerCancelUntil: reservation.customerCancelUntil,
    cancellationPolicySnapshot: reservation.cancellationPolicySnapshot,
    requestHoldExpiresAt: reservation.requestHoldExpiresAt,
    arrivalGraceEndsAt: reservation.arrivalGraceEndsAt,
    reservationPolicyVersion: reservation.reservationPolicyVersion,
    reservationPolicyAcknowledgedVersion: reservation.reservationPolicyAcknowledgedVersion,
    preferredScheduleId: reservation.preferredScheduleId,
    annualPriorityRuleId: reservation.annualPriorityRuleId ?? null,
    annualPriorityHoldMinutes: reservation.annualPriorityHoldMinutes ?? null,
    tableLocks: reservation.tableLocks.map((lock) => ({ ...lock })),
  }),
  decode: (value) => {
    if (!isObject(value) || typeof value.id !== 'string' || !Array.isArray(value.tableLocks)) {
      throw new TypeError('Stored reservation result is invalid')
    }
    return value as unknown as Reservation
  },
}

const priorityQueueOverrideCodec: JsonCodec<PriorityQueueOverride> = {
  encode: (value) => ({
    id: value.id,
    targetKind: value.targetKind,
    publicId: value.publicId,
    mode: value.mode,
    reason: value.reason,
    createdAt: value.createdAt,
  }),
  decode: (value) => {
    if (!isObject(value) || typeof value.id !== 'string' || typeof value.publicId !== 'string'
      || (value.targetKind !== 'reservation' && value.targetKind !== 'waitlist')
      || (value.mode !== 'promote' && value.mode !== 'demote' && value.mode !== 'clear')
      || typeof value.reason !== 'string' || typeof value.createdAt !== 'string') {
      throw new TypeError('Stored priority queue override result is invalid')
    }
    return value as unknown as PriorityQueueOverride
  },
}

async function findVisiblePriorityQueueTarget(
  transaction: ScopedTransaction,
  context: PublicReservationStaffContext,
  targetKind: PriorityQueueTargetKind,
  publicId: string,
): Promise<{ id: string; publicId: string } | null> {
  const table = targetKind === 'reservation' ? 'mbox.reservations' : 'mbox.waitlist_entries'
  const liveStatuses = targetKind === 'reservation'
    ? ['pending', 'confirmed', 'arrived']
    : ['waiting', 'notified', 'arrived']
  const result = await transaction.query<{ id: string; public_id: string }>(`
    SELECT id,public_id
    FROM ${table}
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
      AND status=ANY($4::text[])
      AND ($5::boolean OR owner_employee_id=ANY($6::uuid[]))
    FOR KEY SHARE
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    publicId,
    liveStatuses,
    context.permissions.includes('reservation.view.all'),
    [...context.visibleOwnerEmployeeIds],
  ])
  const row = result.rows[0]
  return row === undefined ? null : { id: row.id, publicId: row.public_id }
}

async function requireGuest(
  options: PublicReservationApiOptions,
  request: FastifyRequest,
  capability: string,
): Promise<PublicReservationGuestContext> {
  const context = await options.resolveGuest(request)
  if (!context.capabilities.includes(capability)) throw new PublicReservationOwnershipError()
  return context
}

function requirePermission(context: PublicReservationStaffContext, permission: string): void {
  if (!context.permissions.includes(permission)) throw new PublicReservationStaffPermissionError()
}

function readPriorityQueueTargetKind(value: string): PriorityQueueTargetKind {
  if (value === 'reservation' || value === 'waitlist') return value
  throw new PublicReservationRequestError('队列对象必须是预约或候位记录')
}

function readPriorityQueueOverrideMode(value: unknown): PriorityQueueOverrideMode {
  if (value === 'promote' || value === 'demote' || value === 'clear') return value
  throw new PublicReservationRequestError('队列调整方式必须是上调、下调或恢复默认')
}

async function handle(reply: FastifyReply, operation: () => Promise<FastifyReply>): Promise<FastifyReply> {
  try {
    reply.header('cache-control', 'no-store')
    return await operation()
  } catch (error) {
    const mapped = mapError(error)
    return reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message, retryAt: mapped.retryAt } })
  }
}

function mapError(error: unknown): { status: number; code: string; message: string; retryAt?: string } {
  if (error instanceof ReservationGuestRateLimitError || error instanceof PublicReservationRateLimitError) {
    return { status: 429, code: 'PUBLIC_RESERVATION_RATE_LIMITED', message: error.message, retryAt: error.retryAt }
  }
  if (error instanceof ReservationGuestSessionInvalidError) {
    return { status: 401, code: 'RESERVATION_SESSION_INVALID', message: error.message }
  }
  if (error instanceof PublicReservationStaffPermissionError) {
    return { status: 403, code: 'RESERVATION_PERMISSION_DENIED', message: error.message }
  }
  if (error instanceof PublicReservationOwnershipError || error instanceof WaitlistNotFoundError) {
    return { status: 404, code: 'RESERVATION_NOT_FOUND', message: error.message }
  }
  if (error instanceof PublicReservationCapacityUnavailableError) {
    return { status: 409, code: 'RESERVATION_CAPACITY_FULL', message: error.message }
  }
  if (error instanceof PublicReservationPolicyVersionConflictError) {
    return { status: 409, code: 'RESERVATION_POLICY_CHANGED', message: error.message }
  }
  if (error instanceof ReservationConflictError || error instanceof ReservationTableUnavailableError) {
    return { status: 409, code: 'TABLE_ALREADY_RESERVED', message: '这个位置刚刚被预订，请重新选择' }
  }
  if (error instanceof ReservationHoldExpiredError) {
    return { status: 409, code: 'RESERVATION_HOLD_EXPIRED', message: '座位保留时间已结束，请重新选择' }
  }
  if (error instanceof ReservationCancellationPolicyError) {
    return { status: 409, code: 'RESERVATION_CANCEL_REQUIRES_STAFF', message: '该预约需要联系门店协助取消' }
  }
  if (error instanceof ReservationTransitionError || error instanceof WaitlistTransitionError) {
    return { status: 409, code: 'RESERVATION_STATE_CONFLICT', message: error.message }
  }
  if (error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError) {
    return { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: '本次操作正在处理中，请勿重复提交' }
  }
  if (postgresCode(error) === '23505') {
    return { status: 409, code: 'ACTIVE_WAITLIST_EXISTS', message: '这个联系方式已经有一条候位记录' }
  }
  if (error instanceof PublicReservationRequestError || error instanceof TypeError) {
    return { status: 400, code: 'PUBLIC_RESERVATION_REQUEST_INVALID', message: error.message }
  }
  return { status: 500, code: 'PUBLIC_RESERVATION_INTERNAL_ERROR', message: '预约服务暂时繁忙，请稍后再试' }
}

function setSessionCookie(reply: FastifyReply, result: ReservationGuestSessionIssueResult): void {
  const expires = new Date(result.session.expiresAt)
  const maxAge = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000))
  reply.header('set-cookie', [
    `mbox_reservation_session=${result.sessionToken}`,
    'Path=/api/public',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`,
    `Max-Age=${maxAge}`,
  ].join('; '))
}

function validateReservationWindow(arrivalAt: string, expectedEndAt: string, current: Date, maxDays: number): void {
  const start = Date.parse(arrivalAt)
  const end = Date.parse(expectedEndAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new PublicReservationRequestError('预计结束时间必须晚于到店时间')
  }
  if (start <= current.getTime()) throw new PublicReservationRequestError('到店时间必须晚于当前时间')
  if (start > current.getTime() + maxDays * 86_400_000) {
    throw new PublicReservationRequestError(`最多可提前${maxDays}天预约`)
  }
}

function validatePublicPerformanceDate(value: string, currentBusinessDate: string, maxDays: number): void {
  const requested = Date.parse(`${value}T00:00:00.000Z`)
  const current = Date.parse(`${currentBusinessDate}T00:00:00.000Z`)
  if (!Number.isFinite(requested) || !Number.isFinite(current)) {
    throw new PublicReservationRequestError('演出日期格式无效')
  }
  const days = Math.round((requested - current) / 86_400_000)
  if (days < 0 || days > maxDays) {
    throw new PublicReservationRequestError(`仅可查询今天起${maxDays}天内的演出`)
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function hashActor(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function readObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new PublicReservationRequestError('请求正文必须是JSON对象')
  return value
}

function readQuery(request: FastifyRequest): Record<string, unknown> {
  return isObject(request.query) ? request.query : {}
}

function readBusinessDate(value: unknown, label: string): string {
  const normalized = readString(value, label, 10, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new PublicReservationRequestError(`${label}格式无效`)
  }
  const instant = new Date(`${normalized}T00:00:00.000Z`)
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== normalized) {
    throw new PublicReservationRequestError(`${label}格式无效`)
  }
  return normalized
}

function readString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new PublicReservationRequestError(`${label}格式无效`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new PublicReservationRequestError(`${label}长度无效`)
  }
  return normalized
}

function readOptionalString(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return readString(value, label, 1, maximum)
}

function readOptionalUuid(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  const normalized = readString(value, label, 36, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new PublicReservationRequestError(`${label}格式无效`)
  }
  return normalized
}

function readInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isInteger(number) || Number(number) < minimum || Number(number) > maximum) {
    throw new PublicReservationRequestError(`${label}格式无效`)
  }
  return Number(number)
}

function readTimestamp(value: unknown, label: string): string {
  const text = readString(value, label, 10, 64)
  if (!Number.isFinite(Date.parse(text))) throw new PublicReservationRequestError(`${label}格式无效`)
  return new Date(text).toISOString()
}

function readEnum<const Values extends readonly string[]>(
  value: unknown,
  label: string,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new PublicReservationRequestError(`${label}格式无效`)
  }
  return value as Values[number]
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (Array.isArray(value)) throw new PublicReservationRequestError('幂等键格式无效')
  return readString(value, '幂等键', 8, 128)
}

function readPublicId(value: string): string {
  return readString(value, '预约编号', 8, 128)
}

function rejectClaims(body: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (body[field] !== undefined) throw new PublicReservationRequestError(`不能提交字段：${field}`)
  }
}

function postgresCode(error: unknown): string | undefined {
  if (!isObject(error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
