import { storage } from './core/storage.js';
import { sync } from './core/sync.js';
import { router } from './router.js';
import { store } from './state/store.js';
import { toast } from './utils/toast.js';

// Lazy-loaded or modular controller bindings
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
    router.register('#/flashcards', loadFlashcardsModule);
    router.register('#/flashcards/edit', loadFlashcardsModule);
    router.register('#/flashcards/study', loadFlashcardsModule);
    router.register('#/flashcards/game', loadFlashcardsModule);
    router.register('#/timeline', loadTimelineModule);
    router.register('#/video', loadVideoModule);
    router.register('#/gradebook', loadGradebookModule);

    // 4. Bind Storage / Backup Toolbar Actions
    bindStorageControls();

    // 5. Register PWA Service Worker (if available)
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.debug('ServiceWorker registration skipped/failed:', err);
      });
    }

    // 6. Execute initial route
    await router.handleRoute();

  } catch (err) {
    console.error('Fatal initialization error:', err);
    toast.danger(`Application boot failed: ${err.message}`);
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

// Bootstrap when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}
