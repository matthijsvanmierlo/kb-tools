import { storage } from './storage.js';
import { toast } from '../utils/toast.js';
import { isDeviceBoundKey, parseBackup } from './backup.js';
import { KeyVault } from './keyvault.js';
import {
  BACKUP_TARGET_METADATA, createAdapter, writeRotatedBackup, listBackups, FsaFileAdapter
} from './storage-adapters/index.js';

/**
 * SyncManager - KB-CORE-002
 * Debounced automatic backup to the teacher's chosen location (a synced folder, Google Drive,
 * OneDrive, or the original single auto-sync file; see storage-adapters/), fallback download,
 * and 72-hour stale backup modal alert. Every backup is encrypted first (keyvault.js).
 */
export class SyncManager {
  constructor(storageManager = storage) {
    this.storage = storageManager;
    this.fileHandle = null;
    this.adapter = null;
    this.debounceTimer = null;
    this.debounceDelayMs = 5000;
    this.isSyncing = false;
    this.pendingSync = false;
    this.lastSyncTimestamp = null;
  }

  /**
   * Writes that aren't user data. Syncing on them would loop forever (every sync stores its
   * own timestamp) or churn the file for nothing.
   */
  static isBookkeepingChange(change) {
    if (!change) return false;
    if (change.tableName === 'outbox') return true;
    if (change.tableName !== 'app_metadata') return false;
    const key = change.key ?? change.obj?.key;
    return key === 'last_manual_export_timestamp' || isDeviceBoundKey(key);
  }

  /** A real FileSystemFileHandle (a handle restored from an old JSON backup is a plain `{}`) */
  static isUsableHandle(handle) {
    return Boolean(handle && typeof handle.createWritable === 'function');
  }

