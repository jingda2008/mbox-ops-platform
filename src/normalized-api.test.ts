import { afterEach, describe, expect, it, vi } from 'vitest'
import { NormalizedApiClient, NormalizedApiError } from './normalized-api'
import type { StaffBootstrapResponse } from './shared/normalized-contracts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function bootstrap(): StaffBootstrapResponse {
  return {
    data: {
      schemaVersion: 1,
      generatedAt: '2026-08-11T12:00:00.000Z',
      watermark: '0123456789abcdef0123456789abcdef',
      store: {
        id: '22222222-2222-4222-8222-222222222222', code: 'lujiazui', name: 'M-BOX',
        timezone: 'Asia/Shanghai', businessDayCutoff: '06:00:00', currency: 'CNY',
      },
      businessDay: { date: '2026-08-11', status: 'open', openedAt: null, rolloverAt: null, closedAt: null },
      staff: {
        id: '33333333-3333-4333-8333-333333333333', code: 'LIYAN', displayName: '李艳',
        roleCodes: ['MANAGER'], roleNames: ['店长'],
      },
      access: {
        permissions: ['dashboard.view'], deniedPermissions: [], dataScopes: [], approvalLimits: [],
        resolvedAt: '2026-08-11T12:00:00.000Z',
      },
      navigation: [], highFrequencyEntries: [], domainSummaries: [],
      endpointRefs: {
        workspace: '/api/staff/workspace', sessions: '/api/operations', operations: '/api/operations',
        tableManagement: '/api/table-management/tables', fulfillment: '/api/commerce/fulfillment',
        reservations: '/api/staff/reservations', reservationIntake: '/api/staff/reservation-intake',
        reconciliation: '/api/reconciliation', inventory: '/api/inventory', notifications: '/api/notifications',
        aiCapabilities: '/api/ai/capabilities', hardwareWork: '/api/hardware/work',
      },
    },
    meta: { generatedAt: '2026-08-11T12:00:00.000Z' },
  }
}

describe('NormalizedApiClient', () => {
  it('binds the native browser fetch receiver before storing it on the client', async () => {
    const nativeLikeFetch = vi.fn(function (this: typeof globalThis) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(new Response(JSON.stringify({
        data: { workItems: [] },
        meta: { generatedAt: '2026-08-11T12:00:00.000Z' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', nativeLikeFetch)
    const client = new NormalizedApiClient()

    await expect(client.getFulfillment()).resolves.toEqual({ workItems: [] })
    expect(nativeLikeFetch).toHaveBeenCalledOnce()
  })

  it('loads the compact bootstrap with credentials and exposes its ETag', async () => {
    const send = vi.fn(async () => new Response(JSON.stringify(bootstrap()), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"bootstrap-v1"' },
    }))
    const client = new NormalizedApiClient({ fetch: send })

    const result = await client.getStaffBootstrap()

    expect(result).toMatchObject({ notModified: false, etag: '"bootstrap-v1"', data: { schemaVersion: 1 } })
    expect(send).toHaveBeenCalledWith('/api/staff/workspace', expect.objectContaining({
      method: 'GET', credentials: 'include', signal: expect.any(AbortSignal),
    }))
  })

  it('renews the short online lease without changing the six-hour staff session', async () => {
    const auth = {
      session: {
        id: 'session-1', employeeId: 'employee-1', issuedAt: '2026-08-11T12:00:00.000Z',
        expiresAt: '2026-08-11T18:00:00.000Z', onlineLeaseUntil: '2026-08-11T12:02:00.000Z', isOnline: true,
      },
      employee: { id: 'employee-1', code: 'liyan', displayName: '李艳', roleCodes: ['MANAGER'] },
      permissions: ['dashboard.view'], deniedPermissions: [],
    }
    const send = vi.fn(async () => new Response(JSON.stringify({ data: auth }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const client = new NormalizedApiClient({ fetch: send })

    await expect(client.heartbeatStaff()).resolves.toEqual(auth)
    expect(send).toHaveBeenCalledWith('/api/auth/heartbeat', expect.objectContaining({
      method: 'POST', credentials: 'include',
    }))
  })

  it('uses conditional requests and preserves cached data on 304', async () => {
    const send = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"bootstrap-v1"')
      return new Response(null, { status: 304, headers: { etag: '"bootstrap-v1"' } })
    })
    const client = new NormalizedApiClient({ fetch: send })

    await expect(client.getStaffBootstrap({ etag: '"bootstrap-v1"' })).resolves.toEqual({
      data: null, etag: '"bootstrap-v1"', notModified: true,
    })
  })

  it('aborts slow reads at the requested timeout and gives an explicit retry path', async () => {
    vi.useFakeTimers()
    const send = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const client = new NormalizedApiClient({ fetch: send, defaultTimeoutMs: 100 })
    const pending = client.getStaffBootstrap()
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout', recovery: 'retry' })

    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })

  it('distinguishes caller cancellation from a network failure', async () => {
    const controller = new AbortController()
    controller.abort()
    const send = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      return new Response(null, { status: 500 })
    })
    const client = new NormalizedApiClient({ fetch: send })

    await expect(client.getStaffBootstrap({ signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted', recovery: 'none',
    })
  })

  it('directs expired sessions to login and rejects untrusted endpoint references', async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'AUTH_REQUIRED', message: '请重新登录', retryable: false },
    }), { status: 401, headers: { 'content-type': 'application/json' } }))
    const client = new NormalizedApiClient({ fetch: send })

    await expect(client.getStaffBootstrap()).rejects.toMatchObject({
      kind: 'http', recovery: 'login', status: 401, code: 'AUTH_REQUIRED',
    })
    await expect(client.getEndpoint('https://example.com/private')).rejects.toBeInstanceOf(NormalizedApiError)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('rejects a structurally invalid bootstrap with a recoverable error', async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ data: { schemaVersion: 1 } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const client = new NormalizedApiClient({ fetch: send })

    await expect(client.getStaffBootstrap()).rejects.toMatchObject({
      kind: 'invalid_response', recovery: 'retry',
    })
  })

  it('loads detailed domains only through explicit on-demand methods', async () => {
    const paths: string[] = []
    const send = vi.fn(async (url: string | URL | Request) => {
      paths.push(String(url))
      return new Response(JSON.stringify({
        data: { source: String(url) },
        meta: { generatedAt: '2026-08-11T12:00:00.000Z' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const client = new NormalizedApiClient({ fetch: send })

    await client.getSessions()
    await client.getOperations()
    await client.getFulfillment()
    await client.getReservationSummary()

    expect(paths).toEqual([
      '/api/operations',
      '/api/operations',
      '/api/commerce/fulfillment',
      '/api/staff/reservations',
    ])
    expect(paths).not.toContain('/api/staff/workspace')
  })

  it('recovers on a later request after a network failure', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { workItems: [] },
        meta: { generatedAt: '2026-08-11T12:00:00.000Z' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = new NormalizedApiClient({ fetch: send })

    await expect(client.getFulfillment()).rejects.toMatchObject({
      kind: 'network', recovery: 'retry', retryable: true,
    })
    await expect(client.getFulfillment()).resolves.toEqual({ workItems: [] })
  })
})
