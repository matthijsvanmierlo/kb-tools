import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { RELAY_SCHEMA_SQL } from './schema.js';
import {
  SCHEMA_VERSION,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TEACHER_QUOTA_MB,
  CHUNK_LIST_PAGE_LIMIT,
  CHUNK_LIST_PAGE_MAX_BYTES,
  SUBMISSION_LIST_PAGE_LIMIT
} from './limits.js';

/**
 * Initialize SQLite database with v2 schema.
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
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  db.exec(RELAY_SCHEMA_SQL);

  // Backward compatibility migration for older drops tables
  try {
    const cols = db.prepare('PRAGMA table_info(drops)').all().map(c => c.name);
    if (cols.length && !cols.includes('secret_hash')) {
      db.exec('ALTER TABLE drops ADD COLUMN secret_hash TEXT;');
    }
  } catch (_) {}

  // Schema v4 migration for teachers table (email, claim_hash, claim_expires_at, active, token_rotated_at)
  try {
    const tCols = db.prepare('PRAGMA table_info(teachers)').all().map(c => c.name);
    if (tCols.length) {
      if (!tCols.includes('email')) db.exec('ALTER TABLE teachers ADD COLUMN email TEXT;');
      if (!tCols.includes('claim_hash')) db.exec('ALTER TABLE teachers ADD COLUMN claim_hash TEXT;');
      if (!tCols.includes('claim_expires_at')) db.exec('ALTER TABLE teachers ADD COLUMN claim_expires_at TEXT;');
      if (!tCols.includes('active')) db.exec('ALTER TABLE teachers ADD COLUMN active INTEGER NOT NULL DEFAULT 1;');
      if (!tCols.includes('token_rotated_at')) db.exec('ALTER TABLE teachers ADD COLUMN token_rotated_at TEXT;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_teachers_email ON teachers(email);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_teachers_claim ON teachers(claim_hash);');
    }
  } catch (_) {}

  return {
    raw: db,

    /**
     * Remove expired payloads and drops, stale workspaces, chunks, snapshots,
     * and orphaned media. Returns keys of deleted blobs so BlobStore can prune them.
     */
    pruneExpired({ retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
      const now = new Date().toISOString();
      const cutoff = new Date(Date.now() - (retentionDays || DEFAULT_RETENTION_DAYS) * 86400000).toISOString();
      const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const expiredBlobKeys = [];

      const result = {
        payloadsPruned: 0,
        dropsPruned: 0,
        feedbackPruned: 0,
        submissionsPruned: 0,
        draftsPruned: 0,
        chunksPruned: 0,
        snapshotsPruned: 0,
        workspacesPruned: 0,
        feedsPruned: 0,
        mediaRefsPruned: 0,
        expiredBlobKeys
      };

      // 1. Expired payloads
      try {
        const pRes = db.prepare('DELETE FROM payloads WHERE expires_at < ?').run(now);
        result.payloadsPruned = pRes.changes;
      } catch (err) {
        console.error('[Prune Error] Payloads:', err);
      }

      // 2. Expired drops & their media / submissions
      try {
        const expiredDrops = db.prepare('SELECT id FROM drops WHERE expires_at < ?').all(now);
        for (const drop of expiredDrops) {
          // Collect media keys only if not referenced by other drops or teacher refs
          const mediaRows = db.prepare('SELECT key FROM drop_media WHERE drop_id = ?').all(drop.id);
          for (const m of mediaRows) {
            const otherDrop = db.prepare('SELECT 1 FROM drop_media WHERE key = ? AND drop_id != ?').get(m.key, drop.id);
            const teacherRef = db.prepare("SELECT 1 FROM media_refs WHERE sha = ? AND owner_kind = 'teacher'").get(m.key);
            if (!otherDrop && !teacherRef) {
              expiredBlobKeys.push(m.key);
            }
          }
          // Collect submission blob keys
          const subRows = db.prepare('SELECT body_key FROM submissions WHERE drop_id = ? AND body_key IS NOT NULL').all(drop.id);
          for (const s of subRows) expiredBlobKeys.push(s.body_key);
          // Delete media_refs
          db.prepare('DELETE FROM media_refs WHERE owner_kind = ? AND owner_id = ?').run('drop', drop.id);
          // Delete drop
          db.prepare('DELETE FROM drops WHERE id = ?').run(drop.id);
          result.dropsPruned++;
        }
      } catch (err) {
        console.error('[Prune Error] Drops:', err);
      }

      // 3. Expired feedback drops
      try {
        const fbRes = db.prepare('DELETE FROM feedback_drops WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
        result.feedbackPruned = fbRes.changes;
      } catch (err) {
        console.error('[Prune Error] Feedback:', err);
      }

      // 4. Stale feeds
      try {
        const fRes = db.prepare('DELETE FROM course_feeds WHERE expires_at < ?').run(now);
        result.feedsPruned = fRes.changes;
      } catch (err) {
        console.error('[Prune Error] Feeds:', err);
      }

      if (retentionDays > 0) {
        // 5. Stale submissions past retention
        try {
          const subStale = db.prepare('SELECT body_key FROM submissions WHERE received_at < ? AND body_key IS NOT NULL').all(cutoff);
          for (const s of subStale) expiredBlobKeys.push(s.body_key);
          result.submissionsPruned = db.prepare('DELETE FROM submissions WHERE received_at < ?').run(cutoff).changes;
        } catch (err) {
          console.error('[Prune Error] Submissions:', err);
        }

        // 6. Stale drafts
        try {
          result.draftsPruned = db.prepare('DELETE FROM drafts WHERE updated_at < ?').run(cutoff).changes;
        } catch (err) {
          console.error('[Prune Error] Drafts:', err);
        }

        // 7. Stale workspaces (no activity past retention)
        try {
          const staleWorkspaces = db.prepare('SELECT id FROM workspaces WHERE last_seen_at < ?').all(cutoff);
          for (const ws of staleWorkspaces) {
            const chunkBlobs = db.prepare('SELECT body_key FROM sync_chunks WHERE workspace_id = ?').all(ws.id);
            for (const c of chunkBlobs) expiredBlobKeys.push(c.body_key);
            const snapBlobs = db.prepare('SELECT body_key FROM sync_snapshots WHERE workspace_id = ?').all(ws.id);
            for (const s of snapBlobs) expiredBlobKeys.push(s.body_key);
            db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
            result.workspacesPruned++;
          }
        } catch (err) {
          console.error('[Prune Error] Workspaces:', err);
        }

        // 8. Stale devices (inactive past retention)
        try {
          const staleDevices = db.prepare('SELECT workspace_id, device_id FROM workspace_devices WHERE last_seen_at < ?').all(cutoff);
          for (const dev of staleDevices) {
            const chunkBlobs = db.prepare('SELECT body_key FROM sync_chunks WHERE workspace_id = ? AND device_id = ?').all(dev.workspace_id, dev.device_id);
            for (const c of chunkBlobs) expiredBlobKeys.push(c.body_key);
            const snapBlobs = db.prepare('SELECT body_key FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').all(dev.workspace_id, dev.device_id);
            for (const s of snapBlobs) expiredBlobKeys.push(s.body_key);
            db.prepare('DELETE FROM sync_chunks WHERE workspace_id = ? AND device_id = ?').run(dev.workspace_id, dev.device_id);
            db.prepare('DELETE FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').run(dev.workspace_id, dev.device_id);
            db.prepare('DELETE FROM workspace_devices WHERE workspace_id = ? AND device_id = ?').run(dev.workspace_id, dev.device_id);
          }
        } catch (err) {
          console.error('[Prune Error] Stale Devices:', err);
        }

        // 9. Chunks older than every active device's acknowledged cursor
        try {
          const workspaces = db.prepare('SELECT id FROM workspaces').all();
          for (const ws of workspaces) {
            const devices = db.prepare('SELECT device_id, last_ack_vector FROM workspace_devices WHERE workspace_id = ?').all(ws.id);
            if (devices.length > 0) {
              let minAck = Infinity;
              for (const dev of devices) {
                let vec = {};
                try { vec = JSON.parse(dev.last_ack_vector || '{}'); } catch (_) {}
                // find min ack across active devices
                const maxForDev = Math.max(...Object.values(vec).map(Number).filter(Number.isFinite), 0);
                if (maxForDev < minAck) minAck = maxForDev;
              }
              if (minAck > 0 && minAck !== Infinity) {
                const chunksToPrune = db.prepare('SELECT body_key FROM sync_chunks WHERE workspace_id = ? AND end_seq <= ?').all(ws.id, minAck);
                for (const c of chunksToPrune) expiredBlobKeys.push(c.body_key);
                const p = db.prepare('DELETE FROM sync_chunks WHERE workspace_id = ? AND end_seq <= ?').run(ws.id, minAck);
                result.chunksPruned += p.changes;
              }
            }
          }
        } catch (err) {
          console.error('[Prune Error] Chunks GC:', err);
        }

        // 10. General chunk pruning older than retention
        try {
          const oldChunks = db.prepare('SELECT body_key FROM sync_chunks WHERE created_at < ?').all(cutoff);
          for (const c of oldChunks) expiredBlobKeys.push(c.body_key);
          const cp = db.prepare('DELETE FROM sync_chunks WHERE created_at < ?').run(cutoff);
          result.chunksPruned += cp.changes;
        } catch (err) {
          console.error('[Prune Error] Chunks Cutoff:', err);
        }

        // 11. Snapshots: keep at most newest per device
        try {
          const oldSnaps = db.prepare(`
            SELECT body_key FROM sync_snapshots
            WHERE created_at < ?
              AND rowid NOT IN (
                SELECT rowid FROM (
                  SELECT rowid, ROW_NUMBER() OVER (PARTITION BY workspace_id, device_id ORDER BY created_at DESC) as rn
                  FROM sync_snapshots
                ) WHERE rn = 1
              )
          `).all(cutoff);
          for (const s of oldSnaps) expiredBlobKeys.push(s.body_key);
          const sp = db.prepare(`
            DELETE FROM sync_snapshots
            WHERE created_at < ?
              AND rowid NOT IN (
                SELECT rowid FROM (
                  SELECT rowid, ROW_NUMBER() OVER (PARTITION BY workspace_id, device_id ORDER BY created_at DESC) as rn
                  FROM sync_snapshots
                ) WHERE rn = 1
              )
          `).run(cutoff);
          result.snapshotsPruned = sp.changes;
        } catch (err) {
          console.error('[Prune Error] Snapshots:', err);
        }
      }

      // 12. Media GC: drop_media or media_refs with zero references older than 24h (excluding teacher refs)
      try {
        const unreferenced = db.prepare(`
          SELECT sha, size FROM media_refs
          WHERE created_at < ?
            AND owner_kind != 'teacher'
            AND NOT EXISTS (SELECT 1 FROM drop_media WHERE drop_media.key = media_refs.sha)
        `).all(oneDayAgo);
        for (const u of unreferenced) {
          expiredBlobKeys.push(u.sha);
          db.prepare('DELETE FROM media_refs WHERE sha = ?').run(u.sha);
          result.mediaRefsPruned++;
        }
      } catch (err) {
        console.error('[Prune Error] Media Refs:', err);
      }

      // 13. Recompute teacher bytes_used nightly
      try {
        this.recomputeAllTeachersBytesUsed();
      } catch (err) {
        console.error('[Prune Error] Recompute Quotas:', err);
      }

      return result;
    },

    recomputeAllTeachersBytesUsed() {
      const teachers = db.prepare('SELECT id FROM teachers').all();
      for (const t of teachers) {
        this.teachers.recomputeBytesUsed(t.id);
      }
    },

    teachers: {
      create({ id, name, email = null, tokenHash, claimHash = null, claimExpiresAt = null, active = 1, createdAt = new Date().toISOString() }) {
        db.prepare('INSERT INTO teachers (id, name, email, token_hash, claim_hash, claim_expires_at, active, bytes_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
          .run(id, name, email ? email.toLowerCase().trim() : null, tokenHash, claimHash, claimExpiresAt, active ? 1 : 0, createdAt);
        return { id, name, email, tokenHash, claimHash, claimExpiresAt, active: active ? 1 : 0, createdAt };
      },
      getByTokenHash(tokenHash) {
        return db.prepare('SELECT * FROM teachers WHERE token_hash = ?').get(tokenHash) || null;
      },
      getById(id) {
        return db.prepare('SELECT * FROM teachers WHERE id = ?').get(id) || null;
      },
      getByEmail(email) {
        if (!email) return null;
        return db.prepare('SELECT * FROM teachers WHERE LOWER(email) = LOWER(?)').get(email.trim()) || null;
      },
      rotateToken(teacherId, oldTokenHash, newTokenHash) {
        const newHash = newTokenHash !== undefined ? newTokenHash : oldTokenHash;
        const oldHash = newTokenHash !== undefined ? oldTokenHash : null;
        const now = new Date().toISOString();
        if (oldHash) {
          const res = db.prepare(`
            UPDATE teachers
            SET token_hash = ?, claim_hash = NULL, claim_expires_at = NULL, token_rotated_at = ?
            WHERE id = ? AND token_hash = ? AND active = 1
          `).run(newHash, now, teacherId, oldHash);
          return res.changes > 0;
        } else {
          const res = db.prepare(`
            UPDATE teachers
            SET token_hash = ?, claim_hash = NULL, claim_expires_at = NULL, token_rotated_at = ?
            WHERE id = ? AND active = 1
          `).run(newHash, now, teacherId);
          return res.changes > 0;
        }
      },
      claimByCodeHash(claimHash, newTokenHash) {
        const now = new Date().toISOString();
        const teacher = db.prepare(`
          SELECT * FROM teachers
          WHERE claim_hash = ? AND active = 1 AND (claim_expires_at IS NULL OR claim_expires_at > ?)
        `).get(claimHash, now);
        if (!teacher) return null;

        db.prepare(`
          UPDATE teachers
          SET token_hash = ?, claim_hash = NULL, claim_expires_at = NULL, token_rotated_at = ?
          WHERE id = ?
        `).run(newTokenHash, now, teacher.id);

        return this.getById(teacher.id);
      },
      setActive(teacherId, active) {
        const res = db.prepare('UPDATE teachers SET active = ? WHERE id = ?').run(active ? 1 : 0, teacherId);
        return res.changes > 0;
      },
      adminResetToken(teacherId, newTokenHash, claimHash = null, claimExpiresAt = null) {
        const now = new Date().toISOString();
        const res = db.prepare(`
          UPDATE teachers
          SET token_hash = ?, claim_hash = ?, claim_expires_at = ?, token_rotated_at = ?, active = 1
          WHERE id = ?
        `).run(newTokenHash, claimHash, claimExpiresAt, now, teacherId);
        return res.changes > 0;
      },
      adjustBytesUsed(teacherId, deltaBytes) {
        db.prepare('UPDATE teachers SET bytes_used = MAX(0, bytes_used + ?) WHERE id = ?').run(deltaBytes, teacherId);
      },
      recomputeBytesUsed(teacherId) {
        // Calculate usage across chunks, snapshots, feeds, payloads, drops, teacher media
        let total = 0;
        // Snapshots + Chunks from teacher workspaces
        const wsRows = db.prepare('SELECT id FROM workspaces WHERE created_by = ?').all(teacherId);
        for (const ws of wsRows) {
          const snapSize = db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM sync_snapshots WHERE workspace_id = ?').get(ws.id)?.s || 0;
          const chunkSize = db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM sync_chunks WHERE workspace_id = ?').get(ws.id)?.s || 0;
          total += Number(snapSize) + Number(chunkSize);
        }
        // Feeds
        const feedSize = db.prepare('SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) as s FROM course_feeds WHERE teacher_id = ?').get(teacherId)?.s || 0;
        total += Number(feedSize);
        // Payloads
        const payloadSize = db.prepare('SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) as s FROM payloads WHERE teacher_id = ?').get(teacherId)?.s || 0;
        total += Number(payloadSize);
        // Drops & submissions & drop media
        const dropRows = db.prepare('SELECT id FROM drops WHERE teacher_id = ?').all(teacherId);
        for (const d of dropRows) {
          const subSize = db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM submissions WHERE drop_id = ?').get(d.id)?.s || 0;
          const mediaSize = db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM drop_media WHERE drop_id = ?').get(d.id)?.s || 0;
          total += Number(subSize) + Number(mediaSize);
        }
        // Teacher media refs
        const teacherMediaSize = db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM media_refs WHERE owner_kind = ? AND owner_id = ?').get('teacher', teacherId)?.s || 0;
        total += Number(teacherMediaSize);

        db.prepare('UPDATE teachers SET bytes_used = ? WHERE id = ?').run(total, teacherId);
        return total;
      },
      getUsage(teacherId) {
        const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId);
        if (!teacher) return null;

        let snapTotal = 0;
        let chunkTotal = 0;
        const wsList = db.prepare('SELECT id, created_at, last_seen_at FROM workspaces WHERE created_by = ?').all(teacherId);
        const workspaces = [];

        for (const ws of wsList) {
          const snapSize = db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM sync_snapshots WHERE workspace_id = ?').get(ws.id)?.s || 0;
          const chunkSize = db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM sync_chunks WHERE workspace_id = ?').get(ws.id)?.s || 0;
          snapTotal += Number(snapSize);
          chunkTotal += Number(chunkSize);

          const devices = db.prepare('SELECT device_id, last_seen_at FROM workspace_devices WHERE workspace_id = ?').all(ws.id);
          workspaces.push({
            id: ws.id,
            created_at: ws.created_at,
            last_seen_at: ws.last_seen_at,
            devices
          });
        }

        const feedSize = Number(db.prepare('SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) as s FROM course_feeds WHERE teacher_id = ?').get(teacherId)?.s || 0);
        const payloadSize = Number(db.prepare('SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) as s FROM payloads WHERE teacher_id = ?').get(teacherId)?.s || 0);

        let dropSubTotal = 0;
        let dropMediaTotal = 0;
        const dropRows = db.prepare('SELECT id FROM drops WHERE teacher_id = ?').all(teacherId);
        for (const d of dropRows) {
          dropSubTotal += Number(db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM submissions WHERE drop_id = ?').get(d.id)?.s || 0);
          dropMediaTotal += Number(db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM drop_media WHERE drop_id = ?').get(d.id)?.s || 0);
        }

        const teacherMediaSize = Number(db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM media_refs WHERE owner_kind = ? AND owner_id = ?').get('teacher', teacherId)?.s || 0);

        const quotaMb = Number(process.env.KB_RELAY_TEACHER_QUOTA_MB || DEFAULT_TEACHER_QUOTA_MB);
        const quotaBytes = quotaMb * 1024 * 1024;

        return {
          teacher_id: teacher.id,
          name: teacher.name,
          bytes_used: teacher.bytes_used,
          quota_bytes: quotaBytes,
          by_category: {
            snapshots: snapTotal,
            chunks: chunkTotal,
            feeds: feedSize,
            payloads: payloadSize,
            drops: dropSubTotal,
            media: dropMediaTotal + teacherMediaSize
          },
          workspaces
        };
      }
    },

    payloads: {
      create({ ref, teacherId, kind, ciphertext, meta, expiresAt }) {
        const now = new Date().toISOString();
        const metaStr = typeof meta === 'object' ? JSON.stringify(meta) : (meta || null);
        db.prepare('INSERT INTO payloads (ref, teacher_id, kind, ciphertext, meta, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(ref, teacherId, kind, ciphertext, metaStr, now, expiresAt);
        return { ref };
      },
      get(ref) {
        const row = db.prepare('SELECT * FROM payloads WHERE ref = ?').get(ref);
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
        const finalExpires = expiresAt || new Date(Date.now() + 180 * 86400 * 1000).toISOString();
        db.prepare('INSERT INTO drops (id, teacher_id, assignment_id, publish_version, created_at, expires_at, secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, teacherId, assignmentId, publishVersion ?? null, now, finalExpires, secretHash ?? null);
        return { id };
      },
      get(id) {
        const row = db.prepare('SELECT * FROM drops WHERE id = ?').get(id);
        if (!row) return null;
        if (row.expires_at && row.expires_at < new Date().toISOString()) {
          return { expired: true };
        }
        return row;
      },
      delete(id, teacherId) {
        const drop = db.prepare('SELECT * FROM drops WHERE id = ? AND teacher_id = ?').get(id, teacherId);
        if (!drop) return { deleted: false, blobKeys: [] };

        const blobKeys = [];
        const mediaRows = db.prepare('SELECT key FROM drop_media WHERE drop_id = ?').all(id);
        for (const m of mediaRows) blobKeys.push(m.key);
        const subRows = db.prepare('SELECT body_key FROM submissions WHERE drop_id = ? AND body_key IS NOT NULL').all(id);
        for (const s of subRows) blobKeys.push(s.body_key);

        db.prepare('DELETE FROM media_refs WHERE owner_kind = ? AND owner_id = ?').run('drop', id);
        const res = db.prepare('DELETE FROM drops WHERE id = ? AND teacher_id = ?').run(id, teacherId);
        return { deleted: res.changes > 0, blobKeys };
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
        const now = new Date().toISOString();
        db.prepare('INSERT INTO workspaces (id, key_hash, created_by, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, keyHash, createdBy, now, now);
        return { id };
      },
      get(id) {
        return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) || null;
      },
      touch(id) {
        db.prepare('UPDATE workspaces SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      },
      delete(id) {
        const blobKeys = [];
        const chunkBlobs = db.prepare('SELECT body_key FROM sync_chunks WHERE workspace_id = ?').all(id);
        for (const c of chunkBlobs) blobKeys.push(c.body_key);
        const snapBlobs = db.prepare('SELECT body_key FROM sync_snapshots WHERE workspace_id = ?').all(id);
        for (const s of snapBlobs) blobKeys.push(s.body_key);

        const res = db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
        return { deleted: res.changes > 0, blobKeys };
      },
      getDevice(workspaceId, deviceId) {
        return db.prepare('SELECT * FROM workspace_devices WHERE workspace_id = ? AND device_id = ?').get(workspaceId, deviceId) || null;
      },
      registerDevice({ workspaceId, deviceId, deviceTokenHash }) {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO workspace_devices (workspace_id, device_id, device_token_hash, last_seen_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(workspace_id, device_id) DO UPDATE SET
            device_token_hash = COALESCE(excluded.device_token_hash, workspace_devices.device_token_hash),
            last_seen_at = excluded.last_seen_at
        `).run(workspaceId, deviceId, deviceTokenHash || null, now);
      },
      touchDevice(workspaceId, deviceId) {
        const now = new Date().toISOString();
        db.prepare('UPDATE workspace_devices SET last_seen_at = ? WHERE workspace_id = ? AND device_id = ?').run(now, workspaceId, deviceId);
        db.prepare('UPDATE workspaces SET last_seen_at = ? WHERE id = ?').run(now, workspaceId);
      },
      ackVector({ workspaceId, deviceId, vector }) {
        const now = new Date().toISOString();
        const vecStr = typeof vector === 'object' ? JSON.stringify(vector) : String(vector);
        db.prepare(`
          INSERT INTO workspace_devices (workspace_id, device_id, last_seen_at, last_ack_vector)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(workspace_id, device_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            last_ack_vector = excluded.last_ack_vector
        `).run(workspaceId, deviceId, now, vecStr);
        db.prepare('UPDATE workspaces SET last_seen_at = ? WHERE id = ?').run(now, workspaceId);
      },
      deleteDevice(workspaceId, deviceId) {
        const blobKeys = [];
        const chunkBlobs = db.prepare('SELECT body_key FROM sync_chunks WHERE workspace_id = ? AND device_id = ?').all(workspaceId, deviceId);
        for (const c of chunkBlobs) blobKeys.push(c.body_key);
        const snapBlobs = db.prepare('SELECT body_key FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').all(workspaceId, deviceId);
        for (const s of snapBlobs) blobKeys.push(s.body_key);

        db.prepare('DELETE FROM sync_chunks WHERE workspace_id = ? AND device_id = ?').run(workspaceId, deviceId);
        db.prepare('DELETE FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').run(workspaceId, deviceId);
        const res = db.prepare('DELETE FROM workspace_devices WHERE workspace_id = ? AND device_id = ?').run(workspaceId, deviceId);
        return { deleted: res.changes > 0, blobKeys };
      },
      listDevices(workspaceId) {
        return db.prepare('SELECT device_id, last_seen_at FROM workspace_devices WHERE workspace_id = ?').all(workspaceId);
      }
    },

    sync: {
      putChunk({ workspaceId, deviceId, start, end, bodyKey, size, sha256, body }) {
        const bKey = bodyKey ?? (body ? `chunk_${workspaceId}_${deviceId}_${start}_${end}` : `chunk_${workspaceId}_${deviceId}_${start}_${end}`);
        const sz = size ?? (body ? Buffer.byteLength(body) : 0);
        const hash = sha256 ?? (body ? createHash('sha256').update(body).digest('hex') : '0000000000000000000000000000000000000000000000000000000000000000');
        const res = db.prepare(`
          INSERT OR IGNORE INTO sync_chunks (workspace_id, device_id, start_seq, end_seq, body_key, size, sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(workspaceId, deviceId, start, end, bKey, sz, hash, new Date().toISOString());
        return { created: res.changes > 0 };
      },
      listChunks(workspaceId, { after = 0, limit = CHUNK_LIST_PAGE_LIMIT } = {}) {
        const safeLimit = Math.min(Math.max(1, limit), CHUNK_LIST_PAGE_LIMIT);
        const rows = db.prepare(`
          SELECT seq, device_id, start_seq AS start, end_seq AS end, body_key, size, sha256
          FROM sync_chunks
          WHERE workspace_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?
        `).all(workspaceId, after, safeLimit + 1);

        // Cap page by total bytes
        const items = [];
        let totalBytes = 0;
        let more = false;

        for (const row of rows) {
          if (items.length >= safeLimit || totalBytes + (row.size || 0) > CHUNK_LIST_PAGE_MAX_BYTES) {
            more = true;
            break;
          }
          items.push(row);
          totalBytes += (row.size || 0);
        }
        if (rows.length > safeLimit) more = true;

        return { items, more };
      },
      deleteChunks(workspaceId, deviceId, through) {
        const toDelete = db.prepare('SELECT body_key FROM sync_chunks WHERE workspace_id = ? AND device_id = ? AND end_seq <= ?')
          .all(workspaceId, deviceId, through);
        const blobKeys = toDelete.map(r => r.body_key);
        const res = db.prepare('DELETE FROM sync_chunks WHERE workspace_id = ? AND device_id = ? AND end_seq <= ?')
          .run(workspaceId, deviceId, through);
        return { deleted: res.changes, blobKeys };
      },
      putSnapshot({ workspaceId, deviceId, createdAt, bodyKey, size, sha256, body }) {
        const bKey = bodyKey ?? `snap_${workspaceId}_${deviceId}`;
        const sz = size ?? (body ? Buffer.byteLength(body) : 0);
        const hash = sha256 ?? (body ? createHash('sha256').update(body).digest('hex') : '0000000000000000000000000000000000000000000000000000000000000000');
        // If there was an existing snapshot for this device, retrieve old body_key for deletion
        const existing = db.prepare('SELECT body_key FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').get(workspaceId, deviceId);
        const oldKey = existing?.body_key && existing.body_key !== bKey ? existing.body_key : null;

        db.prepare(`
          INSERT INTO sync_snapshots (workspace_id, device_id, created_at, body_key, size, sha256)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, device_id) DO UPDATE SET
            created_at = excluded.created_at,
            body_key = excluded.body_key,
            size = excluded.size,
            sha256 = excluded.sha256
        `).run(workspaceId, deviceId, createdAt, bKey, sz, hash);

        return { oldKey };
      },
      listSnapshots(workspaceId) {
        return db.prepare('SELECT device_id, created_at FROM sync_snapshots WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId);
      },
      getSnapshot(workspaceId, deviceId) {
        return db.prepare('SELECT created_at, body_key, size, sha256 FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').get(workspaceId, deviceId) || null;
      }
    },

    submissions: {
      create({ id, dropId, text, bodyKey = null, size = 0, receivedAt = new Date().toISOString(), maxSubmissions = 500 }) {
        // Check existing by id for idempotency
        const existing = db.prepare('SELECT id, received_at FROM submissions WHERE id = ?').get(id);
        if (existing) {
          return { id: existing.id, receivedAt: existing.received_at, duplicate: true };
        }

        const count = db.prepare('SELECT count(*) as count FROM submissions WHERE drop_id = ?').get(dropId)?.count || 0;
        if (count >= maxSubmissions) {
          const err = new Error('DROP_SUBMISSION_QUOTA_EXCEEDED');
          err.code = 'QUOTA_EXCEEDED';
          throw err;
        }

        db.prepare(`
          INSERT INTO submissions (id, drop_id, received_at, text, body_key, size)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `).run(id, dropId, receivedAt, text || null, bodyKey || null, size);

        return { id, receivedAt, duplicate: false };
      },
      list(dropId, { since = null, after = null, limit = SUBMISSION_LIST_PAGE_LIMIT } = {}) {
        const safeLimit = Math.min(Math.max(1, limit), SUBMISSION_LIST_PAGE_LIMIT);
        let sql = 'SELECT id, received_at, text, body_key, size FROM submissions WHERE drop_id = ?';
        const params = [dropId];

        if (after) {
          if (typeof after === 'string' && after.includes('|')) {
            const [afterRec, afterId] = after.split('|');
            sql += ' AND (received_at > ? OR (received_at = ? AND id > ?))';
            params.push(afterRec, afterRec, afterId);
          } else {
            sql += ' AND received_at > ?';
            params.push(after);
          }
        } else if (since) {
          sql += ' AND received_at > ?';
          params.push(since);
        }
        sql += ' ORDER BY received_at ASC, id ASC LIMIT ?';
        params.push(safeLimit + 1);

        const rows = db.prepare(sql).all(...params);
        const more = rows.length > safeLimit;
        const items = more ? rows.slice(0, safeLimit) : rows;
        const last = items[items.length - 1];
        const next_after = last ? `${last.received_at}|${last.id}` : null;

        items.items = items;
        items.next_after = next_after;
        items.more = more;
        return items;
      },
      count(dropId) {
        return db.prepare('SELECT count(*) as count FROM submissions WHERE drop_id = ?').get(dropId)?.count || 0;
      }
    },

    feeds: {
      put({ courseId, teacherId, ciphertext, etag, updatedAt = new Date().toISOString(), expiresAt }) {
        const existing = db.prepare('SELECT teacher_id FROM course_feeds WHERE course_id = ?').get(courseId);
        if (existing && existing.teacher_id !== teacherId) {
          const err = new Error('FEED_OWNERSHIP_CONFLICT');
          err.code = 'FORBIDDEN';
          throw err;
        }
        db.prepare(`
          INSERT INTO course_feeds (course_id, teacher_id, ciphertext, etag, updated_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(course_id) DO UPDATE SET
            teacher_id = excluded.teacher_id,
            ciphertext = excluded.ciphertext,
            etag = excluded.etag,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at
        `).run(courseId, teacherId, ciphertext, etag, updatedAt, expiresAt);
      },
      get(courseId) {
        const row = db.prepare('SELECT course_id, teacher_id, ciphertext, etag, updated_at, expires_at FROM course_feeds WHERE course_id = ?').get(courseId);
        if (!row) return null;
        if (row.expires_at && row.expires_at < new Date().toISOString()) {
          return { expired: true };
        }
        return {
          courseId: row.course_id,
          teacherId: row.teacher_id,
          ciphertext: row.ciphertext,
          etag: row.etag,
          updatedAt: row.updated_at,
          expiresAt: row.expires_at
        };
      },
      delete(courseId, teacherId) {
        const existing = db.prepare('SELECT teacher_id FROM course_feeds WHERE course_id = ?').get(courseId);
        if (!existing) return false;
        if (existing.teacher_id !== teacherId) {
          const err = new Error('FEED_OWNERSHIP_CONFLICT');
          err.code = 'FORBIDDEN';
          throw err;
        }
        return db.prepare('DELETE FROM course_feeds WHERE course_id = ?').run(courseId).changes > 0;
      }
    },

    mediaRefs: {
      addRef({ sha, ownerKind, ownerId, size }) {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO media_refs (sha, owner_kind, owner_id, size, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (sha, owner_kind, owner_id) DO UPDATE SET size = excluded.size
        `).run(sha, ownerKind, ownerId, size, now);
      },
      removeRefs(ownerKind, ownerId) {
        db.prepare('DELETE FROM media_refs WHERE owner_kind = ? AND owner_id = ?').run(ownerKind, ownerId);
      }
    },

    dropMedia: {
      checkQuota(dropId, newBytes, { maxFiles = 100, maxTotalBytes = 100 * 1024 * 1024 } = {}) {
        const row = db.prepare('SELECT count(*) as count, coalesce(sum(size), 0) as total_size FROM drop_media WHERE drop_id = ?').get(dropId);
        const count = Number(row?.count || 0);
        const totalSize = Number(row?.total_size || 0);
        if (count + 1 > maxFiles || totalSize + newBytes > maxTotalBytes) {
          const err = new Error('DROP_MEDIA_QUOTA_EXCEEDED');
          err.code = 'QUOTA_EXCEEDED';
          throw err;
        }
        return true;
      },
      record({ dropId, key, size }) {
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO drop_media (drop_id, key, size, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (key) DO UPDATE SET size = excluded.size`)
          .run(dropId, key, size, now);
        // Also insert media_refs row
        db.prepare(`INSERT INTO media_refs (sha, owner_kind, owner_id, size, created_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(sha, owner_kind, owner_id) DO UPDATE SET size = excluded.size`)
          .run(key, 'drop', dropId, size, now);
        return { dropId, key, size, createdAt: now };
      },
      getStats(dropId) {
        const row = db.prepare('SELECT count(*) as count, coalesce(sum(size), 0) as total_size FROM drop_media WHERE drop_id = ?').get(dropId);
        return { count: Number(row?.count || 0), totalSize: Number(row?.total_size || 0) };
      }
    },

    feedbackDrops: {
      put({ dropId, teacherId = null, ciphertext, expiresAt = null }) {
        const now = new Date().toISOString();
        const existing = db.prepare('SELECT teacher_id FROM feedback_drops WHERE drop_id = ?').get(dropId);
        if (existing && existing.teacher_id && teacherId && existing.teacher_id !== teacherId) {
          const err = new Error('FEEDBACK_DROP_OWNERSHIP_CONFLICT');
          err.code = 'FORBIDDEN';
          throw err;
        }
        db.prepare(`INSERT INTO feedback_drops (drop_id, teacher_id, ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (drop_id) DO UPDATE SET teacher_id = coalesce(excluded.teacher_id, feedback_drops.teacher_id), ciphertext = excluded.ciphertext, created_at = excluded.created_at, expires_at = excluded.expires_at`)
          .run(dropId, teacherId || null, ciphertext, now, expiresAt || null);
        return { dropId, createdAt: now };
      },
      get(dropId) {
        const row = db.prepare('SELECT * FROM feedback_drops WHERE drop_id = ?').get(dropId);
        if (!row) return null;
        if (row.expires_at && row.expires_at < new Date().toISOString()) {
          return { expired: true };
        }
        return row;
      },
      delete(dropId, teacherId = null) {
        if (teacherId) {
          const row = db.prepare('SELECT teacher_id FROM feedback_drops WHERE drop_id = ?').get(dropId);
          if (row && row.teacher_id && row.teacher_id !== teacherId) {
            const err = new Error('FEEDBACK_DROP_OWNERSHIP_CONFLICT');
            err.code = 'FORBIDDEN';
            throw err;
          }
        }
        return db.prepare('DELETE FROM feedback_drops WHERE drop_id = ?').run(dropId).changes > 0;
      }
    },

    getMediaSigningSecret() {
      const row = db.prepare('SELECT value FROM relay_meta WHERE key = ?').get('media_signing_secret');
      if (row?.value) return row.value;
      const secret = randomBytes(32).toString('hex');
      db.prepare('INSERT OR IGNORE INTO relay_meta (key, value) VALUES (?, ?)').run('media_signing_secret', secret);
      const row2 = db.prepare('SELECT value FROM relay_meta WHERE key = ?').get('media_signing_secret');
      return row2?.value || secret;
    },

    checkMediaQuota(dropId, newBytes, opts) {
      return this.dropMedia.checkQuota(dropId, newBytes, opts);
    },

    recordMediaUpload({ dropId, key, size }) {
      return this.dropMedia.record({ dropId, key, size });
    }
  };
}
