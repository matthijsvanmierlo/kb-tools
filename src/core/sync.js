import { storage } from './storage.js';
import { toast } from '../utils/toast.js';

/**
 * SyncManager - KB-CORE-002
 * File System Access API 5-second debounced auto-sync, fallback download,
 * and 72-hour stale backup modal alert.
 */
export class SyncManager {
  constructor(storageManager = storage) {
    this.storage = storageManager;
    this.fileHandle = null;
    this.debounceTimer = null;
    this.debounceDelayMs = 5000;
    this.isSyncing = false;
    this.lastSyncTimestamp = null;
  }

  /**
   * Boot-time initialization: restore saved file handle and run 72h stale backup check
   */
  async init() {
    try {
      const savedHandle = await this.storage.getMetadata('autosync_file_handle');
      if (savedHandle) {
        this.fileHandle = savedHandle;
      }
    } catch (e) {
      console.warn('Could not restore FileSystemFileHandle:', e);
    }

    // Subscribe to storage mutations for debounced auto-sync
    this.storage.onMutation(() => {
      this.triggerDebouncedSync();
    });

    // Check 72-hour stale backup status
    await this.checkStaleBackup();

    return this;
  }

  /**
   * Configure File System Access API auto-sync file
   */
  async configureAutoSyncFile() {
    if (typeof window === 'undefined' || !('showSaveFilePicker' in window)) {
      toast.warning('Auto-sync via File System API is not supported in this browser. Please use manual export.');
      return false;
    }

    try {
      this.fileHandle = await window.showSaveFilePicker({
        suggestedName: 'kennisboost_backup.json',
        types: [{
          description: 'KennisBoost JSON Archive',
          accept: { 'application/json': ['.json'] }
        }]
      });

      await this.storage.setMetadata('autosync_file_handle', this.fileHandle);
      toast.success('Auto-sync configured! Changes will save automatically after 5 seconds of inactivity.');
      
      // Perform immediate sync to initialize file
      await this.executeSync();
      return true;
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('File Picker error:', err);
        toast.danger('Failed to select auto-sync destination.');
      }
      return false;
    }
  }

  /**
   * Trigger a 5,000ms debounced sync
   */
  triggerDebouncedSync() {
    if (!this.fileHandle) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.executeSync();
    }, this.debounceDelayMs);
  }

  /**
   * Execute immediate write to the configured file handle
   */
  async executeSync() {
    if (!this.fileHandle || this.isSyncing) return false;

    try {
      this.isSyncing = true;

      // Verify permission
      if (this.fileHandle.queryPermission) {
        let permission = await this.fileHandle.queryPermission({ mode: 'readwrite' });
        if (permission === 'prompt') {
          this._renderReauthorizeBanner();
          this.isSyncing = false;
          return false;
        }
        if (permission !== 'granted') {
          this.isSyncing = false;
          return false;
        }
      }

      const snapshot = await this.storage.dumpMasterSnapshot();
      const jsonStr = JSON.stringify(snapshot, null, 2);

      const writable = await this.fileHandle.createWritable();
      await writable.write(jsonStr);
      await writable.close();

      const now = Date.now();
      this.lastSyncTimestamp = now;
      await this.storage.setMetadata('last_manual_export_timestamp', now);
      
      this._updateSyncIndicator('synced');
      return true;
    } catch (err) {
      console.error('Auto-sync write failed:', err);
      this._updateSyncIndicator('error');
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Fallback export mechanism generating a downloadable Blob
   */
  async exportManualBackup() {
    try {
      const snapshot = await this.storage.dumpMasterSnapshot();
      const jsonStr = JSON.stringify(snapshot, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });

      const dateStr = new Date().toISOString().split('T')[0];
      const filename = `kennisboost_backup_${dateStr}.json`;

      if (typeof document !== 'undefined') {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          a.remove();
          URL.revokeObjectURL(url);
        }, 100);
      }

      const now = Date.now();
      await this.storage.setMetadata('last_manual_export_timestamp', now);
      toast.success(`Backup exported successfully as ${filename}`);
      return blob;
    } catch (err) {
      console.error('Export manual backup failed:', err);
      toast.danger('Export failed.');
      throw err;
    }
  }

  /**
   * 72-Hour Stale Backup Check
   */
  async checkStaleBackup() {
    const lastExport = await this.storage.getMetadata('last_manual_export_timestamp');
    const snoozeUntil = await this.storage.getMetadata('snooze_backup_until');
    const now = Date.now();

    const THREE_DAYS_MS = 259200000; // 72 hours
    if (lastExport && (now - lastExport > THREE_DAYS_MS) && now > (snoozeUntil || 0)) {
      this._renderStaleBackupModal();
    }
  }

  _renderStaleBackupModal() {
    if (typeof document === 'undefined') return;

    const existing = document.getElementById('sl-stale-backup-dialog');
    if (existing) return;

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'sl-stale-backup-dialog';
    dialog.label = 'Data Backup Recommended';
    dialog.innerHTML = `
      <div class="space-y-4">
        <p class="text-sm text-slate-700">
          You have not backed up your local data in over 3 days. Would you like to export now?
        </p>
        <p class="text-xs text-slate-500">
          KennisBoost stores everything locally in your browser. Regular exports keep your flashcards, timelines, and grade records safe.
        </p>
      </div>
      <div slot="footer" class="flex gap-2 justify-end">
        <sl-button variant="default" id="btn-stale-dismiss">Dismiss</sl-button>
        <sl-button variant="neutral" id="btn-stale-snooze">Remind Tomorrow</sl-button>
        <sl-button variant="primary" id="btn-stale-export">Export Backup</sl-button>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    const exportBtn = dialog.querySelector('#btn-stale-export');
    const snoozeBtn = dialog.querySelector('#btn-stale-snooze');
    const dismissBtn = dialog.querySelector('#btn-stale-dismiss');

    exportBtn?.addEventListener('click', async () => {
      dialog.remove();
      await this.exportManualBackup();
    });

    snoozeBtn?.addEventListener('click', async () => {
      const tomorrow = Date.now() + 86400000; // 24 hours
      await this.storage.setMetadata('snooze_backup_until', tomorrow);
      dialog.remove();
      toast.info('Backup reminder postponed for 24 hours.');
    });

    dismissBtn?.addEventListener('click', () => {
      dialog.remove();
    });
  }

  _renderReauthorizeBanner() {
    if (typeof document === 'undefined') return;
    const existing = document.getElementById('kb-reauthorize-banner');
    if (existing) return;

    const banner = document.createElement('div');
    banner.id = 'kb-reauthorize-banner';
    banner.className = 'bg-amber-100 border-b border-amber-300 px-4 py-2 flex items-center justify-between text-xs text-amber-900';
    banner.innerHTML = `
      <span>Auto-sync file requires re-authorization to continue saving.</span>
      <button class="bg-amber-600 text-white font-medium px-3 py-1 rounded hover:bg-amber-700 focus:outline-none">
        Re-authorize Auto-Sync
      </button>
    `;

    banner.querySelector('button')?.addEventListener('click', async () => {
      if (this.fileHandle && this.fileHandle.requestPermission) {
        const res = await this.fileHandle.requestPermission({ mode: 'readwrite' });
        if (res === 'granted') {
          banner.remove();
          toast.success('Auto-sync re-authorized!');
          await this.executeSync();
        }
      }
    });

    document.body.prepend(banner);
  }

  _updateSyncIndicator(status) {
    if (typeof document === 'undefined') return;
    const indicator = document.getElementById('sync-status-indicator');
    if (!indicator) return;

    if (status === 'synced') {
      indicator.innerHTML = '<span class="text-xs text-emerald-600 font-medium">● Synced</span>';
    } else if (status === 'saving') {
      indicator.innerHTML = '<span class="text-xs text-amber-600 font-medium">● Saving...</span>';
    } else if (status === 'error') {
      indicator.innerHTML = '<span class="text-xs text-red-600 font-medium">● Sync Error</span>';
    }
  }
}

export const sync = new SyncManager();
export default sync;
