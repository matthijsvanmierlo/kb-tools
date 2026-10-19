import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'fs';
import path from 'path';
import {
  isoWeek, backupNamesFor, planRotation, writeRotatedBackup, listBackups, createAdapter,
  isNewerThanLocal, LATEST_BACKUP_NAME, ROTATION, FsaFolderAdapter, FsaFileAdapter
} from '../src/core/storage-adapters/index.js';
import { GoogleDriveAdapter, GDRIVE_TOKEN_METADATA } from '../src/core/storage-adapters/gdrive.js';
import { OneDriveAdapter, ONEDRIVE_TOKEN_METADATA } from '../src/core/storage-adapters/onedrive.js';
import { pkceChallenge, parseCallbackParams, redirectUri, OAUTH_CHANNEL } from '../src/core/storage-adapters/oauth.js';
import { SyncManager } from '../src/core/sync.js';
import { KeyVault } from '../src/core/keyvault.js';
import { DEVICE_BOUND_METADATA } from '../src/core/backup.js';
import { buildCsp, cloudOriginsFromEnv, extraConnectOrigins } from '../scripts/csp.mjs';

/** Metadata store without structured cloning, so fake handles with methods survive */
function plainStore(extra = {}) {
  const map = new Map();
  return {
    map,
    async getMetadata(k) { return map.has(k) ? map.get(k) : null; },
    async setMetadata(k, v) { map.set(k, v); },
    ...extra
  };
}

/** Any adapter backed by a Map */
class MemoryAdapter {
  constructor() { this.files = new Map(); this.rotates = true; this.label = 'Memory'; this.state = 'granted'; }
  async access() { return this.state; }
  async put(n, t) { this.files.set(n, t); }
  async get(n) { return this.files.get(n) ?? null; }
  async list() { return [...this.files.keys()].map(name => ({ name, modified: null })); }
  async delete(n) { this.files.delete(n); }
  toConfig() { return { type: 'memory' }; }
}

/** Minimal FileSystemDirectoryHandle */
function fakeDirectory(name = 'Backups') {
  const files = new Map();
  const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
  const fileHandle = (fname) => ({
    kind: 'file',
    name: fname,
    async getFile() { if (!files.has(fname)) throw notFound(); return { text: async () => files.get(fname), lastModified: 0 }; },
    async createWritable() {
      let buf = '';
      return { write: async (t) => { buf += t; }, close: async () => { files.set(fname, buf); }, abort: async () => {} };
    }
  });
  return {
    name,
    files,
    kind: 'directory',
    permission: 'granted',
    async queryPermission() { return this.permission; },
    async requestPermission() { this.permission = 'granted'; return 'granted'; },
    async getFileHandle(fname, { create = false } = {}) {
      if (!files.has(fname) && !create) throw notFound();
      return fileHandle(fname);
    },
    async removeEntry(fname) { if (!files.delete(fname)) throw notFound(); },
    async *entries() { for (const f of files.keys()) yield [f, fileHandle(f)]; }
  };
}

const jsonResponse = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

