import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EffectiveStaffAccess } from './staff-access-repository.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'
import {
  InvalidStaffCredentialsError,
  type StaffLoginResult,
} from './staff-auth-command-service.js'
import {
  StaffAuthTooManyAttemptsError,
  staffAuthApiPlugin,
  type StaffAuthApiOptions,
} from './staff-auth-api.js'
import {
  DEVICE_ACCESS_COOKIE,
  NormalizedRequestContextResolver,
  STAFF_SESSION_COOKIE,
  fixedStoreScopeResolver,
} from './normalized-request-context.js'
import { StaffSessionNotFoundError, type StaffSession } from './staff-session-repository.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const leaseToken = 'lease_token_'.padEnd(43, 'a')
const sessionToken = 'session_token_'.padEnd(43, 'b')

const session: StaffSession = {
  id: '44444444-4444-4444-8444-444444444444',
  employeeId,
  deviceAccessLeaseId: '55555555-5555-4555-8555-555555555555',
  issuedAt: '2026-08-11T04:00:00.000Z',
  expiresAt: '2026-08-11T10:00:00.000Z',
  lastHeartbeatAt: '2026-08-11T04:00:00.000Z',
  onlineLeaseUntil: '2026-08-11T04:01:30.000Z',
  isOnline: true,
  revokedAt: null,
}

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function fixture(overrides: Partial<StaffAuthApiOptions['auth']> = {}) {
  const loginResult: StaffLoginResult = {
    sessionToken,
    session,
    access: staffAccess(),
  }
  const auth: StaffAuthApiOptions['auth'] = {
    verifyDailyStoreCredential: vi.fn(async () => ({
      leaseToken,
      leaseId: '55555555-5555-4555-8555-555555555555',
      businessDate: '2026-08-10',
      expiresAt: '2026-08-12T00:00:00.000Z',
    })),
    login: vi.fn(async () => loginResult),
    switchEmployee: vi.fn(async () => loginResult),
    authenticateSession: vi.fn(async () => ({ session, access: staffAccess() })),
    heartbeat: vi.fn(async () => ({ session, access: staffAccess() })),
    revokeSession: vi.fn(async () => ({ ...session, revokedAt: '2026-08-11T05:00:00.000Z' })),
    ...overrides,
  }
  const businessClock = {
    current: vi.fn(async () => ({
      businessDate: '2026-08-10',
      timezone: 'Asia/Shanghai',
      cutoff: '06:00:00',
    })),
  }
  const requestContext = new NormalizedRequestContextResolver(
    fixedStoreScopeResolver({ tenantId, storeId }),
    auth,
    businessClock,
  )
  const app = Fastify()
  apps.push(app)
  app.register(staffAuthApiPlugin, {
    prefix: '/api/auth',
    auth,
    requestContext,
    businessClock,
  })
  return { app, auth, businessClock }
}

