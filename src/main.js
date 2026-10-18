import { storage } from './core/storage.js';
import { sync } from './core/sync.js';
import { router } from './router.js';
import { store } from './state/store.js';
import { toast } from './utils/toast.js';
import { getTransport, setTransportConfig, RelayTransport } from './core/transport.js';

// Lazy-loaded or modular controller bindings
async function loadHomeModule(...args) {
  const mod = await import('./modules/home/index.js');
  return mod.renderHomeView(...args);
}

async function loadFlashcardsModule(...args) {
  const mod = await import('./modules/flashcards/index.js');
  return mod.renderFlashcardsView(...args);
}

async function loadTimelineModule(...args) {
  const mod = await import('./modules/timeline/index.js');
  return mod.renderTimelineView(...args);
}

async function loadVideoModule(...args) {
  const mod = await import('./modules/video/index.js');
  return mod.renderVideoView(...args);
}

async function loadAssignmentsModule(...args) {
  const mod = await import('./modules/assignments/index.js');
  return mod.renderAssignmentsView(...args);
}

async function loadStudentReportModule(...args) {
  const mod = await import('./modules/gradebook/student-report.js');
  return mod.renderStudentReportView(...args);
}

async function loadAboutModule(...args) {
  const mod = await import('./modules/about/index.js');
  return mod.renderAboutView(...args);
}

async function loadInboxModule(...args) {
  const mod = await import('./modules/inbox/index.js');
  return mod.renderInboxView(...args);
}

async function loadGuideModule(...args) {
  const mod = await import('./modules/guide/index.js');
  return mod.renderGuideView(...args);
}

async function loadGradebookModule(...args) {
  const mod = await import('./modules/gradebook/index.js');
  return mod.renderGradebookView(...args);
}

async function loadFeedbackModule(...args) {
  const mod = await import('./modules/assignments/feedback-view.js');
  return mod.renderFeedbackView(...args);
}

/**
 * Initialize application services and DOM event bindings
 */
async function bootstrapApp() {
  try {
    // 1. Initialize core storage & OPFS
    await storage.init();

    // 2. Initialize sync engine & check 72h backup
    await sync.init();

    // 3. Register module routes
    router.register('#/', loadHomeModule);
    router.register('#/home', loadHomeModule);
    router.register('#/about', loadAboutModule);
    router.register('#/flashcards', loadFlashcardsModule);
    router.register('#/flashcards/edit', loadFlashcardsModule);
    router.register('#/flashcards/study', loadFlashcardsModule);
    router.register('#/flashcards/game', loadFlashcardsModule);
    router.register('#/timeline', loadTimelineModule);
    router.register('#/timeline/view', loadTimelineModule);
    router.register('#/video', loadVideoModule);
    router.register('#/video/edit', loadVideoModule);
    router.register('#/video/kiosk', loadVideoModule);
    router.register('#/gradebook', loadGradebookModule);
    router.register('#/assignments', loadAssignmentsModule);
    router.register('#/assignments/edit', loadAssignmentsModule);
    router.register('#/assignments/take', loadAssignmentsModule);
    router.register('#/assignments/submissions', loadAssignmentsModule);
    router.register('#/inbox', loadInboxModule);
    router.register('#/report', loadStudentReportModule);
    router.register('#/feedback', loadFeedbackModule);
    router.register('#/guide', loadGuideModule);

    // Global drag-and-drop listener for home and assignments navigating to #/inbox (§6.4)
    if (typeof window !== 'undefined') {
      window.addEventListener('dragover', (e) => {
        const hash = window.location.hash || '#/';
        if (hash === '#/' || hash === '#/home' || hash.startsWith('#/assignments')) {
          if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
          }
        }
      });
      window.addEventListener('drop', (e) => {
        const hash = window.location.hash || '#/';
        if (hash === '#/' || hash === '#/home' || hash === '#/assignments') {
          const files = Array.from(e.dataTransfer?.files || []);
          if (files.length > 0) {
            e.preventDefault();
            store.setState('inboxDrop', files);
            router.navigate('#/inbox');
          }
        }
      });
    }

    // 4. Bind Storage / Backup Toolbar Actions & Global Customizations
    bindStorageControls();
    bindHelpControls();
    initThemeSwitcher();
    updateRelayStatusIndicator();
    window.addEventListener('kb-transport-changed', () => {
      updateRelayStatusIndicator();
    });

    // 5. Initialize Class Selector in Navigation
    const { ClassManager } = await import('./components/class-manager.js');
    const classContainer = document.getElementById('kb-nav-class-selector');
    if (classContainer) {
      await ClassManager.renderGlobalNavSelector(classContainer);
      window.addEventListener('kb-class-filter-changed', () => {
        router.handleRoute();
      });
    }

    // 6. Initialize Command Palette (Ctrl+K & ?)
    const { CommandPalette } = await import('./components/command-palette.js');
    CommandPalette.init();

    // 7. Register PWA Service Worker (if available)
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.debug('ServiceWorker registration skipped/failed:', err);
      });
    }

    // 8. Execute initial route
    await router.handleRoute();

  } catch (err) {
    console.error('Fatal initialization error:', err);
    toast.danger(`Application boot failed: ${err.message}`);
    const container = document.getElementById('app-view-container');
    if (container) {
      container.innerHTML = `
        <div class="p-8 max-w-xl mx-auto text-center space-y-4 bg-white rounded-2xl border border-red-200 shadow-sm mt-8">
          <sl-icon name="exclamation-octagon" class="text-4xl text-red-500"></sl-icon>
          <h2 class="text-xl font-bold text-slate-800">Application Boot Failed</h2>
          <p class="text-sm text-slate-600">${err.message}</p>
          <sl-button variant="primary" onclick="window.location.reload()">Reload Application</sl-button>
        </div>
      `;
    }
  }
}

