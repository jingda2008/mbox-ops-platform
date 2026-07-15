import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import { registerPilotAuthRoutes } from './pilot-auth.js'
import { verifyStaffSession } from './auth-context.js'
import type { RuntimeRepository } from './repository.js'

function repository(): RuntimeRepository {
  const state = createSeedState()
  return {
    init: async () => undefined,
    read: async () => structuredClone(state),
    mutate: async (mutation) => mutation(structuredClone(state)),
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

describe('pilot employee auth', () => {
  it('verifies the access code before listing active employees and signing a session', async () => {
    const app = Fastify()
    const secret = 's'.repeat(32)
    await registerPilotAuthRoutes(app, repository(), {
      accessCode: 'store-pilot-code',
      employeePins,
      sessionSecret: secret,
      sessionHours: 12,
    })

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
    const body = loggedIn.json() as { token: string; employee: { id: string }; expiresAt: number }
    expect(verifyStaffSession(body.token, secret)).toMatchObject({ actorId: body.employee.id, storeId: 'mbox-lujiazui' })
    expect(body.expiresAt).toBeGreaterThan(Date.now())
    await app.close()
  })

  it('rejects an actor that is not in the active employee list', async () => {
    const app = Fastify()
    await registerPilotAuthRoutes(app, repository(), {
      accessCode: 'store-pilot-code',
      employeePins,
      sessionSecret: 's'.repeat(32),
      sessionHours: 12,
    })
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
    await registerPilotAuthRoutes(app, repository(), {
      accessCode: 'store-pilot-code', employeePins,
      sessionSecret: 's'.repeat(32), sessionHours: 12,
    })
    const denied = await app.inject({
      method: 'POST', url: '/api/auth/pilot-login',
      payload: { accessCode: 'store-pilot-code', actorId: 'emp-owner', employeePin: employeePins['emp-host'] },
    })
    expect(denied.statusCode).toBe(401)
    expect(denied.json().code).toBe('PILOT_EMPLOYEE_PIN_DENIED')
    await app.close()
  })
})
