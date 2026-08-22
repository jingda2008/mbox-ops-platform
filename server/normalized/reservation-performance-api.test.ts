import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { PerformanceCommandService } from './performance-command-service.js'
import { ReservationCommandService } from './reservation-command-service.js'
import {
  reservationPerformanceApiPlugin,
  type GuestReservationPerformanceContext,
  type ReservationPerformanceApiOptions,
  type StaffReservationPerformanceContext,
} from './reservation-performance-api.js'
import { ReservationConflictError, type Reservation } from './reservation-repository.js'
import type { DailyPerformanceView, PerformanceSchedule } from './schedule-repository.js'
import type { SongRequest, SongRequestSubmission } from './song-request-repository.js'
import {
  StaffAccessDeniedError,
  type EffectiveStaffAccess,
} from './staff-access-repository.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type ScopedTransaction,
} from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const customerId = '33333333-3333-4333-8333-333333333333'
const otherCustomerId = '44444444-4444-4444-8444-444444444444'
const employeeId = '55555555-5555-4555-8555-555555555555'
const tableId = '66666666-6666-4666-8666-666666666666'
const tableSessionId = '77777777-7777-4777-8777-777777777777'
const reservationId = '88888888-8888-4888-8888-888888888888'
const performerId = '99999999-9999-4999-8999-999999999999'
const scheduleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const songRequestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const areaId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const paymentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const reconciliationEntryId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

const guestContext: GuestReservationPerformanceContext = {
  scope: { tenantId, storeId },
  customerId,
  tableSessionId,
  businessDate: '2026-08-11',
  actorRef: 'guest-session-001',
}

const staffContext: StaffReservationPerformanceContext = {
  scope: { tenantId, storeId },
  employeeId,
  businessDate: '2026-08-11',
}

const reservation: Reservation = {
  id: reservationId,
  publicId: 'reservation-public-0001',
  customerId,
  customerName: '王女士',
  contactToken: 'private-contact-token',
  guestCount: 2,
  arrivalAt: '2026-08-11T14:30:00.000Z',
  expectedEndAt: '2026-08-11T17:00:00.000Z',
  status: 'pending',
  source: 'wechat',
  ownerEmployeeId: null,
  note: '靠近舞台',
  reservationSnapshot: { scene: 'date' },
  createdAt: '2026-08-11T04:00:00.000Z',
  updatedAt: '2026-08-11T04:00:00.000Z',
  aggregateVersion: 1,
  customerCancelUntil: '2026-08-11T12:30:00.000Z',
  cancellationPolicySnapshot: { version: 1 },
  tableLocks: [{
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    reservationId,
    tableId,
    startsAt: '2026-08-11T14:30:00.000Z',
    endsAt: '2026-08-11T17:00:00.000Z',
    status: 'held',
    holdExpiresAt: '2026-08-11T12:20:00.000Z',
    tableCode: 'VIP1',
    tableDisplayName: 'VIP 1',
  }],
}

const schedule: PerformanceSchedule = {
  id: scheduleId,
  performerId,
  performerCode: 'NATALIE',
  performerStageName: 'Natalie',
  performerProfileSnapshot: { bio: 'Soul and pop', imageUrl: '/natalie.jpg', contractFee: 50_000, privatePhone: 'secret' },
  startsAt: '2026-08-11T12:30:00.000Z',
  endsAt: '2026-08-11T13:15:00.000Z',
  status: 'performing',
  sortOrder: 0,
  createdAt: '2026-08-11T03:00:00.000Z',
  updatedAt: '2026-08-11T04:00:00.000Z',
}

const dailyView: DailyPerformanceView = {
  timezone: 'Asia/Shanghai',
  localDate: '2026-08-11',
  phase: 'live',
  current: schedule,
  next: null,
  startsInSeconds: null,
  remainingSeconds: 900,
  schedules: [schedule],
}

