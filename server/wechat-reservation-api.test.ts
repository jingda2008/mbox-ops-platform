import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { WechatAuthenticatedPrincipal } from '../src/shared/wechat-contracts.js'
import { createReservation } from './reservation-domain.js'
import { reservationsFor } from './reservation-api.js'
import type { RuntimeRepository, RuntimeRepositoryHealth } from './repository.js'
import { createSeedState } from './seed.js'
import type { WechatApiSessionRecord } from './wechat-api.js'
import { registerWechatReservationRoutes } from './wechat-reservation-api.js'

const NOW = Date.parse('2030-07-14T10:00:00.000Z')
const SCOPE = { tenantId: 'tenant-mbox', storeId: 'store-lujiazui', appId: 'wx-mbox' }
const TOKEN_A = 'a'.repeat(43)
const TOKEN_B = 'b'.repeat(43)
const TOKEN_C = 'c'.repeat(43)

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('base64url')
}

class MemoryRuntimeRepository implements RuntimeRepository {
  state = createSeedState()

  async init() {}
  async read() { return structuredClone(this.state) }
  async mutate<T>(mutation: (state: RuntimeState) => T | Promise<T>) {
    const working = structuredClone(this.state)
    const result = await mutation(working)
    this.state = working
    return result
  }
  async reset() { this.state = createSeedState(); return structuredClone(this.state) }
  async healthCheck(): Promise<RuntimeRepositoryHealth> {
    return { ready: true, repository: 'memory', revision: this.state.revision }
  }
  async close() {}
}

function principal(principalId: string, memberId: string | null = null): WechatAuthenticatedPrincipal {
  return {
    ...SCOPE,
    principalId,
    identityId: `identity-${principalId}`,
    memberId,
    hasUnionId: true,
  }
}

function session(value: WechatAuthenticatedPrincipal, overrides: Partial<WechatApiSessionRecord> = {}): WechatApiSessionRecord {
  return {
    accessTokenHash: '',
    principal: value,
    issuedAt: NOW - 60_000,
    expiresAt: NOW + 3_600_000,
    revokedAt: null,
    ...overrides,
  }
}

async function buildApp(records: Record<string, WechatApiSessionRecord>) {
  const app = Fastify()
  const repository = new MemoryRuntimeRepository()
  registerWechatReservationRoutes(app, repository, {
    identityRepository: {
      async findSession(hash) { return records[hash] ? structuredClone(records[hash]) : null },
    },
    ...SCOPE,
    now: () => NOW,
  })
  await app.ready()
  return { app, repository }
}

const apps: FastifyInstance[] = []
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

