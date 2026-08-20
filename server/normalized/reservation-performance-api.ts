import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { JsonObject, JsonValue } from './command-executor.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
} from './command-executor.js'
import type { PerformanceCommandService } from './performance-command-service.js'
import {
  PerformerNotFoundError,
  PerformerRepository,
  type Performer,
  type PerformerStatus,
} from './performer-repository.js'
import {
  PerformerSongNotFoundError,
  PerformerSongRepository,
  type PerformerSongInput,
  type PerformerSongStatus,
} from './performer-song-repository.js'
import type { ReservationCommandService } from './reservation-command-service.js'
import {
  ReservationConflictError,
  ReservationCancellationPolicyError,
  ReservationCustomerNotFoundError,
  ReservationHoldExpiredError,
  ReservationLockUnavailableError,
  ReservationNotFoundError,
  ReservationRepository,
  ReservationTransitionError,
  ReservationTableUnavailableError,
  type Reservation,
  type ReservationSeatPreference,
  type ReservationSource,
  type ReservationStatus,
} from './reservation-repository.js'
import {
  ScheduleConflictError,
  ScheduleNotFoundError,
  ScheduleRepository,
  type DailyPerformanceView,
  ScheduleTransitionError,
  type ScheduleStatus,
} from './schedule-repository.js'
import {
  SongRequestEligibilityError,
  SongRequestCustomerSessionError,
  SongRequestNotFoundError,
  SongRequestPaymentEvidenceError,
  SongRequestRepository,
  SongRequestTransitionError,
  type SongRequest,
  type SongRequestStatus,
  type SongRequestType,
} from './song-request-repository.js'
import {
  StaffAccessDeniedError,
  StaffAccessRepository,
  type EffectiveStaffAccess,
  StaffNotFoundError,
} from './staff-access-repository.js'
import {
  NormalizedAuthenticationRequiredError,
  NormalizedStoreUnavailableError,
  TrustedStoreScopeError,
} from './normalized-request-context.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

export interface GuestReservationPerformanceContext {
  scope: Readonly<StoreScope>
  customerId: string
  tableSessionId: string | null
  businessDate: string
  actorRef: string
}

export interface StaffReservationPerformanceContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

type ReservationCommands = Pick<ReservationCommandService, 'create' | 'confirm' | 'arrive' | 'cancel'>
type PerformanceCommands = Pick<
  PerformanceCommandService,
  | 'createPerformer'
  | 'updatePerformer'
  | 'importPerformerSongs'
  | 'updatePerformerSong'
  | 'createSchedule'
  | 'updateSchedule'
  | 'transitionSchedule'
  | 'submitSongRequest'
  | 'confirmSongRequest'
  | 'rejectSongRequest'
  | 'markSongRequestPaid'
  | 'markSongRequestPerformed'
  | 'cancelSongRequest'
>
type StaffAccessPort = Pick<StaffAccessRepository, 'assertPermission'>
type ReservationRepositoryPort = Pick<ReservationRepository, 'findById' | 'findByPublicId'>
type PerformerRepositoryPort = Pick<PerformerRepository, 'findById'>
type PerformerSongRepositoryPort = Pick<PerformerSongRepository, 'list'>
type ScheduleRepositoryPort = Pick<ScheduleRepository, 'getDailyView'>
type SongRequestRepositoryPort = Pick<SongRequestRepository, 'findById'>

export interface ReservationPerformanceApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  reservations: ReservationCommands
  performance: PerformanceCommands
  resolveGuestContext(request: FastifyRequest): Promise<GuestReservationPerformanceContext>
    | GuestReservationPerformanceContext
  resolveStaffContext(request: FastifyRequest): Promise<StaffReservationPerformanceContext>
    | StaffReservationPerformanceContext
  createStaffAccessRepository?(transaction: ScopedTransaction): StaffAccessPort
  createReservationRepository?(transaction: ScopedTransaction): ReservationRepositoryPort
  createPerformerRepository?(transaction: ScopedTransaction): PerformerRepositoryPort
  createPerformerSongRepository?(transaction: ScopedTransaction): PerformerSongRepositoryPort
  createScheduleRepository?(transaction: ScopedTransaction): ScheduleRepositoryPort
  createSongRequestRepository?(transaction: ScopedTransaction): SongRequestRepositoryPort
  createPublicId?: (kind: 'reservation') => string
  now?: () => string
  reservationHoldTtlMinutes?: number
  reservationMaxAdvanceDays?: number
  customerCancellationCutoffMinutes?: number
}

interface AuthorizedStaffContext extends StaffReservationPerformanceContext {
  access: EffectiveStaffAccess
}

interface IdRow extends Record<string, unknown> {
  id: string
}

interface ApiErrorBody {
  error: { code: string; message: string }
}

class ApiRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

class GuestResourceNotFoundError extends Error {
  constructor() {
    super('未找到对应信息')
    this.name = 'GuestResourceNotFoundError'
  }
}

