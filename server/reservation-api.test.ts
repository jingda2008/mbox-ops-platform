import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerReservationRoutes } from './reservation-api.js'
import { JsonRepository } from './repository.js'

async function fixture(authenticated = true, roleId = 'server') {
  const repository = new JsonRepository(`/tmp/mbox-reservations-${crypto.randomUUID()}.json`)
  await repository.init()
  const app = Fastify()
  if (authenticated) {
    app.addHook('preHandler', async (request) => {
      const actorId = roleId === 'manager' ? 'emp-chen' : 'emp-lin'
      request.mboxActor = {
        actorId,
        storeId: 'mbox-lujiazui',
        roleId,
        runtimeMode: 'test',
        authenticatedBy: 'local_header',
      }
    })
  }
  registerReservationRoutes(app, repository)
  return { app, repository }
}

const reservationPayload = {
  customerReference: 'member-opaque-1',
  customerName: '王女士',
  contactReference: 'encrypted-contact-1',
  sourceCode: 'wechat',
  partySize: 6,
  occasionCode: 'birthday',
  occasionNote: '不要提前透露生日环节',
  scheduledAt: '2030-07-14T20:00:00.000+08:00',
  depositRequiredAmount: 50000,
  depositCurrency: 'CNY',
  idempotencyKey: 'reservation-api-create-0001',
}

