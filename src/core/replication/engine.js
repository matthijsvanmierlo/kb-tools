/**
 * Replication engine - KB-CORE-010 (revision-2 §9 "Option B": per-teacher state sync)
 *
 * Moves the outbox (every local write, see storage.js) between devices through a "channel" that
 * only ever stores ciphertext: a school relay or the teacher's backup location (channels.js).
 *
 *  push      unpushed outbox rows → encrypted chunks named by (device, first seq, last seq)
 *  pull      other devices' chunks → applied with last-writer-wins on updated_at; device id breaks ties
 *  snapshot  a full encrypted copy plus the vector of chunks it already contains, so a new device
 *            (or one that fell behind pruned chunks) can catch up without the whole history
 *
 * One engine per channel. The personal channel carries everything; a class channel (co-teaching)
 * carries only records of one class, in both directions, so a co-teacher can never touch the rest
 * of a teacher's data. Grades both sides changed since the last sync are reported as conflicts.
 */
import { scopeOf } from '../storage.js';
import { bytesToB64, b64ToBytes } from '../submission-crypto.js';

export const SYNC_TABLES = [
  'flashcards', 'timelines', 'video_assessments', 'gradebook_courses', 'gradebook_students',
  'gradebook_assignments', 'gradebook_grades', 'gradebook_rubrics', 'assignments', 'assignment_submissions'
];
const SYNCED = new Set(SYNC_TABLES);

export const CHUNK_VERSION = 1;
export const MAX_OPS_PER_CHUNK = 500;
export const CONFLICTS_METADATA = 'sync_conflicts';
const MAX_CONFLICTS = 200;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ReplicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReplicationError';
    this.code = code;
  }
}

/** A channel key from its 32 raw bytes (base64url), shared by every member of the channel */
export function importChannelKey(secretB64) {
  return crypto.subtle.importKey('raw', b64ToBytes(secretB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function newChannelSecret() {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sealJson(key, value, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value)));
  return JSON.stringify({ iv: bytesToB64(iv), ct: bytesToB64(ct) });
}

export async function openJson(key, text, aad) {
  let box;
  try {
    box = JSON.parse(text);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(box.iv), additionalData: enc.encode(aad) }, key, b64ToBytes(box.ct));
    return JSON.parse(dec.decode(pt));
  } catch (_) {
    throw new ReplicationError('UNREADABLE', 'A sync file could not be decrypted (wrong key or damaged).');
  }
}

const chunkAad = (channelId, deviceId, start, end) => `kb-sync-chunk|${channelId}|${deviceId}|${start}|${end}`;
const snapshotAad = (channelId, deviceId) => `kb-sync-snapshot|${channelId}|${deviceId}`;

/** Fields that matter when deciding whether two grade versions really disagree */
const comparable = (r) => {
  if (!r) return '';
  const { updated_at, created_at, ...rest } = r;
  return JSON.stringify(rest, Object.keys(rest).sort());
};

const keyString = (k) => (Array.isArray(k) ? k.join('+') : String(k));

export class ReplicationEngine {
  /**
   * @param {object} opts
   * @param {object} opts.store - StorageManager (outbox, getByChangeKey, applyRemoteChange, metadata)
   * @param {object} opts.channel - see channels.js
   * @param {string} opts.channelId
   * @param {CryptoKey} opts.key - channel key
   * @param {string} opts.deviceId
   * @param {string|null} [opts.courseId] - restrict to one class (co-teacher channel)
   * @param {(op: object) => Promise<void>} [opts.onVaultOp] - personal channel: KeyVault secrets
   */
  constructor({ store, channel, channelId, key, deviceId, courseId = null, onVaultOp = null }) {
    Object.assign(this, { store, channel, channelId, key, deviceId, courseId, onVaultOp });
    this._assignmentCourse = new Map();
  }

  get _cursorKey() { return `repl_cursor:${this.channelId}`; }
  get _vectorKey() { return `repl_vector:${this.channelId}`; }
  get _listCursorKey() { return `repl_list_cursor:${this.channelId}`; }
  get _lastEndKey() { return `repl_last_end:${this.channelId}`; }

  async pushedThrough() {
    return Number(await this.store.getMetadata(this._cursorKey)) || 0;
  }

  async vector() {
    return (await this.store.getMetadata(this._vectorKey)) || {};
  }

  // ---------------------------------------------------------------------------
  // Scope (which ops this channel carries)
  // ---------------------------------------------------------------------------

  async _courseOf(table, record, scope) {
    const s = scope || scopeOf(table, record);
    if (!s) return null;
    if (s.course_id !== undefined) return s.course_id;
    if (s.assignment_id) {
      if (!this._assignmentCourse.has(s.assignment_id)) {
        const a = await this.store.getByChangeKey('assignments', s.assignment_id);
        this._assignmentCourse.set(s.assignment_id, a?.class_id || null);
      }
      return this._assignmentCourse.get(s.assignment_id);
    }
    return null;
  }