export const reservationPerformanceApiPlugin: FastifyPluginAsync<ReservationPerformanceApiOptions> = async (
  app,
  options,
) => {
  const now = options.now ?? (() => new Date().toISOString())
  const holdTtlMinutes = boundedConfiguration(
    options.reservationHoldTtlMinutes,
    'reservationHoldTtlMinutes',
    20,
    5,
    30,
  )
  const maxAdvanceDays = boundedConfiguration(
    options.reservationMaxAdvanceDays,
    'reservationMaxAdvanceDays',
    90,
    1,
    365,
  )
  const cancellationCutoffMinutes = boundedConfiguration(
    options.customerCancellationCutoffMinutes,
    'customerCancellationCutoffMinutes',
    120,
    0,
    10_080,
  )
  const createPublicId = options.createPublicId ?? (() => `reservation-${randomUUID()}`)
  const createAccess = options.createStaffAccessRepository ?? ((tx) => new StaffAccessRepository(tx))
  const createReservations = options.createReservationRepository ?? ((tx) => new ReservationRepository(tx))
  const createPerformers = options.createPerformerRepository ?? ((tx) => new PerformerRepository(tx))
  const createPerformerSongs = options.createPerformerSongRepository ?? ((tx) => new PerformerSongRepository(tx))
  const createSchedules = options.createScheduleRepository ?? ((tx) => new ScheduleRepository(tx))
  const createSongRequests = options.createSongRequestRepository ?? ((tx) => new SongRequestRepository(tx))

  app.get('/guest/reservations', async (request, reply) => handleRoute(reply, async () => {
    const context = await guestContext(options, request)
    const reservations = await options.transactions.run(context.scope, async (transaction) => {
      const ids = await transaction.query<IdRow>(`
        SELECT id FROM mbox.reservations
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND customer_id = $3::uuid
        ORDER BY arrival_at DESC, id DESC
        LIMIT 100
      `, [context.scope.tenantId, context.scope.storeId, context.customerId])
      return hydrateReservations(createReservations(transaction), ids.rows)
    }, { readOnly: true })
    return reply.send({ data: reservations.map(publicReservation) })
  }))

  app.get<{ Params: { publicId: string } }>(
    '/guest/reservations/:publicId',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await guestContext(options, request)
      const publicId = readPublicId(request.params.publicId)
      const reservation = await options.transactions.run(context.scope, async (transaction) => (
        createReservations(transaction).findByPublicId(publicId)
      ), { readOnly: true })
      if (reservation === null || reservation.customerId !== context.customerId) {
        throw new GuestResourceNotFoundError()
      }
      return reply.send({ data: publicReservation(reservation) })
    }),
  )

  app.post('/guest/reservations', async (request, reply) => handleRoute(reply, async () => {
    const context = await guestContext(options, request)
    const body = readObject(request.body)
    rejectClaims(body, [
      'customerId', 'source', 'ownerEmployeeId', 'actor', 'scope', 'publicId',
      'holdExpiresAt', 'customerCancelUntil', 'cancellationPolicySnapshot',
    ])
    const idempotencyKey = readIdempotencyKey(request)
    const input = readReservationInput(body)
    const timing = serverReservationTiming(
      input.arrivalAt,
      now(),
      holdTtlMinutes,
      maxAdvanceDays,
      cancellationCutoffMinutes,
    )
    const execution = await options.reservations.create({
      scope: context.scope,
      actor: { type: 'guest', ref: context.actorRef },
      businessDate: context.businessDate,
      idempotencyKey,
      requestFingerprint: fingerprint(request, context, input),
      publicId: createPublicId('reservation'),
      customerId: context.customerId,
      customerName: input.customerName,
      contactToken: input.contactToken,
      guestCount: input.guestCount,
      arrivalAt: input.arrivalAt,
      expectedEndAt: input.expectedEndAt,
      source: 'wechat',
      note: input.note,
      seatPreference: input.seatPreference,
      reservationSnapshot: input.reservationSnapshot,
      tableIds: input.tableIds,
      initialStatus: 'pending',
      holdExpiresAt: timing.holdExpiresAt,
      customerCancelUntil: timing.customerCancelUntil,
      cancellationPolicySnapshot: timing.policySnapshot,
    })
    return reply.code(execution.replayed ? 200 : 201).send({
      data: publicReservation(execution.value),
      meta: { replayed: execution.replayed, tableLockMode: 'held' },
    })
  }))

  app.delete<{ Params: { publicId: string } }>(
    '/guest/reservations/:publicId',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await guestContext(options, request)
      const body = readOptionalObject(request.body)
      rejectClaims(body, ['customerId', 'actor', 'scope'])
      const publicId = readPublicId(request.params.publicId)
      const reservation = await options.transactions.run(context.scope, async (transaction) => (
        createReservations(transaction).findByPublicId(publicId)
      ), { readOnly: true })
      if (reservation === null || reservation.customerId !== context.customerId) {
        throw new GuestResourceNotFoundError()
      }
      const idempotencyKey = readIdempotencyKey(request)
      const reason = readOptionalString(body.reason, '取消原因', 500)
      const execution = await options.reservations.cancel({
        scope: context.scope,
        actor: { type: 'guest', ref: context.actorRef },
        businessDate: context.businessDate,
        reservationId: reservation.id,
        reason,
        idempotencyKey,
        requestFingerprint: fingerprint(request, context, { publicId, reason }),
      })
      return reply.send({ data: publicReservation(execution.value), meta: { replayed: execution.replayed } })
    }),
  )

  app.get('/guest/performances/today', async (request, reply) => handleRoute(reply, async () => {
    const context = await guestContext(options, request)
    const view = await options.transactions.run(context.scope, (transaction) => (
      createSchedules(transaction).getDailyView(context.businessDate, now())
    ), { readOnly: true })
    return reply.send({ data: publicDailyPerformance(view) })
  }))

  app.post('/guest/song-requests', async (request, reply) => handleRoute(reply, async () => {
    const context = await guestContext(options, request)
    if (context.tableSessionId === null) throw new SongRequestEligibilityError('点歌需要有效的开台桌次')
    const body = readObject(request.body)
    rejectClaims(body, ['customerId', 'tableSessionId', 'actor', 'scope', 'requestedAt'])
    const idempotencyKey = readIdempotencyKey(request)
    const input = readSongSubmission(body)
    const execution = await options.performance.submitSongRequest({
      scope: context.scope,
      actor: { type: 'guest', ref: context.actorRef },
      businessDate: context.businessDate,
      idempotencyKey,
      requestFingerprint: fingerprint(request, context, input),
      tableSessionId: context.tableSessionId,
      customerId: context.customerId,
      scheduleId: input.scheduleId,
      songTitle: input.songTitle,
      requestType: input.requestType,
      note: input.note,
      requestedAt: now(),
      requestExtension: input.requestExtension,
    })
    return reply.code(execution.replayed ? 200 : 201).send({
      data: publicSongRequestSubmission(execution.value),
      meta: { replayed: execution.replayed },
    })
  }))

  app.delete<{ Params: { requestId: string } }>(
    '/guest/song-requests/:requestId',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await guestContext(options, request)
      const requestId = readUuid(request.params.requestId, 'requestId')
      if (context.tableSessionId === null) throw new GuestResourceNotFoundError()
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.performance.cancelSongRequest({
        scope: context.scope,
        actor: { type: 'guest', ref: context.actorRef },
        businessDate: context.businessDate,
        requestId,
        customerId: context.customerId,
        tableSessionId: context.tableSessionId,
        idempotencyKey,
        requestFingerprint: fingerprint(request, context, { requestId }),
      })
      return reply.send({ data: publicSongRequest(execution.value), meta: { replayed: execution.replayed } })
    }),
  )

  app.get('/staff/reservations', async (request, reply) => handleRoute(reply, async () => {
    const context = await authorizedStaff(options, request, 'reservation.view', createAccess)
    const query = readQuery(request)
    const status = readOptionalReservationStatus(query.status)
    const from = readOptionalTimestamp(query.from, 'from')
    const to = readOptionalTimestamp(query.to, 'to')
    if (from !== null && to !== null && Date.parse(to) <= Date.parse(from)) {
      throw new ApiRequestError('to必须晚于from')
    }
    const visibility = reservationVisibility(context)
    const reservations = await options.transactions.run(context.scope, async (transaction) => {
      const ids = await transaction.query<IdRow>(`
        SELECT reservation.id FROM mbox.reservations AS reservation
        WHERE reservation.tenant_id = $1::uuid AND reservation.store_id = $2::uuid
          AND ($3::text IS NULL OR reservation.status = $3)
          AND ($4::timestamptz IS NULL OR reservation.arrival_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR reservation.arrival_at < $5::timestamptz)
          AND (
            $4::timestamptz IS NOT NULL OR $5::timestamptz IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM mbox.stores AS reservation_store
              WHERE reservation_store.tenant_id=reservation.tenant_id
                AND reservation_store.id=reservation.store_id
                AND reservation.arrival_at >= (($9::date::timestamp + reservation_store.business_day_cutoff)
                  AT TIME ZONE reservation_store.timezone)
                AND reservation.arrival_at < ((($9::date + 1)::timestamp + reservation_store.business_day_cutoff)
                  AT TIME ZONE reservation_store.timezone)
            )
          )
          AND (
            $6::boolean
            OR reservation.owner_employee_id = ANY($7::uuid[])
            OR EXISTS (
              SELECT 1
              FROM mbox.reservation_table_locks AS table_lock
              JOIN mbox.tables AS venue_table
                ON venue_table.tenant_id = table_lock.tenant_id
                AND venue_table.store_id = table_lock.store_id
                AND venue_table.id = table_lock.table_id
              WHERE table_lock.tenant_id = reservation.tenant_id
                AND table_lock.store_id = reservation.store_id
                AND table_lock.reservation_id = reservation.id
                AND venue_table.area_id = ANY($8::uuid[])
            )
          )
        ORDER BY reservation.arrival_at ASC, reservation.id ASC
        LIMIT 500
      `, [
        context.scope.tenantId,
        context.scope.storeId,
        status,
        from,
        to,
        visibility.all,
        visibility.ownerEmployeeIds,
        visibility.areaIds,
        context.businessDate,
      ])
      return hydrateReservations(createReservations(transaction), ids.rows)
    }, { readOnly: true })
    const canViewContact = context.access.permissions.includes('reservation.contact.view')
    return reply.send({ data: reservations.map((reservation) => staffReservation(reservation, canViewContact)) })
  }))

  app.post('/staff/reservations', async (request, reply) => handleRoute(reply, async () => {
    const context = await authorizedStaff(options, request, 'reservation.manage', createAccess)
    const body = readObject(request.body)
    rejectClaims(body, ['actor', 'scope'])
    const idempotencyKey = readIdempotencyKey(request)
    rejectClaims(body, ['holdExpiresAt', 'customerCancelUntil', 'cancellationPolicySnapshot'])
    const input = readReservationInput(body)
    const source = readReservationSource(body.source)
    const initialStatus = readInitialReservationStatus(body.initialStatus)
    const timing = serverReservationTiming(
      input.arrivalAt,
      now(),
      holdTtlMinutes,
      maxAdvanceDays,
      cancellationCutoffMinutes,
    )
    const execution = await options.reservations.create({
      scope: context.scope,
      actor: employeeActor(context.employeeId),
      businessDate: context.businessDate,
      idempotencyKey,
      requestFingerprint: fingerprint(request, context, { ...input, source, initialStatus }),
      publicId: input.publicId ?? createPublicId('reservation'),
      customerId: readOptionalUuid(body.customerId, 'customerId'),
      customerName: input.customerName,
      contactToken: input.contactToken,
      guestCount: input.guestCount,
      arrivalAt: input.arrivalAt,
      expectedEndAt: input.expectedEndAt,
      source,
      ownerEmployeeId: readOptionalUuid(body.ownerEmployeeId, 'ownerEmployeeId') ?? context.employeeId,
      note: input.note,
      seatPreference: input.seatPreference,
      reservationSnapshot: input.reservationSnapshot,
      tableIds: input.tableIds,
      initialStatus,
      holdExpiresAt: initialStatus === 'pending' ? timing.holdExpiresAt : null,
      customerCancelUntil: timing.customerCancelUntil,
      cancellationPolicySnapshot: timing.policySnapshot,
    })
    return reply.code(execution.replayed ? 200 : 201).send({
      data: execution.value,
      meta: { replayed: execution.replayed },
    })
  }))

  for (const transition of ['confirm', 'arrive'] as const) {
    app.post<{ Params: { reservationId: string } }>(
      `/staff/reservations/:reservationId/${transition}`,
      async (request, reply) => handleRoute(reply, async () => {
        const context = await authorizedStaff(options, request, 'reservation.manage', createAccess)
        const body = readOptionalObject(request.body)
        rejectClaims(body, ['employeeId', 'actor', 'scope'])
        const reservationId = readUuid(request.params.reservationId, 'reservationId')
        const reason = readOptionalString(body.reason, '原因', 500)
        const idempotencyKey = readIdempotencyKey(request)
        const execution = await options.reservations[transition]({
          scope: context.scope,
          actor: employeeActor(context.employeeId),
          businessDate: context.businessDate,
          reservationId,
          reason,
          idempotencyKey,
          requestFingerprint: fingerprint(request, context, { reservationId, transition, reason }),
        })
        return reply.send({ data: execution.value, meta: { replayed: execution.replayed } })
      }),
    )
  }

  app.post<{ Params: { reservationId: string } }>(
    '/staff/reservations/:reservationId/cancel',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await authorizedStaff(options, request, 'reservation.manage', createAccess)
      const body = readOptionalObject(request.body)
      rejectClaims(body, ['employeeId', 'actor', 'scope'])
      const reservationId = readUuid(request.params.reservationId, 'reservationId')
      const overridePolicy = body.overridePolicy === undefined
        ? false
        : readBoolean(body.overridePolicy, 'overridePolicy')
      const reason = readOptionalString(body.reason, '原因', 500)
      if (overridePolicy) {
        requireAccessPermission(context.access, 'reservation.cancel.override')
        if (reason === null) throw new ApiRequestError('例外取消必须填写原因')
      }
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.reservations.cancel({
        scope: context.scope,
        actor: employeeActor(context.employeeId),
        businessDate: context.businessDate,
        reservationId,
        reason,
        overridePolicy,
        idempotencyKey,
        requestFingerprint: fingerprint(request, context, { reservationId, reason, overridePolicy }),
      })
      return reply.send({ data: execution.value, meta: { replayed: execution.replayed } })
    }),
  )

  app.get('/staff/performers', async (request, reply) => handleRoute(reply, async () => {
    const context = await authorizedStaff(options, request, 'song.view', createAccess)
    const performers = await options.transactions.run(context.scope, async (transaction) => {
      const ids = await transaction.query<IdRow>(`
        SELECT id FROM mbox.performers
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        ORDER BY stage_name, code, id
      `, [context.scope.tenantId, context.scope.storeId])
      const repository = createPerformers(transaction)
      const values: Performer[] = []
      for (const row of ids.rows) {
        const performer = await repository.findById(row.id)
        if (performer !== null) values.push(performer)
      }
      return values
    }, { readOnly: true })
    return reply.send({ data: performers })
  }))

  app.post('/staff/performers', async (request, reply) => handleRoute(reply, async () => {
    const context = await authorizedStaff(options, request, 'song.manage', createAccess)
    const body = readObject(request.body)
    rejectClaims(body, ['employeeId', 'actor', 'scope'])
    const idempotencyKey = readIdempotencyKey(request)
    const input = readPerformerCreate(body)
    const execution = await options.performance.createPerformer({
      ...input,
      scope: context.scope,
      actor: employeeActor(context.employeeId),
      businessDate: context.businessDate,
      idempotencyKey,
      requestFingerprint: fingerprint(request, context, input),
    })
    return reply.code(execution.replayed ? 200 : 201).send({ data: execution.value, meta: { replayed: execution.replayed } })
  }))

  app.patch<{ Params: { performerId: string } }>(
    '/staff/performers/:performerId',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await authorizedStaff(options, request, 'song.manage', createAccess)
      const body = readObject(request.body)
      rejectClaims(body, ['employeeId', 'actor', 'scope'])
      const performerId = readUuid(request.params.performerId, 'performerId')
      const input = readPerformerUpdate(body, performerId)
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.performance.updatePerformer({
        ...input,
        scope: context.scope,
        actor: employeeActor(context.employeeId),
        businessDate: context.businessDate,
        idempotencyKey,
        requestFingerprint: fingerprint(request, context, input),
      })
      return reply.send({ data: execution.value, meta: { replayed: execution.replayed } })
    }),
  )

  app.get<{ Params: { performerId: string } }>(
    '/staff/performers/:performerId/songs',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await authorizedStaff(options, request, 'song.view', createAccess)
      const performerId = readUuid(request.params.performerId, 'performerId')
      const query = readQuery(request)
      const search = query.search === undefined ? '' : readString(query.search, 'search', 120, 0)
      const limit = readQueryInteger(query.limit, 'limit', 1, 1000, 200)
      const songs = await options.transactions.run(context.scope, (transaction) => (
        createPerformerSongs(transaction).list(performerId, search, limit)
      ), { readOnly: true })
      return reply.send({ data: songs })
    }),
  )

  app.post<{ Params: { performerId: string } }>(
    '/staff/performers/:performerId/songs/import',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await authorizedStaff(options, request, 'song.manage', createAccess)
      const performerId = readUuid(request.params.performerId, 'performerId')
      const body = readObject(request.body)
      rejectClaims(body, ['employeeId', 'actor', 'scope', 'performerId'])
      const input = readPerformerSongImport(body, performerId)
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.performance.importPerformerSongs({
        ...input,
        scope: context.scope,
        actor: employeeActor(context.employeeId),
        businessDate: context.businessDate,
        idempotencyKey,
        requestFingerprint: fingerprint(request, context, input),
      })
      return reply.code(execution.replayed ? 200 : 201).send({ data: execution.value, meta: { replayed: execution.replayed } })
    }),
  )

  app.patch<{ Params: { songId: string } }>(
    '/staff/songs/:songId',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await authorizedStaff(options, request, 'song.manage', createAccess)
      const songId = readUuid(request.params.songId, 'songId')
      const body = readObject(request.body)
      rejectClaims(body, ['employeeId', 'actor', 'scope', 'songId', 'performerId'])
      const changes = readPerformerSongUpdate(body)
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.performance.updatePerformerSong({
        songId,
        changes,
        scope: context.scope,
        actor: employeeActor(context.employeeId),
        businessDate: context.businessDate,
        idempotencyKey,
        requestFingerprint: fingerprint(request, context, { songId, changes }),
      })
      return reply.send({ data: execution.value, meta: { replayed: execution.replayed } })
    }),
  )

  app.get('/staff/performances/today', async (request, reply) => handleRoute(reply, async () => {
    const context = await authorizedStaff(options, request, 'song.view', createAccess)
    const view = await options.transactions.run(context.scope, (transaction) => (
      createSchedules(transaction).getDailyView(context.businessDate, now())
    ), { readOnly: true })
    return reply.send({ data: view })
  }))

  app.post('/staff/schedules', async (request, reply) => handleRoute(reply, async () => {
    const context = await authorizedStaff(options, request, 'song.manage', createAccess)
    const body = readObject(request.body)
    rejectClaims(body, ['employeeId', 'actor', 'scope'])
    const input = readScheduleCreate(body)
    const idempotencyKey = readIdempotencyKey(request)
    const execution = await options.performance.createSchedule({
      ...input,
      scope: context.scope,
      actor: employeeActor(context.employeeId),
      businessDate: context.businessDate,
      idempotencyKey,
      requestFingerprint: fingerprint(request, context, input),
    })
    return reply.code(execution.replayed ? 200 : 201).send({ data: execution.value, meta: { replayed: execution.replayed } })
  }))

  app.patch<{ Params: { scheduleId: string } }>(
    '/staff/schedules/:scheduleId',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await authorizedStaff(options, request, 'song.manage', createAccess)
      const body = readObject(request.body)
      rejectClaims(body, ['employeeId', 'actor', 'scope'])
      const scheduleId = readUuid(request.params.scheduleId, 'scheduleId')
      const input = readScheduleUpdate(body, scheduleId)
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.performance.updateSchedule({
        ...input,
        scope: context.scope,
        actor: employeeActor(context.employeeId),
        businessDate: context.businessDate,
        idempotencyKey,
        requestFingerprint: fingerprint(request, context, input),
      })
      return reply.send({ data: execution.value, meta: { replayed: execution.replayed } })
    }),
  )

  app.post<{ Params: { scheduleId: string } }>(
    '/staff/schedules/:scheduleId/status',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await authorizedStaff(options, request, 'song.manage', createAccess)
      const body = readObject(request.body)
      rejectClaims(body, ['employeeId', 'actor', 'scope'])
      const scheduleId = readUuid(request.params.scheduleId, 'scheduleId')
      const targetStatus = readScheduleTransition(body.targetStatus)
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.performance.transitionSchedule({
        scope: context.scope,
        actor: employeeActor(context.employeeId),
        businessDate: context.businessDate,
        scheduleId,
        targetStatus,
        idempotencyKey,
        requestFingerprint: fingerprint(request, context, { scheduleId, targetStatus }),
      })
      return reply.send({ data: execution.value, meta: { replayed: execution.replayed } })
    }),
  )

  app.get('/staff/song-requests', async (request, reply) => handleRoute(reply, async () => {
    const context = await authorizedStaff(options, request, 'song.view', createAccess)
    const query = readQuery(request)
    const status = readOptionalSongStatus(query.status)
    const requests = await options.transactions.run(context.scope, async (transaction) => {
      const ids = await transaction.query<IdRow>(`
        SELECT id FROM mbox.song_requests
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND ($3::text IS NULL OR status = $3)
        ORDER BY created_at DESC, id DESC
        LIMIT 500
      `, [context.scope.tenantId, context.scope.storeId, status])
      const repository = createSongRequests(transaction)
      const values: SongRequest[] = []
      for (const row of ids.rows) {
        const request = await repository.findById(row.id)
        if (request !== null) values.push(request)
      }
      return values
    }, { readOnly: true })
    return reply.send({ data: requests })
  }))

  app.post<{ Params: { requestId: string } }>(
    '/staff/song-requests/:requestId/confirm',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await authorizedStaff(options, request, 'song.manage', createAccess)
      const body = readObject(request.body)
      rejectClaims(body, ['employeeId', 'actorEmployeeId', 'actor', 'scope'])
      const requestId = readUuid(request.params.requestId, 'requestId')
      const quotedAmountMinor = readInteger(body.quotedAmountMinor, 'quotedAmountMinor', 0, Number.MAX_SAFE_INTEGER)
      const currency = readCurrency(body.currency)
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.performance.confirmSongRequest({
        scope: context.scope,
        actor: employeeActor(context.employeeId),
        businessDate: context.businessDate,
        requestId,
        actorEmployeeId: context.employeeId,
        quotedAmountMinor,
        currency,
        idempotencyKey,
        requestFingerprint: fingerprint(request, context, { requestId, quotedAmountMinor, currency }),
      })
      return reply.send({ data: execution.value, meta: { replayed: execution.replayed } })
    }),
  )

  app.post<{ Params: { requestId: string } }>(
    '/staff/song-requests/:requestId/paid',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await authorizedStaff(options, request, 'song.payment.record', createAccess)
      const body = readObject(request.body)
      rejectClaims(body, ['employeeId', 'actorEmployeeId', 'actor', 'scope'])
      const requestId = readUuid(request.params.requestId, 'requestId')
      const paymentId = readUuid(body.paymentId, 'paymentId')
      const reconciliationEntryId = readUuid(body.reconciliationEntryId, 'reconciliationEntryId')
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.performance.markSongRequestPaid({
        scope: context.scope,
        actor: employeeActor(context.employeeId),
        businessDate: context.businessDate,
        requestId,
        actorEmployeeId: context.employeeId,
        paymentId,
        reconciliationEntryId,
        idempotencyKey,
        requestFingerprint: fingerprint(request, context, { requestId, paymentId, reconciliationEntryId }),
      })
      return reply.send({ data: execution.value, meta: { replayed: execution.replayed } })
    }),
  )

  for (const transition of ['reject', 'performed', 'cancel'] as const) {
    app.post<{ Params: { requestId: string } }>(
      `/staff/song-requests/:requestId/${transition}`,
      async (request, reply) => handleRoute(reply, async () => {
        const context = await authorizedStaff(options, request, 'song.manage', createAccess)
        const body = readOptionalObject(request.body)
        rejectClaims(body, ['employeeId', 'actorEmployeeId', 'actor', 'scope'])
        const requestId = readUuid(request.params.requestId, 'requestId')
        const idempotencyKey = readIdempotencyKey(request)
        const command = {
          scope: context.scope,
          actor: employeeActor(context.employeeId),
          businessDate: context.businessDate,
          requestId,
          actorEmployeeId: context.employeeId,
          idempotencyKey,
          requestFingerprint: fingerprint(request, context, { requestId, transition }),
        }
        const execution = transition === 'reject'
          ? await options.performance.rejectSongRequest(command)
          : transition === 'performed'
              ? await options.performance.markSongRequestPerformed(command)
              : await options.performance.cancelSongRequest(command)
        return reply.send({ data: execution.value, meta: { replayed: execution.replayed } })
      }),
    )
  }
}

