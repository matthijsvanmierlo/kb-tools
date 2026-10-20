import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Initialize SQLite database with teachers, payloads, drops, and submissions tables.
 * @param {string} filePath - Absolute or relative path to .sqlite file, or ':memory:'
 */
export function createDatabase(filePath = ':memory:') {
  if (filePath !== ':memory:') {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(filePath);

  if (filePath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS teachers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payloads (
      ref TEXT PRIMARY KEY,
      teacher_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      meta TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS drops (
      id TEXT PRIMARY KEY,
      teacher_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      publish_version INTEGER,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      drop_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY (drop_id) REFERENCES drops(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS drafts (
      drop_id TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (drop_id, draft_id),
      FOREIGN KEY (drop_id) REFERENCES drops(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES teachers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_chunks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      start_seq INTEGER NOT NULL,
      end_seq INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, device_id, start_seq, end_seq),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_snapshots (
      workspace_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (workspace_id, device_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS course_feeds (
      course_id TEXT PRIMARY KEY,
      teacher_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      etag TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sync_chunks_ws ON sync_chunks(workspace_id, seq);
    CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at);
    CREATE INDEX IF NOT EXISTS idx_sync_chunks_created ON sync_chunks(created_at);
    CREATE INDEX IF NOT EXISTS idx_payloads_expires ON payloads(expires_at);
    CREATE INDEX IF NOT EXISTS idx_drops_expires ON drops(expires_at);
    CREATE INDEX IF NOT EXISTS idx_submissions_drop ON submissions(drop_id, received_at);
    CREATE INDEX IF NOT EXISTS idx_course_feeds_updated ON course_feeds(updated_at);
  `);

  // Databases created before drop secrets existed get the column (old drops keep working without)
  const dropColumns = db.prepare('PRAGMA table_info(drops)').all().map(c => c.name);
  if (!dropColumns.includes('secret_hash')) db.exec('ALTER TABLE drops ADD COLUMN secret_hash TEXT');

  return {
    raw: db,

    /**
     * Remove expired payloads and drops, and student data older than the retention period:
     * submissions and drafts (teachers import them long before), and sync chunks (each device's
     * snapshot already contains them; snapshots themselves are kept).
     * @param {{ retentionDays?: number|null }} [opts]
     */
    pruneExpired({ retentionDays = null } = {}) {
      const now = new Date().toISOString();
      const prunePayloads = db.prepare('DELETE FROM payloads WHERE expires_at IS NOT NULL AND expires_at < ?');
      const pruneDrops = db.prepare('DELETE FROM drops WHERE expires_at IS NOT NULL AND expires_at < ?');
      const pRes = prunePayloads.run(now);
      const dRes = pruneDrops.run(now);
      const result = { payloadsPruned: pRes.changes, dropsPruned: dRes.changes, submissionsPruned: 0, draftsPruned: 0, chunksPruned: 0 };
      if (retentionDays > 0) {
        const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
        result.submissionsPruned = db.prepare('DELETE FROM submissions WHERE received_at < ?').run(cutoff).changes;
        result.draftsPruned = db.prepare('DELETE FROM drafts WHERE updated_at < ?').run(cutoff).changes;
        result.chunksPruned = db.prepare('DELETE FROM sync_chunks WHERE created_at < ?').run(cutoff).changes;
      }
      return result;
    },

    teachers: {
      create({ id, name, tokenHash, createdAt = new Date().toISOString() }) {
        const stmt = db.prepare('INSERT INTO teachers (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)');
        stmt.run(id, name, tokenHash, createdAt);
        return { id, name, tokenHash, createdAt };
      },
      getByTokenHash(tokenHash) {
        const stmt = db.prepare('SELECT * FROM teachers WHERE token_hash = ?');
        return stmt.get(tokenHash) || null;
      },
      getById(id) {
        const stmt = db.prepare('SELECT * FROM teachers WHERE id = ?');
        return stmt.get(id) || null;
      }
    },

    payloads: {
      create({ ref, teacherId, kind, ciphertext, meta, expiresAt }) {
        const now = new Date().toISOString();
        const metaStr = typeof meta === 'object' ? JSON.stringify(meta) : (meta || null);
        const stmt = db.prepare('INSERT INTO payloads (ref, teacher_id, kind, ciphertext, meta, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        stmt.run(ref, teacherId, kind, ciphertext, metaStr, now, expiresAt || null);
        return { ref };
      },
      get(ref) {
        const stmt = db.prepare('SELECT * FROM payloads WHERE ref = ?');
        const row = stmt.get(ref);
        if (!row) return null;
        if (row.expires_at && row.expires_at < new Date().toISOString()) {
          return { expired: true };
        }
        return row;
      }
    },

    drops: {
      create({ id, teacherId, assignmentId, publishVersion, expiresAt, secretHash = null }) {
        const now = new Date().toISOString();
        const stmt = db.prepare('INSERT INTO drops (id, teacher_id, assignment_id, publish_version, created_at, expires_at, secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
        stmt.run(id, teacherId, assignmentId, publishVersion ?? null, now, expiresAt || null, secretHash);
        return { id };
      },
      get(id) {
        const stmt = db.prepare('SELECT * FROM drops WHERE id = ?');
        const row = stmt.get(id);
        if (!row) return null;
        if (row.expires_at && row.expires_at < new Date().toISOString()) {
          return { expired: true };
        }
        return row;
      },
      delete(id, teacherId) {
        const stmt = db.prepare('DELETE FROM drops WHERE id = ? AND teacher_id = ?');
        const res = stmt.run(id, teacherId);
        return res.changes > 0;
      }
    },

    drafts: {
      put({ dropId, draftId, ciphertext, maxDrafts = 250 }) {
        const now = new Date().toISOString();
        const existing = db.prepare('SELECT draft_id FROM drafts WHERE drop_id = ? AND draft_id = ?').get(dropId, draftId);
        if (!existing) {
          const count = db.prepare('SELECT count(*) as count FROM drafts WHERE drop_id = ?').get(dropId)?.count || 0;
          if (count >= maxDrafts) {
            const err = new Error('DROP_DRAFT_QUOTA_EXCEEDED');
            err.code = 'QUOTA_EXCEEDED';
            throw err;
          }
        }
        db.prepare(`INSERT INTO drafts (drop_id, draft_id, ciphertext, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (drop_id, draft_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`)
          .run(dropId, draftId, ciphertext, now);
        return { updatedAt: now };
      },
      get(dropId, draftId) {
        return db.prepare('SELECT ciphertext, updated_at FROM drafts WHERE drop_id = ? AND draft_id = ?').get(dropId, draftId) || null;
      }
    },

    workspaces: {
      create({ id, keyHash, createdBy }) {
        db.prepare('INSERT INTO workspaces (id, key_hash, created_by, created_at) VALUES (?, ?, ?, ?)')
          .run(id, keyHash, createdBy, new Date().toISOString());
        return { id };
      },
      get(id) {
        return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) || null;
      }
    },

    sync: {
      putChunk({ workspaceId, deviceId, start, end, body }) {
        const res = db.prepare(`INSERT OR IGNORE INTO sync_chunks (workspace_id, device_id, start_seq, end_seq, body, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(workspaceId, deviceId, start, end, body, new Date().toISOString());
        return { created: res.changes > 0 };
      },
      listChunks(workspaceId, { after = 0, limit = 200 } = {}) {
        const rows = db.prepare(`SELECT seq, device_id, start_seq AS start, end_seq AS end, body FROM sync_chunks
          WHERE workspace_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`).all(workspaceId, after, limit + 1);
        return { items: rows.slice(0, limit), more: rows.length > limit };
      },
      deleteChunks(workspaceId, deviceId, through) {
        return db.prepare('DELETE FROM sync_chunks WHERE workspace_id = ? AND device_id = ? AND end_seq <= ?')
          .run(workspaceId, deviceId, through).changes;
      },
      putSnapshot({ workspaceId, deviceId, createdAt, body }) {
        db.prepare(`INSERT INTO sync_snapshots (workspace_id, device_id, created_at, body) VALUES (?, ?, ?, ?)
          ON CONFLICT (workspace_id, device_id) DO UPDATE SET created_at = excluded.created_at, body = excluded.body`)
          .run(workspaceId, deviceId, createdAt, body);
      },
      listSnapshots(workspaceId) {
        return db.prepare('SELECT device_id, created_at FROM sync_snapshots WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId);
      },
      getSnapshot(workspaceId, deviceId) {
        return db.prepare('SELECT created_at, body FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').get(workspaceId, deviceId) || null;
      }
    },

    submissions: {
      create({ id, dropId, text, receivedAt = new Date().toISOString(), maxSubmissions = 500 }) {
        const count = db.prepare('SELECT count(*) as count FROM submissions WHERE drop_id = ?').get(dropId)?.count || 0;
        if (count >= maxSubmissions) {
          const err = new Error('DROP_SUBMISSION_QUOTA_EXCEEDED');
          err.code = 'QUOTA_EXCEEDED';
          throw err;
        }
        const stmt = db.prepare('INSERT INTO submissions (id, drop_id, received_at, text) VALUES (?, ?, ?, ?)');
        stmt.run(id, dropId, receivedAt, text);
        return { id, receivedAt };
      },
      list(dropId, { since } = {}) {
        let stmt;
        if (since) {
          stmt = db.prepare('SELECT id, received_at, text FROM submissions WHERE drop_id = ? AND received_at > ? ORDER BY received_at ASC');
          return stmt.all(dropId, since);
        } else {
          stmt = db.prepare('SELECT id, received_at, text FROM submissions WHERE drop_id = ? ORDER BY received_at ASC');
          return stmt.all(dropId);
        }
      }
    },

    feeds: {
      put({ courseId, teacherId, ciphertext, etag, updatedAt = new Date().toISOString() }) {
        const stmt = db.prepare(`
          INSERT INTO course_feeds (course_id, teacher_id, ciphertext, etag, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(course_id) DO UPDATE SET
            teacher_id = excluded.teacher_id,
            ciphertext = excluded.ciphertext,
            etag = excluded.etag,
            updated_at = excluded.updated_at
        `);
        stmt.run(courseId, teacherId, ciphertext, etag, updatedAt);
      },
      get(courseId) {
        const row = db.prepare('SELECT course_id, teacher_id, ciphertext, etag, updated_at FROM course_feeds WHERE course_id = ?').get(courseId);
        return row ? {
          courseId: row.course_id,
          teacherId: row.teacher_id,
          ciphertext: row.ciphertext,
          etag: row.etag,
          updatedAt: row.updated_at
        } : null;
      }
    }
  };
}
