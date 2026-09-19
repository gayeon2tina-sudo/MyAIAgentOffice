const CACHE_NAME = 'biggyinc-v3';
// Requests whose content actually changes between deploys (the app's own HTML —
// everything, including all JS, lives inside daily_hq.html) must go network-first.
// Cache-first here would mean a feature added after someone's first visit stays
// invisible to them indefinitely, since the network only ever refreshes the cache
// for "next time," and "next time" always hits the stale cache again first.
function isNetworkFirst(pathname) {
  return pathname.endsWith('/') || pathname.endsWith('/index.html') ||
    pathname.endsWith('/daily_hq.html') || pathname.endsWith('/manifest.json');
}
const CORE_ASSETS = [
  './index.html',
  './daily_hq.html',
  './manifest.json',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './sprites/office-bg.webp',
  './sprites/hub.png',
  './sprites/job.png',
  './sprites/cv.png',
  './sprites/portfolio.png',
  './sprites/backpack.png',
  './sprites/budget.png',
  './sprites/health.png'
];

self.addEventListener('install', (event) => {
  // cache.addAll() is all-or-nothing: if a single one of these fails to fetch (a
  // transient blip, a typo, anything), the whole install rejects and this service
  // worker is discarded — permanently stuck on whatever version installed last,
  // with every future deploy silently failing to take effect. Fetch each asset
  // independently instead, so one failure can't block the rest from being cached
  // or block this version from installing and taking over at all.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(CORE_ASSETS.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never intercept cross-origin requests (the live outreach sheet, Google Fonts) —
  // those must stay live/network-only, not served from cache.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;
  // /api/* is the local server's live day-log data (polled on boot and every
  // window focus). It's never static like the sprites/manifest, so it must
  // never be served from this cache — not even as a stale-while-revalidate
  // "instant" response — or a browser tab can sit showing yesterday's
  // (or a minute-old) task list after a Claude-Code-logged task or another
  // tab's edit actually changed the file on disk. Pass it straight through.
  if (url.pathname.startsWith('/api/')) return;

  if (isNetworkFirst(url.pathname)) {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
