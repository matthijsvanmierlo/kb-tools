/**
 * Backup format & validation (KB-CORE-BACKUP)
 *
 * A backup file can be months old, come from another app version, or be hand-edited, so it is
 * validated with Zod before anything touches IndexedDB. Restores are all-or-nothing.
 *
 * Format v2 adds `blobs` (card images/audio, base64) and drops device-bound metadata.
 */
import { z } from './zod.js';

export const BACKUP_VERSION = 2;

export const BACKUP_TABLES = [
  'flashcards', 'timelines', 'video_assessments', 'gradebook_courses',
  'gradebook_students', 'gradebook_assignments', 'gradebook_grades',
  'gradebook_rubrics', 'assignments', 'assignment_submissions', 'app_metadata'
];

/**
 * Metadata that only makes sense on the device that wrote it. Never exported, and kept as-is
 * on the restoring device (a FileSystemFileHandle serializes to `{}`, and a copied device_id
 * would make two devices indistinguishable to sync).
 */
export const DEVICE_BOUND_METADATA = new Set([
  'autosync_file_handle', 'device_id', 'is_persistent', 'schema_version',
  'snooze_backup_until', 'sync_config', 'storage_warning_dismissed'
]);

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
 * @returns {{ snapshot: object, counts: Record<string, number>, exportedAt: string|null }}
 * @throws {BackupError} with a message suitable for showing to the user
 */
export function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (_) {
    throw new BackupError('This file is not valid JSON.');
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
  return { snapshot, counts, exportedAt: snapshot.exported_at || null };
}

export function stripDeviceMetadata(rows = []) {
  return rows.filter(r => r && !DEVICE_BOUND_METADATA.has(r.key));
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
