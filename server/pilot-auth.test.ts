import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import { registerPilotAuthRoutes } from './pilot-auth.js'
import { verifyStaffSession } from './auth-context.js'
import type { RuntimeRepository } from './repository.js'
import { MemoryRateLimitStore, type RateLimitStore } from './rate-limit.js'
import { MemoryPresenceLeaseStore } from './presence-store.js'

function repository(): RuntimeRepository {
  let state = createSeedState()
  return {
    init: async () => undefined,
    read: async () => structuredClone(state),
    mutate: async (mutation) => {
      const working = structuredClone(state)
      const result = await mutation(working)
      state = working
      return result
    },
    reset: async () => structuredClone(state),
    healthCheck: async () => ({ ready: true, repository: 'test', revision: state.revision }),
    close: async () => undefined,
  }
}

const employeePins = {
  'emp-owner': '1001', 'emp-operations-director': '1013', 'emp-admin': '1002', 'emp-lin': '1003', 'emp-jie': '1004',
  'emp-wu': '1005', 'emp-qing': '1006', 'emp-han': '1007', 'emp-tao': '1008',
  'emp-mia': '1009', 'emp-chen': '1010', 'emp-cashier': '1011', 'emp-host': '1012',
}

function rateLimitStore(now: () => number = Date.now) {
  return new MemoryRateLimitStore({
    usage: 'test', tenantId: 'tenant-test', storeId: 'mbox-lujiazui', hashSecret: 'l'.repeat(32), now,
  })
}

function authOptions(store: RateLimitStore = rateLimitStore()) {
  return {
    accessCode: 'store-pilot-code', employeePins, sessionSecret: 's'.repeat(32), sessionHours: 6, rateLimitStore: store,
  }
}

