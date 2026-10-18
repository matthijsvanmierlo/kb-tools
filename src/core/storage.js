import Dexie from 'dexie';
import { splitName } from './names.js';
import {
  BACKUP_TABLES, BACKUP_VERSION, DEVICE_BOUND_METADATA, parseBackup, stripDeviceMetadata, blobToBase64, base64ToBlob
} from './backup.js';

const DATA_TABLES = new Set([
  'flashcards',
  'timelines',
  'video_assessments',
  'gradebook_courses',
  'gradebook_students',
  'gradebook_assignments',
  'gradebook_grades',
  'gradebook_rubrics',
  'assignments',
  'assignment_submissions'
]);

/**
 * Wrap a Dexie table with stamping (created_at, updated_at, id) and outbox logging.
 */
function wrapDexieTable(rawTable, tableName, storageManager) {
  if (!DATA_TABLES.has(tableName)) return rawTable;

  return new Proxy(rawTable, {
    get(target, prop, receiver) {
      if (prop === 'put') {
        return async (record, ...rest) => {
          const now = new Date().toISOString();
          record.updated_at = now;
          record.created_at = record.created_at || now;
          if (!record.id) {
            record.id = crypto.randomUUID();
          }

          if (storageManager._outboxEnabled && target.db.outbox) {
            const key = tableName === 'gradebook_grades'
              ? [record.student_id, record.assignment_id]
              : (record.id || record.key);
            return target.db.transaction('rw', [target, target.db.outbox], async () => {
              const res = await target.put(record, ...rest);
              await target.db.outbox.add({
                table: tableName,
                key,
                op: 'put',
                record,
                created_at: now,
                pushed_at: null,
                device_id: storageManager.deviceId || null
              });
              return res;
            });
          }
          return target.put(record, ...rest);
        };
      }

      if (prop === 'bulkPut') {
        return async (records, ...rest) => {
          const now = new Date().toISOString();
          for (const r of records) {
            r.updated_at = now;
            r.created_at = r.created_at || now;
            if (!r.id) {
              r.id = crypto.randomUUID();
            }
          }

          if (storageManager._outboxEnabled && target.db.outbox) {
            return target.db.transaction('rw', [target, target.db.outbox], async () => {
              const res = await target.bulkPut(records, ...rest);
              for (const r of records) {
                const key = tableName === 'gradebook_grades'
                  ? [r.student_id, r.assignment_id]
                  : (r.id || r.key);
                await target.db.outbox.add({
                  table: tableName,
                  key,
                  op: 'put',
                  record: r,
                  created_at: now,
                  pushed_at: null,
                  device_id: storageManager.deviceId || null
                });
              }
              return res;
            });
          }
          return target.bulkPut(records, ...rest);
        };
      }

      if (prop === 'delete') {
        return async (key, ...rest) => {
          if (storageManager._outboxEnabled && target.db.outbox) {
            const now = new Date().toISOString();
            return target.db.transaction('rw', [target, target.db.outbox], async () => {
              const res = await target.delete(key, ...rest);
              await target.db.outbox.add({
                table: tableName,
                key,
                op: 'delete',
                created_at: now,
                pushed_at: null,
                device_id: storageManager.deviceId || null
              });
              return res;
            });
          }
          return target.delete(key, ...rest);
        };
      }

      if (prop === 'bulkDelete') {
        return async (keys, ...rest) => {
          if (storageManager._outboxEnabled && target.db.outbox) {
            const now = new Date().toISOString();
            return target.db.transaction('rw', [target, target.db.outbox], async () => {
              const res = await target.bulkDelete(keys, ...rest);
              for (const key of keys) {
                await target.db.outbox.add({
                  table: tableName,
                  key,
                  op: 'delete',
                  created_at: now,
                  pushed_at: null,
                  device_id: storageManager.deviceId || null
                });
              }
              return res;
            });
          }
          return target.bulkDelete(keys, ...rest);
        };
      }

      if (prop === 'clear') {
        return async (...rest) => {
          if (storageManager._outboxEnabled && target.db.outbox) {
            const now = new Date().toISOString();
            return target.db.transaction('rw', [target, target.db.outbox], async () => {
              const res = await target.clear(...rest);
              await target.db.outbox.add({
                table: tableName,
                key: '*',
                op: 'clear',
                created_at: now,
                pushed_at: null,
                device_id: storageManager.deviceId || null
              });
              return res;
            });
          }
          return target.clear(...rest);
        };
      }

      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });
}

/** Below this quota the profile is most likely a guest/ephemeral one (normal profiles get GBs) */
export const TEMPORARY_PROFILE_QUOTA_BYTES = 120 * 1024 * 1024;

export function isTemporaryProfileQuota(estimate) {
  return Boolean(estimate && estimate.quota > 0 && estimate.quota < TEMPORARY_PROFILE_QUOTA_BYTES);
}

/**
 * StorageManager - KB-CORE-001
 * Manages IndexedDB via Dexie.js, OPFS for large binary blobs (>64KB),
 * ephemeral memory fallback for private browsing, and storage quota monitoring.
 */
export class StorageManager {
  constructor() {
    this.db = new Dexie('KennisBoostDB');
    this.ephemeralMode = false;
    this.memoryStore = new Map();
    this.objectUrls = new Set();
    this.mutationListeners = new Set();
    this._outboxEnabled = true;
    this.deviceId = null;

    this.db.version(1).stores({
      flashcards: 'id, title, updated_at',
      timelines: 'id, title, updated_at',
      video_assessments: 'id, title, updated_at',
      gradebook_courses: 'id, name, academic_year',
      gradebook_students: 'id, course_id, student_id, full_name',
      gradebook_assignments: 'id, course_id, term_id, category, due_date',
      gradebook_grades: '[student_id+assignment_id], course_id, student_id, assignment_id, status',
      gradebook_rubrics: 'id, course_id, title',
      app_metadata: 'key',
      binary_blobs: 'id, mime_type, size_bytes'
    });

    this.db.version(2).stores({
      flashcards: 'id, title, class_id, updated_at',
      timelines: 'id, title, class_id, updated_at',
      video_assessments: 'id, title, class_id, updated_at',
      gradebook_courses: 'id, name, section, academic_year, updated_at',
      gradebook_students: 'id, course_id, student_id, full_name',
      gradebook_assignments: 'id, course_id, term_id, category_id, due_date',
      gradebook_grades: '[student_id+assignment_id], course_id, student_id, assignment_id, status',
      gradebook_rubrics: 'id, course_id, title',
      app_metadata: 'key',
      binary_blobs: 'id, mime_type, size_bytes'
    }).upgrade(async tx => {
      await tx.table('flashcards').toCollection().modify(deck => {
        deck.class_id = deck.class_id || null;
        if (Array.isArray(deck.cards)) {
          deck.cards = deck.cards.map(c => ({
            ...c,
            front: typeof c.front === 'string'
              ? { text: c.front, ttsLang: c.tts_lang || 'en-US', sketchData: c.sketch_data || undefined }
              : c.front,
            back: typeof c.back === 'string'
              ? { text: c.back, ttsLang: c.tts_lang || 'en-US', sketchData: undefined }
              : c.back
          }));
        }
      });
      await tx.table('timelines').toCollection().modify(t => {
        t.class_id = t.class_id || null;
        t.updated_at = t.updated_at || new Date().toISOString();
      });
      await tx.table('video_assessments').toCollection().modify(v => {
        v.class_id = v.class_id || null;
        v.updated_at = v.updated_at || new Date().toISOString();
      });
      await tx.table('gradebook_courses').toCollection().modify(c => {
        c.color = c.color || '#2563eb';
        c.section = c.section || 'Section 1';
        c.updated_at = c.updated_at || new Date().toISOString();
      });
    });

    // v3: Assignments module and submissions
    this.db.version(3).stores({
      assignments: 'id, title, class_id, updated_at',
      assignment_submissions: 'id, assignment_id, student_id, submitted_at'
    });

    // v4: Data model upgrade with timestamps, archived_at, sis, stable id for grades, outbox
    this.db.version(4).stores({
      gradebook_courses:      'id, name, section, academic_year, updated_at, archived_at',
      gradebook_students:     'id, course_id, student_id, full_name, email, updated_at, [course_id+student_id]',
      gradebook_assignments:  'id, course_id, term_id, category_id, due_date, updated_at',
      gradebook_grades:       '[student_id+assignment_id], id, course_id, student_id, assignment_id, status, updated_at',
      gradebook_rubrics:      'id, course_id, title, updated_at',
      assignments:            'id, title, class_id, updated_at',
      assignment_submissions: 'id, assignment_id, student_id, submitted_at, synced_at, updated_at, [assignment_id+student_id]',
      flashcards:             'id, title, class_id, updated_at',
      timelines:              'id, title, class_id, updated_at',
      video_assessments:      'id, title, class_id, updated_at',
      outbox:                 '++seq, table, op, created_at, pushed_at'
    }).upgrade(async (tx) => {
      const now = new Date().toISOString();
      const stamp = (r) => {
        r.created_at = r.created_at || r.updated_at || now;
        r.updated_at = r.updated_at || now;
      };
      for (const name of [
        'gradebook_courses', 'gradebook_students', 'gradebook_assignments',
        'gradebook_rubrics', 'assignments', 'assignment_submissions',
        'flashcards', 'timelines', 'video_assessments'
      ]) {
        await tx.table(name).toCollection().modify(stamp);
      }
      await tx.table('gradebook_grades').toCollection().modify((g) => {
        g.id = g.id || crypto.randomUUID();
        stamp(g);
      });
      await tx.table('gradebook_students').toCollection().modify((s) => {
        if (!s.given_name && !s.family_name && s.full_name) {
          const n = splitName(s.full_name);
          s.given_name = n.given;
          s.family_name = n.family;
        }
      });
    });

    // Initialize in-memory tables for ephemeral mode
    const tables = [
      'flashcards', 'timelines', 'video_assessments', 'gradebook_courses',
      'gradebook_students', 'gradebook_assignments', 'gradebook_grades',
      'gradebook_rubrics', 'assignments', 'assignment_submissions',
      'app_metadata', 'binary_blobs', 'outbox'
    ];
    for (const t of tables) {
      this.memoryStore.set(t, new Map());
    }

    this._hookMutations();
  }

  _hookMutations() {
    const notifyMutation = (tableName, action, key, obj) => {
      for (const listener of this.mutationListeners) {
        try {
          listener({ tableName, action, key, obj });
        } catch (e) {
          console.error('Error in mutation listener:', e);
        }
      }
    };

    const tables = this.db.tables;
    if (tables && tables.length) {
      for (const table of tables) {
        table.hook('creating', (primKey, obj) => {
          notifyMutation(table.name, 'create', primKey, obj);
        });
        table.hook('updating', (modifications, primKey, obj) => {
          notifyMutation(table.name, 'update', primKey, { ...obj, ...modifications });
        });
        table.hook('deleting', (primKey) => {
          notifyMutation(table.name, 'delete', primKey, null);
        });
      }
    }
  }

  onMutation(callback) {
    this.mutationListeners.add(callback);
    return () => this.mutationListeners.delete(callback);
  }

  async init() {
    try {
      await this.db.open();
    } catch (err) {
      console.warn('Dexie open error, activating Ephemeral Mode:', err);
      this.ephemeralMode = true;
      this._renderIncognitoWarning();
    }

    // Initialize device_id and schema_version
    let devId = await this.getMetadata('device_id');
    if (!devId) {
      devId = crypto.randomUUID();
      await this.setMetadata('device_id', devId);
    }
    this.deviceId = devId;
    await this.setMetadata('schema_version', 4);

    if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
      let persisted = false;
      try {
        persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
      } catch (_) {}
      await this.setMetadata('is_persistent', persisted);

      // Ask for eviction protection on the first interaction (Firefox shows a prompt, so not at
      // load); Chromium grants it silently for engaged or installed sites.
      if (!persisted && navigator.storage?.persist) {
        const requestPersistence = async () => {
          window.removeEventListener('pointerdown', requestPersistence);
          window.removeEventListener('keydown', requestPersistence);
          try {
            const isPersisted = await navigator.storage.persist();
            await this.setMetadata('is_persistent', isPersisted);
            if (!isPersisted) console.warn('Storage eviction protection not granted by browser.');
          } catch (e) {
            console.debug('storage.persist failed:', e);
          }
        };
        window.addEventListener('pointerdown', requestPersistence, { once: true });
        window.addEventListener('keydown', requestPersistence, { once: true });
      }

      const quota = await this.checkStorageQuota();
      if (!this.ephemeralMode && isTemporaryProfileQuota(quota)) {
        this._renderTemporarySessionBanner();
      }
    }

    return this;
  }

  async checkStorageQuota() {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      try {
        const { usage, quota } = await navigator.storage.estimate();
        const ratio = quota > 0 ? usage / quota : 0;
        const usageMB = (usage / (1024 * 1024)).toFixed(1);
        const quotaMB = (quota / (1024 * 1024)).toFixed(1);

        if (ratio > 0.8) {
          this._renderQuotaWarning(usageMB, quotaMB, Math.round(ratio * 100));
        }

        return { usage, quota, ratio, usageMB, quotaMB };
      } catch (err) {
        console.warn('Storage estimate failed:', err);
      }
    }
    return null;
  }

  _renderIncognitoWarning() {
    if (typeof document === 'undefined') return;
    const existing = document.getElementById('sl-incognito-dialog');
    if (existing) return;

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'sl-incognito-dialog';
    dialog.label = 'Private Browsing Active';
    dialog.innerHTML = `
      <div class="space-y-3">
        <p class="text-sm text-slate-700">
          Strict private browsing is preventing local storage access. You are running in <strong>Ephemeral Mode</strong>.
        </p>
        <p class="text-sm text-red-600 font-semibold">
          Data will NOT persist after tab closure! Please manually export your data before closing the window.
        </p>
      </div>
      <sl-button slot="footer" variant="primary" id="btn-incognito-ack">I Understand</sl-button>
    `;
    document.body.appendChild(dialog);
    dialog.show();

    dialog.addEventListener('sl-request-close', (e) => {
      e.preventDefault();
    });

    const ackBtn = dialog.querySelector('#btn-incognito-ack');
    if (ackBtn) {
      ackBtn.addEventListener('click', () => {
        dialog.remove();
      });
    }
  }

  /**
   * Shared/guest Chromebook profiles (DeviceEphemeralUsersEnabled) and some private modes wipe
   * storage at sign-out; they show up as an unusually small quota.
   */
  _renderTemporarySessionBanner() {
    if (typeof document === 'undefined' || document.getElementById('kb-temporary-session-banner')) return;
    try {
      if (sessionStorage.getItem('kb_temp_banner_dismissed')) return;
    } catch (_) {}
    const banner = document.createElement('div');
    banner.id = 'kb-temporary-session-banner';
    banner.setAttribute('role', 'alert');
    banner.className = 'kb-temp-session-banner no-print';
    banner.innerHTML = `
      <sl-icon name="exclamation-triangle-fill" aria-hidden="true"></sl-icon>
      <span><strong>Temporary session detected.</strong> This browser profile may erase everything when you sign out or close it. Download a backup before closing this window.</span>
      <button type="button" data-action="backup">Download backup</button>
      <button type="button" data-action="dismiss" aria-label="Dismiss warning">✕</button>`;
    banner.querySelector('[data-action="backup"]').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('kb-request-backup'));
    });
    banner.querySelector('[data-action="dismiss"]').addEventListener('click', () => {
      try { sessionStorage.setItem('kb_temp_banner_dismissed', '1'); } catch (_) {}
      banner.remove();
    });
    document.body.prepend(banner);
  }

  _renderQuotaWarning(usageMB, quotaMB, percent) {
    if (typeof document === 'undefined') return;
    const alert = document.createElement('sl-alert');
    alert.variant = 'warning';
    alert.duration = 10000;
    alert.setAttribute('closable', '');
    alert.innerHTML = `
      <sl-icon slot="icon" name="exclamation-triangle"></sl-icon>
      <strong>Storage Quota Warning:</strong> ${percent}% used (${usageMB} MB of ${quotaMB} MB).
      Consider exporting an archive or clearing unused binary assets.
    `;
    document.body.appendChild(alert);
    if (typeof alert.toast === 'function') alert.toast();
  }

  // --- Metadata Helpers ---
  async getMetadata(key) {
    if (this.ephemeralMode) {
      const table = this.memoryStore.get('app_metadata');
      const row = table?.get(key);
      return row ? row.value : null;
    }
    const item = await this.db.app_metadata.get(key);
    return item ? item.value : null;
  }

  async setMetadata(key, value) {
    if (this.ephemeralMode) {
      const table = this.memoryStore.get('app_metadata');
      table?.set(key, { key, value });
      return;
    }
    await this.db.app_metadata.put({ key, value });
  }

  // --- Binary Asset Routing (64KB Rule) ---
  async saveBinaryAsset(id, blob, { preferIndexedDb = false } = {}) {
    const isLarge = blob.size > 65536;

    // preferIndexedDb: small card media stays in IndexedDB so backups can include it
    if (isLarge && !preferIndexedDb && typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        const assetsDir = await root.getDirectoryHandle('assets', { create: true });
        const fileHandle = await assetsDir.getFileHandle(id, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return `opfs://assets/${id}`;
      } catch (err) {
        console.warn('OPFS write failed, falling back to IndexedDB:', err);
      }
    }

    if (this.ephemeralMode) {
      const table = this.memoryStore.get('binary_blobs');
      table.set(id, { id, mime_type: blob.type, size_bytes: blob.size, data: blob });
      return `idb-blob://${id}`;
    }

    await this.db.binary_blobs.put({
      id,
      mime_type: blob.type,
      size_bytes: blob.size,
      data: blob
    });
    return `idb-blob://${id}`;
  }

  async loadBinaryAsset(uri) {
    if (!uri) return '';
    if (uri.startsWith('blob:') || uri.startsWith('data:') || uri.startsWith('http://') || uri.startsWith('https://')) {
      return uri;
    }

    if (uri.startsWith('opfs://assets/')) {
      const id = uri.replace('opfs://assets/', '');
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
        const root = await navigator.storage.getDirectory();
        const assetsDir = await root.getDirectoryHandle('assets');
        const fileHandle = await assetsDir.getFileHandle(id);
        const file = await fileHandle.getFile();
        const objectUrl = URL.createObjectURL(file);
        this.objectUrls.add(objectUrl);
        return objectUrl;
      }
    }

    if (uri.startsWith('idb-blob://')) {
      const id = uri.replace('idb-blob://', '');
      let record;
      if (this.ephemeralMode) {
        record = this.memoryStore.get('binary_blobs')?.get(id);
      } else {
        record = await this.db.binary_blobs.get(id);
      }

      if (record && record.data) {
        const objectUrl = URL.createObjectURL(record.data);
        this.objectUrls.add(objectUrl);
        return objectUrl;
      }
    }

    return uri;
  }

  /** Raw Blob behind an asset URI (idb-blob:// or opfs://), or null */
  async getBinaryBlob(uri) {
    if (!uri) return null;
    if (uri.startsWith('idb-blob://')) {
      const id = uri.slice('idb-blob://'.length);
      const record = this.ephemeralMode
        ? this.memoryStore.get('binary_blobs')?.get(id)
        : await this.db.binary_blobs.get(id);
      return record?.data || null;
    }
    if (uri.startsWith('opfs://assets/') && navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('assets');
      return (await dir.getFileHandle(uri.slice('opfs://assets/'.length))).getFile();
    }
    return null;
  }

  revokeObjectURL(url) {
    if (this.objectUrls.has(url)) {
      URL.revokeObjectURL(url);
      this.objectUrls.delete(url);
    }
  }

  revokeAllObjectURLs() {
    for (const url of this.objectUrls) {
      URL.revokeObjectURL(url);
    }
    this.objectUrls.clear();
  }

  // --- Outbox API (used for Phase 6 sync) ---
  // Merge rules for Option B (per-teacher state sync):
  // - Last-writer-wins (LWW) on updated_at with device_id tiebreak per record.
  // - gradebook_grades is per-cell so LWW is natural.
  // - assignment_submissions are append-only (never conflict).
  // - course settings are whole-record LWW.
  get outbox() {
    return {
      since: async (seq = 0, limit = 100) => {
        if (this.ephemeralMode) {
          const rows = Array.from((this.memoryStore.get('outbox') || new Map()).values());
          return rows.filter(r => r.seq > seq).slice(0, limit);
        }
        return await this.db.outbox.where('seq').above(seq).limit(limit).toArray();
      },
      markPushed: async (seqs) => {
        const now = new Date().toISOString();
        if (this.ephemeralMode) {
          const mem = this.memoryStore.get('outbox');
          if (mem) {
            for (const s of seqs) {
              const r = mem.get(s);
              if (r) r.pushed_at = now;
            }
          }
          return;
        }
        await this.db.transaction('rw', this.db.outbox, async () => {
          for (const s of seqs) {
            await this.db.outbox.update(s, { pushed_at: now });
          }
        });
      },
      prune: async (olderThanDays = 30, onlyPushed = true) => {
        const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
        if (this.ephemeralMode) {
          const mem = this.memoryStore.get('outbox');
          if (mem) {
            for (const [k, v] of mem.entries()) {
              if (v.created_at < cutoff && (!onlyPushed || v.pushed_at)) {
                mem.delete(k);
              }
            }
          }
          return;
        }
        await this.db.transaction('rw', this.db.outbox, async () => {
          const toDelete = await this.db.outbox
            .where('created_at')
            .below(cutoff)
            .and(r => !onlyPushed || r.pushed_at !== null)
            .primaryKeys();
          await this.db.outbox.bulkDelete(toDelete);
        });
      }
    };
  }

  // --- Generic Table Interface for CRUD with Ephemeral Mode Support ---
  table(tableName) {
    if (this.ephemeralMode) {
      const memTable = this.memoryStore.get(tableName) || new Map();
      this.memoryStore.set(tableName, memTable);

      const resolveKey = (id) => {
        if (Array.isArray(id)) return id.join('+');
        return String(id);
      };

      const recordKey = (item) => {
        if (item.student_id && item.assignment_id && tableName === 'gradebook_grades') {
          return `${item.student_id}+${item.assignment_id}`;
        }
        if (item.id) {
          return Array.isArray(item.id) ? item.id.join('+') : String(item.id);
        }
        if (item.key) return String(item.key);
        return crypto.randomUUID();
      };

      const stampRecord = (item) => {
        const now = new Date().toISOString();
        item.updated_at = now;
        item.created_at = item.created_at || now;
        if (!item.id && DATA_TABLES.has(tableName)) {
          item.id = crypto.randomUUID();
        }
      };

      return {
        get: async (id) => {
          const k = resolveKey(id);
          return memTable.get(k);
        },
        put: async (item) => {
          stampRecord(item);
          const key = recordKey(item);
          memTable.set(key, item);

          if (this._outboxEnabled) {
            const outboxMem = this.memoryStore.get('outbox');
            if (outboxMem) {
              const seq = outboxMem.size + 1;
              outboxMem.set(seq, {
                seq,
                table: tableName,
                key: tableName === 'gradebook_grades' ? [item.student_id, item.assignment_id] : key,
                op: 'put',
                record: item,
                created_at: item.updated_at,
                pushed_at: null,
                device_id: this.deviceId || null
              });
            }
          }
          return key;
        },
        bulkPut: async (items) => {
          for (const it of items) {
            stampRecord(it);
            const key = recordKey(it);
            memTable.set(key, it);

            if (this._outboxEnabled) {
              const outboxMem = this.memoryStore.get('outbox');
              if (outboxMem) {
                const seq = outboxMem.size + 1;
                outboxMem.set(seq, {
                  seq,
                  table: tableName,
                  key: tableName === 'gradebook_grades' ? [it.student_id, it.assignment_id] : key,
                  op: 'put',
                  record: it,
                  created_at: it.updated_at,
                  pushed_at: null,
                  device_id: this.deviceId || null
                });
              }
            }
          }
        },
        delete: async (id) => {
          const key = resolveKey(id);
          memTable.delete(key);

          if (this._outboxEnabled) {
            const outboxMem = this.memoryStore.get('outbox');
            if (outboxMem) {
              const seq = outboxMem.size + 1;
              outboxMem.set(seq, {
                seq,
                table: tableName,
                key: id,
                op: 'delete',
                created_at: new Date().toISOString(),
                pushed_at: null,
                device_id: this.deviceId || null
              });
            }
          }
        },
        bulkDelete: async (keys) => {
          for (const k of keys) {
            const key = resolveKey(k);
            memTable.delete(key);

            if (this._outboxEnabled) {
              const outboxMem = this.memoryStore.get('outbox');
              if (outboxMem) {
                const seq = outboxMem.size + 1;
                outboxMem.set(seq, {
                  seq,
                  table: tableName,
                  key: k,
                  op: 'delete',
                  created_at: new Date().toISOString(),
                  pushed_at: null,
                  device_id: this.deviceId || null
                });
              }
            }
          }
        },
        clear: async () => {
          memTable.clear();
        },
        count: async () => memTable.size,
        toArray: async () => Array.from(memTable.values()),
        where: (field) => {
          const createClause = (predicate) => ({
            toArray: async () => Array.from(memTable.values()).filter(predicate),
            count: async () => Array.from(memTable.values()).filter(predicate).length,
            delete: async () => {
              for (const [k, v] of Array.from(memTable.entries())) {
                if (predicate(v)) memTable.delete(k);
              }
            },
            primaryKeys: async () => {
              const pks = [];
              for (const [k, v] of memTable.entries()) {
                if (predicate(v)) {
                  pks.push(k.includes('+') ? k.split('+') : k);
                }
              }
              return pks;
            },
            and: (subPred) => createClause(item => predicate(item) && subPred(item))
          });

          return {
            equals: (val) => createClause(item => item[field] === val)
          };
        },
        toCollection: () => ({
          modify: async (fn) => {
            for (const item of memTable.values()) {
              fn(item);
            }
          }
        })
      };
    }

    return wrapDexieTable(this.db[tableName], tableName, this);
  }

  /**
   * Export all database tables into a portable master JSON snapshot (format v2).
   * Device-bound metadata is left out; media blobs are embedded as base64.
   */
  async dumpMasterSnapshot() {
    const snapshot = {
      version: BACKUP_VERSION,
      exported_at: new Date().toISOString(),
      data: {},
      blobs: []
    };

    for (const tbl of BACKUP_TABLES) {
      const rows = await this.table(tbl).toArray();
      snapshot.data[tbl] = tbl === 'app_metadata' ? stripDeviceMetadata(rows) : rows;
    }

    const blobs = await this.table('binary_blobs').toArray();
    for (const b of blobs) {
      if (typeof b?.data?.arrayBuffer === 'function') {
        snapshot.blobs.push({ id: b.id, mime_type: b.mime_type || b.data.type, data: await blobToBase64(b.data) });
      }
    }

    return snapshot;
  }

  /**
   * Restore all database tables from a master JSON snapshot. Validates first (throws BackupError),
   * then replaces every table in one transaction. Device-bound metadata on this device is kept.
   */
  async restoreMasterSnapshot(snapshot) {
    const { snapshot: valid } = typeof snapshot === 'string'
      ? parseBackup(snapshot)
      : parseBackup(JSON.stringify(snapshot));

    const tables = BACKUP_TABLES.filter(t => Array.isArray(valid.data[t]));
    const now = new Date().toISOString();
    const prepared = {};
    for (const tbl of tables) {
      let rows = valid.data[tbl].map(r => ({ ...r }));
      if (tbl === 'app_metadata') {
        const keep = (await this.table('app_metadata').toArray()).filter(r => DEVICE_BOUND_METADATA.has(r.key));
        rows = [...stripDeviceMetadata(rows), ...keep];
      } else if (DATA_TABLES.has(tbl)) {
        for (const r of rows) {
          r.created_at = r.created_at || r.updated_at || now;
          r.updated_at = r.updated_at || now;
        }
      }
      prepared[tbl] = rows;
    }
    const blobs = (valid.blobs || []).map(b => ({
      id: b.id,
      mime_type: b.mime_type,
      size_bytes: Math.floor(b.data.length * 3 / 4),
      data: base64ToBlob(b.data, b.mime_type)
    }));

    if (this.ephemeralMode) {
      for (const tbl of tables) {
        await this.table(tbl).clear();
        await this.table(tbl).bulkPut(prepared[tbl]);
      }
      if (blobs.length) await this.table('binary_blobs').bulkPut(blobs);
      return;
    }

    // Raw Dexie tables: a restore must not be replayed into the sync outbox as fresh edits
    const dbTables = [...tables.map(t => this.db[t]), this.db.binary_blobs];
    await this.db.transaction('rw', dbTables, async () => {
      for (const tbl of tables) {
        await this.db[tbl].clear();
        await this.db[tbl].bulkPut(prepared[tbl]);
      }
      if (blobs.length) await this.db.binary_blobs.bulkPut(blobs);
    });
  }
}

export const storage = new StorageManager();
export default storage;