  /** Should this channel carry the op (outgoing) or accept it (incoming)? */
  async _inScope(op, { incoming = false } = {}) {
    if (op.table === '_vault') return !this.courseId && (!incoming || Boolean(this.onVaultOp));
    if (!SYNCED.has(op.table)) return false;
    if (!this.courseId) return true;
    let scope = op.scope;
    // Never trust a remote op's claimed scope: derive it from the record (or what it would delete)
    if (incoming) {
      scope = op.op === 'put'
        ? scopeOf(op.table, op.record)
        : scopeOf(op.table, await this.store.getByChangeKey(op.table, op.key));
    }
    return (await this._courseOf(op.table, op.record, scope)) === this.courseId;
  }

  // ---------------------------------------------------------------------------
  // Push
  // ---------------------------------------------------------------------------

  async push() {
    let cursor = await this.pushedThrough();
    let pushed = 0;
    for (;;) {
      const rows = await this.store.outbox.since(cursor, MAX_OPS_PER_CHUNK);
      if (!rows.length) break;
      const ops = [];
      for (const r of rows) {
        const op = { table: r.table, op: r.op, key: r.key, record: r.record, scope: r.scope || null, ts: r.created_at };
        if (await this._inScope(op)) ops.push(op);
      }
      const start = rows[0].seq;
      const end = rows[rows.length - 1].seq;
      if (ops.length) {
        // prev_end lets a reader tell "rows out of this channel's scope" from "chunks I missed"
        const prevEnd = Number(await this.store.getMetadata(this._lastEndKey)) || 0;
        const body = await sealJson(this.key, { v: CHUNK_VERSION, channel: this.channelId, device_id: this.deviceId, start, end, prev_end: prevEnd, ops }, chunkAad(this.channelId, this.deviceId, start, end));
        await this.channel.putChunk({ deviceId: this.deviceId, start, end, body });
        await this.store.setMetadata(this._lastEndKey, end);
        pushed += ops.length;
      }
      cursor = end;
      await this.store.setMetadata(this._cursorKey, cursor);
    }
    return pushed;
  }

  // ---------------------------------------------------------------------------
  // Pull
  // ---------------------------------------------------------------------------

  async pull() {
    let vector = await this.vector();
    const result = { applied: 0, conflicts: 0, bootstrapped: false };

    // A device with nothing from this channel yet starts from the newest snapshot
    if (!Object.keys(vector).length) {
      const snap = await this.channel.latestSnapshot({ excludeDeviceId: this.deviceId });
      if (snap) {
        const r = await this._applySnapshot(snap);
        result.applied += r.applied;
        result.bootstrapped = true;
        vector = await this.vector();
      }
    }

    const pending = await this._pendingLocalKeys();
    const listCursor = await this.store.getMetadata(this._listCursorKey);
    const { items, cursor } = await this.channel.listChunks({ after: listCursor });
    const chunks = items
      .filter(c => c.deviceId !== this.deviceId && c.end > (vector[c.deviceId] || 0))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.start - b.start);

