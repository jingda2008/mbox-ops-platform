import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect(response.headers['permissions-policy']).toBe('camera=(self), microphone=(self), geolocation=()')
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

  it('keeps API and HTML responses out of shared caches without overriding route policy', async () => {
    const app = Fastify()
    await registerObservability(app, { runtimeMode: 'test', readiness: async () => ({ ready: true }) })
    app.get('/', async (_request, reply) => reply.type('text/html').send('<main>M-BOX</main>'))
    app.get('/api/private-view', async (_request, reply) => reply.header('cache-control', 'private, no-cache').send({ ok: true }))
    app.post('/brand/update', async () => ({ ok: true }))

    expect((await app.inject({ method: 'GET', url: '/' })).headers['cache-control']).toBe('no-cache')
    expect((await app.inject({ method: 'GET', url: '/api/ready' })).headers['cache-control']).toBe('no-store')
    expect((await app.inject({ method: 'GET', url: '/api/private-view' })).headers['cache-control']).toBe('private, no-cache')
    expect((await app.inject({ method: 'POST', url: '/brand/update' })).headers['cache-control']).toBe('no-store')
    await app.close()
  })

  it('assigns immutable caching only to fingerprinted build assets', async () => {
    const app = Fastify()
    await registerObservability(app, { runtimeMode: 'test', readiness: async () => ({ ready: true }) })
    app.get('/assets/index-Cpns5OkI.js', async (_request, reply) => reply.type('application/javascript').send('export {}'))
    app.get('/assets/mbox-floorplan.png', async (_request, reply) => reply.type('image/png').send('image'))
    app.get('/menu/cocktail.jpg', async (_request, reply) => reply.type('image/jpeg').send('image'))
    app.get('/brand/moods-v2/happy.png', async (_request, reply) => reply.type('image/png').send('image'))
    app.get('/icons/app-icon-192.png', async (_request, reply) => reply.type('image/png').send('image'))
    app.get('/sw.js', async (_request, reply) => reply.type('application/javascript').send(''))

    expect((await app.inject('/assets/index-Cpns5OkI.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable')
    for (const path of ['/assets/mbox-floorplan.png', '/menu/cocktail.jpg', '/brand/moods-v2/happy.png', '/icons/app-icon-192.png']) {
      expect((await app.inject(path)).headers['cache-control']).toBe('public, max-age=3600, stale-while-revalidate=86400')
    }
    expect((await app.inject('/sw.js')).headers['cache-control']).toBe('no-cache')
    await app.close()
  })

  it('sets production static policy before fastify-static defaults and still permits route overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mbox-static-cache-'))
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'assets', 'index-Cpns5OkI.js'), 'export {}')
    await writeFile(join(root, 'index.html'), '<main>M-BOX</main>')
    const app = Fastify()
    try {
      await app.register(fastifyStatic, { root, prefix: '/', wildcard: false })
      app.get('/explicit-before', async (_request, reply) => reply.header('cache-control', 'public, max-age=300').send('owned'))
      await registerObservability(app, { runtimeMode: 'test', readiness: async () => ({ ready: true }) })
      app.get('/explicit-after', async (_request, reply) => reply.header('cache-control', 'public, max-age=17').send('owned'))

      expect((await app.inject('/assets/index-Cpns5OkI.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect((await app.inject('/')).headers['cache-control']).toBe('no-cache')
      expect((await app.inject('/explicit-before')).headers['cache-control']).toBe('public, max-age=300')
      expect((await app.inject('/explicit-after')).headers['cache-control']).toBe('public, max-age=17')
    } finally {
      await app.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
