import { store } from './state/store.js';
import { CryptoShareEngine } from './core/crypto-share.js';
import { storage } from './core/storage.js';
import { toast } from './utils/toast.js';
import { Sanitizer } from './core/sanitizer.js';
import { normalizeAccessCode } from './core/access-codes.js';
import { getTransport } from './core/transport.js';
import { normalizeSharedEnvelope, toLibraryRecord } from './core/shared-payload.js';
import { StudentProfile } from './core/student-profile.js';
import { StudentLedger } from './modules/student/ledger.js';
import { RoleMode } from './state/role-mode.js';

/**
 * Extract student share params from URL query parameters.
 * @param {Record<string, string>} [params]
 * @returns {{ sid: string|null, sname: string|null }}
 */
export function extractShareParams(params = {}) {
  return {
    sid: params?.sid || null,
    sname: params?.sname || null
  };
}

export const ROUTE_TITLES = {
  '#/': 'Home',
  '#/home': 'Home',
  '#/course': 'Courses',
  '#/course/join': 'Join Course',
  '#/calendar': 'Calendar',
  '#/classes': 'Classes & Rosters',
  '#/flashcards': 'Flashcards',
  '#/flashcards/study': 'Study Flashcards',
  '#/flashcards/edit': 'Flashcard Editor',
  '#/timeline': 'Timeline',
  '#/timeline/view': 'View Timeline',
  '#/video': 'Interactive Video',
  '#/gradebook': 'Gradebook',
  '#/assignments': 'Assignments',
  '#/assignments/edit': 'Assignment Editor',
  '#/assignments/take': 'Take Assignment',
  '#/inbox': 'Submission Inbox',
  '#/share': 'Share',
  '#/student': 'Student Hub',
  '#/student/courses': 'My Courses',
  '#/student/course': 'Course Details',
  '#/student/gradebook': 'My Grades',
  '#/guide': 'Teacher Guide',
  '#/about': 'About',
  '#/philosophy': 'Local-First Philosophy'
};

export function routeTitle(path) {
  if (!path) return 'KennisBoost Tools';
  const clean = path.split('?')[0].toLowerCase();
  const title = ROUTE_TITLES[clean];
  if (title) return `${title} · KennisBoost Tools`;
  return 'KennisBoost Tools';
}

/**
 * Hash-based Single Page App Router
 * Supports routes: #/flashcards, #/timeline, #/video, #/gradebook, #/share
 */
export class Router {
  constructor(routes = {}) {
    this.routes = routes;
    this.currentPath = '';
    this.currentParams = {};
    this.activeCleanup = null;
    this._navToken = 0;
    this._lastViewKey = null;

    if (typeof window !== 'undefined') {
      window.addEventListener('hashchange', () => this.handleRoute());
      window.addEventListener('popstate', () => this.handleRoute());
    }
  }

  /**
   * Register a route handler
   * @param {string} path - e.g. '#/flashcards'
   * @param {(params: Record<string, string>, router: Router) => Promise<Function|void>|Function|void} handler
   */
  register(path, handler) {
    this.routes[path] = handler;
  }

  /**
   * Navigate programmatically to a hash path
   * @param {string} pathWithQuery
   */
  navigate(pathWithQuery) {
    if (typeof window !== 'undefined') {
      window.location.hash = pathWithQuery.startsWith('#') ? pathWithQuery : `#${pathWithQuery}`;
    }
  }

  /**
   * Parse the current hash and query parameters
   */
  parseHash() {
    const rawHash = (typeof window !== 'undefined' ? window.location.hash : '') || '#/';
    const [pathPart, queryPart] = rawHash.split('?');
    const path = pathPart.toLowerCase() || '#/';

    const params = {};
    if (queryPart) {
      const searchParams = new URLSearchParams(queryPart);
      for (const [key, val] of searchParams.entries()) {
        params[key] = val;
      }
    }

    return { path, params };
  }

