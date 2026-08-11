import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GuestSessionRecord } from './guest-session-repository.js'
import {
  GUEST_DEVICE_HEADER,
  GUEST_SESSION_COOKIE,
  GuestAuthenticationRequiredError,
  GuestCapabilityDeniedError,
  GuestDeviceBindingError,
  GuestRequestContextResolver,
  HeaderGuestDeviceFingerprintResolver,
  requireGuestCapability,
} from './guest-request-context.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const token = 'guest_token_'.padEnd(43, 'a')
const deviceKey = 'wechat-browser-device-001'

const session: GuestSessionRecord = {
  id: '33333333-3333-4333-8333-333333333333',
  kind: 'table',
  customerId: '44444444-4444-4444-8444-444444444444',
  tableSessionId: '55555555-5555-4555-8555-555555555555',
  reservationId: null,
  tableCode: 'VIP1',
  tableDisplayName: 'VIP 1',
  businessDate: '2026-08-11',
  scopes: ['guest.session.read', 'guest.menu.read', 'guest.order.create'],
  issuedAt: '2026-08-11T12:00:00.000Z',
  expiresAt: '2026-08-11T13:00:00.000Z',
  lastSeenAt: '2026-08-11T12:00:00.000Z',
}

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('GuestRequestContextResolver', () => {
  it('uses trusted store scope and authenticated session facts only', async () => {
    const authenticate = vi.fn(async () => session)
    const resolver = new GuestRequestContextResolver(
      { resolve: () => ({ tenantId, storeId }) },
      new HeaderGuestDeviceFingerprintResolver(),
      { authenticate },
    )
    const app = Fastify()
    apps.push(app)
    app.get('/context', async (request) => resolver.resolve(request))

    const response = await app.inject({
      method: 'GET',
      url: '/context?tableSessionId=forged&customerId=forged&scope=admin',
      headers: {
        authorization: `Bearer ${token}`,
        [GUEST_DEVICE_HEADER]: deviceKey,
        'x-tenant-id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'x-store-id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'x-table-session-id': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'x-customer-id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'x-capabilities': '*',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      scope: { tenantId, storeId },
      sessionKind: 'table',
      customerId: session.customerId,
      tableSessionId: session.tableSessionId,
      reservationId: null,
      tableCode: 'VIP1',
      tableDisplayName: 'VIP 1',
      businessDate: '2026-08-11',
      expiresAt: '2026-08-11T13:00:00.000Z',
      capabilities: ['guest.session.read', 'guest.menu.read', 'guest.order.create'],
      actorRef: `guest-session:${session.id}`,
    })
    expect(authenticate).toHaveBeenCalledWith({
      scope: { tenantId, storeId },
      sessionToken: token,
      deviceFingerprint: deviceKey,
    })
  })

  it('accepts a secure cookie and rejects conflicting bearer credentials', async () => {
    const resolver = new GuestRequestContextResolver(
      { resolve: () => ({ tenantId, storeId }) },
      new HeaderGuestDeviceFingerprintResolver(),
      { authenticate: async () => session },
    )
    const app = Fastify()
    apps.push(app)
    app.get('/context', async (request, reply) => {
      try {
        return await resolver.resolve(request)
      } catch (error) {
        if (error instanceof GuestAuthenticationRequiredError) {
          return reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } })
        }
        throw error
      }
    })

    const cookie = await app.inject({
      method: 'GET',
      url: '/context',
      headers: {
        cookie: `${GUEST_SESSION_COOKIE}=${token}`,
        [GUEST_DEVICE_HEADER]: deviceKey,
      },
    })
    expect(cookie.statusCode).toBe(200)

    const conflict = await app.inject({
      method: 'GET',
      url: '/context',
      headers: {
        authorization: `Bearer ${'b'.repeat(43)}`,
        cookie: `${GUEST_SESSION_COOKIE}=${token}`,
        [GUEST_DEVICE_HEADER]: deviceKey,
      },
    })
    expect(conflict.statusCode).toBe(401)
  })

  it('enforces the database-issued least-privilege capability list', () => {
    const context = {
      scope: { tenantId, storeId },
      sessionKind: 'table' as const,
      customerId: session.customerId,
      tableSessionId: session.tableSessionId,
      reservationId: null,
      tableCode: 'VIP1',
      tableDisplayName: 'VIP 1',
      businessDate: '2026-08-11',
      expiresAt: session.expiresAt,
      capabilities: ['guest.menu.read'],
      actorRef: `guest-session:${session.id}`,
    }
    expect(() => requireGuestCapability(context, 'guest.menu.read')).not.toThrow()
    expect(() => requireGuestCapability(context, 'guest.reservation.update'))
      .toThrow(GuestCapabilityDeniedError)
  })

  it('rejects conflicting body and header device identities', () => {
    const devices = new HeaderGuestDeviceFingerprintResolver()
    expect(() => devices.resolve({
      headers: { [GUEST_DEVICE_HEADER]: 'header-device-002' },
    } as never, 'body-device-001')).toThrow(GuestDeviceBindingError)
  })
})
