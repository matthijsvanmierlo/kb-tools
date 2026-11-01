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
 * Creates an async repository interface over Cloudflare D1 (env.DB).
 * @param {any} d1 - Cloudflare D1 database binding
 */
export function createD1Database(d1) {
  return {
    raw: d1,

    /**
     * Executes canonical schema DDL statement by statement.
     * Guarded by a relay_meta row to avoid duplicate runs.
     */
    async initSchema() {
      // Check if schema already initialized
      try {
        const metaRow = await d1.prepare('SELECT value FROM relay_meta WHERE key = ?').bind('schema_version').first();
        if (metaRow?.value === String(SCHEMA_VERSION)) {
          return;
        }
      } catch (_) {
        // Table doesn't exist yet, proceed with DDL
      }

      // Split into single statements
      const statements = RELAY_SCHEMA_SQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      for (const stmt of statements) {
        try {
          await d1.prepare(stmt).run();
        } catch (e) {
          // If prepare fails, try exec if available or log error
          try {
            if (typeof d1.exec === 'function') await d1.exec(stmt);
          } catch (_) {}
        }
      }

      try {
        await d1.prepare('INSERT OR REPLACE INTO relay_meta (key, value) VALUES (?, ?)')
          .bind('schema_version', String(SCHEMA_VERSION))
          .run();
      } catch (_) {}
    },

    /**
     * Remove expired payloads and drops, stale workspaces, chunks, snapshots,
     * and orphaned media. Returns keys of deleted blobs so caller can prune from BlobStore.
     */
    async pruneExpired({ retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
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

      // 1. Payloads
      try {
        const pRes = await d1.prepare('DELETE FROM payloads WHERE expires_at < ?').bind(now).run();
        result.payloadsPruned = pRes?.meta?.changes ?? 0;
      } catch (err) {
        console.error('[D1 Prune Error] Payloads:', err);
      }

      // 2. Drops
      try {
        const expiredDrops = await d1.prepare('SELECT id FROM drops WHERE expires_at < ?').bind(now).all();
        const dropList = expiredDrops?.results || [];
        for (const drop of dropList) {
          const mediaRows = await d1.prepare('SELECT key FROM drop_media WHERE drop_id = ?').bind(drop.id).all();
          for (const m of (mediaRows?.results || [])) expiredBlobKeys.push(m.key);

          const subRows = await d1.prepare('SELECT body_key FROM submissions WHERE drop_id = ? AND body_key IS NOT NULL').bind(drop.id).all();
          for (const s of (subRows?.results || [])) expiredBlobKeys.push(s.body_key);

          await d1.prepare('DELETE FROM media_refs WHERE owner_kind = ? AND owner_id = ?').bind('drop', drop.id).run();
          await d1.prepare('DELETE FROM drops WHERE id = ?').bind(drop.id).run();
          result.dropsPruned++;
        }
      } catch (err) {
        console.error('[D1 Prune Error] Drops:', err);
      }

      // 3. Feedback drops
      try {
        const fbRes = await d1.prepare('DELETE FROM feedback_drops WHERE expires_at IS NOT NULL AND expires_at < ?').bind(now).run();
        result.feedbackPruned = fbRes?.meta?.changes ?? 0;
      } catch (err) {
        console.error('[D1 Prune Error] Feedback:', err);
      }

      // 4. Feeds
      try {
        const fRes = await d1.prepare('DELETE FROM course_feeds WHERE expires_at < ?').bind(now).run();
        result.feedsPruned = fRes?.meta?.changes ?? 0;
      } catch (err) {
        console.error('[D1 Prune Error] Feeds:', err);
      }

      if (retentionDays > 0) {
        // 5. Submissions
        try {
          const subStale = await d1.prepare('SELECT body_key FROM submissions WHERE received_at < ? AND body_key IS NOT NULL').bind(cutoff).all();
          for (const s of (subStale?.results || [])) expiredBlobKeys.push(s.body_key);
          const sRes = await d1.prepare('DELETE FROM submissions WHERE received_at < ?').bind(cutoff).run();
          result.submissionsPruned = sRes?.meta?.changes ?? 0;
        } catch (err) {
          console.error('[D1 Prune Error] Submissions:', err);
        }

        // 6. Drafts
        try {
          const dfRes = await d1.prepare('DELETE FROM drafts WHERE updated_at < ?').bind(cutoff).run();
          result.draftsPruned = dfRes?.meta?.changes ?? 0;
        } catch (err) {
          console.error('[D1 Prune Error] Drafts:', err);
        }

        // 7. Workspaces
        try {
          const staleWorkspaces = await d1.prepare('SELECT id FROM workspaces WHERE last_seen_at < ?').bind(cutoff).all();
          for (const ws of (staleWorkspaces?.results || [])) {
            const chunkBlobs = await d1.prepare('SELECT body_key FROM sync_chunks WHERE workspace_id = ?').bind(ws.id).all();
            for (const c of (chunkBlobs?.results || [])) expiredBlobKeys.push(c.body_key);
            const snapBlobs = await d1.prepare('SELECT body_key FROM sync_snapshots WHERE workspace_id = ?').bind(ws.id).all();
            for (const s of (snapBlobs?.results || [])) expiredBlobKeys.push(s.body_key);
            await d1.prepare('DELETE FROM workspaces WHERE id = ?').bind(ws.id).run();
            result.workspacesPruned++;
          }
        } catch (err) {
          console.error('[D1 Prune Error] Workspaces:', err);
        }

        // 8. Stale Devices
        try {
          const staleDevices = await d1.prepare('SELECT workspace_id, device_id FROM workspace_devices WHERE last_seen_at < ?').bind(cutoff).all();
          for (const dev of (staleDevices?.results || [])) {
            const chunkBlobs = await d1.prepare('SELECT body_key FROM sync_chunks WHERE workspace_id = ? AND device_id = ?').bind(dev.workspace_id, dev.device_id).all();
            for (const c of (chunkBlobs?.results || [])) expiredBlobKeys.push(c.body_key);
            const snapBlobs = await d1.prepare('SELECT body_key FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').bind(dev.workspace_id, dev.device_id).all();
            for (const s of (snapBlobs?.results || [])) expiredBlobKeys.push(s.body_key);
            await d1.prepare('DELETE FROM sync_chunks WHERE workspace_id = ? AND device_id = ?').bind(dev.workspace_id, dev.device_id).run();
            await d1.prepare('DELETE FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').bind(dev.workspace_id, dev.device_id).run();
            await d1.prepare('DELETE FROM workspace_devices WHERE workspace_id = ? AND device_id = ?').bind(dev.workspace_id, dev.device_id).run();
          }
        } catch (err) {
          console.error('[D1 Prune Error] Stale Devices:', err);
        }

        // 9. Chunks GC
        try {
          const workspaces = await d1.prepare('SELECT id FROM workspaces').all();
          for (const ws of (workspaces?.results || [])) {
            const devices = await d1.prepare('SELECT device_id, last_ack_vector FROM workspace_devices WHERE workspace_id = ?').bind(ws.id).all();
            const devList = devices?.results || [];
            if (devList.length > 0) {
              let minAck = Infinity;
              for (const dev of devList) {
                let vec = {};
                try { vec = JSON.parse(dev.last_ack_vector || '{}'); } catch (_) {}
                const maxForDev = Math.max(...Object.values(vec).map(Number).filter(Number.isFinite), 0);
                if (maxForDev < minAck) minAck = maxForDev;
              }
              if (minAck > 0 && minAck !== Infinity) {
                const toPrune = await d1.prepare('SELECT body_key FROM sync_chunks WHERE workspace_id = ? AND end_seq <= ?').bind(ws.id, minAck).all();
                for (const c of (toPrune?.results || [])) expiredBlobKeys.push(c.body_key);
                const p = await d1.prepare('DELETE FROM sync_chunks WHERE workspace_id = ? AND end_seq <= ?').bind(ws.id, minAck).run();
                result.chunksPruned += p?.meta?.changes ?? 0;
              }
            }
          }
        } catch (err) {
          console.error('[D1 Prune Error] Chunks GC:', err);
        }

        // 10. Chunks cutoff
        try {
          const oldChunks = await d1.prepare('SELECT body_key FROM sync_chunks WHERE created_at < ?').bind(cutoff).all();
          for (const c of (oldChunks?.results || [])) expiredBlobKeys.push(c.body_key);
          const cp = await d1.prepare('DELETE FROM sync_chunks WHERE created_at < ?').bind(cutoff).run();
          result.chunksPruned += cp?.meta?.changes ?? 0;
        } catch (err) {
          console.error('[D1 Prune Error] Chunks Cutoff:', err);
        }

        // 11. Snapshots cutoff
        try {
          const snapRes = await d1.prepare(`
            DELETE FROM sync_snapshots
            WHERE created_at < ?
              AND rowid NOT IN (
                SELECT rowid FROM (
                  SELECT rowid, ROW_NUMBER() OVER (PARTITION BY workspace_id, device_id ORDER BY created_at DESC) as rn
                  FROM sync_snapshots
                ) WHERE rn = 1
              )
          `).bind(cutoff).run();
          result.snapshotsPruned = snapRes?.meta?.changes ?? 0;
        } catch (err) {
          console.error('[D1 Prune Error] Snapshots:', err);
        }
      }

      // 12. Media GC
      try {
        const unreferenced = await d1.prepare(`
          SELECT sha, size FROM media_refs
          WHERE created_at < ?
            AND NOT EXISTS (SELECT 1 FROM drop_media WHERE drop_media.key = media_refs.sha)
        `).bind(oneDayAgo).all();
        for (const u of (unreferenced?.results || [])) {
          expiredBlobKeys.push(u.sha);
          await d1.prepare('DELETE FROM media_refs WHERE sha = ?').bind(u.sha).run();
          result.mediaRefsPruned++;
        }
      } catch (err) {
        console.error('[D1 Prune Error] Media Refs:', err);
      }

      // 13. Recompute teacher bytes
      try {
        await this.recomputeAllTeachersBytesUsed();
      } catch (err) {
        console.error('[D1 Prune Error] Quota Recompute:', err);
      }

      return result;
    },

    async recomputeAllTeachersBytesUsed() {
      const teachers = await d1.prepare('SELECT id FROM teachers').all();
      for (const t of (teachers?.results || [])) {
        await this.teachers.recomputeBytesUsed(t.id);
      }
    },

    teachers: {
      async create({ id, name, tokenHash, createdAt = new Date().toISOString() }) {
        await d1.prepare('INSERT INTO teachers (id, name, token_hash, bytes_used, created_at) VALUES (?, ?, ?, 0, ?)')
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
      },
      async adjustBytesUsed(teacherId, deltaBytes) {
        await d1.prepare('UPDATE teachers SET bytes_used = MAX(0, bytes_used + ?) WHERE id = ?')
          .bind(deltaBytes, teacherId)
          .run();
      },
      async recomputeBytesUsed(teacherId) {
        let total = 0;
        const wsRows = await d1.prepare('SELECT id FROM workspaces WHERE created_by = ?').bind(teacherId).all();
        for (const ws of (wsRows?.results || [])) {
          const snapRow = await d1.prepare('SELECT COALESCE(SUM(size), 0) as s FROM sync_snapshots WHERE workspace_id = ?').bind(ws.id).first();
          const chunkRow = await d1.prepare('SELECT COALESCE(SUM(size), 0) as s FROM sync_chunks WHERE workspace_id = ?').bind(ws.id).first();
          total += Number(snapRow?.s || 0) + Number(chunkRow?.s || 0);
        }
        const feedRow = await d1.prepare('SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) as s FROM course_feeds WHERE teacher_id = ?').bind(teacherId).first();
        total += Number(feedRow?.s || 0);
        const payloadRow = await d1.prepare('SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) as s FROM payloads WHERE teacher_id = ?').bind(teacherId).first();
        total += Number(payloadRow?.s || 0);

        const dropRows = await d1.prepare('SELECT id FROM drops WHERE teacher_id = ?').bind(teacherId).all();
        for (const d of (dropRows?.results || [])) {
          const subRow = await d1.prepare('SELECT COALESCE(SUM(size), 0) as s FROM submissions WHERE drop_id = ?').bind(d.id).first();
          const mediaRow = await d1.prepare('SELECT COALESCE(SUM(size), 0) as s FROM drop_media WHERE drop_id = ?').bind(d.id).first();
          total += Number(subRow?.s || 0) + Number(mediaRow?.s || 0);
        }
        const teacherMediaRow = await d1.prepare('SELECT COALESCE(SUM(size), 0) as s FROM media_refs WHERE owner_kind = ? AND owner_id = ?').bind('teacher', teacherId).first();
        total += Number(teacherMediaRow?.s || 0);

        await d1.prepare('UPDATE teachers SET bytes_used = ? WHERE id = ?').bind(total, teacherId).run();
        return total;
      },
      async getUsage(teacherId) {
        const teacher = await d1.prepare('SELECT * FROM teachers WHERE id = ?').bind(teacherId).first();
        if (!teacher) return null;

        let snapTotal = 0;
        let chunkTotal = 0;
        const wsList = await d1.prepare('SELECT id, created_at, last_seen_at FROM workspaces WHERE created_by = ?').bind(teacherId).all();
        const workspaces = [];

        for (const ws of (wsList?.results || [])) {
          const snapRow = await d1.prepare('SELECT COALESCE(SUM(size), 0) as s FROM sync_snapshots WHERE workspace_id = ?').bind(ws.id).first();
          const chunkRow = await d1.prepare('SELECT COALESCE(SUM(size), 0) as s FROM sync_chunks WHERE workspace_id = ?').bind(ws.id).first();
          snapTotal += Number(snapRow?.s || 0);
          chunkTotal += Number(chunkRow?.s || 0);

          const devList = await d1.prepare('SELECT device_id, last_seen_at FROM workspace_devices WHERE workspace_id = ?').bind(ws.id).all();
          workspaces.push({
            id: ws.id,
            created_at: ws.created_at,
            last_seen_at: ws.last_seen_at,
            devices: devList?.results || []
          });
        }

        const feedRow = await d1.prepare('SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) as s FROM course_feeds WHERE teacher_id = ?').bind(teacherId).first();
        const payloadRow = await d1.prepare('SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) as s FROM payloads WHERE teacher_id = ?').bind(teacherId).first();

        let dropSubTotal = 0;
        let dropMediaTotal = 0;
        const dropRows = await d1.prepare('SELECT id FROM drops WHERE teacher_id = ?').bind(teacherId).all();
        for (const d of (dropRows?.results || [])) {
          const subRow = await d1.prepare('SELECT COALESCE(SUM(size), 0) as s FROM submissions WHERE drop_id = ?').bind(d.id).first();
          const mediaRow = await d1.prepare('SELECT COALESCE(SUM(size), 0) as s FROM drop_media WHERE drop_id = ?').bind(d.id).first();
          dropSubTotal += Number(subRow?.s || 0);
          dropMediaTotal += Number(mediaRow?.s || 0);
        }

        const teacherMediaRow = await d1.prepare('SELECT COALESCE(SUM(size), 0) as s FROM media_refs WHERE owner_kind = ? AND owner_id = ?').bind('teacher', teacherId).first();

        const quotaMb = Number(process.env?.KB_RELAY_TEACHER_QUOTA_MB || DEFAULT_TEACHER_QUOTA_MB);
        const quotaBytes = quotaMb * 1024 * 1024;

        return {
          teacher_id: teacher.id,
          name: teacher.name,
          bytes_used: teacher.bytes_used,
          quota_bytes: quotaBytes,
          by_category: {
            snapshots: snapTotal,
            chunks: chunkTotal,
            feeds: Number(feedRow?.s || 0),
            payloads: Number(payloadRow?.s || 0),
            drops: dropSubTotal,
            media: dropMediaTotal + Number(teacherMediaRow?.s || 0)
          },
          workspaces
        };
      }
    },

    payloads: {
      async create({ ref, teacherId, kind, ciphertext, meta, expiresAt }) {
        const now = new Date().toISOString();
        const metaStr = typeof meta === 'object' ? JSON.stringify(meta) : (meta || null);
        await d1.prepare('INSERT INTO payloads (ref, teacher_id, kind, ciphertext, meta, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(ref, teacherId, kind, ciphertext, metaStr, now, expiresAt)
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
        const finalExpires = expiresAt || new Date(Date.now() + 180 * 86400 * 1000).toISOString();
        await d1.prepare('INSERT INTO drops (id, teacher_id, assignment_id, publish_version, created_at, expires_at, secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(id, teacherId, assignmentId, publishVersion ?? null, now, finalExpires, secretHash ?? null)
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
        const drop = await d1.prepare('SELECT * FROM drops WHERE id = ? AND teacher_id = ?').bind(id, teacherId).first();
        if (!drop) return { deleted: false, blobKeys: [] };

        const blobKeys = [];
        const mediaRows = await d1.prepare('SELECT key FROM drop_media WHERE drop_id = ?').bind(id).all();
        for (const m of (mediaRows?.results || [])) blobKeys.push(m.key);
        const subRows = await d1.prepare('SELECT body_key FROM submissions WHERE drop_id = ? AND body_key IS NOT NULL').bind(id).all();
        for (const s of (subRows?.results || [])) blobKeys.push(s.body_key);

        await d1.prepare('DELETE FROM media_refs WHERE owner_kind = ? AND owner_id = ?').bind('drop', id).run();
        const res = await d1.prepare('DELETE FROM drops WHERE id = ? AND teacher_id = ?').bind(id, teacherId).run();
        return { deleted: (res?.meta?.changes ?? 0) > 0, blobKeys };
      }
    },

    drafts: {
      async put({ dropId, draftId, ciphertext, maxDrafts = 250 }) {
        const now = new Date().toISOString();
        // Atomic conditional insert using D1 batch or check
        const existing = await d1.prepare('SELECT draft_id FROM drafts WHERE drop_id = ? AND draft_id = ?').bind(dropId, draftId).first();
        if (!existing) {
          const countRow = await d1.prepare('SELECT count(*) as count FROM drafts WHERE drop_id = ?').bind(dropId).first();
          if ((countRow?.count || 0) >= maxDrafts) {
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
        const row = await d1.prepare('SELECT ciphertext, updated_at FROM drafts WHERE drop_id = ? AND draft_id = ?')
          .bind(dropId, draftId)
          .first();
        return row || null;
      }
    },

    workspaces: {
      async create({ id, keyHash, createdBy }) {
        const now = new Date().toISOString();
        await d1.prepare('INSERT INTO workspaces (id, key_hash, created_by, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
          .bind(id, keyHash, createdBy, now, now)
          .run();
        return { id };
      },
      async get(id) {
        const row = await d1.prepare('SELECT * FROM workspaces WHERE id = ?').bind(id).first();
        return row || null;
      },
      async touch(id) {
        await d1.prepare('UPDATE workspaces SET last_seen_at = ? WHERE id = ?').bind(new Date().toISOString(), id).run();
      },
      async delete(id) {
        const blobKeys = [];
        const chunkBlobs = await d1.prepare('SELECT body_key FROM sync_chunks WHERE workspace_id = ?').bind(id).all();
        for (const c of (chunkBlobs?.results || [])) blobKeys.push(c.body_key);
        const snapBlobs = await d1.prepare('SELECT body_key FROM sync_snapshots WHERE workspace_id = ?').bind(id).all();
        for (const s of (snapBlobs?.results || [])) blobKeys.push(s.body_key);

        const res = await d1.prepare('DELETE FROM workspaces WHERE id = ?').bind(id).run();
        return { deleted: (res?.meta?.changes ?? 0) > 0, blobKeys };
      },
      async getDevice(workspaceId, deviceId) {
        const row = await d1.prepare('SELECT * FROM workspace_devices WHERE workspace_id = ? AND device_id = ?').bind(workspaceId, deviceId).first();
        return row || null;
      },
      async registerDevice({ workspaceId, deviceId, deviceTokenHash }) {
        const now = new Date().toISOString();
        await d1.prepare(`
          INSERT INTO workspace_devices (workspace_id, device_id, device_token_hash, last_seen_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(workspace_id, device_id) DO UPDATE SET
            device_token_hash = COALESCE(excluded.device_token_hash, workspace_devices.device_token_hash),
            last_seen_at = excluded.last_seen_at
        `).bind(workspaceId, deviceId, deviceTokenHash || null, now).run();
      },
      async touchDevice(workspaceId, deviceId) {
        const now = new Date().toISOString();
        await d1.prepare('UPDATE workspace_devices SET last_seen_at = ? WHERE workspace_id = ? AND device_id = ?').bind(now, workspaceId, deviceId).run();
        await d1.prepare('UPDATE workspaces SET last_seen_at = ? WHERE id = ?').bind(now, workspaceId).run();
      },
      async ackVector({ workspaceId, deviceId, vector }) {
        const now = new Date().toISOString();
        const vecStr = typeof vector === 'object' ? JSON.stringify(vector) : String(vector);
        await d1.prepare(`
          INSERT INTO workspace_devices (workspace_id, device_id, last_seen_at, last_ack_vector)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(workspace_id, device_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            last_ack_vector = excluded.last_ack_vector
        `).bind(workspaceId, deviceId, now, vecStr).run();
        await d1.prepare('UPDATE workspaces SET last_seen_at = ? WHERE id = ?').bind(now, workspaceId).run();
      },
      async deleteDevice(workspaceId, deviceId) {
        const blobKeys = [];
        const chunkBlobs = await d1.prepare('SELECT body_key FROM sync_chunks WHERE workspace_id = ? AND device_id = ?').bind(workspaceId, deviceId).all();
        for (const c of (chunkBlobs?.results || [])) blobKeys.push(c.body_key);
        const snapBlobs = await d1.prepare('SELECT body_key FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').bind(workspaceId, deviceId).all();
        for (const s of (snapBlobs?.results || [])) blobKeys.push(s.body_key);

        await d1.prepare('DELETE FROM sync_chunks WHERE workspace_id = ? AND device_id = ?').bind(workspaceId, deviceId).run();
        await d1.prepare('DELETE FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').bind(workspaceId, deviceId).run();
        const res = await d1.prepare('DELETE FROM workspace_devices WHERE workspace_id = ? AND device_id = ?').bind(workspaceId, deviceId).run();
        return { deleted: (res?.meta?.changes ?? 0) > 0, blobKeys };
      },
      async listDevices(workspaceId) {
        const rows = await d1.prepare('SELECT device_id, last_seen_at FROM workspace_devices WHERE workspace_id = ?').bind(workspaceId).all();
        return rows?.results || [];
      }
    },

    sync: {
      async putChunk({ workspaceId, deviceId, start, end, bodyKey, size, sha256, body }) {
        const bKey = bodyKey ?? (body ? `chunk_${workspaceId}_${deviceId}_${start}_${end}` : null);
        const sz = size ?? (body ? (typeof body === 'string' ? new TextEncoder().encode(body).length : body.byteLength || 0) : 0);
        const hash = sha256 ?? null;
        const res = await d1.prepare(`
          INSERT OR IGNORE INTO sync_chunks (workspace_id, device_id, start_seq, end_seq, body_key, size, sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(workspaceId, deviceId, start, end, bKey, sz, hash, new Date().toISOString()).run();
        return { created: (res?.meta?.changes ?? 0) > 0 };
      },
      async listChunks(workspaceId, { after = 0, limit = CHUNK_LIST_PAGE_LIMIT } = {}) {
        const safeLimit = Math.min(Math.max(1, limit), CHUNK_LIST_PAGE_LIMIT);
        const res = await d1.prepare(`
          SELECT seq, device_id, start_seq AS start, end_seq AS end, body_key, size, sha256
          FROM sync_chunks
          WHERE workspace_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?
        `).bind(workspaceId, after, safeLimit + 1).all();

        const rows = res?.results || [];
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
      async deleteChunks(workspaceId, deviceId, through) {
        const toDelete = await d1.prepare('SELECT body_key FROM sync_chunks WHERE workspace_id = ? AND device_id = ? AND end_seq <= ?')
          .bind(workspaceId, deviceId, through).all();
        const blobKeys = (toDelete?.results || []).map(r => r.body_key);
        const res = await d1.prepare('DELETE FROM sync_chunks WHERE workspace_id = ? AND device_id = ? AND end_seq <= ?')
          .bind(workspaceId, deviceId, through).run();
        return { deleted: res?.meta?.changes ?? 0, blobKeys };
      },
      async putSnapshot({ workspaceId, deviceId, createdAt, bodyKey, size, sha256, body }) {
        const bKey = bodyKey ?? (body ? `snap_${workspaceId}_${deviceId}` : null);
        const sz = size ?? (body ? (typeof body === 'string' ? new TextEncoder().encode(body).length : body.byteLength || 0) : 0);
        const hash = sha256 ?? null;
        const existing = await d1.prepare('SELECT body_key FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').bind(workspaceId, deviceId).first();
        const oldKey = existing?.body_key && existing.body_key !== bKey ? existing.body_key : null;

        await d1.prepare(`
          INSERT INTO sync_snapshots (workspace_id, device_id, created_at, body_key, size, sha256)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, device_id) DO UPDATE SET
            created_at = excluded.created_at,
            body_key = excluded.body_key,
            size = excluded.size,
            sha256 = excluded.sha256
        `).bind(workspaceId, deviceId, createdAt, bKey, sz, hash).run();

        return { oldKey };
      },
      async listSnapshots(workspaceId) {
        const res = await d1.prepare('SELECT device_id, created_at FROM sync_snapshots WHERE workspace_id = ? ORDER BY created_at DESC').bind(workspaceId).all();
        return res?.results || [];
      },
      async getSnapshot(workspaceId, deviceId) {
        const row = await d1.prepare('SELECT created_at, body_key, size, sha256 FROM sync_snapshots WHERE workspace_id = ? AND device_id = ?').bind(workspaceId, deviceId).first();
        return row || null;
      }
    },

    submissions: {
      async create({ id, dropId, text, bodyKey = null, size = 0, receivedAt = new Date().toISOString(), maxSubmissions = 500 }) {
        const existing = await d1.prepare('SELECT id, received_at FROM submissions WHERE id = ?').bind(id).first();
        if (existing) {
          return { id: existing.id, receivedAt: existing.received_at, duplicate: true };
        }

        const countRow = await d1.prepare('SELECT count(*) as count FROM submissions WHERE drop_id = ?').bind(dropId).first();
        if ((countRow?.count || 0) >= maxSubmissions) {
          const err = new Error('DROP_SUBMISSION_QUOTA_EXCEEDED');
          err.code = 'QUOTA_EXCEEDED';
          throw err;
        }

        await d1.prepare(`
          INSERT INTO submissions (id, drop_id, received_at, text, body_key, size)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `).bind(id, dropId, receivedAt, text || null, bodyKey || null, size).run();

        return { id, receivedAt, duplicate: false };
      },
      async list(dropId, { since = null, after = null, limit = SUBMISSION_LIST_PAGE_LIMIT } = {}) {
        const safeLimit = Math.min(Math.max(1, limit), SUBMISSION_LIST_PAGE_LIMIT);
        let sql = 'SELECT id, received_at, text, body_key, size FROM submissions WHERE drop_id = ?';
        const params = [dropId];

        if (since) {
          sql += ' AND received_at > ?';
          params.push(since);
        }
        if (after) {
          sql += ' AND received_at > ?';
          params.push(after);
        }
        sql += ' ORDER BY received_at ASC LIMIT ?';
        params.push(safeLimit);

        const res = await d1.prepare(sql).bind(...params).all();
        return res?.results || [];
      },
      async count(dropId) {
        const row = await d1.prepare('SELECT count(*) as count FROM submissions WHERE drop_id = ?').bind(dropId).first();
        return row?.count || 0;
      }
    },

    feeds: {
      async put({ courseId, teacherId, ciphertext, etag, updatedAt = new Date().toISOString(), expiresAt }) {
        const existing = await d1.prepare('SELECT teacher_id FROM course_feeds WHERE course_id = ?').bind(courseId).first();
        if (existing && existing.teacher_id !== teacherId) {
          const err = new Error('FEED_OWNERSHIP_CONFLICT');
          err.code = 'FORBIDDEN';
          throw err;
        }
        await d1.prepare(`
          INSERT INTO course_feeds (course_id, teacher_id, ciphertext, etag, updated_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(course_id) DO UPDATE SET
            teacher_id = excluded.teacher_id,
            ciphertext = excluded.ciphertext,
            etag = excluded.etag,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at
        `).bind(courseId, teacherId, ciphertext, etag, updatedAt, expiresAt).run();
      },
      async get(courseId) {
        const row = await d1.prepare('SELECT course_id, teacher_id, ciphertext, etag, updated_at, expires_at FROM course_feeds WHERE course_id = ?').bind(courseId).first();
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
      async delete(courseId, teacherId) {
        const existing = await d1.prepare('SELECT teacher_id FROM course_feeds WHERE course_id = ?').bind(courseId).first();
        if (!existing) return false;
        if (existing.teacher_id !== teacherId) {
          const err = new Error('FEED_OWNERSHIP_CONFLICT');
          err.code = 'FORBIDDEN';
          throw err;
        }
        const res = await d1.prepare('DELETE FROM course_feeds WHERE course_id = ?').bind(courseId).run();
        return (res?.meta?.changes ?? 0) > 0;
      }
    },

    mediaRefs: {
      async addRef({ sha, ownerKind, ownerId, size }) {
        const now = new Date().toISOString();
        await d1.prepare(`
          INSERT INTO media_refs (sha, owner_kind, owner_id, size, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (sha, owner_kind, owner_id) DO UPDATE SET size = excluded.size
        `).bind(sha, ownerKind, ownerId, size, now).run();
      },
      async removeRefs(ownerKind, ownerId) {
        await d1.prepare('DELETE FROM media_refs WHERE owner_kind = ? AND owner_id = ?').bind(ownerKind, ownerId).run();
      }
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
        await d1.prepare(`INSERT INTO media_refs (sha, owner_kind, owner_id, size, created_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(sha, owner_kind, owner_id) DO UPDATE SET size = excluded.size`)
          .bind(key, 'drop', dropId, size, now)
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

    async getMediaSigningSecret() {
      const row = await d1.prepare('SELECT value FROM relay_meta WHERE key = ?').bind('media_signing_secret').first();
      if (row?.value) return row.value;

      // In browser/worker, generate 32 random bytes hex
      let secret;
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        secret = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        const { randomBytes } = await import('node:crypto');
        secret = randomBytes(32).toString('hex');
      }

      await d1.prepare('INSERT OR IGNORE INTO relay_meta (key, value) VALUES (?, ?)').bind('media_signing_secret', secret).run();
      const row2 = await d1.prepare('SELECT value FROM relay_meta WHERE key = ?').bind('media_signing_secret').first();
      return row2?.value || secret;
    },

    async checkMediaQuota(dropId, newBytes, opts) {
      return this.dropMedia.checkQuota(dropId, newBytes, opts);
    },

    async recordMediaUpload({ dropId, key, size }) {
      return this.dropMedia.record({ dropId, key, size });
    }
  };
}
