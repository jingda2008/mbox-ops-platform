import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { AuthorizationError } from './authorization.js'
import { registerReservationRoutes } from './reservation-api.js'
import { JsonRepository } from './repository.js'

function auth(roleId: string, actorId = roleId === 'host' ? 'emp-host' : `test-${roleId}`) {
  return { 'x-test-role': roleId, 'x-test-actor': actorId }
}

async function fixture() {
  const repository = new JsonRepository(`/tmp/mbox-reservation-authorization-${crypto.randomUUID()}.json`)
  await repository.init()
  await repository.mutate((state) => {
    const host = state.employees.find((item) => item.id === 'emp-host')!
    host.roleId = 'host'
    host.roleIds = []
    host.permissionIds = []
    host.areaIds = state.areas.map((area) => area.id)
    host.online = true
    host.paused = false
    state.shiftAssignments = state.shiftAssignments.filter((shift) => shift.employeeId !== host.id)
    state.shiftAssignments.push({
      id: 'shift-test-host',
      employeeId: host.id,
      businessDate: state.store.businessDate,
      startAt: `${state.store.businessDate}T12:00:00+08:00`,
      endAt: `${state.store.businessDate}T23:59:59+08:00`,
      roleId: 'host',
      areaIds: state.areas.map((area) => area.id),
      stationIds: [],
      isPrimary: false,
      status: 'active',
    })
    state.revision += 1
  })
  const app = Fastify()
  app.addHook('preHandler', async (request) => {
    const roleId = String(request.headers['x-test-role'] ?? 'host')
    request.mboxActor = {
      actorId: String(request.headers['x-test-actor'] ?? `emp-${roleId}`),
      storeId: 'mbox-lujiazui',
      roleId,
      runtimeMode: 'test',
      authenticatedBy: 'local_header',
    }
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthorizationError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message, operation: error.operation })
    }
    return reply.send(error)
  })
  registerReservationRoutes(app, repository)
  return { app, repository }
}

function payload(suffix: string, depositRequiredAmount = 0, scheduledAt = '2030-07-14T20:00:00.000+08:00') {
  return {
    customerReference: `member-${suffix}`,
    customerName: '预约客人',
    contactReference: `contact-${suffix}`,
    sourceCode: 'wechat',
    partySize: 6,
    scheduledAt,
    depositRequiredAmount,
    depositCurrency: 'CNY',
    idempotencyKey: `reservation-create-${suffix}`,
  }
}

async function create(app: FastifyInstance, suffix: string, depositRequiredAmount = 0, scheduledAt?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/reservations',
    headers: auth('host'),
    payload: payload(suffix, depositRequiredAmount, scheduledAt),
  })
}

async function prepareRefund(app: FastifyInstance, suffix: string) {
  const created = await create(app, suffix, 50_000)
  expect(created.statusCode).toBe(201)
  const reservationId = created.json().id as string
  const intentReference = `intent-${suffix}`

  const intent = await app.inject({
    method: 'POST',
    url: `/api/reservations/${reservationId}/deposit-intent`,
    headers: auth('host'),
    payload: { paymentIntentReference: intentReference, idempotencyKey: `reservation-intent-${suffix}` },
  })
  expect(intent.statusCode).toBe(200)

  const paid = await app.inject({
    method: 'POST',
    url: `/api/reservations/${reservationId}/deposit-confirmation`,
    headers: auth('cashier', `emp-cashier-${suffix}`),
    payload: {
      paymentIntentReference: intentReference,
      paymentConfirmationReference: `payment-${suffix}`,
      confirmedAmount: 50_000,
      currency: 'CNY',
      idempotencyKey: `reservation-payment-${suffix}`,
    },
  })
  expect(paid.statusCode).toBe(200)

  const cancelled = await app.inject({
    method: 'POST',
    url: `/api/reservations/${reservationId}/actions`,
    headers: auth('host'),
    payload: { action: 'cancel', reason: '顾客取消', idempotencyKey: `reservation-cancel-${suffix}` },
  })
  expect(cancelled.statusCode).toBe(200)
  return reservationId
}

