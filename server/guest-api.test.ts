import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerGuestRoutes } from './guest-api.js'
import { JsonRepository } from './repository.js'
import { signTableAccessToken } from './table-access.js'

async function fixture() {
  const repository = new JsonRepository(`/tmp/mbox-guest-${crypto.randomUUID()}.json`)
  await repository.init()
  const app = Fastify()
  registerGuestRoutes(app, repository, { secret: 'q'.repeat(32), runtimeMode: 'test' })
  return { app, repository }
}

describe('guest table API', () => {
  it('returns only the signed table session and accepts an idempotent request', async () => {
    const { app, repository } = await fixture()
    const token = signTableAccessToken({
      storeId: 'mbox-lujiazui', tableCode: 'L01', tokenVersion: 1, issuedAt: Date.now(),
    }, 'q'.repeat(32))
    const session = await app.inject({ method: 'GET', url: `/api/guest/session?token=${encodeURIComponent(token)}` })
    expect(session.statusCode).toBe(200)
    expect(session.json()).not.toHaveProperty('employees')
    expect(session.json().table.code).toBe('L01')

    const body = { tableToken: token, serviceTypeId: 'water', note: '', idempotencyKey: 'guest-request-0001' }
    const first = await app.inject({ method: 'POST', url: '/api/guest/tasks', payload: body })
    const replay = await app.inject({ method: 'POST', url: '/api/guest/tasks', payload: body })
    expect(first.statusCode).toBe(201)
    expect(replay.json().id).toBe(first.json().id)
    await app.close()
    await repository.close()
  })

  it('rejects a token for another store', async () => {
    const { app, repository } = await fixture()
    const token = signTableAccessToken({
      storeId: 'other-store', tableCode: 'L01', tokenVersion: 1, issuedAt: Date.now(),
    }, 'q'.repeat(32))
    const response = await app.inject({ method: 'GET', url: `/api/guest/session?token=${encodeURIComponent(token)}` })
    expect(response.statusCode).toBe(403)
    await app.close()
    await repository.close()
  })

  it('replays a guest song request with the same stable request id', async () => {
    const { app, repository } = await fixture()
    const token = signTableAccessToken({
      storeId: 'mbox-lujiazui', tableCode: 'L01', tokenVersion: 1, issuedAt: Date.now(),
    }, 'q'.repeat(32))
    const session = await app.inject({ method: 'GET', url: `/api/guest/session?token=${encodeURIComponent(token)}` })
    const offer = session.json().songOffers[0]
    expect(offer).toBeTruthy()
    const payload = {
      tableToken: token,
      appearanceId: offer.appearanceId,
      singerId: offer.singerId,
      songId: offer.songId,
      customerNote: '生日祝福',
      idempotencyKey: 'guest-song-retry-0001',
    }
    const first = await app.inject({ method: 'POST', url: '/api/guest/song-requests', payload })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const replay = await app.inject({ method: 'POST', url: '/api/guest/song-requests', payload })
    expect(first.statusCode).toBe(201)
    expect(replay.statusCode).toBe(201)
    expect(replay.json().id).toBe(first.json().id)
    expect((await repository.read()).songState.requests).toHaveLength(1)
    await app.close()
    await repository.close()
  })
})