describe('Phase 27: Backup rotation', () => {
  it('numbers ISO weeks correctly across year boundaries', () => {
    expect(isoWeek(new Date(2026, 0, 1))).toBe('2026-W01');
    expect(isoWeek(new Date(2024, 11, 30))).toBe('2025-W01');
    expect(isoWeek(new Date(2027, 0, 1))).toBe('2026-W53');
    expect(isoWeek(new Date(2026, 9, 18))).toBe('2026-W42');
  });

  it('writes the day and week copy only on the first backup of each, and latest every time', () => {
    const now = new Date(2026, 9, 18, 9);
    const names = backupNamesFor(now);
    expect(planRotation([], now).write).toEqual([names.daily, names.weekly, LATEST_BACKUP_NAME]);
    expect(planRotation([names.daily, names.weekly, LATEST_BACKUP_NAME], now).write).toEqual([LATEST_BACKUP_NAME]);
  });

  it('keeps 7 daily and 8 weekly copies over two months of daily use', async () => {
    const adapter = new MemoryAdapter();
    for (let d = 0; d < 60; d++) {
      await writeRotatedBackup(adapter, `backup-${d}`, new Date(2026, 7, 1 + d, 10));
      await writeRotatedBackup(adapter, `backup-${d}-later`, new Date(2026, 7, 1 + d, 15));
    }
    const names = [...adapter.files.keys()];
    expect(names.filter(n => n.includes('-daily-'))).toHaveLength(ROTATION.daily);
    expect(names.filter(n => n.includes('-weekly-'))).toHaveLength(ROTATION.weekly);
    expect(adapter.files.get(LATEST_BACKUP_NAME)).toBe('backup-59-later');
    // A day's copy is that day's first backup, so a bad afternoon edit can be undone
    expect(adapter.files.get(backupNamesFor(new Date(2026, 7, 60)).daily)).toBe('backup-59');
  });

  it('lists backups newest first with latest on top', async () => {
    const adapter = new MemoryAdapter();
    await writeRotatedBackup(adapter, 'a', new Date(2026, 9, 1));
    await writeRotatedBackup(adapter, 'b', new Date(2026, 9, 2));
    adapter.files.set('notes.txt', 'ignored');
    const list = await listBackups(adapter);
    expect(list[0]).toMatchObject({ name: LATEST_BACKUP_NAME, kind: 'Latest' });
    expect(list.map(b => b.kind)).toEqual(['Latest', 'Daily', 'Daily', 'Weekly']);
    expect(list[1].name).toContain('daily-2026-10-02');
  });

  it('detects when a location holds a backup newer than this browser\'s last one', () => {
    const file = JSON.stringify({ kennisboost_backup: 3, exported_at: '2026-10-18T10:00:00.000Z' });
    expect(isNewerThanLocal(file, Date.parse('2026-10-17T10:00:00Z'))).toBe(true);
    expect(isNewerThanLocal(file, null)).toBe(true);
    expect(isNewerThanLocal(file, Date.parse('2026-10-18T10:00:05Z'))).toBe(false);
    expect(isNewerThanLocal('garbage', Date.now())).toBe(true);
    expect(isNewerThanLocal(null, 0)).toBe(false);
  });
});

describe('Phase 27: Folder locations (File System Access)', () => {
  it('reads, writes, lists and deletes in a picked folder', async () => {
    const dir = fakeDirectory();
    const adapter = new FsaFolderAdapter(dir);
    expect(adapter.label).toContain('Backups');
    await adapter.put('a.json', 'one');
    await adapter.put('a.json', 'two');
    expect(await adapter.get('a.json')).toBe('two');
    expect(await adapter.get('missing.json')).toBeNull();
    expect((await adapter.list()).map(f => f.name)).toEqual(['a.json']);
    await adapter.delete('a.json');
    await adapter.delete('a.json');
    expect(dir.files.size).toBe(0);
  });

  it('reports a lapsed folder permission and only re-asks when interactive', async () => {
    const dir = fakeDirectory();
    dir.permission = 'prompt';
    const adapter = new FsaFolderAdapter(dir);
    expect(await adapter.access()).toBe('prompt');
    expect(await adapter.access({ interactive: true })).toBe('granted');
  });

  it('rebuilds adapters from stored config and hides unconfigured cloud providers', () => {
    const store = plainStore();
    expect(createAdapter({ type: 'fsa-folder', handle: fakeDirectory() }, store)).toBeInstanceOf(FsaFolderAdapter);
    expect(createAdapter({ type: 'fsa-file', handle: {} }, store)).toBeInstanceOf(FsaFileAdapter);
    expect(createAdapter({ type: 'gdrive' }, store, { cloud: { google: null } })).toBeNull();
    expect(createAdapter({ type: 'gdrive' }, store, { cloud: { google: { clientId: 'x' } } })).toBeInstanceOf(GoogleDriveAdapter);
    expect(createAdapter({ type: 'onedrive' }, store, { cloud: { microsoft: { clientId: 'y' } } })).toBeInstanceOf(OneDriveAdapter);
    expect(createAdapter(null, store)).toBeNull();
  });

  it('never exports the location or cloud tokens in a backup', () => {
    for (const k of ['backup_target', GDRIVE_TOKEN_METADATA, ONEDRIVE_TOKEN_METADATA]) {
      expect(DEVICE_BOUND_METADATA.has(k)).toBe(true);
    }
  });
});

