import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import JSZip from 'jszip';
import { StorageManager, isTemporaryProfileQuota, TEMPORARY_PROFILE_QUOTA_BYTES } from '../src/core/storage.js';
import { SyncManager } from '../src/core/sync.js';
import { parseBackup, BackupError, DEVICE_BOUND_METADATA } from '../src/core/backup.js';
import { expandFiles, ZIP_LIMITS } from '../src/core/envelope-router.js';

describe('Phase 21: Ephemeral / guest profile detection (rev-3 §3.2)', () => {
  it('flags quotas under 120 MB as temporary profiles', () => {
    expect(TEMPORARY_PROFILE_QUOTA_BYTES).toBe(120 * 1024 * 1024);
    expect(isTemporaryProfileQuota({ quota: 100 * 1024 * 1024 })).toBe(true);
    expect(isTemporaryProfileQuota({ quota: 10 * 1024 * 1024 * 1024 })).toBe(false);
    expect(isTemporaryProfileQuota({ quota: 0 })).toBe(false);
    expect(isTemporaryProfileQuota(null)).toBe(false);
  });
});

describe('Phase 21: Backup validation & safe restore (rev-3 §3.5)', () => {
  it('rejects non-JSON, foreign JSON and malformed tables with a readable error', () => {
    expect(() => parseBackup('not json')).toThrow(BackupError);
    expect(() => parseBackup('{"hello":"world"}')).toThrow(/not a KennisBoost backup/);
    expect(() => parseBackup(JSON.stringify({ version: 2, data: { flashcards: [{ title: 'no id' }] } }))).toThrow(BackupError);
    expect(() => parseBackup(JSON.stringify({ version: 2, data: { flashcards: 'oops' } }))).toThrow(BackupError);
    expect(() => parseBackup(JSON.stringify({ version: 2, data: { flashcards: [{ id: 'a' }, { id: 'a' }] } }))).toThrow(/duplicate/);
    expect(() => parseBackup(JSON.stringify({ version: 2, data: {}, blobs: [{ id: 'm', mime_type: 'text/html', data: 'PGI+' }] }))).toThrow(BackupError);
  });

  it('accepts v1 backups and reports record counts', () => {
    const { counts } = parseBackup(JSON.stringify({ version: 1, data: { flashcards: [{ id: 'd1', title: 'x' }], gradebook_grades: [{ student_id: 's', assignment_id: 'a' }] } }));
    expect(counts.flashcards).toBe(1);
    expect(counts.gradebook_grades).toBe(1);
  });

  it('exports no device-bound metadata and keeps this device\'s own on restore', async () => {
    const sm = new StorageManager();
    await sm.init();
    await sm.table('flashcards').put({ id: 'deck-1', title: 'Deck' });
    await sm.setMetadata('autosync_file_handle', { fake: 'handle' });
    await sm.setMetadata('teacher_submission_keypair', { publicJwk: { x: 1 } });
    const deviceId = await sm.getMetadata('device_id');

    const snapshot = await sm.dumpMasterSnapshot();
    const keys = snapshot.data.app_metadata.map(r => r.key);
    for (const k of DEVICE_BOUND_METADATA) expect(keys).not.toContain(k);
    expect(keys).toContain('teacher_submission_keypair');

    // Simulate a backup from another device that (wrongly) carries device metadata
    snapshot.data.app_metadata.push({ key: 'device_id', value: 'other-device' }, { key: 'autosync_file_handle', value: {} });
    await sm.table('flashcards').put({ id: 'deck-2', title: 'Made after backup' });
    await sm.restoreMasterSnapshot(snapshot);

    expect(await sm.getMetadata('device_id')).toBe(deviceId);
    expect(await sm.getMetadata('autosync_file_handle')).toEqual({ fake: 'handle' });
    expect((await sm.table('flashcards').toArray()).map(d => d.id)).toEqual(['deck-1']);
  });

  it('leaves the database untouched when the backup is invalid', async () => {
    const sm = new StorageManager();
    await sm.init();
    await sm.table('timelines').put({ id: 't-keep', title: 'Keep me' });
    await expect(sm.restoreMasterSnapshot({ version: 2, data: { timelines: [{ title: 'no id' }] } })).rejects.toThrow(BackupError);
    expect(await sm.table('timelines').get('t-keep')).toBeTruthy();
  });

  it('round-trips media blobs', async () => {
    const sm = new StorageManager();
    await sm.init();
    // fake-indexeddb can't structured-clone jsdom Blobs, so exercise the in-memory store here
    sm.ephemeralMode = true;
    const uri = await sm.saveBinaryAsset('media-1', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/webp' }), { preferIndexedDb: true });
    const snapshot = await sm.dumpMasterSnapshot();
    expect(snapshot.blobs.find(b => b.id === 'media-1')).toMatchObject({ mime_type: 'image/webp', data: 'AQIDBA==' });
    await sm.table('binary_blobs').clear();
    await sm.restoreMasterSnapshot(snapshot);
    const blob = await sm.getBinaryBlob(uri);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });
});

describe('Phase 21: Auto-sync robustness (rev-3 §3.4)', () => {
  it('ignores its own bookkeeping writes (no endless re-sync loop)', () => {
    expect(SyncManager.isBookkeepingChange({ tableName: 'app_metadata', key: 'last_manual_export_timestamp' })).toBe(true);
    expect(SyncManager.isBookkeepingChange({ tableName: 'app_metadata', key: 'device_id' })).toBe(true);
    expect(SyncManager.isBookkeepingChange({ tableName: 'outbox', key: 1 })).toBe(true);
    expect(SyncManager.isBookkeepingChange({ tableName: 'flashcards', key: 'd1' })).toBe(false);
    expect(SyncManager.isBookkeepingChange({ tableName: 'app_metadata', key: 'teacher_submission_keypair' })).toBe(false);
  });

  it('discards file handles that were restored from JSON', () => {
    expect(SyncManager.isUsableHandle({})).toBe(false);
    expect(SyncManager.isUsableHandle({ createWritable: () => {} })).toBe(true);
  });

  it('queues a second write when data changes during an in-flight write', async () => {
    let release;
    const writes = [];
    const handle = {
      queryPermission: async () => 'granted',
      createWritable: async () => ({
        write: async (s) => { writes.push(s); await new Promise(r => { release = r; }); },
        close: async () => {}
      })
    };
    const meta = new Map();
    const fakeStorage = {
      onMutation: () => {},
      getMetadata: async (k) => meta.get(k) ?? null,
      setMetadata: async (k, v) => { meta.set(k, v); },
      dumpMasterSnapshot: async () => ({ n: writes.length })
    };
    const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5)); };
    const sync = new SyncManager(fakeStorage);
    sync.fileHandle = handle;
    sync.debounceDelayMs = 0;
    const first = sync.executeSync();
    await until(() => writes.length === 1); // backups are encrypted first, so the write lands a bit later
    expect(await sync.executeSync()).toBe(false); // busy → queued, not dropped
    expect(sync.pendingSync).toBe(true);
    const releaseFirst = release;
    releaseFirst();
    await first;
    await until(() => writes.length === 2);
    release();
    expect(writes.length).toBe(2);
  });
});

