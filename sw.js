const CACHE_NAME = 'kennisboost-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/tailwind.output.css',
  './css/app.css',
  './src/main.js',
  './src/router.js',
  './src/state/store.js',
  './src/utils/uuid.js',
  './src/utils/toast.js',
  './src/core/storage.js',
  './src/core/sync.js',
  './src/core/sanitizer.js',
  './src/core/validator.js',
  './src/core/crypto-share.js',
  './src/modules/flashcards/index.js',
  './src/modules/flashcards/editor.js',
  './src/modules/flashcards/sketch-canvas.js',
  './src/modules/flashcards/fsrs.js',
  './src/modules/flashcards/study-player.js',
  './src/modules/flashcards/tower-defense.js',
  './src/modules/timeline/index.js',
  './src/modules/timeline/canvas-renderer.js',
  './src/modules/timeline/svg-exporter.js',
  './src/modules/video/index.js',
  './src/modules/video/drivers.js',
  './src/modules/video/interceptor.js',
  './src/modules/video/kiosk-report.js',
  './src/modules/gradebook/index.js',
  './src/modules/gradebook/virtual-grid.js',
  './src/modules/gradebook/engine-calc.js',
  './src/modules/gradebook/rubric-builder.js',
  './src/modules/gradebook/report-generator.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only intercept GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        // Cache dynamic CDN resources (jsdelivr, KaTeX, Shoelace) for offline durability
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          (event.request.url.includes('cdn.jsdelivr.net') || event.request.url.startsWith(self.location.origin))
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // If offline and request is for navigation, return cached index.html
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
