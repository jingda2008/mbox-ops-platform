import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { RuntimeRepository, RuntimeRepositoryHealth } from './repository.js'
import { createSeedState } from './seed.js'
import { registerPublicReservationRoutes, signPublicReservationSession } from './public-reservation-api.js'
import { MemoryRateLimitStore, type RateLimitStore } from './rate-limit.js'

const NOW = Date.parse('2030-07-14T10:00:00.000Z')
const SECRET = 'r'.repeat(32)

class MemoryRepository implements RuntimeRepository {
  state = createSeedState()
  async init() {}
  async read() { return structuredClone(this.state) }
  async mutate<T>(mutation: (state: RuntimeState) => T | Promise<T>) {
    const next = structuredClone(this.state)
    const result = await mutation(next)
    this.state = next
    return result
  }
  async reset() { this.state = createSeedState(); return structuredClone(this.state) }
  async healthCheck(): Promise<RuntimeRepositoryHealth> { return { ready: true, repository: 'memory', revision: this.state.revision } }
  async close() {}
}

function rateLimitStore() {
  return new MemoryRateLimitStore({
    usage: 'test', tenantId: 'tenant-test', storeId: 'mbox-lujiazui', hashSecret: 'l'.repeat(32), now: () => NOW,
  })
}

async function fixture(limiter: RateLimitStore = rateLimitStore()) {
  const app = Fastify()
  const repository = new MemoryRepository()
  registerPublicReservationRoutes(app, repository, { secret: SECRET, now: () => NOW, rateLimitStore: limiter })
  await app.ready()
  return { app, repository }
}

const apps: FastifyInstance[] = []
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

function token(customerId: string, storeId = 'mbox-lujiazui') {
  return signPublicReservationSession({ storeId, customerId, issuedAt: NOW, expiresAt: NOW + 60_000 }, SECRET)
}

describe('public reservation pilot API', () => {
  it('issues a signed session without exposing other guests', async () => {
    const { app } = await fixture()
    apps.push(app)
    const session = await app.inject({ method: 'POST', url: '/api/public/reservation-session' })
    expect(session.statusCode).toBe(200)
    expect(session.json().accessToken).toContain('.')
    const list = await app.inject({
      method: 'GET', url: '/api/public/reservations',
      headers: { authorization: `Bearer ${session.json().accessToken}` },
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().reservations).toEqual([])
    expect(list.json().config.areaPreferences.length).toBeGreaterThan(0)
  })

  it('creates once, returns only the current phone reservations and rejects another store', async () => {
    const { app, repository } = await fixture()
    apps.push(app)
    const input = {
      customerName: 'Amy', partySize: 4, areaPreferenceCode: 'lounge', occasionCode: 'birthday',
      occasionNote: '演练生日桌', scheduledAt: '2030-07-15T12:00:00.000Z', idempotencyKey: 'public-reservation-0001',
    }
    const first = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: { authorization: `Bearer ${token('customer-a')}` }, payload: input })
    const replay = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: { authorization: `Bearer ${token('customer-a')}` }, payload: input })
    const other = await app.inject({ method: 'GET', url: '/api/public/reservations', headers: { authorization: `Bearer ${token('customer-b')}` } })
    const wrongStore = await app.inject({ method: 'GET', url: '/api/public/reservations', headers: { authorization: `Bearer ${token('customer-c', 'other-store')}` } })
    expect(first.statusCode).toBe(201)
    expect(replay.statusCode).toBe(200)
    expect(repository.state.reservationState?.reservations).toHaveLength(1)
    expect(other.json().reservations).toEqual([])
    expect(wrongStore.statusCode).toBe(403)
  })

  it('rejects unsigned sessions and invalid reservation times', async () => {
    const { app } = await fixture()
    apps.push(app)
    const unsigned = await app.inject({ method: 'GET', url: '/api/public/reservations' })
    const invalidTime = await app.inject({
      method: 'POST', url: '/api/public/reservations', headers: { authorization: `Bearer ${token('customer-a')}` },
      payload: { customerName: 'Amy', partySize: 2, scheduledAt: '2030-07-14T10:05:00.000Z', idempotencyKey: 'public-reservation-0002' },
    })
    expect(unsigned.statusCode).toBe(401)
    expect(invalidTime.statusCode).toBe(400)
    expect(invalidTime.json()).toMatchObject({ code: 'PUBLIC_RESERVATION_TIME_INVALID' })
  })

  it('shares session issuance limits across route instances', async () => {
    const sharedLimiter = rateLimitStore()
    const first = await fixture(sharedLimiter)
    const second = await fixture(sharedLimiter)
    apps.push(first.app, second.app)

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const target = attempt % 2 === 0 ? first.app : second.app
      const response = await target.inject({ method: 'POST', url: '/api/public/reservation-session' })
      expect(response.statusCode).toBe(200)
    }
    const blocked = await second.app.inject({ method: 'POST', url: '/api/public/reservation-session' })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().code).toBe('PUBLIC_RESERVATION_RATE_LIMITED')
  })
})
