import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { FastifyPluginAsync } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import {
  NORMALIZED_LOG_REDACTION_PATHS,
  NORMALIZED_MIN_SCHEMA_VERSION,
  createNormalizedApp,
  type NormalizedLifecycleController,
} from './normalized-app.js'
import {
  NORMALIZED_SCHEMA_FLAVOR,
  NormalizedRuntimeConfigurationError,
  type NormalizedRuntimeConfig,
} from './normalized-runtime-config.js'
import { DEVICE_ACCESS_COOKIE } from './normalized-request-context.js'
import type {
  PostgresPool,
  PostgresPoolClient,
  PostgresQueryResult,
} from './transaction-runner.js'

const config: NormalizedRuntimeConfig = {
  nodeEnv: 'test',
  deploymentTier: 'validation',
  databaseUrl: 'postgresql://unused/normalized',
  tenantId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
  secret: '0123456789abcdef0123456789abcdef',
  metricsToken: 'normalized-metrics-token-0123456789abcdef',
  payment: null,
  wechatIdentity: null,
  guestPaymentMode: 'simulation',
  inventoryEnforcementMode: 'audit_only',
  guestOrderSafetyPolicy: {
    duplicateWindowSeconds: 45,
    maxOrdersPerCustomerPerMinute: 5,
    maxOrdersPerTablePerMinute: 20,
  },
  commitSha: 'abcdef1234567890',
  releaseImageDigest: null,
  schemaFlavor: NORMALIZED_SCHEMA_FLAVOR,
  host: '127.0.0.1',
  port: 3_000,
  poolMax: 4,
  workerPoolMax: 2,
  trustProxyHops: 0,
  staticDir: null,
  startWorkers: false,
}

