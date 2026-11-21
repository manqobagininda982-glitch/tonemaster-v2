// Offline app shell. Cache-first: the app never uses internet on launch. Samples/loops are NEVER cached here (they live in encrypted storage).
// Store / update requests (/api/...) always go to the network and are never cached.
const V = 'tonemaster-shell-v4', FILES = ['./', 'index.html', 'css/app.css', 'js/tonemaster.bundle.js', 'js/lame.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x.startsWith('tonemaster-shell') && x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin || u.pathname.includes('/api/') || u.pathname.startsWith('/~')) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(V).then(ch => ch.put(e.request, c)); } return r; })));
});
