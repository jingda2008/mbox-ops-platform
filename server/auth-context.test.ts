import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { AuthenticationError, registerAuthContext, signStaffSession, verifyStaffSession } from './auth-context.js'
import { createSeedState } from './seed.js'

const secret = 'mbox-test-session-secret-with-32-characters'
const now = Date.parse('2026-07-14T12:00:00.000Z')

describe('staff session', () => {
  it('signs and verifies bounded staff claims', () => {
    const token = signStaffSession({ sessionId: 'session-1', actorId: 'emp-chen', storeId: 'mbox-lujiazui', issuedAt: now, expiresAt: now + 60_000 }, secret)
    expect(verifyStaffSession(token, secret, now)).toMatchObject({ sessionId: 'session-1', actorId: 'emp-chen', storeId: 'mbox-lujiazui' })
  })

  it('rejects tampered and expired sessions', () => {
    const token = signStaffSession({ sessionId: 'session-2', actorId: 'emp-chen', storeId: 'mbox-lujiazui', issuedAt: now, expiresAt: now + 1_000 }, secret)
    expect(() => verifyStaffSession(`${token}x`, secret, now)).toThrow(AuthenticationError)
    expect(() => verifyStaffSession(token, secret, now + 2_000)).toThrow('员工会话已过期')
  })

  it('requires a production-grade signing secret', () => {
    expect(() => signStaffSession({ sessionId: 'session-3', actorId: 'a', storeId: 's', issuedAt: now, expiresAt: now + 1 }, 'short')).toThrow(
      '会话密钥至少需要32个字符',
    )
  })
})

describe('request authentication boundary', () => {
  it('requires local employee context for protected APIs but permits guest requests', async () => {
    const app = Fastify()
    await registerAuthContext(app, { runtimeMode: 'local', readState: async () => createSeedState() })
    app.get('/api/protected', async (request) => request.mboxActor)
    app.post('/api/guest/tasks', async () => ({ accepted: true }))
    app.get('/api/public/reservations', async () => ({ accepted: true }))
    app.put('/api/public/reservations/reservation-1', async () => ({ accepted: true }))
    app.delete('/api/public/reservations/reservation-1', async () => ({ accepted: true }))

    expect((await app.inject({ method: 'GET', url: '/api/protected' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/protected', headers: {
      'x-mbox-actor-id': 'emp-chen',
      'x-mbox-store-id': 'mbox-lujiazui',
    } })).json()).toMatchObject({ actorId: 'emp-chen', authenticatedBy: 'local_header', sessionId: null })
    expect((await app.inject({ method: 'POST', url: '/api/guest/tasks', payload: {} })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/public/reservations' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PUT', url: '/api/public/reservations/reservation-1' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'DELETE', url: '/api/public/reservations/reservation-1' })).statusCode).toBe(200)
    await app.close()
  })

  it.each(['staging', 'production'] as const)('requires signed sessions, disables dev routes and rejects actor impersonation in %s', async (runtimeMode) => {
    const app = Fastify()
    const state = createSeedState()
    const issuedAt = Date.now()
    const expiresAt = issuedAt + 60_000
    state.presenceLeases = [{
      sessionId: `session-${runtimeMode}`, actorId: 'emp-chen', storeId: state.store.id,
      businessDate: state.store.businessDate, establishedAt: issuedAt, lastSeenAt: issuedAt,
      expiresAt, sessionExpiresAt: expiresAt,
    }]
    await registerAuthContext(app, { runtimeMode, sessionSecret: secret, readState: async () => state })
    app.post('/api/protected', async (request) => request.mboxActor)
    app.get('/api/dev/member', async () => ({ unsafe: true }))
    const token = signStaffSession({ sessionId: `session-${runtimeMode}`, actorId: 'emp-chen', storeId: 'mbox-lujiazui', issuedAt, expiresAt }, secret)

    expect((await app.inject({ method: 'GET', url: '/api/dev/member' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/protected', headers: { authorization: `Bearer ${token}` }, payload: { actorId: 'emp-lin' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/protected', headers: { authorization: `Bearer ${token}` }, payload: { actorId: 'emp-chen' } })).statusCode).toBe(200)
    await app.close()
  })

  it('permits only the provider callback path without staff authentication', async () => {
    const app = Fastify()
    await registerAuthContext(app, { runtimeMode: 'production', sessionSecret: secret, readState: async () => createSeedState() })
    app.post('/api/payments/providers/postar/callback', async () => ({ accepted: true }))
    app.post('/api/payments/providers/postar/provider-query', async () => ({ unsafe: true }))

    expect((await app.inject({ method: 'POST', url: '/api/payments/providers/postar/callback' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/payments/providers/postar/provider-query' })).statusCode).toBe(401)
    await app.close()
  })

  it('rejects a signed token after its presence lease is removed', async () => {
    const app = Fastify()
    const state = createSeedState()
    const issuedAt = Date.now()
    const expiresAt = issuedAt + 60_000
    const token = signStaffSession({ sessionId: 'revoked-session', actorId: 'emp-chen', storeId: state.store.id, issuedAt, expiresAt }, secret)
    await registerAuthContext(app, { runtimeMode: 'production', sessionSecret: secret, readState: async () => state })
    app.get('/api/protected', async () => ({ unsafe: true }))

    const response = await app.inject({ method: 'GET', url: '/api/protected', headers: { authorization: `Bearer ${token}` } })
    expect(response.statusCode).toBe(401)
    expect(response.json().code).toBe('STAFF_SESSION_REVOKED')
    await app.close()
  })
})
