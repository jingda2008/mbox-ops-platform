import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerObservability } from './observability.js'

describe('observability', () => {
  it('reports liveness, readiness and security headers', async () => {
    const app = Fastify()
    await registerObservability(app, { runtimeMode: 'test', readiness: async () => ({ ready: true, details: { repository: 'ok' } }) })
    const response = await app.inject({ method: 'GET', url: '/api/ready' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'ready', repository: 'ok' })
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    await app.close()
  })

  it('protects metrics outside local and test', async () => {
    const app = Fastify()
    await registerObservability(app, {
      runtimeMode: 'production',
      metricsToken: 'm'.repeat(32),
      readiness: async () => ({ ready: false }),
    })
    expect((await app.inject({ method: 'GET', url: '/api/metrics' })).statusCode).toBe(401)
    const response = await app.inject({ method: 'GET', url: '/api/metrics', headers: { authorization: `Bearer ${'m'.repeat(32)}` } })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('mbox_api_requests_total')
    expect((await app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(503)
    await app.close()
  })
})