describe('Phase 27: OAuth helpers', () => {
  it('derives the RFC 7636 PKCE challenge', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('builds the callback URL next to index.html and reads query + fragment parameters', () => {
    expect(redirectUri('https://kb.school.edu/tools/index.html?x=1#/home')).toBe('https://kb.school.edu/tools/oauth-callback.html');
    expect(parseCallbackParams('https://a/b?code=1&state=s#access_token=t')).toEqual({ code: '1', state: 's', access_token: 't' });
  });

  it('callback page hands the result to the app and scrubs it from the address bar', async () => {
    window.history.replaceState(null, '', '/oauth-callback.html?code=abc&state=xyz');
    document.body.innerHTML = '<p id="kb-oauth-status"></p>';
    const received = new Promise((resolve) => {
      const ch = new BroadcastChannel(OAUTH_CHANNEL);
      ch.onmessage = (e) => { ch.close(); resolve(e.data); };
    });
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    const src = fs.readFileSync(path.resolve('src/boot/oauth-callback.js'), 'utf8');
    new Function(src)();
    expect(await received).toEqual({ code: 'abc', state: 'xyz' });
    expect(window.location.search).toBe('');
    expect(document.getElementById('kb-oauth-status').textContent).toContain('Signed in');
    closeSpy.mockRestore();
  });

  it('callback page references only same-origin script (CSP)', () => {
    const html = fs.readFileSync(path.resolve('oauth-callback.html'), 'utf8');
    expect(html).toContain("script-src 'self'");
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    expect(html).toContain('src="src/boot/oauth-callback.js"');
  });
});

describe('Phase 27: Google Drive adapter', () => {
  /** In-memory Drive v3 subset: folders, multipart create, media update, download, delete */
  function fakeDrive() {
    const files = new Map();
    let n = 0;
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      const u = new URL(url);
      calls.push({ method: opts.method || 'GET', url: u, opts });
      if (opts.headers?.Authorization !== 'Bearer tok-1') return jsonResponse(401, {});
      const method = opts.method || 'GET';
      if (u.pathname === '/drive/v3/files' && method === 'GET') {
        const q = u.searchParams.get('q');
        const parent = q.match(/'([^']+)' in parents/)?.[1];
        const list = [...files.values()].filter(f => parent ? f.parent === parent : (q.includes('folder') && f.folder));
        return jsonResponse(200, { files: list.map(f => ({ id: f.id, name: f.name, modifiedTime: '2026-10-18T00:00:00Z' })) });
      }
      if (u.pathname === '/drive/v3/files' && method === 'POST') {
        const meta = JSON.parse(opts.body);
        const id = `id${++n}`;
        files.set(id, { id, name: meta.name, folder: true });
        return jsonResponse(200, { id });
      }
      if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
        const [, metaPart, contentPart] = opts.body.split(/--kb[^\r]*\r\n/);
        const meta = JSON.parse(metaPart.split('\r\n\r\n')[1]);
        const content = contentPart.split('\r\n\r\n')[1].replace(/\r\n$/, '');
        const id = `id${++n}`;
        files.set(id, { id, name: meta.name, parent: meta.parents[0], content });
        return jsonResponse(200, { id });
      }
      const id = decodeURIComponent(u.pathname.split('/').pop());
      if (u.pathname.startsWith('/upload/drive/v3/files/') && method === 'PATCH') {
        files.get(id).content = opts.body;
        return jsonResponse(200, { id });
      }
      if (method === 'GET' && u.searchParams.get('alt') === 'media') {
        return files.has(id) ? jsonResponse(200, files.get(id).content) : jsonResponse(404, {});
      }
      if (method === 'DELETE') return jsonResponse(files.delete(id) ? 204 : 404, {});
      return jsonResponse(400, {});
    };
    return { files, calls, fetchImpl };
  }

  let store;
  let drive;
  let popupUrls;
  const makeAdapter = () => new GoogleDriveAdapter({ clientId: 'gid', hostedDomain: 'school.edu' }, store, {
    fetchImpl: drive.fetchImpl,
    popup: async (url, state) => {
      popupUrls.push(new URL(url));
      return { access_token: 'tok-1', expires_in: '3599', scope: 'https://www.googleapis.com/auth/drive.file', state };
    }
  });

  beforeEach(() => {
    store = plainStore();
    drive = fakeDrive();
    popupUrls = [];
  });

  it('asks for the narrow drive.file scope with the school domain hint', async () => {
    const adapter = makeAdapter();
    expect(await adapter.access()).toBe('prompt');
    expect(await adapter.access({ interactive: true })).toBe('granted');
    const url = popupUrls[0];
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(url.searchParams.get('response_type')).toBe('token');
    expect(url.searchParams.get('hd')).toBe('school.edu');
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/oauth-callback\.html$/);
    expect(await adapter.access()).toBe('granted');
  });

  it('creates one backups folder, then creates or updates files in it', async () => {
    const adapter = makeAdapter();
    await adapter.access({ interactive: true });
    await adapter.put('kennisboost-backup-latest.json', '{"v":1}');
    await adapter.put('kennisboost-backup-latest.json', '{"v":2}');
    await adapter.put('kennisboost-backup-daily-2026-10-18.json', '{"v":2}');
    const folders = [...drive.files.values()].filter(f => f.folder);
    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe('KennisBoost Backups');
    expect((await adapter.list()).map(f => f.name).sort()).toEqual(['kennisboost-backup-daily-2026-10-18.json', 'kennisboost-backup-latest.json']);
    expect(await adapter.get('kennisboost-backup-latest.json')).toBe('{"v":2}');
    expect(drive.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);

    // A second device finds the same folder instead of creating another
    const other = makeAdapter();
    expect(await other.get('kennisboost-backup-latest.json')).toBe('{"v":2}');

    await adapter.delete('kennisboost-backup-daily-2026-10-18.json');
    expect(await adapter.get('kennisboost-backup-daily-2026-10-18.json')).toBeNull();
  });

  it('turns an expired or revoked token into a reconnect request', async () => {
    const adapter = makeAdapter();
    await store.setMetadata(GDRIVE_TOKEN_METADATA, { access_token: 'revoked', expires_at: Date.now() + 60000 });
    await expect(adapter.list()).rejects.toMatchObject({ name: 'CloudAuthError', code: 'SIGN_IN_REQUIRED' });
    expect(await store.getMetadata(GDRIVE_TOKEN_METADATA)).toBeNull();
    expect(await adapter.access()).toBe('prompt');
  });
});