describe('staffAuthApiPlugin', () => {
  it('verifies the current database business day and grants a secure device cookie', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/auth/device-access',
      payload: {
        credential: 'TEST_STORE_GATE',
        deviceKey: 'device-tablet-001',
        businessDate: '2099-01-01',
        scope: { tenantId: 'forged', storeId: 'forged' },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      data: { businessDate: '2026-08-10', expiresAt: '2026-08-12T00:00:00.000Z' },
    })
    expect(response.headers['set-cookie']).toContain(`${DEVICE_ACCESS_COOKIE}=${leaseToken}`)
    expect(response.headers['set-cookie']).toContain('HttpOnly')
    expect(response.headers['set-cookie']).toContain('Secure')
    expect(response.headers['set-cookie']).toContain('SameSite=Strict')
    expect(JSON.stringify(response.json())).not.toContain('TEST_STORE_GATE')
    expect(value.auth.verifyDailyStoreCredential).toHaveBeenCalledWith({
      scope: { tenantId, storeId },
      businessDate: '2026-08-10',
      credential: 'TEST_STORE_GATE',
      deviceKey: 'device-tablet-001',
    })
  })

  it('logs in with a device lease and returns only safe session metadata', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie: `${DEVICE_ACCESS_COOKIE}=${leaseToken}` },
      payload: { employeeCode: 'LIYAN', pin: '2468' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['set-cookie']).toContain(`${STAFF_SESSION_COOKIE}=${sessionToken}`)
    expect(response.headers['set-cookie']).toContain('HttpOnly')
    expect(response.json()).toMatchObject({
      data: {
        session: { employeeId, expiresAt: '2026-08-11T10:00:00.000Z' },
        employee: { id: employeeId, code: 'LIYAN', displayName: '李艳' },
        permissions: ['dashboard.view', 'table.open'],
      },
    })
    const serialized = JSON.stringify(response.json())
    expect(serialized).not.toContain('2468')
    expect(serialized).not.toContain(sessionToken)
    expect(serialized).not.toContain(leaseToken)
    expect(value.auth.login).toHaveBeenCalledWith({
      scope: { tenantId, storeId },
      deviceAccessToken: leaseToken,
      employeeCode: 'LIYAN',
      pin: '2468',
    })
  })

  it('switches employees without asking for the store credential again', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/auth/switch',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { employeeCode: 'TOM', pin: '1048' },
    })

    expect(response.statusCode).toBe(200)
    expect(value.auth.switchEmployee).toHaveBeenCalledWith({
      scope: { tenantId, storeId },
      currentSessionToken: sessionToken,
      employeeCode: 'TOM',
      pin: '1048',
    })
    expect(value.auth.verifyDailyStoreCredential).not.toHaveBeenCalled()
  })

  it('supports session lookup, heartbeat and logout with bearer or secure cookie', async () => {
    const value = fixture()
    const current = await value.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { authorization: `Bearer ${sessionToken}` },
    })
    expect(current.statusCode).toBe(200)
    expect(current.json()).toMatchObject({
      data: { businessDate: '2026-08-10', timezone: 'Asia/Shanghai' },
    })

    const heartbeat = await value.app.inject({
      method: 'POST',
      url: '/api/auth/heartbeat',
      headers: { cookie: `${STAFF_SESSION_COOKIE}=${sessionToken}` },
    })
    expect(heartbeat.statusCode).toBe(200)

    const logout = await value.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: `${STAFF_SESSION_COOKIE}=${sessionToken}` },
    })
    expect(logout.statusCode).toBe(204)
    expect(logout.headers['set-cookie']).toContain('Max-Age=0')
    expect(value.auth.revokeSession).toHaveBeenCalledWith({
      scope: { tenantId, storeId },
      sessionToken,
      actorEmployeeId: employeeId,
      businessDate: '2026-08-10',
      reason: '员工主动退出',
    })
  })

  it('returns stable Chinese 401, 403 and 429 errors without leaking secrets', async () => {
    const invalid = fixture({
      login: vi.fn(async () => { throw new InvalidStaffCredentialsError() }),
    })
    const invalidResponse = await invalid.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie: `${DEVICE_ACCESS_COOKIE}=${leaseToken}` },
      payload: { employeeCode: 'LIYAN', pin: '9999' },
    })
    expect(invalidResponse.statusCode).toBe(401)
    expect(invalidResponse.json()).toEqual({
      error: { code: 'AUTH_REQUIRED', message: '登录信息无效或已过期，请重新登录' },
    })
    expect(JSON.stringify(invalidResponse.json())).not.toContain('9999')

    const forbidden = fixture({
      authenticateSession: vi.fn(async () => { throw new StaffAccessDeniedError('internal employee id') }),
    })
    const forbiddenResponse = await forbidden.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { authorization: `Bearer ${sessionToken}` },
    })
    expect(forbiddenResponse.statusCode).toBe(403)
    expect(forbiddenResponse.json()).toEqual({
      error: { code: 'STAFF_ACCESS_FORBIDDEN', message: '当前员工无权执行此操作' },
    })

    const limited = fixture({
      login: vi.fn(async () => { throw new StaffAuthTooManyAttemptsError() }),
    })
    const limitedResponse = await limited.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie: `${DEVICE_ACCESS_COOKIE}=${leaseToken}` },
      payload: { employeeCode: 'LIYAN', pin: '2468' },
    })
    expect(limitedResponse.statusCode).toBe(429)
    expect(limitedResponse.json()).toEqual({
      error: { code: 'AUTH_RATE_LIMITED', message: '尝试次数过多，请稍后再试' },
    })

    const expired = fixture({
      authenticateSession: vi.fn(async () => { throw new StaffSessionNotFoundError() }),
    })
    const expiredResponse = await expired.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { authorization: `Bearer ${sessionToken}` },
    })
    expect(expiredResponse.statusCode).toBe(401)
  })
})

function staffAccess(): EffectiveStaffAccess {
  return {
    employeeId,
    employeeCode: 'LIYAN',
    displayName: '李艳',
    roleCodes: ['MANAGER'],
    permissions: ['dashboard.view', 'table.open'],
    deniedPermissions: [],
    dataScopes: [],
    approvalLimits: [],
    navigation: [],
    resolvedAt: '2026-08-11T04:00:00.000Z',
  }
}