function bindStorageControls() {
  const btnConfigureSync = document.getElementById('menu-btn-configure-sync');
  const btnExportBackup = document.getElementById('menu-btn-export-backup');
  const btnImportBackup = document.getElementById('menu-btn-import-backup');
  const btnStorageInfo = document.getElementById('menu-btn-storage-info');
  const fileInput = document.getElementById('input-backup-file');

  btnConfigureSync?.addEventListener('click', async () => {
    await sync.configureAutoSyncFile();
  });

  btnExportBackup?.addEventListener('click', async () => {
    await sync.exportManualBackup();
  });

  btnImportBackup?.addEventListener('click', () => {
    fileInput?.click();
  });

  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const snapshot = JSON.parse(text);
      await storage.restoreMasterSnapshot(snapshot);
      toast.success('Backup restored successfully! Refreshing view...');
      await router.handleRoute();
    } catch (err) {
      console.error('Failed to restore backup:', err);
      toast.danger('Invalid backup file. Restore aborted.');
    } finally {
      fileInput.value = '';
    }
  });

  const btnRelayConnect = document.getElementById('menu-btn-relay-connect');
  btnRelayConnect?.addEventListener('click', () => {
    openRelayConfigDialog();
  });

  btnStorageInfo?.addEventListener('click', async () => {
    const quota = await storage.checkStorageQuota();
    const isEphemeral = storage.ephemeralMode;
    const isPersistent = await storage.getMetadata('is_persistent');

    const tables = [
      'gradebook_courses', 'gradebook_students', 'gradebook_assignments',
      'gradebook_grades', 'gradebook_rubrics', 'assignments',
      'assignment_submissions', 'flashcards', 'timelines', 'video_assessments'
    ];
    const tableCounts = {};
    for (const t of tables) {
      try {
        tableCounts[t] = await storage.table(t).count();
      } catch (e) {
        tableCounts[t] = 0;
      }
    }

    const msg = `
      <div class="space-y-3 text-sm">
        <div>
          <p><strong>Storage Mode:</strong> ${isEphemeral ? '<span class="text-amber-600 font-semibold">Ephemeral (Private Browsing)</span>' : '<span class="text-emerald-600 font-semibold">Persistent IndexedDB</span>'}</p>
          <p><strong>Durable Storage Granted:</strong> ${isPersistent ? 'Yes' : 'Browser Default'}</p>
          ${quota ? `<p><strong>Storage Usage:</strong> ${quota.usageMB} MB / ${quota.quotaMB} MB (${Math.round(quota.ratio * 100)}%)</p>` : ''}
        </div>
        <div class="pt-2 border-t border-slate-200">
          <p class="font-semibold text-xs text-slate-700 uppercase tracking-wider mb-2">Stored Record Counts</p>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
            ${tables.map(t => `<div class="flex justify-between py-0.5 border-b border-slate-100"><span class="font-mono">${t}</span><span class="font-bold text-slate-800">${tableCounts[t] ?? 0}</span></div>`).join('')}
          </div>
        </div>
      </div>
    `;

    const dialog = document.createElement('sl-dialog');
    dialog.label = 'Local Storage Status & Record Counts';
    dialog.innerHTML = `
      ${msg}
      <sl-button slot="footer" variant="primary" id="btn-close-storage-info">Close</sl-button>
    `;
    document.body.appendChild(dialog);
    dialog.show();

    dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
    dialog.querySelector('#btn-close-storage-info')?.addEventListener('click', () => dialog.hide());
  });
}

