// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRelayServer, RateLimiter } from '../server/relay/index.js';
import { hashToken, generateToken } from '../server/relay/auth.js';
import { createDatabase } from '../server/relay/db.js';
import { appHandler } from '../server.js';
import { RelayTransport } from '../src/core/transport.js';
import { initRelay, parseTeachers } from '../scripts/relay-init.mjs';

const listen = (instance) => new Promise(r => instance.server.listen(0, '127.0.0.1', () => r(instance.server.address().port)));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kb-relay-'));

describe('Phase 30: Relay hardening', () => {
  let relay;
  let baseUrl;
  let token;
  beforeAll(async () => {
    relay = createRelayServer({ dbPath: ':memory:' });
    baseUrl = `http://127.0.0.1:${await listen(relay)}`;
    token = generateToken();
    relay.db.teachers.create({ id: 'T1', name: 'T1', tokenHash: hashToken(token) });
  });
  afterAll(() => relay.close());

  it('new drop boxes need their secret; drops from before secrets keep working', async () => {
    const teacher = new RelayTransport({ baseUrl, token });
    const student = new RelayTransport({ baseUrl });
    const { dropId, dropSecret } = await teacher.createDrop({ assignmentId: 'as-1' });
    await expect(student.submitToDrop(dropId, 'KBSUB1.x')).rejects.toThrow(/drop secret/);
    expect((await student.submitToDrop(dropId, 'KBSUB1.x', { dropSecret })).receiptId).toBeTruthy();

    relay.db.drops.create({ id: 'legacydrop0001', teacherId: 'T1', assignmentId: 'as-0' });
    expect((await student.submitToDrop('legacydrop0001', 'KBSUB1.y')).receiptId).toBeTruthy();
    // The secret is stored only as a hash
    expect(JSON.stringify(relay.db.drops.get(dropId))).not.toContain(dropSecret);
  });

  it('keeps no IP addresses, only short-lived salted hashes', () => {
    const limiter = new RateLimiter(2, 50);
    limiter.isAllowed('203.0.113.7');
    limiter.isAllowed('203.0.113.7');
    expect(limiter.isAllowed('203.0.113.7')).toBe(false);
    expect([...limiter.clients.keys()].join()).not.toContain('203.0.113');
    expect(new RateLimiter()._key('203.0.113.7')).not.toBe(limiter._key('203.0.113.7'));
    limiter.sweep(Date.now() + 1000);
    expect(limiter.clients.size).toBe(0);
  });

  it('deletes student data past the retention period but keeps sync snapshots', () => {
    const db = createDatabase(':memory:');
    db.teachers.create({ id: 'T1', name: 'T1', tokenHash: 'h' });
    db.drops.create({ id: 'd1', teacherId: 'T1', assignmentId: 'a' });
    db.workspaces.create({ id: 'w'.repeat(24), keyHash: 'k', createdBy: 'T1' });
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    db.submissions.create({ id: 's-old', dropId: 'd1', text: 'KBSUB1.old', receivedAt: old });
    db.submissions.create({ id: 's-new', dropId: 'd1', text: 'KBSUB1.new' });
    db.drafts.put({ dropId: 'd1', draftId: 'a'.repeat(64), ciphertext: 'KBDRAFT1.x' });
    db.raw.prepare('UPDATE drafts SET updated_at = ?').run(old);
    db.sync.putChunk({ workspaceId: 'w'.repeat(24), deviceId: 'device-01', start: 1, end: 1, body: 'c' });
    db.raw.prepare('UPDATE sync_chunks SET created_at = ?').run(old);
    db.sync.putSnapshot({ workspaceId: 'w'.repeat(24), deviceId: 'device-01', createdAt: old, body: 's' });

    expect(db.pruneExpired({ retentionDays: 0 }).submissionsPruned).toBe(0);
    const r = db.pruneExpired({ retentionDays: 30 });
    expect(r).toMatchObject({ submissionsPruned: 1, draftsPruned: 1, chunksPruned: 1 });
    expect(db.submissions.list('d1').map(s => s.text)).toEqual(['KBSUB1.new']);
    expect(db.sync.getSnapshot('w'.repeat(24), 'device-01')).toBeTruthy();
  });

  it('adds the secret column to databases from older versions', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'old.sqlite');
    const legacy = createDatabase(file);
    legacy.raw.exec('ALTER TABLE drops DROP COLUMN secret_hash');
    legacy.raw.close();
    const upgraded = createDatabase(file);
    expect(upgraded.raw.prepare('PRAGMA table_info(drops)').all().map(c => c.name)).toContain('secret_hash');
    upgraded.raw.close();
  });
});