describe('Phase 21: Inbox archive limits', () => {
  it('refuses archives with too many files', async () => {
    const zip = new JSZip();
    for (let i = 0; i <= ZIP_LIMITS.maxEntries; i++) zip.file(`s${i}.kbsub`, 'x');
    const data = await zip.generateAsync({ type: 'arraybuffer' });
    await expect(expandFiles([{ name: 'class.zip', data }])).rejects.toThrow('ZIP_TOO_MANY_FILES');
  });

  it('refuses zip files nested too deeply', async () => {
    let inner = await new JSZip().file('a.kbsub', 'x').generateAsync({ type: 'uint8array' });
    for (let i = 0; i < ZIP_LIMITS.maxDepth; i++) {
      inner = await new JSZip().file(`n${i}.zip`, inner).generateAsync({ type: 'uint8array' });
    }
    await expect(expandFiles([{ name: 'deep.zip', data: inner.buffer }])).rejects.toThrow('ZIP_TOO_DEEP');
  });

  it('still unpacks normal LMS bulk downloads', async () => {
    const zip = new JSZip();
    zip.file('Emma_123_submission.kbsub', 'KBSUB1.abc');
    zip.file('__MACOSX/._junk', 'x');
    const data = await zip.generateAsync({ type: 'arraybuffer' });
    const out = await expandFiles([{ name: 'bulk.zip', data }]);
    expect(out).toEqual([{ source: 'Emma_123_submission.kbsub', text: 'KBSUB1.abc' }]);
  });
});
