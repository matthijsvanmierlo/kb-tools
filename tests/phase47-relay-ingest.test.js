import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDatabase } from '../server/relay/db.js';
import { createRelayFetchHandler } from '../server/relay/handler.js';
import { pullDrop } from '../src/core/drop-pull.js';
import { recordTaskSubmission } from '../src/modules/tasks/submissions.js';
import { storage } from '../src/core/storage.js';

describe('Phase 47: Lossless Relay Ingest (R3)', () => {
  let db;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    // Clear indexeddb tables
    for (const t of ['task_submissions', 'app_metadata']) {
      await storage.table(t).clear().catch(() => {});
    }
  });

  describe('R3.1: Keyset cursor for submissions with identical received_at', () => {
    it('returns all 150 submissions exactly once across multiple pages', () => {
      // 1. Setup teacher and drop
      db.teachers.create({ id: 't1', name: 'Teacher 1', tokenHash: 'hash1' });
      db.drops.create({
        id: 'drop-150',
        teacherId: 't1',
        assignmentId: 'asg-150',
        publishVersion: 1,
        expiresAt: new Date(Date.now() + 86400000).toISOString()
      });

      // 2. Insert 150 submissions with identical received_at
      const sameReceivedAt = '2026-11-01T12:00:00.000Z';
      for (let i = 1; i <= 150; i++) {
        const id = `sub_${String(i).padStart(4, '0')}`;
        db.submissions.create({
          id,
          dropId: 'drop-150',
          receivedAt: sameReceivedAt,
          text: `KBSUB1.payload_${id}`,
          size: 50
        });
      }

      // 3. Paging with limit 50
      const pageSize = 50;
      let after = null;
      let collected = [];
      let pages = 0;

      while (true) {
        pages++;
        const res = db.submissions.list('drop-150', { after, limit: pageSize });
        const items = res.items || res;
        collected.push(...items);
        if (!res.more) break;
        after = res.next_after;
      }

      expect(pages).toBe(3);
      expect(collected.length).toBe(150);

      // Verify every submission is present and there are no duplicates
      const ids = collected.map(s => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(150);
      expect(ids[0]).toBe('sub_0001');
      expect(ids[149]).toBe('sub_0150');
    });
  });

  describe('R3.2: Shared pullDrop with error tolerance and cursor advancement', () => {
    it('imports good items, reports corrupt ones without halting, and advances cursor past corrupt item', async () => {
      const mockItems = [
        { id: 'sub_1', received_at: '2026-11-01T12:00:01.000Z', text: 'valid_1' },
        { id: 'sub_2', received_at: '2026-11-01T12:00:02.000Z', text: 'corrupt_item' },
        { id: 'sub_3', received_at: '2026-11-01T12:00:03.000Z', text: 'valid_2' }
      ];

      const mockTransport = {
        listDrop: vi.fn().mockResolvedValue({
          items: mockItems,
          next_after: '2026-11-01T12:00:03.000Z|sub_3',
          more: false
        })
      };

      const imported = [];
      const res = await pullDrop({
        transport: mockTransport,
        dropId: 'drop-test',
        onItem: async (item) => {
          if (item.text === 'corrupt_item') {
            throw new Error('CORRUPT_PAYLOAD');
          }
          imported.push(item.id);
          return { ok: true };
        }
      });

      expect(res.count).toBe(3);
      expect(res.imported).toBe(2);
      expect(res.failures.length).toBe(1);
      expect(res.failures[0].id).toBe('sub_2');
      expect(res.failures[0].error).toContain('CORRUPT_PAYLOAD');
      expect(imported).toEqual(['sub_1', 'sub_3']);

      // Check cursor advanced past all items including the corrupt one
      const cursors = await storage.getMetadata('relay_cursors');
      expect(cursors['drop-test']).toBe('2026-11-01T12:00:03.000Z|sub_3');
    });
  });

  describe('R3.3 & R3.4: Task submission de-duplication and staged persistence', () => {
    it('counts duplicate when the same task envelope is imported twice', async () => {
      const submission1 = {
        id: 'sub-t-1',
        task_id: 'task-dedup-1',
        student_id: 'S100',
        student_name: 'Carol',
        submitted_at: '2026-11-01T10:00:00.000Z',
        content: { text: 'Initial work' }
      };

      const res1 = await recordTaskSubmission(submission1);
      expect(res1.duplicate).toBeFalsy();
      expect(res1.is_latest).toBe(true);

      // Import the same envelope again (same student_id, same submitted_at)
      const submission2 = {
        id: 'sub-t-2',
        task_id: 'task-dedup-1',
        student_id: 'S100',
        student_name: 'Carol',
        submitted_at: '2026-11-01T10:00:00.000Z',
        content: { text: 'Initial work' }
      };

      const res2 = await recordTaskSubmission(submission2);
      expect(res2.duplicate).toBe(true);
    });

    it('persists inbox_staged so items survive navigation', async () => {
      const stagedList = [
        { id: 'it-1', text: 'KBSUB1.mock1', source: 'test' },
        { id: 'it-2', text: 'KBSUB1.mock2', source: 'test' }
      ];

      await storage.setMetadata('inbox_staged', stagedList);

      // Re-read like a reloaded view
      const loaded = await storage.getMetadata('inbox_staged');
      expect(loaded).toEqual(stagedList);
    });
  });

  describe('R3.6: Server expired feed returns 410 with no ETag', () => {
    it('returns 410 without ETag when feed is expired', async () => {
      db.teachers.create({ id: 't-feed', name: 'Teacher Feed', tokenHash: 'feedhash' });
      db.feeds.put({
        courseId: 'course-expired',
        teacherId: 't-feed',
        ciphertext: 'cipher123',
        etag: 'etag123',
        expiresAt: '2020-01-01T00:00:00.000Z' // Expired in the past
      });

      const handleFetch = createRelayFetchHandler({
        db,
        env: { RELAY_SIGNING_SECRET: 'test-secret' }
      });

      const request = new Request('http://localhost:3000/feed/course-expired', {
        method: 'GET'
      });

      const response = await handleFetch(request);

      expect(response.status).toBe(410);
      expect(response.headers.get('ETag')).toBeNull();
      const body = await response.json();
      expect(body.error).toContain('expired');
    });
  });

  describe('R3.6: Teacher media survives prune past 24 hours', () => {
    it('preserves teacher media refs while pruning unreferenced drop media', () => {
      const twoDaysAgo = new Date(Date.now() - 48 * 3600000).toISOString();

      // Teacher upload media_refs
      db.raw.prepare(`
        INSERT INTO media_refs (sha, owner_kind, owner_id, size, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('teacher-blob-sha', 'teacher', 't1', 1000, twoDaysAgo);

      // Drop media_refs with no drop_media row
      db.raw.prepare(`
        INSERT INTO media_refs (sha, owner_kind, owner_id, size, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('drop-orphan-sha', 'drop', 'drop-x', 500, twoDaysAgo);

      // Prune with 0 retention days
      const pruneRes = db.pruneExpired({ retentionDays: 0 });

      // Drop orphan should be pruned
      expect(pruneRes.mediaRefsPruned).toBeGreaterThanOrEqual(1);
      const orphan = db.raw.prepare('SELECT 1 FROM media_refs WHERE sha = ?').get('drop-orphan-sha');
      expect(orphan).toBeUndefined();

      // Teacher media ref must survive
      const teacherRef = db.raw.prepare('SELECT 1 FROM media_refs WHERE sha = ?').get('teacher-blob-sha');
      expect(teacherRef).toBeTruthy();
    });
  });
});
