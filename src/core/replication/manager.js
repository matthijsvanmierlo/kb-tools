/**
 * ReplicationManager - keeps a teacher's devices (and co-teachers' shared classes) in sync.
 *
 * Channels come from KeyVault secrets, so they travel encrypted in backups and to linked devices:
 *   workspace            the teacher's own devices: relay workspace or backup location
 *   class_share:<id>     a class shared with co-teachers (relay only: two teachers don't share
 *                        a folder), plus class_key:<id>, the key students' work is encrypted to
 *
 * Without any channel, the outbox is simply pruned (a workspace starts from a snapshot anyway).
 */
import { storage as defaultStore } from '../storage.js';
import { KeyVault } from '../keyvault.js';
import { getTransport, setTransportConfig, RelayTransport } from '../transport.js';
import { sync as backupSync } from '../sync.js';
import { ReplicationEngine, importChannelKey, newChannelSecret, CONFLICTS_METADATA } from './engine.js';
import { LocationChannel, RelayChannel } from './channels.js';
import { answerOffer, openAnswer } from './link.js';

export const WORKSPACE_SECRET = 'workspace';
export const CLASS_SHARE_PREFIX = 'class_share:';
export const CLASS_KEY_PREFIX = 'class_key:';
const SNAPSHOT_EVERY_MS = 24 * 60 * 60 * 1000;
export const INVITE_VERSION = 1;

/** Vault secrets a linked device may receive through the personal channel */
const SHARED_SECRET_PREFIXES = [CLASS_SHARE_PREFIX, CLASS_KEY_PREFIX, 'retired_class_key:'];

export class ReplicationSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReplicationSetupError';
    this.code = code;
  }
}

async function defaultGetRelay() {
  const t = await getTransport();
  return t instanceof RelayTransport && t.baseUrl && t.token ? t : null;
}

const sameServer = (a, b) => String(a || '').replace(/\/+$/, '').replace(/\/api\/v1$/, '') === String(b || '').replace(/\/+$/, '').replace(/\/api\/v1$/, '');

export class ReplicationManager {
  /**
   * @param {object} [deps] - injectable for tests
   * @param {object} [deps.store]
   * @param {() => Promise<RelayTransport|null>} [deps.getRelay]
   * @param {() => object|null} [deps.getBackupAdapter] - the active backup location adapter
   * @param {(cfg: object) => Promise<void>} [deps.setRelayConfig]
   */
  constructor({ store = defaultStore, getRelay = defaultGetRelay, getBackupAdapter = null, setRelayConfig = setTransportConfig } = {}) {
    this.store = store;
    this.getRelay = getRelay;
    this.getBackupAdapter = getBackupAdapter || (() => backupSync.activeAdapter());
    this.setRelayConfig = setRelayConfig;
    this.status = { state: 'off', lastSyncAt: null, error: null, conflicts: 0, channels: [] };
    this._running = null;
    this._timer = null;
    this._debounce = null;
  }

  get deviceId() {
    return this.store.deviceId;
  }

  // ---------------------------------------------------------------------------
  // Secrets that propagate to the teacher's other devices
  // ---------------------------------------------------------------------------

  async _shareSecret(name, value) {
    if (value === null) await KeyVault.deleteSecret(this.store, name);
    else await KeyVault.setSecret(this.store, name, value);
    await this.store.outbox.append({ table: '_vault', op: value === null ? 'delete' : 'put', key: name, record: value });
  }

  async _onVaultOp(op) {
    if (!SHARED_SECRET_PREFIXES.some(p => String(op.key).startsWith(p))) return;
    if (op.op === 'delete') await KeyVault.deleteSecret(this.store, op.key);
    else if (op.record) await KeyVault.setSecret(this.store, op.key, op.record);
  }

  async _sharedSecretOps() {
    const ops = [];
    for (const name of await KeyVault.listSecretNames(this.store)) {
      if (!SHARED_SECRET_PREFIXES.some(p => name.startsWith(p))) continue;
      ops.push({ table: '_vault', op: 'put', key: name, record: await KeyVault.getSecret(this.store, name) });
    }
    return ops;
  }

  // ---------------------------------------------------------------------------
  // Channels & engines
  // ---------------------------------------------------------------------------

