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

describe('pilot employee auth', () => {
  it('verifies the access code before listing active employees and signing a session', async () => {
    const app = Fastify()
    const secret = 's'.repeat(32)
    await registerPilotAuthRoutes(app, repository(), {
      accessCode: 'store-pilot-code',
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
      payload: { accessCode: 'store-pilot-code', actorId: employees[0]!.id },
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
      sessionSecret: 's'.repeat(32),
      sessionHours: 12,
    })
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/pilot-login',
      payload: { accessCode: 'store-pilot-code', actorId: 'missing-employee' },
    })
    expect(response.statusCode).toBe(403)
    await app.close()
  })
})