export async function openRelayConfigDialog() {
  const currentConfig = (await storage.getMetadata('sync_config')) || (typeof window !== 'undefined' ? window.KB_CONFIG : null) || {};
  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Connect to a school server';
  dialog.style.setProperty('--width', '520px');
  dialog.innerHTML = `
    <div class="space-y-4 text-sm">
      <p class="text-xs text-slate-500 leading-relaxed">
        Connecting to a school-hosted KennisBoost relay server unlocks short links and automatic server-assisted hand-in. All lesson payloads and student submissions remain end-to-end encrypted so the server never sees student data or answer keys.
      </p>
      <sl-input id="input-relay-url" label="Server Base URL" placeholder="https://relay.myschool.edu or http://localhost:3000" value="${currentConfig.baseUrl || ''}"></sl-input>
      <sl-input id="input-relay-token" type="password" password-toggle label="Teacher Bearer Token" placeholder="Paste 64-character token" value="${currentConfig.token || ''}"></sl-input>
      <sl-input id="input-relay-teacher-id" label="Teacher ID (optional)" placeholder="e.g. T-101" value="${currentConfig.teacherId || ''}"></sl-input>

      <div id="relay-test-result" class="hidden p-3 rounded-xl text-xs space-y-1"></div>
    </div>
    <div slot="footer" class="flex flex-wrap justify-between items-center gap-2">
      ${currentConfig.baseUrl ? `<sl-button variant="danger" size="small" id="btn-relay-disconnect">Disconnect</sl-button>` : `<span></span>`}
      <div class="flex gap-2">
        <sl-button size="small" id="btn-relay-test">Test connection</sl-button>
        <sl-button variant="primary" size="small" id="btn-relay-save">Save</sl-button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  const urlInput = dialog.querySelector('#input-relay-url');
  const tokenInput = dialog.querySelector('#input-relay-token');
  const idInput = dialog.querySelector('#input-relay-teacher-id');
  const testResult = dialog.querySelector('#relay-test-result');

  dialog.querySelector('#btn-relay-test')?.addEventListener('click', async () => {
    const btn = dialog.querySelector('#btn-relay-test');
    btn.loading = true;
    testResult.classList.add('hidden');
    try {
      const baseUrl = urlInput.value.trim();
      const token = tokenInput.value.trim();
      if (!baseUrl) throw new Error('Please enter a server base URL');
      const tempRelay = new RelayTransport({ baseUrl, token });
      const health = await tempRelay.health();
      if (!health.ok) throw new Error(health.error || 'Server health check failed');
      testResult.className = 'p-3 rounded-xl text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 space-y-1';
      testResult.innerHTML = `
        <div class="font-semibold flex items-center gap-1.5"><sl-icon name="check-circle-fill" class="text-emerald-600"></sl-icon> Server online! (v${health.serverVersion || '1.0.0'})</div>
        <div class="text-[11px] text-emerald-700">Supported features: ${(health.features || ['payloads', 'drops']).join(', ')}</div>
      `;
      testResult.classList.remove('hidden');
    } catch (err) {
      testResult.className = 'p-3 rounded-xl text-xs bg-rose-50 border border-rose-200 text-rose-800';
      testResult.innerHTML = `<div class="font-semibold flex items-center gap-1.5"><sl-icon name="exclamation-octagon-fill" class="text-rose-600"></sl-icon> Connection error</div><div class="text-[11px] text-rose-700">${err.message}</div>`;
      testResult.classList.remove('hidden');
    } finally {
      btn.loading = false;
    }
  });

  dialog.querySelector('#btn-relay-save')?.addEventListener('click', async () => {
    const baseUrl = urlInput.value.trim();
    const token = tokenInput.value.trim();
    const teacherId = idInput.value.trim();
    if (!baseUrl) {
      toast.danger('Base URL is required.');
      return;
    }
    await setTransportConfig({ baseUrl, token, teacherId });
    toast.success('School server connected successfully!');
    dialog.hide();
    updateRelayStatusIndicator();
  });

  dialog.querySelector('#btn-relay-disconnect')?.addEventListener('click', async () => {
    await setTransportConfig(null);
    toast.info('Disconnected from school server.');
    dialog.hide();
    updateRelayStatusIndicator();
  });

  dialog.addEventListener('sl-after-hide', () => dialog.remove());
}

export async function updateRelayStatusIndicator() {
  if (typeof document === 'undefined') return;
  const indicator = document.getElementById('sync-status-indicator');
  if (!indicator) return;
  try {
    const transport = await getTransport();
    if (transport && transport.capabilities.hostPayload) {
      indicator.innerHTML = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-medium border border-emerald-200" title="Connected to school relay server"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>Server: connected</span>`;
      return;
    }
  } catch {}
  if (indicator.textContent.includes('Server:')) {
    indicator.innerHTML = '';
  }
}

