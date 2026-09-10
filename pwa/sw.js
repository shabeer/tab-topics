// Tab Topics PWA Service Worker
const CACHE_NAME = 'tab-topics-v2-cache-v3';

const STATIC_ASSETS = [
  './',
  './index.html',
  './index.js',
  './index.css',
  './share-receive.html',
  './share-receive.js',
  './auth.js',
  './idb-adapter.js',
  './manifest.webmanifest',
  './shared/logic.js',
  './shared/store.js',
  './shared/youtube.js',
  './shared/sync.js',
  './shared/drive.js',
  './shared/sync-engine.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('Tab Topics SW: some assets failed to pre-cache:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Bypass cache for external APIs (Google APIs, YouTube Data API, etc.)
  if (url.origin !== self.location.origin) {
    return;
  }

  // Cache-first strategy for local static assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Refresh cache in background
        fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
            }
          })
          .catch(() => {});
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        }
        return networkResponse;
      });
    })
  );
});
