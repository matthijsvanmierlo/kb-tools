// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../server/relay/worker.js';
import { createD1Database } from '../server/relay/d1-db.js';
import { createRelayServer } from '../server/relay/index.js';
import { createDbPartsStore } from '../server/relay/media-store.js';
import { generateToken, hashToken } from '../server/relay/auth.js';
import { pruneRelay } from '../scripts/relay-prune-stale.mjs';

/**
 * Creates an in-memory mock of Cloudflare D1 (env.DB) using node:sqlite,
 * strictly enforcing the ~2MB row/value size limit like real Cloudflare D1.
 */
function createStrictMockD1() {
  const db = new DatabaseSync(':memory:');
  const MAX_D1_VALUE_BYTES = 2 * 1024 * 1024; // 2MB limit

  function checkSize(val) {
    if (typeof val === 'string' && Buffer.byteLength(val, 'utf8') > MAX_D1_VALUE_BYTES) {
      throw new Error(`D1 row/value limit exceeded (~2MB): size was ${Buffer.byteLength(val, 'utf8')} bytes`);
    }
    if (val instanceof Uint8Array && val.byteLength > MAX_D1_VALUE_BYTES) {
      throw new Error(`D1 row/value limit exceeded (~2MB): size was ${val.byteLength} bytes`);
    }
  }

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
          for (const p of params) {
            checkSize(p);
          }
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

describe('WS1: Relay storage bounds, parity, safety, and quotas', () => {
  it('splits and reassembles a 3 MB blob on D1 without exceeding the 2 MB row cap', async () => {
    const mockD1 = createStrictMockD1();
    const d1Db = createD1Database(mockD1);
    await d1Db.initSchema();

    const partsStore = createDbPartsStore(mockD1);

    // Generate 3 MB of synthetic data
    const size3Mb = 3 * 1024 * 1024;
    const largeData = Buffer.alloc(size3Mb, 'x');
    largeData.write('START-OF-BLOB', 0);
    largeData.write('END-OF-BLOB', size3Mb - 20);

    // Should not throw D1 2MB limit error
    const putRes = await partsStore.put('test-3mb-blob', largeData, 'application/octet-stream');
    expect(putRes.ok).toBe(true);

    // Verify reassembled data matches exactly
    const retrieved = await partsStore.get('test-3mb-blob');
    expect(retrieved).not.toBeNull();
    expect(retrieved.data.byteLength).toBe(size3Mb);
    expect(Buffer.from(retrieved.data.subarray(0, 13)).toString('utf8')).toBe('START-OF-BLOB');
    expect(Buffer.from(retrieved.data.subarray(size3Mb - 20, size3Mb - 9)).toString('utf8')).toBe('END-OF-BLOB');

    // Deletion
    await partsStore.delete('test-3mb-blob');
    expect(await partsStore.get('test-3mb-blob')).toBeNull();
  });

  it('prunes expired data and removes orphaned blobs and media refs', async () => {
    const relay = createRelayServer({ dbPath: ':memory:', retentionDays: 30 });
    const teacherId = 'T-PRUNE';
    const token = generateToken();
    relay.db.teachers.create({ id: teacherId, name: 'Prune Teacher', tokenHash: hashToken(token) });

    // Insert an expired drop
    const dropId = 'drop-expired-1';
    const pastDate = new Date(Date.now() - 35 * 86400000).toISOString();
    await relay.db.drops.create({
      id: dropId,
      teacherId,
      assignmentId: 'as-1',
      expiresAt: pastDate
    });

    // Put media in blobStore and record drop media
    const mediaKey = 'a'.repeat(64) + '.png';
    await relay.blobStore.put(mediaKey, Buffer.from('image-bytes'), 'image/png');
    await relay.db.dropMedia.record({ dropId, key: mediaKey, size: 100 });

    // Verify media is present
    expect(await relay.blobStore.get(mediaKey)).not.toBeNull();

    // Run prune
    const pruneResult = relay.db.pruneExpired({ retentionDays: 30 });
    expect(pruneResult.dropsPruned).toBeGreaterThanOrEqual(1);
    expect(pruneResult.expiredBlobKeys).toContain(mediaKey);

    // Delete expired blobs as the relay interval does
    await relay.blobStore.deleteMany(pruneResult.expiredBlobKeys);
    expect(await relay.blobStore.get(mediaKey)).toBeNull();

    await relay.close();
  });

  it('enforces 507 quota_exceeded when teacher storage quota is exceeded', async () => {
    // Set quota to 1 MB for testing
    process.env.KB_RELAY_TEACHER_QUOTA_MB = '1';
    const relay = createRelayServer({ dbPath: ':memory:' });
    await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${relay.server.address().port}`;

    const teacherId = 'T-QUOTA';
    const token = generateToken();
    relay.db.teachers.create({ id: teacherId, name: 'Quota Teacher', tokenHash: hashToken(token) });

    // Fill up quota: teacher quota is 1 MB (1,048,576 bytes)
    // Create workspace
    const wsRes = await fetch(`${baseUrl}/api/v1/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const { workspace_id: wsId, workspace_key: wsKey } = await wsRes.json();

    // First chunk: 900 KB (valid, under MAX_SYNC_CHUNK_SIZE of 1MB)
    const chunk1 = await fetch(`${baseUrl}/api/v1/sync/${wsId}/chunks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-KB-Workspace-Key': wsKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        device_id: 'dev-quota-01',
        start: 1,
        end: 1,
        body: 'x'.repeat(900 * 1024)
      })
    });
    expect(chunk1.status).toBe(201);

    // Second chunk: 200 KB (individually under 1MB, but cumulative 1.1MB > 1MB quota)
    const chunkRes = await fetch(`${baseUrl}/api/v1/sync/${wsId}/chunks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-KB-Workspace-Key': wsKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        device_id: 'dev-quota-01',
        start: 2,
        end: 2,
        body: 'x'.repeat(200 * 1024)
      })
    });

    expect(chunkRes.status).toBe(507);
    const errBody = await chunkRes.json();
    expect(errBody.error).toBe('quota_exceeded');

    delete process.env.KB_RELAY_TEACHER_QUOTA_MB;
    await relay.close();
  });

  it('handles idempotent submissions and returns 200 with duplicate:true', async () => {
    const relay = createRelayServer({ dbPath: ':memory:' });
    await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${relay.server.address().port}`;

    const teacherId = 'T-SUB';
    const token = generateToken();
    relay.db.teachers.create({ id: teacherId, name: 'Sub Teacher', tokenHash: hashToken(token) });

    // Create drop
    const dropRes = await fetch(`${baseUrl}/api/v1/drops`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignment_id: 'as-sub' })
    });
    const { drop_id: dropId, drop_secret: dropSecret } = await dropRes.json();

    const submissionBody = 'KBSUB1.test-ciphertext-data-12345';

    // First submission
    const sub1 = await fetch(`${baseUrl}/api/v1/drops/${dropId}/submissions`, {
      method: 'POST',
      headers: { 'X-KB-Drop-Secret': dropSecret, 'Content-Type': 'text/plain' },
      body: submissionBody
    });
    expect(sub1.status).toBe(201);
    const sub1Data = await sub1.json();
    expect(sub1Data.receipt_id).toBeDefined();

    // Retry identical submission
    const sub2 = await fetch(`${baseUrl}/api/v1/drops/${dropId}/submissions`, {
      method: 'POST',
      headers: { 'X-KB-Drop-Secret': dropSecret, 'Content-Type': 'text/plain' },
      body: submissionBody
    });
    expect(sub2.status).toBe(200);
    const sub2Data = await sub2.json();
    expect(sub2Data.duplicate).toBe(true);
    expect(sub2Data.receipt_id).toBe(sub1Data.receipt_id);

    await relay.close();
  });

  it('serves media with X-Content-Type-Options: nosniff and rejects HTML/SVG', async () => {
    const relay = createRelayServer({ dbPath: ':memory:' });
    await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${relay.server.address().port}`;

    const teacherId = 'T-MEDIA';
    const token = generateToken();
    relay.db.teachers.create({ id: teacherId, name: 'Media Teacher', tokenHash: hashToken(token) });

    // Requesting presign for svg or html must be rejected
    const svgRes = await fetch(`${baseUrl}/api/v1/media/presign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha256: 'a'.repeat(64), mime: 'image/svg+xml', ext: 'svg' })
    });
    expect(svgRes.status).toBe(400);

    const htmlRes = await fetch(`${baseUrl}/api/v1/media/presign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha256: 'b'.repeat(64), mime: 'text/html', ext: 'html' })
    });
    expect(htmlRes.status).toBe(400);

    // Valid PNG upload
    const pngHash = 'c'.repeat(64);
    const pngKey = `${pngHash}.png`;
    await relay.blobStore.put(pngKey, Buffer.from('png-bytes'), 'image/png');

    const fileRes = await fetch(`${baseUrl}/api/v1/media/file/${pngKey}`);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(fileRes.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(fileRes.headers.get('content-type')).toBe('image/png');

    await relay.close();
  });

  it('ensures media signing secret is stable across two mock isolates on D1', async () => {
    const mockD1 = createStrictMockD1();
    const d1Db1 = createD1Database(mockD1);
    await d1Db1.initSchema();
    const secret1 = await d1Db1.getMediaSigningSecret();

    // Second isolate sharing the same D1 DB
    const d1Db2 = createD1Database(mockD1);
    const secret2 = await d1Db2.getMediaSigningSecret();

    expect(secret1).toBeDefined();
    expect(secret1.length).toBe(64); // 32 hex bytes
    expect(secret1).toBe(secret2);
  });
});
