const CACHE_NAME = 'kennisboost-v5';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/tailwind.output.css',
  './css/app.css',
  './fonts/inter-latin-wght-normal.woff2',
  './src/components/class-manager.js',
  './src/components/command-palette.js',
  './src/components/project-library.js',
  './src/components/rich-text-editor.js',
  './src/components/share-dialog.js',
  './src/core/access-codes.js',
  './src/core/crypto-share.js',
  './src/core/sanitizer.js',
  './src/core/storage.js',
  './src/core/submission-crypto.js',
  './src/core/sync.js',
  './src/core/validator.js',
  './src/main.js',
  './src/modules/assignments/editor.js',
  './src/modules/assignments/grading.js',
  './src/modules/assignments/index.js',
  './src/modules/assignments/pipeline.js',
  './src/modules/assignments/publish.js',
  './src/modules/assignments/question-types.js',
  './src/modules/assignments/seed.js',
  './src/modules/assignments/submissions.js',
  './src/modules/assignments/take.js',
  './src/modules/flashcards/editor.js',
  './src/modules/flashcards/fsrs.js',
  './src/modules/flashcards/index.js',
  './src/modules/flashcards/sketch-canvas.js',
  './src/modules/flashcards/study-player.js',
  './src/modules/flashcards/tower-defense.js',
  './src/modules/gradebook/aggregates.js',
  './src/modules/gradebook/assignment-dialog.js',
  './src/modules/gradebook/bridge.js',
  './src/modules/gradebook/course-settings.js',
  './src/modules/gradebook/engine-calc.js',
  './src/modules/gradebook/grade-drawer.js',
  './src/modules/gradebook/grading-scales.js',
  './src/modules/gradebook/index.js',
  './src/modules/gradebook/report-generator.js',
  './src/modules/gradebook/rubric-builder.js',
  './src/modules/gradebook/standards-view.js',
  './src/modules/gradebook/student-report.js',
  './src/modules/gradebook/virtual-grid.js',
  './src/modules/guide/index.js',
  './src/modules/home/index.js',
  './src/modules/timeline/canvas-renderer.js',
  './src/modules/timeline/index.js',
  './src/modules/timeline/svg-exporter.js',
  './src/modules/video/drivers.js',
  './src/modules/video/index.js',
  './src/modules/video/interceptor.js',
  './src/modules/video/kiosk-report.js',
  './src/modules/video/sample-videos.js',
  './src/modules/video/secure.js',
  './src/modules/video/share-video.js',
  './src/router.js',
  './src/state/store.js',
  './src/utils/dialogs.js',
  './src/utils/toast.js',
  './src/utils/uuid.js'
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
