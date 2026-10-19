// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { createRelayServer } from '../server/relay/index.js';
import { hashToken, generateToken } from '../server/relay/auth.js';
import { StorageManager } from '../src/core/storage.js';
import { RelayTransport } from '../src/core/transport.js';
import { ReplicationManager } from '../src/core/replication/manager.js';
import { createOffer } from '../src/core/replication/link.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { KeyVault } from '../src/core/keyvault.js';
import { DraftRoamer, deriveDraftSecrets } from '../src/modules/assignments/draft-roaming.js';

let relay;
let baseUrl;
const tokens = {};

beforeAll(async () => {
  relay = createRelayServer({ dbPath: ':memory:' });
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${relay.server.address().port}`;
  for (const id of ['T1', 'T2']) {
    tokens[id] = generateToken();
    relay.db.teachers.create({ id, name: id, tokenHash: hashToken(tokens[id]) });
  }
});

afterAll(async () => {
  await relay.close();
});

let n = 0;
/** A teacher device: its own database, relay connection and replication manager */
async function teacherDevice(teacherId, { connected = true } = {}) {
  const store = new StorageManager({ dbName: `kb-relay-test-${Date.now()}-${n++}` });
  await store.init();
  let transport = connected ? new RelayTransport({ baseUrl, token: tokens[teacherId] }) : null;
  const manager = new ReplicationManager({
    store,
    getRelay: async () => transport,
    getBackupAdapter: () => null,
    setRelayConfig: async (cfg) => { transport = new RelayTransport(cfg); }
  });
  return { store, manager, connect: () => { transport = new RelayTransport({ baseUrl, token: tokens[teacherId] }); } };
}

const json = (res) => res.json();

describe('Phase 29: Relay sync endpoints', () => {
  it('needs a teacher token and the workspace key, and stores chunks once', async () => {
    const t = new RelayTransport({ baseUrl, token: tokens.T1 });
    const { workspaceId, workspaceKey } = await t.syncCreateWorkspace();
    const url = `${baseUrl}/api/v1/sync/${workspaceId}/chunks`;
    expect((await fetch(url, { headers: { 'X-KB-Workspace-Key': workspaceKey } })).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: `Bearer ${tokens.T2}`, 'X-KB-Workspace-Key': 'wrong' } })).status).toBe(403);

    const chunk = { device_id: 'device-0001', start: 1, end: 3, body: '{"iv":"x","ct":"y"}' };
    await t.syncPutChunk(workspaceId, workspaceKey, chunk);
    await t.syncPutChunk(workspaceId, workspaceKey, chunk);
    await t.syncPutChunk(workspaceId, workspaceKey, { ...chunk, start: 4, end: 4 });
    // Another teacher holding the workspace key (a co-teacher) can read it
    const other = new RelayTransport({ baseUrl, token: tokens.T2 });
    const page = await other.syncListChunks(workspaceId, workspaceKey);
    expect(page.items.map(c => [c.start, c.end])).toEqual([[1, 3], [4, 4]]);
    expect((await t.syncListChunks(workspaceId, workspaceKey, { after: page.items[0].seq })).items).toHaveLength(1);

    await expect(t.syncPutChunk(workspaceId, workspaceKey, { ...chunk, start: 0 })).rejects.toThrow(/Invalid/);
    expect((await t.syncDeleteChunks(workspaceId, workspaceKey, { device_id: 'device-0001', through: 3 })).deleted).toBe(1);

    await t.syncPutSnapshot(workspaceId, workspaceKey, 'device-0001', { created_at: '2026-10-18T00:00:00Z', body: 'cipher' });
    expect(await t.syncListSnapshots(workspaceId, workspaceKey)).toEqual([{ device_id: 'device-0001', created_at: '2026-10-18T00:00:00Z' }]);
    expect((await t.syncGetSnapshot(workspaceId, workspaceKey, 'device-0001')).body).toBe('cipher');
  });

  it('stores student drafts only as KBDRAFT1 ciphertext under a 64-hex id', async () => {
    const t = new RelayTransport({ baseUrl, token: tokens.T1 });
    const { dropId, dropSecret } = await t.createDrop({ assignmentId: 'as-1' });
    const anon = new RelayTransport({ baseUrl });
    const id = 'a'.repeat(64);
    const opts = { dropSecret };
    await expect(anon.getDraft(dropId, id)).rejects.toThrow(/403/);
    expect(await anon.getDraft(dropId, id, opts)).toBeNull();
    await expect(anon.putDraft(dropId, id, 'plain text', opts)).rejects.toThrow(/400/);
    await expect(anon.putDraft(dropId, 'short', 'KBDRAFT1.x', opts)).rejects.toThrow(/400/);
    await anon.putDraft(dropId, id, 'KBDRAFT1.abc', opts);
    expect((await anon.getDraft(dropId, id, opts)).ciphertext).toBe('KBDRAFT1.abc');
    expect((await fetch(`${baseUrl}/api/v1/health`).then(json)).features).toEqual(expect.arrayContaining(['sync', 'drafts']));
  });
});

describe('Phase 29: Linking a teacher\'s devices through the relay', () => {
  it('a new device gets the keys, the data and later edits, in both directions', async () => {
    const laptop = await teacherDevice('T1');
    const keys = await SubmissionCrypto.getOrCreateTeacherKeys(laptop.store);
    await laptop.store.table('gradebook_courses').put({ id: 'c1', name: 'Chemistry' });
    await laptop.store.table('gradebook_students').put({ id: 's1', course_id: 'c1', student_id: 'S1', full_name: 'Ada' });
    const handIn = await SubmissionCrypto.encryptForTeacher(keys.publicJwk, { answer: 42 }, {});
    await laptop.store.setMetadata('sync_config', { baseUrl, token: tokens.T1 });

    // The school PC has never been connected; the link brings the relay settings along
    const pc = await teacherDevice('T1', { connected: false });
    const offer = await createOffer('device');
    const { code, safety } = await laptop.manager.answerDeviceLink(offer.code);
    const link = await pc.manager.openDeviceLink(offer, code);
    expect(link.safety).toBe(safety);
    const { status } = await link.apply();
    expect(status.state).toBe('idle');

    expect((await pc.store.table('gradebook_students').get('s1')).full_name).toBe('Ada');
    const pcKeys = await SubmissionCrypto.getOrCreateTeacherKeys(pc.store);
    expect(await SubmissionCrypto.decryptFromStudent(pcKeys.decryptionKeys, handIn)).toEqual({ answer: 42 });

    await pc.store.table('gradebook_students').put({ id: 's2', course_id: 'c1', student_id: 'S2', full_name: 'Grace' });
    await pc.manager.syncNow();
    await laptop.manager.syncNow();
    expect((await laptop.store.table('gradebook_students').get('s2')).full_name).toBe('Grace');

    // Fully synced, so the outbox has been pruned on both devices
    expect(await laptop.store.outbox.since(0)).toEqual([]);
  });

  it('prunes the outbox when nothing is set up to sync', async () => {
    const solo = await teacherDevice('T1', { connected: false });
    await solo.store.table('flashcards').put({ id: 'd1', title: 'x' });
    const status = await solo.manager.syncNow();
    expect(status.state).toBe('off');
    expect(await solo.store.outbox.since(0)).toEqual([]);
  });
});

describe('Phase 29: Co-teaching a class', () => {
  it('shares one class, its hand-ins and its edits, and nothing else', async () => {
    const owner = await teacherDevice('T1');
    await owner.store.table('gradebook_courses').put({ id: 'c1', name: 'Shared biology' });
    await owner.store.table('gradebook_courses').put({ id: 'c2', name: 'Private history' });
    await owner.store.table('gradebook_students').put({ id: 's1', course_id: 'c1', student_id: 'S1', full_name: 'Ada' });
    await owner.store.table('gradebook_students').put({ id: 's9', course_id: 'c2', student_id: 'S9', full_name: 'Private kid' });

    const co = await teacherDevice('T2');
    const offer = await createOffer('coteacher');
    const course = await owner.store.table('gradebook_courses').get('c1');
    const { code, safety } = await owner.manager.answerClassInvite(course, offer.code);
    const invite = await co.manager.openClassInvite(offer, code);
    expect(invite.safety).toBe(safety);
    expect(invite.course.name).toBe('Shared biology');
    expect((await invite.apply()).state).toBe('idle');

    expect((await co.store.table('gradebook_courses').toArray()).map(c => c.id)).toEqual(['c1']);
    expect(await co.store.table('gradebook_students').get('s9')).toBeUndefined();

    // New work for the shared class is encrypted to the class key, which both teachers hold
    const publishKeys = await owner.manager.publishKeysFor('c1');
    expect(publishKeys.fingerprint).not.toBe((await KeyVault.getTeacherKeys(owner.store)).fingerprint);
    const handIn = await SubmissionCrypto.encryptForTeacher(publishKeys.publicJwk, { from: 'student' }, {});
    expect(await SubmissionCrypto.decryptFromStudent((await SubmissionCrypto.getOrCreateTeacherKeys(co.store)).decryptionKeys, handIn)).toEqual({ from: 'student' });
    expect((await co.manager.publishKeysFor('c1')).fingerprint).toBe(publishKeys.fingerprint);
    // Other classes still use the personal key
    expect((await owner.manager.publishKeysFor('c2')).fingerprint).toBe((await KeyVault.getTeacherKeys(owner.store)).fingerprint);

    // The co-teacher grades; their private classes never reach the owner
    await co.store.table('gradebook_grades').put({ id: 'g1', student_id: 'S1', assignment_id: 'A1', course_id: 'c1', raw_score: 7 });
    await co.store.table('gradebook_courses').put({ id: 'c3', name: 'Co-teacher private' });
    await co.manager.syncNow();
    await owner.manager.syncNow();
    expect((await owner.store.getByChangeKey('gradebook_grades', ['S1', 'A1'])).raw_score).toBe(7);
    expect(await owner.store.table('gradebook_courses').get('c3')).toBeUndefined();

    // Stopping: the owner gets a new class key next time; the old one still opens old hand-ins
    await owner.manager.stopSharing('c1');
    expect((await owner.manager.publishKeysFor('c1')).fingerprint).toBe((await KeyVault.getTeacherKeys(owner.store)).fingerprint);
    expect(await SubmissionCrypto.decryptFromStudent((await SubmissionCrypto.getOrCreateTeacherKeys(owner.store)).decryptionKeys, handIn)).toEqual({ from: 'student' });
  });

  it('explains that sharing needs the school server', async () => {
    const offline = await teacherDevice('T1', { connected: false });
    const offer = await createOffer('coteacher');
    await expect(offline.manager.answerClassInvite({ id: 'c1', name: 'x' }, offer.code)).rejects.toMatchObject({ code: 'NEEDS_RELAY' });
  });
});

describe('Phase 29: Student drafts that follow the student', () => {
  it('continues on another device only with the right access code, and never in the clear', async () => {
    const t = new RelayTransport({ baseUrl, token: tokens.T1 });
    const { dropId, dropSecret } = await t.createDrop({ assignmentId: 'as-9' });
    const params = { relay: { base_url: baseUrl, drop_id: dropId, drop_secret: dropSecret }, assignmentId: 'as-9', publishVersion: 1, studentId: 's1' };
    expect(DraftRoamer.canRoam({ relay: params.relay }, 'K7M2-QX9P')).toBe(true);
    expect(DraftRoamer.canRoam({ relay: params.relay }, '')).toBe(false);

    const first = new DraftRoamer({ ...params, accessCode: 'K7M2-QX9P' });
    first.schedule({ answers: { q1: 'Photosynthesis needs light' }, saved_at: '2026-10-18T10:00:00Z' });
    await first.flush();

    const secrets = await deriveDraftSecrets({ ...params, accessCode: 'K7M2QX9P' });
    const stored = relay.db.drafts.get(dropId, secrets.id);
    expect(stored.ciphertext.startsWith('KBDRAFT1.')).toBe(true);
    expect(stored.ciphertext).not.toContain('Photosynthesis');

    const otherDevice = new DraftRoamer({ ...params, studentId: 'S1', accessCode: 'k7m2 qx9p' });
    expect((await otherDevice.load()).answers.q1).toBe('Photosynthesis needs light');
    expect(await new DraftRoamer({ ...params, accessCode: 'WRNG-CODE' }).load()).toBeNull();

    await otherDevice.markSubmitted();
    expect(await first.load()).toBeNull();
  });
});