const songRequest: SongRequest = {
  id: songRequestId,
  tableSessionId,
  performerId,
  scheduleId,
  customerId,
  songTitle: '后来',
  requestType: 'catalog',
  status: 'requested',
  quotedAmountMinor: null,
  currency: null,
  note: null,
  createdAt: '2026-08-11T04:00:00.000Z',
  updatedAt: '2026-08-11T04:00:00.000Z',
}

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function fixture(overrides: Partial<ReservationPerformanceApiOptions> = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM mbox.reservations')) return { rows: [{ id: reservationId }], rowCount: 1 }
    if (sql.includes('FROM mbox.performers')) return { rows: [{ id: performerId }], rowCount: 1 }
    if (sql.includes('FROM mbox.song_requests')) return { rows: [{ id: songRequestId }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const transaction = { scope: { tenantId, storeId }, query } as unknown as ScopedTransaction
  const transactions: ReservationPerformanceApiOptions['transactions'] = {
    run: vi.fn(async (_scope, operation) => operation(transaction)),
  }
  const staffAccess: EffectiveStaffAccess = {
    employeeId,
    employeeCode: 'LIYAN',
    displayName: '李艳',
    roleCodes: ['MANAGER'],
    roleNames: ['店长'],
    permissions: [
      'reservation.view', 'reservation.manage', 'reservation.contact.view',
      'reservation.cancel.override', 'song.view', 'song.manage', 'song.payment.record',
    ],
    deniedPermissions: [],
    dataScopes: [],
    approvalLimits: [],
    navigation: [],
    resolvedAt: '2026-08-11T04:00:00.000Z',
  }
  const assertPermission = vi.fn(async () => staffAccess)
  const reservationRepository = {
    findById: vi.fn(async () => reservation),
    findByPublicId: vi.fn(async () => reservation),
  }
  const performer = {
    id: performerId,
    code: 'NATALIE',
    stageName: 'Natalie',
    profileSnapshot: { bio: 'Soul and pop' },
    songCatalog: [{ code: 'SONG-1', title: '后来' }],
    status: 'active' as const,
    createdAt: '2026-08-11T03:00:00.000Z',
    updatedAt: '2026-08-11T04:00:00.000Z',
  }
  const performerRepository = { findById: vi.fn(async () => performer) }
  const scheduleRepository = { getDailyView: vi.fn(async () => dailyView) }
  const songRequestRepository = { findById: vi.fn(async () => songRequest) }
  const reservations: ReservationPerformanceApiOptions['reservations'] = {
    create: vi.fn(async () => ({ value: reservation, replayed: false })),
    confirm: vi.fn(async () => ({ value: { ...reservation, status: 'confirmed' as const }, replayed: false })),
    arrive: vi.fn(async () => ({ value: { ...reservation, status: 'arrived' as const }, replayed: false })),
    complete: vi.fn(async () => ({ value: { ...reservation, status: 'completed' as const }, replayed: false })),
    cancel: vi.fn(async () => ({ value: { ...reservation, status: 'cancelled' as const }, replayed: false })),
  }
  const submission: SongRequestSubmission = {
    request: songRequest,
    slot: 'current',
    extensionRequested: false,
    requiresStaffConfirmation: true,
  }
  const performance: ReservationPerformanceApiOptions['performance'] = {
    createPerformer: vi.fn(async () => ({ value: performer, replayed: false })),
    updatePerformer: vi.fn(async () => ({ value: performer, replayed: false })),
    createSchedule: vi.fn(async () => ({ value: schedule, replayed: false })),
    updateSchedule: vi.fn(async () => ({ value: schedule, replayed: false })),
    transitionSchedule: vi.fn(async () => ({ value: schedule, replayed: false })),
    submitSongRequest: vi.fn(async () => ({ value: submission, replayed: false })),
    confirmSongRequest: vi.fn(async () => ({ value: { ...songRequest, status: 'accepted' as const }, replayed: false })),
    rejectSongRequest: vi.fn(async () => ({ value: { ...songRequest, status: 'rejected' as const }, replayed: false })),
    markSongRequestPaid: vi.fn(async () => ({ value: { ...songRequest, status: 'paid' as const }, replayed: false })),
    markSongRequestPerformed: vi.fn(async () => ({ value: { ...songRequest, status: 'performed' as const }, replayed: false })),
    cancelSongRequest: vi.fn(async () => ({ value: { ...songRequest, status: 'cancelled' as const }, replayed: false })),
  }
  const options: ReservationPerformanceApiOptions = {
    transactions,
    reservations,
    performance,
    resolveGuestContext: vi.fn(async () => guestContext),
    resolveStaffContext: vi.fn(async () => staffContext),
    createStaffAccessRepository: () => ({ assertPermission }),
    createReservationRepository: () => reservationRepository,
    createPerformerRepository: () => performerRepository,
    createScheduleRepository: () => scheduleRepository,
    createSongRequestRepository: () => songRequestRepository,
    createPublicId: () => 'reservation-generated-0001',
    now: () => '2026-08-11T13:00:00.000Z',
    ...overrides,
  }
  const app = Fastify()
  apps.push(app)
  app.register(reservationPerformanceApiPlugin, { prefix: '/api', ...options })
  return {
    app,
    options,
    transactions,
    query,
    assertPermission,
    reservations,
    performance,
    reservationRepository,
    scheduleRepository,
    songRequestRepository,
  }
}

describe('reservationPerformanceApiPlugin guest reservation flows', () => {
  it('creates a customer-owned pending reservation and table hold without trusting identity claims', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/reservations',
      headers: { 'idempotency-key': 'guest-reservation-create-0001' },
      payload: {
        customerName: '王女士',
        contactToken: 'private-contact-token',
        guestCount: 2,
        arrivalAt: '2026-08-11T14:30:00.000Z',
        expectedEndAt: '2026-08-11T17:00:00.000Z',
        tableIds: [tableId],
        reservationSnapshot: { scene: 'date' },
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      data: { publicId: reservation.publicId, contactAvailable: true },
      meta: { replayed: false, tableLockMode: 'held' },
    })
    expect(JSON.stringify(response.json())).not.toContain('private-contact-token')
    expect(Object.keys(response.json().data).sort()).toEqual([
      'arrivalAt', 'contactAvailable', 'expectedEndAt', 'guestCount',
      'publicId', 'source', 'status', 'tables',
    ].sort())
    expect(value.reservations.create).toHaveBeenCalledWith(expect.objectContaining({
      customerId,
      source: 'wechat',
      initialStatus: 'pending',
      tableIds: [tableId],
      actor: { type: 'guest', ref: guestContext.actorRef },
      holdExpiresAt: '2026-08-11T13:20:00.000Z',
      customerCancelUntil: '2026-08-11T12:30:00.000Z',
    }))

    const forged = await value.app.inject({
      method: 'POST',
      url: '/api/guest/reservations',
      headers: { 'idempotency-key': 'guest-reservation-forged-0001' },
      payload: {
        customerId: otherCustomerId,
        customerName: '冒名客户',
        contactToken: 'contact',
        guestCount: 2,
        arrivalAt: '2026-08-11T14:30:00.000Z',
        expectedEndAt: '2026-08-11T17:00:00.000Z',
        tableIds: [tableId],
      },
    })
    expect(forged.statusCode).toBe(400)
    expect(forged.json()).toMatchObject({ error: { code: 'REQUEST_INVALID' } })

    const clientExpiry = await value.app.inject({
      method: 'POST',
      url: '/api/guest/reservations',
      headers: { 'idempotency-key': 'guest-reservation-expiry-claim-0001' },
      payload: {
        customerName: '王女士',
        contactToken: 'contact',
        guestCount: 2,
        arrivalAt: '2026-08-11T14:30:00.000Z',
        expectedEndAt: '2026-08-11T17:00:00.000Z',
        holdExpiresAt: '2026-08-11T14:29:00.000Z',
        tableIds: [tableId],
      },
    })
    expect(clientExpiry.statusCode).toBe(400)

    const tooFarAhead = await value.app.inject({
      method: 'POST',
      url: '/api/guest/reservations',
      headers: { 'idempotency-key': 'guest-reservation-too-far-0001' },
      payload: {
        customerName: '王女士',
        contactToken: 'contact',
        guestCount: 2,
        arrivalAt: '2027-01-11T14:30:00.000Z',
        expectedEndAt: '2027-01-11T17:00:00.000Z',
        tableIds: [tableId],
      },
    })
    expect(tooFarAhead.statusCode).toBe(400)
    expect(tooFarAhead.json()).toMatchObject({ error: { code: 'REQUEST_INVALID' } })
  })

  it('lists and reads only the authenticated customer reservations without exposing contact tokens', async () => {
    const value = fixture()
    const list = await value.app.inject({ method: 'GET', url: '/api/guest/reservations' })
    expect(list.statusCode).toBe(200)
    expect(list.json().data).toHaveLength(1)
    expect(JSON.stringify(list.json())).not.toContain('private-contact-token')
    expect(JSON.stringify(list.json())).not.toContain(reservationId)
    expect(JSON.stringify(list.json())).not.toContain(customerId)
    expect(JSON.stringify(list.json())).not.toContain(employeeId)
    expect(JSON.stringify(list.json())).not.toContain('靠近舞台')
    expect(JSON.stringify(list.json())).not.toContain('scene')

    const detail = await value.app.inject({
      method: 'GET',
      url: `/api/guest/reservations/${reservation.publicId}`,
    })
    expect(detail.statusCode).toBe(200)

    value.reservationRepository.findByPublicId.mockResolvedValueOnce({
      ...reservation,
      customerId: otherCustomerId,
    })
    const concealed = await value.app.inject({
      method: 'GET',
      url: `/api/guest/reservations/${reservation.publicId}`,
    })
    expect(concealed.statusCode).toBe(404)
    expect(concealed.json()).toEqual({
      error: { code: 'RESOURCE_NOT_FOUND', message: '未找到对应信息' },
    })
  })

  it('allows the owner to cancel and conceals another customer reservation', async () => {
    const value = fixture()
    const cancelled = await value.app.inject({
      method: 'DELETE',
      url: `/api/guest/reservations/${reservation.publicId}`,
      headers: { 'idempotency-key': 'guest-reservation-cancel-0001' },
      payload: { reason: '行程有变' },
    })
    expect(cancelled.statusCode).toBe(200)
    expect(value.reservations.cancel).toHaveBeenCalledWith(expect.objectContaining({
      reservationId,
      reason: '行程有变',
      actor: { type: 'guest', ref: guestContext.actorRef },
    }))

    value.reservationRepository.findByPublicId.mockResolvedValueOnce({ ...reservation, customerId: otherCustomerId })
    const denied = await value.app.inject({
      method: 'DELETE',
      url: `/api/guest/reservations/${reservation.publicId}`,
      headers: { 'idempotency-key': 'guest-reservation-cancel-0002' },
    })
    expect(denied.statusCode).toBe(404)
    expect(value.reservations.cancel).toHaveBeenCalledTimes(1)
  })
})