describe('Phase 27: OneDrive adapter', () => {
  function fakeGraph() {
    const files = new Map();
    const tokenRequests = [];
    let issued = 0;
    const fetchImpl = async (url, opts = {}) => {
      const u = new URL(url);
      if (u.hostname === 'login.microsoftonline.com') {
        const form = Object.fromEntries(new URLSearchParams(opts.body));
        tokenRequests.push({ url: u, form });
        if (form.grant_type === 'refresh_token' && form.refresh_token !== 'rt-1') return jsonResponse(400, { error: 'invalid_grant' });
        issued++;
        return jsonResponse(200, { access_token: `at-${issued}`, refresh_token: 'rt-1', expires_in: 3600 });
      }
      if (!/^Bearer at-\d+$/.test(opts.headers?.Authorization || '')) return jsonResponse(401, {});
      const method = opts.method || 'GET';
      const base = '/v1.0/me/drive/special/approot';
      if (u.pathname === `${base}/children`) {
        return jsonResponse(200, { value: [...files.keys()].map(name => ({ name, file: {}, lastModifiedDateTime: '2026-10-18T00:00:00Z' })) });
      }
      const m = decodeURIComponent(u.pathname).match(/approot:\/(.+?):(\/content)?$/);
      const name = m[1];
      if (method === 'PUT') { files.set(name, opts.body); return jsonResponse(201, {}); }
      if (method === 'GET') return files.has(name) ? jsonResponse(200, files.get(name)) : jsonResponse(404, {});
      if (method === 'DELETE') return jsonResponse(files.delete(name) ? 204 : 404, {});
      return jsonResponse(400, {});
    };
    return { files, tokenRequests, fetchImpl };
  }

  let store;
  let graph;
  let authorizeUrl;
  const makeAdapter = () => new OneDriveAdapter({ clientId: 'mid', tenant: 'contoso.edu' }, store, {
    fetchImpl: graph.fetchImpl,
    popup: async (url, state) => {
      authorizeUrl = new URL(url);
      return { code: 'auth-code', state };
    }
  });

  beforeEach(() => {
    store = plainStore();
    graph = fakeGraph();
  });

  it('signs in with PKCE (no client secret) for the app folder only', async () => {
    const adapter = makeAdapter();
    await adapter.access({ interactive: true });
    expect(authorizeUrl.pathname).toBe('/contoso.edu/oauth2/v2.0/authorize');
    expect(authorizeUrl.searchParams.get('scope')).toBe('Files.ReadWrite.AppFolder offline_access');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const exchange = graph.tokenRequests[0].form;
    expect(exchange.grant_type).toBe('authorization_code');
    expect(exchange.client_secret).toBeUndefined();
    expect(await pkceChallenge(exchange.code_verifier)).toBe(authorizeUrl.searchParams.get('code_challenge'));
  });

  it('stores, lists, reads and deletes backups in the app folder', async () => {
    const adapter = makeAdapter();
    await adapter.access({ interactive: true });
    await adapter.put('kennisboost-backup-latest.json', 'cipher');
    expect((await adapter.list()).map(f => f.name)).toEqual(['kennisboost-backup-latest.json']);
    expect(await adapter.get('kennisboost-backup-latest.json')).toBe('cipher');
    await adapter.delete('kennisboost-backup-latest.json');
    expect(await adapter.get('kennisboost-backup-latest.json')).toBeNull();
  });

  it('refreshes an expired token silently, and asks to reconnect when the refresh token is gone', async () => {
    const adapter = makeAdapter();
    await store.setMetadata(ONEDRIVE_TOKEN_METADATA, { access_token: 'old', expires_at: Date.now() - 1000, refresh_token: 'rt-1' });
    expect(await adapter.access()).toBe('granted');
    expect(graph.tokenRequests.at(-1).form.grant_type).toBe('refresh_token');

    await store.setMetadata(ONEDRIVE_TOKEN_METADATA, { access_token: 'old', expires_at: Date.now() - 1000, refresh_token: 'stale' });
    expect(await adapter.access()).toBe('prompt');
    expect(await store.getMetadata(ONEDRIVE_TOKEN_METADATA)).toBeNull();
  });
});

