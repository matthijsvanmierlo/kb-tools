/**
 * Replication channels: where encrypted sync chunks and snapshots are kept (engine.js).
 *
 * Interface:
 *   putChunk({ deviceId, start, end, body })      idempotent per (device, start, end)
 *   listChunks({ after }) → { items: [{ deviceId, start, end, ... }], cursor }
 *   getChunk(item) → body
 *   putSnapshot({ deviceId, createdAt, body })    keeps the newest per device
 *   latestSnapshot({ deviceId?, excludeDeviceId? }) → item | null
 *   getSnapshot(item) → body
 *   deleteChunks({ deviceId, throughSeq })
 */

const pad = (n) => String(n).padStart(10, '0');
const UUIDISH = '[0-9A-Za-z-]{8,64}';

/**
 * Files next to the backups in the teacher's backup location (synced folder, Google Drive,
 * OneDrive). Works for one teacher's own devices: every device sees the same folder.
 */
export class LocationChannel {
  constructor(adapter, channelId) {
    if (!adapter?.rotates) throw new Error('This backup location cannot hold sync files.');
    this.adapter = adapter;
    this.channelId = channelId;
    this.prefix = `kbsync-${channelId}-`;
    this.chunkRe = new RegExp(`^kbsync-${channelId}-c-(${UUIDISH})-(\\d{10})-(\\d{10})\\.kbc$`);
    this.snapRe = new RegExp(`^kbsync-${channelId}-s-(${UUIDISH})\\.kbc$`);
  }

  get label() {
    return this.adapter.label;
  }

  _chunkName(deviceId, start, end) {
    return `${this.prefix}c-${deviceId}-${pad(start)}-${pad(end)}.kbc`;
  }

  async putChunk({ deviceId, start, end, body }) {
    await this.adapter.put(this._chunkName(deviceId, start, end), body);
  }

  async _files() {
    return (await this.adapter.list()).filter(f => f.name.startsWith(this.prefix));
  }

  async listChunks() {
    const items = [];
    for (const f of await this._files()) {
      const m = f.name.match(this.chunkRe);
      if (m) items.push({ name: f.name, deviceId: m[1], start: Number(m[2]), end: Number(m[3]) });
    }
    return { items, cursor: null };
  }

  async getChunk(item) {
    return this.adapter.get(item.name);
  }

  /** One snapshot file per device, overwritten (the folder adapters replace files atomically) */
  async putSnapshot({ deviceId, createdAt, body }) {
    await this.adapter.put(`${this.prefix}s-${deviceId}.kbc`, JSON.stringify({ created_at: createdAt, body }));
  }

  async latestSnapshot({ deviceId = null, excludeDeviceId = null } = {}) {
    const found = [];
    for (const f of await this._files()) {
      const m = f.name.match(this.snapRe);
      if (!m || (deviceId && m[1] !== deviceId) || m[1] === excludeDeviceId) continue;
      const text = await this.adapter.get(f.name);
      try {
        const { created_at, body } = JSON.parse(text);
        found.push({ deviceId: m[1], createdAt: created_at, body });
      } catch (_) {}
    }
    found.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return found[0] || null;
  }

  async getSnapshot(item) {
    return item.body;
  }

  async deleteChunks({ deviceId, throughSeq }) {
    let n = 0;
    for (const c of (await this.listChunks()).items) {
      if (c.deviceId === deviceId && c.end <= throughSeq) {
        await this.adapter.delete(c.name);
        n++;
      }
    }
    return n;
  }
}

/**
 * The school relay (server/relay, /api/v1/sync/:workspace). Needed for co-teaching, where two
 * teachers don't share a folder. Every request carries the teacher's relay token and the
 * workspace's own access key; the relay stores ciphertext only.
 */
export class RelayChannel {
  constructor(transport, { workspaceId, workspaceKey }) {
    this.transport = transport;
    this.workspaceId = workspaceId;
    this.workspaceKey = workspaceKey;
  }

  get label() {
    return 'School server';
  }

  putChunk({ deviceId, start, end, body }) {
    return this.transport.syncPutChunk(this.workspaceId, this.workspaceKey, { device_id: deviceId, start, end, body });
  }

  async listChunks({ after = null } = {}) {
    const items = [];
    let cursor = after;
    for (;;) {
      const page = await this.transport.syncListChunks(this.workspaceId, this.workspaceKey, { after: cursor });
      for (const c of page.items) items.push({ seq: c.seq, deviceId: c.device_id, start: c.start, end: c.end, body: c.body });
      if (page.items.length) cursor = page.items[page.items.length - 1].seq;
      if (!page.more) break;
    }
    return { items, cursor };
  }

  async getChunk(item) {
    return item.body;
  }

  putSnapshot({ deviceId, createdAt, body }) {
    return this.transport.syncPutSnapshot(this.workspaceId, this.workspaceKey, deviceId, { created_at: createdAt, body });
  }

  async latestSnapshot({ deviceId = null, excludeDeviceId = null } = {}) {
    const list = (await this.transport.syncListSnapshots(this.workspaceId, this.workspaceKey))
      .filter(s => (!deviceId || s.device_id === deviceId) && s.device_id !== excludeDeviceId)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return list[0] ? { deviceId: list[0].device_id, createdAt: list[0].created_at } : null;
  }

  async getSnapshot(item) {
    return (await this.transport.syncGetSnapshot(this.workspaceId, this.workspaceKey, item.deviceId)).body;
  }

  deleteChunks({ deviceId, throughSeq }) {
    return this.transport.syncDeleteChunks(this.workspaceId, this.workspaceKey, { device_id: deviceId, through: throughSeq });
  }
}

/** In-memory channel shared by test "devices" */
export class MemoryChannel {
  constructor() {
    this.chunks = new Map();
    this.snapshots = new Map();
  }

  async putChunk({ deviceId, start, end, body }) {
    this.chunks.set(`${deviceId}|${start}|${end}`, { deviceId, start, end, body });
  }

  async listChunks() {
    return { items: [...this.chunks.values()], cursor: null };
  }

  async getChunk(item) {
    return item.body;
  }

  async putSnapshot({ deviceId, createdAt, body }) {
    this.snapshots.set(deviceId, { deviceId, createdAt, body });
  }

  async latestSnapshot({ deviceId = null, excludeDeviceId = null } = {}) {
    return [...this.snapshots.values()]
      .filter(s => (!deviceId || s.deviceId === deviceId) && s.deviceId !== excludeDeviceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
  }

  async getSnapshot(item) {
    return item.body;
  }

  async deleteChunks({ deviceId, throughSeq }) {
    let n = 0;
    for (const [k, c] of this.chunks) {
      if (c.deviceId === deviceId && c.end <= throughSeq) { this.chunks.delete(k); n++; }
    }
    return n;
  }
}
