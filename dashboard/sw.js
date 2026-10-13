// Offline support. Network first: whenever the dashboard server is reachable you always get
// the latest files (revalidated, never a stale HTTP-cache copy); the saved copy is only used
// when there is no connection, so the app still opens offline.
const CACHE = 'tremorband-v16';
const SHELL = [
  './', 'index.html', 'css/style.css', 'css/screen_tests.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/app.js', 'js/ble.js', 'js/chart.js', 'js/protocol.js', 'js/report.js', 'js/sim.js', 'js/store.js', 'js/tests.js', 'js/wearoff.js', 'js/dsp.js', 'js/bench.js', 'js/compare.js', 'js/livepipe.js', 'js/versus.js', 'data/pads_summary.json',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the browser's HTTP cache, so the offline copy is the real latest
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request, { cache: 'no-cache' });  // revalidate with the server
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