describe('Phase 27: Automatic backups to a location', () => {
  function syncWith(adapter) {
    const store = plainStore({ onMutation: () => {}, dumpMasterSnapshot: async () => ({ version: 2, exported_at: new Date().toISOString(), data: { gradebook_students: [{ id: 's', full_name: 'Ada Lovelace' }] } }) });
    const sync = new SyncManager(store);
    return { sync, store, adapter };
  }

  it('writes encrypted, rotated backups to the chosen location', async () => {
    const { sync, store, adapter } = syncWith(new MemoryAdapter());
    expect(await sync.setBackupTarget(adapter)).toBe(true);
    expect(await store.getMetadata('backup_target')).toEqual({ type: 'memory' });
    const names = [...adapter.files.keys()];
    expect(names).toContain(LATEST_BACKUP_NAME);
    expect(names.some(n => n.includes('-daily-'))).toBe(true);
    const latest = adapter.files.get(LATEST_BACKUP_NAME);
    expect(JSON.parse(latest).kennisboost_backup).toBe(3);
    expect(latest).not.toContain('Ada Lovelace');
    expect((await sync.openBackupFile(latest)).counts.gradebook_students).toBe(1);
    expect(sync.hasAutomaticBackup()).toBe(true);
    expect(await KeyVault.getPendingRecoveryCode(store)).toBeTruthy();
  });

  it('pauses (without writing) while access needs a click, and on a cloud sign-in error', async () => {
    const { sync, adapter } = syncWith(new MemoryAdapter());
    sync.adapter = adapter;
    adapter.state = 'prompt';
    expect(await sync.executeSync()).toBe(false);
    expect(adapter.files.size).toBe(0);

    adapter.state = 'granted';
    adapter.put = async () => { throw Object.assign(new Error('Reconnect'), { name: 'CloudAuthError', code: 'SIGN_IN_REQUIRED' }); };
    expect(await sync.executeSync()).toBe(false);
  });

  it('restores the location at boot and stops when cleared', async () => {
    const dir = fakeDirectory();
    const { sync, store } = syncWith(null);
    await store.setMetadata('backup_target', { type: 'fsa-folder', handle: dir });
    await sync.init();
    expect(sync.activeAdapter()).toBeInstanceOf(FsaFolderAdapter);
    expect(await sync.executeSync()).toBe(true);
    expect(dir.files.has(LATEST_BACKUP_NAME)).toBe(true);
    await sync.clearBackupTarget();
    expect(sync.hasAutomaticBackup()).toBe(false);
  });
});

describe('Phase 27: CSP for cloud providers', () => {
  it('allows only the enabled providers\' API origins', () => {
    expect(cloudOriginsFromEnv({})).toEqual([]);
    expect(cloudOriginsFromEnv({ KB_CLOUD_PROVIDERS: 'google' })).toEqual(['https://www.googleapis.com']);
    expect(cloudOriginsFromEnv({ KB_CLOUD_PROVIDERS: 'microsoft' })).toContain('https://graph.microsoft.com');
    expect(() => cloudOriginsFromEnv({ KB_CLOUD_PROVIDERS: 'dropbox' })).toThrow(/Unknown/);
    const origins = extraConnectOrigins({ KB_RELAY_ORIGIN: 'https://relay.school.edu/x', KB_CLOUD_PROVIDERS: 'google,microsoft' });
    expect(origins).toContain('https://relay.school.edu');
    const csp = buildCsp({ importMapHash: "'sha256-x'", relayOrigins: origins });
    expect(csp).toMatch(/connect-src 'self' data: https:\/\/relay\.school\.edu https:\/\/www\.googleapis\.com/);
  });
});
