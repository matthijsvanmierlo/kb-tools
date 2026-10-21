// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../server/relay/worker.js';
import { createD1Database } from '../server/relay/d1-db.js';
import { generateToken, hashToken } from '../server/relay/auth.js';
import { router } from '../src/router.js';
import { storage } from '../src/core/storage.js';
import { getTransport, setTransportConfig, RelayTransport } from '../src/core/transport.js';
import { initRelay } from '../scripts/relay-init.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Creates an in-memory mock of Cloudflare D1 (env.DB) using node:sqlite.
 */
function createMockD1() {
  const db = new DatabaseSync(':memory:');

  return {
    raw: db,
    async exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      return {
        _params: [],
        bind(...params) {
          this._params = params;
          return this;
        },
        async first() {
          const stmt = db.prepare(sql);
          return stmt.get(...this._params) || null;
        },
        async all() {
          const stmt = db.prepare(sql);
          const results = stmt.all(...this._params);
          return { results, meta: { changes: 0 } };
        },
        async run() {
          const stmt = db.prepare(sql);
          const res = stmt.run(...this._params);
          return { meta: { changes: res.changes } };
        }
      };
    }
  };
}

/**
 * Creates an in-memory mock of Cloudflare R2 (env.MEDIA_BUCKET).
 */
function createMockR2() {
  const store = new Map();
  return {
    async put(key, data, options = {}) {
      const bytes = data instanceof Uint8Array ? data : Buffer.from(data);
      store.set(key, {
        data: bytes,
        httpMetadata: options.httpMetadata || {}
      });
      return { key };
    },
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      return {
        async arrayBuffer() {
          return item.data.buffer.slice(item.data.byteOffset, item.data.byteOffset + item.data.byteLength);
        },
        httpMetadata: item.httpMetadata
      };
    },
    raw: store
  };
}

