/**
 * KeyVault - KB-CORE-008
 *
 * Keeps the teacher's secrets safe at rest and makes backups useless to anyone without the
 * teacher's recovery code:
 *
 *  1. Recovery code — 128 random bits shown to the teacher once as a printable "recovery kit"
 *     (e.g. "7K3M-…"). HKDF turns it into the backup key. The code itself is only kept on this
 *     device until the teacher confirms they saved the kit.
 *  2. Backup key — a non-extractable AES-256-GCM CryptoKey stored on this device (device-bound),
 *     so background auto-sync can encrypt without asking for anything.
 *  3. Teacher key — the ECDH private key used to open student submissions. Locally it is a
 *     non-extractable CryptoKey; the only exported form is encrypted under the backup key
 *     (`teacher_key_wrapped`), so a backup or a copied sync file never contains it in the clear.
 *
 * Backups (format v3) are deflate-raw → AES-256-GCM under the backup key. Restoring on a new
 * device needs the recovery code; restoring on the device that wrote the file needs nothing.
 */
import { SubmissionCrypto, bytesToB64, b64ToBytes, sha256Hex } from './submission-crypto.js';
import { deflateRaw, inflateRaw, supportsCompressionStreams } from './crypto-share.js';

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const LEGACY_TEACHER_KEY = 'teacher_submission_keypair';
export const TEACHER_KEY_WRAPPED = 'teacher_key_wrapped';
export const RECOVERY_KIT_SAVED_AT = 'recovery_kit_saved_at';

/** Device-bound vault entries: never exported, kept as-is on restore (see backup.js) */
export const VAULT_DEVICE_METADATA = Object.freeze({
  teacherKeyLocal: 'teacher_key_local',
  backupKey: 'vault_backup_key',
  previousBackupKeys: 'vault_previous_backup_keys',
  pendingRecoveryCode: 'vault_pending_recovery_code'
});
const M = VAULT_DEVICE_METADATA;

export const ENCRYPTED_BACKUP_VERSION = 3;

// Crockford base32: no I, L, O, U, so codes survive handwriting and reading aloud
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

/** 16 random bytes → 26 Crockford characters, grouped by 4 */
export function encodeRecoveryCode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}

