// Linedesk service worker: makes the app installable and lets the app shell open without a network.
// It caches the app shell only: index.html, the built /assets/* (hashed, the same for every user) and
// the icons. It never caches API, sync shape or recording responses (/api, /v1, /mcp, /rtc): those
// carry a person's data, which lives in IndexedDB and goes on sign-out (localData.ts). One cache per
// build (`?build=` in the script URL, see src/serviceWorker.ts); older builds' caches go on activate.
const BUILD = new URL(self.location.href).searchParams.get('build') || 'dev'
const PREFIX = 'linedesk-shell-'
const CACHE = `${PREFIX}${BUILD}`
const SHELL = ['/', '/boot.css', '/locale.js', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png']
const NEVER = ['/api/', '/v1/', '/mcp', '/rtc']

/** The hashed files index.html loads (entry script, styles), so the shell opens offline after the first visit. */
function assetsOf(html) {
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1])
}

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await cache.addAll(SHELL)
      const index = await cache.match('/')
      if (index) await cache.addAll(assetsOf(await index.text()))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter(n => n.startsWith(PREFIX) && n !== CACHE).map(n => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

/** Pages: the network first (an update is picked up at once), the cached shell when offline. */
async function page(request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response.ok && (response.headers.get('content-type') || '').includes('text/html'))
      await cache.put('/', response.clone())
    return response
  } catch (error) {
    const cached = await cache.match('/')
    if (cached) return cached
    throw error
  }
}

/** Hashed assets never change under the same name: the cache first, then the network (kept for next time). */
async function asset(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (NEVER.some(p => url.pathname.startsWith(p))) return
  if (request.mode === 'navigate') return event.respondWith(page(request))
  if (url.pathname.startsWith('/assets/')) return event.respondWith(asset(request))
})

// Push notifications about calls (apps/api/src/push.ts): who called and, if the member opted in, one
// line on what about. One notification per call: a later push (message taken, call ended) replaces
// the earlier one; only urgent calls sound again. Nothing from a push is stored here.
self.addEventListener('push', event => {
  let data = null
  try {
    data = event.data ? event.data.json() : null
  } catch {
    /* not ours */
  }
  if (!data || typeof data.callId !== 'string' || typeof data.title !== 'string') return
  event.waitUntil(
    (async () => {
      // A Linedesk window in front shows the call itself; a background tab also gets the page's own
      // notification, which has the same tag, so the two never show twice.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (windows.some(w => w.focused && w.visibilityState === 'visible')) return
      await self.registration.showNotification(data.title, {
        body: data.body || undefined,
        tag: `call-${data.callId}`,
        renotify: data.urgent === true,
        requireInteraction: data.urgent === true,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { callId: data.callId },
      })
    })(),
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const callId = event.notification.data?.callId
  if (typeof callId !== 'string') return
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find(w => new URL(w.url).origin === self.location.origin)
      if (open) {
        open.postMessage({ type: 'linedesk:open-call', callId })
        // Focusing can be refused (no user gesture); the call is open either way.
        await open.focus().catch(() => {})
        return
      }
      await self.clients.openWindow(`/#call/${encodeURIComponent(callId)}`)
    })(),
  )
})
