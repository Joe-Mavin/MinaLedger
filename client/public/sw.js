const CACHE_NAME = 'minaledger-app-shell-v2';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg', '/assets/app.js', '/assets/index.css'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('/index.html', response.clone());
        }
        return response;
      } catch {
        return (await caches.match('/index.html')) || Response.error();
      }
    })());
    return;
  }
  if (!APP_SHELL.includes(url.pathname)) return;
  if (request.destination === 'script' || request.destination === 'style' || request.destination === 'image' || url.pathname === '/manifest.webmanifest') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(url.pathname, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(url.pathname)) || Response.error();
      }
    })());
  }
});