  async _relayFor(baseUrl) {
    const relay = await this.getRelay();
    if (!relay) throw new ReplicationSetupError('NEEDS_RELAY', 'Connect to your school server to sync.');
    if (baseUrl && !sameServer(relay.baseUrl, baseUrl)) {
      throw new ReplicationSetupError('OTHER_RELAY', `Connect to ${baseUrl} to sync.`);
    }
    return relay;
  }

  async _channelFor(cfg, channelId) {
    if (cfg.type === 'relay') {
      return new RelayChannel(await this._relayFor(cfg.base_url), { workspaceId: cfg.workspace_id, workspaceKey: cfg.workspace_key });
    }
    if (cfg.type === 'location') {
      const adapter = this.getBackupAdapter();
      if (!adapter?.rotates || (cfg.location_type && adapter.id !== cfg.location_type)) {
        throw new ReplicationSetupError('NEEDS_LOCATION', 'Choose the same backup location on this device to sync.');
      }
      return new LocationChannel(adapter, channelId);
    }
    return null;
  }

  async _engine(id, secret, channel, courseId = null) {
    return new ReplicationEngine({
      store: this.store,
      channel,
      channelId: id,
      key: await importChannelKey(secret),
      deviceId: this.deviceId,
      courseId,
      onVaultOp: courseId ? null : (op) => this._onVaultOp(op)
    });
  }

  /** Engines for every configured channel; channels that can't connect are reported, not thrown */
  async engines() {
    const out = [];
    const problems = [];
    const ws = await KeyVault.getSecret(this.store, WORKSPACE_SECRET);
    if (ws && ws.channel?.type !== 'none') {
      try {
        out.push({ name: 'Your devices', engine: await this._engine(ws.id, ws.secret, await this._channelFor(ws.channel, ws.id)) });
      } catch (err) {
        problems.push({ name: 'Your devices', error: err });
      }
    }
    for (const name of await KeyVault.listSecretNames(this.store, CLASS_SHARE_PREFIX)) {
      const share = await KeyVault.getSecret(this.store, name);
      if (!share) continue;
      const label = `Shared class: ${share.course_name || share.course_id}`;
      try {
        const channel = await this._channelFor({ type: 'relay', ...share.relay }, share.id);
        out.push({ name: label, engine: await this._engine(share.id, share.secret, channel, share.course_id) });
      } catch (err) {
        problems.push({ name: label, error: err });
      }
    }
    return { engines: out, problems };
  }

  /** A new channel starts from a snapshot, not from the whole (possibly pruned) outbox */
  async _startChannel(engine, { extra = null } = {}) {
    await this.store.setMetadata(`repl_cursor:${engine.channelId}`, await this.store.outbox.latestSeq());
    await engine.writeSnapshot({ extra });
    await this.store.setMetadata(`repl_snapshot_at:${engine.channelId}`, Date.now());
  }

  // ---------------------------------------------------------------------------
  // Sync rounds
  // ---------------------------------------------------------------------------

