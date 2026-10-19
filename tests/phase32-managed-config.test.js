import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { parseManagedConfig, loadManagedConfig, getPolicy, setManagedConfigForTests, DEFAULT_POLICY } from '../src/core/managed-config.js';
import { configOrigins, extraConnectOrigins } from '../scripts/csp.mjs';
import { computeDataSafety } from '../src/components/data-safety.js';
import { DraftRoamer } from '../src/modules/assignments/draft-roaming.js';
import { StorageManager, storage } from '../src/core/storage.js';
import { getTransport } from '../src/core/transport.js';
import { SyncManager } from '../src/core/sync.js';
import { KeyVault, RECOVERY_ESCROW } from '../src/core/keyvault.js';
import { buildStudentRecord, studentIdsIn, recordToCsvFiles, buildRecordsZip } from '../src/core/records-export.js';
import { createTermArchive, openTermArchive, openTermArchiveAsSchool } from '../src/core/records-archive.js';
import { generateEscrowKeys } from '../scripts/escrow-keygen.mjs';
import { loadServiceWorker } from './helpers/load-sw.js';
import { unlockCodeForBackup, exportArchive } from '../scripts/escrow-recover.mjs';

let n = 0;
async function device() {
  const sm = new StorageManager({ dbName: `kb-p5-${Date.now()}-${n++}` });
  await sm.init();
  return sm;
}

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

afterEach(() => {
  setManagedConfigForTests(null);
  window.KB_CONFIG = undefined;
  try { localStorage.clear(); } catch (_) {}
});

describe('Phase 32: Managed configuration', () => {
  it('validates, applies policy defaults and rejects a bad file as a whole', () => {
    const ok = parseManagedConfig({ relay: { baseUrl: 'https://kb.school.edu' }, policy: { allowCoTeaching: false } });
    expect(ok.error).toBeNull();
    expect(ok.policy).toEqual({ ...DEFAULT_POLICY, allowCoTeaching: false });
    const bad = parseManagedConfig({ relay: { baseUrl: 'not a url' }, policy: { allowCoTeaching: false } });
    expect(bad.error).toMatch(/relay\.baseUrl/);
    expect(bad.policy.allowCoTeaching).toBe(true);
    expect(parseManagedConfig({ policy: { allowedBackupLocations: ['dropbox'] } }).error).toBeTruthy();
    expect(parseManagedConfig({ escrow: { adminPublicKey: { kty: 'EC', crv: 'P-256', x: 'short', y: 'short' } } }).error).toMatch(/escrow/);
  });

  it('loads config.json over config.js and exposes it to existing readers', async () => {
    window.KB_CONFIG = { cloud: { google: { clientId: 'from-config-js.apps.googleusercontent.com' } } };
    const cfg = await loadManagedConfig({ fetchImpl: async () => response(200, { relay: { baseUrl: 'https://kb.school.edu' }, policy: { backupReminderHours: 24 } }) });
    expect(cfg.source).toBe('config.json');
    expect(getPolicy().backupReminderHours).toBe(24);
    expect(window.KB_CONFIG.baseUrl).toBe('https://kb.school.edu');
    expect(window.KB_CONFIG.cloud.google.clientId).toContain('from-config-js');
  });

  it('ignores an invalid file, keeps the last good settings offline, and forgets them when removed', async () => {
    const bad = await loadManagedConfig({ fetchImpl: async () => response(200, { policy: { backupReminderHours: -1 } }) });
    expect(bad.error).toBeTruthy();
    expect(window.KB_CONFIG).toBeNull();

    await loadManagedConfig({ fetchImpl: async () => response(200, { policy: { allowDirectTransfer: false } }) });
    const offline = await loadManagedConfig({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    expect(offline.policy.allowDirectTransfer).toBe(false);

    await loadManagedConfig({ fetchImpl: async () => response(404, {}) });
    const later = await loadManagedConfig({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    expect(later.policy.allowDirectTransfer).toBe(true);
  });

  it('a teacher\'s own relay connection wins over the managed URL, which has no token', async () => {
    window.KB_CONFIG = { baseUrl: 'https://kb.school.edu' };
    await storage.init();
    await storage.setMetadata('sync_config', null);
    expect((await getTransport({ forceReload: true })).constructor.kind).toBe('null');
    await storage.setMetadata('sync_config', { baseUrl: 'https://kb.school.edu', token: 'mine' });
    const t = await getTransport({ forceReload: true });
    expect(t.token).toBe('mine');
    await storage.setMetadata('sync_config', null);
  });

  it('turns policy off where it applies', () => {
    const relay = { relay: { drop_id: 'd1' } };
    expect(DraftRoamer.canRoam(relay, 'K7M2-QX9P')).toBe(true);
    setManagedConfigForTests({ policy: { studentDraftRoaming: false } });
    expect(DraftRoamer.canRoam(relay, 'K7M2-QX9P')).toBe(false);
  });

  it('never serves config.json from the service worker cache', () => {
    const { shouldBypassCache } = loadServiceWorker();
    expect(shouldBypassCache('https://kb.school.edu/config.json', 'https://kb.school.edu')).toBe(true);
    expect(shouldBypassCache('https://kb.school.edu/tools/config.json', 'https://kb.school.edu')).toBe(true);
    expect(shouldBypassCache('https://kb.school.edu/config.example.json', 'https://kb.school.edu')).toBe(false);
  });

  it('derives CSP connect-src from config.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cfg-'));
    const file = path.join(dir, 'config.json');
    expect(configOrigins(file)).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ relay: { baseUrl: 'https://kb.school.edu/relay' }, cloud: { google: { clientId: 'x' } } }));
    expect(configOrigins(file)).toEqual(['https://kb.school.edu', 'https://www.googleapis.com']);
    expect(extraConnectOrigins({ KB_CLOUD_PROVIDERS: 'microsoft' }, { configPath: file })).toEqual(expect.arrayContaining(['https://graph.microsoft.com', 'https://kb.school.edu']));
    fs.writeFileSync(file, '{oops');
    expect(() => configOrigins(file)).toThrow(/not valid JSON/);
  });
});