async function authorizedStaff(
  options: ReservationPerformanceApiOptions,
  request: FastifyRequest,
  permission: string,
  createAccess: (transaction: ScopedTransaction) => StaffAccessPort,
): Promise<AuthorizedStaffContext> {
  const context = await options.resolveStaffContext(request)
  validateScopeAndBusinessDate(context.scope, context.businessDate)
  readUuid(context.employeeId, 'employeeId')
  const access = await options.transactions.run(context.scope, async (transaction) => {
    return createAccess(transaction).assertPermission(context.employeeId, permission)
  }, { readOnly: true })
  return { ...context, access }
}

async function guestContext(
  options: ReservationPerformanceApiOptions,
  request: FastifyRequest,
): Promise<GuestReservationPerformanceContext> {
  const context = await options.resolveGuestContext(request)
  validateScopeAndBusinessDate(context.scope, context.businessDate)
  readUuid(context.customerId, 'customerId')
  if (context.tableSessionId !== null) readUuid(context.tableSessionId, 'tableSessionId')
  if (context.actorRef.trim().length < 3 || context.actorRef.length > 160) {
    throw new ApiRequestError('客户身份上下文无效')
  }
  return context
}

function validateScopeAndBusinessDate(scope: Readonly<StoreScope>, businessDate: string): void {
  readUuid(scope.tenantId, 'tenantId')
  readUuid(scope.storeId, 'storeId')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new ApiRequestError('businessDate格式无效')
}

