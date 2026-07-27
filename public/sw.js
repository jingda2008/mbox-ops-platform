const CACHE_NAMESPACE = 'mbox-ops-'
const STATIC_CACHE = `${CACHE_NAMESPACE}static-v5`
const MEDIA_CACHE = `${CACHE_NAMESPACE}media-v5`
const ACTIVE_CACHES = new Set([STATIC_CACHE, MEDIA_CACHE])
const APP_SHELL_URL = '/'
const SENSITIVE_PATH = /^\/api(?:\/|$)|\/(?:member|members|payment|payments|refund|refunds)(?:\/|$)/i
const HASHED_ASSET_PATH = /^\/assets\/.*-(?=[A-Za-z0-9_-]{8,}\.[^.]+$)(?=[A-Za-z0-9_-]*[A-Z0-9_])[A-Za-z0-9_-]{8,}\.[^.]+$/
const UPDATEABLE_MEDIA_PATH = /^\/(?:menu|brand|icons)(?:\/|$)|^\/assets\/mbox-floorplan(?:-2026)?\.(?:png|jpg|webp)$/

function canStore(response) {
  return response.ok && response.type === 'basic' && !/\bno-store\b/i.test(response.headers.get('cache-control') ?? '')
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (canStore(response)) await cache.put(request, response.clone())
  return response
}

function staleWhileRevalidate(event, request) {
  const update = caches.open(MEDIA_CACHE).then(async (cache) => {
    const response = await fetch(request)
    if (canStore(response)) await cache.put(request, response.clone())
    return response
  })
  event.waitUntil(update.then(() => undefined).catch(() => undefined))
  return caches.open(MEDIA_CACHE).then(async (cache) => (await cache.match(request)) ?? update)
}

async function navigationNetworkFirst(request) {
  const cache = await caches.open(STATIC_CACHE)
  try {
    const response = await fetch(request)
    if (canStore(response)) await cache.put(APP_SHELL_URL, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(APP_SHELL_URL)
    if (cached) return cached
    throw error
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([
    caches.open(MEDIA_CACHE),
    caches.open(STATIC_CACHE).then(async (cache) => {
      try {
        const response = await fetch(APP_SHELL_URL)
        if (canStore(response)) await cache.put(APP_SHELL_URL, response.clone())
      } catch {
        // A later successful navigation will populate the offline shell.
      }
    }),
  ]))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_NAMESPACE) && !ACTIVE_CACHES.has(key))
        .map((key) => caches.delete(key)),
    )),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  // Business data stays on the network; only the data-free application shell is retained for offline startup.
  if (SENSITIVE_PATH.test(url.pathname)) return
  if (request.mode === 'navigate') {
    event.respondWith(navigationNetworkFirst(request))
    return
  }

  if (HASHED_ASSET_PATH.test(url.pathname)) {
    event.respondWith(cacheFirst(request))
    return
  }
  if (UPDATEABLE_MEDIA_PATH.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, request))
  }
})