describe('Phase 32: Data safety status', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const good = {
    policy: DEFAULT_POLICY,
    ephemeral: false,
    lastBackupAt: now - 3600 * 1000,
    hasAutomaticBackup: true,
    backupLabel: 'Folder "Backups"',
    canAutoBackup: true,
    recoveryKitSaved: true,
    persistent: true,
    quotaRatio: 0.1,
    sync: { configured: false },
    escrow: { available: false },
    configError: null
  };
  const levelOf = (patch) => computeDataSafety({ ...good, ...patch }, now).level;

  it('is "ok" only when backups, kit and storage are all fine', () => {
    expect(levelOf({})).toBe('ok');
    expect(levelOf({ recoveryKitSaved: false })).toBe('attention');
    expect(levelOf({ persistent: false })).toBe('attention');
    expect(levelOf({ lastBackupAt: now - 100 * 3600 * 1000 })).toBe('attention');
  });

  it('flags real risks', () => {
    expect(levelOf({ lastBackupAt: null })).toBe('risk');
    expect(levelOf({ lastBackupAt: null, hasData: false })).toBe('attention');
    expect(levelOf({ ephemeral: true })).toBe('risk');
    expect(levelOf({ quotaRatio: 0.95 })).toBe('risk');
    expect(levelOf({ hasAutomaticBackup: false })).toBe('attention');
    expect(levelOf({ hasAutomaticBackup: false, policy: { ...DEFAULT_POLICY, requireAutomaticBackup: true } })).toBe('risk');
  });

  it('reports sync problems, escrow and broken school settings with a way to act', () => {
    const s = computeDataSafety({ ...good, sync: { configured: true, state: 'error', error: 'Connect to your school server to sync.' }, escrow: { available: true, registered: true, current: false, label: 'IT' }, configError: 'policy: bad' }, now);
    expect(s.level).toBe('attention');
    expect(s.items.find(i => i.id === 'sync').detail).toContain('school server');
    expect(s.items.find(i => i.id === 'escrow')).toMatchObject({ ok: false, action: { id: 'escrow' } });
    expect(s.items.find(i => i.id === 'config').detail).toContain('policy: bad');
  });
});

