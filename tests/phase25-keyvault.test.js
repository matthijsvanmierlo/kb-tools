import { describe, it, expect } from 'vitest';
import {
  KeyVault, VaultError, encodeRecoveryCode, decodeRecoveryCode,
  VAULT_DEVICE_METADATA, LEGACY_TEACHER_KEY, TEACHER_KEY_WRAPPED
} from '../src/core/keyvault.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { DEVICE_BOUND_METADATA } from '../src/core/backup.js';

/** Minimal metadata store (same shape the StorageManager exposes); structuredClone like IndexedDB */
function memoryStore() {
  const map = new Map();
  return {
    map,
    async getMetadata(k) { return map.has(k) ? structuredClone(map.get(k)) : null; },
    async setMetadata(k, v) { map.set(k, structuredClone(v)); }
  };
}

async function roundTrip(keys) {
  const env = await SubmissionCrypto.encryptForTeacher(keys.publicJwk, { hello: 'world' }, { assignment_id: 'a-1' });
  return SubmissionCrypto.decryptFromStudent(keys.privateKey, env);
}

describe('Phase 25: Recovery codes', () => {
  it('round-trips 128 bits through a 26-character grouped code', () => {
    const raw = crypto.getRandomValues(new Uint8Array(16));
    const code = encodeRecoveryCode(raw);
    expect(code.replace(/-/g, '')).toHaveLength(26);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z-]+$/);
    expect(decodeRecoveryCode(code)).toEqual(raw);
  });

  it('forgives case, spacing and look-alike characters', () => {
    const raw = new Uint8Array(16).fill(0);
    raw[0] = 0x84; // encodes to "G0…", exercising the O→0 mapping
    const code = encodeRecoveryCode(raw);
    const sloppy = code.toLowerCase().replace(/0/g, 'o').replace(/-/g, ' ');
    expect(decodeRecoveryCode(sloppy)).toEqual(raw);
  });

  it('rejects codes of the wrong length', () => {
    expect(() => decodeRecoveryCode('ABCD-EFGH')).toThrow(VaultError);
  });
});

describe('Phase 25: Teacher key in the vault', () => {
  it('creates a non-extractable private key and only stores it encrypted', async () => {
    const store = memoryStore();
    const keys = await SubmissionCrypto.getOrCreateTeacherKeys(store);
    expect(keys.privateKey.extractable).toBe(false);
    expect(keys.fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(await roundTrip(keys)).toEqual({ hello: 'world' });

    const wrapped = await store.getMetadata(TEACHER_KEY_WRAPPED);
    expect(wrapped.ct).toBeTruthy();
    expect(wrapped.d).toBeUndefined();
    expect(JSON.stringify(wrapped)).not.toContain('"d"');
    expect(await store.getMetadata(LEGACY_TEACHER_KEY)).toBeNull();
  });

  it('returns the same key on later calls and after the local copy is dropped', async () => {
    const store = memoryStore();
    const first = await KeyVault.getTeacherKeys(store);
    expect((await KeyVault.getTeacherKeys(store)).fingerprint).toBe(first.fingerprint);
    await KeyVault.forgetLocalTeacherKey(store);
    const again = await KeyVault.getTeacherKeys(store);
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(await roundTrip(again)).toEqual({ hello: 'world' });
  });

  it('migrates a plaintext key from an older version and deletes it', async () => {
    const store = memoryStore();
    const legacy = await SubmissionCrypto.generateKeyPair();
    await store.setMetadata(LEGACY_TEACHER_KEY, legacy);
    const env = await SubmissionCrypto.encryptForTeacher(legacy.publicJwk, { old: true }, {});

    const keys = await KeyVault.getTeacherKeys(store);
    expect(keys.fingerprint).toBe(legacy.fingerprint);
    expect(await store.getMetadata(LEGACY_TEACHER_KEY)).toBeNull();
    expect(await SubmissionCrypto.decryptFromStudent(keys.privateKey, env)).toEqual({ old: true });
    expect((await KeyVault.status(store)).hasVault).toBe(true);
  });

  it('reports a locked key when the backup key for it is missing', async () => {
    const store = memoryStore();
    await KeyVault.getTeacherKeys(store);
    await store.setMetadata(VAULT_DEVICE_METADATA.backupKey, null);
    await KeyVault.forgetLocalTeacherKey(store);
    // ensure() would make a new backup key, but it cannot open the old wrapped key
    await KeyVault.ensure(store);
    await expect(KeyVault.getTeacherKeys(store)).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });
});

describe('Phase 25: Recovery kit lifecycle', () => {
  it('keeps the code pending until the teacher confirms, then forgets it', async () => {
    const store = memoryStore();
    const code = await KeyVault.getPendingRecoveryCode(store);
    expect(code).toBeTruthy();
    expect((await KeyVault.status(store)).recoveryKitSaved).toBe(false);
    await KeyVault.confirmRecoveryKitSaved(store);
    expect(await KeyVault.getPendingRecoveryCode(store)).toBeNull();
    expect((await KeyVault.status(store)).recoveryKitSaved).toBe(true);
  });

  it('rotating the code re-encrypts the teacher key and keeps old backups readable here', async () => {
    const store = memoryStore();
    const keys = await KeyVault.getTeacherKeys(store);
    const oldBackup = await KeyVault.encryptBackup(store, { version: 2, data: {} });
    const oldCode = await KeyVault.getPendingRecoveryCode(store);
    await KeyVault.confirmRecoveryKitSaved(store);

    const newCode = await KeyVault.rotateRecoveryCode(store);
    expect(newCode).not.toBe(oldCode);
    expect((await KeyVault.status(store)).recoveryKitSaved).toBe(false);

    await KeyVault.forgetLocalTeacherKey(store);
    expect((await KeyVault.getTeacherKeys(store)).fingerprint).toBe(keys.fingerprint);
    expect((await KeyVault.decryptBackup(store, oldBackup)).usedRecoveryCode).toBe(false);
  });

  it('never exports vault internals in a backup', () => {
    for (const k of Object.values(VAULT_DEVICE_METADATA)) expect(DEVICE_BOUND_METADATA.has(k)).toBe(true);
    expect(DEVICE_BOUND_METADATA.has(TEACHER_KEY_WRAPPED)).toBe(false);
  });
});
