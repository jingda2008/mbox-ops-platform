import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import { registerPilotAuthRoutes } from './pilot-auth.js'
import { verifyStaffSession } from './auth-context.js'
import type { RuntimeRepository } from './repository.js'
import { MemoryRateLimitStore, type RateLimitStore } from './rate-limit.js'

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
  'emp-owner': '100001', 'emp-admin': '100002', 'emp-lin': '100003', 'emp-jie': '100004',
  'emp-wu': '100005', 'emp-qing': '100006', 'emp-han': '100007', 'emp-tao': '100008',
  'emp-mia': '100009', 'emp-chen': '100010', 'emp-cashier': '100011', 'emp-host': '100012',
}

function rateLimitStore(now: () => number = Date.now) {
  return new MemoryRateLimitStore({
    usage: 'test', tenantId: 'tenant-test', storeId: 'mbox-lujiazui', hashSecret: 'l'.repeat(32), now,
  })
}

function authOptions(store: RateLimitStore = rateLimitStore()) {
  return {
    accessCode: 'store-pilot-code', employeePins, sessionSecret: 's'.repeat(32), sessionHours: 12, rateLimitStore: store,
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
    expect(body.expiresAt).toBeGreaterThan(Date.now())
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

  it('rejects an actor that is not in the active employee list', async () => {
    const app = Fastify()
    await registerPilotAuthRoutes(app, repository(), authOptions())
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/pilot-login',
      payload: { accessCode: 'store-pilot-code', actorId: 'missing-employee', employeePin: '100099' },
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

    limiterNow += 10 * 60_000
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