describe('Phase 32: School-assisted recovery', () => {
  it('needs both the school key and the teacher\'s passphrase', async () => {
    const school = await generateEscrowKeys();
    const laptop = await device();
    await laptop.table('flashcards').put({ id: 'd1', title: 'Biology' });
    await expect(KeyVault.setUpEscrow(laptop, school.publicJwk, 'short')).rejects.toMatchObject({ code: 'WEAK_PASSPHRASE' });
    await KeyVault.setUpEscrow(laptop, school.publicJwk, 'my long passphrase');
    expect((await KeyVault.escrowStatus(laptop, school.publicJwk)).current).toBe(true);
    const backup = await new SyncManager(laptop).buildBackupText();
    expect(JSON.parse(backup).escrow.envelope).toBeTruthy();

    // IT turns the backup into an unlock code; it does not reveal the recovery code
    const unlock = await unlockCodeForBackup(backup, school);
    expect(unlock).toMatch(/^KBESC1\./);
    const other = await generateEscrowKeys();
    await expect(unlockCodeForBackup(backup, other)).rejects.toThrow(/escrow key/);

    // New device, kit lost: unlock code + passphrase open the backup
    const fresh = await device();
    const sync = new SyncManager(fresh);
    await expect(sync.openBackupFile(backup, { escrow: { unlockCode: unlock, passphrase: 'wrong passphrase!' } })).rejects.toMatchObject({ code: 'WRONG_PASSPHRASE' });
    const opened = await sync.openBackupFile(backup, { escrow: { unlockCode: unlock, passphrase: 'my long passphrase' } });
    await sync.restoreOpenedBackup(opened);
    expect((await fresh.table('flashcards').get('d1')).title).toBe('Biology');
    // The teacher is shown the same recovery code again to save a new kit
    const code = await KeyVault.getPendingRecoveryCode(fresh);
    expect((await new SyncManager(await device()).openBackupFile(backup, { recoveryCode: code })).counts.flashcards).toBe(1);
  });

  it('asks for the passphrase again after the recovery code changes', async () => {
    const school = await generateEscrowKeys();
    const a = await device();
    await KeyVault.setUpEscrow(a, school.publicJwk, 'my long passphrase');
    await KeyVault.rotateRecoveryCode(a);
    expect(await KeyVault.escrowStatus(a, school.publicJwk)).toEqual({ registered: true, current: false });
    expect(JSON.parse(await new SyncManager(a).buildBackupText()).escrow).toBeUndefined();
    expect(await a.getMetadata(RECOVERY_ESCROW)).toBeTruthy();
  });
});

