import { RELAY_SCHEMA_SQL } from './schema.js';

/**
 * Creates an async repository interface over Cloudflare D1 (env.DB).
 * Has the exact same repository method names and return shapes as server/relay/db.js.
 * @param {any} d1 - Cloudflare D1 database binding
 */
export function createD1Database(d1) {
  return {
    raw: d1,

    /**
     * Helper to execute canonical schema DDL on this D1 instance.
     */
    async initSchema() {
      await d1.exec(RELAY_SCHEMA_SQL);
    },

    /**
     * Remove expired payloads and drops, and student data older than the retention period.
     * @param {{ retentionDays?: number|null }} [opts]
     */
    async pruneExpired({ retentionDays = null } = {}) {
      const now = new Date().toISOString();
      const pRes = await d1.prepare('DELETE FROM payloads WHERE expires_at IS NOT NULL AND expires_at < ?').bind(now).run();
      
      // Before deleting drops, collect any associated media keys so caller can prune blobs
      let expiredMediaKeys = [];
      try {
        const dropRows = await d1.prepare('SELECT id FROM drops WHERE expires_at IS NOT NULL AND expires_at < ?').bind(now).all();
        const expiredDropIds = (dropRows?.results || []).map(r => r.id);
        if (expiredDropIds.length > 0) {
          const placeholders = expiredDropIds.map(() => '?').join(',');
          const mediaRows = await d1.prepare(`SELECT key FROM drop_media WHERE drop_id IN (${placeholders})`).bind(...expiredDropIds).all();
          expiredMediaKeys = (mediaRows?.results || []).map(r => r.key);
        }
      } catch (_) {}

      const dRes = await d1.prepare('DELETE FROM drops WHERE expires_at IS NOT NULL AND expires_at < ?').bind(now).run();
      let fbRes = null;
      try {
        fbRes = await d1.prepare('DELETE FROM feedback_drops WHERE expires_at IS NOT NULL AND expires_at < ?').bind(now).run();
      } catch (_) {}

      const result = {
        payloadsPruned: pRes?.meta?.changes ?? 0,
        dropsPruned: dRes?.meta?.changes ?? 0,
        feedbackPruned: fbRes?.meta?.changes ?? 0,
        submissionsPruned: 0,
        draftsPruned: 0,
        chunksPruned: 0,
        snapshotsPruned: 0,
        expiredMediaKeys
      };

      if (retentionDays > 0) {
        const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
        const sRes = await d1.prepare('DELETE FROM submissions WHERE received_at < ?').bind(cutoff).run();
        const dfRes = await d1.prepare('DELETE FROM drafts WHERE updated_at < ?').bind(cutoff).run();
        const cRes = await d1.prepare('DELETE FROM sync_chunks WHERE created_at < ?').bind(cutoff).run();
        result.submissionsPruned = sRes?.meta?.changes ?? 0;
        result.draftsPruned = dfRes?.meta?.changes ?? 0;
        result.chunksPruned = cRes?.meta?.changes ?? 0;
        try {
          const snapRes = await d1.prepare(`
            DELETE FROM sync_snapshots
            WHERE created_at < ?
              AND rowid NOT IN (
                SELECT rowid FROM (
                  SELECT rowid, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at DESC) as rn
                  FROM sync_snapshots
                ) WHERE rn = 1
              )
          `).bind(cutoff).run();
          result.snapshotsPruned = snapRes?.meta?.changes ?? 0;
        } catch (_) {}
      }
      return result;
    },

    teachers: {
      async create({ id, name, tokenHash, createdAt = new Date().toISOString() }) {
        await d1.prepare('INSERT INTO teachers (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
          .bind(id, name, tokenHash, createdAt)
          .run();
        return { id, name, tokenHash, createdAt };
      },
      async getByTokenHash(tokenHash) {
        const row = await d1.prepare('SELECT * FROM teachers WHERE token_hash = ?').bind(tokenHash).first();
        return row || null;
      },
      async getById(id) {
        const row = await d1.prepare('SELECT * FROM teachers WHERE id = ?').bind(id).first();
        return row || null;
      }
    },

    payloads: {
      async create({ ref, teacherId, kind, ciphertext, meta, expiresAt }) {
        const now = new Date().toISOString();
        const metaStr = typeof meta === 'object' ? JSON.stringify(meta) : (meta || null);
        await d1.prepare('INSERT INTO payloads (ref, teacher_id, kind, ciphertext, meta, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(ref, teacherId, kind, ciphertext, metaStr, now, expiresAt || null)
          .run();
        return { ref };
      },
      async get(ref) {
        const row = await d1.prepare('SELECT * FROM payloads WHERE ref = ?').bind(ref).first();
        if (!row) return null;
        if (row.expires_at && row.expires_at < new Date().toISOString()) {
          return { expired: true };
        }
        return row;
      }
    },

    drops: {
      async create({ id, teacherId, assignmentId, publishVersion, expiresAt, secretHash = null }) {
        const now = new Date().toISOString();
        await d1.prepare('INSERT INTO drops (id, teacher_id, assignment_id, publish_version, created_at, expires_at, secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(id, teacherId, assignmentId, publishVersion ?? null, now, expiresAt || null, secretHash)
          .run();
        return { id };
      },
      async get(id) {
        const row = await d1.prepare('SELECT * FROM drops WHERE id = ?').bind(id).first();
        if (!row) return null;
        if (row.expires_at && row.expires_at < new Date().toISOString()) {
          return { expired: true };
        }
        return row;
      },
      async delete(id, teacherId) {
        const res = await d1.prepare('DELETE FROM drops WHERE id = ? AND teacher_id = ?').bind(id, teacherId).run();
        return (res?.meta?.changes ?? 0) > 0;
      }
    },

    drafts: {
      async put({ dropId, draftId, ciphertext, maxDrafts = 250 }) {
        const now = new Date().toISOString();
        const existing = await d1.prepare('SELECT draft_id FROM drafts WHERE drop_id = ? AND draft_id = ?').bind(dropId, draftId).first();
        if (!existing) {
          const countRow = await d1.prepare('SELECT count(*) as count FROM drafts WHERE drop_id = ?').bind(dropId).first();
          const count = countRow?.count || 0;
          if (count >= maxDrafts) {
            const err = new Error('DROP_DRAFT_QUOTA_EXCEEDED');
            err.code = 'QUOTA_EXCEEDED';
            throw err;
          }
        }
        await d1.prepare(`INSERT INTO drafts (drop_id, draft_id, ciphertext, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (drop_id, draft_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`)
          .bind(dropId, draftId, ciphertext, now)
          .run();
        return { updatedAt: now };
      },
      async get(dropId, draftId) {
        const row = await d1.prepare('SELECT ciphertext, updated_at FROM drafts WHERE drop_id = ? AND draft_id = ?').bind(dropId, draftId).first();
        return row ? { ciphertext: row.ciphertext, updated_at: row.updated_at } : null;
      }
    },

    workspaces: {
      async create({ id, keyHash, createdBy }) {
        await d1.prepare('INSERT INTO workspaces (id, key_hash, created_by, created_at) VALUES (?, ?, ?, ?)')
          .bind(id, keyHash, createdBy, new Date().toISOString())
          .run();
        return { id };
      },
      async get(id) {
        const row = await d1.prepare('SELECT * FROM workspaces WHERE id = ?').bind(id).first();
        return row || null;
      }
    },

    sync: {
      async putChunk({ workspaceId, deviceId, start, end, body }) {
        const res = await d1.prepare(`INSERT OR IGNORE INTO sync_chunks (workspace_id, device_id, start_seq, end_seq, body, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(workspaceId, deviceId, start, end, body, new Date().toISOString())
          .run();
        return { created: (res?.meta?.changes ?? 0) > 0 };
      },
      async listChunks(workspaceId, { after = 0, limit = 200 } = {}) {
        const res = await d1.prepare(`SELECT seq, device_id, start_seq AS start, end_seq AS end, body FROM sync_chunks
          WHERE workspace_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
          .bind(workspaceId, after, limit + 1)
          .all();
        const rows = res?.results || [];
        return { items: rows.slice(0, limit), more: rows.length > limit };
      },
      async deleteChunks(workspaceId, deviceId, through) {
        const res = await d1.prepare('DELETE FROM sync_chunks WHERE workspace_id = ? AND device_id = ? AND end_seq <= ?')
          .bind(workspaceId, deviceId, through)
          .run();
        return res?.meta?.changes ?? 0;
      },
      async putSnapshot({ workspaceId, deviceId, createdAt, body }) {
        await d1.prepare(`INSERT INTO sync_snapshots (workspace_id, device_id, created_at, body) VALUES (?, ?, ?, ?)
          ON CONFLICT (workspace_id, device_id) DO UPDATE SET created_at = excluded.created_at, body = excluded.body`)
          .bind(workspaceId, deviceId, createdAt, body)
          .run();
      },
      async listSnapshots(workspaceId) {
        const res = await d1.prepare('SELECT device_id, created_at FROM sync_snapshots WHERE workspace_id = ? ORDER BY created_at DESC')
          .bind(workspaceId)
          .all();
        return res?.results || [];
      },
      async getSnapshot(workspaceId, deviceId) {
        const row = await d1.prepare('SELECT created_at, body FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?')
          .bind(workspaceId, deviceId)
          .first();
        return row || null;
      }
    },

    submissions: {
      async create({ id, dropId, text, receivedAt = new Date().toISOString(), maxSubmissions = 500 }) {
        const countRow = await d1.prepare('SELECT count(*) as count FROM submissions WHERE drop_id = ?').bind(dropId).first();
        const count = countRow?.count || 0;
        if (count >= maxSubmissions) {
          const err = new Error('DROP_SUBMISSION_QUOTA_EXCEEDED');
          err.code = 'QUOTA_EXCEEDED';
          throw err;
        }
        await d1.prepare('INSERT INTO submissions (id, drop_id, received_at, text) VALUES (?, ?, ?, ?)')
          .bind(id, dropId, receivedAt, text)
          .run();
        return { id, receivedAt };
      },
      async list(dropId, { since } = {}) {
        let res;
        if (since) {
          res = await d1.prepare('SELECT id, received_at, text FROM submissions WHERE drop_id = ? AND received_at > ? ORDER BY received_at ASC')
            .bind(dropId, since)
            .all();
        } else {
          res = await d1.prepare('SELECT id, received_at, text FROM submissions WHERE drop_id = ? ORDER BY received_at ASC')
            .bind(dropId)
            .all();
        }
        return res?.results || [];
      }
    },

    feeds: {
      async put({ courseId, teacherId, ciphertext, etag, updatedAt = new Date().toISOString() }) {
        const existing = await d1.prepare('SELECT teacher_id FROM course_feeds WHERE course_id = ?').bind(courseId).first();
        if (existing && existing.teacher_id !== teacherId) {
          const err = new Error('FEED_OWNERSHIP_CONFLICT');
          err.code = 'FORBIDDEN';
          throw err;
        }
        await d1.prepare(`
          INSERT INTO course_feeds (course_id, teacher_id, ciphertext, etag, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(course_id) DO UPDATE SET
            teacher_id = excluded.teacher_id,
            ciphertext = excluded.ciphertext,
            etag = excluded.etag,
            updated_at = excluded.updated_at
        `)
          .bind(courseId, teacherId, ciphertext, etag, updatedAt)
          .run();
      },
      async get(courseId) {
        const row = await d1.prepare('SELECT course_id, teacher_id, ciphertext, etag, updated_at FROM course_feeds WHERE course_id = ?')
          .bind(courseId)
          .first();
        return row ? {
          courseId: row.course_id,
          teacherId: row.teacher_id,
          ciphertext: row.ciphertext,
          etag: row.etag,
          updatedAt: row.updated_at
        } : null;
      }
    },

    async getMediaSigningSecret() {
      const row = await d1.prepare('SELECT value FROM relay_meta WHERE key = ?').bind('media_signing_secret').first();
      if (row?.value) return row.value;
      let secret;
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const buf = new Uint8Array(32);
        crypto.getRandomValues(buf);
        secret = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        const { randomBytes } = await import('node:crypto');
        secret = randomBytes(32).toString('hex');
      }
      await d1.prepare('INSERT OR REPLACE INTO relay_meta (key, value) VALUES (?, ?)')
        .bind('media_signing_secret', secret)
        .run();
      return secret;
    },

    dropMedia: {
      async checkQuota(dropId, newBytes, { maxFiles = 100, maxTotalBytes = 100 * 1024 * 1024 } = {}) {
        const row = await d1.prepare('SELECT count(*) as count, coalesce(sum(size), 0) as total_size FROM drop_media WHERE drop_id = ?').bind(dropId).first();
        const count = Number(row?.count || 0);
        const totalSize = Number(row?.total_size || 0);
        if (count + 1 > maxFiles || totalSize + newBytes > maxTotalBytes) {
          const err = new Error('DROP_MEDIA_QUOTA_EXCEEDED');
          err.code = 'QUOTA_EXCEEDED';
          throw err;
        }
        return true;
      },
      async record({ dropId, key, size }) {
        const now = new Date().toISOString();
        await d1.prepare(`INSERT INTO drop_media (drop_id, key, size, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (key) DO UPDATE SET size = excluded.size`)
          .bind(dropId, key, size, now)
          .run();
        return { dropId, key, size, createdAt: now };
      },
      async getStats(dropId) {
        const row = await d1.prepare('SELECT count(*) as count, coalesce(sum(size), 0) as total_size FROM drop_media WHERE drop_id = ?').bind(dropId).first();
        return { count: Number(row?.count || 0), totalSize: Number(row?.total_size || 0) };
      }
    },

    feedbackDrops: {
      async put({ dropId, teacherId = null, ciphertext, expiresAt = null }) {
        const now = new Date().toISOString();
        const existing = await d1.prepare('SELECT teacher_id FROM feedback_drops WHERE drop_id = ?').bind(dropId).first();
        if (existing && existing.teacher_id && teacherId && existing.teacher_id !== teacherId) {
          const err = new Error('FEEDBACK_DROP_OWNERSHIP_CONFLICT');
          err.code = 'FORBIDDEN';
          throw err;
        }
        await d1.prepare(`INSERT INTO feedback_drops (drop_id, teacher_id, ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (drop_id) DO UPDATE SET teacher_id = coalesce(excluded.teacher_id, feedback_drops.teacher_id), ciphertext = excluded.ciphertext, created_at = excluded.created_at, expires_at = excluded.expires_at`)
          .bind(dropId, teacherId || null, ciphertext, now, expiresAt || null)
          .run();
        return { dropId, createdAt: now };
      },
      async get(dropId) {
        const row = await d1.prepare('SELECT * FROM feedback_drops WHERE drop_id = ?').bind(dropId).first();
        if (!row) return null;
        if (row.expires_at && row.expires_at < new Date().toISOString()) {
          return { expired: true };
        }
        return row;
      },
      async delete(dropId, teacherId = null) {
        if (teacherId) {
          const row = await d1.prepare('SELECT teacher_id FROM feedback_drops WHERE drop_id = ?').bind(dropId).first();
          if (row && row.teacher_id && row.teacher_id !== teacherId) {
            const err = new Error('FEEDBACK_DROP_OWNERSHIP_CONFLICT');
            err.code = 'FORBIDDEN';
            throw err;
          }
        }
        const res = await d1.prepare('DELETE FROM feedback_drops WHERE drop_id = ?').bind(dropId).run();
        return (res?.meta?.changes ?? 0) > 0;
      }
    },

    async checkMediaQuota(dropId, newBytes, opts) {
      return this.dropMedia.checkQuota(dropId, newBytes, opts);
    },

    async recordMediaUpload({ dropId, key, size }) {
      return this.dropMedia.record({ dropId, key, size });
    }
  };
}