describe('reservationPerformanceApiPlugin staff reservation permissions', () => {
  it('returns only unresolved prior-business-day reservations for the carryover worklist', async () => {
    const value = fixture()
    const response = await value.app.inject({ method: 'GET', url: '/api/staff/reservations?range=carryover' })

    expect(response.statusCode).toBe(200)
    const reservationQuery = value.query.mock.calls.find(([sql]) => String(sql).includes('FROM mbox.reservations'))
    expect(reservationQuery?.[0]).toContain("reservation.status IN ('pending','confirmed','arrived','seated')")
    expect(reservationQuery?.[1]).toContain('carryover')
  })

  it('requires both dates for an explicit history search', async () => {
    const value = fixture()
    const response = await value.app.inject({ method: 'GET', url: '/api/staff/reservations?range=history' })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { message: '历史查询必须同时提供起止时间' } })
    expect(value.query).not.toHaveBeenCalled()
  })

  it('returns only unresolved prior-business-day reservations for the carryover worklist', async () => {
    const value = fixture()
    const response = await value.app.inject({ method: 'GET', url: '/api/staff/reservations?range=carryover' })

    expect(response.statusCode).toBe(200)
    const reservationQuery = value.query.mock.calls.find(([sql]) => String(sql).includes('FROM mbox.reservations'))
    expect(reservationQuery?.[0]).toContain("reservation.status IN ('pending','confirmed','arrived','seated')")
    expect(reservationQuery?.[1]).toContain('carryover')
  })

  it('requires both dates for an explicit history search', async () => {
    const value = fixture()
    const response = await value.app.inject({ method: 'GET', url: '/api/staff/reservations?range=history' })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { message: '历史查询必须同时提供起止时间' } })
    expect(value.query).not.toHaveBeenCalled()
  })

  it('checks live StaffAccessRepository permissions for reads and management commands', async () => {
    const value = fixture()
    const list = await value.app.inject({ method: 'GET', url: '/api/staff/reservations?status=pending' })
    expect(list.statusCode).toBe(200)
    expect(value.assertPermission).toHaveBeenNthCalledWith(1, employeeId, 'reservation.view')

    const arrived = await value.app.inject({
      method: 'POST',
      url: `/api/staff/reservations/${reservationId}/arrive`,
      headers: { 'idempotency-key': 'staff-reservation-arrive-0001' },
    })
    expect(arrived.statusCode).toBe(200)
    expect(value.assertPermission).toHaveBeenNthCalledWith(2, employeeId, 'reservation.manage')
    expect(value.reservations.arrive).toHaveBeenCalledWith(expect.objectContaining({
      reservationId,
      actor: { type: 'employee', employeeId },
    }))

    const completed = await value.app.inject({
      method: 'POST',
      url: `/api/staff/reservations/${reservationId}/complete`,
      headers: { 'idempotency-key': 'staff-reservation-complete-0001' },
      payload: { reason: '本次接待已完成，归档当日预约' },
    })
    expect(completed.statusCode).toBe(200)
    expect(value.assertPermission).toHaveBeenNthCalledWith(3, employeeId, 'reservation.manage')
    expect(value.reservations.complete).toHaveBeenCalledWith(expect.objectContaining({
      reservationId,
      actor: { type: 'employee', employeeId },
      reason: '本次接待已完成，归档当日预约',
    }))
  })

  it('returns a stable 403 and does not execute commands when database permission is denied', async () => {
    const value = fixture()
    value.assertPermission.mockRejectedValueOnce(new StaffAccessDeniedError('internal detail'))
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/staff/reservations/${reservationId}/confirm`,
      headers: { 'idempotency-key': 'staff-reservation-denied-0001' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      error: { code: 'STAFF_ACCESS_FORBIDDEN', message: '当前员工无权执行此操作' },
    })
    expect(value.reservations.confirm).not.toHaveBeenCalled()
  })

  it('returns a stable 401 when the trusted staff session has expired', async () => {
    const value = fixture({
      resolveStaffContext: vi.fn(async () => { throw new StaffSessionNotFoundError() }),
    })
    const response = await value.app.inject({ method: 'GET', url: '/api/staff/reservations' })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: { code: 'AUTH_REQUIRED', message: '登录信息无效或已过期，请重新登录' },
    })
    expect(value.assertPermission).not.toHaveBeenCalled()
  })

  it('applies owner and area data scopes and hides contact without the dedicated permission', async () => {
    const value = fixture()
    value.assertPermission.mockResolvedValueOnce({
      employeeId,
      employeeCode: 'TOM',
      displayName: 'Tom',
      roleCodes: ['SERVICE'],
      roleNames: ['服务员'],
      permissions: ['reservation.view'],
      deniedPermissions: [],
      dataScopes: [{ key: 'reservation.area_ids', effect: 'include', value: [areaId] }],
      approvalLimits: [],
      navigation: [],
      resolvedAt: '2026-08-11T04:00:00.000Z',
    })
    const response = await value.app.inject({ method: 'GET', url: '/api/staff/reservations' })
    expect(response.statusCode).toBe(200)
    expect(response.json().data[0]).not.toHaveProperty('contactToken')
    expect(response.json().data[0]).toMatchObject({ contactAvailable: true })
    const scopedCall = value.query.mock.calls.find(([sql]) => sql.includes('FROM mbox.reservations AS reservation'))
    expect(scopedCall?.[0]).toContain("reservation.status = 'pending'")
    expect(scopedCall?.[0]).toContain("($9::date + 1)::timestamp + reservation_store.business_day_cutoff")
    expect(scopedCall?.[1]).toEqual([
      tenantId, storeId, null, null, null, false, [employeeId], [areaId], '2026-08-11', 'current',
    ])
  })

  it('requires an explicit exception permission and reason to cancel past policy', async () => {
    const value = fixture()
    value.assertPermission.mockResolvedValueOnce({
      employeeId,
      employeeCode: 'TOM',
      displayName: 'Tom',
      roleCodes: ['SERVICE'],
      roleNames: ['服务员'],
      permissions: ['reservation.manage'],
      deniedPermissions: [],
      dataScopes: [],
      approvalLimits: [],
      navigation: [],
      resolvedAt: '2026-08-11T04:00:00.000Z',
    })
    const denied = await value.app.inject({
      method: 'POST',
      url: `/api/staff/reservations/${reservationId}/cancel`,
      headers: { 'idempotency-key': 'staff-reservation-override-denied-0001' },
      payload: { overridePolicy: true, reason: '经理现场处理' },
    })
    expect(denied.statusCode).toBe(403)
    expect(value.reservations.cancel).not.toHaveBeenCalled()

    const missingReason = await value.app.inject({
      method: 'POST',
      url: `/api/staff/reservations/${reservationId}/cancel`,
      headers: { 'idempotency-key': 'staff-reservation-override-reason-0001' },
      payload: { overridePolicy: true },
    })
    expect(missingReason.statusCode).toBe(400)
  })

  it('maps a concurrent table lock conflict to a stable customer-facing error', async () => {
    const value = fixture({
      reservations: {
        create: vi.fn(async () => { throw new ReservationConflictError() }),
        confirm: vi.fn(),
        arrive: vi.fn(),
        cancel: vi.fn(),
      },
    })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/reservations',
      headers: { 'idempotency-key': 'guest-reservation-conflict-0001' },
      payload: {
        customerName: '王女士',
        contactToken: 'contact',
        guestCount: 2,
        arrivalAt: '2026-08-11T14:30:00.000Z',
        expectedEndAt: '2026-08-11T17:00:00.000Z',
        tableIds: [tableId],
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      error: { code: 'RESERVATION_TABLE_CONFLICT', message: '所选桌位在该时段已不可预约' },
    })
  })
})

describe('reservationPerformanceApiPlugin performance and song requests', () => {
  it('returns today performance and binds a guest song request to the trusted table session', async () => {
    const value = fixture()
    const current = await value.app.inject({ method: 'GET', url: '/api/guest/performances/today' })
    expect(current.statusCode).toBe(200)
    expect(current.json()).toMatchObject({
      data: {
        phase: 'live',
        current: {
          performerStageName: 'Natalie',
          performerProfile: { bio: 'Soul and pop', imageUrl: '/natalie.jpg' },
        },
        remainingSeconds: 900,
      },
    })
    expect(JSON.stringify(current.json())).not.toContain('contractFee')
    expect(JSON.stringify(current.json())).not.toContain('privatePhone')
    expect(JSON.stringify(current.json())).not.toContain(performerId)
    expect(value.scheduleRepository.getDailyView).toHaveBeenCalledWith(
      '2026-08-11',
      '2026-08-11T13:00:00.000Z',
    )

    const submitted = await value.app.inject({
      method: 'POST',
      url: '/api/guest/song-requests',
      headers: { 'idempotency-key': 'guest-song-submit-0001' },
      payload: { scheduleId, songTitle: '后来', requestType: 'catalog' },
    })
    expect(submitted.statusCode).toBe(201)
    expect(value.performance.submitSongRequest).toHaveBeenCalledWith(expect.objectContaining({
      tableSessionId,
      customerId,
      scheduleId,
      requestedAt: '2026-08-11T13:00:00.000Z',
      actor: { type: 'guest', ref: guestContext.actorRef },
    }))
    expect(Object.keys(submitted.json().data.request).sort()).toEqual([
      'createdAt', 'currency', 'id', 'quotedAmountMinor', 'requestType',
      'songTitle', 'status', 'updatedAt',
    ].sort())
    const publicSongJson = JSON.stringify(submitted.json())
    expect(publicSongJson).not.toContain(customerId)
    expect(publicSongJson).not.toContain(tableSessionId)
    expect(publicSongJson).not.toContain(performerId)
    expect(publicSongJson).not.toContain('note')

    const cancelled = await value.app.inject({
      method: 'DELETE',
      url: `/api/guest/song-requests/${songRequestId}`,
      headers: { 'idempotency-key': 'guest-song-cancel-0001' },
    })
    expect(cancelled.statusCode).toBe(200)
    expect(value.performance.cancelSongRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: songRequestId,
      customerId,
      tableSessionId,
      actor: { type: 'guest', ref: guestContext.actorRef },
    }))
    expect(value.songRequestRepository.findById).not.toHaveBeenCalled()
  })

  it('uses song.view for staff queues and song.manage for performer, schedule and request changes', async () => {
    const value = fixture()
    const performers = await value.app.inject({ method: 'GET', url: '/api/staff/performers' })
    expect(performers.statusCode).toBe(200)
    expect(value.assertPermission).toHaveBeenLastCalledWith(employeeId, 'song.view')

    const createdSchedule = await value.app.inject({
      method: 'POST',
      url: '/api/staff/schedules',
      headers: { 'idempotency-key': 'staff-schedule-create-0001' },
      payload: {
        performerId,
        startsAt: '2026-08-11T12:30:00.000Z',
        endsAt: '2026-08-11T13:15:00.000Z',
      },
    })
    expect(createdSchedule.statusCode).toBe(201)
    expect(value.assertPermission).toHaveBeenLastCalledWith(employeeId, 'song.manage')

    const confirmed = await value.app.inject({
      method: 'POST',
      url: `/api/staff/song-requests/${songRequestId}/confirm`,
      headers: { 'idempotency-key': 'staff-song-confirm-0001' },
      payload: { quotedAmountMinor: 20000, currency: 'CNY' },
    })
    expect(confirmed.statusCode).toBe(200)
    expect(value.performance.confirmSongRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: songRequestId,
      actorEmployeeId: employeeId,
      actor: { type: 'employee', employeeId },
      quotedAmountMinor: 20000,
      currency: 'CNY',
    }))
  })

  it('prevents a customer without an open table session from submitting song requests', async () => {
    const value = fixture({
      resolveGuestContext: vi.fn(async () => ({ ...guestContext, tableSessionId: null })),
    })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/song-requests',
      headers: { 'idempotency-key': 'guest-song-no-table-0001' },
      payload: { scheduleId, songTitle: '后来', requestType: 'catalog' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'SONG_REQUEST_NOT_ELIGIBLE' } })
    expect(value.performance.submitSongRequest).not.toHaveBeenCalled()
  })

  it('uses a dedicated cashier permission and requires payment evidence to mark a song paid', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/staff/song-requests/${songRequestId}/paid`,
      headers: { 'idempotency-key': 'song-payment-evidence-0001' },
      payload: { paymentId, reconciliationEntryId },
    })
    expect(response.statusCode).toBe(200)
    expect(value.assertPermission).toHaveBeenLastCalledWith(employeeId, 'song.payment.record')
    expect(value.performance.markSongRequestPaid).toHaveBeenCalledWith(expect.objectContaining({
      requestId: songRequestId,
      actorEmployeeId: employeeId,
      paymentId,
      reconciliationEntryId,
    }))
  })
})

const integrationDatabaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const postgresIntegration = integrationDatabaseUrl ? describe : describe.skip

postgresIntegration('reservationPerformanceApiPlugin PostgreSQL privacy and data scopes', () => {
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }
  const scopedCustomerId = randomUUID()
  const scopedEmployeeId = randomUUID()
  const otherEmployeeId = randomUUID()
  const firstAreaId = randomUUID()
  const secondAreaId = randomUUID()
  const firstTableId = randomUUID()
  const secondTableId = randomUUID()
  const thirdTableId = randomUUID()
  let pool: Pool
  let app: FastifyInstance
  let staffAccess: EffectiveStaffAccess
  const reservationIds: string[] = []

  beforeAll(async () => {
    await runNormalizedMigrations(integrationDatabaseUrl!)
    pool = new Pool({ connectionString: integrationDatabaseUrl, max: 8 })
    const runner = new ScopedPostgresTransactionRunner(asPostgresPool(pool))
    const executor = new NormalizedCommandExecutor(runner)
    const reservations = new ReservationCommandService(executor)
    const performance = new PerformanceCommandService(executor)
    await seedApiScope(pool, {
      ...scope,
      customerId: scopedCustomerId,
      employeeId: scopedEmployeeId,
      otherEmployeeId,
      firstAreaId,
      secondAreaId,
      firstTableId,
      secondTableId,
      thirdTableId,
    })
    const definitions = [
      { tableId: firstTableId, ownerEmployeeId: scopedEmployeeId, suffix: 'owned' },
      { tableId: secondTableId, ownerEmployeeId: otherEmployeeId, suffix: 'area' },
      { tableId: thirdTableId, ownerEmployeeId: otherEmployeeId, suffix: 'hidden' },
    ]
    for (const [index, definition] of definitions.entries()) {
      const created = await reservations.create({
        scope,
        actor: { type: 'employee', employeeId: definition.ownerEmployeeId },
        businessDate: '2026-08-11',
        publicId: `api-scope-reservation-${definition.suffix}`,
        customerId: scopedCustomerId,
        customerName: `Private Guest ${definition.suffix}`,
        contactToken: `private-contact-${definition.suffix}`,
        guestCount: 2 + index,
        arrivalAt: `2026-08-12T${12 + index}:00:00.000Z`,
        expectedEndAt: `2026-08-12T${14 + index}:00:00.000Z`,
        source: 'phone',
        ownerEmployeeId: definition.ownerEmployeeId,
        note: `private-note-${definition.suffix}`,
        reservationSnapshot: { internalSegment: definition.suffix },
        tableIds: [definition.tableId],
        initialStatus: 'confirmed',
        customerCancelUntil: '2026-08-12T10:00:00.000Z',
        cancellationPolicySnapshot: { internalRule: true },
        idempotencyKey: `api-scope-create-${definition.suffix}-0001`,
        requestFingerprint: `api-scope-create-${definition.suffix}-fingerprint`,
      })
      reservationIds.push(created.value.id)
    }
    staffAccess = scopedAccess({
      employeeId: scopedEmployeeId,
      roleCodes: ['SERVICE'],
      permissions: ['reservation.view'],
      dataScopes: [{ key: 'reservation.area_ids', effect: 'include', value: [firstAreaId] }],
    })
    app = Fastify()
    app.register(reservationPerformanceApiPlugin, {
      prefix: '/api',
      transactions: runner,
      reservations,
      performance,
      resolveGuestContext: async () => ({
        scope,
        customerId: scopedCustomerId,
        tableSessionId: null,
        businessDate: '2026-08-11',
        actorRef: 'postgres-privacy-guest',
      }),
      resolveStaffContext: async () => ({
        scope,
        employeeId: scopedEmployeeId,
        businessDate: '2026-08-11',
      }),
      createStaffAccessRepository: () => ({ assertPermission: async () => staffAccess }),
      now: () => '2026-08-11T13:00:00.000Z',
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await pool?.end()
  })

  it('uses strict public DTOs and enforces owner, area, manager and contact scopes', async () => {
    const staffUrl = '/api/staff/reservations?from=2026-08-12T00%3A00%3A00.000Z&to=2026-08-13T00%3A00%3A00.000Z'
    const guest = await app.inject({ method: 'GET', url: '/api/guest/reservations' })
    expect(guest.statusCode).toBe(200)
    expect(guest.json().data).toHaveLength(3)
    for (const value of guest.json().data) {
      expect(Object.keys(value).sort()).toEqual([
        'arrivalAt', 'contactAvailable', 'expectedEndAt', 'guestCount',
        'publicId', 'source', 'status', 'tables',
      ].sort())
    }
    const publicJson = JSON.stringify(guest.json())
    for (const privateValue of [
      ...reservationIds,
      scopedCustomerId,
      scopedEmployeeId,
      otherEmployeeId,
      'private-contact',
      'private-note',
      'internalSegment',
      'internalRule',
    ]) expect(publicJson).not.toContain(privateValue)

    const areaScoped = await app.inject({ method: 'GET', url: staffUrl })
    expect(areaScoped.statusCode).toBe(200)
    expect(areaScoped.json().data).toHaveLength(2)
    expect(areaScoped.json().data.every((value: Record<string, unknown>) => !('contactToken' in value))).toBe(true)

    staffAccess = scopedAccess({
      employeeId: scopedEmployeeId,
      roleCodes: ['GREETER'],
      permissions: ['reservation.view', 'reservation.view.all'],
      dataScopes: [],
    })
    const greeter = await app.inject({ method: 'GET', url: staffUrl })
    expect(greeter.json().data).toHaveLength(3)
    expect(greeter.json().data.every((value: Record<string, unknown>) => !('contactToken' in value))).toBe(true)

    staffAccess = scopedAccess({
      employeeId: scopedEmployeeId,
      roleCodes: ['SERVICE'],
      permissions: ['reservation.view'],
      dataScopes: [],
    })
    const ownerOnly = await app.inject({ method: 'GET', url: staffUrl })
    expect(ownerOnly.json().data).toHaveLength(1)
    expect(ownerOnly.json().data[0]).toMatchObject({ ownerEmployeeId: scopedEmployeeId })

    staffAccess = scopedAccess({
      employeeId: scopedEmployeeId,
      roleCodes: ['MANAGER'],
      permissions: ['reservation.view', 'reservation.view.all', 'reservation.contact.view'],
      dataScopes: [],
    })
    const manager = await app.inject({ method: 'GET', url: staffUrl })
    expect(manager.json().data).toHaveLength(3)
    expect(manager.json().data.every((value: Record<string, unknown>) => (
      typeof value.contactToken === 'string' && value.contactToken.startsWith('private-contact-')
    ))).toBe(true)
  })
})

describe('normalized architecture boundary', () => {
  it('does not reference whole-store runtime state, mutate queues or operational projections', async () => {
    const source = await readFile(new URL('./reservation-performance-api.ts', import.meta.url), 'utf8')
    const forbidden = [
      ['Runtime', 'State'].join(''),
      ['repository', '.mutate'].join(''),
      ['operational', '_'].join(''),
      ['mutation', 'Tail'].join(''),
    ]
    for (const token of forbidden) expect(source).not.toContain(token)
  })
})

function asPostgresPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}