export function decodeRecoveryCode(code) {
  const norm = String(code || '').toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (norm.length !== 26 || /[U]/.test(norm)) {
    throw new VaultError('BAD_CODE', 'A recovery code has 26 letters and digits.');
  }
  const out = new Uint8Array(16);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const ch of norm) {
    value = (value << 5) | CROCKFORD.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      if (i < 16) out[i++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

async function keyIdFor(rawCodeBytes) {
  return (await sha256Hex(`kb-vault-id|${bytesToB64(rawCodeBytes)}`)).slice(0, 12);
}

async function deriveBackupKey(rawCodeBytes) {
  const ikm = await subtle().importKey('raw', rawCodeBytes, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('kb-vault-v1'), info: enc.encode('kb-backup') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function aesEncrypt(key, bytes, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes);
  return { iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

async function aesDecrypt(key, { iv, ct }, aad) {
  return new Uint8Array(await subtle().decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(iv), additionalData: enc.encode(aad) }, key, b64ToBytes(ct)
  ));
}

const importPrivate = (jwk) => subtle().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

const wrapAad = (keyId, fingerprint) => `kb-teacher-key|${keyId}|${fingerprint}`;
const backupAad = (keyId, compression) => `kb-backup-v3|${keyId}|${compression}`;

export class KeyVault {
  // ---------------------------------------------------------------------------
  // Backup key & recovery code
  // ---------------------------------------------------------------------------

  /** Create the backup key on first use. Returns `{ id, key }`. */
  static async ensure(store) {
    const existing = await store.getMetadata(M.backupKey);
    if (existing?.key && existing?.id) return existing;
    return this._installNewRecoveryCode(store);
  }

  static async _installNewRecoveryCode(store) {
    const raw = crypto.getRandomValues(new Uint8Array(16));
    const entry = { id: await keyIdFor(raw), key: await deriveBackupKey(raw), created_at: new Date().toISOString() };
    await store.setMetadata(M.backupKey, entry);
    await store.setMetadata(M.pendingRecoveryCode, encodeRecoveryCode(raw));
    await store.setMetadata(RECOVERY_KIT_SAVED_AT, null);
    return entry;
  }

  /** The recovery code, while the teacher has not yet confirmed saving their kit */
  static async getPendingRecoveryCode(store) {
    await this.ensure(store);
    return store.getMetadata(M.pendingRecoveryCode);
  }

  static async confirmRecoveryKitSaved(store) {
    await store.setMetadata(M.pendingRecoveryCode, null);
    await store.setMetadata(RECOVERY_KIT_SAVED_AT, new Date().toISOString());
  }

  /**
   * Replace the recovery code (e.g. the printed kit was lost). The teacher key is re-encrypted
   * under the new backup key. The old key is kept on this device so older backup files written
   * here still open; on other devices they need the old code.
   */
  static async rotateRecoveryCode(store) {
    const old = await this.ensure(store);
    const teacher = await this._readWrappedJwk(store);
    const previous = (await store.getMetadata(M.previousBackupKeys)) || [];
    await store.setMetadata(M.previousBackupKeys, [old, ...previous.filter(p => p.id !== old.id)].slice(0, 10));
    const fresh = await this._installNewRecoveryCode(store);
    if (teacher) await this._storeWrapped(store, fresh, teacher.jwk, teacher.meta);
    return store.getMetadata(M.pendingRecoveryCode);
  }

  static async status(store) {
    const backupKey = await store.getMetadata(M.backupKey);
    const savedAt = await store.getMetadata(RECOVERY_KIT_SAVED_AT);
    const pending = await store.getMetadata(M.pendingRecoveryCode);
    return {
      hasVault: Boolean(backupKey?.key),
      keyId: backupKey?.id || null,
      recoveryKitSaved: Boolean(savedAt) && !pending,
      recoveryKitSavedAt: savedAt || null
    };
  }

  static async _keyById(store, id) {
    const current = await store.getMetadata(M.backupKey);
    if (current?.id === id) return current;
    const previous = (await store.getMetadata(M.previousBackupKeys)) || [];
    return previous.find(p => p.id === id) || null;
  }

  // ---------------------------------------------------------------------------
  // Teacher key
  // ---------------------------------------------------------------------------

  /**
   * The teacher's submission key pair: `{ publicJwk, fingerprint, privateKey, created_at }`, where
   * privateKey is a non-extractable CryptoKey. Created on first use; a plaintext key from an older
   * version (or an older backup) is migrated into the vault and deleted.
   */
  static async getTeacherKeys(store) {
    const local = await store.getMetadata(M.teacherKeyLocal);
    const wrapped = await store.getMetadata(TEACHER_KEY_WRAPPED);
    if (local?.privateKey && (!wrapped || wrapped.fingerprint === local.fingerprint)) return local;

    const legacy = await store.getMetadata(LEGACY_TEACHER_KEY);
    if (legacy?.privateJwk && legacy?.publicJwk) {
      const vault = await this.ensure(store);
      const meta = { publicJwk: legacy.publicJwk, fingerprint: legacy.fingerprint || await SubmissionCrypto.fingerprint(legacy.publicJwk), created_at: legacy.created_at || null };
      await this._storeWrapped(store, vault, legacy.privateJwk, meta);
      await store.setMetadata(LEGACY_TEACHER_KEY, null);
      return this._storeLocal(store, legacy.privateJwk, meta);
    }

    if (wrapped) {
      const opened = await this._readWrappedJwk(store);
      if (!opened) {
        throw new VaultError('VAULT_LOCKED', 'Your submission key is locked. Restore a backup with your recovery code to unlock it.');
      }
      return this._storeLocal(store, opened.jwk, opened.meta);
    }

    const vault = await this.ensure(store);
    const fresh = await SubmissionCrypto.generateKeyPair();
    const meta = { publicJwk: fresh.publicJwk, fingerprint: fresh.fingerprint, created_at: fresh.created_at };
    await this._storeWrapped(store, vault, fresh.privateJwk, meta);
    return this._storeLocal(store, fresh.privateJwk, meta);
  }

  static async _storeLocal(store, privateJwk, meta) {
    const local = { ...meta, privateKey: await importPrivate(privateJwk) };
    await store.setMetadata(M.teacherKeyLocal, local);
    return local;
  }

  static async _storeWrapped(store, vault, privateJwk, meta) {
    const sealed = await aesEncrypt(vault.key, enc.encode(JSON.stringify(privateJwk)), wrapAad(vault.id, meta.fingerprint));
    await store.setMetadata(TEACHER_KEY_WRAPPED, { ...meta, backup_key_id: vault.id, ...sealed });
  }

  /** Decrypt the exported teacher key, or null when this device lacks the matching backup key */
  static async _readWrappedJwk(store) {
    const wrapped = await store.getMetadata(TEACHER_KEY_WRAPPED);
    if (!wrapped?.ct) return null;
    const vault = await this._keyById(store, wrapped.backup_key_id);
    if (!vault) return null;
    const jwk = JSON.parse(dec.decode(await aesDecrypt(vault.key, wrapped, wrapAad(vault.id, wrapped.fingerprint))));
    const { publicJwk, fingerprint, created_at } = wrapped;
    return { jwk, meta: { publicJwk, fingerprint, created_at } };
  }

  // ---------------------------------------------------------------------------
  // Encrypted backups (format v3)
  // ---------------------------------------------------------------------------

  static isEncryptedBackup(text) {
    try {
      const obj = typeof text === 'string' ? JSON.parse(text) : text;
      return obj?.kennisboost_backup === ENCRYPTED_BACKUP_VERSION;
    } catch (_) {
      return false;
    }
  }

  /** Encrypt a backup snapshot object; returns the JSON text to write to disk */
  static async encryptBackup(store, snapshot) {
    const vault = await this.ensure(store);
    const compression = supportsCompressionStreams() ? 'deflate-raw' : 'none';
    let bytes = enc.encode(JSON.stringify(snapshot));
    if (compression === 'deflate-raw') bytes = await deflateRaw(bytes);
    const sealed = await aesEncrypt(vault.key, bytes, backupAad(vault.id, compression));
    return JSON.stringify({
      kennisboost_backup: ENCRYPTED_BACKUP_VERSION,
      exported_at: snapshot.exported_at || new Date().toISOString(),
      key_id: vault.id,
      compression,
      ...sealed
    });
  }

  /**
   * Decrypt a v3 backup. Uses this device's backup key when it matches, otherwise the recovery code.
   * @returns {Promise<{ text: string, vault: { id, key }, usedRecoveryCode: boolean }>}
   * @throws {VaultError} NEEDS_RECOVERY_CODE | WRONG_CODE | DAMAGED
   */
  static async decryptBackup(store, text, recoveryCode = null) {
    let outer;
    try {
      outer = JSON.parse(text);
    } catch (_) {
      throw new VaultError('DAMAGED', 'This backup file is damaged.');
    }
    if (outer?.kennisboost_backup !== ENCRYPTED_BACKUP_VERSION || !outer.ct || !outer.iv || !outer.key_id) {
      throw new VaultError('DAMAGED', 'This backup file is damaged.');
    }

    let vault = await this._keyById(store, outer.key_id);
    let usedRecoveryCode = false;
    if (!vault) {
      if (!recoveryCode) throw new VaultError('NEEDS_RECOVERY_CODE', 'Enter the recovery code from your recovery kit to open this backup.');
      const raw = decodeRecoveryCode(recoveryCode);
      if (await keyIdFor(raw) !== outer.key_id) {
        throw new VaultError('WRONG_CODE', 'That recovery code does not belong to this backup. Check for typos, or try an older kit.');
      }
      vault = { id: outer.key_id, key: await deriveBackupKey(raw), created_at: new Date().toISOString() };
      usedRecoveryCode = true;
    }

    let bytes;
    try {
      bytes = await aesDecrypt(vault.key, outer, backupAad(outer.key_id, outer.compression));
    } catch (_) {
      throw new VaultError('DAMAGED', 'This backup file is damaged or was modified.');
    }
    if (outer.compression === 'deflate-raw') bytes = await inflateRaw(bytes);
    return { text: dec.decode(bytes), vault, usedRecoveryCode };
  }

  /**
   * After a restore: make the backup's key this device's backup key (so the restored teacher key
   * unlocks and later backups open with the same recovery code), and drop the stale local key.
   */
  static async adoptBackupKey(store, vault, { usedRecoveryCode = false } = {}) {
    const current = await store.getMetadata(M.backupKey);
    if (current?.key && current.id !== vault.id) {
      const previous = (await store.getMetadata(M.previousBackupKeys)) || [];
      await store.setMetadata(M.previousBackupKeys, [current, ...previous.filter(p => p.id !== current.id && p.id !== vault.id)].slice(0, 10));
    }
    // A pending code belongs to the key being replaced, so it no longer opens anything new
    if (usedRecoveryCode || current?.id !== vault.id) await store.setMetadata(M.pendingRecoveryCode, null);
    if (usedRecoveryCode) await store.setMetadata(RECOVERY_KIT_SAVED_AT, new Date().toISOString());
    await store.setMetadata(M.backupKey, vault);
    await this.forgetLocalTeacherKey(store);
  }

  /** Called after any restore: the local key may belong to the replaced data */
  static async forgetLocalTeacherKey(store) {
    await store.setMetadata(M.teacherKeyLocal, null);
  }
}

export default KeyVault;
