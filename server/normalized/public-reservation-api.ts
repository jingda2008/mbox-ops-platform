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
  now?: () => Date
  createPublicId?: (kind: 'reservation' | 'waitlist') => string
}

interface ReservationPolicyRow extends Record<string, unknown> {
  hold_minutes: number
  max_advance_days: number
  default_duration_minutes: number
  customer_cancel_cutoff_minutes: number
  deposit_mode: 'disabled' | 'flat' | 'minimum_spend_ratio'
  deposit_minor: string | number | null
  deposit_ratio_bps: number | null
  deposit_rule_text: string | null
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

interface PrivateContactRow extends Record<string, unknown> {
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
}

class PublicReservationRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicReservationRequestError'
  }
}

class PublicReservationOwnershipError extends Error {
  constructor() {
    super('没有找到对应预约')
    this.name = 'PublicReservationOwnershipError'
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
      return { policy, expectedEndAt, tables }
    })
    return reply.send({
      data: {
        arrivalAt,
        expectedEndAt: result.expectedEndAt,
        guestCount,
        holdMinutes: result.policy.hold_minutes,
        depositRule: publicDepositRule(result.policy, null),
        areas: groupPublicTables(result.tables),
      },
    })
  }))

  app.post('/public/reservations', async (request, reply) => handle(reply, async () => {
    const context = await requireGuest(options, request, 'guest.reservation.update')
    const body = readObject(request.body)
    rejectClaims(body, ['customerId', 'source', 'holdExpiresAt', 'contactToken', 'actor', 'scope'])
    const mode = readEnum(body.mode, '选位方式', ['direct', 'self_select'] as const)
    const customerName = readString(body.customerName, '预约姓名', 1, 128)
    const contact = await options.protectContact(readString(body.contact, '联系方式', 3, 256))
    const guestCount = readInteger(body.guestCount, '人数', 1, 200)
    const arrivalAt = readTimestamp(body.arrivalAt, '到店时间')
    const note = readOptionalString(body.note, '备注', 1000)
    const requestedTableCodes = mode === 'self_select'
      ? readStringArray(body.tableCodes, '桌位', 1, 4)
      : []
    const idempotencyKey = readIdempotencyKey(request)
    const publicId = readOptionalString(body.publicId, '预约编号', 128) ?? createPublicId('reservation')
    const execution = await options.commands.execute({
      scope: context.scope,
      operationScope: 'public.reservation.create',
      idempotencyKey,
      requestFingerprint: fingerprint({ mode, customerName, contact: contact.hash, guestCount, arrivalAt, note, requestedTableCodes }),
      resultCodec: reservationCodec,
    }, async (transaction) => {
      await enforceRateLimit(transaction, 'reservation', hashActor(context.actorRef), 8, 60_000)
      const policy = await readPolicy(transaction)
      const expectedEndAt = body.expectedEndAt === undefined
        ? new Date(Date.parse(arrivalAt) + policy.default_duration_minutes * 60_000).toISOString()
        : readTimestamp(body.expectedEndAt, '预计结束时间')
      validateReservationWindow(arrivalAt, expectedEndAt, now(), policy.max_advance_days)
      const available = (await listReservationTables(transaction, arrivalAt, expectedEndAt, guestCount))
        .filter((table) => table.availability_status === 'available')
      const selected = selectTables(mode, requestedTableCodes, available)
      const heldUntil = new Date(Math.min(
        Date.parse(arrivalAt),
        now().getTime() + policy.hold_minutes * 60_000,
      )).toISOString()
      const deposit = publicDepositRule(policy, selected.reduce(
        (sum, table) => sum + Number(table.minimum_spend_minor ?? 0),
        0,
      ))
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
        reservationSnapshot: { bookingMode: mode, depositRule: deposit },
        tableIds: selected.map((table) => table.table_id),
        initialStatus: 'pending',
        holdExpiresAt: heldUntil,
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
      meta: { replayed: execution.replayed, holdMinutes: 20 },
    })
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
      rejectClaims(body, ['customerId', 'source', 'status', 'actor', 'scope'])
      const publicId = readPublicId(request.params.publicId)
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.commands.execute({
        scope: context.scope,
        operationScope: 'public.reservation.update',
        idempotencyKey,
        requestFingerprint: fingerprint({ publicId, body }),
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
        const expectedEndAt = body.expectedEndAt === undefined
          ? current.expectedEndAt
          : readTimestamp(body.expectedEndAt, '预计结束时间')
        const note = body.note === undefined ? current.note : readOptionalString(body.note, '备注', 1000)
        const policy = await readPolicy(transaction)
        validateReservationWindow(arrivalAt, expectedEndAt, now(), policy.max_advance_days)
        const requestedCodes = body.tableCodes === undefined
          ? current.tableLocks.map((lock) => lock.tableCode)
          : readStringArray(body.tableCodes, '桌位', 1, 4)
        await transaction.query(`
          UPDATE mbox.reservation_table_locks SET status = 'released', hold_expires_at = NULL
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND reservation_id = $3::uuid
            AND status IN ('held', 'confirmed')
        `, [transaction.scope.tenantId, transaction.scope.storeId, current.id])
        const tables = (await listReservationTables(transaction, arrivalAt, expectedEndAt, guestCount))
          .filter((table) => table.availability_status === 'available')
        const selected = selectTables('self_select', requestedCodes, tables)
        const lockStatus = current.status === 'confirmed' ? 'confirmed' : 'held'
        const holdExpiresAt = lockStatus === 'held'
          ? new Date(Math.min(Date.parse(arrivalAt), now().getTime() + policy.hold_minutes * 60_000)).toISOString()
          : null
        try {
          await transaction.query(`
            INSERT INTO mbox.reservation_table_locks (
              tenant_id, store_id, reservation_id, table_id, reserved_during, status, hold_expires_at
            ) SELECT $1::uuid, $2::uuid, $3::uuid, table_id,
              tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6,
              CASE WHEN $6 = 'held' THEN $7::timestamptz ELSE NULL END
            FROM unnest($8::uuid[]) AS table_id
          `, [
            transaction.scope.tenantId,
            transaction.scope.storeId,
            current.id,
            arrivalAt,
            expectedEndAt,
            lockStatus,
            holdExpiresAt,
            selected.map((table) => table.table_id),
          ])
        } catch (error) {
          if (postgresCode(error) === '23P01') throw new ReservationConflictError()
          throw error
        }
        await transaction.query(`
          UPDATE mbox.reservations
          SET customer_name = $4, guest_count = $5, arrival_at = $6::timestamptz,
            expected_end_at = $7::timestamptz, note = $8,
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
    const execution = await options.waitlists.create({
      scope: context.scope,
      actor: { type: 'guest', ref: context.actorRef },
      businessDate: context.businessDate,
      idempotencyKey: readIdempotencyKey(request),
      requestFingerprint: fingerprint({ ...body, contact: contact.hash }),
      publicId: createPublicId('waitlist'),
      customerId: context.customerId,
      customerName: readString(body.customerName, '候位姓名', 1, 128),
      contact,
      guestCount: readInteger(body.guestCount, '人数', 1, 200),
      desiredArrivalAt: readTimestamp(body.desiredArrivalAt, '预计到店时间'),
      source: 'wechat',
      note: readOptionalString(body.note, '备注', 1000),
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
            FILTER (WHERE venue_table.code IS NOT NULL), ARRAY[]::text[]) AS table_codes
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
        WHERE reservation.tenant_id = $1::uuid AND reservation.store_id = $2::uuid
          AND reservation.arrival_at >= $3::timestamptz AND reservation.arrival_at < $4::timestamptz
          AND ($5::boolean OR reservation.owner_employee_id = ANY($6::uuid[]))
        GROUP BY reservation.id, contact.masked_contact
        UNION ALL
        SELECT 'waitlist'::text AS kind, waitlist.public_id, waitlist.customer_name,
          waitlist.masked_contact, waitlist.guest_count,
          waitlist.desired_arrival_at::text AS arrival_at, waitlist.status,
          waitlist.source, waitlist.owner_employee_id, ARRAY[]::text[] AS table_codes
        FROM mbox.waitlist_entries AS waitlist
        WHERE waitlist.tenant_id = $1::uuid AND waitlist.store_id = $2::uuid
          AND waitlist.desired_arrival_at >= $3::timestamptz
          AND waitlist.desired_arrival_at < $4::timestamptz
          AND ($5::boolean OR waitlist.owner_employee_id = ANY($6::uuid[]))
        ORDER BY arrival_at, public_id
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
      })),
    })
  }))
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
    SELECT id FROM mbox.reservations
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
      AND public_id = $3 AND customer_id = $4::uuid
    ${lock ? 'FOR UPDATE' : ''}
  `, [transaction.scope.tenantId, transaction.scope.storeId, publicId, customerId])
  const id = selected.rows[0]?.id
  if (!id) throw new PublicReservationOwnershipError()
  const reservation = await new ReservationRepository(transaction).findById(id)
  if (!reservation) throw new PublicReservationOwnershipError()
  return reservation
}

async function readPolicy(transaction: ScopedTransaction): Promise<ReservationPolicyRow> {
  const result = await transaction.query<ReservationPolicyRow>(`
    SELECT hold_minutes, max_advance_days, default_duration_minutes,
      customer_cancel_cutoff_minutes, deposit_mode, deposit_minor,
      deposit_ratio_bps, deposit_rule_text
    FROM mbox.public_reservation_policies
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
  `, [transaction.scope.tenantId, transaction.scope.storeId])
  const row = result.rows[0]
  if (!row) throw new Error('门店预约规则尚未配置')
  return row
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

function selectTables(
  mode: 'direct' | 'self_select',
  requestedCodes: readonly string[],
  available: readonly AvailableTableRow[],
): AvailableTableRow[] {
  if (mode === 'direct') {
    const first = available[0]
    if (!first) throw new ReservationTableUnavailableError()
    return [first]
  }
  const selected = requestedCodes.map((code) => available.find((table) => table.table_code === code))
  if (selected.some((table) => table === undefined)) throw new ReservationTableUnavailableError()
  return selected as AvailableTableRow[]
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
    tableCodes: reservation.tableLocks
      .filter((lock) => ['held', 'confirmed'].includes(lock.status))
      .map((lock) => lock.tableCode),
    holdExpiresAt: reservation.tableLocks.find((lock) => lock.status === 'held')?.holdExpiresAt ?? null,
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
  }
}

function reservationEvent(reservation: Reservation): JsonObject {
  return {
    publicId: reservation.publicId,
    guestCount: reservation.guestCount,
    arrivalAt: reservation.arrivalAt,
    expectedEndAt: reservation.expectedEndAt,
    status: reservation.status,
    source: reservation.source,
    tableCodes: reservation.tableLocks.map((lock) => lock.tableCode),
  }
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
    reservationSnapshot: reservation.reservationSnapshot,
    createdAt: reservation.createdAt,
    updatedAt: reservation.updatedAt,
    aggregateVersion: reservation.aggregateVersion,
    customerCancelUntil: reservation.customerCancelUntil,
    cancellationPolicySnapshot: reservation.cancellationPolicySnapshot,
    tableLocks: reservation.tableLocks.map((lock) => ({ ...lock })),
  }),
  decode: (value) => {
    if (!isObject(value) || typeof value.id !== 'string' || !Array.isArray(value.tableLocks)) {
      throw new TypeError('Stored reservation result is invalid')
    }
    return value as unknown as Reservation
  },
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
  if (!context.permissions.includes(permission)) throw new PublicReservationOwnershipError()
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
  if (error instanceof PublicReservationOwnershipError || error instanceof WaitlistNotFoundError) {
    return { status: 404, code: 'RESERVATION_NOT_FOUND', message: error.message }
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
    'Path=/public',
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

function readStringArray(value: unknown, label: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new PublicReservationRequestError(`${label}数量无效`)
  }
  const values = value.map((item) => readString(item, label, 1, 32))
  if (new Set(values).size !== values.length) throw new PublicReservationRequestError(`${label}不能重复`)
  return values
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
