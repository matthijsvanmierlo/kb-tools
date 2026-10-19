/**
 * Term archives - KB-CORE-013
 *
 * At the end of a term a teacher can file an encrypted copy of everything in a school-designated
 * place, so the school keeps its records after the teacher's devices are replaced or the teacher
 * leaves. The snapshot is encrypted under a fresh key K, and K is wrapped:
 *   - under the teacher's backup key (the teacher can always open their archives), and
 *   - when IT enabled `escrow.archivesReadableBySchool`, to the school's offline escrow key, so the
 *     school can open archives without the teacher (scripts/escrow-recover.mjs --archive).
 * The second wrap is shown to the teacher before archiving; day-to-day backups are never readable
 * by the school.
 */
import { KeyVault, VAULT_DEVICE_METADATA } from './keyvault.js';
import { SubmissionCrypto, bytesToB64, b64ToBytes } from './submission-crypto.js';
import { deflateRaw, inflateRaw, supportsCompressionStreams } from './crypto-share.js';

export const ARCHIVE_VERSION = 1;
const enc = new TextEncoder();
const dec = new TextDecoder();

const dataAad = (id) => `kb-archive-data|${id}`;
const teacherWrapAad = (id, keyId) => `kb-archive-key|${id}|${keyId}`;

async function aesGcm(op, key, bytes, aad, iv) {
  return new Uint8Array(await crypto.subtle[op]({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes));
}

/**
 * @param {object} store - StorageManager
 * @param {object} opts
 * @param {string} opts.label - e.g. "2025-26 Term 1"
 * @param {object|null} [opts.schoolPublicJwk] - escrow key, when archives are readable by the school
 * @param {string} [opts.teacherName]
 * @returns {Promise<{ text: string, filename: string, readableBySchool: boolean }>}
 */
export async function createTermArchive(store, { label, schoolPublicJwk = null, teacherName = '' }) {
  const vault = await KeyVault.ensure(store);
  const snapshot = await store.dumpMasterSnapshot();
  const id = crypto.randomUUID();
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);

  const compression = supportsCompressionStreams() ? 'deflate-raw' : 'none';
  let bytes = enc.encode(JSON.stringify(snapshot));
  if (compression === 'deflate-raw') bytes = await deflateRaw(bytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await aesGcm('encrypt', key, bytes, dataAad(id), iv);

  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const teacherWrap = await aesGcm('encrypt', vault.key, rawKey, teacherWrapAad(id, vault.id), wrapIv);
  const schoolWrap = schoolPublicJwk
    ? await SubmissionCrypto.encryptForTeacher(schoolPublicJwk, { k: bytesToB64(rawKey) }, { kind: 'term-archive', archive_id: id, v: ARCHIVE_VERSION })
    : null;

  const createdAt = new Date().toISOString();
  const archive = {
    kennisboost_archive: ARCHIVE_VERSION,
    id,
    label,
    teacher: teacherName || null,
    created_at: createdAt,
    counts: Object.fromEntries(Object.entries(snapshot.data).filter(([t]) => t !== 'app_metadata').map(([t, rows]) => [t, rows.length])),
    compression,
    iv: bytesToB64(iv),
    ct: bytesToB64(ct),
    teacher_wrap: { key_id: vault.id, iv: bytesToB64(wrapIv), ct: bytesToB64(teacherWrap) },
    school_wrap: schoolWrap ? { admin_fingerprint: await SubmissionCrypto.fingerprint(schoolPublicJwk), envelope: schoolWrap } : null
  };
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 40);
  return {
    text: JSON.stringify(archive),
    filename: `kennisboost-archive-${safe(teacherName) || 'teacher'}-${safe(label)}-${createdAt.slice(0, 10)}.kbarchive.json`,
    readableBySchool: Boolean(schoolWrap)
  };
}

async function openWithRawKey(archive, rawKey) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  let bytes = await aesGcm('decrypt', key, b64ToBytes(archive.ct), dataAad(archive.id), b64ToBytes(archive.iv));
  if (archive.compression === 'deflate-raw') bytes = await inflateRaw(bytes);
  return JSON.parse(dec.decode(bytes));
}

/** Teacher side: open an archive with this device's (current or previous) backup key */
export async function openTermArchive(store, text) {
  const archive = JSON.parse(text);
  if (archive?.kennisboost_archive !== ARCHIVE_VERSION) throw new Error('NOT_AN_ARCHIVE');
  const current = await store.getMetadata(VAULT_DEVICE_METADATA.backupKey);
  const previous = (await store.getMetadata(VAULT_DEVICE_METADATA.previousBackupKeys)) || [];
  const vault = [current, ...previous].find(v => v?.id === archive.teacher_wrap.key_id);
  if (!vault) throw new Error('NOT_THIS_TEACHER');
  const rawKey = await aesGcm('decrypt', vault.key, b64ToBytes(archive.teacher_wrap.ct), teacherWrapAad(archive.id, vault.id), b64ToBytes(archive.teacher_wrap.iv));
  return openWithRawKey(archive, rawKey);
}

/** School side: open an archive with the escrow private key (offline tool) */
export async function openTermArchiveAsSchool(text, schoolPrivateJwk) {
  const archive = JSON.parse(text);
  if (archive?.kennisboost_archive !== ARCHIVE_VERSION) throw new Error('NOT_AN_ARCHIVE');
  if (!archive.school_wrap) throw new Error('NOT_READABLE_BY_SCHOOL');
  const { k } = await SubmissionCrypto.decryptFromStudent(schoolPrivateJwk, archive.school_wrap.envelope);
  return openWithRawKey(archive, b64ToBytes(k));
}
