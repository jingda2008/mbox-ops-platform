import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

interface TestResponse {
  body: string
  ok: boolean
  type: 'basic'
  headers: { get: (name: string) => string | null }
  clone: () => TestResponse
}

function response(body: string, cacheControl = 'public, max-age=3600'): TestResponse {
  const value: TestResponse = {
    body,
    ok: true,
    type: 'basic',
    headers: { get: (name) => name.toLowerCase() === 'cache-control' ? cacheControl : null },
    clone: () => value,
  }
  return value
}

function loadWorker(networkResponse = response('network')) {
  const listeners = new Map<string, (event: TestEvent) => void>()
  const stores = new Map<string, Map<string, TestResponse>>()
  const deleted: string[] = []
  const fetch = vi.fn(async () => networkResponse)
  const keyFor = (request: TestRequest | string) => typeof request === 'string'
    ? new URL(request, 'https://mbox.test').href
    : request.url
  const caches = {
    open: vi.fn(async (name: string) => {
      const store = stores.get(name) ?? new Map<string, TestResponse>()
      stores.set(name, store)
      return {
        match: async (request: TestRequest | string) => store.get(keyFor(request)),
        put: async (request: TestRequest | string, value: TestResponse) => { store.set(keyFor(request), value) },
      }
    }),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => {
      deleted.push(name)
      return stores.delete(name)
    },
  }
  const self = {
    location: { origin: 'https://mbox.test' },
    clients: { claim: vi.fn() },
    skipWaiting: vi.fn(),
    addEventListener: (name: string, listener: (event: TestEvent) => void) => listeners.set(name, listener),
  }
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    URL,
    Set,
    Promise,
    caches,
    fetch,
    self,
  })
  return { caches, deleted, fetch, listeners, stores }
}

interface TestRequest {
  method: string
  mode: string
  url: string
}

interface TestEvent {
  request: TestRequest
  respondWith: (response: Promise<TestResponse>) => void
  waitUntil: (work: Promise<unknown>) => void
}

function fetchEvent(url: string, mode = 'cors') {
  const waits: Promise<unknown>[] = []
  let result: Promise<TestResponse> | undefined
  return {
    event: {
      request: { method: 'GET', mode, url },
      respondWith: (responsePromise: Promise<TestResponse>) => { result = Promise.resolve(responsePromise) },
      waitUntil: (work: Promise<unknown>) => waits.push(Promise.resolve(work)),
    },
    result: () => result,
    waitForBackgroundWork: () => Promise.all(waits),
  }
}

describe('service worker cache policy', () => {
  it('never intercepts API requests', () => {
    const worker = loadWorker()
    const api = fetchEvent('https://mbox.test/api/guest/session')

    worker.listeners.get('fetch')?.(api.event)

    expect(api.result()).toBeUndefined()
    expect(worker.fetch).not.toHaveBeenCalled()
  })

  it('uses network-first navigation and falls back to the data-free application shell', async () => {
    const worker = loadWorker(response('fresh-shell', 'no-cache'))
    const online = fetchEvent('https://mbox.test/', 'navigate')

    worker.listeners.get('fetch')?.(online.event)
    expect((await online.result())?.body).toBe('fresh-shell')
    expect(worker.stores.get('mbox-ops-static-v5')?.get('https://mbox.test/')?.body).toBe('fresh-shell')

    worker.fetch.mockRejectedValueOnce(new Error('offline'))
    const offline = fetchEvent('https://mbox.test/', 'navigate')
    worker.listeners.get('fetch')?.(offline.event)
    expect((await offline.result())?.body).toBe('fresh-shell')
  })

  it('uses cache-first for fingerprinted build assets', async () => {
    const worker = loadWorker()
    const url = 'https://mbox.test/assets/index-Cpns5OkI.js'
    worker.stores.set('mbox-ops-static-v5', new Map([[url, response('cached')]]))
    const request = fetchEvent(url)

    worker.listeners.get('fetch')?.(request.event)

    expect((await request.result())?.body).toBe('cached')
    expect(worker.fetch).not.toHaveBeenCalled()
  })

  it('serves updateable media immediately and refreshes it in the background', async () => {
    const worker = loadWorker(response('fresh'))
    const url = 'https://mbox.test/menu/cocktail.jpg'
    worker.stores.set('mbox-ops-media-v5', new Map([[url, response('cached')]]))
    const request = fetchEvent(url)

    worker.listeners.get('fetch')?.(request.event)

    expect((await request.result())?.body).toBe('cached')
    await request.waitForBackgroundWork()
    expect(worker.stores.get('mbox-ops-media-v5')?.get(url)?.body).toBe('fresh')
  })

  it('deletes only outdated M-BOX caches during activation', async () => {
    const worker = loadWorker()
    worker.stores.set('mbox-ops-shell-v4', new Map())
    worker.stores.set('mbox-ops-static-v5', new Map())
    worker.stores.set('mbox-ops-media-v5', new Map())
    worker.stores.set('another-app-v1', new Map())
    const waits: Promise<unknown>[] = []

    worker.listeners.get('activate')?.({ waitUntil: (work) => waits.push(work) } as TestEvent)
    await Promise.all(waits)

    expect(worker.deleted).toEqual(['mbox-ops-shell-v4'])
    expect(worker.stores.has('another-app-v1')).toBe(true)
  })
})
