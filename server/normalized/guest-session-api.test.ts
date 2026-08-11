import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GuestSessionRecord, TableScanResult } from './guest-session-repository.js'
import {
  GUEST_DEVICE_HEADER,
  GUEST_SESSION_COOKIE,
  GuestRequestContextResolver,
  HeaderGuestDeviceFingerprintResolver,
} from './guest-request-context.js'
import {
  guestSessionApiPlugin,
  type GuestSessionApiOptions,
} from './guest-session-api.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const customerId = '33333333-3333-4333-8333-333333333333'
const tableSessionId = '44444444-4444-4444-8444-444444444444'
const guestSessionId = '55555555-5555-4555-8555-555555555555'
const tableQrToken = 'fixed_table_qr_'.padEnd(48, 'q')
const deviceKey = 'wechat-device-guest-001'
const sessionToken = 'guest_session_'.padEnd(48, 's')

const session: GuestSessionRecord = {
  id: guestSessionId,
  kind: 'table',
  customerId,
  tableSessionId,
  reservationId: null,
  tableCode: 'VIP1',
  tableDisplayName: 'VIP 1',
  businessDate: '2026-08-11',
  scopes: [
    'guest.session.read', 'guest.menu.read', 'guest.order.create',
    'guest.service.create', 'guest.song.request',
  ],
  issuedAt: '2026-08-11T12:00:00.000Z',
  expiresAt: '2026-08-11T13:00:00.000Z',
  lastSeenAt: '2026-08-11T12:00:00.000Z',
}

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function fixture(result: TableScanResult = { status: 'active', sessionToken, session }) {
  const scanTable = vi.fn(async () => result)
  const authenticate = vi.fn(async () => session)
  const requestContext = new GuestRequestContextResolver(
    { resolve: () => ({ tenantId, storeId }) },
    new HeaderGuestDeviceFingerprintResolver(),
    { authenticate },
  )
  const options: GuestSessionApiOptions = {
    sessions: { scanTable },
    requestContext,
    businessClock: { current: async () => ({ businessDate: '2026-08-11' }) },
  }
  const app = Fastify()
  apps.push(app)
  app.register(guestSessionApiPlugin, { ...options, prefix: '/api/guest' })
  return { app, scanTable, authenticate }
}

describe('guestSessionApiPlugin', () => {
  it('issues a secure cookie and returns no internal IDs, hashes, or bearer token', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/session/scan?customerId=forged&tableSessionId=forged',
      headers: {
        [GUEST_DEVICE_HEADER]: deviceKey,
        'x-customer-id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'x-table-session-id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'x-capabilities': '*',
      },
      payload: {
        tableQrToken,
        deviceKey,
        scope: { tenantId: 'forged', storeId: 'forged' },
        customerId: 'forged',
        tableSessionId: 'forged',
        capabilities: ['admin'],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['set-cookie']).toContain(`${GUEST_SESSION_COOKIE}=${sessionToken}`)
    expect(response.headers['set-cookie']).toContain('HttpOnly')
    expect(response.headers['set-cookie']).toContain('Secure')
    expect(response.headers['set-cookie']).toContain('SameSite=Lax')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({
      data: {
        status: 'active',
        message: '已经找到您的桌位，今晚由我们继续照顾您。',
        table: { code: 'VIP1', displayName: 'VIP 1' },
        businessDate: '2026-08-11',
        expiresAt: '2026-08-11T13:00:00.000Z',
        capabilities: session.scopes,
      },
    })
    const serialized = JSON.stringify(response.json())
    expect(serialized).not.toContain(customerId)
    expect(serialized).not.toContain(tableSessionId)
    expect(serialized).not.toContain(guestSessionId)
    expect(serialized).not.toContain(sessionToken)
    expect(serialized).not.toMatch(/[0-9a-f]{64}/)
    expect(value.scanTable).toHaveBeenCalledWith({
      scope: { tenantId, storeId },
      tableQrToken,
      deviceFingerprint: deviceKey,
      businessDate: '2026-08-11',
    })
  })

  it('returns a friendly stable waiting state when the table is not open', async () => {
    const value = fixture({
      status: 'waiting_for_table',
      tableCode: 'W01',
      tableDisplayName: '室外 W01',
    })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/session/scan',
      headers: { [GUEST_DEVICE_HEADER]: deviceKey },
      payload: { tableQrToken, deviceKey },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      data: {
        status: 'waiting_for_table',
        message: '欢迎到店，这张桌子还在准备中，请稍候或请服务伙伴为您开台。',
        table: { code: 'W01', displayName: '室外 W01' },
      },
    })
    expect(JSON.stringify(response.json())).not.toContain('过期')
    expect(response.headers['set-cookie']).toContain('Max-Age=0')
  })

  it('coalesces a double scan without replacing the valid cookie', async () => {
    const value = fixture({ status: 'already_active', session })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/session/scan',
      headers: { [GUEST_DEVICE_HEADER]: deviceKey },
      payload: { tableQrToken, deviceKey },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.json()).toMatchObject({
      data: {
        status: 'already_active',
        table: { code: 'VIP1', displayName: 'VIP 1' },
      },
    })
  })

  it('returns only a safe public DTO for an authenticated session', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'GET',
      url: '/api/guest/session?customerId=forged',
      headers: {
        authorization: `Bearer ${sessionToken}`,
        [GUEST_DEVICE_HEADER]: deviceKey,
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      data: {
        status: 'active',
        sessionKind: 'table',
        table: { code: 'VIP1', displayName: 'VIP 1' },
        businessDate: '2026-08-11',
        expiresAt: '2026-08-11T13:00:00.000Z',
        capabilities: session.scopes,
      },
    })
    const serialized = JSON.stringify(response.json())
    expect(serialized).not.toContain(customerId)
    expect(serialized).not.toContain(tableSessionId)
    expect(serialized).not.toContain(guestSessionId)
    expect(value.authenticate).toHaveBeenCalledWith({
      scope: { tenantId, storeId },
      sessionToken,
      deviceFingerprint: deviceKey,
    })
  })

  it('rejects invalid QR credentials without reflecting them', async () => {
    const value = fixture({ status: 'invalid_qr' })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/session/scan',
      headers: { [GUEST_DEVICE_HEADER]: deviceKey },
      payload: { tableQrToken, deviceKey },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: {
        code: 'TABLE_QR_INVALID',
        message: '没有识别到本店有效桌码，请重新扫描桌面上的固定二维码。',
      },
    })
    expect(JSON.stringify(response.json())).not.toContain(tableQrToken)
  })

  it('returns a retry time when fixed-table scans are rate limited', async () => {
    const value = fixture({
      status: 'rate_limited',
      retryAt: '2026-08-11T12:01:00.000Z',
    })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/session/scan',
      headers: { [GUEST_DEVICE_HEADER]: deviceKey },
      payload: { tableQrToken, deviceKey },
    })
    expect(response.statusCode).toBe(429)
    expect(response.json()).toMatchObject({
      error: {
        code: 'GUEST_SCAN_RATE_LIMITED',
        retryAt: '2026-08-11T12:01:00.000Z',
      },
    })
  })

  it('rejects conflicting device identities before calling the session service', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/guest/session/scan',
      headers: { [GUEST_DEVICE_HEADER]: 'header-device-002' },
      payload: { tableQrToken, deviceKey: 'body-device-001' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: {
        code: 'GUEST_SESSION_INVALID',
        message: '设备信息不一致，请重新扫描桌面二维码',
      },
    })
    expect(value.scanTable).not.toHaveBeenCalled()
  })
})