describe('Phase 32: Student records', () => {
  const data = {
    gradebook_courses: [{ id: 'c1', name: 'Biology', categories: [{ id: 'cat', name: 'Tests' }] }, { id: 'c2', name: 'History' }],
    gradebook_students: [
      { id: 'e1', course_id: 'c1', student_id: 'S1', full_name: 'Ada Lovelace', email: 'ada@school.edu', access_code: 'K7M2-QX9P' },
      { id: 'e2', course_id: 'c2', student_id: 's1', full_name: 'Ada Lovelace', email: 'ada@school.edu', access_code: 'AAAA-BBBB' },
      { id: 'e3', course_id: 'c1', student_id: 'S2', full_name: 'Grace Hopper' }
    ],
    gradebook_assignments: [{ id: 'g1', course_id: 'c1', title: 'Cells test', category_id: 'cat', max_score: 10, due_date: '2026-10-01' }, { id: 'g2', course_id: 'c2', title: 'Essay', max_score: 20 }],
    gradebook_grades: [
      { student_id: 'S1', assignment_id: 'g1', course_id: 'c1', raw_score: 8, status: 'graded', feedback: 'Good' },
      { student_id: 's1', assignment_id: 'g2', course_id: 'c2', raw_score: 15 },
      { student_id: 'S2', assignment_id: 'g1', course_id: 'c1', raw_score: 5 }
    ],
    assignments: [{ id: 'as1', class_id: 'c1', title: 'Quiz' }],
    assignment_submissions: [{ id: 'sub1', assignment_id: 'as1', student_id: 'S1', submitted_at: '2026-10-02T10:00:00Z', answers: { q1: 'mitochondria' }, auto: { earned: 3, possible: 4 }, identity: 'verified' }]
  };

  it('collects everything about one student across classes, without access codes', () => {
    const r = buildStudentRecord(data, 's1', { now: new Date('2026-10-18T00:00:00Z') });
    expect(r.student.classes.map(c => c.name)).toEqual(['Biology', 'History']);
    expect(r.student.emails).toEqual(['ada@school.edu']);
    expect(r.grades.map(g => [g.assignment, g.score])).toEqual([['Cells test', 8], ['Essay', 15]]);
    expect(r.grades[0].category).toBe('Tests');
    expect(r.submissions[0]).toMatchObject({ assignment: 'Quiz', answers: { q1: 'mitochondria' }, auto_score: { earned: 3, possible: 4 } });
    expect(JSON.stringify(r)).not.toContain('K7M2');
    expect(JSON.stringify(r)).not.toContain('Grace');
  });

  it('can be limited to one class and lists each student once', () => {
    const r = buildStudentRecord(data, 'S1', { courseIds: ['c2'] });
    expect(r.grades.map(g => g.assignment)).toEqual(['Essay']);
    expect(r.submissions).toEqual([]);
    expect(studentIdsIn(data)).toEqual(['S1', 'S2']);
    expect(studentIdsIn(data, ['c2'])).toEqual(['s1']);
  });

  it('packages JSON, CSV and a readme per student', async () => {
    const records = studentIdsIn(data).map(id => buildStudentRecord(data, id));
    expect(recordToCsvFiles(records[0])['grades.csv']).toContain('Cells test');
    const zip = await JSZip.loadAsync(await (await buildRecordsZip(records, { JSZip, school: 'Riverdale' })).arrayBuffer());
    const names = Object.keys(zip.files);
    expect(names).toEqual(expect.arrayContaining(['S1_Ada_Lovelace/record.json', 'S1_Ada_Lovelace/grades.csv', 'S2_Grace_Hopper/README.txt']));
    expect(await zip.file('S1_Ada_Lovelace/README.txt').async('string')).toContain('Riverdale');
  });
});

describe('Phase 32: Term archives', () => {
  it('the teacher can always open them; the school only when the policy says so', async () => {
    const school = await generateEscrowKeys();
    const a = await device();
    await a.table('gradebook_courses').put({ id: 'c1', name: 'Biology' });
    await a.table('gradebook_students').put({ id: 'e1', course_id: 'c1', student_id: 'S1', full_name: 'Ada Lovelace' });

    const privateOnly = await createTermArchive(a, { label: 'T1', teacherName: 'Ms J' });
    expect(privateOnly.readableBySchool).toBe(false);
    expect(privateOnly.text).not.toContain('Ada');
    expect((await openTermArchive(a, privateOnly.text)).data.gradebook_students[0].full_name).toBe('Ada Lovelace');
    await expect(openTermArchiveAsSchool(privateOnly.text, school.privateJwk)).rejects.toThrow('NOT_READABLE_BY_SCHOOL');
    await expect(openTermArchive(await device(), privateOnly.text)).rejects.toThrow('NOT_THIS_TEACHER');

    const shared = await createTermArchive(a, { label: 'T1', schoolPublicJwk: school.publicJwk });
    expect(shared.filename).toMatch(/^kennisboost-archive-teacher-T1-\d{4}-\d{2}-\d{2}\.kbarchive\.json$/);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-archive-'));
    const { students } = await exportArchive(shared.text, school, out);
    expect(students).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'S1', 'record.json'), 'utf8')).student.full_name).toBe('Ada Lovelace');
  });
});
