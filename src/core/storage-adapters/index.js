/**
 * Backup locations - KB-CORE-009
 *
 * Where encrypted backups (keyvault.js, format v3) are written. Every adapter stores opaque
 * ciphertext, so the school's cloud provides durability and domain ownership without being able
 * to read class data.
 *
 * Adapter interface:
 *   id, label
 *   rotates                      → true if the location keeps dated copies (folders, cloud)
 *   access({ interactive })      → 'granted' | 'prompt' | 'denied'; interactive may open a
 *                                  permission prompt or sign-in popup, so only call it from a click
 *   put(name, text) / get(name) → text | null / list() → [{ name, modified }] / delete(name)
 *   toConfig()                   → structured-cloneable config, stored as `backup_target`
 */
import { FsaFolderAdapter, FsaFileAdapter } from './fsa.js';
import { GoogleDriveAdapter } from './gdrive.js';
import { OneDriveAdapter } from './onedrive.js';

export const BACKUP_TARGET_METADATA = 'backup_target';

export const BACKUP_PREFIX = 'kennisboost-backup-';
export const LATEST_BACKUP_NAME = `${BACKUP_PREFIX}latest.json`;
export const ROTATION = Object.freeze({ daily: 7, weekly: 8 });

const pad = (n) => String(n).padStart(2, '0');

/** ISO-8601 week number, e.g. 2026-W42 (sorts lexicographically) */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${pad(week)}`;
}

export function backupNamesFor(now) {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return {
    latest: LATEST_BACKUP_NAME,
    daily: `${BACKUP_PREFIX}daily-${day}.json`,
    weekly: `${BACKUP_PREFIX}weekly-${isoWeek(now)}.json`
  };
}

/**
 * Which files to write and delete for a backup at `now`. `latest` is always rewritten; the first
 * backup of each day and week also becomes that day's/week's copy and is never overwritten, so a
 * bad change (or a corrupt write) can't replace every good copy.
 * @param {string[]} existing - file names already in the location
 * @returns {{ write: string[], remove: string[] }}
 */
export function planRotation(existing, now, policy = ROTATION) {
  const names = backupNamesFor(now);
  const have = new Set(existing);
  const write = [];
  if (!have.has(names.daily)) write.push(names.daily);
  if (!have.has(names.weekly)) write.push(names.weekly);
  write.push(names.latest);

  const keepNewest = (kind, n, extra) => {
    const all = [...new Set([...existing.filter(f => f.startsWith(`${BACKUP_PREFIX}${kind}-`)), extra])].sort().reverse();
    return all.slice(n);
  };
  const remove = [...keepNewest('daily', policy.daily, names.daily), ...keepNewest('weekly', policy.weekly, names.weekly)];
  return { write, remove };
}

/** Write one backup to an adapter, applying rotation where the location supports it */
export async function writeRotatedBackup(adapter, text, now = new Date()) {
  if (!adapter.rotates) {
    await adapter.put(LATEST_BACKUP_NAME, text);
    return { write: [LATEST_BACKUP_NAME], remove: [] };
  }
  const existing = (await adapter.list()).map(f => f.name);
  const plan = planRotation(existing, now);
  for (const name of plan.write) await adapter.put(name, text);
  for (const name of plan.remove) await adapter.delete(name);
  return plan;
}

/** Backups in a location, newest first, with a friendly label */
export async function listBackups(adapter) {
  if (!adapter.rotates) return [{ name: LATEST_BACKUP_NAME, modified: null, kind: 'Latest' }];
  const files = (await adapter.list()).filter(f => f.name.startsWith(BACKUP_PREFIX) && f.name.endsWith('.json'));
  const KINDS = ['Latest', 'Daily', 'Weekly', 'Backup'];
  const kindOf = (n) => n === LATEST_BACKUP_NAME ? 'Latest' : n.includes('-daily-') ? 'Daily' : n.includes('-weekly-') ? 'Weekly' : 'Backup';
  // Latest, then daily copies, then weekly copies, each newest first
  return files
    .map(f => ({ ...f, kind: kindOf(f.name) }))
    .sort((a, b) => (KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)) || b.name.localeCompare(a.name));
}

/** exported_at of a backup file; readable without decrypting (v3 keeps it in the envelope) */
export function backupExportedAt(text) {
  try {
    return JSON.parse(text)?.exported_at || null;
  } catch (_) {
    return null;
  }
}

/**
 * True when a location's latest backup may hold work this browser doesn't have: it is newer than
 * this browser's last backup, or its date can't be read. Used before overwriting it.
 */
export function isNewerThanLocal(latestText, lastLocalBackupMs) {
  if (!latestText) return false;
  const theirs = Date.parse(backupExportedAt(latestText) || '');
  return !Number.isFinite(theirs) || theirs > (Number(lastLocalBackupMs) || 0);
}

/** Cloud providers the deployment has enabled (window.KB_CONFIG.cloud, see config.example.js) */
export function cloudConfig() {
  const cfg = (typeof window !== 'undefined' && window.KB_CONFIG && window.KB_CONFIG.cloud) || {};
  return {
    google: cfg.google?.clientId ? cfg.google : null,
    microsoft: cfg.microsoft?.clientId ? cfg.microsoft : null
  };
}

export function supportsFolderAccess() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Rebuild an adapter from its stored `backup_target` config */
export function createAdapter(config, store, { cloud = cloudConfig() } = {}) {
  if (!config?.type) return null;
  switch (config.type) {
    case 'fsa-folder': return config.handle ? new FsaFolderAdapter(config.handle) : null;
    case 'fsa-file': return config.handle ? new FsaFileAdapter(config.handle) : null;
    case 'gdrive': return cloud.google ? new GoogleDriveAdapter({ ...cloud.google, ...config }, store) : null;
    case 'onedrive': return cloud.microsoft ? new OneDriveAdapter({ ...cloud.microsoft, ...config }, store) : null;
    default: return null;
  }
}

export { FsaFolderAdapter, FsaFileAdapter, GoogleDriveAdapter, OneDriveAdapter };
