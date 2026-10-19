import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { StorageManager } from '../src/core/storage.js';
import { ReplicationEngine, importChannelKey, newChannelSecret, sealJson, CONFLICTS_METADATA } from '../src/core/replication/engine.js';
import { MemoryChannel } from '../src/core/replication/channels.js';
import { createOffer, answerOffer, openAnswer, parseOffer } from '../src/core/replication/link.js';
import { KeyVault } from '../src/core/keyvault.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { SyncManager } from '../src/core/sync.js';
import { isDeviceBoundKey } from '../src/core/backup.js';

let dbCounter = 0;
async function device() {
  const sm = new StorageManager({ dbName: `kb-test-${Date.now()}-${dbCounter++}` });
  await sm.init();
  return sm;
}

const tick = () => new Promise(r => setTimeout(r, 5));

async function engineFor(store, channel, secret, extra = {}) {
  return new ReplicationEngine({ store, channel, channelId: 'chan1', key: await importChannelKey(secret), deviceId: store.deviceId, ...extra });
}

describe('Phase 28: Outbox for sync', () => {
  it('records the class of every change, including deletes, and never echoes remote changes', async () => {
    const a = await device();
    await a.table('gradebook_students').put({ id: 's1', course_id: 'c1', student_id: 'S1', full_name: 'Ada' });
    await a.table('assignment_submissions').put({ id: 'sub1', assignment_id: 'as1', student_id: 'S1' });
    await a.table('gradebook_students').delete('s1');
    const rows = await a.outbox.since(0);
    expect(rows.map(r => r.scope)).toEqual([{ course_id: 'c1' }, { assignment_id: 'as1' }, { course_id: 'c1' }]);

    const before = await a.outbox.latestSeq();
    await a.applyRemoteChange('gradebook_students', 'put', 's2', { id: 's2', course_id: 'c1', updated_at: '2026-01-01T00:00:00Z' });
    expect(await a.outbox.latestSeq()).toBe(before);
    expect((await a.getByChangeKey('gradebook_students', 's2')).id).toBe('s2');

    await a.outbox.pruneThrough(before);
    expect(await a.outbox.since(0)).toEqual([]);
  });

  it('keeps sync cursors out of backups', () => {
    expect(isDeviceBoundKey('repl_cursor:abc')).toBe(true);
    expect(isDeviceBoundKey('sync_conflicts')).toBe(true);
    expect(isDeviceBoundKey('vault_secrets')).toBe(false);
  });
});