  /**
   * Handle the current route change
   */
  async handleRoute() {
    if (typeof window !== 'undefined' && (!window.location.hash || window.location.hash === '#')) {
      window.location.hash = '#/';
      return;
    }

    const { path, params } = this.parseHash();

    // Legacy redirect for roster view inside gradebook
    if (path === '#/gradebook' && params?.view === 'roster') {
      const courseId = params?.courseId ? `&courseId=${encodeURIComponent(params.courseId)}` : '';
      this.navigate(`#/classes?tab=roster${courseId}`);
      return;
    }

    this.currentPath = path;
    this.currentParams = params;

    store.setState('currentRoute', path);

    if (typeof document !== 'undefined') {
      document.title = routeTitle(path);
    }

    // Update screen reader announcement
    this._announceRouteChange(path);

    // Update navigation bar active states
    this._updateNavUI(path);
    try {
      const { updateActiveNav } = await import('./components/app-nav.js');
      updateActiveNav(window.location.hash || path);
    } catch (_) {}

    // Minimal Chrome (Exam / Kiosk) vs Standard Chrome
    const isMinimalChrome = (path === '#/assignments/take' && !params?.preview)
      || path === '#/share'
      || path.endsWith('/kiosk')
      || Boolean(params?.kiosk);

    if (typeof document !== 'undefined' && document.body) {
      if (isMinimalChrome) {
        document.body.dataset.chrome = 'minimal';
      } else {
        delete document.body.dataset.chrome;
      }

      if (RoleMode.get() === 'student') {
        document.body.dataset.mode = 'student';
      } else {
        delete document.body.dataset.mode;
      }

      const brand = document.querySelector('.kb-brand');
      if (brand) {
        brand.setAttribute('href', RoleMode.get() === 'student' ? '#/student' : '#/');
      }
    }

    // Handle share route specially
    if (path === '#/share') {
      await this._handleShareRoute(params);
      return;
    }

    const container = typeof document !== 'undefined' ? document.getElementById('app-view-container') : null;
    const navToken = ++this._navToken;
    const isNewView = this._lastViewKey !== this._viewKey(path, params);
    const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // Fade out the outgoing view before swapping content
    if (container && isNewView && container.childElementCount > 0 && !reduceMotion) {
      container.classList.remove('kb-view-enter');
      container.classList.add('kb-view-exit');
      await new Promise(resolve => setTimeout(resolve, 110));
      if (navToken !== this._navToken) return;
    }
    this._setProgress(true);

    // Dialogs and drawers live on <body>, outside the view; close them when leaving the view.
    // Also revoke in-memory object URLs created for decrypted CDN media blobs.
    if (isNewView) {
      if (typeof document !== 'undefined') {
        document.querySelectorAll('body > sl-dialog, body > sl-drawer').forEach(el => el.remove());
      }
      try {
        storage.revokeAllObjectURLs();
      } catch (_) {}
    }

    // Call active view cleanup if registered
    if (typeof this.activeCleanup === 'function') {
      try {
        this.activeCleanup();
      } catch (err) {
        console.error('Error during route view cleanup:', err);
      }
      this.activeCleanup = null;
    }

    // Match route handler
    const handler = this.routes[path] || (path === '#/home' ? this.routes['#/'] : null) || this.routes['#/'] || this.routes['#/flashcards'];
    if (handler && container) {
      try {
        const cleanup = await handler(params, this, container);
        if (typeof cleanup === 'function') {
          this.activeCleanup = cleanup;
        }
      } catch (err) {
        console.error(`Route error in ${path}:`, err);
        container.innerHTML = `
          <div class="p-8 max-w-xl mx-auto text-center space-y-4 bg-white rounded-2xl border border-slate-200 shadow-sm mt-8">
            <sl-icon name="exclamation-octagon" class="text-4xl text-red-500"></sl-icon>
            <h2 class="text-xl font-bold text-slate-800">Error Loading View</h2>
            <p class="text-sm text-slate-600">${Sanitizer.escapeHTML(err.message)}</p>
            <sl-button variant="primary" href="#/">Return Home</sl-button>
          </div>
        `;
      }
    }

    if (navToken !== this._navToken) return;
    this._setProgress(false);

    if (container) {
      container.classList.remove('kb-view-exit');
      if (isNewView) {
        this._lastViewKey = this._viewKey(path, params);
        if (!reduceMotion) {
          container.classList.remove('kb-view-enter');
          void container.offsetWidth; // restart animation
          container.classList.add('kb-view-enter');
          container.addEventListener('animationend', () => container.classList.remove('kb-view-enter'), { once: true });
        }
        if (typeof window.scrollTo === 'function') {
          try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (e) { window.scrollTo(0, 0); }
        }

        if (!this._initialLoad && typeof document !== 'undefined') {
          const openDialog = document.querySelector('sl-dialog[open], sl-drawer[open]');
          if (!openDialog && container) {
            requestAnimationFrame(() => {
              const h1 = container.querySelector('h1');
              if (h1) {
                h1.setAttribute('tabindex', '-1');
                h1.focus({ preventScroll: true });
              } else {
                container.focus({ preventScroll: true });
              }
            });
          }
        }
        this._initialLoad = false;
      }
    }
  }

