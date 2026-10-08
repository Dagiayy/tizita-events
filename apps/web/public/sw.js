/* Minimal PWA worker: caches the app shell so the page opens on a flaky link. API responses and photos are NEVER cached
   (private event media must not persist in shared caches). Queued uploads live in IndexedDB and resume when the page reopens. */
const SHELL = 'ep-shell-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/offline.html'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/v1/')) return;      // network only for the API / media
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  if (url.pathname.startsWith('/_next/static/')) {
    e.respondWith(caches.open(SHELL).then(async (c) => { const hit = await c.match(req); if (hit) return hit; const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }));
  }
});