describe('Phase 28: Replication engine', () => {
  let a, b, channel, secret, ea, eb;
  beforeEach(async () => {
    a = await device();
    b = await device();
    channel = new MemoryChannel();
    secret = newChannelSecret();
    ea = await engineFor(a, channel, secret);
    eb = await engineFor(b, channel, secret);
  });

  it('copies changes to the other device without echoing them back', async () => {
    await a.table('flashcards').put({ id: 'd1', title: 'Cells' });
    await a.table('gradebook_grades').put({ id: 'g1', student_id: 'S1', assignment_id: 'A1', course_id: 'c1', raw_score: 8 });
    expect(await ea.push()).toBe(2);
    const r = await eb.pull();
    expect(r.applied).toBe(2);
    expect((await b.table('flashcards').get('d1')).title).toBe('Cells');
    expect((await b.getByChangeKey('gradebook_grades', ['S1', 'A1'])).raw_score).toBe(8);
    expect(await b.outbox.latestSeq()).toBe(0);
    expect(await eb.push()).toBe(0);
    // Pulling again changes nothing
    expect((await eb.pull()).applied).toBe(0);
  });

  it('stores only ciphertext in the channel', async () => {
    await a.table('gradebook_students').put({ id: 's1', course_id: 'c1', student_id: 'S1', full_name: 'Ada Lovelace' });
    await ea.push();
    const body = [...channel.chunks.values()][0].body;
    expect(body).not.toContain('Ada');
  });

  it('keeps the newest edit and reports grades both devices changed', async () => {
    await a.table('gradebook_grades').put({ id: 'g1', student_id: 'S1', assignment_id: 'A1', course_id: 'c1', raw_score: 5 });
    await ea.push();
    await eb.pull();
    // Both edit before syncing; B's edit is newer
    await a.table('gradebook_grades').put({ id: 'g1', student_id: 'S1', assignment_id: 'A1', course_id: 'c1', raw_score: 6 });
    await tick();
    await b.table('gradebook_grades').put({ id: 'g1', student_id: 'S1', assignment_id: 'A1', course_id: 'c1', raw_score: 9 });
    await eb.pull(); await eb.push();
    await ea.pull(); await ea.push();
    await eb.pull();
    expect((await a.getByChangeKey('gradebook_grades', ['S1', 'A1'])).raw_score).toBe(9);
    expect((await b.getByChangeKey('gradebook_grades', ['S1', 'A1'])).raw_score).toBe(9);
    const conflicts = await a.getMetadata(CONFLICTS_METADATA);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kept: { raw_score: 9 }, discarded: { raw_score: 6 } });
  });

  it('propagates deletes, but an edit made after the deletion wins', async () => {
    await a.table('flashcards').put({ id: 'd1', title: 'One' });
    await a.table('flashcards').put({ id: 'd2', title: 'Two' });
    await ea.push(); await eb.pull();
    await a.table('flashcards').delete('d1');
    await a.table('flashcards').delete('d2');
    await tick();
    await b.table('flashcards').put({ id: 'd2', title: 'Two, edited later' });
    await ea.push(); await eb.pull();
    expect(await b.table('flashcards').get('d1')).toBeUndefined();
    expect((await b.table('flashcards').get('d2')).title).toBe('Two, edited later');
  });

  it('lets a new device catch up from a snapshot after old chunks were pruned', async () => {
    await a.table('flashcards').put({ id: 'd1', title: 'Before' });
    await ea.push(); await eb.pull();
    const { vector } = await ea.writeSnapshot();
    await ea.pruneOwnChunks(vector[a.deviceId]);
    expect(channel.chunks.size).toBe(0);

    await a.table('flashcards').put({ id: 'd2', title: 'After' });
    await ea.push();

    const c = await device();
    const ec = await engineFor(c, channel, secret);
    const r = await ec.pull();
    expect(r.bootstrapped).toBe(true);
    expect((await c.table('flashcards').toArray()).map(d => d.id).sort()).toEqual(['d1', 'd2']);
    // B, which already had d1, just applies the new chunk
    await eb.pull();
    expect((await b.table('flashcards').get('d2')).title).toBe('After');
  });

  it('notices chunks it missed (pruned while offline) and recovers from the snapshot', async () => {
    await a.table('flashcards').put({ id: 'd1', title: 'Seen' });
    await ea.push(); await eb.pull();
    await a.table('flashcards').put({ id: 'd2', title: 'Missed' });
    await ea.push();
    const { vector } = await ea.writeSnapshot();
    await ea.pruneOwnChunks(vector[a.deviceId]);
    await a.table('flashcards').put({ id: 'd3', title: 'Next' });
    await ea.push();
    await eb.pull();
    expect((await b.table('flashcards').toArray()).map(d => d.id).sort()).toEqual(['d1', 'd2', 'd3']);
  });

  it('rejects damaged chunks', async () => {
    await a.table('flashcards').put({ id: 'd1', title: 'x' });
    await ea.push();
    const c = [...channel.chunks.values()][0];
    const box = JSON.parse(c.body);
    box.ct = box.ct.slice(0, -4) + 'AAAA';
    c.body = JSON.stringify(box);
    await expect(eb.pull()).rejects.toMatchObject({ code: 'UNREADABLE' });
  });

  it('a class channel carries one class only, and ignores anything else a co-teacher sends', async () => {
    const ca = await engineFor(a, channel, secret, { courseId: 'c1' });
    const cb = await engineFor(b, channel, secret, { courseId: 'c1' });
    await a.table('gradebook_courses').put({ id: 'c1', name: 'Shared' });
    await a.table('gradebook_courses').put({ id: 'c2', name: 'Private' });
    await a.table('assignments').put({ id: 'as1', class_id: 'c1', title: 'Quiz' });
    await a.table('assignment_submissions').put({ id: 'sub1', assignment_id: 'as1', student_id: 'S1' });
    await ca.push();
    await cb.pull();
    expect((await b.table('gradebook_courses').toArray()).map(c => c.id)).toEqual(['c1']);
    expect(await b.table('assignment_submissions').get('sub1')).toBeTruthy();

    // A co-teacher's device crafts a chunk claiming a c1 scope for a c2 record
    const key = await importChannelKey(secret);
    const evil = { v: 1, channel: 'chan1', device_id: 'evil-device-1', start: 1, end: 1, prev_end: 0, ops: [
      { table: 'gradebook_courses', op: 'put', key: 'c2', scope: { course_id: 'c1' }, record: { id: 'c2', name: 'Hijacked', updated_at: '2999-01-01T00:00:00Z' } },
      { table: 'gradebook_courses', op: 'delete', key: 'c2', scope: { course_id: 'c1' }, ts: '2999-01-01T00:00:00Z' },
      { table: '_vault', op: 'put', key: 'class_key:c2', record: {} }
    ] };
    await channel.putChunk({ deviceId: 'evil-device-1', start: 1, end: 1, body: await sealJson(key, evil, 'kb-sync-chunk|chan1|evil-device-1|1|1') });
    await ca.pull();
    expect((await a.table('gradebook_courses').get('c2')).name).toBe('Private');
  });
});

