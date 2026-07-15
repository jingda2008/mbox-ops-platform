import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RuntimeState, Table } from '../src/shared/contracts.js'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'
import type { GuestSessionResponse } from '../src/shared/guest-contracts.js'
import { registerGuestRoutes } from './guest-api.js'
import { JsonRepository } from './repository.js'
import { requireGuestSession, signStaticTableQrToken, verifyTableAccessToken } from './table-access.js'
import { transferOpenTableSession } from './table-session-api.js'

const secret = 'q'.repeat(32)
const sessionTtlMs = 5 * 60_000

async function fixture(runtimeMode: RuntimeMode = 'test', allowPaymentSimulation = false) {
  let now = Date.now()
  const repository = new JsonRepository(`/tmp/mbox-guest-${crypto.randomUUID()}.json`)
  await repository.init()
  const app = Fastify()
  registerGuestRoutes(app, repository, {
    secret,
    runtimeMode,
    allowPaymentSimulation,
    guestSessionTtlMs: sessionTtlMs,
    now: () => now,
  })
  return { app, repository, now: () => now, setNow: (value: number) => { now = value } }
}

function staticQr(now: number, storeId = 'mbox-lujiazui', tableCode = 'L01', tokenVersion = 1) {
  return signStaticTableQrToken({ storeId, tableCode, tokenVersion, issuedAt: now }, secret)
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
  it('keeps the local table-code sample by issuing the same short-lived session token', async () => {
    const { app, repository, now } = await fixture()
    const response = await app.inject({ method: 'GET', url: '/api/guest/session?table=L01' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as GuestSessionResponse
    expect(body.table.code).toBe('L01')
    expect(body.serviceTypes.map((type) => type.code)).not.toContain('FULFILLMENT_DELIVERY')
    expect(requireGuestSession(verifyTableAccessToken(body.tableToken, secret, now())).tableSessionId)
      .toBe(body.account.tableSessionId)
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
      task.status = 'completed'
      task.completedAt = new Date(now()).toISOString()
      state.revision += 1
    })
    const feedback = await app.inject({
      method: 'POST',
      url: `/api/guest/tasks/${encodeURIComponent(first.json().id)}/feedback`,
      payload: {
        tableToken: body.tableToken,
        action: 'confirm',
        note: '',
        idempotencyKey: 'guest-feedback-0001',
      },
    })
    expect(feedback.statusCode).toBe(200)
    expect(feedback.json().status).toBe('confirmed')
    await closeFixture(app, repository)
  })

  it('does not exchange a static QR unless the table has a current open visit', async () => {
    const { app, repository, now } = await fixture()
    const response = (await exchange(app, staticQr(now(), 'mbox-lujiazui', 'L04'))).response
    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('TABLE_SESSION_NOT_OPEN')
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

    for (const [index, note] of ['需要婴儿椅', '需要纸巾', '空调温度调高', '稍后安排生日歌'].entries()) {
      expect((await submit(note, `000${index + 3}`)).statusCode).toBe(201)
    }
    const limited = await submit('再拿一个杯子', '0007')
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ code: 'GUEST_SERVICE_RATE_LIMITED' })
    expect((await repository.read()).tasks.filter((task) => task.serviceTypeId === customType!.id)).toHaveLength(5)

    setNow(now() + 61_000)
    expect((await submit('一分钟后再拿一个杯子', '0008')).statusCode).toBe(201)
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
        idempotencyKey: 'guest-cart-payment-0001',
      },
    })
    expect(orderResponse.statusCode).toBe(201)
    expect(orderResponse.json()).toMatchObject({ status: 'draft', amounts: { payableAmount: 30_400 } })
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
    expect(checkout.statusCode).toBe(201)
    expect(checkout.json()).toMatchObject({
      providerRequired: false,
      paymentIntent: { status: 'succeeded', amount: 30_400, channel: 'wechat_mock' },
      order: { status: 'submitted' },
    })
    const state = await repository.read()
    expect(state.orderDomain.kdsTasks).toHaveLength(2)
    expect(state.paymentDomain.paymentIntents[0]).toMatchObject({ status: 'succeeded', orderIds: [orderResponse.json().id] })
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
    expect(checkout.statusCode).toBe(201)
    expect(checkout.json()).toMatchObject({
      providerRequired: false,
      paymentIntent: { status: 'succeeded', channel: 'wechat_mock' },
      order: { status: 'submitted' },
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