describe('reservation employee API', () => {
  it('rejects creating a fake reservation for a walk-in guest', async () => {
    const { app, repository } = await fixture(true, 'manager')
    const response = await app.inject({
      method: 'POST', url: '/api/reservations',
      payload: { ...reservationPayload, sourceCode: 'walk_in', idempotencyKey: 'reservation-walk-in-rejected-0001' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'WALK_IN_USES_TABLE_OPEN' })
    expect(response.json().message).toContain('直接开台')
    expect((await repository.read()).reservationState?.reservations).toHaveLength(0)
    await app.close()
    await repository.close()
  })

  it('excludes legacy walk-in rows from the raw reservation API', async () => {
    const { app, repository } = await fixture(true, 'manager')
    const created = await app.inject({ method: 'POST', url: '/api/reservations', payload: reservationPayload })
    expect(created.statusCode, created.body).toBe(201)
    await repository.mutate((state) => {
      const reservation = state.reservationState!.reservations[0]!
      state.reservationState!.reservations.push({
        ...structuredClone(reservation),
        id: 'legacy-walk-in-row',
        sourceCode: 'walk_in',
      })
      state.revision += 1
    })

    const response = await app.inject({ method: 'GET', url: '/api/reservations' })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().reservations.map((item: { id: string }) => item.id)).toEqual([created.json().id])
    await app.close()
    await repository.close()
  })

  it('requires a request actor for every route', async () => {
    const { app, repository } = await fixture(false)
    const response = await app.inject({ method: 'GET', url: '/api/reservations' })
    expect(response.statusCode).toBe(401)
    await app.close()
    await repository.close()
  })

  it('returns defaults before the first reservation and lets only a manager version configuration idempotently', async () => {
    const { app, repository } = await fixture(true, 'manager')
    const initial = await app.inject({ method: 'GET', url: '/api/reservations' })
    expect(initial.statusCode).toBe(200)
    expect(initial.json().config).toMatchObject({ version: 1, minimumPartySize: 1 })

    const config = {
      minimumPartySize: 2,
      maximumPartySize: 80,
      sources: [{ code: 'wechat', name: '微信预约', enabled: true, sortOrder: 10 }],
      areaPreferences: [{ code: 'lounge', name: '大厅休闲区', enabled: true, sortOrder: 10 }],
      occasions: [{ code: 'birthday', name: '生日', enabled: true, serviceScript: ['准备生日权益'] }],
      businessHours: { timeZone: 'Asia/Shanghai', openingTime: '21:00', closingTime: '03:00', slotMinutes: 20, closedWeekdays: [1] },
      capacity: { defaultDailyCapacity: 90, defaultSlotCapacity: 12, dateOverrides: [{ date: '2030-08-01', enabled: false, totalCapacity: 0, slotCapacities: [] }] },
      publicRules: {
        minimumLeadMinutes: 30, maximumAdvanceDays: 90, duplicateWindowMinutes: 45,
        acceptedContactMethods: ['phone'], createRateLimit: { limit: 3, windowMinutes: 20 },
      },
    }
    const payload = { config, reason: '陆家嘴预约规则生效', idempotencyKey: 'reservation-config-update-0001' }
    const first = await app.inject({ method: 'PUT', url: '/api/reservations/config', payload })
    const replay = await app.inject({ method: 'PUT', url: '/api/reservations/config', payload })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({
      version: 2, minimumPartySize: 2,
      businessHours: { openingTime: '21:00', closingTime: '03:00' },
      capacity: { defaultDailyCapacity: 90, defaultSlotCapacity: 12 },
      publicRules: { minimumLeadMinutes: 30, acceptedContactMethods: ['phone'] },
    })
    expect(replay.json()).toEqual(first.json())

    const state = await repository.read()
    expect(state.auditEntries.filter((entry) => entry.action === 'reservation.config.updated.v1')).toHaveLength(1)
    await app.close()
    await repository.close()
  })

  it('rejects reservation configuration changes from a service reception account', async () => {
    const { app, repository } = await fixture()
    const response = await app.inject({
      method: 'PUT',
      url: '/api/reservations/config',
      payload: {
        config: {
          minimumPartySize: 1,
          maximumPartySize: 30,
          sources: [{ code: 'phone', name: '电话', enabled: true, sortOrder: 10 }],
          areaPreferences: [],
          occasions: [{ code: 'other', name: '其他', enabled: true, serviceScript: [] }],
        },
        reason: '无权限修改',
        idempotencyKey: 'reservation-config-denied-0001',
      },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('AUTHORIZATION_DENIED')
    await app.close()
    await repository.close()
  })

  it('creates idempotently and persists the birthday context', async () => {
    const { app, repository } = await fixture()
    const first = await app.inject({ method: 'POST', url: '/api/reservations', payload: reservationPayload })
    const replay = await app.inject({ method: 'POST', url: '/api/reservations', payload: reservationPayload })
    expect(first.statusCode).toBe(201)
    expect(replay.statusCode).toBe(201)
    expect(replay.json().id).toBe(first.json().id)
    expect(first.json()).toMatchObject({ status: 'requested', occasionCode: 'birthday', partySize: 6 })

    const list = await app.inject({ method: 'GET', url: '/api/reservations?status=requested' })
    expect(list.statusCode).toBe(200)
    expect(list.json().reservations).toHaveLength(1)
    await app.close()
    await repository.close()
  })

  it('records external payment facts, seats the guest and preserves the table session binding', async () => {
    const { app, repository } = await fixture(true, 'manager')
    const created = await app.inject({
      method: 'POST', url: '/api/reservations',
      payload: { ...reservationPayload, salesEmployeeId: 'emp-lin' },
    })
    const reservationId = created.json().id as string

    const changedSales = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/sales-attribution`,
      payload: { salesEmployeeId: 'emp-mia', reason: '客户到店前确认改由Mia负责', idempotencyKey: 'reservation-sales-change-0001' },
    })
    expect(changedSales.json()).toMatchObject({ previousSalesEmployeeId: 'emp-lin', salesEmployeeId: 'emp-mia' })

    const intent = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/deposit-intent`,
      payload: { paymentIntentReference: 'payment-intent-1', idempotencyKey: 'reservation-api-intent-0001' },
    })
    expect(intent.json().deposit.status).toBe('payment_intent_recorded')

    const paid = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/deposit-confirmation`,
      payload: {
        paymentIntentReference: 'payment-intent-1',
        paymentConfirmationReference: 'provider-payment-1',
        confirmedAmount: 50000,
        currency: 'CNY',
        idempotencyKey: 'reservation-api-payment-0001',
      },
    })
    expect(paid.json().deposit.status).toBe('payment_confirmed')

    for (const [action, key] of [['confirm', 'reservation-api-confirm-0001'], ['arrive', 'reservation-api-arrive-0001']] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/reservations/${reservationId}/actions`,
        payload: { action, idempotencyKey: key },
      })
      expect(response.statusCode).toBe(200)
    }
    const seated = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/actions`,
      payload: {
        action: 'seat',
        tableId: 'table-l04',
        idempotencyKey: 'reservation-api-seat-0001',
      },
    })
    expect(seated.statusCode, seated.body).toBe(200)
    expect(seated.json()).toMatchObject({ status: 'seated', tableCode: 'L04' })
    expect(seated.json().tableSessionId).toMatch(/^session:table-l04:/)
    const state = await repository.read()
    expect(state.salesAttributionRecords?.filter((record) => record.subjectType === 'reservation' && record.subjectId === reservationId)).toHaveLength(2)
    expect(state.salesAttributionRecords?.find((record) => record.subjectType === 'table_session' && record.subjectId === seated.json().tableSessionId)).toMatchObject({ salesEmployeeId: 'emp-mia' })
    expect(state.auditEntries.filter((entry) => entry.action === 'sales_attribution.changed.v1')).toHaveLength(1)
    await app.close()
    await repository.close()
  })

  it('allows a reservation party to take a smaller table with recorded extra seating', async () => {
    const { app, repository } = await fixture(true, 'manager')
    const created = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      payload: {
        ...reservationPayload,
        partySize: 8,
        depositRequiredAmount: 0,
        idempotencyKey: 'reservation-api-create-extra-seats',
      },
    })
    const reservationId = created.json().id as string
    for (const [action, key] of [
      ['confirm', 'reservation-extra-confirm'],
      ['arrive', 'reservation-extra-arrive'],
    ] as const) {
      expect((await app.inject({
        method: 'POST',
        url: `/api/reservations/${reservationId}/actions`,
        payload: { action, idempotencyKey: key },
      })).statusCode).toBe(200)
    }
    const seated = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/actions`,
      payload: { action: 'seat', tableId: 'table-l04', idempotencyKey: 'reservation-extra-seat' },
    })
    expect(seated.statusCode, seated.body).toBe(200)
    const state = await repository.read()
    expect(state.tables.find((table) => table.id === 'table-l04')).toMatchObject({ status: 'occupied', guestCount: 8 })
    expect(state.auditEntries.find((entry) => entry.action === 'table.opened_from_reservation.v1')?.details)
      .toMatchObject({ guestCount: 8, tableCapacity: 6, extraSeatCount: 2 })
    await app.close()
    await repository.close()
  })

  it('does not turn a cancellation into a simulated refund', async () => {
    const { app, repository } = await fixture()
    const created = await app.inject({
      method: 'POST',
      url: '/api/reservations',
      payload: { ...reservationPayload, depositRequiredAmount: 0, idempotencyKey: 'reservation-api-create-no-deposit' },
    })
    const reservationId = created.json().id as string
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/reservations/${reservationId}/actions`,
      payload: { action: 'cancel', reason: '顾客行程变化', idempotencyKey: 'reservation-api-cancel-0001' },
    })
    expect(cancelled.json().deposit).toMatchObject({ status: 'not_required', refundConfirmationReference: null, refundedAt: null })
    await app.close()
    await repository.close()
  })

  it('does not seat a reservation at a table actively held for a waitlist guest', async () => {
    const { app, repository } = await fixture(true, 'manager')
    const created = await app.inject({
      method: 'POST', url: '/api/reservations',
      payload: { ...reservationPayload, occasionCode: 'other', idempotencyKey: 'reservation-held-table-create' },
    })
    const reservationId = created.json().id as string
    await repository.mutate((state) => {
      const now = new Date().toISOString()
      state.reservationState!.reservations.find((reservation) => reservation.id === reservationId)!.status = 'arrived'
      const table = state.tables.find((item) => item.id === 'table-l04')!
      table.status = 'reserved'
      state.waitlistEntries.push({
        id: 'waitlist-held-table', customerReference: 'customer-held', customerName: '候补李女士', contactReference: 'contact-held',
        partySize: 2, areaPreferenceCode: null, originalReservationId: null, status: 'notified', joinedSequence: 1,
        joinedAt: now, maximumWaitUntil: new Date(Date.now() + 30 * 60_000).toISOString(), notifiedAt: now,
        responseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), heldTableId: table.id, heldTableCode: table.code,
        tableSessionId: null, seatedAt: null, closedAt: null, closeReason: null, createdBy: 'emp-chen', updatedAt: now,
        revision: 1, configVersion: state.reservationState!.config.version,
      })
      state.revision += 1
    })

    const response = await app.inject({
      method: 'POST', url: `/api/reservations/${reservationId}/actions`,
      payload: { action: 'seat', tableId: 'table-l04', idempotencyKey: 'reservation-held-table-seat' },
    })

    expect(response.statusCode).toBe(500)
    expect(response.json().message).toContain('已锁给候补客人候补李女士')
    expect((await repository.read()).tables.find((table) => table.id === 'table-l04')?.status).toBe('reserved')
    await app.close()
    await repository.close()
  })
})