describe('Phase 28: Link handshake', () => {
  it('delivers the payload and shows the same safety number on both screens', async () => {
    const offer = await createOffer('device');
    expect(offer.code).toMatch(/^KBLINK1\./);
    const { code, safety } = await answerOffer(offer.code, { hello: 'new device' }, 'device');
    const opened = await openAnswer(offer, code);
    expect(opened.payload).toEqual({ hello: 'new device' });
    expect(opened.safety).toBe(safety);
    expect(safety).toMatch(/^\d{3} \d{3}$/);
  });

  it('refuses replies made for another screen and codes of the wrong kind', async () => {
    const offer = await createOffer('device');
    const other = await createOffer('device');
    const { code } = await answerOffer(other.code, { x: 1 }, 'device');
    await expect(openAnswer(offer, code)).rejects.toMatchObject({ code: 'NOT_FOR_THIS_SCREEN' });
    const join = await createOffer('coteacher');
    expect(() => parseOffer(join.code, 'device')).toThrow(/co-teacher/);
    expect(() => parseOffer('KBLINK1.abc', 'device')).toThrow(/damaged/);
  });
});

describe('Phase 28: Vault secrets, class keys and device linking', () => {
  it('keeps secrets encrypted and readable after the recovery code changes', async () => {
    const a = await device();
    await KeyVault.setSecret(a, 'class_key:c1', { hello: 'world' });
    expect(JSON.stringify(await a.getMetadata('vault_secrets'))).not.toContain('world');
    await KeyVault.rotateRecoveryCode(a);
    expect(await KeyVault.getSecret(a, 'class_key:c1')).toEqual({ hello: 'world' });
  });

  it('opens hand-ins encrypted to any key this device holds', async () => {
    const a = await device();
    const own = await SubmissionCrypto.getOrCreateTeacherKeys(a);
    const cls = await KeyVault.ensureClassKey(a, 'c1');
    const toClass = await SubmissionCrypto.encryptForTeacher(cls.publicJwk, { for: 'class' }, {});
    const keys = await SubmissionCrypto.getOrCreateTeacherKeys(a);
    expect(keys.decryptionKeys).toHaveLength(2);
    expect(await SubmissionCrypto.decryptFromStudent(keys.decryptionKeys, toClass)).toEqual({ for: 'class' });
    const stranger = await SubmissionCrypto.generateKeyPair();
    const toStranger = await SubmissionCrypto.encryptForTeacher(stranger.publicJwk, {}, {});
    await expect(SubmissionCrypto.decryptFromStudent(keys.decryptionKeys, toStranger)).rejects.toThrow('DECRYPTION_FAILED');
    expect(own.fingerprint).toBe(keys.fingerprint);
  });

  it('a linked device opens the other device\'s hand-ins and backups, and keeps its own old key', async () => {
    const a = await device();
    const b = await device();
    const aKeys = await SubmissionCrypto.getOrCreateTeacherKeys(a);
    await KeyVault.confirmRecoveryKitSaved(a);
    const bOld = await SubmissionCrypto.getOrCreateTeacherKeys(b);
    const toA = await SubmissionCrypto.encryptForTeacher(aKeys.publicJwk, { to: 'A' }, {});
    const toOldB = await SubmissionCrypto.encryptForTeacher(bOld.publicJwk, { to: 'old B' }, {});
    await a.table('flashcards').put({ id: 'd1', title: 'From A' });
    const backup = await new SyncManager(a).buildBackupText();

    await KeyVault.importLinkBundle(b, await KeyVault.exportLinkBundle(a));
    const bKeys = await SubmissionCrypto.getOrCreateTeacherKeys(b);
    expect(bKeys.fingerprint).toBe(aKeys.fingerprint);
    expect(await SubmissionCrypto.decryptFromStudent(bKeys.decryptionKeys, toA)).toEqual({ to: 'A' });
    expect(await SubmissionCrypto.decryptFromStudent(bKeys.decryptionKeys, toOldB)).toEqual({ to: 'old B' });
    expect((await new SyncManager(b).openBackupFile(backup)).usedRecoveryCode).toBe(false);
    expect((await KeyVault.status(b)).recoveryKitSaved).toBe(true);
  });
});