describe('createNormalizedApp', () => {
  it('redacts contact plaintext and one-use phone authorization codes from defensive logs', () => {
    expect(NORMALIZED_LOG_REDACTION_PATHS).toEqual(expect.arrayContaining([
      'body.contactValue', 'body.phoneAuthorizationCode',
    ]))
  })

  it('uses only the configured direct reverse-proxy hop to resolve the customer IP', async () => {
    const clientIpProbe: FastifyPluginAsync<Record<string, unknown>> = async (app) => {
      app.get('/client-ip', async (request) => ({ clientIp: request.ip }))
    }
    const direct = await createNormalizedApp({
      config: { ...config, trustProxyHops: 0 }, pool: fakePool(), logger: false,
      injectedPlugins: [{ name: 'direct-ip-probe', plugin: clientIpProbe, prefix: '/api' }],
    })
    const proxied = await createNormalizedApp({
      config: { ...config, trustProxyHops: 1 }, pool: fakePool(), logger: false,
      injectedPlugins: [{ name: 'proxied-ip-probe', plugin: clientIpProbe, prefix: '/api' }],
    })

    const forged = await direct.app.inject({
      method: 'GET', url: '/api/client-ip', headers: { 'x-forwarded-for': '203.0.113.42' },
    })
    const forwarded = await proxied.app.inject({
      method: 'GET', url: '/api/client-ip', headers: { 'x-forwarded-for': '203.0.113.42' },
    })

    expect(forged.json().clientIp).not.toBe('203.0.113.42')
    expect(forwarded.json()).toEqual({ clientIp: '203.0.113.42' })
    await Promise.all([direct.app.close(), proxied.app.close()])
  })

  it('keeps a contract migration candidate read-only and visibly non-writable',async()=>{
    const mutation:FastifyPluginAsync<Record<string,unknown>>=async(app)=>{
      app.post('/mutation',async()=>({ written:true }))
    }
    const runtime=await createNormalizedApp({
      config:{ ...config,runtimeRole:'contract_candidate' },pool:fakePool(),logger:false,
      injectedPlugins:[{ name:'candidate-mutation-probe',plugin:mutation,prefix:'/api' }],
    })
    const blocked=await runtime.app.inject({ method:'POST',url:'/api/mutation' })
    expect(blocked.statusCode).toBe(503)
    expect(blocked.json()).toEqual({ error:{
      code:'CONTRACT_CANDIDATE_READ_ONLY',message:'系统正在完成安全升级，暂不接受写入操作。',
    } })
    const live=await runtime.app.inject({ method:'GET',url:'/api/live' })
    expect(live.json()).toMatchObject({ runtimeRole:'contract_candidate',writeEnabled:false })
    await runtime.app.close()
  })

  it('subscribes to idle database client errors so they cannot crash the service', async () => {
    let listener: ((error: unknown) => void) | undefined
    const pool: InspectablePool = {
      ...fakePool(),
      on: vi.fn((_event: 'error', nextListener: (error: unknown) => void) => {
        listener = nextListener
      }),
    }
    const runtime = await createNormalizedApp({ config, pool, logger: false })

    expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(() => listener?.(Object.assign(new Error('connection terminated'), { code: '57P01' }))).not.toThrow()
    await runtime.app.close()
  })

  it('registers the normalized system and domain routes without legacy dependencies', async () => {
    const pool = fakePool()
    const extension: FastifyPluginAsync<Record<string, unknown>> = async (app) => {
      app.get('/probe', async () => ({ ok: true }))
    }
    const runtime = await createNormalizedApp({
      config,
      pool,
      logger: false,
      injectedPlugins: [{ name: 'customer-table-side', plugin: extension, prefix: '/api/extensions' }],
    })
    const routes = [
      ['GET', '/api/live'],
      ['GET', '/api/ready'],
      ['GET', '/api/version'],
      ['GET', '/api/metrics'],
      ['GET', '/api/operations'],
      ['GET', '/api/staff/workspace'],
      ['GET', '/api/catalog/products'],
      ['POST', '/api/commerce/orders'],
      ['POST', '/api/payments'],
      ['POST', '/api/guest/reservations'],
      ['GET', '/api/guest/menu/products'],
      ['GET', '/api/inventory'],
      ['GET', '/api/table-management/tables'],
      ['GET', '/api/notifications'],
      ['GET', '/api/ai/capabilities'],
      ['GET', '/api/hardware/devices'],
      ['POST', '/api/public/reservation/session'],
      ['GET', '/api/public/reservation/availability'],
      ['GET', '/api/public/mini/menu/products'],
      ['POST', '/api/public/reservations'],
      ['GET', '/api/staff/reservation-intake'],
      ['GET', '/api/extensions/probe'],
    ] as const
    for (const [method, url] of routes) {
      expect(runtime.app.hasRoute({ method, url }), `${method} ${url}`).toBe(true)
    }

    const live = await runtime.app.inject({ method: 'GET', url: '/api/live' })
    expect(live.statusCode).toBe(200)
    expect(live.json()).toEqual({
      status: 'live',
      commitSha: config.commitSha,
      releaseImageDigest: null,
      schemaFlavor: NORMALIZED_SCHEMA_FLAVOR,
      deploymentTier: 'validation',
      inventoryEnforcementMode: 'audit_only',
      runtimeRole:'normal',
      writeEnabled:true,
    })
    const version = await runtime.app.inject({ method: 'GET', url: '/api/version' })
    expect(version.statusCode).toBe(200)
    expect(version.json()).toEqual({
      commitSha: config.commitSha,
      releaseImageDigest: null,
      schemaFlavor: NORMALIZED_SCHEMA_FLAVOR,
      deploymentTier: 'validation',
      inventoryEnforcementMode: 'audit_only',
      runtimeRole:'normal',
      writeEnabled:true,
    })
    await runtime.app.close()

    const source = await readFile(new URL('./normalized-app.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/RuntimeState|runtime_states|RuntimeRepository|repository\.mutate|mutationTail/)
  })

  it('registers formal WeChat challenge and code authentication routes only when identity is configured', async () => {
    const disabled = await createNormalizedApp({ config, pool: fakePool(), logger: false })
    expect(disabled.app.hasRoute({ method: 'POST', url: '/api/wechat/challenges' })).toBe(false)
    await disabled.app.close()

    const enabled = await createNormalizedApp({
      config: {
        ...config,
        wechatIdentity: {
          appId: 'wxformalidentity',
          appSecret: 'wechat-app-secret-for-test-only',
          stateSecret: 'wechat-state-secret-for-test-only-1234567890',
          encryptionKeyVersion: 1,
          encryptionKey: Buffer.alloc(32, 7),
        },
      },
      pool: fakePool(),
      logger: false,
    })
    expect(enabled.app.hasRoute({ method: 'POST', url: '/api/wechat/challenges' })).toBe(true)
    expect(enabled.app.hasRoute({ method: 'POST', url: '/api/wechat/code-authentication' })).toBe(true)
    expect(enabled.app.hasRoute({ method: 'POST', url: '/api/wechat/logout' })).toBe(true)
    await enabled.app.close()
  })

  it('checks the database schema and trusted store before reporting ready', async () => {
    const pool = fakePool({
      ready: { schema_flavor: NORMALIZED_SCHEMA_FLAVOR, schema_version: NORMALIZED_MIN_SCHEMA_VERSION, store_active: true },
    })
    const runtime = await createNormalizedApp({ config, pool, logger: false })
    const response = await runtime.app.inject({ method: 'GET', url: '/api/ready' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      status: 'ready',
      schemaVersion: NORMALIZED_MIN_SCHEMA_VERSION,
      commitSha: config.commitSha,
      releaseImageDigest: null,
      schemaFlavor: NORMALIZED_SCHEMA_FLAVOR,
      deploymentTier: 'validation',
      inventoryEnforcementMode: 'audit_only',
      runtimeRole:'normal',
      writeEnabled:true,
    })
    expect(pool.queries.some((query) => query.includes('normalized_schema_metadata'))).toBe(true)
    expect(pool.queries).toHaveLength(2)
    expect(pool.queries.every((query)=>query.includes("set_config('app.tenant_id'")
      && query.includes("set_config('app.store_id'"))).toBe(true)
    const keyProbe=pool.queries.find((query)=>query.includes('oldest_rank'))
    expect(keyProbe).toContain('newest_rank')
    await runtime.app.inject({method:'GET',url:'/api/ready'})
    expect(pool.queries.filter((query)=>query.includes('oldest_rank'))).toHaveLength(1)
    await runtime.app.close()
  })

  it('uses one request-time database round trip after the startup key probe is cached', async () => {
    const pool = fakePool({ queryDelayMs: 1_200 })
    const runtime = await createNormalizedApp({ config, pool, logger: false })
    const startedAt = performance.now()
    const response = await runtime.app.inject({ method: 'GET', url: '/api/ready' })
    const elapsedMs = performance.now() - startedAt

    expect(response.statusCode).toBe(200)
    expect(pool.queries).toHaveLength(2)
    expect(elapsedMs).toBeGreaterThanOrEqual(1_100)
    expect(elapsedMs).toBeLessThan(3_000)
    await runtime.app.close()
  })

  it('sets application security headers and protects normalized metrics with a bearer token', async () => {
    const runtime = await createNormalizedApp({ config, pool: fakePool(), logger: false })
    const live = await runtime.app.inject({ method: 'GET', url: '/api/live' })
    expect(live.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'cross-origin-embedder-policy': 'credentialless',
      'cross-origin-opener-policy': 'same-origin-allow-popups',
      'cross-origin-resource-policy': 'same-site',
    })
    expect(live.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(live.headers['permissions-policy']).toContain('microphone=(self)')
    expect(live.headers['strict-transport-security']).toBeUndefined()

    const rejected = await runtime.app.inject({ method: 'GET', url: '/api/metrics' })
    expect(rejected.statusCode).toBe(401)
    expect(rejected.body).not.toContain(config.metricsToken ?? '')

    const accepted = await runtime.app.inject({
      method: 'GET',
      url: '/api/metrics',
      headers: { authorization: `Bearer ${config.metricsToken}` },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.headers['content-type']).toContain('text/plain')
    expect(accepted.body).toContain('mbox_runtime_info{')
    expect(accepted.body).toContain('deployment_tier="validation"')
    expect(accepted.body).toContain('mbox_database_pool_acquisitions_total{outcome="success"}')
    expect(accepted.body).not.toContain(config.metricsToken ?? '')
    await runtime.app.close()
  })

  it('adds HSTS when the optimized runtime is used in the controlled validation tier', async () => {
    const runtime = await createNormalizedApp({
      config: { ...config, nodeEnv: 'production' },
      pool: fakePool(),
      logger: false,
    })
    const response = await runtime.app.inject({ method: 'GET', url: '/api/live' })
    expect(response.headers['strict-transport-security']).toContain('max-age=31536000')
    await runtime.app.close()
  })

  it('does not report ready until configured workers have completed a healthy cycle', async () => {
    const pool = fakePool({
      ready: { schema_flavor: NORMALIZED_SCHEMA_FLAVOR, schema_version: NORMALIZED_MIN_SCHEMA_VERSION, store_active: true },
    })
    const workerHealth = {
      snapshot: vi.fn(() => ({
        status: 'starting' as const,
        lastCompletedAt: null,
        failures: [] as string[],
        integrationWorkersEnabled: false,
        adapterCapabilities: [] as string[],
      })),
    }
    const runtime = await createNormalizedApp({ config, pool, logger: false, workerHealth })
    const starting = await runtime.app.inject({ method: 'GET', url: '/api/ready' })
    expect(starting.statusCode).toBe(503)
    expect(starting.json()).toMatchObject({ status: 'not_ready', reason: 'workers_unavailable' })

    workerHealth.snapshot.mockReturnValue({
      status: 'healthy',
      lastCompletedAt: '2026-08-12T00:00:01.000Z',
      failures: [],
      integrationWorkersEnabled: false,
      adapterCapabilities: [],
    })
    const healthy = await runtime.app.inject({ method: 'GET', url: '/api/ready' })
    expect(healthy.statusCode).toBe(200)
    expect(healthy.json()).toMatchObject({
      status: 'ready',
      workers: { status: 'healthy', integrationWorkersEnabled: false },
    })
    await runtime.app.close()
  })

  it('does not report ready when normalized migrations are older than registered plugins', async () => {
    expect(NORMALIZED_MIN_SCHEMA_VERSION).toBe('114')
    const pool = fakePool({
      ready: { schema_flavor: NORMALIZED_SCHEMA_FLAVOR, schema_version: '096', store_active: true },
    })
    const runtime = await createNormalizedApp({ config, pool, logger: false })
    const response = await runtime.app.inject({ method: 'GET', url: '/api/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ status: 'not_ready', reason: 'normalized_schema_outdated' })
    await runtime.app.close()
  })

  it('returns a stable 503 without leaking database failures', async () => {
    const pool = fakePool({ failure: new Error('password=do-not-leak host=private-db') })
    const runtime = await createNormalizedApp({ config, pool, logger: false })
    const response = await runtime.app.inject({ method: 'GET', url: '/api/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ status: 'not_ready', reason: 'database_unavailable' })
    expect(response.body).not.toContain('do-not-leak')
    expect(response.body).not.toContain('private-db')
    await runtime.app.close()
  })

  it('returns DEVICE_ACCESS_REQUIRED when staff login has no device lease', async () => {
    const runtime = await createNormalizedApp({ config, pool: fakePool(), logger: false })
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { employeeCode: 'LIYAN', pin: '1234' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: {
        code: 'DEVICE_ACCESS_REQUIRED',
        message: '当前设备尚未完成门店验证，或验证已失效，请重新验证',
      },
    })
    expect(response.body).not.toContain('lease')
    expect(response.body).not.toContain('credential')
    await runtime.app.close()
  })

  it('returns DEVICE_ACCESS_REQUIRED for an expired or unknown device lease', async () => {
    const runtime = await createNormalizedApp({
      config,
      pool: fakePool({ deviceLeaseValid: false }),
      logger: false,
    })
    const opaqueLease = 'invalid-device-lease-token'.padEnd(43, 'x')
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie: `${DEVICE_ACCESS_COOKIE}=${opaqueLease}` },
      payload: { employeeCode: 'LIYAN', pin: '1234' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('DEVICE_ACCESS_REQUIRED')
    expect(response.body).not.toContain(opaqueLease)
    await runtime.app.close()
  })

  it('keeps invalid employee identity or PIN generic when the device lease is valid', async () => {
    const runtime = await createNormalizedApp({
      config,
      pool: fakePool({ deviceLeaseValid: true }),
      logger: false,
    })
    const opaqueLease = 'valid-device-lease-token'.padEnd(43, 'v')
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie: `${DEVICE_ACCESS_COOKIE}=${opaqueLease}` },
      payload: { employeeCode: 'UNKNOWN', pin: '9999' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: { code: 'AUTH_REQUIRED', message: '登录信息无效或已过期，请重新登录' },
    })
    expect(response.body).not.toContain('UNKNOWN')
    expect(response.body).not.toContain('9999')
    await runtime.app.close()
  })

  it('starts explicitly configured controllers and stops them before closing the pool', async () => {
    const events: string[] = []
    const pool = fakePool({ events })
    const controller: NormalizedLifecycleController = {
      start: vi.fn(() => { events.push('worker:start') }),
      stop: vi.fn(() => { events.push('worker:stop') }),
    }
    const runtime = await createNormalizedApp({
      config: { ...config, startWorkers: true },
      pool,
      logger: false,
      lifecycleControllers: [controller],
    })
    expect(controller.start).toHaveBeenCalledOnce()
    await runtime.app.close()
    expect(controller.stop).toHaveBeenCalledOnce()
    expect(events).toEqual(['worker:start', 'worker:stop', 'pool:end'])
  })

  it('fails closed when workers are enabled without an execution adapter', async () => {
    await expect(createNormalizedApp({
      config: { ...config, startWorkers: true },
      pool: fakePool(),
      logger: false,
    })).rejects.toBeInstanceOf(NormalizedRuntimeConfigurationError)
  })

  it('cleans up a partially started worker set when a later controller fails', async () => {
    const events: string[] = []
    const pool = fakePool({ events })
    const first: NormalizedLifecycleController = {
      start: () => { events.push('first:start') },
      stop: () => { events.push('first:stop') },
    }
    const second: NormalizedLifecycleController = {
      start: () => { throw new Error('worker startup failed') },
      stop: () => { events.push('second:stop') },
    }
    await expect(createNormalizedApp({
      config: { ...config, startWorkers: true },
      pool,
      logger: false,
      lifecycleControllers: [first, second],
    })).rejects.toThrow('worker startup failed')
    expect(events).toEqual(['first:start', 'first:stop', 'pool:end'])
  })

  it('keeps the independent server and package scripts off the legacy entrypoint', async () => {
    const serverSource = await readFile(new URL('../normalized-server.ts', import.meta.url), 'utf8')
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    const normalizedTsconfig = JSON.parse(
      await readFile(new URL('../../tsconfig.normalized-server.json', import.meta.url), 'utf8'),
    ) as { compilerOptions: { outDir: string }; files: string[] }
    expect(serverSource).toContain("./normalized/normalized-app.js")
    expect(serverSource).not.toMatch(/server\/index|RuntimeState|RuntimeRepository/)
    expect(packageJson.scripts.dev).toContain('npm:dev:api')
    expect(packageJson.scripts['dev:api']).toBe('tsx watch server/normalized-server.ts')
    expect(packageJson.scripts['dev:normalized']).toBe('tsx watch server/normalized-server.ts')
    expect(packageJson.scripts['dev:api:legacy']).toBeUndefined()
    expect(packageJson.scripts.build).toBe('npm run build:normalized')
    expect(packageJson.scripts['build:normalized']).toContain('tsconfig.normalized-server.json')
    expect(packageJson.scripts['build:normalized']).not.toContain('tsconfig.server.json')
    expect(normalizedTsconfig.files).toContain('server/normalized-server.ts')
    expect(normalizedTsconfig.compilerOptions.outDir).toBe('dist-normalized')
    expect(packageJson.scripts['start:normalized']).toBe('node dist-normalized/server/normalized-server.js')
    expect(packageJson.scripts.start).toBe('node dist-normalized/server/normalized-server.js')
    expect(packageJson.scripts['start:legacy']).toBeUndefined()
    expect(Object.values(packageJson.scripts).join('\n')).not.toContain('server/index.ts')
    expect(Object.values(packageJson.scripts).join('\n')).not.toContain('dist-server/server/index.js')
  })

  it('serves direct SPA routes from the normalized image without hiding unknown APIs', async () => {
    const staticDir = await mkdtemp(resolve(tmpdir(), 'mbox-normalized-static-'))
    await writeFile(resolve(staticDir, 'index.html'), '<!doctype html><title>normalized shell</title>')
    await mkdir(resolve(staticDir, 'menu', 'items'), { recursive: true })
    await writeFile(resolve(staticDir, 'menu', 'items', 'public.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const runtime = await createNormalizedApp({
      config: { ...config, staticDir },
      pool: fakePool(),
      logger: false,
    })
    try {
      for (const url of ['/guest?table=W01', '/reserve', '/member', '/mini-preview', '/staff/live']) {
        const response = await runtime.app.inject({
          method: 'GET', url, headers: { accept: 'text/html' },
        })
        expect(response.statusCode, url).toBe(200)
        expect(response.body).toContain('normalized shell')
        expect(response.headers['cache-control']).toBe('no-store')
      }
      const api = await runtime.app.inject({
        method: 'GET', url: '/api/does-not-exist', headers: { accept: 'text/html' },
      })
      expect(api.statusCode).toBe(404)
      expect(api.json()).toEqual({
        error: { code: 'ROUTE_NOT_FOUND', message: '请求的页面或接口不存在' },
      })

      const menuImage = await runtime.app.inject({
        method: 'GET', url: '/menu/items/public.jpg?revision=1',
      })
      expect(menuImage.statusCode).toBe(200)
      expect(menuImage.headers['content-type']).toBe('image/jpeg')
      expect(menuImage.headers['cross-origin-resource-policy']).toBe('cross-origin')

      const unpublishedPublicAsset = await runtime.app.inject({
        method: 'GET', url: '/api/public/media-assets/MA00000000000000000000000000000000',
      })
      expect(unpublishedPublicAsset.statusCode).toBe(404)
      expect(unpublishedPublicAsset.headers['cross-origin-resource-policy']).toBe('cross-origin')

      const staffAsset = await runtime.app.inject({
        method: 'GET', url: '/api/staff/media-assets/MA00000000000000000000000000000000',
      })
      expect(staffAsset.headers['cross-origin-resource-policy']).toBe('same-site')
    } finally {
      await runtime.app.close()
      await rm(staticDir, { recursive: true, force: true })
    }
  })
})

interface FakePoolOptions {
  ready?: { schema_flavor: string; schema_version: string; store_active: boolean }
  failure?: Error
  events?: string[]
  deviceLeaseValid?: boolean
  queryDelayMs?: number
}

type InspectablePool = PostgresPool & { queries: string[] }

function fakePool(options: FakePoolOptions = {}): InspectablePool {
  const queries: string[] = []
  const client: PostgresPoolClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
    ): Promise<PostgresQueryResult<Row>> {
      queries.push(text)
      if (options.queryDelayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, options.queryDelayMs))
      if (text.includes('normalized_schema_metadata')) {
        if (options.failure) throw options.failure
        const ready = options.ready ?? {
          schema_flavor: NORMALIZED_SCHEMA_FLAVOR,
          schema_version: NORMALIZED_MIN_SCHEMA_VERSION,
          store_active: true,
        }
        return { rows: [ready as Row], rowCount: 1 }
      }
      if (text.includes('UPDATE mbox.store_device_access_leases AS dl')) {
        if (options.deviceLeaseValid !== true) return { rows: [], rowCount: 0 }
        return {
          rows: [{
            id: '55555555-5555-4555-8555-555555555555',
            business_date: '2026-08-11',
            device_key_hash: 'd'.repeat(64),
            expires_at: '2026-08-12T06:00:00.000Z',
          } as Row],
          rowCount: 1,
        }
      }
      if (text.includes('INSERT INTO mbox.staff_login_rate_limits')) {
        return {
          rows: [{ attempt_count: 1, expires_at: '2026-08-11T12:10:00.000Z' } as Row],
          rowCount: 1,
        }
      }
      if (text.includes('AS valid') && text.includes('store_device_access_leases')) {
        return { rows: [{ valid: options.deviceLeaseValid === true } as Row], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    release: vi.fn(),
  }
  return {
    queries,
    connect: vi.fn(async () => client),
    end: vi.fn(async () => { options.events?.push('pool:end') }),
  }
}