describe('Phase 30: One server for app and relay', () => {
  let relay;
  let baseUrl;
  beforeAll(async () => {
    relay = createRelayServer({ dbPath: ':memory:', appHandler });
    baseUrl = `http://127.0.0.1:${await listen(relay)}`;
  });
  afterAll(() => relay.close());

  it('serves the app with its security headers next to the API, and never server code', async () => {
    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(await page.text()).toContain('<script type="importmap">');
    expect((await fetch(`${baseUrl}/api/v1/health`).then(r => r.json())).ok).toBe(true);
    expect((await fetch(`${baseUrl}/server/relay/index.js`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/scripts/relay-init.mjs`)).status).toBe(404);
  });
});

describe('Phase 30: HTTPS', () => {
  const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
  it.skipIf(!hasOpenssl)('serves the API over TLS when given a certificate', async () => {
    const dir = tmpDir();
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    const relay = createRelayServer({ dbPath: ':memory:', tls: { cert: fs.readFileSync(path.join(dir, 'cert.pem')), key: fs.readFileSync(path.join(dir, 'key.pem')) } });
    const port = await listen(relay);
    const body = await new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: '/api/v1/health', rejectUnauthorized: false }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
    expect(body.ok).toBe(true);
    await relay.close();
  });
});

describe('Phase 30: relay:init', () => {
  it('parses teachers from flags and CSV and rejects unsafe ids', () => {
    expect(parseTeachers(['T1:Ms. Jansen', 'T2'], 'id,name\nT3,"Mr. de Vries, PhD"\n')).toEqual([
      { id: 'T1', name: 'Ms. Jansen' }, { id: 'T2', name: 'T2' }, { id: 'T3', name: 'Mr. de Vries, PhD' }
    ]);
    expect(() => parseTeachers(['bad id:x'])).toThrow(/may only contain/);
  });

  it('creates the database, settings and a private token sheet, and is safe to re-run', () => {
    const dir = tmpDir();
    const first = initRelay({ dir, teachers: [{ id: 'T1', name: 'Ann' }, { id: 'T2', name: 'Bo' }], publicUrl: 'https://kb.school.lan', serveApp: true, retentionDays: 90 });
    expect(first.created).toHaveLength(2);
    const env = fs.readFileSync(first.files.envPath, 'utf8');
    expect(env).toContain('KB_RELAY_SERVE_APP=1');
    expect(env).toContain('KB_RELAY_RETENTION_DAYS=90');
    expect(env).toContain('KB_RELAY_ORIGINS=https://kb.school.lan');
    expect(fs.statSync(first.files.tokensPath).mode & 0o777).toBe(0o600);

    const db = createDatabase(first.files.dbPath);
    expect(db.teachers.getByTokenHash(hashToken(first.created[0].token)).id).toBe('T1');
    db.raw.close();

    const again = initRelay({ dir, teachers: [{ id: 'T1', name: 'Ann' }, { id: 'T3', name: 'Cy' }], publicUrl: 'https://kb.school.lan' });
    expect(again.created.map(t => t.id)).toEqual(['T3']);
    expect(again.skipped).toEqual(['T1']);
    expect(fs.readFileSync(first.files.tokensPath, 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('runs from the command line', () => {
    const dir = tmpDir();
    const out = execFileSync('node', ['scripts/relay-init.mjs', '--dir', dir, '--teacher', 'T9:Test'], { encoding: 'utf8' });
    expect(out).toContain('teachers added  1');
    expect(fs.existsSync(path.join(dir, 'data', 'relay.sqlite'))).toBe(true);
  });
});