async function hydrateReservations(
  repository: ReservationRepositoryPort,
  rows: readonly IdRow[],
): Promise<Reservation[]> {
  const values: Reservation[] = []
  for (const row of rows) {
    const reservation = await repository.findById(row.id)
    if (reservation !== null) values.push(reservation)
  }
  return values
}

function publicReservation(reservation: Reservation) {
  return {
    publicId: reservation.publicId,
    guestCount: reservation.guestCount,
    arrivalAt: reservation.arrivalAt,
    expectedEndAt: reservation.expectedEndAt,
    status: reservation.status,
    source: reservation.source,
    contactAvailable: reservation.contactToken.length > 0,
    tables: reservation.tableLocks.map((lock) => ({
      code: lock.tableCode,
      displayName: lock.tableDisplayName,
    })),
  }
}

function staffReservation(reservation: Reservation, canViewContact: boolean) {
  const { contactToken, ...base } = reservation
  return canViewContact
    ? { ...base, contactToken, contactAvailable: contactToken.length > 0 }
    : { ...base, contactAvailable: contactToken.length > 0 }
}

function publicDailyPerformance(view: DailyPerformanceView) {
  const publicSchedule = (schedule: DailyPerformanceView['schedules'][number]) => ({
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

function publicPerformerProfile(profile: Record<string, unknown>) {
  const result: Record<string, string | string[]> = {}
  for (const key of ['bio', 'imageUrl'] as const) {
    const value = profile[key]
    if (typeof value === 'string') result[key] = value
  }
  for (const key of ['genres', 'styles', 'highlights'] as const) {
    const value = profile[key]
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      result[key] = value as string[]
    }
  }
  return result
}

function publicSongRequest(request: SongRequest) {
  return {
    id: request.id,
    songTitle: request.songTitle,
    requestType: request.requestType,
    status: request.status,
    quotedAmountMinor: request.quotedAmountMinor,
    currency: request.currency,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  }
}

function publicSongRequestSubmission(submission: {
  request: SongRequest
  slot: 'current' | 'next'
  extensionRequested: boolean
  requiresStaffConfirmation: boolean
}) {
  return {
    request: publicSongRequest(submission.request),
    slot: submission.slot,
    extensionRequested: submission.extensionRequested,
    requiresStaffConfirmation: submission.requiresStaffConfirmation,
  }
}

function reservationVisibility(context: AuthorizedStaffContext) {
  const all = context.access.permissions.includes('reservation.view.all')
    || context.access.dataScopes.some((scope) => (
      scope.key === 'reservation.visibility' && scope.effect === 'include' && scope.value === 'all'
    ))
  const ownerEmployeeIds = new Set<string>([context.employeeId])
  const areaIds = new Set<string>()
  for (const scope of context.access.dataScopes) {
    const target = scope.key === 'reservation.owner_employee_id' || scope.key === 'reservation.owner_employee_ids'
      ? ownerEmployeeIds
      : scope.key === 'reservation.area_id' || scope.key === 'reservation.area_ids'
        ? areaIds
        : null
    if (target === null) continue
    for (const id of scopeUuids(scope.value)) {
      if (scope.effect === 'include') target.add(id)
      else target.delete(id)
    }
  }
  return { all, ownerEmployeeIds: [...ownerEmployeeIds], areaIds: [...areaIds] }
}

function scopeUuids(value: JsonValue): string[] {
  const values = Array.isArray(value) ? value : [value]
  return values.filter((entry): entry is string => (
    typeof entry === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry)
  ))
}

function requireAccessPermission(access: EffectiveStaffAccess, permission: string): void {
  if (!access.permissions.includes(permission)) {
    throw new StaffAccessDeniedError(`Employee ${access.employeeId} does not have permission ${permission}`)
  }
}

function readReservationInput(body: JsonObject) {
  const arrivalAt = readTimestamp(body.arrivalAt, 'arrivalAt')
  const expectedEndAt = readTimestamp(body.expectedEndAt, 'expectedEndAt')
  if (Date.parse(expectedEndAt) <= Date.parse(arrivalAt)) throw new ApiRequestError('expectedEndAt必须晚于arrivalAt')
  return {
    publicId: body.publicId === undefined ? null : readPublicId(body.publicId),
    customerName: readString(body.customerName, 'customerName', 120),
    contactToken: readString(body.contactToken, 'contactToken', 256),
    guestCount: readInteger(body.guestCount, 'guestCount', 1, 200),
    arrivalAt,
    expectedEndAt,
    note: readOptionalString(body.note, 'note', 2_000),
    seatPreference: readSeatPreference(body.seatPreference),
    reservationSnapshot: readOptionalJsonObject(body.reservationSnapshot, 'reservationSnapshot'),
    tableIds: readUuidArray(body.tableIds, 'tableIds', 1, 20),
  }
}

function readSeatPreference(value: unknown): ReservationSeatPreference {
  if (value === undefined) return 'no_preference'
  if (typeof value !== 'string' || ![
    'no_preference', 'stage_atmosphere', 'quiet_chat', 'comfortable_booth', 'outdoor_view',
  ].includes(value)) throw new ApiRequestError('seatPreference无效')
  return value as ReservationSeatPreference
}

function serverReservationTiming(
  arrivalAt: string,
  currentInstant: string,
  holdTtlMinutes: number,
  maxAdvanceDays: number,
  cancellationCutoffMinutes: number,
) {
  const arrivalMs = Date.parse(arrivalAt)
  const nowMs = Date.parse(currentInstant)
  if (!Number.isFinite(nowMs)) throw new TypeError('Server clock must be an ISO timestamp')
  if (arrivalMs <= nowMs) throw new ApiRequestError('到店时间必须晚于当前时间')
  if (arrivalMs > nowMs + maxAdvanceDays * 86_400_000) {
    throw new ApiRequestError(`最多可提前${maxAdvanceDays}天预约`)
  }
  return {
    holdExpiresAt: new Date(Math.min(arrivalMs, nowMs + holdTtlMinutes * 60_000)).toISOString(),
    customerCancelUntil: new Date(arrivalMs - cancellationCutoffMinutes * 60_000).toISOString(),
    policySnapshot: {
      version: 1,
      customerCancellationCutoffMinutes: cancellationCutoffMinutes,
      paidDepositRequiresStaffException: true,
    } satisfies JsonObject,
  }
}

function boundedConfiguration(
  value: number | undefined,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const configured = value ?? fallback
  if (!Number.isSafeInteger(configured) || configured < minimum || configured > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return configured
}

function readPerformerCreate(body: JsonObject) {
  return {
    code: readPatternString(body.code, 'code', /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
    stageName: readString(body.stageName, 'stageName', 120),
    profileSnapshot: readOptionalJsonObject(body.profileSnapshot, 'profileSnapshot'),
    songCatalog: readOptionalJsonObjectArray(body.songCatalog, 'songCatalog'),
    status: readPerformerStatus(body.status, 'active'),
  }
}

function readPerformerUpdate(body: JsonObject, performerId: string) {
  const input: {
    performerId: string
    stageName?: string
    profileSnapshot?: JsonObject
    songCatalog?: JsonObject[]
    status?: PerformerStatus
  } = { performerId }
  if (body.stageName !== undefined) input.stageName = readString(body.stageName, 'stageName', 120)
  if (body.profileSnapshot !== undefined) input.profileSnapshot = readJsonObject(body.profileSnapshot, 'profileSnapshot')
  if (body.songCatalog !== undefined) input.songCatalog = readJsonObjectArray(body.songCatalog, 'songCatalog')
  if (body.status !== undefined) input.status = readPerformerStatus(body.status)
  if (Object.keys(input).length === 1) throw new ApiRequestError('至少提供一个歌手资料变更')
  return input
}

function readPerformerSongImport(body: JsonObject, performerId: string) {
  const mode = body.mode === undefined ? 'upsert' : readSongImportMode(body.mode)
  const rows = readJsonObjectArray(body.songs, 'songs')
  if (rows.length > 5000 || (rows.length === 0 && mode !== 'replace')) {
    throw new ApiRequestError('songs必须包含1至5000首；replace模式允许空歌单')
  }
  return {
    performerId,
    sourceName: readString(body.sourceName ?? 'staff manual import', 'sourceName', 256),
    mode,
    songs: rows.map((row, index) => readPerformerSong(row, `songs[${index}]`)),
  }
}

function readPerformerSongUpdate(body: JsonObject): Partial<PerformerSongInput> {
  const changes: Partial<PerformerSongInput> = {}
  if (body.code !== undefined) changes.code = body.code === null ? null : readString(body.code, 'code', 64)
  if (body.title !== undefined) changes.title = readString(body.title, 'title', 240)
  if (body.aliases !== undefined) changes.aliases = readStringArray(body.aliases, 'aliases', 0, 100)
  if (body.metadata !== undefined) changes.metadata = readJsonObject(body.metadata, 'metadata')
  if (body.status !== undefined) changes.status = readPerformerSongStatus(body.status)
  if (Object.keys(changes).length === 0) throw new ApiRequestError('至少提供一个歌曲变更')
  return changes
}

function readPerformerSong(row: JsonObject, label: string): PerformerSongInput {
  return {
    code: row.code === undefined || row.code === null ? null : readString(row.code, `${label}.code`, 64),
    title: readString(row.title, `${label}.title`, 240),
    aliases: row.aliases === undefined ? [] : readStringArray(row.aliases, `${label}.aliases`, 0, 100),
    metadata: row.metadata === undefined ? {} : readJsonObject(row.metadata, `${label}.metadata`),
    status: row.status === undefined ? 'active' : readPerformerSongStatus(row.status),
  }
}

function readScheduleCreate(body: JsonObject) {
  return {
    performerId: readUuid(body.performerId, 'performerId'),
    startsAt: readTimestamp(body.startsAt, 'startsAt'),
    endsAt: readTimestamp(body.endsAt, 'endsAt'),
    sortOrder: body.sortOrder === undefined ? 0 : readInteger(body.sortOrder, 'sortOrder', -10_000, 10_000),
  }
}

function readScheduleUpdate(body: JsonObject, scheduleId: string) {
  const input: { scheduleId: string; startsAt?: string; endsAt?: string; sortOrder?: number } = { scheduleId }
  if (body.startsAt !== undefined) input.startsAt = readTimestamp(body.startsAt, 'startsAt')
  if (body.endsAt !== undefined) input.endsAt = readTimestamp(body.endsAt, 'endsAt')
  if (body.sortOrder !== undefined) input.sortOrder = readInteger(body.sortOrder, 'sortOrder', -10_000, 10_000)
  if (Object.keys(input).length === 1) throw new ApiRequestError('至少提供一个排班变更')
  return input
}

function readSongSubmission(body: JsonObject) {
  return {
    scheduleId: readUuid(body.scheduleId, 'scheduleId'),
    songTitle: readString(body.songTitle, 'songTitle', 200),
    requestType: readSongRequestType(body.requestType),
    note: readOptionalString(body.note, 'note', 1_000),
    requestExtension: body.requestExtension === undefined
      ? false
      : readBoolean(body.requestExtension, 'requestExtension'),
  }
}

function readObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new ApiRequestError('请求正文必须是JSON对象')
  return value
}

function readOptionalObject(value: unknown): JsonObject {
  if (value === undefined || value === null || value === '') return {}
  return readObject(value)
}

function readQuery(request: FastifyRequest): Record<string, unknown> {
  if (typeof request.query !== 'object' || request.query === null || Array.isArray(request.query)) return {}
  return request.query as Record<string, unknown>
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== 'string') throw new ApiRequestError(`${label}格式无效`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) throw new ApiRequestError(`${label}格式无效`)
  return normalized
}

function readOptionalString(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return readString(value, label, maximum)
}

function readPatternString(value: unknown, label: string, pattern: RegExp): string {
  const text = readString(value, label, 128)
  if (!pattern.test(text)) throw new ApiRequestError(`${label}格式无效`)
  return text
}

function readInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ApiRequestError(`${label}格式无效`)
  }
  return value
}