    for (const c of chunks) {
      if (c.end <= (vector[c.deviceId] || 0)) continue;
      const body = await this.channel.getChunk(c);
      const chunk = await openJson(this.key, body, chunkAad(this.channelId, c.deviceId, c.start, c.end));
      if (chunk.channel !== this.channelId || chunk.device_id !== c.deviceId) {
        throw new ReplicationError('MISMATCH', 'A sync file does not belong where it was found.');
      }
      if ((chunk.prev_end || 0) > (vector[c.deviceId] || 0)) {
        // Earlier chunks from that device were pruned before this one saw them: catch up from its snapshot
        const snap = await this.channel.latestSnapshot({ deviceId: c.deviceId });
        if (!snap) throw new ReplicationError('GAP', 'Some changes from another device are no longer available. Restore a recent backup on this device.');
        result.applied += (await this._applySnapshot(snap)).applied;
        vector = await this.vector();
        if (c.end <= (vector[c.deviceId] || 0)) continue;
      }
      for (const op of chunk.ops || []) {
        const r = await this._applyOp(op, c.deviceId, pending);
        result.applied += r.applied;
        result.conflicts += r.conflict;
      }
      vector[c.deviceId] = Math.max(vector[c.deviceId] || 0, c.end);
      await this.store.setMetadata(this._vectorKey, vector);
    }
    if (cursor !== undefined && cursor !== null) await this.store.setMetadata(this._listCursorKey, cursor);
    return result;
  }

  async _pendingLocalKeys() {
    const cursor = await this.pushedThrough();
    const pending = new Set();
    let seq = cursor;
    for (;;) {
      const rows = await this.store.outbox.since(seq, 1000);
      if (!rows.length) break;
      for (const r of rows) pending.add(`${r.table}|${keyString(r.key)}`);
      seq = rows[rows.length - 1].seq;
    }
    return pending;
  }

  _newer(incoming, sourceDevice, local) {
    let a = incoming?.updated_at || '';
    const b = local?.updated_at || '';
    // Clamp future clock skew: allow at most localNow + 5 minutes
    const maxFuture = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    if (a > maxFuture) {
      a = maxFuture;
    }
    if (a !== b) return a > b;
    return sourceDevice > this.deviceId;
  }

  async _applyOp(op, sourceDevice, pending) {
    const none = { applied: 0, conflict: 0 };
    if (!(await this._inScope(op, { incoming: true }))) return none;
    if (op.table === '_vault') {
      await this.onVaultOp(op);
      return { applied: 1, conflict: 0 };
    }
    const local = await this.store.getByChangeKey(op.table, op.key);

    if (op.op === 'delete') {
      // An edit made here after the deletion wins over it
      if (local && (local.updated_at || '') > (op.ts || '')) return none;
      if (!local) return none;
      await this.store.applyRemoteChange(op.table, 'delete', op.key, null);
      return { applied: 1, conflict: 0 };
    }
    if (op.op !== 'put' || !op.record) return none;

    const incomingWins = !local || this._newer(op.record, sourceDevice, local);
    let conflict = 0;
    const conflictTables = ['gradebook_grades', 'assignments', 'gradebook_assignments'];
    if (local && conflictTables.includes(op.table) && pending.has(`${op.table}|${keyString(op.key)}`)
      && comparable(local) !== comparable(op.record)) {
      await this._recordConflict(op, local, incomingWins, sourceDevice);
      conflict = 1;
    }
    if (!incomingWins) return { applied: 0, conflict };
    await this.store.applyRemoteChange(op.table, 'put', op.key, op.record);
    return { applied: 1, conflict };
  }

  async _recordConflict(op, local, incomingWins, sourceDevice) {
    const list = (await this.store.getMetadata(CONFLICTS_METADATA)) || [];
    list.unshift({
      id: crypto.randomUUID(),
      channel: this.channelId,
      table: op.table,
      key: op.key,
      kept: incomingWins ? op.record : local,
      discarded: incomingWins ? local : op.record,
      kept_from: incomingWins ? sourceDevice : this.deviceId,
      detected_at: new Date().toISOString()
    });
    await this.store.setMetadata(CONFLICTS_METADATA, list.slice(0, MAX_CONFLICTS));
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  /**
   * Write a full copy of this channel's data. `extra` lets the personal channel include vault
   * secrets, so a device that joins after their ops were pruned still receives them.
   */
  async writeSnapshot({ extra = null } = {}) {
    const tables = {};
    for (const t of SYNC_TABLES) {
      const rows = await this.store.table(t).toArray();
      const kept = [];
      for (const r of rows) {
        if (!this.courseId || (await this._courseOf(t, r, null)) === this.courseId) kept.push(r);
      }
      tables[t] = kept;
    }
    const vector = { ...(await this.vector()), [this.deviceId]: await this.pushedThrough() };
    const createdAt = new Date().toISOString();
    const body = await sealJson(this.key, { v: CHUNK_VERSION, channel: this.channelId, device_id: this.deviceId, created_at: createdAt, vector, tables, extra }, snapshotAad(this.channelId, this.deviceId));
    await this.channel.putSnapshot({ deviceId: this.deviceId, createdAt, body });
    return { createdAt, vector };
  }

  async _applySnapshot(snap) {
    const body = await this.channel.getSnapshot(snap);
    const data = await openJson(this.key, body, snapshotAad(this.channelId, snap.deviceId));
    if (data.channel !== this.channelId || data.device_id !== snap.deviceId) {
      throw new ReplicationError('MISMATCH', 'A sync snapshot does not belong where it was found.');
    }
    let applied = 0;
    const pending = await this._pendingLocalKeys();
    for (const t of SYNC_TABLES) {
      for (const record of data.tables?.[t] || []) {
        const key = t === 'gradebook_grades' ? [record.student_id, record.assignment_id] : record.id;
        applied += (await this._applyOp({ table: t, op: 'put', key, record }, snap.deviceId, pending)).applied;
      }
    }
    if (data.extra && this.onVaultOp && !this.courseId) {
      for (const op of data.extra.vault_ops || []) await this.onVaultOp(op);
    }
    const vector = await this.vector();
    for (const [dev, seq] of Object.entries(data.vector || {})) {
      if (dev !== this.deviceId) vector[dev] = Math.max(vector[dev] || 0, seq);
    }
    await this.store.setMetadata(this._vectorKey, vector);
    return { applied };
  }

  /** Remove this device's chunks that its newest snapshot already contains */
  async pruneOwnChunks(throughSeq) {
    if (!this.channel.deleteChunks) return 0;
    return this.channel.deleteChunks({ deviceId: this.deviceId, throughSeq });
  }
}