  /** Views are distinguished by path plus the project id they display */
  _viewKey(path, params = {}) {
    return `${path}|${params.id || ''}`;
  }

  _setProgress(active) {
    if (typeof document === 'undefined') return;
    const bar = document.getElementById('kb-route-progress');
    if (!bar) return;
    clearTimeout(this._progressTimer);
    if (active) {
      // Only show for loads that take a noticeable moment
      this._progressTimer = setTimeout(() => bar.classList.add('is-active'), 120);
    } else {
      bar.classList.remove('is-active');
    }
  }

  /**
   * Remove share secrets (payload, key, hosted ref) from the address bar and session history as
   * soon as they are in memory, so they don't linger in history, screenshots or over a shoulder.
   */
  _scrubShareHash() {
    if (typeof window === 'undefined' || !window.history?.replaceState) return;
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, '', `${pathname}${search}#/share`);
  }

  async _handleShareRoute(params) {
    const shareParams = extractShareParams(params);
    store.setState('shareParams', shareParams);

    let effectiveParams = { ...params };

    // A bare #/share (e.g. Back after the payload was scrubbed) has nothing left to open
    if (!effectiveParams.d && !effectiveParams.ref) {
      if (typeof document !== 'undefined' && document.getElementById('sl-decrypt-dialog')) return;
      // Replace rather than push so the Back button doesn't bounce between #/share and home
      if (typeof window !== 'undefined') window.location.replace('#/');
      return;
    }
    this._scrubShareHash();

    if (effectiveParams.ref) {
      try {
        const transport = await getTransport();
        const hosted = await transport.fetchPayload(effectiveParams.ref);
        const rawJsonStr = await CryptoShareEngine.unwrapHosted(hosted.ciphertext, effectiveParams.k);
        const parsed = JSON.parse(rawJsonStr);
        if (parsed.d) {
          effectiveParams = { ...effectiveParams, ...CryptoShareEngine.parseShareFile(rawJsonStr) };
        } else {
          this._activateSharedPayload(parsed);
          return;
        }
      } catch (err) {
        toast.danger('Failed to load shared lesson from server: ' + (err.message || 'not found.'));
        this.navigate('#/');
        return;
      }
    }

    await this._openSharePayload(effectiveParams.d, effectiveParams.enc === '1', Number(effectiveParams.v) === 2 ? 2 : 1);
  }

  /**
   * Open a .kbshare file's contents (Home "Open file", OS file launch, share sheet).
   * @param {string} text
   */
  async openShareFile(text) {
    let file;
    try {
      file = CryptoShareEngine.parseShareFile(text);
    } catch (_) {
      toast.danger('This file is not a KennisBoost lesson (.kbshare).');
      return;
    }
    await this._openSharePayload(file.d, file.enc === '1', file.v);
  }

  async _openSharePayload(dParam, isEncrypted, version) {
    if (!dParam) {
      toast.danger('Invalid share link: missing data payload.');
      this.navigate('#/');
      return;
    }

    if (!isEncrypted) {
      try {
        const unpacked = await CryptoShareEngine.unpackSharePayload(dParam, false, '', version);
        this._activateSharedPayload(unpacked);
      } catch (err) {
        toast.danger(err.message === 'UNSUPPORTED_BROWSER'
          ? 'This browser is too old to open this lesson. Please update it or try Chrome, Edge, Firefox or Safari.'
          : 'Failed to load shared lesson: payload corrupted.');
        this.navigate('#/');
      }
      return;
    }

    // Attempt keychain auto-unlock with candidate access codes first
    const candidates = StudentProfile.candidateAccessCodes();
    for (const code of candidates) {
      try {
        const unpacked = await CryptoShareEngine.unpackSharePayload(dParam, true, code, version);
        if (unpacked) {
          toast.info('Unlocked automatically using your saved class access code.');
          this._activateSharedPayload(unpacked);
          return;
        }
      } catch (_) {}
    }

    // Encrypted payload: open decryption dialog
    this._renderDecryptionDialog(dParam, version);
  }

  _renderDecryptionDialog(dParam, version = 1) {
    if (typeof document === 'undefined') return;

    const existing = document.getElementById('sl-decrypt-dialog');
    if (existing) existing.remove();

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'sl-decrypt-dialog';
    dialog.label = 'Protected Lesson';
    dialog.setAttribute('no-header', '');

    dialog.innerHTML = `
      <div id="decrypt-dialog-body" class="p-4 space-y-4">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600">
            <sl-icon name="lock" class="text-xl"></sl-icon>
          </div>
          <div>
            <h3 class="font-bold text-slate-800 text-lg">Protected Educational Content</h3>
            <p class="text-xs text-slate-500">This content is encrypted with AES-256. Enter the access code or passphrase your teacher gave you.</p>
          </div>
        </div>

        <div class="space-y-1">
          <sl-input id="input-share-passphrase" type="password" password-toggle placeholder="Access code or passphrase" autofocus>
            <sl-icon name="key" slot="prefix"></sl-icon>
          </sl-input>
          <div id="decrypt-error-msg" class="text-xs text-red-600 font-medium hidden" aria-live="assertive"></div>
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <sl-button variant="default" id="btn-cancel-decrypt">Cancel</sl-button>
          <sl-button variant="primary" id="btn-submit-decrypt">Unlock Lesson</sl-button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    const input = dialog.querySelector('#input-share-passphrase');
    const submitBtn = dialog.querySelector('#btn-submit-decrypt');
    const cancelBtn = dialog.querySelector('#btn-cancel-decrypt');
    const errorMsg = dialog.querySelector('#decrypt-error-msg');
    const bodyContainer = dialog.querySelector('#decrypt-dialog-body');

    const attemptUnlock = async () => {
      const passphrase = input.value;
      if (!passphrase) {
        input.setAttribute('aria-invalid', 'true');
        return;
      }

      submitBtn.setAttribute('loading', '');
      try {
        // Access codes are printed as "K7M2-QX9P" but stored without punctuation; accept either
        const normalized = normalizeAccessCode(passphrase);
        const unpacked = await CryptoShareEngine.unpackSharePayload(dParam, true, passphrase, version)
          .catch(err => (normalized && normalized !== passphrase
            ? CryptoShareEngine.unpackSharePayload(dParam, true, normalized, version)
            : Promise.reject(err)));
        dialog.remove();
        toast.success('Lesson unlocked successfully!');
        this._activateSharedPayload(unpacked);
      } catch (err) {
        submitBtn.removeAttribute('loading');
        input.setAttribute('aria-invalid', 'true');
        errorMsg.textContent = 'Incorrect passphrase or corrupted payload.';
        errorMsg.classList.remove('hidden');

        // Apply shake animation
        bodyContainer.classList.add('kb-shake');
        setTimeout(() => bodyContainer.classList.remove('kb-shake'), 450);
      }
    };

    submitBtn.addEventListener('click', attemptUnlock);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attemptUnlock();
    });
    cancelBtn.addEventListener('click', () => {
      dialog.remove();
      this.navigate('#/flashcards');
    });
  }

  _activateSharedPayload(unpacked) {
    // Unpacked structure: { v: 1, type: 'flashcards' | 'timeline' | 'video' | 'gradebook' | 'student_grade_report', payload: ... }
    let type;
    let payload;
    try {
      ({ type, payload } = normalizeSharedEnvelope(unpacked));
    } catch (err) {
      console.warn('Rejected shared payload:', err.message);
      toast.danger('This shared link is not a valid KennisBoost lesson.');
      this.navigate('#/');
      return;
    }
    store.setState('ephemeralData', { type, payload });

    try {
      const itemId = payload?.assignment_id || payload?.id || (typeof crypto !== 'undefined' ? crypto.randomUUID() : 'shared-item');
      const courseId = payload?.course_id || payload?.course_meta?.course_id || null;
      const dueDate = payload?.due_date || payload?.settings?.due_date || null;
      storage.table('student_items').put({
        id: `${courseId || 'general'}_${itemId}`,
        course_id: courseId,
        item_id: itemId,
        kind: type,
        title: payload?.title || payload?.name || 'Shared Item',
        payload,
        due_date: dueDate,
        updated_at: new Date().toISOString()
      }).catch(() => {});
    } catch (_) {}

    const isStudent = type === 'assignment' || (type === 'video' && payload?.secure) || type === 'student_grade_report' || type === 'assignment_feedback';
    if (typeof document !== 'undefined' && document.body) {
      if (isStudent) {
        document.body.dataset.mode = 'student';
      } else {
        delete document.body.dataset.mode;
      }
    }

    this._renderEphemeralBanner(type, payload);

    // Route to appropriate module
    if (type === 'flashcards') {
      store.setState('activeDeck', payload);
      this.navigate('#/flashcards/study');
    } else if (type === 'timeline') {
      store.setState('activeTimeline', payload);
      this.navigate('#/timeline');
    } else if (type === 'video') {
      store.setState('activeVideo', payload);
      this.navigate('#/video?kiosk=1');
    } else if (type === 'student_grade_report') {
      StudentLedger.ingestGradeReport(payload).catch(console.error);
      RoleMode.set('student');
      this.navigate('#/student/gradebook');
    } else if (type === 'assignment_feedback') {
      StudentLedger.ingestAssignmentFeedback(payload).catch(console.error);
      RoleMode.set('student');
      toast.success(`Feedback for "${payload.assignment?.title || 'Assignment'}" added to your gradebook!`);
      this.navigate('#/student/gradebook');
    } else if (type === 'assignment') {
      this.navigate('#/assignments/take');
    } else if (type === 'gradebook') {
      store.setState('activeCourse', payload);
      this.navigate('#/gradebook');
    } else {
      this.navigate('#/flashcards');
    }
  }

  _renderEphemeralBanner(type, payload) {
    if (typeof document === 'undefined') return;
    // Grade reports and assignments are for viewing/answering only, never for copying into a library
    // (Video links are student copies without answer keys, so saving them as a project makes no sense)
    if (type === 'assignment' || type === 'student_grade_report' || type === 'assignment_feedback' || (type === 'video' && payload?.secure)) {
      document.getElementById('kb-ephemeral-banner')?.remove();
      return;
    }

    const existing = document.getElementById('kb-ephemeral-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'kb-ephemeral-banner';
    banner.className = 'bg-indigo-600 text-white px-4 py-2 flex items-center justify-between text-xs shadow-md z-40';
    banner.innerHTML = `
      <div class="flex items-center gap-2">
        <sl-icon name="cloud-download"></sl-icon>
        <span class="font-medium">Shared Lesson Loaded (Ephemeral Session)</span>
      </div>
      <div class="flex items-center gap-2">
        <button id="btn-save-shared-local" class="bg-white text-indigo-700 hover:bg-indigo-50 font-semibold px-3 py-1 rounded shadow-sm">
          Save to My Local Library
        </button>
        <button id="btn-dismiss-shared-banner" class="text-white hover:text-indigo-200 px-2 py-1">
          ✕
        </button>
      </div>
    `;

    banner.querySelector('#btn-save-shared-local')?.addEventListener('click', async () => {
      try {
        const { ContentImporter } = await import('./core/content-importer.js');
        const res = await ContentImporter.importRecordToLibrary(type, payload);
        store.setState('ephemeralData', null);
        banner.remove();
        toast.success(`Saved "${res.title || 'lesson'}" to local library!`);
        if (type === 'flashcards' && res.id) this.navigate(`#/flashcards/edit?id=${res.id}`);
        else if (type === 'timeline' && res.id) this.navigate(`#/timeline/edit?id=${res.id}`);
        else if (type === 'video' && res.id) this.navigate(`#/video/edit?id=${res.id}`);
        else if (type === 'assignment' && res.id) this.navigate(`#/assignments/edit?id=${res.id}`);
        else if (type === 'course_feed' && res.id) this.navigate(`#/course?courseId=${res.id}`);
        else if (type === 'gradebook' && res.id) this.navigate(`#/gradebook?courseId=${res.id}`);
      } catch (err) {
        console.error('Save shared failed:', err);
        toast.danger('Could not save to local library: ' + err.message);
      }
    });

    banner.querySelector('#btn-dismiss-shared-banner')?.addEventListener('click', () => {
      banner.remove();
    });

    const header = document.querySelector('header');
    if (header && header.parentNode) {
      header.parentNode.insertBefore(banner, header.nextSibling);
    } else {
      document.body.prepend(banner);
    }
  }

  _announceRouteChange(path) {
    if (typeof document === 'undefined') return;
    const announcer = document.getElementById('kb-aria-announcer');
    if (announcer) {
      const titles = {
        '#/': 'KennisBoost Home Hub',
        '#/home': 'KennisBoost Home Hub',
        '#/flashcards': 'Flashcards and Study Engine',
        '#/flashcards/study': 'Flashcard Review Session',
        '#/flashcards/game': 'Tower Defense Study Game',
        '#/timeline': 'Interactive Timeline Engine',
        '#/video': 'Video Assessment Platform',
        '#/about': 'About KennisBoost Tools',
        '#/inbox': 'Student Work Inbox',
        '#/feedback': 'Assignment Feedback',
        '#/gradebook': 'Browser Gradebook',
        '#/assignments': 'Assignments',
        '#/assignments/edit': 'Assignment Editor',
        '#/assignments/take': 'Assignment',
        '#/assignments/submissions': 'Assignment Submissions',
        '#/report': 'Student Grade Report',
        '#/classes': 'Classes & Rosters',
        '#/calendar': 'Interactive Calendar',
        '#/course': 'Course Syllabus & Units',
        '#/student/courses': 'My Enrolled Courses',
        '#/student/course': 'Course Details',
        '#/guide': 'Teacher Guide and Recommended Workflows',
        '#/share': 'Shared Lesson Decryption'
      };
      announcer.textContent = `Navigated to ${titles[path] || path}`;
    }
  }

  _updateNavUI(path) {
    if (typeof document === 'undefined') return;
    const navLinks = document.querySelectorAll('[data-route-link]');
    navLinks.forEach(link => {
      const target = link.getAttribute('data-route-link');
      let isActive = false;
      if (target === '#/') {
        isActive = (path === '#/' || path === '#/home' || path === '');
      } else {
        isActive = path.startsWith(target);
      }

      if (isActive) {
        link.classList.add('kb-nav-active');
        link.setAttribute('aria-current', 'page');
      } else {
        link.classList.remove('kb-nav-active');
        link.removeAttribute('aria-current');
      }
    });
  }
}

export const router = new Router();
export default router;