function readQueryInteger(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new ApiRequestError(`${label}格式无效`)
  return readInteger(Number(value), label, minimum, maximum)
}

function readStringArray(value: unknown, label: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new ApiRequestError(`${label}格式无效`)
  }
  const values = value.map((entry) => readString(entry, label, 240))
  if (new Set(values.map((entry) => entry.toLocaleLowerCase('zh-CN'))).size !== values.length) {
    throw new ApiRequestError(`${label}不能包含重复值`)
  }
  return values
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ApiRequestError(`${label}格式无效`)
  return value
}

function readUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiRequestError(`${label}必须是有效UUID`)
  }
  return value
}

function readOptionalUuid(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return readUuid(value, label)
}

function readUuidArray(value: unknown, label: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new ApiRequestError(`${label}格式无效`)
  const ids = value.map((entry) => readUuid(entry, label))
  if (new Set(ids).size !== ids.length) throw new ApiRequestError(`${label}不能包含重复值`)
  return ids
}

function readTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    || !Number.isFinite(Date.parse(value))
  ) throw new ApiRequestError(`${label}必须是包含时区的有效ISO时间`)
  return value
}

function readOptionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return readTimestamp(value, label)
}

function readPublicId(value: unknown): string {
  return readString(value, 'publicId', 128, 8)
}