function scopedAccess(input: {
  employeeId: string
  roleCodes: string[]
  permissions: string[]
  dataScopes: EffectiveStaffAccess['dataScopes']
}): EffectiveStaffAccess {
  return {
    employeeId: input.employeeId,
    employeeCode: 'SCOPED',
    displayName: 'Scoped Employee',
    roleCodes: input.roleCodes,
    roleNames: input.roleCodes,
    permissions: input.permissions,
    deniedPermissions: [],
    dataScopes: input.dataScopes,
    approvalLimits: [],
    navigation: [],
    resolvedAt: '2026-08-11T13:00:00.000Z',
  }
}

async function seedApiScope(pool: Pool, input: {
  tenantId: string
  storeId: string
  customerId: string
  employeeId: string
  otherEmployeeId: string
  firstAreaId: string
  secondAreaId: string
  firstTableId: string
  secondTableId: string
  thirdTableId: string
}): Promise<void> {
  const suffix = input.tenantId.slice(0, 8)
  await pool.query(`
    INSERT INTO mbox.tenants(id, code, name) VALUES ($1, $2, 'API Scope Tenant')
  `, [input.tenantId, `api-scope-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.stores(id, tenant_id, code, name, timezone, business_day_cutoff)
    VALUES ($1, $2, $3, 'API Scope Store', 'Asia/Shanghai', '06:00')
  `, [input.storeId, input.tenantId, `api-scope-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.public_reservation_policies (
      tenant_id, store_id, hold_minutes, arrival_grace_minutes
    ) VALUES ($1, $2, 20, 10)
  `, [input.tenantId, input.storeId])
  await pool.query(`
    INSERT INTO mbox.areas(id, tenant_id, store_id, code, name, area_type) VALUES
      ($1, $3, $4, 'AREA_A', 'Area A', 'indoor'),
      ($2, $3, $4, 'AREA_B', 'Area B', 'indoor')
  `, [input.firstAreaId, input.secondAreaId, input.tenantId, input.storeId])
  await pool.query(`
    INSERT INTO mbox.tables(id, tenant_id, store_id, area_id, code, display_name, capacity) VALUES
      ($1, $4, $5, $6, 'A01', 'A01', 4),
      ($2, $4, $5, $6, 'A02', 'A02', 4),
      ($3, $4, $5, $7, 'B01', 'B01', 4)
  `, [
    input.firstTableId,
    input.secondTableId,
    input.thirdTableId,
    input.tenantId,
    input.storeId,
    input.firstAreaId,
    input.secondAreaId,
  ])
  await pool.query(`
    INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name, status) VALUES
      ($1, $3, $4, 'SCOPED01', 'Scoped Employee', 'active'),
      ($2, $3, $4, 'OTHER01', 'Other Employee', 'active')
  `, [input.employeeId, input.otherEmployeeId, input.tenantId, input.storeId])
  await pool.query(`
    INSERT INTO mbox.customers(id, tenant_id, store_id, public_id, status)
    VALUES ($1, $2, $3, $4, 'active')
  `, [input.customerId, input.tenantId, input.storeId, `api-customer-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.customer_identities(
      tenant_id, store_id, customer_id, identity_kind, identity_hash
    ) VALUES ($1, $2, $3, 'anonymous', $4)
  `, [input.tenantId, input.storeId, input.customerId, 'b'.repeat(64)])
}
