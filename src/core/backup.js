/**
 * Backup format & validation (KB-CORE-BACKUP)
 *
 * A backup file can be months old, come from another app version, or be hand-edited, so it is
 * validated with Zod before anything touches IndexedDB. Restores are all-or-nothing.
 *
 * Format v2 adds `blobs` (card images/audio, base64) and drops device-bound metadata.
 * Files on disk are v3: the v2 snapshot encrypted under the teacher's recovery code (keyvault.js).
 * This module validates the decrypted snapshot; plaintext v1/v2 files are still accepted.
 */
import { z } from './zod.js';

export const BACKUP_VERSION = 2;

export const BACKUP_TABLES = [
  'flashcards', 'timelines', 'video_assessments', 'gradebook_courses',
  'gradebook_students', 'gradebook_assignments', 'gradebook_grades',
  'gradebook_rubrics', 'assignments', 'assignment_submissions',
  'student_courses', 'student_ledger', 'app_metadata'
];

/**
 * Metadata that only makes sense on the device that wrote it. Never exported, and kept as-is
 * on the restoring device (a FileSystemFileHandle serializes to `{}`, and a copied device_id
 * would make two devices indistinguishable to sync).
 */
export const DEVICE_BOUND_METADATA = new Set([
  'autosync_file_handle', 'device_id', 'is_persistent', 'schema_version',
  'snooze_backup_until', 'sync_config', 'storage_warning_dismissed',
  // KeyVault: CryptoKeys (serialize to `{}`) and the recovery code, which must never sit next to
  // the backup it unlocks
  'teacher_key_local', 'vault_backup_key', 'vault_previous_backup_keys', 'vault_pending_recovery_code',
  // Backup location (may hold a folder handle) and cloud sign-in tokens
  'backup_target', 'cloud_auth_gdrive', 'cloud_auth_onedrive',
  // Replication: conflicts this device detected (cursors use the repl_ prefix below)
  'sync_conflicts'
]);

/** Prefixes of device-bound keys that exist per sync channel (repl_cursor:<id>, …) */
export const DEVICE_BOUND_PREFIXES = ['repl_'];

export function isDeviceBoundKey(key) {
  return DEVICE_BOUND_METADATA.has(key) || DEVICE_BOUND_PREFIXES.some(p => String(key).startsWith(p));
}

const MAX_RECORDS_PER_TABLE = 200000;
const MAX_BLOB_BYTES = 5 * 1024 * 1024;

const idString = z.string().min(1).max(200);
const record = z.looseObject({ id: idString });
const gradeRecord = z.looseObject({ student_id: idString, assignment_id: idString });
const metadataRecord = z.object({ key: z.string().min(1).max(200), value: z.unknown() });

const tableSchemas = Object.fromEntries(BACKUP_TABLES.map((t) => {
  const row = t === 'gradebook_grades' ? gradeRecord : t === 'app_metadata' ? metadataRecord : record;
  return [t, z.array(row).max(MAX_RECORDS_PER_TABLE).optional()];
}));

const blobSchema = z.object({
  id: idString,
  mime_type: z.string().regex(/^(image\/(webp|png|jpeg|gif)|audio\/(webm|ogg|mp4|mpeg)(;\s*codecs=[\w.]+)?)$/),
  data: z.string().max(Math.ceil(MAX_BLOB_BYTES * 4 / 3) + 4)
});

export const BackupSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  exported_at: z.string().optional(),
  data: z.looseObject(tableSchemas),
  blobs: z.array(blobSchema).max(20000).optional()
});

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupError';
  }
}

/**
 * Parse and validate backup JSON text.
 * @param {string} text
 * @returns {{ snapshot: object, counts: Record<string, number>, exportedAt: string|null, hasPlaintextSecrets: boolean }}
 * @throws {BackupError} with a message suitable for showing to the user
 */
export function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (_) {
    throw new BackupError('This file is not valid JSON.');
  }
  if (raw?.kennisboost_backup === 3) {
    throw new BackupError('This backup is encrypted and must be opened with its recovery code first.');
  }
  const result = BackupSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path?.length ? ` (at ${issue.path.slice(0, 3).join('.')})` : '';
    throw new BackupError(`This is not a KennisBoost backup, or it is damaged${where}.`);
  }
  const snapshot = result.data;
  // Ids must be unique per table or bulkPut would silently merge rows
  for (const t of BACKUP_TABLES) {
    const rows = snapshot.data[t];
    if (!rows || t === 'gradebook_grades' || t === 'app_metadata') continue;
    if (new Set(rows.map(r => r.id)).size !== rows.length) {
      throw new BackupError(`The backup contains duplicate records in ${t}.`);
    }
  }
  const counts = {};
  for (const t of BACKUP_TABLES) {
    if (t !== 'app_metadata') counts[t] = snapshot.data[t]?.length || 0;
  }
  counts.media = snapshot.blobs?.length || 0;
  // Written before encrypted backups existed: the teacher's private key is in the clear
  const hasPlaintextSecrets = Boolean(snapshot.data.app_metadata?.some(r => r.key === 'teacher_submission_keypair' && r.value));
  return { snapshot, counts, exportedAt: snapshot.exported_at || null, hasPlaintextSecrets };
}

export function stripDeviceMetadata(rows = []) {
  return rows.filter(r => r && !isDeviceBoundKey(r.key));
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