describe('reservation operation authorization', () => {
  it('lets a host manage reservation arrival, seating and no-show without confirming deposits', async () => {
    const { app, repository } = await fixture()
    const created = await create(app, 'host-actions')
    const reservationId = created.json().id as string
    expect(created.statusCode).toBe(201)

    for (const [action, key] of [
      ['confirm', 'reservation-host-confirm'],
      ['arrive', 'reservation-host-arrive'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/reservations/${reservationId}/actions`,
        headers: auth('host'),
        payload: { action, idempotencyKey: key },
      })
      expect(response.statusCode).toBe(200)
    }
    const seated = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/actions`,
      headers: auth('host'),
      payload: {
        action: 'seat',
        tableId: 'table-l04',
        idempotencyKey: 'reservation-host-seat',
      },
    })
    expect({ statusCode: seated.statusCode, body: seated.json() }).toEqual({
      statusCode: 200,
      body: expect.objectContaining({ status: 'seated' }),
    })
    const openedTable = (await repository.read()).tables.find((table) => table.id === 'table-l04')
    expect(openedTable).toMatchObject({ status: 'occupied', guestCount: 6 })
    expect((await repository.read()).awaitingOrderIntents).toHaveLength(1)

    const noShowCreated = await create(app, 'host-no-show', 0, '2020-07-14T20:00:00.000+08:00')
    const noShowId = noShowCreated.json().id as string
    await app.inject({
      method: 'POST',
      url: `/api/reservations/${noShowId}/actions`,
      headers: auth('host'),
      payload: { action: 'confirm', idempotencyKey: 'reservation-host-no-show-confirm' },
    })
    const noShow = await app.inject({
      method: 'POST',
      url: `/api/reservations/${noShowId}/actions`,
      headers: auth('host'),
      payload: { action: 'no_show', reason: '超过预约时间未到', idempotencyKey: 'reservation-host-no-show' },
    })
    expect(noShow.json().status).toBe('no_show')

    const depositCreated = await create(app, 'host-deposit-denied', 50_000)
    const depositId = depositCreated.json().id as string
    await app.inject({
      method: 'POST',
      url: `/api/reservations/${depositId}/deposit-intent`,
      headers: auth('host'),
      payload: { paymentIntentReference: 'intent-host-denied', idempotencyKey: 'reservation-host-intent-denied' },
    })
    const denied = await app.inject({
      method: 'POST',
      url: `/api/reservations/${depositId}/deposit-confirmation`,
      headers: auth('host'),
      payload: {
        paymentIntentReference: 'intent-host-denied',
        paymentConfirmationReference: 'payment-host-denied',
        confirmedAmount: 50_000,
        currency: 'CNY',
        idempotencyKey: 'reservation-host-payment-denied',
      },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().operation).toBe('reservation.deposit.confirm')
    await app.close()
    await repository.close()
  })

  it('lets a cashier confirm deposits and request refunds but not approve them', async () => {
    const { app, repository } = await fixture()
    const reservationId = await prepareRefund(app, 'cashier-refund')
    const refundRequestReference = 'refund-cashier-refund'
    const started = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/deposit-refunds`,
      headers: auth('cashier', 'emp-cashier-refund'),
      payload: { refundRequestReference, idempotencyKey: 'reservation-refund-start-cashier' },
    })
    expect(started.json().deposit.status).toBe('refund_processing')

    const denied = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/deposit-refund-confirmation`,
      headers: auth('cashier', 'emp-cashier-refund'),
      payload: {
        refundRequestReference,
        refundConfirmationReference: 'refund-confirm-cashier',
        refundedAmount: 50_000,
        currency: 'CNY',
        idempotencyKey: 'reservation-refund-complete-cashier',
      },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().operation).toBe('reservation.deposit.refund.approve')

    const approved = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/deposit-refund-confirmation`,
      headers: auth('manager', 'emp-manager-approver'),
      payload: {
        refundRequestReference,
        refundConfirmationReference: 'refund-confirm-manager',
        refundedAmount: 50_000,
        currency: 'CNY',
        idempotencyKey: 'reservation-refund-complete-manager',
      },
    })
    expect(approved.json().deposit.status).toBe('refunded')
    await app.close()
    await repository.close()
  })

  it('separates refund requester and approver and reads the latest configured role permissions', async () => {
    const { app, repository } = await fixture()
    const reservationId = await prepareRefund(app, 'separation')
    const refundRequestReference = 'refund-separation'
    await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/deposit-refunds`,
      headers: auth('manager', 'emp-manager-requester'),
      payload: { refundRequestReference, idempotencyKey: 'reservation-refund-start-separation' },
    })

    const selfApproval = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/deposit-refund-confirmation`,
      headers: auth('manager', 'emp-manager-requester'),
      payload: {
        refundRequestReference,
        refundConfirmationReference: 'refund-confirm-self',
        refundedAmount: 50_000,
        currency: 'CNY',
        idempotencyKey: 'reservation-refund-complete-self',
      },
    })
    expect(selfApproval.statusCode).toBe(403)
    expect(selfApproval.json().message).toContain('不同员工')

    await repository.mutate((state) => {
      const manager = state.config.roles.find((role) => role.id === 'manager')!
      manager.permissionIds = manager.permissionIds?.filter((permission) => permission !== 'payment.refund.approve')
      state.revision += 1
    })
    const revokedManager = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/deposit-refund-confirmation`,
      headers: auth('manager', 'emp-manager-other'),
      payload: {
        refundRequestReference,
        refundConfirmationReference: 'refund-confirm-revoked-manager',
        refundedAmount: 50_000,
        currency: 'CNY',
        idempotencyKey: 'reservation-refund-complete-revoked-manager',
      },
    })
    expect(revokedManager.statusCode).toBe(403)

    const ownerApproval = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/deposit-refund-confirmation`,
      headers: auth('owner', 'emp-owner-approver'),
      payload: {
        refundRequestReference,
        refundConfirmationReference: 'refund-confirm-owner',
        refundedAmount: 50_000,
        currency: 'CNY',
        idempotencyKey: 'reservation-refund-complete-owner',
      },
    })
    expect(ownerApproval.json().deposit.status).toBe('refunded')
    await app.close()
    await repository.close()
  })

  it('keeps administrators out of every reservation money operation', async () => {
    const { app, repository } = await fixture()
    const cases = [
      {
        url: '/api/reservations/unknown/deposit-confirmation',
        payload: {
          paymentIntentReference: 'intent-admin', paymentConfirmationReference: 'payment-admin',
          confirmedAmount: 50_000, currency: 'CNY', idempotencyKey: 'reservation-admin-confirm',
        },
      },
      {
        url: '/api/reservations/unknown/deposit-refunds',
        payload: { refundRequestReference: 'refund-admin', idempotencyKey: 'reservation-admin-refund-start' },
      },
      {
        url: '/api/reservations/unknown/deposit-refund-confirmation',
        payload: {
          refundRequestReference: 'refund-admin', refundConfirmationReference: 'refund-confirm-admin',
          refundedAmount: 50_000, currency: 'CNY', idempotencyKey: 'reservation-admin-refund-complete',
        },
      },
    ]
    for (const testCase of cases) {
      const response = await app.inject({ method: 'POST', headers: auth('admin'), ...testCase })
      expect(response.statusCode).toBe(403)
      expect(response.json().code).toBe('AUTHORIZATION_DENIED')
    }
    await app.close()
    await repository.close()
  })
})