describe('pilot employee auth', () => {
  it('reuses the daily store pass when switching employees and expires it at Beijing midnight', async () => {
    let now = Date.parse('2026-07-17T10:00:00.000Z')
    const app = Fastify()
    await registerPilotAuthRoutes(app, repository(), { ...authOptions(), now: () => now })

    const verified = await app.inject({
      method: 'POST', url: '/api/auth/pilot-login', payload: { accessCode: 'store-pilot-code' },
    })
    expect(verified.statusCode).toBe(200)
    expect(verified.json()).toMatchObject({
      storeAccessToken: expect.any(String),
      storeAccessExpiresAt: Date.parse('2026-07-17T16:00:00.000Z'),
    })

    const switched = await app.inject({
      method: 'POST',
      url: '/api/auth/pilot-login',
      payload: {
        storeAccessToken: verified.json().storeAccessToken,
        actorId: 'emp-host',
        employeePin: employeePins['emp-host'],
      },
    })
    expect(switched.statusCode).toBe(200)
    expect(switched.json()).toMatchObject({ employee: { id: 'emp-host' } })

    now = Date.parse('2026-07-17T16:00:00.000Z')
    const nextDay = await app.inject({
      method: 'POST', url: '/api/auth/pilot-login', payload: { storeAccessToken: verified.json().storeAccessToken },
    })
    expect(nextDay.statusCode).toBe(401)
    expect(nextDay.json().code).toBe('STORE_ACCESS_PASS_INVALID')
    await app.close()
  })

  it('verifies the access code before listing active employees and signing a session', async () => {
    const app = Fastify()
    const secret = 's'.repeat(32)
    await registerPilotAuthRoutes(app, repository(), { ...authOptions(), sessionSecret: secret })

    const denied = await app.inject({ method: 'POST', url: '/api/auth/pilot-login', payload: { accessCode: 'wrong' } })
    expect(denied.statusCode).toBe(401)

    const listed = await app.inject({ method: 'POST', url: '/api/auth/pilot-login', payload: { accessCode: 'store-pilot-code' } })
    expect(listed.statusCode).toBe(200)
    const employees = listed.json().employees as Array<{ id: string }>
    expect(employees.length).toBeGreaterThan(1)

    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/auth/pilot-login',
      payload: { accessCode: 'store-pilot-code', actorId: employees[0]!.id, employeePin: employeePins[employees[0]!.id as keyof typeof employeePins] },
    })
    expect(loggedIn.statusCode).toBe(200)
    const body = loggedIn.json() as { token: string; sessionId: string; employee: { id: string }; expiresAt: number; presenceExpiresAt: number }
    expect(verifyStaffSession(body.token, secret)).toMatchObject({ sessionId: body.sessionId, actorId: body.employee.id, storeId: 'mbox-lujiazui' })
    expect(body.expiresAt - Date.now()).toBeGreaterThan(6 * 60 * 60_000 - 5_000)
    expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(6 * 60 * 60_000)
    expect(body.presenceExpiresAt).toBeLessThanOrEqual(body.expiresAt)
    await app.close()
  })

  it('creates a distinct signed session and presence lease for every device login', async () => {
    const app = Fastify()
    const runtimeRepository = repository()
    const secret = 's'.repeat(32)
    await registerPilotAuthRoutes(app, runtimeRepository, { ...authOptions(), sessionSecret: secret })
    const request = {
      method: 'POST' as const,
      url: '/api/auth/pilot-login',
      payload: { accessCode: 'store-pilot-code', actorId: 'emp-chen', employeePin: employeePins['emp-chen'] },
    }

    const first = (await app.inject(request)).json()
    const second = (await app.inject(request)).json()
    const state = await runtimeRepository.read()

    expect(first.sessionId).not.toBe(second.sessionId)
    expect(state.presenceLeases?.filter((lease) => lease.actorId === 'emp-chen').map((lease) => lease.sessionId))
      .toEqual(expect.arrayContaining([first.sessionId, second.sessionId]))
    expect(state.employees.find((employee) => employee.id === 'emp-chen')?.online).toBe(true)
    await app.close()
  })

  it('does not issue a token and compensates the aggregate when normalized lease persistence fails', async () => {
    const app = Fastify({ logger: false })
    const runtimeRepository = repository()
    const presenceLeaseStore = new MemoryPresenceLeaseStore()
    presenceLeaseStore.upsert = async () => { throw new Error('simulated normalized lease failure') }
    await registerPilotAuthRoutes(app, runtimeRepository, { ...authOptions(), presenceLeaseStore })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/pilot-login',
      payload: { accessCode: 'store-pilot-code', actorId: 'emp-chen', employeePin: employeePins['emp-chen'] },
    })

    expect(response.statusCode).toBe(500)
    expect(response.json()).not.toHaveProperty('token')
    const state = await runtimeRepository.read()
    expect(state.presenceLeases?.filter((lease) => lease.actorId === 'emp-chen')).toEqual([])
    expect(state.auditEntries.some((entry) => entry.action === 'staff_presence.ended.v1')).toBe(true)
    await app.close()
  })

  it('rejects an actor that is not in the active employee list', async () => {
    const app = Fastify()
    await registerPilotAuthRoutes(app, repository(), authOptions())
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/pilot-login',
      payload: { accessCode: 'store-pilot-code', actorId: 'missing-employee', employeePin: '9999' },
    })
    expect(response.statusCode).toBe(403)
    await app.close()
  })

  it('does not let one employee use the shared store code to impersonate another employee', async () => {
    const app = Fastify()
    await registerPilotAuthRoutes(app, repository(), authOptions())
    const denied = await app.inject({
      method: 'POST', url: '/api/auth/pilot-login',
      payload: { accessCode: 'store-pilot-code', actorId: 'emp-owner', employeePin: employeePins['emp-host'] },
    })
    expect(denied.statusCode).toBe(401)
    expect(denied.json().code).toBe('PILOT_EMPLOYEE_PIN_DENIED')
    await app.close()
  })

  it('verifies only the current employee PIN without issuing a new session', async () => {
    const app = Fastify()
    app.decorateRequest('mboxActor', null)
    app.addHook('preHandler', async (request) => {
      if (request.url === '/api/auth/verify-pin') {
        request.mboxActor = {
          actorId: 'emp-chen',
          storeId: 'mbox-lujiazui',
          roleId: 'manager',
          runtimeMode: 'test',
          authenticatedBy: 'local_header',
          sessionId: null,
          sessionExpiresAt: null,
        }
      }
    })
    await registerPilotAuthRoutes(app, repository(), authOptions())

    const denied = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-pin',
      payload: { employeePin: employeePins['emp-lin'] },
    })
    expect(denied.statusCode).toBe(401)
    expect(denied.json()).toMatchObject({
      code: 'PILOT_EMPLOYEE_PIN_DENIED',
      message: '员工PIN错误，请输入当前登录员工的PIN',
    })

    const verified = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-pin',
      payload: { employeePin: employeePins['emp-chen'] },
    })
    expect(verified.statusCode).toBe(200)
    expect(verified.json()).toEqual({ verified: true, actorId: 'emp-chen' })
    expect(verified.json()).not.toHaveProperty('token')
    await app.close()
  })

  it('allows five failures, blocks the sixth, expires the window, and clears failures after success', async () => {
    let limiterNow = Date.parse('2030-07-14T10:00:00.000Z')
    const app = Fastify()
    await registerPilotAuthRoutes(app, repository(), authOptions(rateLimitStore(() => limiterNow)))

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const denied = await app.inject({ method: 'POST', url: '/api/auth/pilot-login', payload: { accessCode: 'wrong' } })
      expect(denied.statusCode).toBe(401)
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/pilot-login', payload: { accessCode: 'wrong' } })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().code).toBe('PILOT_LOGIN_RATE_LIMITED')

    limiterNow += 15 * 60_000
    const expired = await app.inject({ method: 'POST', url: '/api/auth/pilot-login', payload: { accessCode: 'wrong' } })
    expect(expired.statusCode).toBe(401)
    const successful = await app.inject({
      method: 'POST', url: '/api/auth/pilot-login',
      payload: { accessCode: 'store-pilot-code', actorId: 'emp-chen', employeePin: employeePins['emp-chen'] },
    })
    expect(successful.statusCode).toBe(200)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const denied = await app.inject({ method: 'POST', url: '/api/auth/pilot-login', payload: { accessCode: 'wrong' } })
      expect(denied.statusCode).toBe(401)
    }
    const blockedAgain = await app.inject({ method: 'POST', url: '/api/auth/pilot-login', payload: { accessCode: 'wrong' } })
    expect(blockedAgain.statusCode).toBe(429)
    await app.close()
  })
})
