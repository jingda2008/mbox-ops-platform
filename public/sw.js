const CACHE_VERSION = 'mbox-ops-shell-v3'
const SHELL_URLS = ['/', '/manifest.webmanifest', '/favicon.svg', '/assets/mbox-floorplan.png']
const SENSITIVE_PATH = /\/(api|member|members|payment|payments|refund|refunds)(\/|$)/i
const STATIC_DESTINATIONS = new Set(['document', 'script', 'style', 'image', 'font'])
const STATIC_SHELL_PATH = /^(\/assets\/|\/favicon\.svg$|\/manifest\.webmanifest$)/

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_URLS)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  if (request.method !== 'GET' || url.origin !== self.location.origin || SENSITIVE_PATH.test(url.pathname)) {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_VERSION)
            await cache.put('/', response.clone())
          }
          return response
        })
        .catch(async () => (await caches.match('/')) ?? new Response('离线壳不可用', { status: 503 })),
    )
    return
  }

  if (!STATIC_DESTINATIONS.has(request.destination) || !STATIC_SHELL_PATH.test(url.pathname)) return

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then(async (response) => {
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(CACHE_VERSION)
          await cache.put(request, response.clone())
        }
        return response
      })
      return cached ?? network
    }),
  )
})