function readOptionalJsonObject(value: unknown, label: string): JsonObject {
  if (value === undefined || value === null) return {}
  return readJsonObject(value, label)
}

function readJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new ApiRequestError(`${label}必须是JSON对象`)
  return value
}

function readOptionalJsonObjectArray(value: unknown, label: string): JsonObject[] {
  if (value === undefined || value === null) return []
  return readJsonObjectArray(value, label)
}

function readJsonObjectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((entry) => !isJsonObject(entry))) {
    throw new ApiRequestError(`${label}必须是JSON对象数组`)
  }
  return value as JsonObject[]
}

function readReservationSource(value: unknown): Exclude<ReservationSource, 'wechat' | 'walk_in'> {
  if (value === 'phone' || value === 'employee' || value === 'integration') return value
  throw new ApiRequestError('员工预约source必须是phone、employee或integration')
}

function readInitialReservationStatus(value: unknown): 'pending' | 'confirmed' {
  if (value === undefined || value === 'confirmed') return 'confirmed'
  if (value === 'pending') return value
  throw new ApiRequestError('initialStatus必须是pending或confirmed')
}

function readOptionalReservationStatus(value: unknown): ReservationStatus | null {
  if (value === undefined || value === null || value === '') return null
  const statuses: readonly ReservationStatus[] = ['pending', 'confirmed', 'arrived', 'seated', 'completed', 'cancelled', 'no_show']
  if (typeof value !== 'string' || !statuses.includes(value as ReservationStatus)) throw new ApiRequestError('预约状态筛选无效')
  return value as ReservationStatus
}

