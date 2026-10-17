import { storage } from './core/storage.js';
import { sync } from './core/sync.js';
import { router } from './router.js';
import { store } from './state/store.js';
import { toast } from './utils/toast.js';

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

async function loadGuideModule(...args) {
  const mod = await import('./modules/guide/index.js');
  return mod.renderGuideView(...args);
}

async function loadGradebookModule(...args) {
  const mod = await import('./modules/gradebook/index.js');
  return mod.renderGradebookView(...args);
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
    router.register('#/report', loadStudentReportModule);
    router.register('#/guide', loadGuideModule);

    // 4. Bind Storage / Backup Toolbar Actions & Global Customizations
    bindStorageControls();
    initThemeSwitcher();

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

  btnStorageInfo?.addEventListener('click', async () => {
    const quota = await storage.checkStorageQuota();
    const isEphemeral = storage.ephemeralMode;
    const isPersistent = await storage.getMetadata('is_persistent');

    const msg = `
      <div class="space-y-2 text-sm">
        <p><strong>Storage Mode:</strong> ${isEphemeral ? '<span class="text-amber-600 font-semibold">Ephemeral (Private Browsing)</span>' : '<span class="text-emerald-600 font-semibold">Persistent IndexedDB</span>'}</p>
        <p><strong>Durable Storage Granted:</strong> ${isPersistent ? 'Yes' : 'Browser Default'}</p>
        ${quota ? `<p><strong>Storage Usage:</strong> ${quota.usageMB} MB / ${quota.quotaMB} MB (${Math.round(quota.ratio * 100)}%)</p>` : ''}
      </div>
    `;

    const dialog = document.createElement('sl-dialog');
    dialog.label = 'Local Storage Status';
    dialog.innerHTML = `
      ${msg}
      <sl-button slot="footer" variant="primary" id="btn-close-storage-info">Close</sl-button>
    `;
    document.body.appendChild(dialog);
    dialog.show();

    dialog.querySelector('#btn-close-storage-info')?.addEventListener('click', () => dialog.remove());
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