  /**
   * Boot-time initialization: restore saved file handle and run 72h stale backup check
   */
  async init() {
    try {
      const savedHandle = await this.storage.getMetadata('autosync_file_handle');
      if (SyncManager.isUsableHandle(savedHandle)) {
        this.fileHandle = savedHandle;
        // Browsers forget the write grant between sessions; re-granting needs a click
        if (typeof savedHandle.queryPermission === 'function'
          && await savedHandle.queryPermission({ mode: 'readwrite' }) === 'prompt') {
          this._renderReauthorizeBanner();
        }
      } else if (savedHandle) {
        await this.storage.setMetadata('autosync_file_handle', null);
      }
    } catch (e) {
      console.warn('Could not restore FileSystemFileHandle:', e);
    }

    try {
      this.adapter = createAdapter(await this.storage.getMetadata(BACKUP_TARGET_METADATA), this.storage);
      if (this.adapter && await this.adapter.access({ interactive: false }) === 'prompt') {
        this._renderReauthorizeBanner();
      }
    } catch (e) {
      console.warn('Could not restore backup location:', e);
    }

    // Subscribe to storage mutations for debounced auto-sync
    this.storage.onMutation((change) => {
      if (SyncManager.isBookkeepingChange(change)) return;
      this.triggerDebouncedSync();
    });

    // Write pending changes right away when the tab is hidden or closed
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
          this.executeSync();
        }
      });
    }

    // Check 72-hour stale backup status
    await this.checkStaleBackup();

    return this;
  }

  /** The configured backup location, if any */
  activeAdapter() {
    if (this.adapter) return this.adapter;
    return this.fileHandle ? new FsaFileAdapter(this.fileHandle) : null;
  }

  hasAutomaticBackup() {
    return Boolean(this.activeAdapter());
  }

  /**
   * Make `adapter` the backup location (it must already have access) and write a first backup.
   * Replaces the legacy single auto-sync file.
   */
  async setBackupTarget(adapter) {
    this.adapter = adapter;
    this.fileHandle = null;
    await this.storage.setMetadata(BACKUP_TARGET_METADATA, adapter.toConfig());
    await this.storage.setMetadata('autosync_file_handle', null);
    if (typeof document !== 'undefined') document.getElementById('kb-reauthorize-banner')?.remove();
    const ok = await this.executeSync();
    if (ok) toast.success(`Automatic encrypted backups now go to ${adapter.label}.`);
    else toast.warning(`Could not write to ${adapter.label} yet. Check the backup status in the header.`);
    await this.promptRecoveryKitIfNeeded();
    return ok;
  }

  async clearBackupTarget() {
    this.adapter = null;
    this.fileHandle = null;
    await this.storage.setMetadata(BACKUP_TARGET_METADATA, null);
    await this.storage.setMetadata('autosync_file_handle', null);
  }

  /** Backups available in the configured location, newest first */
  async listLocationBackups(adapter = this.activeAdapter()) {
    if (!adapter) return [];
    return listBackups(adapter);
  }

  /** Every backup that leaves IndexedDB is encrypted under the teacher's recovery code */
  async buildBackupText() {
    const snapshot = await this.storage.dumpMasterSnapshot();
    return KeyVault.encryptBackup(this.storage, snapshot);
  }

  /** A backup is only useful on another device together with the recovery code */
  async promptRecoveryKitIfNeeded() {
    const status = await KeyVault.status(this.storage);
    if (status.recoveryKitSaved || typeof document === 'undefined') return;
    const { RecoveryKit } = await import('../components/recovery-kit.js');
    RecoveryKit.open();
  }

  /**
   * Open a backup file for restoring: decrypts v3 (with this device's key or the recovery code)
   * and validates the snapshot. Nothing is written yet.
   * @throws {VaultError|BackupError}
   */
  async openBackupFile(text, { recoveryCode = null } = {}) {
    if (!KeyVault.isEncryptedBackup(text)) {
      return { ...parseBackup(text), text, encrypted: false, vault: null, usedRecoveryCode: false };
    }
    const opened = await KeyVault.decryptBackup(this.storage, text, recoveryCode);
    return { ...parseBackup(opened.text), text: opened.text, encrypted: true, vault: opened.vault, usedRecoveryCode: opened.usedRecoveryCode };
  }

  /** Restore a backup returned by openBackupFile */
  async restoreOpenedBackup(opened) {
    await this.storage.restoreMasterSnapshot(opened.text);
    if (opened.vault) {
      await KeyVault.adoptBackupKey(this.storage, opened.vault, { usedRecoveryCode: opened.usedRecoveryCode });
    } else {
      // A plaintext backup's key is migrated into the vault on next use
      await KeyVault.forgetLocalTeacherKey(this.storage);
    }
  }

  /**
   * Trigger a 5,000ms debounced sync
   */
  triggerDebouncedSync() {
    const adapter = this.activeAdapter();
    if (!adapter) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this._updateSyncIndicator('pending');
    // Cloud APIs get fewer, larger writes than a local file
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.executeSync();
    }, Math.max(this.debounceDelayMs, adapter.minDebounceMs || 0));
  }

  /**
   * Execute immediate write to the configured file handle
   */
  async executeSync() {
    const adapter = this.activeAdapter();
    if (!adapter) return false;
    if (this.isSyncing) {
      // A change landed mid-write: write again once the current write finishes
      this.pendingSync = true;
      return false;
    }

    try {
      this.isSyncing = true;
      this.pendingSync = false;

      // Browsers forget folder grants between sessions and cloud tokens expire; re-granting needs a click
      const permission = await adapter.access({ interactive: false });
      if (permission === 'prompt') {
        this._renderReauthorizeBanner();
        return false;
      }
      if (permission !== 'granted') {
        this._updateSyncIndicator('error');
        return false;
      }

      this._updateSyncIndicator('saving');
      const jsonStr = await this.buildBackupText();
      await writeRotatedBackup(adapter, jsonStr, new Date());

      const now = Date.now();
      this.lastSyncTimestamp = now;
      await this.storage.setMetadata('last_manual_export_timestamp', now);

      this._updateSyncIndicator('synced');
      return true;
    } catch (err) {
      console.error('Auto-sync write failed:', err);
      if (err?.name === 'CloudAuthError') this._renderReauthorizeBanner();
      this._updateSyncIndicator('error');
      return false;
    } finally {
      this.isSyncing = false;
      if (this.pendingSync) {
        this.pendingSync = false;
        this.triggerDebouncedSync();
      }
    }
  }

  /**
   * Fallback export mechanism generating a downloadable Blob
   */
  async exportManualBackup() {
    try {
      const jsonStr = await this.buildBackupText();
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
      toast.success(`Encrypted backup exported as ${filename}`);
      await this.promptRecoveryKitIfNeeded();
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
        <sl-button variant="default" id="btn-stale-snooze">Remind Tomorrow</sl-button>
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
    const adapter = this.activeAdapter();
    if (!adapter) return;

    const banner = document.createElement('div');
    banner.id = 'kb-reauthorize-banner';
    banner.className = 'bg-amber-100 border-b border-amber-300 px-4 py-2 flex items-center justify-between text-xs text-amber-900';
    banner.innerHTML = `
      <span></span>
      <button class="bg-amber-600 text-white font-medium px-3 py-1 rounded hover:bg-amber-700 focus:outline-none">
        Reconnect
      </button>
    `;
    banner.querySelector('span').textContent = `Automatic backups to ${adapter.label} are paused until you reconnect. Your data is still safe in this browser.`;

    banner.querySelector('button')?.addEventListener('click', async () => {
      try {
        if (await adapter.access({ interactive: true }) === 'granted') {
          banner.remove();
          toast.success('Automatic backups resumed.');
          await this.executeSync();
        }
      } catch (err) {
        toast.danger(err?.message || 'Could not reconnect.');
      }
    });

    document.body.prepend(banner);
  }

  _updateSyncIndicator(status) {
    if (typeof document === 'undefined') return;
    const indicator = document.getElementById('sync-status-indicator');
    if (!indicator) return;

    if (status === 'synced') {
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      indicator.innerHTML = `<span class="text-xs text-emerald-600 font-medium" title="Encrypted backup saved at ${time}">● Synced</span>`;
    } else if (status === 'pending') {
      indicator.innerHTML = '<span class="text-xs text-slate-500 font-medium" title="Changes will be backed up in a few seconds">● Changes pending</span>';
    } else if (status === 'saving') {
      indicator.innerHTML = '<span class="text-xs text-amber-600 font-medium">● Saving...</span>';
    } else if (status === 'error') {
      indicator.innerHTML = '<span class="text-xs text-red-600 font-medium">● Sync Error</span>';
    }
  }
}

export const sync = new SyncManager();
export default sync;
