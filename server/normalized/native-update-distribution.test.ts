import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerNativeUpdateDistribution } from './native-update-distribution.js'

let root: string, app: FastifyInstance
const bytes = Buffer.from('actual local apk artifact bytes\u0000\u0001')
const sha = createHash('sha256').update(bytes).digest('hex')
const filename = `MBOX-Staff-0.4.0-rc.3-build8-${sha.slice(0, 12)}.apk`
const feed = { schemaVersion: 1, channel: 'stable', releases: [{ platform: 'android', build: 8, sha256: sha }] }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mbox-native-distribution-')))
  await writeFile(join(root, filename), bytes)
  await writeFile(join(root, 'stable.json'), JSON.stringify(feed))
  app = Fastify()
  registerNativeUpdateDistribution(app, root)
  app.setNotFoundHandler((_request, reply) => reply.type('text/html').send('<html>SPA fallback</html>'))
  await app.ready()
})
afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })

describe('native update public distribution', () => {
  it('serves actual file bytes over HTTP with APK MIME, immutable caching and exact length', async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const result = await fetch(`${address}/native-updates/staff/${filename}`)
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toBe('application/vnd.android.package-archive')
    expect(result.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(result.headers.get('content-length')).toBe(String(bytes.length))
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes)
    const head = await fetch(`${address}/native-updates/staff/${filename}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(bytes.length))
    expect(await head.text()).toBe('')
  })

  it('serves only matching stable or preview JSON and always bypasses cache', async () => {
    const stable = await app.inject('/native-updates/staff/stable.json')
    expect(stable.statusCode).toBe(200)
    expect(stable.json()).toEqual(feed)
    expect(stable.headers['cache-control']).toBe('no-store')
    expect(stable.headers['content-type']).toBe('application/json; charset=utf-8')
    await writeFile(join(root, 'preview.json'), JSON.stringify({ ...feed, channel: 'preview' }))
    const preview = await app.inject({ method: 'HEAD', url: '/native-updates/staff/preview.json' })
    expect(preview.statusCode).toBe(200)
    expect(preview.body).toBe('')
    expect(preview.headers['cache-control']).toBe('no-store')
    await writeFile(join(root, 'stable.json'), JSON.stringify({ ...feed, channel: 'preview' }))
    expect((await app.inject('/native-updates/staff/stable.json')).statusCode).toBe(404)
  })

  it('rejects missing, arbitrary and traversal filenames without falling into HTML', async () => {
    await writeFile(join(root, 'credentials.json'), 'private-not-a-public-artifact')
    for (const name of ['', '/', '/missing.apk', '/credentials.json', '/release.json', '/nested/stable.json', '/%2e%2e%2fcredentials.json', '/MBOX-Staff-..-build8-aaaaaaaaaaaa.apk']) {
      const result = await app.inject({ url: `/native-updates/staff${name}`, headers: { accept: 'text/html' } })
      expect(result.statusCode, name).toBe(404)
      expect(result.headers['cache-control'], name).toBe('no-store')
      expect(result.body, name).not.toContain('SPA fallback')
      expect(result.body, name).not.toContain('private-not-a-public-artifact')
    }
  })

  it('rejects symlinks, invalid JSON, oversize manifests and directories', async () => {
    await rm(join(root, filename))
    await symlink(join(root, 'stable.json'), join(root, filename))
    expect((await app.inject(`/native-updates/staff/${filename}`)).statusCode).toBe(404)
    await writeFile(join(root, 'stable.json'), '{')
    expect((await app.inject('/native-updates/staff/stable.json')).statusCode).toBe(404)
    await writeFile(join(root, 'stable.json'), ' '.repeat(65_537))
    expect((await app.inject('/native-updates/staff/stable.json')).statusCode).toBe(404)
  })

  it('cannot write or change the directory through its public routes', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const result = await app.inject({ method, url: '/native-updates/staff/stable.json', payload: { overwrite: true } })
      expect(result.statusCode).toBe(405)
    }
    expect(JSON.parse(await readFile(join(root, 'stable.json'), 'utf8'))).toEqual(feed)
  })

  it('keeps the path reserved and 404 when native distribution is not configured', async () => {
    const disabled = Fastify()
    registerNativeUpdateDistribution(disabled, null)
    disabled.setNotFoundHandler((_request, reply) => reply.type('text/html').send('SPA'))
    const result = await disabled.inject('/native-updates/staff/stable.json')
    expect(result.statusCode).toBe(404)
    expect(result.body).not.toContain('SPA')
    await disabled.close()
  })
})
