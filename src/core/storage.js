import Dexie from 'dexie';

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
      // Normalize legacy flashcard items where front/back were plain strings
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

    // v3: Assignments module (auto-graded question sets) and encrypted student submissions
    this.db.version(3).stores({
      assignments: 'id, title, class_id, updated_at',
      assignment_submissions: 'id, assignment_id, student_id, submitted_at'
    });

    // Initialize in-memory tables for ephemeral mode
    const tables = [
      'flashcards', 'timelines', 'video_assessments', 'gradebook_courses',
      'gradebook_students', 'gradebook_assignments', 'gradebook_grades',
      'gradebook_rubrics', 'assignments', 'assignment_submissions',
      'app_metadata', 'binary_blobs'
    ];
    for (const t of tables) {
      this.memoryStore.set(t, new Map());
    }

    this._hookMutations();
  }

  _hookMutations() {
    // Notify mutation listeners whenever writes happen
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

  /**
   * Subscribe to database write mutations (used by auto-sync daemon)
   * @param {(mutation: {tableName: string, action: string, key: any, obj: any}) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onMutation(callback) {
    this.mutationListeners.add(callback);
    return () => this.mutationListeners.delete(callback);
  }

  /**
   * Initialize database and perform quota/persistence checks
   */
  async init() {
    try {
      await this.db.open();
    } catch (err) {
      console.warn('Dexie open error, activating Ephemeral Mode:', err);
      this.ephemeralMode = true;
      this._renderIncognitoWarning();
    }

    if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
      // 1. One-time gesture listener for navigator.storage.persist()
      const requestPersistence = async () => {
        if (navigator.storage && navigator.storage.persist) {
          try {
            const isPersisted = await navigator.storage.persist();
            await this.setMetadata('is_persistent', isPersisted);
          } catch (e) {
            console.debug('storage.persist failed:', e);
          }
        }
        window.removeEventListener('pointerdown', requestPersistence);
        window.removeEventListener('keydown', requestPersistence);
      };
      window.addEventListener('pointerdown', requestPersistence, { once: true });
      window.addEventListener('keydown', requestPersistence, { once: true });

      // 2. Storage estimate & quota warning
      await this.checkStorageQuota();
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
      // Prevent closing unless acknowledged
      e.preventDefault();
    });

    const ackBtn = dialog.querySelector('#btn-incognito-ack');
    if (ackBtn) {
      ackBtn.addEventListener('click', () => {
        dialog.remove();
      });
    }
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
      const row = table.get(key);
      return row ? row.value : null;
    }
    const item = await this.db.app_metadata.get(key);
    return item ? item.value : null;
  }

  async setMetadata(key, value) {
    if (this.ephemeralMode) {
      const table = this.memoryStore.get('app_metadata');
      table.set(key, { key, value });
      return;
    }
    await this.db.app_metadata.put({ key, value });
  }

  // --- Binary Asset Routing (64KB Rule) ---
  /**
   * Save a binary asset (Blob/File). If >64KB and OPFS is available, routes to OPFS.
   * Otherwise stores in IndexedDB binary_blobs.
   * @param {string} id
   * @param {Blob} blob
   * @returns {Promise<string>} URI reference (opfs://assets/{id} or idb-blob://{id})
   */
  async saveBinaryAsset(id, blob) {
    const isLarge = blob.size > 65536; // 64KB threshold

    if (isLarge && typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
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

    // IDB or Memory fallback
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

  /**
   * Resolve an asset URI into an Object URL
   * @param {string} uri - opfs://assets/{id} or idb-blob://{id} or standard url
   * @returns {Promise<string>} Blob Object URL
   */
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
        record = this.memoryStore.get('binary_blobs').get(id);
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

  /**
   * Revoke an active Object URL created by loadBinaryAsset
   */
  revokeObjectURL(url) {
    if (this.objectUrls.has(url)) {
      URL.revokeObjectURL(url);
      this.objectUrls.delete(url);
    }
  }

  /**
   * Revoke all managed Object URLs on view unmount
   */
  revokeAllObjectURLs() {
    for (const url of this.objectUrls) {
      URL.revokeObjectURL(url);
    }
    this.objectUrls.clear();
  }

  // --- Generic Table Interface for CRUD with Ephemeral Mode Support ---
  table(tableName) {
    if (this.ephemeralMode) {
      const memTable = this.memoryStore.get(tableName) || new Map();
      return {
        get: async (id) => memTable.get(id),
        put: async (item) => {
          const key = item.id || (item.key ? item.key : `${item.student_id}+${item.assignment_id}`);
          memTable.set(key, item);
          return key;
        },
        bulkPut: async (items) => {
          for (const it of items) {
            const key = it.id || (it.key ? it.key : `${it.student_id}+${it.assignment_id}`);
            memTable.set(key, it);
          }
        },
        delete: async (id) => {
          memTable.delete(id);
        },
        clear: async () => {
          memTable.clear();
        },
        toArray: async () => Array.from(memTable.values()),
        where: (field) => ({
          equals: (val) => ({
            toArray: async () => Array.from(memTable.values()).filter(x => x[field] === val),
            delete: async () => {
              for (const [k, v] of memTable.entries()) {
                if (v[field] === val) memTable.delete(k);
              }
            }
          })
        })
      };
    }
    return this.db[tableName];
  }

  /**
   * Export all database tables into a master JSON snapshot
   */
  async dumpMasterSnapshot() {
    const tables = [
      'flashcards', 'timelines', 'video_assessments', 'gradebook_courses',
      'gradebook_students', 'gradebook_assignments', 'gradebook_grades',
      'gradebook_rubrics', 'assignments', 'assignment_submissions', 'app_metadata'
    ];

    const snapshot = {
      version: 1,
      exported_at: new Date().toISOString(),
      data: {}
    };

    for (const tbl of tables) {
      snapshot.data[tbl] = await this.table(tbl).toArray();
    }

    return snapshot;
  }

  /**
   * Restore all database tables from a master JSON snapshot
   */
  async restoreMasterSnapshot(snapshot) {
    if (!snapshot || !snapshot.data) {
      throw new Error('Invalid snapshot data');
    }

    for (const [tbl, records] of Object.entries(snapshot.data)) {
      if (Array.isArray(records)) {
        await this.table(tbl).clear();
        await this.table(tbl).bulkPut(records);
      }
    }
  }
}

export const storage = new StorageManager();
export default storage;
