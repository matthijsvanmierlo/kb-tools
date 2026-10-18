const CACHE_NAME = 'kennisboost-v12';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/tailwind.output.css',
  './css/app.css',
  './fonts/inter-latin-wght-normal.woff2',
  './src/components/class-manager.js',
  './src/components/class-setup-wizard.js',
  './src/components/command-palette.js',
  './src/components/export-dialog.js',
  './src/components/grades-import-dialog.js',
  './src/components/handin-instructions.js',
  './src/components/project-library.js',
  './src/components/rich-text-editor.js',
  './src/components/roster-import-dialog.js',
  './src/components/setup-checklist.js',
  './src/components/share-dialog.js',
  './src/version.js',
  './src/core/academic-year.js',
  './src/core/access-codes.js',
  './src/core/crypto-share.js',
  './src/core/csv.js',
  './src/core/demo.js',
  './src/core/envelope-router.js',
  './src/core/export-presets.js',
  './src/core/links.js',
  './src/core/names.js',
  './src/core/oneroster.js',
  './src/core/roster-import.js',
  './src/core/sanitizer.js',
  './src/core/storage.js',
  './src/core/submission-crypto.js',
  './src/core/sync.js',
  './src/core/transport.js',
  './src/core/validator.js',
  './src/main.js',
  './src/modules/about/index.js',
  './src/modules/assignments/editor.js',
  './src/modules/assignments/feedback-link.js',
  './src/modules/assignments/feedback-pdf.js',
  './src/modules/assignments/feedback-view.js',
  './src/modules/assignments/grading.js',
  './src/modules/assignments/import.js',
  './src/modules/assignments/index.js',
  './src/modules/assignments/pipeline.js',
  './src/modules/assignments/publish.js',
  './src/modules/assignments/question-types.js',
  './src/modules/assignments/seed.js',
  './src/modules/assignments/submissions.js',
  './src/modules/assignments/take.js',
  './src/modules/inbox/index.js',
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
  './src/modules/gradebook/gradebook-csv.js',
  './src/modules/gradebook/grading-scales.js',
  './src/modules/gradebook/index.js',
  './src/modules/gradebook/report-generator.js',
  './src/modules/gradebook/roster-view.js',
  './src/modules/gradebook/rubric-builder.js',
  './src/modules/gradebook/standards-view.js',
  './src/modules/gradebook/student-report.js',
  './src/modules/gradebook/virtual-grid.js',
  './src/modules/guide/index.js',
  './src/modules/home/home-stats.js',
  './src/modules/home/index.js',
  './src/modules/timeline/canvas-renderer.js',
  './src/modules/timeline/index.js',
  './src/modules/timeline/svg-exporter.js',
  './src/modules/video/drivers.js',
  './src/modules/video/index.js',
  './src/modules/video/interceptor.js',
  './src/modules/video/kiosk-report.js',
  './src/modules/video/receipt-import.js',
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

/**
 * Determine whether a fetch request should bypass the Service Worker cache.
 * Network-only for API requests (/api/) or cross-origin requests that are not jsdelivr CDN assets.
 *
 * @param {string} urlString
 * @param {string} [baseOrigin]
 * @returns {boolean}
 */
export function shouldBypassCache(urlString, baseOrigin = (typeof self !== 'undefined' && self.location ? self.location.origin : '')) {
  try {
    const u = new URL(urlString, baseOrigin || 'http://localhost');
    if (u.pathname.startsWith('/api/')) return true;
    if (baseOrigin && u.origin !== baseOrigin && !u.hostname.includes('cdn.jsdelivr.net')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

self.addEventListener('fetch', (event) => {
  // Only intercept GET requests
  if (event.request.method !== 'GET') return;

  if (shouldBypassCache(event.request.url)) {
    return; // Pass through to network
  }

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