function readSongRequestType(value: unknown): SongRequestType {
  if (value === 'catalog' || value === 'custom') return value
  throw new ApiRequestError('requestType必须是catalog或custom')
}

function readSongImportMode(value: unknown): 'upsert' | 'replace' {
  if (value === 'upsert' || value === 'replace') return value
  throw new ApiRequestError('mode必须是upsert或replace')
}

function readPerformerSongStatus(value: unknown): PerformerSongStatus {
  if (value === 'active' || value === 'inactive') return value
  throw new ApiRequestError('歌曲状态无效')
}

function readOptionalSongStatus(value: unknown): SongRequestStatus | null {
  if (value === undefined || value === null || value === '') return null
  const statuses: readonly SongRequestStatus[] = ['requested', 'confirming', 'accepted', 'rejected', 'paid', 'performed', 'cancelled']
  if (typeof value !== 'string' || !statuses.includes(value as SongRequestStatus)) throw new ApiRequestError('点歌状态筛选无效')
  return value as SongRequestStatus
}

function readPerformerStatus(value: unknown, fallback?: PerformerStatus): PerformerStatus {
  if (value === undefined && fallback !== undefined) return fallback
  if (value === 'active' || value === 'inactive') return value
  throw new ApiRequestError('歌手状态无效')
}

