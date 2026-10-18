import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { StorageManager } from '../src/core/storage.js';
import { SyncManager } from '../src/core/sync.js';
import { KeyVault, LEGACY_TEACHER_KEY } from '../src/core/keyvault.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { parseBackup, BackupError } from '../src/core/backup.js';

async function freshDevice() {
  const sm = new StorageManager();
  await sm.init();
  return { sm, sync: new SyncManager(sm) };
}

/** Wipe the browser profile: what a lost laptop or "clear site data" does */
async function wipe(sm) {
  sm.db.close();
  await sm.db.delete();
}

describe('Phase 26: Encrypted backups (format v3)', () => {
  let device;
  beforeEach(async () => {
    if (device) await wipe(device.sm);
    device = await freshDevice();
    await device.sm.table('gradebook_students').put({ id: 'st-1', course_id: 'c1', student_id: 'S1', full_name: 'Ada Lovelace', access_code: 'K7M2-QX9P' });
  });

  it('writes ciphertext only: no names, access codes or private key in the file', async () => {
    await SubmissionCrypto.getOrCreateTeacherKeys(device.sm);
    const text = await device.sync.buildBackupText();
    const outer = JSON.parse(text);
    expect(outer.kennisboost_backup).toBe(3);
    expect(text).not.toContain('Ada Lovelace');
    expect(text).not.toContain('K7M2');
    expect(text).not.toContain('privateJwk');
    expect(() => parseBackup(text)).toThrow(BackupError);
  });

  it('restores on the same device without asking for the code', async () => {
    const text = await device.sync.buildBackupText();
    await device.sm.table('gradebook_students').put({ id: 'st-2', course_id: 'c1', student_id: 'S2', full_name: 'Made later' });
    const opened = await device.sync.openBackupFile(text);
    expect(opened.encrypted).toBe(true);
    expect(opened.usedRecoveryCode).toBe(false);
    expect(opened.counts.gradebook_students).toBe(1);
    await device.sync.restoreOpenedBackup(opened);
    expect((await device.sm.table('gradebook_students').toArray()).map(s => s.id)).toEqual(['st-1']);
  });

  it('restores on a new device with the recovery code, and old submissions still open', async () => {
    const keys = await SubmissionCrypto.getOrCreateTeacherKeys(device.sm);
    const submission = await SubmissionCrypto.encryptForTeacher(keys.publicJwk, { answer: 42 }, { assignment_id: 'as-1' });
    const code = await KeyVault.getPendingRecoveryCode(device.sm);
    const text = await device.sync.buildBackupText();

    await wipe(device.sm);
    device = await freshDevice();

    await expect(device.sync.openBackupFile(text)).rejects.toMatchObject({ code: 'NEEDS_RECOVERY_CODE' });
    const wrongCode = await KeyVault.getPendingRecoveryCode(device.sm); // this device's own, unrelated code
    await expect(device.sync.openBackupFile(text, { recoveryCode: wrongCode })).rejects.toMatchObject({ code: 'WRONG_CODE' });

    const opened = await device.sync.openBackupFile(text, { recoveryCode: code.toLowerCase() });
    expect(opened.usedRecoveryCode).toBe(true);
    await device.sync.restoreOpenedBackup(opened);

    const restoredKeys = await SubmissionCrypto.getOrCreateTeacherKeys(device.sm);
    expect(restoredKeys.fingerprint).toBe(keys.fingerprint);
    expect(await SubmissionCrypto.decryptFromStudent(restoredKeys.privateKey, submission)).toEqual({ answer: 42 });
    expect((await device.sm.table('gradebook_students').toArray())[0].full_name).toBe('Ada Lovelace');

    // The restored device now writes backups the same recovery code opens, and the kit counts as saved
    expect((await KeyVault.status(device.sm)).recoveryKitSaved).toBe(true);
    const next = JSON.parse(await device.sync.buildBackupText());
    expect(next.key_id).toBe(JSON.parse(text).key_id);
  });

  it('rejects a modified backup', async () => {
    const outer = JSON.parse(await device.sync.buildBackupText());
    outer.compression = 'none';
    await expect(device.sync.openBackupFile(JSON.stringify(outer))).rejects.toMatchObject({ code: 'DAMAGED' });
  });

  it('still restores old plaintext backups, flags them, and migrates their key into the vault', async () => {
    const legacy = await SubmissionCrypto.generateKeyPair();
    const old = { version: 2, data: { app_metadata: [{ key: LEGACY_TEACHER_KEY, value: legacy }], flashcards: [{ id: 'd1', title: 'Old deck' }] } };
    const opened = await device.sync.openBackupFile(JSON.stringify(old));
    expect(opened.encrypted).toBe(false);
    expect(opened.hasPlaintextSecrets).toBe(true);

    await SubmissionCrypto.getOrCreateTeacherKeys(device.sm); // a key from before the restore
    await device.sync.restoreOpenedBackup(opened);

    const keys = await SubmissionCrypto.getOrCreateTeacherKeys(device.sm);
    expect(keys.fingerprint).toBe(legacy.fingerprint);
    expect(await device.sm.getMetadata(LEGACY_TEACHER_KEY)).toBeNull();
    expect(await device.sync.buildBackupText()).not.toContain(legacy.privateJwk.d);
  });
});
