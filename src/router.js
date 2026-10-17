import { store } from './state/store.js';
import { CryptoShareEngine } from './core/crypto-share.js';
import { storage } from './core/storage.js';
import { toast } from './utils/toast.js';

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
    const rawHash = (typeof window !== 'undefined' ? window.location.hash : '') || '#/flashcards';
    const [pathPart, queryPart] = rawHash.split('?');
    const path = pathPart.toLowerCase() || '#/flashcards';

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
    if (typeof window !== 'undefined' && !window.location.hash) {
      window.location.hash = '#/flashcards';
      return;
    }

    const { path, params } = this.parseHash();
    this.currentPath = path;
    this.currentParams = params;

    store.setState('currentRoute', path);

    // Update screen reader announcement
    this._announceRouteChange(path);

    // Update navigation bar active states
    this._updateNavUI(path);

    // Handle share route specially
    if (path === '#/share') {
      await this._handleShareRoute(params);
      return;
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
    const handler = this.routes[path] || this.routes['#/flashcards'];
    if (handler) {
      const container = document.getElementById('app-view-container');
      if (container) {
        try {
          const cleanup = await handler(params, this, container);
          if (typeof cleanup === 'function') {
            this.activeCleanup = cleanup;
          }
        } catch (err) {
          console.error(`Route error in ${path}:`, err);
          container.innerHTML = `
            <div class="p-8 max-w-xl mx-auto text-center space-y-4">
              <sl-icon name="exclamation-octagon" class="text-4xl text-red-500"></sl-icon>
              <h2 class="text-xl font-bold text-slate-800">Error Loading View</h2>
              <p class="text-sm text-slate-600">${err.message}</p>
              <sl-button variant="primary" onclick="window.location.hash='#/flashcards'">Return Home</sl-button>
            </div>
          `;
        }
      }
    }
  }

  async _handleShareRoute(params) {
    const isEncrypted = params.enc === '1';
    const dParam = params.d;

    if (!dParam) {
      toast.danger('Invalid share link: missing data payload.');
      this.navigate('#/flashcards');
      return;
    }

    if (!isEncrypted) {
      try {
        const unpacked = await CryptoShareEngine.unpackSharePayload(dParam, false);
        this._activateSharedPayload(unpacked);
      } catch (err) {
        toast.danger('Failed to load shared lesson: payload corrupted.');
        this.navigate('#/flashcards');
      }
      return;
    }

    // Encrypted payload: open decryption dialog
    this._renderDecryptionDialog(dParam);
  }

  _renderDecryptionDialog(dParam) {
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
            <p class="text-xs text-slate-500">This lesson is encrypted with AES-256. Enter the passphrase to unlock.</p>
          </div>
        </div>

        <div class="space-y-1">
          <sl-input id="input-share-passphrase" type="password" password-toggle placeholder="Passphrase or Student ID" autofocus>
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
        const unpacked = await CryptoShareEngine.unpackSharePayload(dParam, true, passphrase);
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
    const { type, payload } = unpacked;
    store.setState('ephemeralData', { type, payload });

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
    } else if (type === 'gradebook' || type === 'student_grade_report') {
      store.setState('activeCourse', payload);
      this.navigate('#/gradebook');
    } else {
      this.navigate('#/flashcards');
    }
  }

  _renderEphemeralBanner(type, payload) {
    if (typeof document === 'undefined') return;

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
        if (type === 'flashcards') {
          const table = storage.table('flashcards');
          const item = { ...payload, id: crypto.randomUUID(), updated_at: new Date().toISOString() };
          await table.put(item);
          toast.success('Deck saved to local library!');
        } else if (type === 'timeline') {
          const table = storage.table('timelines');
          const item = { ...payload, id: crypto.randomUUID(), updated_at: new Date().toISOString() };
          await table.put(item);
          toast.success('Timeline saved to local library!');
        } else if (type === 'video') {
          const table = storage.table('video_assessments');
          const item = { ...payload, id: crypto.randomUUID(), updated_at: new Date().toISOString() };
          await table.put(item);
          toast.success('Video assessment saved to local library!');
        }
        banner.remove();
      } catch (err) {
        console.error('Save shared failed:', err);
        toast.danger('Could not save to local library.');
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
        '#/flashcards': 'Flashcards and Study Engine',
        '#/flashcards/study': 'Flashcard Review Session',
        '#/flashcards/game': 'Tower Defense Study Game',
        '#/timeline': 'Interactive Timeline Engine',
        '#/video': 'Video Assessment Platform',
        '#/gradebook': 'Browser Gradebook',
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
      if (path.startsWith(target)) {
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