  /** Pull, then push (so local edits not yet sent count as conflicts), then snapshot/prune */
  async syncNow({ forceSnapshot = false } = {}) {
    if (this._running) return this._running;
    this._running = (async () => {
      const { engines, problems } = await this.engines();
      if (!engines.length && !problems.length) {
        // Nothing to sync to: the outbox would only grow
        await this.store.outbox.pruneThrough(await this.store.outbox.latestSeq());
        this._setStatus({ state: 'off', error: null, channels: [] });
        return this.status;
      }
      this._setStatus({ state: 'syncing' });
      const channels = problems.map(p => ({ name: p.name, ok: false, error: p.error.message, code: p.error.code }));
      let applied = 0;
      for (const { name, engine } of engines) {
        try {
          const pulled = await engine.pull();
          applied += pulled.applied;
          await engine.push();
          const snapKey = `repl_snapshot_at:${engine.channelId}`;
          const last = Number(await this.store.getMetadata(snapKey)) || 0;
          if (forceSnapshot || Date.now() - last > SNAPSHOT_EVERY_MS) {
            const extra = engine.courseId ? null : { vault_ops: await this._sharedSecretOps() };
            const { vector } = await engine.writeSnapshot({ extra });
            await this.store.setMetadata(snapKey, Date.now());
            await engine.pruneOwnChunks(vector[this.deviceId] || 0);
          }
          channels.push({ name, ok: true });
        } catch (err) {
          console.warn(`[sync] ${name}:`, err);
          channels.push({ name, ok: false, error: err.message, code: err.code });
        }
      }
      // Rows every working channel has pushed are no longer needed
      if (engines.length && channels.every(c => c.ok)) {
        const cursors = await Promise.all(engines.map(({ engine }) => engine.pushedThrough()));
        await this.store.outbox.pruneThrough(Math.min(...cursors));
      }
      const conflicts = ((await this.store.getMetadata(CONFLICTS_METADATA)) || []).length;
      const failed = channels.find(c => !c.ok);
      this._setStatus({
        state: failed ? 'error' : 'idle',
        error: failed ? failed.error : null,
        lastSyncAt: channels.some(c => c.ok) ? new Date().toISOString() : this.status.lastSyncAt,
        conflicts,
        channels
      });
      if (applied && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('kb-remote-changes', { detail: { applied } }));
      return this.status;
    })();
    try {
      return await this._running;
    } finally {
      this._running = null;
    }
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...patch };
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('kb-replication-status', { detail: this.status }));
  }

  /** Background sync: every minute while visible, and shortly after local edits */
  start() {
    if (this._timer || typeof window === 'undefined') return;
    const tick = () => {
      if (document.visibilityState === 'visible') this.syncNow().catch(() => {});
    };
    this._timer = setInterval(tick, 60 * 1000);
    this.store.onMutation((change) => {
      if (change?.tableName === 'outbox' || change?.tableName === 'app_metadata') return;
      clearTimeout(this._debounce);
      this._debounce = setTimeout(tick, 15 * 1000);
    });
    document.addEventListener('visibilitychange', tick);
    setTimeout(tick, 3000);
  }

  // ---------------------------------------------------------------------------
  // Own devices
  // ---------------------------------------------------------------------------

  async workspace() {
    return KeyVault.getSecret(this.store, WORKSPACE_SECRET);
  }

  /**
   * Create the personal workspace if there is none: on the relay when connected, else in the
   * backup location, else keys-only (devices can open each other's backups and hand-ins).
   */
  async ensureWorkspace() {
    const existing = await this.workspace();
    if (existing) return existing;
    const relay = await this.getRelay();
    const adapter = this.getBackupAdapter();
    let channel = { type: 'none' };
    let id = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    if (relay) {
      const { workspaceId, workspaceKey } = await relay.syncCreateWorkspace();
      id = workspaceId;
      channel = { type: 'relay', base_url: relay.baseUrl, workspace_id: workspaceId, workspace_key: workspaceKey };
    } else if (adapter?.rotates) {
      channel = { type: 'location', location_type: adapter.id };
    }
    const ws = { id, secret: newChannelSecret(), channel, created_at: new Date().toISOString() };
    await KeyVault.setSecret(this.store, WORKSPACE_SECRET, ws);
    if (channel.type !== 'none') {
      await this._startChannel(await this._engine(ws.id, ws.secret, await this._channelFor(channel, ws.id)), { extra: { vault_ops: await this._sharedSecretOps() } });
    }
    return ws;
  }

  /** Existing device: answer a new device's link code. Returns the reply code and safety number. */
  async answerDeviceLink(offerCode) {
    const ws = await this.ensureWorkspace();
    if (ws.channel.type !== 'none') await this.syncNow({ forceSnapshot: true });
    const relayConfig = ws.channel.type === 'relay' ? await this.store.getMetadata('sync_config') : null;
    return answerOffer(offerCode, {
      v: INVITE_VERSION,
      vault: await KeyVault.exportLinkBundle(this.store),
      relay: relayConfig && relayConfig.baseUrl ? relayConfig : null,
      channel: ws.channel.type,
      location_type: ws.channel.location_type || null
    }, 'device');
  }

  /**
   * New device: open the reply. Nothing changes until `apply()` is called, after the teacher
   * confirmed the safety numbers match.
   */
  async openDeviceLink(offer, answerCode) {
    const { payload, safety } = await openAnswer(offer, answerCode);
    return {
      safety,
      channel: payload.channel,
      locationType: payload.location_type,
      apply: async () => {
        await KeyVault.importLinkBundle(this.store, payload.vault);
        if (payload.relay) await this.setRelayConfig(payload.relay);
        const status = await this.syncNow();
        return { status, needsLocation: payload.channel === 'location' && status.channels.some(c => c.code === 'NEEDS_LOCATION') };
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Co-teaching
  // ---------------------------------------------------------------------------

  async classShare(courseId) {
    return KeyVault.getSecret(this.store, `${CLASS_SHARE_PREFIX}${courseId}`);
  }

  /** Keys new assignments for a class are published with: the class key once it is shared */
  async publishKeysFor(courseId) {
    if (courseId && await this.classShare(courseId)) return KeyVault.ensureClassKey(this.store, courseId);
    return KeyVault.getTeacherKeys(this.store);
  }

  /** Owner: answer a co-teacher's join code with the class key and channel credentials */
  async answerClassInvite(course, offerCode) {
    const relay = await this.getRelay();
    if (!relay) throw new ReplicationSetupError('NEEDS_RELAY', 'Sharing a class needs a connection to your school server (Backup & storage → Connect to a school server).');
    let share = await this.classShare(course.id);
    if (!share) {
      const { workspaceId, workspaceKey } = await relay.syncCreateWorkspace();
      share = {
        id: workspaceId,
        secret: newChannelSecret(),
        course_id: course.id,
        course_name: course.name || '',
        relay: { base_url: relay.baseUrl, workspace_id: workspaceId, workspace_key: workspaceKey },
        owner: true,
        created_at: new Date().toISOString()
      };
      await KeyVault.ensureClassKey(this.store, course.id);
      await this._shareSecret(`${CLASS_KEY_PREFIX}${course.id}`, await KeyVault.exportClassKey(this.store, course.id));
      await this._shareSecret(`${CLASS_SHARE_PREFIX}${course.id}`, share);
      await this._startChannel(await this._engine(share.id, share.secret, await this._channelFor({ type: 'relay', ...share.relay }, share.id), course.id));
    } else {
      await this.syncNow({ forceSnapshot: true });
    }
    return answerOffer(offerCode, {
      v: INVITE_VERSION,
      course: { id: course.id, name: course.name || '' },
      class_key: await KeyVault.exportClassKey(this.store, course.id),
      share: { ...share, owner: false }
    }, 'coteacher');
  }

  /** Co-teacher: open the owner's reply; `apply()` after the safety numbers match */
  async openClassInvite(offer, answerCode) {
    const { payload, safety } = await openAnswer(offer, answerCode);
    if (payload?.v !== INVITE_VERSION || !payload.course?.id || !payload.class_key || !payload.share?.relay) {
      throw new ReplicationSetupError('BAD_INVITE', 'This invite is not from a compatible version of KennisBoost.');
    }
    return {
      safety,
      course: payload.course,
      serverUrl: payload.share.relay.base_url,
      apply: async () => {
        await this._relayFor(payload.share.relay.base_url);
        await this._shareSecret(`${CLASS_KEY_PREFIX}${payload.course.id}`, payload.class_key);
        await this._shareSecret(`${CLASS_SHARE_PREFIX}${payload.course.id}`, { ...payload.share, joined_at: new Date().toISOString() });
        return this.syncNow();
      }
    };
  }

  /**
   * Stop syncing a shared class on all of this teacher's devices. The owner also replaces the
   * class key, so assignments published from now on can't be opened by former co-teachers; the old
   * key is kept to open work already handed in.
   */
  async stopSharing(courseId) {
    const share = await this.classShare(courseId);
    if (!share) return;
    if (share.owner) {
      const old = await KeyVault.exportClassKey(this.store, courseId);
      if (old) await this._shareSecret(`retired_class_key:${courseId}:${old.fingerprint}`, old);
      await this._shareSecret(`${CLASS_KEY_PREFIX}${courseId}`, null);
    }
    await this._shareSecret(`${CLASS_SHARE_PREFIX}${courseId}`, null);
  }

  // ---------------------------------------------------------------------------
  // Conflicts
  // ---------------------------------------------------------------------------

  async conflicts() {
    return (await this.store.getMetadata(CONFLICTS_METADATA)) || [];
  }

  /** Keep the discarded version instead (it becomes a fresh local edit and syncs out) */
  async resolveConflict(id, { useDiscarded = false } = {}) {
    const list = await this.conflicts();
    const c = list.find(x => x.id === id);
    if (!c) return;
    if (useDiscarded && c.discarded) await this.store.table(c.table).put({ ...c.discarded });
    await this.store.setMetadata(CONFLICTS_METADATA, list.filter(x => x.id !== id));
    this._setStatus({ conflicts: list.length - 1 });
  }
}

export const replication = new ReplicationManager();
export default replication;
