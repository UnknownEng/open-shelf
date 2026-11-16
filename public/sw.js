// Network-first service worker: always fresh when online, app shell available offline.
const CACHE = 'openshelf-v3';
const SHELL = ['/', '/index.html', '/css/app.css', '/css/genz.css', '/js/main.js', '/js/api.js', '/js/ui.js', '/js/fx.js', '/js/actions.js',
  '/js/views/home.js', '/js/views/browse.js', '/js/views/shelf.js', '/js/views/admin.js', '/js/views/book.js', '/js/views/auth.js',
  '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && !url.search) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('/index.html'))));
});