describe('Phase 37: Cloudflare Worker, D1 Database, and Zero-Leak #/connect Route', () => {
  let mockD1;
  let mockR2;
  let d1Db;
  let env;
  const teacherId = 'T-CF-1';
  const teacherToken = generateToken();

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await storage.init();
    await setTransportConfig(null);

    mockD1 = createMockD1();
    mockR2 = createMockR2();
    d1Db = createD1Database(mockD1);
    await d1Db.initSchema();

    // Seed test teacher in D1
    await d1Db.teachers.create({
      id: teacherId,
      name: 'Cloudflare Teacher',
      tokenHash: hashToken(teacherToken)
    });

    env = {
      DB: mockD1,
      MEDIA_BUCKET: mockR2,
      KB_RELAY_ORIGINS: '*',
      KB_RELAY_RETENTION_DAYS: '180'
    };
  });

  describe('1. Cloudflare Worker Endpoint Parity & Features', () => {
    it('serves /api/v1/health with media feature when R2 bucket is bound', async () => {
      const req = new Request('https://relay.test.workers.dev/api/v1/health');
      const res = await worker.fetch(req, env, {});
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.features).toContain('payloads');
      expect(data.features).toContain('media');
    });

    it('handles teacher payload publish and retrieval over Cloudflare Worker', async () => {
      // Publish payload
      const pubReq = new Request('https://relay.test.workers.dev/api/v1/payloads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${teacherToken}`
        },
        body: JSON.stringify({
          kind: 'flashcards',
          ciphertext: 'ENC_FLASHCARDS_BLOB',
          meta: { title: 'French Deck' }
        })
      });
      const pubRes = await worker.fetch(pubReq, env, {});
      expect(pubRes.status).toBe(201);
      const { ref } = await pubRes.json();
      expect(ref).toBeTruthy();

      // Retrieve payload
      const getReq = new Request(`https://relay.test.workers.dev/api/v1/payloads/${ref}`);
      const getRes = await worker.fetch(getReq, env, {});
      expect(getRes.status).toBe(200);
      const body = await getRes.json();
      expect(body.kind).toBe('flashcards');
      expect(body.ciphertext).toBe('ENC_FLASHCARDS_BLOB');
    });

    it('rejects unauthorized teacher actions with 401', async () => {
      const pubReq = new Request('https://relay.test.workers.dev/api/v1/payloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'flashcards', ciphertext: 'xyz' })
      });
      const res = await worker.fetch(pubReq, env, {});
      expect(res.status).toBe(401);
    });

    it('handles drops, drop secrets, student submissions, and teacher retrieval', async () => {
      // Create drop
      const dropReq = new Request('https://relay.test.workers.dev/api/v1/drops', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${teacherToken}`
        },
        body: JSON.stringify({ assignment_id: 'asg-cf-1' })
      });
      const dropRes = await worker.fetch(dropReq, env, {});
      expect(dropRes.status).toBe(201);
      const { drop_id: dropId, drop_secret: dropSecret } = await dropRes.json();
      expect(dropId).toBeTruthy();
      expect(dropSecret).toBeTruthy();

      // Student submission without secret is rejected with 403
      const badSubReq = new Request(`https://relay.test.workers.dev/api/v1/drops/${dropId}/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'KBSUB1.student_encrypted_data'
      });
      const badSubRes = await worker.fetch(badSubReq, env, {});
      expect(badSubRes.status).toBe(403);

      // Student submission with secret succeeds
      const subReq = new Request(`https://relay.test.workers.dev/api/v1/drops/${dropId}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-KB-Drop-Secret': dropSecret
        },
        body: 'KBSUB1.student_encrypted_data'
      });
      const subRes = await worker.fetch(subReq, env, {});
      expect(subRes.status).toBe(201);
      const subData = await subRes.json();
      expect(subData.receipt_id).toBeTruthy();

      // Teacher retrieves submissions
      const listReq = new Request(`https://relay.test.workers.dev/api/v1/drops/${dropId}/submissions`, {
        headers: { 'Authorization': `Bearer ${teacherToken}` }
      });
      const listRes = await worker.fetch(listReq, env, {});
      expect(listRes.status).toBe(200);
      const { items } = await listRes.json();
      expect(items).toHaveLength(1);
      expect(items[0].text).toBe('KBSUB1.student_encrypted_data');
    });

    it('handles course feed publish and conditional ETag 304 response', async () => {
      const courseId = 'cf-course-101';
      const feedData = 'ENC_FEED_DATA_V1';

      // Publish feed
      const putReq = new Request(`https://relay.test.workers.dev/api/v1/feed/${courseId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${teacherToken}`
        },
        body: JSON.stringify({ ciphertext: feedData, etag: 'etag-v1' })
      });
      const putRes = await worker.fetch(putReq, env, {});
      expect(putRes.status).toBe(200);

      // Get feed
      const getReq = new Request(`https://relay.test.workers.dev/api/v1/feed/${courseId}`);
      const getRes = await worker.fetch(getReq, env, {});
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get('ETag')).toBe('"etag-v1"');
      const getBody = await getRes.json();
      expect(getBody.ciphertext).toBe(feedData);

      // Conditional GET with If-None-Match returns 304
      const condReq = new Request(`https://relay.test.workers.dev/api/v1/feed/${courseId}`, {
        headers: { 'If-None-Match': '"etag-v1"' }
      });
      const condRes = await worker.fetch(condReq, env, {});
      expect(condRes.status).toBe(304);
    });

    it('handles native Cloudflare R2 media upload and download', async () => {
      const hash = 'a'.repeat(64);
      const filename = `${hash}.webp`;

      // 1. Presign returns direct upload URL
      const preReq = new Request('https://relay.test.workers.dev/api/v1/media/presign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${teacherToken}`
        },
        body: JSON.stringify({ sha256: hash, mime: 'image/webp', ext: 'webp' })
      });
      const preRes = await worker.fetch(preReq, env, {});
      expect(preRes.status).toBe(200);
      const preData = await preRes.json();
      expect(preData.upload_url).toContain(`/api/v1/media/upload?key=${filename}`);

      // 2. Upload file bytes to R2
      const mediaBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const upReq = new Request(`https://relay.test.workers.dev/api/v1/media/upload?key=${filename}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/webp' },
        body: mediaBytes
      });
      const upRes = await worker.fetch(upReq, env, {});
      expect(upRes.status).toBe(200);

      // Verify file reached mock R2 store
      expect(mockR2.raw.has(`assets/${filename}`)).toBe(true);

      // 3. Download file back from R2
      const downReq = new Request(`https://relay.test.workers.dev/api/v1/media/file/${filename}`);
      const downRes = await worker.fetch(downReq, env, {});
      expect(downRes.status).toBe(200);
      expect(downRes.headers.get('Content-Type')).toBe('image/webp');
      const downloadedBuf = await downRes.arrayBuffer();
      expect(new Uint8Array(downloadedBuf)).toEqual(mediaBytes);
    });
  });

  describe('2. Scheduled Cron Triggers (Retention Pruning in D1)', () => {
    it('executes scheduled cron and prunes expired drops and old submissions', async () => {
      const oldDate = new Date(Date.now() - 200 * 86400000).toISOString();
      const dropId = 'drop-cron-test';

      await d1Db.drops.create({
        id: dropId,
        teacherId,
        assignmentId: 'asg-1',
        expiresAt: oldDate
      });

      await d1Db.submissions.create({
        id: 'sub-old',
        dropId,
        text: 'KBSUB1.old',
        receivedAt: oldDate
      });

      // Run scheduled trigger
      let waitPromise = null;
      const ctx = {
        waitUntil(p) { waitPromise = p; }
      };
      await worker.scheduled({ cron: '0 3 * * *' }, env, ctx);
      if (waitPromise) await waitPromise;

      // Drop should be pruned
      const drop = await d1Db.drops.get(dropId);
      expect(drop).toBeNull();
    });
  });

  describe('3. Zero-Leak Teacher Onboarding UX (#/connect)', () => {
    it('configures transport and scrubs URL fragment immediately on #/connect', async () => {
      const originalHistory = window.history;
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

      // Emulate teacher clicking one-click connection link
      window.location.hash = `#/connect?relay=https://relay.cf.school.edu&token=${teacherToken}&id=${teacherId}`;
      await router.handleRoute();

      // 1. Verify history.replaceState was invoked immediately to scrub token
      expect(replaceStateSpy).toHaveBeenCalledWith(null, '', expect.stringContaining('#/'));
      expect(replaceStateSpy.mock.calls[0][2]).not.toContain(teacherToken);

      // 2. Verify transport config was saved into IndexedDB
      const transport = await getTransport();
      expect(transport).toBeInstanceOf(RelayTransport);
      expect(transport.baseUrl).toBe('https://relay.cf.school.edu');
      expect(transport.token).toBe(teacherToken);
      expect(transport.teacherId).toBe(teacherId);

      // 3. Verify event was dispatched for UI indicator updates
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'kb-relay-connected'
      }));
    });

    it('rejects incomplete #/connect links gracefully', async () => {
      window.location.hash = '#/connect?relay=https://relay.cf.school.edu';
      await router.handleRoute();

      // Without token, transport shouldn't be configured
      const transport = await getTransport();
      expect(transport.token).toBeFalsy();
    });
  });

  describe('4. CLI Provisioning with Cloudflare D1 SQL Generation', () => {
    it('generates d1-seed-teachers.sql and connect_url in teacher-tokens.csv', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cf-test-'));
      const result = initRelay({
        dir: tmpDir,
        teachers: [
          { id: 'T-PROV-1', name: 'Dr. Jane Smith' },
          { id: 'T-PROV-2', name: 'Mr. John Doe' }
        ],
        publicUrl: 'https://kennisboost-relay.school.workers.dev'
      });

      expect(result.created).toHaveLength(2);
      expect(fs.existsSync(result.files.tokensPath)).toBe(true);
      expect(fs.existsSync(result.files.d1SqlPath)).toBe(true);

      // Verify tokens.csv includes connect_url column
      const csvContent = fs.readFileSync(result.files.tokensPath, 'utf8');
      expect(csvContent).toContain('connect_url');
      expect(csvContent).toContain('#/connect?relay=');

      // Verify d1-seed-teachers.sql contains valid INSERT statements
      const sqlContent = fs.readFileSync(result.files.d1SqlPath, 'utf8');
      expect(sqlContent).toContain('INSERT OR IGNORE INTO teachers');
      expect(sqlContent).toContain('T-PROV-1');
      expect(sqlContent).toContain('Dr. Jane Smith');
      expect(sqlContent).toContain(hashToken(result.created[0].token));
    });
  });
});