function readScheduleTransition(value: unknown): Extract<ScheduleStatus, 'performing' | 'completed' | 'cancelled'> {
  if (value === 'performing' || value === 'completed' || value === 'cancelled') return value
  throw new ApiRequestError('排班目标状态无效')
}

function readCurrency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw new ApiRequestError('currency必须是ISO 4217代码')
  return value
}

function rejectClaims(body: JsonObject, fields: readonly string[]): void {
  const claimed = fields.find((field) => body[field] !== undefined)
  if (claimed !== undefined) throw new ApiRequestError(`请求不得指定${claimed}`)
}

function readIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key']
  if (Array.isArray(raw) || typeof raw !== 'string') throw new ApiRequestError('缺少有效Idempotency-Key请求头')
  const value = raw.trim()
  if (value.length < 8 || value.length > 160) throw new ApiRequestError('Idempotency-Key格式无效')
  return value
}

function employeeActor(employeeId: string) {
  return { type: 'employee' as const, employeeId }
}

function fingerprint(
  request: FastifyRequest,
  context: GuestReservationPerformanceContext | StaffReservationPerformanceContext,
  payload: unknown,
): string {
  return stableStringify({
    method: request.method,
    path: request.routeOptions.url ?? request.url.split('?')[0] ?? request.url,
    tenantId: context.scope.tenantId,
    storeId: context.scope.storeId,
    principalId: 'employeeId' in context ? context.employeeId : context.customerId,
    payload: payload as JsonValue,
  })
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

async function handleRoute(
  reply: FastifyReply,
  operation: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  try {
    return await operation()
  } catch (error) {
    const mapped = mapError(error)
    return reply.code(mapped.statusCode).send(mapped.body)
  }
}

function mapError(error: unknown): { statusCode: number; body: ApiErrorBody } {
  if (
    error instanceof NormalizedAuthenticationRequiredError
    || error instanceof StaffSessionNotFoundError
  ) return apiError(401, 'AUTH_REQUIRED', '登录信息无效或已过期，请重新登录')
  if (
    error instanceof TrustedStoreScopeError
    || error instanceof NormalizedStoreUnavailableError
  ) return apiError(403, 'STORE_ACCESS_FORBIDDEN', '当前设备无权访问该门店')
  if (error instanceof StaffAccessDeniedError) return apiError(403, 'STAFF_ACCESS_FORBIDDEN', '当前员工无权执行此操作')
  if (error instanceof StaffNotFoundError) return apiError(403, 'STAFF_ACCESS_FORBIDDEN', '当前员工无权执行此操作')
  if (error instanceof GuestResourceNotFoundError) return apiError(404, 'RESOURCE_NOT_FOUND', error.message)
  if (error instanceof ReservationNotFoundError) return apiError(404, 'RESERVATION_NOT_FOUND', '预约不存在')
  if (error instanceof ReservationCustomerNotFoundError) return apiError(404, 'RESERVATION_CUSTOMER_NOT_FOUND', '预约客户不存在')
  if (error instanceof PerformerNotFoundError) return apiError(404, 'PERFORMER_NOT_FOUND', '歌手不存在')
  if (error instanceof PerformerSongNotFoundError) return apiError(404, 'PERFORMER_SONG_NOT_FOUND', '歌曲不存在')
  if (error instanceof ScheduleNotFoundError) return apiError(404, 'SCHEDULE_NOT_FOUND', '演出排班不存在')
  if (error instanceof SongRequestNotFoundError) return apiError(404, 'SONG_REQUEST_NOT_FOUND', '点歌请求不存在')
  if (error instanceof ReservationConflictError) return apiError(409, 'RESERVATION_TABLE_CONFLICT', '所选桌位在该时段已不可预约')
  if (error instanceof ReservationTableUnavailableError) return apiError(409, 'RESERVATION_TABLE_UNAVAILABLE', '所选桌位当前不可预约')
  if (error instanceof ReservationCancellationPolicyError) {
    return error.reason === 'paid_deposit'
      ? apiError(409, 'RESERVATION_PAID_DEPOSIT_REQUIRES_STAFF', '该预约已有定金，请联系工作人员处理取消和退款')
      : apiError(409, 'RESERVATION_CANCELLATION_CUTOFF_PASSED', '已超过自助取消时间，请联系工作人员处理')
  }
  if (error instanceof ReservationHoldExpiredError) return apiError(409, 'RESERVATION_HOLD_EXPIRED', '桌位保留时间已过，请重新选择')
  if (error instanceof ReservationLockUnavailableError) return apiError(409, 'RESERVATION_LOCK_UNAVAILABLE', '预约桌位锁已失效')
  if (error instanceof ReservationTransitionError) return apiError(409, 'RESERVATION_STATE_CONFLICT', '当前预约状态不允许此操作')
  if (error instanceof ScheduleConflictError) return apiError(409, 'SCHEDULE_CONFLICT', '演出时间与现有排班冲突')
  if (error instanceof ScheduleTransitionError) return apiError(409, 'SCHEDULE_STATE_CONFLICT', '当前演出状态不允许此操作')
  if (error instanceof SongRequestCustomerSessionError) return apiError(403, 'SONG_REQUEST_TABLE_CUSTOMER_MISMATCH', error.message)
  if (error instanceof SongRequestPaymentEvidenceError) return apiError(409, 'SONG_REQUEST_PAYMENT_EVIDENCE_INVALID', error.message)
  if (error instanceof SongRequestEligibilityError) return apiError(409, 'SONG_REQUEST_NOT_ELIGIBLE', '当前桌次或演出安排暂不支持该点歌请求')
  if (error instanceof SongRequestTransitionError) return apiError(409, 'SONG_REQUEST_STATE_CONFLICT', '当前点歌状态不允许此操作')
  if (isPostgresConstraintError(error)) return apiError(409, 'SONG_CATALOG_CONFLICT', '歌曲名称、编号或别名与现有歌单冲突')
  if (error instanceof IdempotencyConflictError) return apiError(409, 'IDEMPOTENCY_CONFLICT', '重复请求内容不一致')
  if (error instanceof IdempotencyInProgressError) return apiError(425, 'IDEMPOTENCY_IN_PROGRESS', '相同请求正在处理中')
  if (error instanceof ApiRequestError || error instanceof TypeError) return apiError(400, 'REQUEST_INVALID', error.message)
  if (error instanceof IdempotencyRecordError) return apiError(503, 'COMMAND_TEMPORARILY_UNAVAILABLE', '操作暂时不可用，请稍后重试')
  return apiError(500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试')
}

function isPostgresConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error.code === '23505' || error.code === '23514' || error.code === '23503')
}

function apiError(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } }
}
