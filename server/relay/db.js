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

    CREATE INDEX IF NOT EXISTS idx_payloads_expires ON payloads(expires_at);
    CREATE INDEX IF NOT EXISTS idx_drops_expires ON drops(expires_at);
    CREATE INDEX IF NOT EXISTS idx_submissions_drop ON submissions(drop_id, received_at);
  `);

  return {
    raw: db,

    pruneExpired() {
      const now = new Date().toISOString();
      const prunePayloads = db.prepare('DELETE FROM payloads WHERE expires_at IS NOT NULL AND expires_at < ?');
      const pruneDrops = db.prepare('DELETE FROM drops WHERE expires_at IS NOT NULL AND expires_at < ?');
      const pRes = prunePayloads.run(now);
      const dRes = pruneDrops.run(now);
      return { payloadsPruned: pRes.changes, dropsPruned: dRes.changes };
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
      create({ id, teacherId, assignmentId, publishVersion, expiresAt }) {
        const now = new Date().toISOString();
        const stmt = db.prepare('INSERT INTO drops (id, teacher_id, assignment_id, publish_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
        stmt.run(id, teacherId, assignmentId, publishVersion ?? null, now, expiresAt || null);
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

    submissions: {
      create({ id, dropId, text, receivedAt = new Date().toISOString() }) {
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
    }
  };
}
