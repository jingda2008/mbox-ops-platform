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

function headers(customerId = 'customer-a') {
  return { authorization: `Bearer ${token(customerId)}` }
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    customerName: 'Amy', phone: '13800138000', partySize: 4, areaPreferenceCode: 'lounge', occasionCode: 'birthday',
    occasionNote: '演练生日桌', scheduledAt: '2030-07-15T12:30:00.000Z', idempotencyKey: 'public-reservation-0001',
    ...overrides,
  }
}

describe('public reservation commercial API', () => {
  it('issues a signed session and publishes configurable booking rules without exposing other guests', async () => {
    const { app } = await fixture()
    apps.push(app)
    const session = await app.inject({ method: 'POST', url: '/api/public/reservation-session' })
    expect(session.statusCode).toBe(200)
    expect(session.json().accessToken).toContain('.')
    const list = await app.inject({ method: 'GET', url: '/api/public/reservations', headers: { authorization: `Bearer ${session.json().accessToken}` } })
    expect(list.statusCode).toBe(200)
    expect(list.json().reservations).toEqual([])
    expect(list.json().config).toMatchObject({
      businessHours: { timeZone: 'Asia/Shanghai', openingTime: '20:30', closingTime: '02:00', slotMinutes: 30 },
      capacity: { defaultDailyCapacity: 120, defaultSlotCapacity: 20 },
      publicRules: { minimumLeadMinutes: 15, maximumAdvanceDays: 180, acceptedContactMethods: ['phone', 'wechat'] },
    })
  })

  it('creates once with contact identity, replays safely and isolates guest sessions', async () => {
    const { app, repository } = await fixture()
    apps.push(app)
    const input = createInput()
    const first = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers(), payload: input })
    const replay = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers(), payload: input })
    const own = await app.inject({ method: 'GET', url: '/api/public/reservations', headers: headers() })
    const other = await app.inject({ method: 'GET', url: '/api/public/reservations', headers: headers('customer-b') })
    const wrongStore = await app.inject({ method: 'GET', url: '/api/public/reservations', headers: { authorization: `Bearer ${token('customer-c', 'other-store')}` } })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({ phone: '+8613800138000', wechatId: null })
    expect(replay.statusCode).toBe(200)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(repository.state.reservationState?.reservations).toHaveLength(1)
    expect(own.json().reservations).toHaveLength(1)
    expect(other.json().reservations).toEqual([])
    expect(wrongStore.statusCode).toBe(403)
  })

  it('accepts explicit international E.164 phone numbers without treating them as mainland numbers', async () => {
    const { app } = await fixture()
    apps.push(app)
    const created = await app.inject({
      method: 'POST', url: '/api/public/reservations', headers: headers(),
      payload: createInput({ phone: '+1 415 555 2671' }),
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().phone).toBe('+14155552671')
  })

  it('requires a phone or WeChat identity and rejects times outside the configured cross-midnight window', async () => {
    const { app } = await fixture()
    apps.push(app)
    const noContact = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers(), payload: createInput({ phone: undefined }) })
    const beforeOpening = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers(), payload: createInput({
      scheduledAt: '2030-07-15T12:00:00.000Z', idempotencyKey: 'public-reservation-before-opening',
    }) })
    const afterMidnight = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers('customer-b'), payload: createInput({
      phone: undefined, wechatId: 'amy-night', scheduledAt: '2030-07-15T17:30:00.000Z', idempotencyKey: 'public-reservation-after-midnight',
    }) })
    expect(noContact.statusCode).toBe(400)
    expect(noContact.json().code).toBe('PUBLIC_RESERVATION_CONTACT_INVALID')
    expect(beforeOpening.statusCode).toBe(400)
    expect(beforeOpening.json()).toMatchObject({ code: 'PUBLIC_RESERVATION_RULE_REJECTED' })
    expect(afterMidnight.statusCode).toBe(201)
  })

  it('blocks duplicate contact identities within the configured time window across browser sessions', async () => {
    const { app } = await fixture()
    apps.push(app)
    const first = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers('device-a'), payload: createInput() })
    const duplicate = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers('device-b'), payload: createInput({
      scheduledAt: '2030-07-15T13:00:00.000Z', idempotencyKey: 'public-reservation-duplicate',
    }) })
    expect(first.statusCode).toBe(201)
    expect(duplicate.statusCode).toBe(400)
    expect(duplicate.json().message).toContain('相近时间已经有预约')
  })

  it('enforces date closure, daily capacity and slot capacity overrides', async () => {
    const closedFixture = await fixture()
    apps.push(closedFixture.app)
    closedFixture.repository.state.reservationState!.config.capacity.dateOverrides = [{
      date: '2030-07-15', enabled: false, totalCapacity: 0, slotCapacities: [],
    }]
    const closed = await closedFixture.app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers(), payload: createInput() })
    expect(closed.statusCode).toBe(400)
    expect(closed.json().message).toContain('暂停接受预约')

    const capacityFixture = await fixture()
    apps.push(capacityFixture.app)
    capacityFixture.repository.state.reservationState!.config.capacity.dateOverrides = [{
      date: '2030-07-15', enabled: true, totalCapacity: 1, slotCapacities: [{ time: '20:30', capacity: 1 }],
    }]
    const first = await capacityFixture.app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers('capacity-a'), payload: createInput() })
    const full = await capacityFixture.app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers('capacity-b'), payload: createInput({
      phone: '13900139000', scheduledAt: '2030-07-15T13:00:00.000Z', idempotencyKey: 'public-reservation-capacity-full',
    }) })
    expect(first.statusCode).toBe(201)
    expect(full.statusCode).toBe(400)
    expect(full.json().message).toContain('这一天的预约已经满')
  })

  it('lets the owning guest update and cancel while rejecting another session', async () => {
    const { app } = await fixture()
    apps.push(app)
    const created = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers(), payload: createInput() })
    const reservationId = created.json().id as string
    const updatePayload = {
      customerName: 'Amy新称呼', phone: '13800138000', partySize: 6, scheduledAt: '2030-07-15T13:30:00.000Z',
      areaPreferenceCode: 'interactive', occasionCode: null, occasionNote: '', idempotencyKey: 'public-reservation-update-0001',
    }
    const forbidden = await app.inject({ method: 'PUT', url: `/api/public/reservations/${reservationId}`, headers: headers('other-device'), payload: updatePayload })
    const updated = await app.inject({ method: 'PUT', url: `/api/public/reservations/${reservationId}`, headers: headers(), payload: updatePayload })
    const cancelPayload = {
      reason: '行程有变', idempotencyKey: 'public-reservation-cancel-0001',
    }
    const cancelled = await app.inject({ method: 'DELETE', url: `/api/public/reservations/${reservationId}`, headers: headers(), payload: cancelPayload })
    const cancelReplay = await app.inject({ method: 'DELETE', url: `/api/public/reservations/${reservationId}`, headers: headers(), payload: cancelPayload })
    expect(forbidden.statusCode).toBe(403)
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ customerName: 'Amy新称呼', partySize: 6, areaPreferenceCode: 'interactive', occasionCode: null })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().status).toBe('cancelled')
    expect(cancelReplay.statusCode).toBe(200)
    expect(cancelReplay.json()).toEqual(cancelled.json())
  })

  it('stops public changes after the guest has arrived', async () => {
    const { app, repository } = await fixture()
    apps.push(app)
    const created = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers(), payload: createInput() })
    const reservationId = created.json().id as string
    repository.state.reservationState!.reservations.find((item) => item.id === reservationId)!.status = 'arrived'
    const updated = await app.inject({
      method: 'PUT', url: `/api/public/reservations/${reservationId}`, headers: headers(),
      payload: {
        customerName: 'Amy', phone: '13800138000', partySize: 8,
        scheduledAt: '2030-07-15T13:30:00.000Z', idempotencyKey: 'public-reservation-arrived-update',
      },
    })
    expect(updated.statusCode).toBe(400)
    expect(updated.json().message).toContain('已到店或结束')
  })

  it('applies an independent configurable create limit without charging idempotent replays', async () => {
    const { app, repository } = await fixture()
    apps.push(app)
    repository.state.reservationState!.config.publicRules.createRateLimit = { limit: 2, windowMinutes: 30 }
    const firstInput = createInput()
    const first = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers('rate-a'), payload: firstInput })
    const replay = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers('rate-a'), payload: firstInput })
    const second = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers('rate-b'), payload: createInput({
      phone: '13900139000', scheduledAt: '2030-07-15T13:30:00.000Z', idempotencyKey: 'public-reservation-rate-0002',
    }) })
    const blocked = await app.inject({ method: 'POST', url: '/api/public/reservations', headers: headers('rate-c'), payload: createInput({
      phone: '13700137000', scheduledAt: '2030-07-15T14:30:00.000Z', idempotencyKey: 'public-reservation-rate-0003',
    }) })
    expect(first.statusCode).toBe(201)
    expect(replay.statusCode).toBe(200)
    expect(second.statusCode).toBe(201)
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().code).toBe('PUBLIC_RESERVATION_CREATE_RATE_LIMITED')
  })

  it('rejects unsigned sessions and shares session issuance limits across route instances', async () => {
    const sharedLimiter = rateLimitStore()
    const first = await fixture(sharedLimiter)
    const second = await fixture(sharedLimiter)
    apps.push(first.app, second.app)
    const unsigned = await first.app.inject({ method: 'GET', url: '/api/public/reservations' })
    expect(unsigned.statusCode).toBe(401)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const target = attempt % 2 === 0 ? first.app : second.app
      expect((await target.inject({ method: 'POST', url: '/api/public/reservation-session' })).statusCode).toBe(200)
    }
    const blocked = await second.app.inject({ method: 'POST', url: '/api/public/reservation-session' })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().code).toBe('PUBLIC_RESERVATION_RATE_LIMITED')
  })
})