describe('wechat reservation customer boundary', () => {
  it('requires a live, unrevoked WeChat bearer session', async () => {
    const { app } = await buildApp({
      [tokenHash(TOKEN_A)]: session(principal('customer-a'), { revokedAt: NOW - 1 }),
      [tokenHash(TOKEN_C)]: session({ ...principal('customer-c'), storeId: 'store-other' }),
    })
    apps.push(app)

    const missing = await app.inject({ method: 'GET', url: '/api/wechat/reservations' })
    const revoked = await app.inject({
      method: 'GET',
      url: '/api/wechat/reservations',
      headers: { authorization: `Bearer ${TOKEN_A}` },
    })
    const otherStore = await app.inject({
      method: 'GET',
      url: '/api/wechat/reservations',
      headers: { authorization: `Bearer ${TOKEN_C}` },
    })

    expect(missing.statusCode).toBe(401)
    expect(missing.json()).toMatchObject({ code: 'WECHAT_SESSION_REQUIRED' })
    expect(revoked.statusCode).toBe(401)
    expect(revoked.json()).toMatchObject({ code: 'WECHAT_SESSION_INVALID' })
    expect(otherStore.statusCode).toBe(403)
    expect(otherStore.json()).toMatchObject({ code: 'WECHAT_RESERVATION_SCOPE_FORBIDDEN' })
  })

  it('returns public config and only reservations owned by the current principal or member', async () => {
    const { app, repository } = await buildApp({
      [tokenHash(TOKEN_A)]: session(principal('customer-a', 'member-a')),
      [tokenHash(TOKEN_B)]: session(principal('customer-b')),
    })
    apps.push(app)
    const domain = reservationsFor(repository.state)
    createReservation(domain, {
      reservationId: 'reservation-a', customerReference: 'member:member-a', customerName: '林女士',
      contactReference: 'wechat-principal:customer-a', sourceCode: 'wechat', partySize: 4,
      scheduledAt: '2030-07-15T12:00:00.000Z', depositRequiredAmount: 0, depositCurrency: 'CNY',
      actorId: 'wechat:customer-a', occurredAt: '2030-07-14T10:01:00.000Z', idempotencyKey: 'reservation-a-key',
    })
    createReservation(domain, {
      reservationId: 'reservation-b', customerReference: 'wechat-principal:customer-b', customerName: '王先生',
      contactReference: 'wechat-principal:customer-b', sourceCode: 'wechat', partySize: 2,
      scheduledAt: '2030-07-15T13:00:00.000Z', depositRequiredAmount: 0, depositCurrency: 'CNY',
      actorId: 'wechat:customer-b', occurredAt: '2030-07-14T10:02:00.000Z', idempotencyKey: 'reservation-b-key',
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/wechat/reservations',
      headers: { authorization: `Bearer ${TOKEN_A}` },
    })
    const body = response.json()

    expect(response.statusCode).toBe(200)
    expect(body.reservations).toHaveLength(1)
    expect(body.reservations[0]).toMatchObject({ id: 'reservation-a', customerName: '林女士' })
    expect(body.config).not.toHaveProperty('sources')
    expect(body).not.toHaveProperty('auditEvents')
    expect(body).not.toHaveProperty('employees')
    expect(JSON.stringify(body)).not.toContain('customer-b')
    expect(JSON.stringify(body)).not.toContain('wechat-principal')
  })

  it('creates a zero-deposit WeChat reservation once when the client retries', async () => {
    const { app, repository } = await buildApp({
      [tokenHash(TOKEN_A)]: session(principal('customer-a')),
    })
    apps.push(app)
    const payload = {
      customerName: 'Amy',
      partySize: 6,
      areaPreferenceCode: 'lounge',
      occasionCode: 'birthday',
      occasionNote: '希望安排生日歌',
      scheduledAt: '2030-07-15T12:00:00.000Z',
      idempotencyKey: 'wechat-reservation-create-0001',
    }
    const headers = { authorization: `Bearer ${TOKEN_A}` }
    const revisionBefore = repository.state.revision

    const first = await app.inject({ method: 'POST', url: '/api/wechat/reservations', headers, payload })
    const replay = await app.inject({ method: 'POST', url: '/api/wechat/reservations', headers, payload })
    const domain = reservationsFor(repository.state)

    expect(first.statusCode).toBe(201)
    expect(replay.statusCode).toBe(200)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(replay.json()).toEqual(first.json())
    expect(domain.reservations).toHaveLength(1)
    expect(domain.auditEvents).toHaveLength(1)
    expect(domain.reservations[0]).toMatchObject({
      sourceCode: 'wechat',
      customerReference: 'wechat-principal:customer-a',
      contactReference: 'wechat-principal:customer-a',
      createdBy: 'wechat:customer-a',
      status: 'requested',
      deposit: { requiredAmount: 0, status: 'not_required' },
    })
    expect(repository.state.revision).toBe(revisionBefore + 1)
    expect(JSON.stringify(first.json())).not.toContain('customerReference')
  })

  it('rejects customer attempts to choose source, contact or deposit amount', async () => {
    const { app, repository } = await buildApp({
      [tokenHash(TOKEN_A)]: session(principal('customer-a')),
    })
    apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/wechat/reservations',
      headers: { authorization: `Bearer ${TOKEN_A}` },
      payload: {
        customerName: 'Amy',
        partySize: 2,
        scheduledAt: '2030-07-15T12:00:00.000Z',
        idempotencyKey: 'wechat-reservation-tamper-0001',
        sourceCode: 'phone',
        contactReference: '13800138000',
        depositRequiredAmount: 1,
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'WECHAT_RESERVATION_INPUT_INVALID' })
    expect(reservationsFor(repository.state).reservations).toHaveLength(0)
  })

  it('rejects a past or immediate reservation time', async () => {
    const { app, repository } = await buildApp({
      [tokenHash(TOKEN_A)]: session(principal('customer-a')),
    })
    apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/wechat/reservations',
      headers: { authorization: `Bearer ${TOKEN_A}` },
      payload: {
        customerName: 'Amy',
        partySize: 2,
        scheduledAt: new Date(NOW + 5 * 60_000).toISOString(),
        idempotencyKey: 'wechat-reservation-too-soon-0001',
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'WECHAT_RESERVATION_TIME_INVALID' })
    expect(reservationsFor(repository.state).reservations).toHaveLength(0)
  })
})
