import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { storage, StorageManager } from '../src/core/storage.js';
import { CryptoShareEngine } from '../src/core/crypto-share.js';
import { LinkBuilder } from '../src/core/links.js';
import { RelayTransport, NullTransport, getTransport, setTransportConfig } from '../src/core/transport.js';
import { loadServiceWorker } from './helpers/load-sw.js';

const { shouldBypassCache } = loadServiceWorker();

describe('Phase 17: Sync-Server Readiness & Transport (§9)', () => {

  describe('Outbox (Change Log §9.3)', () => {
    let testStorage;

    beforeEach(async () => {
      testStorage = new StorageManager();
      await testStorage.init();
      await testStorage.table('assignments').clear();
      if (testStorage.db.outbox) {
        await testStorage.db.outbox.clear();
      }
    });

    it('records outbox operations for put and delete in transactions', async () => {
      const assignment = {
        id: 'asg-outbox-1',
        title: 'Outbox Test Assignment',
        questions: []
      };

      // 1. Put
      await testStorage.table('assignments').put(assignment);

      let items = await testStorage.outbox.since(0);
      expect(items.length).toBeGreaterThanOrEqual(1);
      const putOp = items.find(r => r.key === 'asg-outbox-1' && r.op === 'put');
      expect(putOp).toBeDefined();
      expect(putOp.table).toBe('assignments');
      expect(putOp.pushed_at).toBeNull();
      expect(putOp.record.title).toBe('Outbox Test Assignment');

      // 2. Delete
      await testStorage.table('assignments').delete('asg-outbox-1');

      items = await testStorage.outbox.since(0);
      const deleteOp = items.find(r => r.key === 'asg-outbox-1' && r.op === 'delete');
      expect(deleteOp).toBeDefined();
      expect(deleteOp.table).toBe('assignments');
      expect(deleteOp.pushed_at).toBeNull();
    });

    it('manages outbox since, markPushed, and prune', async () => {
      await testStorage.table('assignments').put({ id: 'asg-1', title: 'A1' });
      await testStorage.table('assignments').put({ id: 'asg-2', title: 'A2' });

      let unpushed = await testStorage.outbox.since(0);
      expect(unpushed.length).toBe(2);

      const firstSeq = unpushed[0].seq;
      await testStorage.outbox.markPushed([firstSeq]);

      const afterMark = await testStorage.outbox.since(0);
      const pushedRow = afterMark.find(r => r.seq === firstSeq);
      expect(pushedRow.pushed_at).not.toBeNull();

      // Prune pushed rows older than -0.01 days (all marked rows)
      await testStorage.outbox.prune(-0.01, true);
      const afterPrune = await testStorage.outbox.since(0);
      expect(afterPrune.some(r => r.seq === firstSeq)).toBe(false);
      // Unpushed row should still exist
      expect(afterPrune.some(r => r.seq === unpushed[1].seq)).toBe(true);
    });
  });

  describe('Hosted Links & Cryptography (§9.4)', () => {
    it('wraps and unwraps hosted payloads with AES-256-GCM', async () => {
      const payload = {
        title: 'Quiz 1',
        questions: [{ id: 'q1', prompt: 'Solve 2+2', points: 5 }]
      };

      const wrapped = await CryptoShareEngine.wrapForHosting(payload);
      expect(typeof wrapped.ciphertext).toBe('string');
      expect(typeof wrapped.key).toBe('string');
      expect(wrapped.ciphertext.length).toBeGreaterThan(20);
      expect(wrapped.key.length).toBeGreaterThan(20);

      const unwrappedStr = await CryptoShareEngine.unwrapHosted(wrapped.ciphertext, wrapped.key);
      const parsed = JSON.parse(unwrappedStr);
      expect(parsed.title).toBe('Quiz 1');
      expect(parsed.questions[0].prompt).toBe('Solve 2+2');
    });

    it('fails unwrapping when ciphertext is tampered with', async () => {
      const payload = { test: true };
      const wrapped = await CryptoShareEngine.wrapForHosting(payload);

      // Tamper with middle byte of ciphertext
      const chars = wrapped.ciphertext.split('');
      chars[15] = chars[15] === 'A' ? 'B' : 'A';
      const tampered = chars.join('');

      await expect(CryptoShareEngine.unwrapHosted(tampered, wrapped.key)).rejects.toThrow();
    });

    it('generates short link URL with key embedded only in fragment', () => {
      const ref = 'payload-ref-123';
      const key = 'secret-fragment-key';
      const link = LinkBuilder.hosted(ref, key, 'https://myschool.edu/');

      expect(link).toBe('https://myschool.edu/#/share?ref=payload-ref-123&k=secret-fragment-key');
      expect(link).not.toContain('k=secret-fragment-key?');
      // Fragment key is after # so browser will never send it in HTTP requests
      const [beforeHash, afterHash] = link.split('#');
      expect(beforeHash).toBe('https://myschool.edu/');
      expect(afterHash).toContain('k=secret-fragment-key');
    });
  });

  describe('Client Transport Abstraction (§9.2)', () => {
    it('defaults to NullTransport when unconfigured', async () => {
      await setTransportConfig(null);
      const transport = await getTransport();
      expect(transport.capabilities.hostPayload).toBe(false);
      expect(transport.capabilities.collectSubmissions).toBe(false);
      const health = await transport.health();
      expect(health.ok).toBe(false);
    });

    it('switches to RelayTransport when sync_config is configured', async () => {
      await setTransportConfig({
        baseUrl: 'http://localhost:3000',
        token: 'test-token',
        teacherId: 'T1'
      });
      const transport = await getTransport();
      expect(transport.capabilities.hostPayload).toBe(true);
      expect(transport.capabilities.collectSubmissions).toBe(true);
      expect(transport.apiBase).toBe('http://localhost:3000/api/v1');

      // Cleanup
      await setTransportConfig(null);
    });
  });

  describe('Service Worker Cache Bypass (§9.8)', () => {
    it('bypasses cache for /api/ routes', () => {
      expect(shouldBypassCache('http://localhost:8000/api/v1/health', 'http://localhost:8000')).toBe(true);
      expect(shouldBypassCache('http://localhost:8000/api/payloads/123', 'http://localhost:8000')).toBe(true);
    });

    it('does not bypass cache for local static assets', () => {
      expect(shouldBypassCache('http://localhost:8000/index.html', 'http://localhost:8000')).toBe(false);
      expect(shouldBypassCache('http://localhost:8000/src/main.js', 'http://localhost:8000')).toBe(false);
      expect(shouldBypassCache('http://localhost:8000/css/app.css', 'http://localhost:8000')).toBe(false);
    });

    it('never caches third-party origins (all libraries are self-hosted)', () => {
      expect(shouldBypassCache('https://cdn.jsdelivr.net/npm/dexie@4.0.4/dist/dexie.mjs', 'http://localhost:8000')).toBe(true);
      expect(shouldBypassCache('http://localhost:8000/vendor/dexie.mjs', 'http://localhost:8000')).toBe(false);
    });

    it('bypasses cache for cross-origin relay server calls', () => {
      expect(shouldBypassCache('https://school-relay.example.com/drops', 'http://localhost:8000')).toBe(true);
    });
  });

  describe('Reference Relay Server Integration (§9.6)', () => {
    let serverProc;
    let serverUrl;
    let teacherToken;
    let tempDbPath;

    beforeAll(async () => {
      tempDbPath = path.join(os.tmpdir(), `relay-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);

      // 1. Provision a teacher account using the CLI script
      const addTeacherOutput = execSync(`node scripts/relay-add-teacher.mjs teacher-integration-1 "Test Teacher"`, {
        env: { ...process.env, KB_RELAY_DB: tempDbPath },
        encoding: 'utf-8'
      });
      const tokenMatch = addTeacherOutput.match(/Token\s*:\s*([a-f0-9]+)/i);
      expect(tokenMatch).not.toBeNull();
      teacherToken = tokenMatch[1];

      // 2. Spawn the relay server on an ephemeral port
      serverProc = spawn('node', ['server/relay/index.js'], {
        env: { ...process.env, PORT: '0', KB_RELAY_DB: tempDbPath }
      });

      await new Promise((resolve, reject) => {
        serverProc.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          const m = text.match(/listening on (http:\/\/[^\s]+)/);
          if (m) {
            serverUrl = m[1].replace('localhost', '127.0.0.1');
            resolve();
          }
        });
        serverProc.stderr.on('data', (chunk) => {
          // ignore warning
        });
        serverProc.on('error', reject);
      });
    });

    afterAll(async () => {
      if (serverProc) {
        serverProc.kill();
      }
      try {
        if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
        if (fs.existsSync(tempDbPath + '-wal')) fs.unlinkSync(tempDbPath + '-wal');
        if (fs.existsSync(tempDbPath + '-shm')) fs.unlinkSync(tempDbPath + '-shm');
      } catch {}
    });

    it('responds to GET /health and /api/v1/health', async () => {
      const res = await fetch(`${serverUrl}/api/v1/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.version).toBe('1.0.0');
      expect(body.features).toContain('payloads');
      expect(body.features).toContain('drops');
    });

    it('exercises payloads endpoint: auth, post, get, and 404', async () => {
      const transport = new RelayTransport({ baseUrl: serverUrl, token: teacherToken });

      // Unauthenticated post should fail
      const unauthTransport = new RelayTransport({ baseUrl: serverUrl, token: 'invalid' });
      await expect(unauthTransport.publishPayload({
        kind: 'assignment',
        ciphertext: 'cipher-test'
      })).rejects.toThrow();

      // Authenticated post succeeds
      const { ref } = await transport.publishPayload({
        kind: 'assignment',
        ciphertext: 'base64url-ciphertext-data',
        meta: { title: 'Test Lesson' }
      });
      expect(typeof ref).toBe('string');
      expect(ref.length).toBeGreaterThanOrEqual(16);

      // Public GET without auth succeeds
      const publicTransport = new RelayTransport({ baseUrl: serverUrl });
      const fetched = await publicTransport.fetchPayload(ref);
      expect(fetched.kind).toBe('assignment');
      expect(fetched.ciphertext).toBe('base64url-ciphertext-data');

      // Nonexistent ref returns 404
      await expect(publicTransport.fetchPayload('nonexistent-ref')).rejects.toThrow();
    });

    it('exercises drops and submissions: create, submit, list, and delete', async () => {
      const teacherTransport = new RelayTransport({ baseUrl: serverUrl, token: teacherToken });

      // 1. Teacher creates drop
      const { dropId, dropSecret } = await teacherTransport.createDrop({
        assignmentId: 'asg-drop-1',
        publishVersion: 1
      });
      expect(typeof dropId).toBe('string');
      expect(dropSecret).toMatch(/^[0-9a-f]{48}$/);

      // 2. Student submits envelope (no auth, but the drop secret from the assignment payload)
      const studentTransport = new RelayTransport({ baseUrl: serverUrl });
      const envelope = 'KBSUB1.header.iv.ciphertext.mac';
      await expect(studentTransport.submitToDrop(dropId, envelope)).rejects.toThrow(/drop secret/);
      await expect(studentTransport.submitToDrop(dropId, envelope, { dropSecret: 'wrong' })).rejects.toThrow(/drop secret/);
      const subResult = await studentTransport.submitToDrop(dropId, envelope, { dropSecret });
      expect(subResult.receiptId).toBeDefined();
      expect(subResult.received_at).toBeDefined();

      // Invalid format rejected
      await expect(studentTransport.submitToDrop(dropId, 'INVALID.envelope', { dropSecret })).rejects.toThrow();

      // 3. Teacher lists drop submissions
      const list = await teacherTransport.listDrop(dropId);
      expect(list.items.length).toBe(1);
      expect(list.items[0].text).toBe(envelope);

      // List with since in future returns 0 items
      const futureDate = new Date(Date.now() + 60000).toISOString();
      const emptySince = await teacherTransport.listDrop(dropId, { since: futureDate });
      expect(emptySince.items.length).toBe(0);

      // 4. Delete drop
      await teacherTransport.deleteDrop(dropId);
      await expect(studentTransport.submitToDrop(dropId, envelope, { dropSecret })).rejects.toThrow();
    });

    it('enforces payload size limit (512KB)', async () => {
      const transport = new RelayTransport({ baseUrl: serverUrl, token: teacherToken });
      const largeCiphertext = 'A'.repeat(550 * 1024);

      await expect(transport.publishPayload({
        kind: 'assignment',
        ciphertext: largeCiphertext
      })).rejects.toThrow();
    });

    it('enforces rate limiting on submission endpoint (30/min)', async () => {
      const teacherTransport = new RelayTransport({ baseUrl: serverUrl, token: teacherToken });
      const { dropId, dropSecret } = await teacherTransport.createDrop({ assignmentId: 'rate-limit-test' });

      const studentTransport = new RelayTransport({ baseUrl: serverUrl });
      const envelope = 'KBSUB1.test-envelope';

      let rateLimited = false;
      for (let i = 0; i < 35; i++) {
        try {
          await studentTransport.submitToDrop(dropId, envelope, { dropSecret });
        } catch (err) {
          if (err.message.includes('Rate limit exceeded')) {
            rateLimited = true;
            break;
          }
          throw err;
        }
      }
      expect(rateLimited).toBe(true);
    });
  });
});
