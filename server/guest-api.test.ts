import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RuntimeState, Table } from '../src/shared/contracts.js'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'
import type { GuestSessionResponse } from '../src/shared/guest-contracts.js'
import { registerGuestRoutes } from './guest-api.js'
import { JsonRepository } from './repository.js'
import {
  requireGuestSession,
  signGuestSessionToken,
  signStaticTableQrToken,
  TableAccessError,
  verifyTableAccessToken,
} from './table-access.js'
import { transferOpenTableSession } from './table-session-api.js'
import { createPaymentIntent } from './payment-domain.js'
import { applyTaskAction, createServiceTask } from './domain.js'
import { MemoryGuestInsightsStore } from './guest-insights.js'
import { tableSessionOperation } from './table-sessions.js'

const secret = 'q'.repeat(32)
const sessionTtlMs = 5 * 60_000

async function fixture(
  runtimeMode: RuntimeMode = 'test',
  allowPaymentSimulation = false,
  ttlMs: number | null = sessionTtlMs,
  previousSecret?: string,
) {
  let now = Date.now()
  const repository = new JsonRepository(`/tmp/mbox-guest-${crypto.randomUUID()}.json`)
  await repository.init()
  const app = Fastify()
  const guestInsights = new MemoryGuestInsightsStore()
  await guestInsights.init()
  registerGuestRoutes(app, repository, {
    secret,
    previousSecret,
    runtimeMode,
    allowPaymentSimulation,
    ...(ttlMs === null ? {} : { guestSessionTtlMs: ttlMs }),
    now: () => now,
    guestInsights,
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TableAccessError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message, details: error.details })
    }
    return reply.status(500).send({ message: error.message })
  })
  return { app, repository, guestInsights, now: () => now, setNow: (value: number) => { now = value } }
}

function staticQr(now: number, storeId = 'mbox-lujiazui', tableCode = 'L01', tokenVersion = 1, signingSecret = secret) {
  return signStaticTableQrToken({ storeId, tableCode, tokenVersion, issuedAt: now }, signingSecret)
}

function nextDate(date: string) {
  const value = new Date(`${date}T12:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

async function exchange(app: FastifyInstance, token: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/guest/session?token=${encodeURIComponent(token)}`,
  })
  return { response, body: response.json() as GuestSessionResponse }
}

async function closeFixture(app: FastifyInstance, repository: JsonRepository) {
  await app.close()
  await repository.close()
}

async function replaceOpenSession(repository: JsonRepository, tableCode: string, newSessionId: string, openedAt: string) {
  await repository.mutate((state) => {
    const table = state.tables.find((candidate) => candidate.code === tableCode)!
    for (const session of state.songState.tableSessions) {
      if (session.tableId === table.id && session.status === 'open') {
        session.status = 'closed'
        session.closedAt = openedAt
      }
    }
    state.songState.tableSessions.push({
      id: newSessionId,
      tableId: table.id,
      tableCode,
      status: 'open',
      openedAt,
      closedAt: null,
    })
    table.status = 'occupied'
    table.openedAt = openedAt
    state.revision += 1
  })
}

