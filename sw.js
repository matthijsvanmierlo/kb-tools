/* KennisBoost service worker (classic script — no ES module syntax, so every browser can run it).
 *
 *  - Precaches the app shell (list + content-hash version generated into sw-assets.js).
 *  - Cache-first for same-origin GETs (navigations get the cached shell); other origins untouched.
 *  - Web Share Target: receives POSTed files/links entirely inside the worker, so shared data never
 *    reaches a server, and hands them to the app through a private cache.
 */
importScripts('./sw-assets.js');

const CACHE_NAME = `kennisboost-${self.KB_CACHE_VERSION || 'dev'}`;
const SHARE_CACHE = 'kennisboost-share-inbox';
const SHARE_TARGET_PATH = 'share-target';

/**
 * Network-only for API calls and anything cross-origin (relay servers, video hosts).
 * @param {string} urlString
 * @param {string} [baseOrigin]
 * @returns {boolean}
 */
function shouldBypassCache(urlString, baseOrigin) {
  const origin = baseOrigin || (self.location ? self.location.origin : '');
  try {
    const u = new URL(urlString, origin || 'http://localhost');
    if (u.pathname.startsWith('/api/')) return true;
    // School IT settings must reach devices as soon as they change (the app keeps an offline copy)
    if (u.pathname.endsWith('/config.json')) return true;
    return Boolean(origin) && u.origin !== origin;
  } catch (_) {
    return false;
  }
}

/** True for the POST the OS share sheet sends to the manifest's share_target action */
function isShareTargetRequest(request) {
  if (request.method !== 'POST') return false;
  try {
    return new URL(request.url).pathname.endsWith(`/${SHARE_TARGET_PATH}`);
  } catch (_) {
    return false;
  }
}

/**
 * Store shared files and text in SHARE_CACHE and send the app to the inbox.
 * The app reads and deletes the entries (src/core/launch.js).
 */
async function handleShareTarget(request) {
  const form = await request.formData();
  const cache = await caches.open(SHARE_CACHE);
  const stamp = Date.now();
  let n = 0;
  for (const file of form.getAll('files')) {
    if (!file || typeof file === 'string') continue;
    await cache.put(`./__share/${stamp}-${n++}`, new Response(file, {
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'shared-file') }
    }));
  }
  const text = [form.get('title'), form.get('text'), form.get('url')].filter(v => typeof v === 'string' && v).join('\n');
  if (text) {
    await cache.put(`./__share/${stamp}-${n++}`, new Response(text, {
      headers: { 'Content-Type': 'text/plain', 'X-Filename': 'shared-text.txt' }
    }));
  }
  return Response.redirect(new URL('./#/inbox?shared=1', self.registration.scope).href, 303);
}

self.KB_SW = { shouldBypassCache, isShareTargetRequest, CACHE_NAME };

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(self.KB_PRECACHE || ['./', './index.html']))
  );
  // No skipWaiting() here: swapping caches under an open page would mix module versions.
  // The page asks the user, then sends SKIP_WAITING (src/core/pwa.js).
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME && key !== SHARE_CACHE).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (isShareTargetRequest(request)) {
    event.respondWith(handleShareTarget(request));
    return;
  }
  if (request.method !== 'GET' || shouldBypassCache(request.url)) return;

  // Navigations get the cached shell so index.html always matches the cached modules. A new
  // deploy installs a new worker; the page then offers a reload (main.js, controllerchange).
  if (request.mode === 'navigate' && /\/(index\.html)?$/.test(new URL(request.url).pathname)) {
    event.respondWith(
      caches.match('./index.html', { ignoreSearch: true }).then((cached) => cached || fetch(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
