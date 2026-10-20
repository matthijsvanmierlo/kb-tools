/**
 * PWA integration (KB-CORE-PWA)
 *  - Service worker registration with a user-confirmed update (no mid-session cache swaps).
 *  - File Handling API: files double-clicked in the OS arrive through `launchQueue`.
 *  - Web Share Target: the service worker stashes shared files/links in a private cache that is
 *    drained here.
 * Every entry point funnels into openIncomingFiles(), the same path as the Home "Open file" button.
 */
import { store } from '../state/store.js';
import { toast } from '../utils/toast.js';
import { extractEnvelopeFromHtml } from './html-launcher.js';

const SHARE_CACHE = 'kennisboost-share-inbox';
const HANDIN_EXTENSIONS = ['.kbsub', '.kbr', '.zip'];

let deferredInstallPrompt = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    window.dispatchEvent(new CustomEvent('kb-pwa-installable', { detail: true }));
  });
}

export function canInstallPwa() {
  return !!deferredInstallPrompt;
}

export async function promptPwaInstall() {
  if (!deferredInstallPrompt) return false;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  window.dispatchEvent(new CustomEvent('kb-pwa-installable', { detail: false }));
  return outcome === 'accepted';
}

/** Extract the `#/share?...` part of a KennisBoost link, or null */
export function extractShareHash(text, origin = (typeof window !== 'undefined' ? window.location.origin : '')) {
  const match = String(text || '').match(/https?:\/\/\S+?#\/share\?\S+|#\/share\?\S+/);
  if (!match) return null;
  const candidate = match[0];
  if (candidate.startsWith('#')) return candidate;
  try {
    const u = new URL(candidate);
    if (origin && u.origin !== origin) return null;
    if (u.hash && u.hash.startsWith('#/share')) return u.hash;
    return null;
  } catch (_) {
    return null;
  }
}

/** Decide where an incoming file belongs */
export function classifyIncomingFile(name = '') {
  const lower = name.toLowerCase();
  if (HANDIN_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'inbox';
  if (lower.endsWith('.kbfeedback')) return 'feedback';
  if (lower.endsWith('.kbsession')) return 'session';
  return 'share';
}

function goToInbox(router, files) {
  store.setState('inboxDrop', files);
  // Re-render when the inbox is already showing (navigating to the same hash fires no event)
  if (window.location.hash === '#/inbox') router.handleRoute();
  else router.navigate('#/inbox');
}

/**
 * Open files that came from outside the app (OS launch, share sheet, file picker).
 * @param {File[]} files
 * @param {{ navigate: Function }} router
 */
export async function openIncomingFiles(files, router) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;

  const handin = list.filter(f => classifyIncomingFile(f.name) === 'inbox');
  const others = list.filter(f => classifyIncomingFile(f.name) !== 'inbox');

  if (handin.length) {
    goToInbox(router, handin);
    if (!others.length) return;
  }

  for (const file of others) {
    let text = await file.text();
    if (file.name.toLowerCase().endsWith('.html') || file.name.toLowerCase().endsWith('.htm') || text.includes('kb-payload')) {
      const extracted = extractEnvelopeFromHtml(text);
      if (extracted) {
        if (typeof extracted === 'object') {
          if (extracted.kind === 'assignment_feedback' || extracted.type === 'assignment_feedback') {
            if (typeof router._activateSharedPayload === 'function') {
              router._activateSharedPayload({ type: 'assignment_feedback', payload: extracted });
            } else {
              router.navigate('#/student/gradebook');
            }
            return;
          }
          if (extracted.kind === 'student_grade_report' || extracted.type === 'student_grade_report') {
            if (typeof router._activateSharedPayload === 'function') {
              router._activateSharedPayload({ type: 'student_grade_report', payload: extracted });
            } else {
              router.navigate('#/report');
            }
            return;
          }
          if (extracted.kbsub === 1 || extracted.epk || extracted.submission) {
            goToInbox(router, [file]);
            continue;
          }
          text = JSON.stringify(extracted);
        } else if (typeof extracted === 'string') {
          text = extracted;
        }
      }
    }

    const shareHash = extractShareHash(text);
    if (shareHash) {
      router.navigate(shareHash);
      return;
    }
    // A shared lesson file, or student work saved as .txt/.json → let the inbox classify it
    if (/KBSUB1\./.test(text)) {
      goToInbox(router, [file]);
      continue;
    }

    // Inspect parsed JSON objects for session, feedback, grade reports, and assignment envelopes
    try {
      const parsed = typeof text === 'object' ? text : JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        if (parsed.kennisboost_student_session || file.name.toLowerCase().endsWith('.kbsession')) {
          const { importStudentSession } = await import('../modules/student/session-portability.js');
          await importStudentSession(text);
          router.navigate('#/student');
          return;
        }
        if (parsed.course && (Array.isArray(parsed.items) || Array.isArray(parsed.units))) {
          const { mergeCourseFeed } = await import('../modules/student/course-store.js');
          await mergeCourseFeed(parsed);
          router.navigate(`#/student/course?id=${parsed.course.id}`);
          return;
        }
        if (parsed.kind === 'assignment_feedback' || parsed.type === 'assignment_feedback') {
          if (typeof router._activateSharedPayload === 'function') {
            router._activateSharedPayload({ type: 'assignment_feedback', payload: parsed });
          } else {
            router.navigate('#/student/gradebook');
          }
          return;
        }
        if (parsed.kind === 'student_grade_report' || parsed.type === 'student_grade_report') {
          if (typeof router._activateSharedPayload === 'function') {
            router._activateSharedPayload({ type: 'student_grade_report', payload: parsed });
          } else {
            router.navigate('#/report');
          }
          return;
        }
        if (parsed.kind === 'kb-assignment' || (parsed.type === 'assignment' && parsed.assignment)) {
          if (typeof router._activateSharedPayload === 'function') {
            router._activateSharedPayload({ type: 'assignment', payload: parsed.assignment || parsed });
          } else if (typeof router.openShareFile === 'function') {
            await router.openShareFile(text);
          }
          return;
        }
      }
    } catch (_) {}

    await router.openShareFile(text);
  }
}