describe('guest table API', () => {
  it('issues a 60-minute rolling session by default', async () => {
    const { app, repository, now } = await fixture('test', false, null)
    const response = await app.inject({ method: 'GET', url: '/api/guest/session?table=L01' })
    const body = response.json() as GuestSessionResponse
    const claims = requireGuestSession(verifyTableAccessToken(body.tableToken, secret, now()))

    expect(response.statusCode).toBe(200)
    expect(claims.expiresAt - claims.issuedAt).toBe(60 * 60_000)
    await closeFixture(app, repository)
  })

  it('keeps the local table-code sample by issuing the same short-lived session token', async () => {
    const { app, repository, now } = await fixture()
    const response = await app.inject({ method: 'GET', url: '/api/guest/session?table=L01' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as GuestSessionResponse
    expect(body.table.code).toBe('L01')
    expect(body.communityBrand).toMatchObject({ name: '超嗨部落', markUrl: '/brand/superhigh-mark.png' })
    expect(body.serviceTypes.map((type) => type.code)).not.toContain('FULFILLMENT_DELIVERY')
    expect(body.serviceTypes.map((type) => type.code)).toContain('GUEST_MOOD_INFO')
    expect(body.products.find((product) => product.id === 'product-balance-adjustment')).toMatchObject({
      name: '补差额',
      specification: '1元/份',
      listPriceAmount: 100,
    })
    expect(body.stageSchedule.length).toBeGreaterThan(0)
    expect(body.stageSchedule[0]).toMatchObject({
      singerName: expect.any(String),
      startsAt: expect.any(String),
      endsAt: expect.any(String),
      profile: { styleTags: expect.any(Array) },
    })
    expect(requireGuestSession(verifyTableAccessToken(body.tableToken, secret, now())).tableSessionId)
      .toBe(body.account.tableSessionId)
    await closeFixture(app, repository)
  })

  it('exposes the visit-scoped scene so guest menu recommendations can use the opening context', async () => {
    const { app, repository } = await fixture()
    await repository.mutate((state) => {
      const session = state.songState.tableSessions.find((candidate) => (
        candidate.tableCode === 'L01' && candidate.status === 'open'
      ))!
      tableSessionOperation(state, session).recommendationScene = 'date'
      state.revision += 1
    })

    const response = await app.inject({ method: 'GET', url: '/api/guest/session?table=L01' })
    const body = response.json() as GuestSessionResponse

    expect(response.statusCode).toBe(200)
    expect(body.table).toMatchObject({ code: 'L01', recommendationScene: 'date' })
    await closeFixture(app, repository)
  })

  it('includes hidden bundle components for comparison without exposing unrelated hidden products', async () => {
    const { app, repository } = await fixture()
    await repository.mutate((state) => {
      state.products.find((product) => product.id === 'product-cocktail')!.guestVisible = false
      state.products.find((product) => product.id === 'product-balance-adjustment')!.guestVisible = false
      state.revision += 1
    })

    const response = await app.inject({ method: 'GET', url: '/api/guest/session?table=L01' })
    const body = response.json() as GuestSessionResponse

    expect(response.statusCode).toBe(200)
    expect(body.products.find((product) => product.id === 'product-cocktail')).toMatchObject({
      guestVisible: false,
      costAmount: 0,
    })
    expect(body.products.some((product) => product.id === 'product-balance-adjustment')).toBe(false)
    await closeFixture(app, repository)
  })

  it('uses the current Beijing business date for the guest lineup even when the admin day is stale', async () => {
    const { app, repository } = await fixture()
    const initial = (await app.inject({ method: 'GET', url: '/api/guest/session?table=L01' })).json() as GuestSessionResponse
    const todayBusinessDate = initial.store.businessDate
    await repository.mutate((state) => {
      state.store.businessDate = nextDate(todayBusinessDate)
      state.songState.businessDate = state.store.businessDate
      state.revision += 1
    })

    const response = await app.inject({ method: 'GET', url: '/api/guest/session?table=L01' })
    const body = response.json() as GuestSessionResponse

    expect(response.statusCode).toBe(200)
    expect(body.store.businessDate).toBe(todayBusinessDate)
    expect(body.stageSchedule.map((appearance) => appearance.appearanceId)).toEqual(initial.stageSchedule.map((appearance) => appearance.appearanceId))
    await closeFixture(app, repository)
  })

  it('only exposes singers and song offers from the current business-date schedule', async () => {
    const { app, repository } = await fixture()
    await repository.mutate((state) => {
      state.songState.singers.push({
        id: 'singer-future-only',
        displayName: '未来场歌手',
        actorId: 'singer-future-only',
        active: true,
        photoUrl: '/singers/future.png',
        headline: '未来场次',
        bio: '这位歌手只安排在未来日期，不应出现在今天的客户点歌页面。',
        styleTags: ['未来场次'],
      })
      state.songState.songs.push({ id: 'song-future-only', title: '未来的歌', artist: '演示', durationSeconds: 240, active: true })
      state.songState.repertoire.push({
        id: 'repertoire-future-only',
        singerId: 'singer-future-only',
        songId: 'song-future-only',
        priceAmount: 8800,
        currency: 'CNY',
        configVersion: 1,
        enabled: true,
      })
      state.songState.performanceSessions.push({
        id: 'performance-future-only',
        businessDate: '2099-01-01',
        title: '未来演出',
        status: 'scheduled',
        startsAt: '2099-01-01T12:00:00.000Z',
        endsAt: '2099-01-01T14:00:00.000Z',
        appearances: [{
          id: 'appearance-future-only',
          singerId: 'singer-future-only',
          startsAt: '2099-01-01T12:30:00.000Z',
          endsAt: '2099-01-01T13:30:00.000Z',
          requestOpensAt: '2099-01-01T12:00:00.000Z',
          requestClosesAt: '2099-01-01T13:45:00.000Z',
          acceptingRequests: true,
        }],
      })
      state.revision += 1
    })

    const body = (await app.inject({ method: 'GET', url: '/api/guest/session?table=L01' })).json() as GuestSessionResponse

    expect(body.stageSchedule.map((item) => item.singerId)).not.toContain('singer-future-only')
    expect(body.songOffers.map((item) => item.singerId)).not.toContain('singer-future-only')
    expect(body.songOffers.every((offer) => body.stageSchedule.some((appearance) => appearance.appearanceId === offer.appearanceId))).toBe(true)
    await closeFixture(app, repository)
  })

  it('keeps the singer repertoire visible while accurately marking the reservation window', async () => {
    const { app, repository, setNow } = await fixture()
    let appearanceId = ''
    let requestOpensAt = ''
    await repository.mutate((state) => {
      const performance = state.songState.performanceSessions.find((item) => item.businessDate === state.store.businessDate)!
      const appearance = performance.appearances[0]!
      performance.startsAt = new Date(`${state.store.businessDate}T12:00:00+08:00`).toISOString()
      performance.endsAt = new Date(`${state.store.businessDate}T21:15:00+08:00`).toISOString()
      performance.status = 'scheduled'
      appearance.startsAt = new Date(`${state.store.businessDate}T20:30:00+08:00`).toISOString()
      appearance.endsAt = new Date(`${state.store.businessDate}T21:15:00+08:00`).toISOString()
      appearance.requestOpensAt = new Date(`${state.store.businessDate}T12:00:00+08:00`).toISOString()
      appearance.requestClosesAt = appearance.endsAt
      appearance.advanceBookingEnabled = true
      appearanceId = appearance.id
      requestOpensAt = appearance.requestOpensAt
      state.revision += 1
    })
    const beforeOpenTime = Date.parse(requestOpensAt) - 60_000
    setNow(beforeOpenTime)

    const beforeOpen = (await app.inject({ method: 'GET', url: '/api/guest/session?table=L01' })).json() as GuestSessionResponse
    expect(beforeOpen.stageSchedule.map((item) => item.appearanceId)).toContain(appearanceId)
    expect(beforeOpen.songOffers.find((item) => item.appearanceId === appearanceId)).toMatchObject({ requestAvailable: false, requestMode: null })
    expect(beforeOpen.serverNow).toBe(new Date(beforeOpenTime).toISOString())

    setNow(Date.parse(requestOpensAt))
    const opened = (await app.inject({ method: 'GET', url: '/api/guest/session?table=L01' })).json() as GuestSessionResponse
    expect(opened.songOffers.find((item) => item.appearanceId === appearanceId)).toMatchObject({ requestAvailable: true })
    await closeFixture(app, repository)
  })

  it('submits an advance reservation for the next singer before arrival', async () => {
    const { app, repository, now } = await fixture()
    await repository.mutate((state) => {
      const performance = state.songState.performanceSessions.find((item) => item.businessDate === state.store.businessDate)!
      const appearance = performance.appearances[0]!
      performance.startsAt = new Date(now() - 60_000).toISOString()
      performance.endsAt = new Date(now() + 2 * 60 * 60_000).toISOString()
      performance.configVersion = 7
      appearance.startsAt = new Date(now() + 30 * 60_000).toISOString()
      appearance.endsAt = new Date(now() + 75 * 60_000).toISOString()
      appearance.requestOpensAt = new Date(now() - 60_000).toISOString()
      appearance.requestClosesAt = new Date(now() + 70 * 60_000).toISOString()
      appearance.advanceBookingEnabled = true
      state.revision += 1
    })
    const session = (await exchange(app, staticQr(now()))).body
    const offer = session.songOffers.find((item) => item.requestMode === 'advance_reservation')!
    expect(offer).toMatchObject({ requestAvailable: true, scheduleVersion: 7 })
    const submitted = await app.inject({ method: 'POST', url: '/api/guest/song-requests', payload: {
      tableToken: session.tableToken, appearanceId: offer.appearanceId, singerId: offer.singerId, songId: offer.songId,
      customerNote: '', idempotencyKey: 'advance-guest-song-0001',
    } })
    expect(submitted.statusCode, submitted.body).toBe(201)
    expect(submitted.json()).toMatchObject({ requestMode: 'advance_reservation', scheduleVersion: 7, status: 'pending_confirmation' })
    await closeFixture(app, repository)
  })

  it('submits an extension negotiation when the current slot cannot fit the song', async () => {
    const { app, repository, now } = await fixture()
    await repository.mutate((state) => {
      const performance = state.songState.performanceSessions.find((item) => item.businessDate === state.store.businessDate)!
      const appearance = performance.appearances[0]!
      performance.startsAt = new Date(now() - 60 * 60_000).toISOString()
      performance.endsAt = new Date(now() + 60 * 60_000).toISOString()
      appearance.startsAt = new Date(now() - 30 * 60_000).toISOString()
      appearance.endsAt = new Date(now() + 2 * 60_000).toISOString()
      appearance.requestOpensAt = new Date(now() - 60 * 60_000).toISOString()
      appearance.requestClosesAt = new Date(now() - 60_000).toISOString()
      appearance.extensionNegotiationEnabled = true
      state.revision += 1
    })
    const session = (await exchange(app, staticQr(now()))).body
    const offer = session.songOffers.find((item) => item.requestMode === 'extension_negotiation')!
    expect(offer).toMatchObject({ requestAvailable: true })
    const submitted = await app.inject({ method: 'POST', url: '/api/guest/song-requests', payload: {
      tableToken: session.tableToken, appearanceId: offer.appearanceId, singerId: offer.singerId, songId: offer.songId,
      customerNote: '', idempotencyKey: 'extension-guest-song-0001',
    } })
    expect(submitted.statusCode, submitted.body).toBe(201)
    expect(submitted.json()).toMatchObject({ requestMode: 'extension_negotiation', status: 'pending_confirmation' })
    await closeFixture(app, repository)
  })

  it('exchanges a static QR for a short-lived token bound to the current open table visit', async () => {
    const { app, repository, now } = await fixture()
    const qrToken = staticQr(now())
    const { response, body } = await exchange(app, qrToken)

    expect(response.statusCode).toBe(200)
    expect(body).not.toHaveProperty('employees')
    expect(body.table.code).toBe('L01')
    expect(body.tableToken).not.toBe(qrToken)
    const sessionClaims = requireGuestSession(verifyTableAccessToken(body.tableToken, secret, now()))
    expect(sessionClaims).toMatchObject({
      tableCode: 'L01',
      tableSessionId: body.account.tableSessionId,
      tokenVersion: 1,
      expiresAt: now() + sessionTtlMs,
    })
    expect(body.guestSession).toEqual({
      tableSessionId: body.account.tableSessionId,
      tokenVersion: 1,
      expiresAt: new Date(now() + sessionTtlMs).toISOString(),
    })

    const taskBody = {
      tableToken: body.tableToken,
      serviceTypeId: 'water',
      note: '',
      idempotencyKey: 'guest-request-0001',
    }
    const first = await app.inject({ method: 'POST', url: '/api/guest/tasks', payload: taskBody })
    const replay = await app.inject({ method: 'POST', url: '/api/guest/tasks', payload: taskBody })
    expect(first.statusCode).toBe(201)
    expect(first.json().serviceTypeName).toBe('加水')
    expect(replay.json().id).toBe(first.json().id)
    await repository.mutate((state) => {
      const task = state.tasks.find((candidate) => candidate.id === first.json().id)!
      for (const [action, note] of [
        ['accept', ''],
        ['arrive', ''],
        ['complete', '已补水'],
      ] as const) {
        applyTaskAction(state, task.id, {
          action,
          actorId: task.ownerId!,
          note,
          idempotencyKey: `guest-service-close-${action}`,
        })
      }
    })
    const refreshed = await app.inject({
      method: 'GET',
      url: `/api/guest/session?token=${encodeURIComponent(body.tableToken)}`,
    })
    expect((await repository.read()).tasks.find((candidate) => candidate.id === first.json().id)?.status).toBe('confirmed')
    expect(refreshed.json().tasks).not.toContainEqual(expect.objectContaining({ id: first.json().id }))
    await closeFixture(app, repository)
  })

  it('accepts a previous static QR key only for migration and rotates the guest session to the current key', async () => {
    const previousSecret = 'p'.repeat(32)
    const { app, repository, now } = await fixture('test', false, sessionTtlMs, previousSecret)
    const { response, body } = await exchange(app, staticQr(now(), 'mbox-lujiazui', 'L01', 1, previousSecret))

    expect(response.statusCode).toBe(200)
    expect(requireGuestSession(verifyTableAccessToken(body.tableToken, secret, now()))).toMatchObject({
      tableCode: 'L01',
      tableSessionId: body.account.tableSessionId,
    })
    expect(() => verifyTableAccessToken(body.tableToken, previousSecret, now())).toThrow()

    const previousGuestSession = signGuestSessionToken({
      storeId: 'mbox-lujiazui',
      tableCode: 'L01',
      tableSessionId: body.account.tableSessionId,
      tokenVersion: 1,
      issuedAt: now(),
      expiresAt: now() + sessionTtlMs,
    }, previousSecret)
    const rejected = await app.inject({
      method: 'GET',
      url: `/api/guest/session?token=${encodeURIComponent(previousGuestSession)}`,
    })
    expect(rejected.statusCode).toBe(401)
    expect(rejected.json()).toMatchObject({ code: 'TABLE_QR_REQUIRED' })

    await closeFixture(app, repository)
  })

  it('keeps one anonymous guest identity across the visit and records meaningful behavior idempotently', async () => {
    const { app, repository, guestInsights, now } = await fixture()
    const first = await exchange(app, staticQr(now()))
    const anonymousId = first.body.guestIdentity.anonymousId
    expect(anonymousId).toMatch(/^[0-9a-f-]{36}$/)

    const refreshed = await app.inject({
      method: 'GET',
      url: `/api/guest/session?token=${encodeURIComponent(first.body.tableToken)}`,
      headers: { 'x-mbox-guest-id': anonymousId },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json().guestIdentity.anonymousId).toBe(anonymousId)

    const mood = await app.inject({
      method: 'POST',
      url: '/api/guest/events',
      headers: { 'x-mbox-guest-id': anonymousId },
      payload: {
        tableToken: first.body.tableToken,
        eventType: 'mood_selected',
        metadata: { moodId: 'happy' },
        idempotencyKey: 'mood-event-0001',
      },
    })
    expect(mood.statusCode).toBe(202)

    const recommendation = await app.inject({
      method: 'POST',
      url: '/api/guest/events',
      headers: { 'x-mbox-guest-id': anonymousId },
      payload: {
        tableToken: first.body.tableToken,
        eventType: 'recommendation_viewed',
        metadata: {
          productId: 'product-pair-cocktail-night',
          partySize: 2,
          intent: 'relaxed',
          taste: 'refreshing',
          dwell: 'one_set',
          paymentStatus: 'forged',
        },
        idempotencyKey: 'recommendation-event-0001',
      },
    })
    expect(recommendation.statusCode).toBe(202)
    expect(guestInsights.events.find((event) => event.eventType === 'recommendation_viewed')?.metadata).toEqual({
      productId: 'product-pair-cocktail-night',
      partySize: 2,
      intent: 'relaxed',
      taste: 'refreshing',
      dwell: 'one_set',
    })

    const updatedRecommendation = await app.inject({
      method: 'POST',
      url: '/api/guest/events',
      headers: { 'x-mbox-guest-id': anonymousId },
      payload: {
        tableToken: first.body.tableToken,
        eventType: 'recommendation_result_updated',
        metadata: {
          source: 'rules',
          primaryProductId: 'product-pair-cocktail-night',
          comparisonProductIds: 'product-pair-beer-night,product-pair-cocktail-night,product-pair-complete-night',
          changed: true,
          forgedPrice: 1,
        },
        idempotencyKey: 'recommendation-updated-event-0001',
      },
    })
    expect(updatedRecommendation.statusCode).toBe(202)
    expect(guestInsights.events.find((event) => event.eventType === 'recommendation_result_updated')?.metadata).toEqual({
      source: 'rules',
      primaryProductId: 'product-pair-cocktail-night',
      comparisonProductIds: 'product-pair-beer-night,product-pair-cocktail-night,product-pair-complete-night',
      changed: true,
    })

    const abandonedCart = await app.inject({
      method: 'POST',
      url: '/api/guest/events',
      headers: { 'x-mbox-guest-id': anonymousId },
      payload: {
        tableToken: first.body.tableToken,
        eventType: 'cart_abandoned',
        metadata: {
          itemCount: 2,
          distinctProductCount: 1,
          totalAmount: 24_800,
          lastView: 'recommend',
        },
        idempotencyKey: 'cart-abandoned-event-0001',
      },
    })
    expect(abandonedCart.statusCode).toBe(202)

    const forgedPayment = await app.inject({
      method: 'POST',
      url: '/api/guest/events',
      headers: { 'x-mbox-guest-id': anonymousId },
      payload: {
        tableToken: first.body.tableToken,
        eventType: 'payment_completed',
        metadata: { amount: 1 },
        idempotencyKey: 'forged-payment-0001',
      },
    })
    expect(forgedPayment.statusCode).toBe(400)
    expect(forgedPayment.json().code).toBe('GUEST_EVENT_SERVER_OWNED')

    const service = await app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      headers: { 'x-mbox-guest-id': anonymousId },
      payload: {
        tableToken: first.body.tableToken,
        serviceTypeId: first.body.serviceTypes[0]!.id,
        note: '',
        idempotencyKey: 'anonymous-service-0001',
      },
    })
    expect(service.statusCode).toBe(201)
    expect(guestInsights.profiles.get(anonymousId)).toMatchObject({ visitCount: 1 })
    expect(guestInsights.events.filter((event) => event.anonymousId === anonymousId).map((event) => event.eventType))
      .toEqual(expect.arrayContaining(['session_started', 'mood_selected', 'service_requested']))
    expect(guestInsights.events.filter((event) => event.eventType === 'session_started')).toHaveLength(1)
    await closeFixture(app, repository)
  })
  it('freezes a previous-business-day table visit without exposing or accepting payment for its orders', async () => {
    const { app, repository, now } = await fixture()
    const current = (await exchange(app, staticQr(now()))).body
    const order = await app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      payload: {
        tableToken: current.tableToken,
        items: [{ productId: 'product-beer', quantity: 1 }],
        idempotencyKey: 'stale-session-order-0001',
      },
    })
    expect(order.statusCode, order.body).toBe(201)

    await repository.mutate((state) => {
      state.store.businessDate = nextDate(state.store.businessDate)
      state.songState.businessDate = state.store.businessDate
      state.revision += 1
    })

    const frozenResponse = await app.inject({
      method: 'GET',
      url: `/api/guest/session?token=${encodeURIComponent(current.tableToken)}`,
    })
    expect(frozenResponse.statusCode, frozenResponse.body).toBe(200)
    expect(frozenResponse.json().account).toMatchObject({
      frozen: true,
      requiresManagerHandover: true,
      balanceAmount: 0,
      orders: [],
      payments: [],
    })
    expect(frozenResponse.json().tasks).toEqual([])

    const newGuestScan = await exchange(app, staticQr(now()))
    expect(newGuestScan.response.statusCode, newGuestScan.response.body).toBe(200)
    expect(newGuestScan.body.account).toMatchObject({ frozen: true, orders: [], payments: [] })
    const blockedNewOrder = await app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      payload: {
        tableToken: newGuestScan.body.tableToken,
        items: [{ productId: 'product-beer', quantity: 1 }],
        idempotencyKey: 'stale-session-new-guest-order-0001',
      },
    })
    expect(blockedNewOrder.statusCode).toBe(409)
    expect(blockedNewOrder.json().code).toBe('TABLE_SESSION_HANDOVER_REQUIRED')

    const checkout = await app.inject({
      method: 'POST',
      url: '/api/guest/checkout',
      payload: {
        tableToken: current.tableToken,
        orderId: order.json().id,
        idempotencyKey: 'stale-session-checkout-0001',
      },
    })
    expect(checkout.statusCode).toBe(409)
    expect(checkout.json().code).toBe('TABLE_SESSION_HANDOVER_REQUIRED')
    expect((await repository.read()).paymentDomain.paymentIntents).toHaveLength(0)

    const rolledState = await repository.read()
    const reopenedAt = `${rolledState.store.businessDate}T20:30:00+08:00`
    await replaceOpenSession(
      repository,
      'L01',
      `session:table-l01:${rolledState.store.businessDate}:new-guest`,
      reopenedAt,
    )
    const nextGuest = await exchange(app, staticQr(now()))
    expect(nextGuest.response.statusCode, nextGuest.response.body).toBe(200)
    expect(nextGuest.body.account).toMatchObject({
      sessionBusinessDate: rolledState.store.businessDate,
      frozen: false,
      orders: [],
      payments: [],
    })
    expect((await repository.read()).orderDomain.orders.some((candidate) => candidate.id === order.json().id)).toBe(true)
    await closeFixture(app, repository)
  })

  it('keeps an after-midnight visit in the current nightclub business date', async () => {
    const { app, repository, now } = await fixture()
    const state = await repository.read()
    const openedAt = `${nextDate(state.store.businessDate)}T01:30:00+08:00`
    await replaceOpenSession(repository, 'L01', 'legacy-after-midnight-session', openedAt)

    const response = await exchange(app, staticQr(now()))

    expect(response.response.statusCode, response.response.body).toBe(200)
    expect(response.body.account).toMatchObject({
      sessionBusinessDate: state.store.businessDate,
      frozen: false,
      requiresManagerHandover: false,
    })
    await closeFixture(app, repository)
  })

  it('freezes an overlong table visit in production even when the business date was never advanced', async () => {
    const { app, repository, now } = await fixture('production')
    const openedAt = new Date(now() - 13 * 60 * 60_000).toISOString()
    await replaceOpenSession(repository, 'L01', 'session:table-l01:current-overlong', openedAt)

    const exchanged = await exchange(app, staticQr(now()))
    expect(exchanged.response.statusCode, exchanged.response.body).toBe(200)
    expect(exchanged.body.account).toMatchObject({
      frozen: true,
      requiresManagerHandover: true,
      orders: [],
      payments: [],
    })

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      payload: {
        tableToken: exchanged.body.tableToken,
        serviceTypeId: 'water',
        note: '',
        idempotencyKey: 'overlong-session-task-0001',
      },
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().code).toBe('TABLE_SESSION_HANDOVER_REQUIRED')
    await closeFixture(app, repository)
  })

  it('keeps an unowned guest request visible and reflects the employee who later claims it', async () => {
    const { app, repository, now } = await fixture()
    await repository.mutate((state) => {
      for (const employee of state.employees) employee.online = false
      state.revision += 1
    })
    const session = (await exchange(app, staticQr(now()))).body
    const created = await app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      payload: {
        tableToken: session.tableToken,
        serviceTypeId: 'water',
        note: '',
        idempotencyKey: 'guest-unowned-claim-0001',
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ status: 'pending', ownerName: null })

    await repository.mutate((state) => {
      state.employees.find((employee) => employee.id === 'emp-lin')!.online = true
      applyTaskAction(state, created.json().id, {
        action: 'accept', actorId: 'emp-lin', note: '', idempotencyKey: 'guest-unowned-claimed-0001',
      })
    })
    const refreshed = (await exchange(app, staticQr(now()))).body
    expect(refreshed.tasks.find((task) => task.id === created.json().id)).toMatchObject({
      status: 'accepted',
      ownerName: 'Tom',
      customerReply: expect.stringContaining('Tom'),
    })
    await closeFixture(app, repository)
  })

  it('does not exchange a static QR unless the table has a current open visit', async () => {
    const { app, repository, now } = await fixture()
    const response = (await exchange(app, staticQr(now(), 'mbox-lujiazui', 'L04'))).response
    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('TABLE_SESSION_NOT_OPEN')
    await closeFixture(app, repository)
  })

  it('records guest mood as L0 table context without creating an employee to-do', async () => {
    const { app, repository, now } = await fixture()
    const session = (await exchange(app, staticQr(now()))).body
    const moodType = session.serviceTypes.find((serviceType) => serviceType.code === 'GUEST_MOOD_INFO')
    expect(moodType).toBeDefined()

    const response = await app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      payload: {
        tableToken: session.tableToken,
        serviceTypeId: moodType!.id,
        note: '今晚状态：开心',
        idempotencyKey: 'guest-mood-l0-0001',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ status: 'confirmed' })
    const storedTask = (await repository.read()).tasks.find((task) => task.id === response.json().id)
    expect(storedTask).toMatchObject({
      workflowLevel: 'L0',
      status: 'confirmed',
      resolution: '客情信息已记录',
    })
    expect(storedTask?.ownerEmployeeId).toBeFalsy()
    await closeFixture(app, repository)
  })

  it('submits standalone custom requests, merges duplicates and limits each table to five requests per minute', async () => {
    const { app, repository, now, setNow } = await fixture()
    const session = (await exchange(app, staticQr(now()))).body
    const customType = session.serviceTypes.find((serviceType) => serviceType.code === 'CUSTOM_REQUEST')
    expect(customType).toMatchObject({ id: 'custom-request', name: '个性化需求' })

    const empty = await app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      payload: {
        tableToken: session.tableToken,
        serviceTypeId: customType!.id,
        note: '',
        idempotencyKey: 'custom-empty-0001',
      },
    })
    expect(empty.statusCode).toBe(400)
    expect(empty.json().code).toBe('GUEST_CUSTOM_REQUEST_REQUIRED')

    const submit = (note: string, suffix: string) => app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      payload: {
        tableToken: session.tableToken,
        serviceTypeId: customType!.id,
        note,
        idempotencyKey: `custom-request-${suffix}`,
      },
    })
    const first = await submit('需要两杯温水', '0001')
    const duplicate = await submit('需要两杯温水', '0002')
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({ serviceTypeName: '个性化需求' })
    expect(duplicate.statusCode).toBe(201)
    expect(duplicate.json().id).toBe(first.json().id)

    for (const [index, note] of ['需要婴儿椅', '需要纸巾', '空调温度调高'].entries()) {
      expect((await submit(note, `000${index + 3}`)).statusCode).toBe(201)
    }
    const limited = await submit('稍后安排生日歌', '0006')
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({
      code: 'GUEST_SERVICE_RATE_LIMITED',
      message: '收到啦～你的召唤已经闪到我们这边，小伙伴正在赶来，再给我们一点点时间哦。',
    })
    expect(limited.json().message).not.toMatch(/60|5次|最多/)
    const mergedTask = (await repository.read()).tasks.find((task) => task.serviceTypeId === customType!.id)!
    expect(mergedTask).toMatchObject({
      id: first.json().id,
      requestCount: 5,
      note: '空调温度调高',
    })
    expect((await repository.read()).taskEvents.filter((event) => (
      event.taskId === mergedTask.id && event.type === 'task.request_merged.v1'
    ))).toHaveLength(4)

    setNow(now() + 61_000)
    expect((await submit('一分钟后再拿一个杯子', '0007')).statusCode).toBe(201)
    expect((await repository.read()).tasks.find((task) => task.id === mergedTask.id)).toMatchObject({
      requestCount: 6,
      note: '一分钟后再拿一个杯子',
    })
    await closeFixture(app, repository)
  })

  it('never drops complaint requests behind the ordinary guest rate limit', async () => {
    const { app, repository, now } = await fixture()
    const session = (await exchange(app, staticQr(now()))).body
    const submit = (serviceTypeId: string, suffix: string) => app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      payload: {
        tableToken: session.tableToken,
        serviceTypeId,
        note: `请求-${suffix}`,
        idempotencyKey: `protected-request-${suffix}`,
      },
    })
    for (const [index, serviceTypeId] of ['water', 'ice', 'order-help', 'birthday', 'custom-request'].entries()) {
      expect((await submit(serviceTypeId, `ordinary-000${index + 1}`)).statusCode).toBe(201)
    }

    const complaint = await submit('complaint', 'complaint-0001')
    const repeated = await submit('complaint', 'complaint-0002')
    expect(complaint.statusCode).toBe(201)
    expect(repeated.statusCode).toBe(201)
    expect(repeated.json().id).toBe(complaint.json().id)
    expect((await repository.read()).tasks.find((task) => task.id === complaint.json().id)).toMatchObject({
      requestCount: 2,
      note: '请求-complaint-0002',
    })
    await closeFixture(app, repository)
  })

  it('merges a guest request into an existing open system task of the same table and type', async () => {
    const { app, repository, now } = await fixture()
    const session = (await exchange(app, staticQr(now()))).body
    const systemTaskId = await repository.mutate((state) => createServiceTask(state, {
      tableCode: 'L01',
      serviceTypeId: 'water',
      source: 'system',
      note: '巡桌补水提醒',
      idempotencyKey: 'system-water-reminder-0001',
    }).id)

    const response = await app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      payload: {
        tableToken: session.tableToken,
        serviceTypeId: 'water',
        note: '需要两杯温水',
        idempotencyKey: 'guest-water-merge-system-0001',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().id).toBe(systemTaskId)
    expect((await repository.read()).tasks.find((task) => task.id === systemTaskId)).toMatchObject({
      source: 'system',
      requestCount: 2,
      note: '需要两杯温水',
    })
    await closeFixture(app, repository)
  })

  it('rejects the long-lived static QR on every guest write endpoint', async () => {
    const { app, repository, now } = await fixture()
    const qrToken = staticQr(now())
    const writes = [
      app.inject({
        method: 'POST',
        url: '/api/guest/tasks',
        payload: { tableToken: qrToken, serviceTypeId: 'water', note: '', idempotencyKey: 'static-task-0001' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/guest/tasks/any-task/feedback',
        payload: { tableToken: qrToken, action: 'confirm', note: '', idempotencyKey: 'static-feedback-0001' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/guest/song-requests',
        payload: {
          tableToken: qrToken,
          appearanceId: 'appearance-tianti',
          singerId: 'singer-tianti',
          songId: 'song-demo-1',
          customerNote: '',
          idempotencyKey: 'static-song-0001',
        },
      }),
    ]
    for (const response of await Promise.all(writes)) {
      expect(response.statusCode).toBe(401)
      expect(response.json().code).toBe('GUEST_SESSION_REQUIRED')
    }
    await closeFixture(app, repository)
  })

  it('rejects expired short-lived tokens on every guest write endpoint', async () => {
    const { app, repository, now, setNow } = await fixture()
    const { body } = await exchange(app, staticQr(now()))
    setNow(now() + sessionTtlMs + 1)
    const writes = [
      app.inject({
        method: 'POST',
        url: '/api/guest/tasks',
        payload: { tableToken: body.tableToken, serviceTypeId: 'water', note: '', idempotencyKey: 'expired-task-0001' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/guest/tasks/any-task/feedback',
        payload: { tableToken: body.tableToken, action: 'confirm', note: '', idempotencyKey: 'expired-feedback-0001' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/guest/song-requests',
        payload: {
          tableToken: body.tableToken,
          appearanceId: 'appearance-tianti',
          singerId: 'singer-tianti',
          songId: 'song-demo-1',
          customerNote: '',
          idempotencyKey: 'expired-song-0001',
        },
      }),
    ]
    for (const response of await Promise.all(writes)) {
      expect(response.statusCode).toBe(401)
      expect(response.json().code).toBe('GUEST_SESSION_EXPIRED')
    }
    await closeFixture(app, repository)
  })

  it('revokes a short token when the table closes and reopens with a new visit id', async () => {
    const { app, repository, now, setNow } = await fixture()
    const qrToken = staticQr(now())
    const firstSession = (await exchange(app, qrToken)).body
    await repository.mutate((state) => {
      createServiceTask(state, {
        tableCode: 'L01', serviceTypeId: 'water', source: 'guest', note: '上一桌的加水需求',
        idempotencyKey: 'previous-visit-water-task-0001',
      })
    })
    setNow(now() + 1_000)
    await replaceOpenSession(repository, 'L01', 'session:table-l01:reopened', new Date(now()).toISOString())

    const staleWrite = await app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      payload: {
        tableToken: firstSession.tableToken,
        serviceTypeId: 'water',
        note: '',
        idempotencyKey: 'stale-visit-task-0001',
      },
    })
    expect(staleWrite.statusCode).toBe(410)
    expect(staleWrite.json().code).toBe('GUEST_SESSION_REVOKED')

    const nextSession = (await exchange(app, qrToken)).body
    expect(nextSession.guestSession.tableSessionId).toBe('session:table-l01:reopened')
    expect(nextSession.tableToken).not.toBe(firstSession.tableToken)
    expect(nextSession.tasks).toEqual([])
    await closeFixture(app, repository)
  })

  it('revokes the old table token after transfer while the target QR keeps the same visit', async () => {
    const { app, repository, now } = await fixture()
    const original = (await exchange(app, staticQr(now()))).body
    await repository.mutate((state) => transferOpenTableSession(state, 'table-l01', {
      targetTableId: 'table-l04',
      kind: 'relocate',
      reason: '顾客现场申请更换位置',
      idempotencyKey: 'guest-transfer-l01-l04-001',
    }, 'emp-chen', new Date(now()).toISOString()))

    const stale = await app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      payload: {
        tableToken: original.tableToken,
        serviceTypeId: 'water',
        note: '',
        idempotencyKey: 'guest-task-after-transfer-old-table-001',
      },
    })
    expect(stale.statusCode).toBe(410)
    expect(stale.json().code).toBe('GUEST_SESSION_REVOKED')

    const target = (await exchange(app, staticQr(now(), 'mbox-lujiazui', 'L04'))).body
    expect(target.table.code).toBe('L04')
    expect(target.guestSession.tableSessionId).toBe(original.guestSession.tableSessionId)
    await closeFixture(app, repository)
  })

  it('revokes both QR redemption and existing sessions when tokenVersion changes', async () => {
    const { app, repository, now } = await fixture()
    const qrToken = staticQr(now())
    const session = (await exchange(app, qrToken)).body
    await repository.mutate((state: RuntimeState) => {
      const table = state.tables.find((candidate) => candidate.code === 'L01') as Table & { qrTokenVersion?: number }
      table.qrTokenVersion = 2
      state.revision += 1
    })

    const qrResponse = (await exchange(app, qrToken)).response
    const writeResponse = await app.inject({
      method: 'POST',
      url: '/api/guest/tasks',
      payload: {
        tableToken: session.tableToken,
        serviceTypeId: 'water',
        note: '',
        idempotencyKey: 'revoked-version-task-0001',
      },
    })
    expect(qrResponse.statusCode).toBe(410)
    expect(qrResponse.json().code).toBe('TABLE_TOKEN_REVOKED')
    expect(writeResponse.statusCode).toBe(410)
    expect(writeResponse.json().code).toBe('TABLE_TOKEN_REVOKED')
    await closeFixture(app, repository)
  })

  it('rejects a static QR for another store', async () => {
    const { app, repository, now } = await fixture()
    const response = (await exchange(app, staticQr(now(), 'other-store'))).response
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('TABLE_STORE_MISMATCH')
    await closeFixture(app, repository)
  })

  it('replays a guest song request with the same stable request id', async () => {
    const { app, repository, now } = await fixture()
    const session = (await exchange(app, staticQr(now()))).body
    const offer = session.songOffers[0]
    expect(offer).toBeTruthy()
    const payload = {
      tableToken: session.tableToken,
      appearanceId: offer!.appearanceId,
      singerId: offer!.singerId,
      songId: offer!.songId,
      customerNote: '生日祝福',
      idempotencyKey: 'guest-song-retry-0001',
    }
    const first = await app.inject({ method: 'POST', url: '/api/guest/song-requests', payload })
    const replay = await app.inject({ method: 'POST', url: '/api/guest/song-requests', payload })
    expect(first.statusCode).toBe(201)
    expect(replay.statusCode).toBe(201)
    expect(replay.json().id).toBe(first.json().id)
    expect((await repository.read()).songState.requests).toHaveLength(1)
    await closeFixture(app, repository)
  })

  it('keeps guest orders in draft until payment succeeds, then publishes KDS and paid signals', async () => {
    const { app, repository, now } = await fixture()
    const session = (await exchange(app, staticQr(now()))).body
    expect(session.products.map((product) => product.imageUrl)).toContain('/menu/cocktail.jpg')
    expect(session.products.every((product) => product.costAmount === 0)).toBe(true)

    const orderResponse = await app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      payload: {
        tableToken: session.tableToken,
        items: [
          { productId: 'product-cocktail', quantity: 2 },
          { productId: 'product-fruit', quantity: 1 },
        ],
        fulfillmentNote: '鸡尾酒少冰，小食一起上',
        idempotencyKey: 'guest-cart-payment-0001',
      },
    })
    expect(orderResponse.statusCode).toBe(201)
    expect(orderResponse.json()).toMatchObject({
      status: 'draft',
      fulfillmentNote: '鸡尾酒少冰，小食一起上',
      amounts: { payableAmount: 30_400 },
    })
    expect((await repository.read()).orderDomain.kdsTasks).toHaveLength(0)

    const checkout = await app.inject({
      method: 'POST',
      url: '/api/guest/checkout',
      payload: {
        tableToken: session.tableToken,
        orderId: orderResponse.json().id,
        idempotencyKey: 'guest-cart-payment-checkout-0001',
      },
    })
    expect(checkout.statusCode, checkout.body).toBe(201)
    expect(checkout.json()).toMatchObject({
      providerRequired: false,
      paymentIntent: { status: 'succeeded', amount: 30_400, channel: 'wechat_mock' },
      order: { status: 'submitted' },
    })
    const state = await repository.read()
    expect(state.orderDomain.kdsTasks).toHaveLength(2)
    expect(state.orderDomain.kdsTasks.every((task) => task.fulfillmentNote === '鸡尾酒少冰，小食一起上')).toBe(true)
    expect(state.commercialOps?.printJobs).toHaveLength(2)
    expect(state.commercialOps?.printJobs.every((job) => job.fulfillmentNote === '鸡尾酒少冰，小食一起上')).toBe(true)
    expect(state.commercialOps?.printJobs.map((job) => job.routeId).toSorted()).toEqual(['route-bar', 'route-kitchen'])
    expect(state.paymentDomain.paymentIntents[0]).toMatchObject({ status: 'succeeded', orderIds: [orderResponse.json().id] })
    await closeFixture(app, repository)
  })

  it('rejects reuse of a guest order key with different cart contents', async () => {
    const { app, repository, now } = await fixture()
    const session = (await exchange(app, staticQr(now()))).body
    const base = {
      tableToken: session.tableToken,
      items: [{ productId: 'product-beer', quantity: 1 }],
      idempotencyKey: 'guest-cart-conflict-0001',
    }
    expect((await app.inject({ method: 'POST', url: '/api/guest/orders', payload: base })).statusCode).toBe(201)
    const conflict = await app.inject({
      method: 'POST', url: '/api/guest/orders',
      payload: { ...base, items: [{ productId: 'product-beer', quantity: 2 }] },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().code).toBe('GUEST_ORDER_IDEMPOTENCY_CONFLICT')
    expect((await repository.read()).orderDomain.orders).toHaveLength(1)
    await closeFixture(app, repository)
  })

  it('requires an explicit second confirmation for a repeated cart inside the safety window', async () => {
    const { app, repository, now } = await fixture()
    const session = (await exchange(app, staticQr(now()))).body
    const first = await app.inject({
      method: 'POST', url: '/api/guest/orders',
      payload: {
        tableToken: session.tableToken,
        items: [{ productId: 'product-beer', quantity: 1 }],
        idempotencyKey: 'guest-duplicate-first-0001',
      },
    })
    expect(first.statusCode).toBe(201)

    const blockedPayload = {
      tableToken: session.tableToken,
      items: [{ productId: 'product-beer', quantity: 1 }],
      idempotencyKey: 'guest-duplicate-second-0001',
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/guest/orders', payload: blockedPayload })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json()).toMatchObject({
      code: 'GUEST_ORDER_DUPLICATE_CONFIRMATION_REQUIRED',
      details: { conflictingOrderId: first.json().id },
    })

    const confirmed = await app.inject({
      method: 'POST', url: '/api/guest/orders',
      payload: { ...blockedPayload, confirmedDuplicateOrderId: first.json().id },
    })
    expect(confirmed.statusCode, confirmed.body).toBe(201)
    expect((await repository.read()).orderDomain.orders).toHaveLength(2)
    await closeFixture(app, repository)
  })

  it('closes an expired checkout intent and creates a replacement', async () => {
    const { app, repository, now, setNow } = await fixture()
    const session = (await exchange(app, staticQr(now()))).body
    const order = await app.inject({
      method: 'POST', url: '/api/guest/orders',
      payload: {
        tableToken: session.tableToken,
        items: [{ productId: 'product-beer', quantity: 1 }],
        idempotencyKey: 'guest-expired-order-0001',
      },
    })
    const checkoutPayload = {
      tableToken: session.tableToken,
      orderId: order.json().id,
      idempotencyKey: 'guest-expired-checkout-0001',
    }
    await repository.mutate((state) => {
      const createdOrder = state.orderDomain.orders.find((candidate) => candidate.id === order.json().id)!
      createPaymentIntent(state.paymentDomain, {
        paymentIntentId: 'expired-guest-intent', tableSessionId: createdOrder.tableSessionId,
        lineAllocations: createdOrder.items.map((item) => ({
          orderId: createdOrder.id, orderItemId: item.id, quantity: item.quantity, unitPaidAmount: item.unitSalePriceAmount,
        })),
        amount: createdOrder.amounts.payableAmount, currency: 'CNY', channel: 'postar', merchantId: state.store.id,
        createdBy: 'guest-L01', deviceId: 'guest-web-L01', occurredAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + 100).toISOString(), idempotencyKey: 'expired-guest-intent-create-0001',
      })
      state.revision += 1
    })
    setNow(now() + 101)
    const replacement = await app.inject({ method: 'POST', url: '/api/guest/checkout', payload: checkoutPayload })
    expect(replacement.statusCode).toBe(201)
    expect(replacement.json().paymentIntent.id).not.toBe('expired-guest-intent')
    const intents = (await repository.read()).paymentDomain.paymentIntents
    expect(intents).toHaveLength(2)
    expect(intents[0]).toMatchObject({ status: 'closed', failureReason: '支付意图已过期' })
    expect(intents[1].status).toBe('succeeded')
    await closeFixture(app, repository)
  })

  it('allows automatic non-settling checkout in an explicitly enabled staging pilot', async () => {
    const { app, repository, now } = await fixture('staging', true)
    const session = (await exchange(app, staticQr(now()))).body
    const orderResponse = await app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      payload: {
        tableToken: session.tableToken,
        items: [{ productId: 'product-beer', quantity: 1 }],
        idempotencyKey: 'staging-pilot-guest-order-0001',
      },
    })
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/guest/checkout',
      payload: {
        tableToken: session.tableToken,
        orderId: orderResponse.json().id,
        idempotencyKey: 'staging-pilot-guest-checkout-0001',
      },
    })
    expect(checkout.statusCode, checkout.body).toBe(201)
    expect(checkout.json()).toMatchObject({
      providerRequired: false,
      paymentIntent: { status: 'succeeded', channel: 'wechat_mock' },
      order: { status: 'in_fulfillment' },
    })
    await closeFixture(app, repository)
  })

  it('rejects a stale guest cart when the administrator has just marked the product sold out', async () => {
    const { app, repository, now } = await fixture()
    const session = (await exchange(app, staticQr(now()))).body
    expect(session.products.find((product) => product.id === 'product-cocktail')?.soldOut).toBe(false)

    await repository.mutate((state) => {
      const product = state.products.find((candidate) => candidate.id === 'product-cocktail')!
      product.soldOut = true
      product.soldOutReason = '今晚基酒已售完'
      state.revision += 1
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/guest/orders',
      payload: {
        tableToken: session.tableToken,
        items: [{ productId: 'product-cocktail', quantity: 1 }],
        idempotencyKey: 'guest-stale-cart-soldout-0001',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('今晚基酒已售完')
    expect((await repository.read()).orderDomain.orders).toHaveLength(0)
    await closeFixture(app, repository)
  })
})