function bindHelpControls() {
  const helpMenu = document.getElementById('kb-help-menu');
  helpMenu?.addEventListener('sl-select', async (e) => {
    const val = e.detail.item.value;
    if (val === 'guide') {
      router.navigate('#/guide');
    } else if (val === 'about') {
      router.navigate('#/about');
    } else if (val === 'shortcuts') {
      document.getElementById('menu-btn-keyboard-shortcuts')?.click();
    } else if (val === 'load-sample') {
      const { loadDemoWorkspace } = await import('./core/demo.js');
      await loadDemoWorkspace();
      toast.success('Sample workspace loaded!');
      router.handleRoute();
    } else if (val === 'remove-sample') {
      const { removeDemoData } = await import('./core/demo.js');
      await removeDemoData();
      toast.info('Sample data removed.');
      router.handleRoute();
    }
  });
}

const THEME_ICONS = { light: 'sun', dark: 'moon-stars', system: 'circle-half', projector: 'projector' };
const THEME_LABELS = { light: 'Light', dark: 'Dark', system: 'System', projector: 'Projector' };

function initThemeSwitcher() {
  const themeMenu = document.getElementById('kb-theme-menu');
  const themeIcon = document.getElementById('icon-active-theme');
  const html = document.documentElement;
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)');
  let current = 'system';

  const applyTheme = (theme) => {
    current = THEME_ICONS[theme] ? theme : 'system';
    const isDark = current === 'dark' || (current === 'system' && !!systemDark?.matches);
    html.classList.remove('sl-theme-light', 'sl-theme-dark', 'kb-theme-projector');
    html.classList.add(isDark ? 'sl-theme-dark' : 'sl-theme-light');
    if (current === 'projector') html.classList.add('kb-theme-projector');

    if (themeIcon) themeIcon.name = THEME_ICONS[current];
    themeMenu?.querySelectorAll('sl-menu-item').forEach(item => {
      item.checked = item.value === current;
    });
    window.dispatchEvent(new CustomEvent('kb-theme-changed', { detail: { theme: current, isDark } }));

    try {
      localStorage.setItem('kb_theme_mode', current);
    } catch (e) {}
  };

  let savedTheme = 'system';
  try {
    savedTheme = localStorage.getItem('kb_theme_mode') || 'system';
  } catch (e) {}
  applyTheme(savedTheme);

  systemDark?.addEventListener?.('change', () => {
    if (current === 'system') applyTheme('system');
  });

  themeMenu?.addEventListener('sl-select', (e) => {
    const selected = e.detail.item.value;
    if (selected) {
      applyTheme(selected);
      toast.info(`Theme: ${THEME_LABELS[selected]}`);
    }
  });
}

// Bootstrap when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}