/** Drain files the service worker stored from a Web Share Target POST */
export async function takeSharedFiles() {
  if (typeof caches === 'undefined') return [];
  const cache = await caches.open(SHARE_CACHE);
  const requests = await cache.keys();
  const files = [];
  for (const req of requests) {
    const res = await cache.match(req);
    if (res) {
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-Filename') || 'shared-file');
      files.push(new File([blob], name, { type: blob.type }));
    }
    await cache.delete(req);
  }
  return files;
}

/**
 * Check if the window was launched with a payload in window.name or sessionStorage.
 * @param {{ navigate: Function }} router
 */
export async function consumeWindowLaunchPayload(router) {
  if (typeof window === 'undefined') return false;

  let rawPayload = null;
  let filename = 'incoming-payload.json';
  let payloadType = '';

  // 1. Check window.name envelope (cross-origin bridge)
  if (typeof window.name === 'string' && window.name.startsWith('KB_LAUNCH_V1:')) {
    try {
      const data = JSON.parse(window.name.slice('KB_LAUNCH_V1:'.length));
      rawPayload = data.payload;
      payloadType = data.payloadType || data.type || '';
      filename = (data.title ? data.title.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : 'incoming') +
        (payloadType === 'submission' ? '.kbsub' : payloadType === 'feedback' ? '.kbfeedback' : '.kbshare');
    } catch (e) {
      console.warn('Could not parse window.name launch payload:', e);
    }
    try { window.name = ''; } catch (_) {}
  }

  // 2. Check sessionStorage fallback
  if (!rawPayload) {
    try {
      const stored = sessionStorage.getItem('kb_incoming_payload');
      if (stored) {
        rawPayload = stored;
        sessionStorage.removeItem('kb_incoming_payload');
      }
    } catch (_) {}
  }

  if (rawPayload) {
    const content = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
    const file = new File([content], filename, { type: 'application/json' });
    await openIncomingFiles([file], router);
    return true;
  }
  return false;
}

export async function initLaunchHandlers(router) {
  if (typeof window === 'undefined') return;

  // Consume any incoming launch payload passed via window.name or sessionStorage
  await consumeWindowLaunchPayload(router);

  if ('launchQueue' in window && typeof window.launchQueue.setConsumer === 'function') {
    window.launchQueue.setConsumer(async (params) => {
      if (!params?.files?.length) return;
      try {
        const files = await Promise.all(params.files.map(h => h.getFile()));
        await openIncomingFiles(files, router);
      } catch (err) {
        console.error('Could not open launched file:', err);
        toast.danger('Could not open that file.');
      }
    });
  }

  const hash = window.location.hash || '';
  if (hash.startsWith('#/inbox') && hash.includes('shared=1')) {
    takeSharedFiles()
      .then(files => (files.length ? openIncomingFiles(files, router) : null))
      .catch(err => console.error('Could not read shared files:', err));
  }
}

export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!window.location.protocol.startsWith('http')) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  const offerUpdate = (worker) => {
    if (!worker || !navigator.serviceWorker.controller) return; // first install: nothing to update
    const alert = Object.assign(document.createElement('sl-alert'), {
      variant: 'primary',
      closable: true,
      duration: Infinity
    });
    alert.innerHTML = `
      <sl-icon slot="icon" name="arrow-repeat"></sl-icon>
      <strong>A new version of KennisBoost is ready.</strong><br>
      Save your work, then reload to update.
      <div class="mt-2"><sl-button size="small" variant="primary">Reload now</sl-button></div>`;
    const reloadBtn = alert.querySelector('sl-button');
    reloadBtn?.addEventListener('click', () => {
      reloadBtn.loading = true;
      reloadBtn.disabled = true;
      try {
        worker.postMessage('SKIP_WAITING');
      } catch (err) {
        console.warn('SKIP_WAITING postMessage error:', err);
      }
      setTimeout(() => {
        if (!reloading) {
          reloading = true;
          window.location.reload();
        }
      }, 600);
    });
    document.body.append(alert);
    alert.toast?.();
  };

  navigator.serviceWorker.register('./sw.js').then((reg) => {
    if (reg.waiting) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') offerUpdate(worker);
      });
    });
  }).catch(err => {
    console.debug('ServiceWorker registration skipped/failed:', err);
  });
}
