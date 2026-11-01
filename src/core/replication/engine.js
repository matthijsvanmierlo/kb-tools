import { mergeRecords, markRemoved } from './merge.js';
import { HLC, hlc } from './hlc.js';
import { scopeOf } from '../storage.js';
import { supportsCompressionStreams } from '../crypto-share.js';
import { generateUUID } from '../../utils/uuid.js';
import lzLib from 'lz-string';

const LZString = lzLib.compressToUint8Array ? lzLib : (lzLib.default || lzLib);

export const SYNC_TABLES = [
  'flashcards', 'timelines', 'video_assessments', 'gradebook_courses', 'gradebook_students',
  'gradebook_assignments', 'gradebook_grades', 'gradebook_rubrics', 'assignments', 'assignment_submissions',
  'tasks', 'task_submissions',
  'course_units', 'course_items'
];
const SYNCED = new Set(SYNC_TABLES);

export const CHUNK_VERSION = 2;
export const MAX_OPS_PER_CHUNK = 500;
export const TARGET_CHUNK_BYTES = 768 * 1024; // 768 KB target
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

async function pipeBytes(bytes, transform) {
  const writer = transform.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close());
  written.catch(() => {});
  const reader = transform.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await written;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function compressPayload(bytes) {
  if (supportsCompressionStreams()) {
    try {
      const compressed = await pipeBytes(bytes, new CompressionStream('gzip'));
      const out = new Uint8Array(compressed.byteLength + 1);
      out[0] = 0x02; // Format 2 = gzip
      out.set(compressed, 1);
      return out;
    } catch (_) {}
  }
  // Fallback to lz-string
  const compressed = LZString.compressToUint8Array
    ? LZString.compressToUint8Array(dec.decode(bytes))
    : enc.encode(LZString.compress(dec.decode(bytes)));
  const out = new Uint8Array(compressed.byteLength + 1);
  out[0] = 0x03; // Format 3 = lz-string
  out.set(compressed, 1);
  return out;
}

async function decompressPayload(bytes) {
  if (!bytes || bytes.byteLength === 0) return new Uint8Array();
  const format = bytes[0];
  if (format === 0x02 && supportsCompressionStreams()) {
    try {
      return await pipeBytes(bytes.subarray(1), new DecompressionStream('gzip'));
    } catch (_) {}
  }
  if (format === 0x03) {
    try {
      const decompressedStr = LZString.decompressFromUint8Array
        ? LZString.decompressFromUint8Array(bytes.subarray(1))
        : LZString.decompress(dec.decode(bytes.subarray(1)));
      return enc.encode(decompressedStr);
    } catch (_) {}
  }
  // Format 1 or uncompressed fallback
  return bytes;
}

export async function sealJson(key, value, aad) {
  const jsonBytes = enc.encode(JSON.stringify(value));
  const payloadBytes = await compressPayload(jsonBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, payloadBytes);
  return JSON.stringify({ v: 2, iv: bytesToB64(iv), ct: bytesToB64(ct) });
}

export async function openJson(key, text, aad) {
  let box;
  try {
    box = JSON.parse(text);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(box.iv), additionalData: enc.encode(aad) }, key, b64ToBytes(box.ct));
    const decompressed = await decompressPayload(new Uint8Array(pt));
    return JSON.parse(dec.decode(decompressed));
  } catch (err) {
    throw new ReplicationError('UNREADABLE', 'A sync file could not be decrypted (wrong key or damaged).');
  }
}

const chunkAad = (channelId, deviceId, start, end) => `kb-sync-chunk|${channelId}|${deviceId}|${start}|${end}`;
const snapshotAad = (channelId, deviceId) => `kb-sync-snapshot|${channelId}|${deviceId}`;

const comparable = (r) => {
  if (!r) return '';
  const { updated_at, created_at, _hlc, _fhlc, _removed, ...rest } = r;
  return JSON.stringify(rest, Object.keys(rest).sort());
};

const keyString = (k) => (Array.isArray(k) ? k.join('+') : String(k));

export class ReplicationEngine {
  constructor({ store, channel, channelId, key, deviceId, courseId = null, onVaultOp = null }) {
    Object.assign(this, { store, channel, channelId, key, deviceId, courseId, onVaultOp });
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

  async _courseOf(table, record, scope) {
    const s = scope || scopeOf(table, record);
    if (!s) return null;
    if (s.course_id !== undefined) return s.course_id;
    if (s.assignment_id) {
      if (!this._assignmentCourse) this._assignmentCourse = new Map();
      if (!this._assignmentCourse.has(s.assignment_id)) {
        const a = await this.store.getByChangeKey('assignments', s.assignment_id);
        this._assignmentCourse.set(s.assignment_id, a?.class_id || null);
      }
      return this._assignmentCourse.get(s.assignment_id);
    }
    return null;
  }

  async _inScope(op, { incoming = false } = {}) {
    if (op.table === '_vault') return !this.courseId && (!incoming || Boolean(this.onVaultOp));
    if (!SYNCED.has(op.table)) return false;
    if (!this.courseId) return true;
    let scope = op.scope;
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
      let totalSerializedBytes = 0;
      let lastProcessedSeq = cursor;

      for (const r of rows) {
        let rec = r.record;
        // If single record is larger than cap, upload to standalone blob
        if (rec) {
          const recJson = JSON.stringify(rec);
          if (recJson.length > TARGET_CHUNK_BYTES && typeof this.channel.putBlob === 'function') {
            const blobKey = `blob_${this.channelId}_${this.deviceId}_${r.seq}`;
            await this.channel.putBlob(blobKey, recJson);
            rec = { _blobRef: blobKey, id: rec.id, _hlc: rec._hlc };
          }
        }

        const op = {
          table: r.table,
          op: r.op,
          key: r.key,
          record: rec,
          scope: r.scope || null,
          ts: r.created_at,
          hlc: r.hlc || rec?._hlc || null
        };

        if (await this._inScope(op)) {
          const opBytes = enc.encode(JSON.stringify(op)).length;
          if (ops.length > 0 && totalSerializedBytes + opBytes > TARGET_CHUNK_BYTES) {
            // Cut chunk here
            break;
          }
          ops.push(op);
          totalSerializedBytes += opBytes;
        }
        lastProcessedSeq = r.seq;
      }

      if (lastProcessedSeq === cursor) break;

      const start = rows[0].seq;
      const end = lastProcessedSeq;

      if (ops.length) {
        const prevEnd = Number(await this.store.getMetadata(this._lastEndKey)) || 0;
        const body = await sealJson(
          this.key,
          { v: CHUNK_VERSION, channel: this.channelId, device_id: this.deviceId, start, end, prev_end: prevEnd, ops },
          chunkAad(this.channelId, this.deviceId, start, end)
        );
        await this.channel.putChunk({ deviceId: this.deviceId, start, end, body });
        await this.store.setMetadata(this._lastEndKey, end);
        pushed += ops.length;
      }

      cursor = end;
      await this.store.setMetadata(this._cursorKey, cursor);
      if (typeof this.store.outbox?.markPushed === 'function') {
        const pushedSeqs = rows.filter(r => r.seq <= end).map(r => r.seq);
        if (pushedSeqs.length) {
          await this.store.outbox.markPushed(pushedSeqs);
        }
      }
    }

    return pushed;
  }

  // ---------------------------------------------------------------------------
  // Pull
  // ---------------------------------------------------------------------------

  async _quarantineChunk(chunkMeta, reason) {
    try {
      const qTable = this.store.table('repl_quarantine');
      if (qTable) {
        await qTable.put({
          channel_id: this.channelId,
          device_id: chunkMeta.deviceId,
          start_seq: chunkMeta.start,
          end_seq: chunkMeta.end,
          quarantined_at: new Date().toISOString(),
          reason
        });
      }
    } catch (_) {}
  }

  async pull() {
    let vector = await this.vector();
    const result = { applied: 0, conflicts: 0, bootstrapped: false };

    // Start from newest snapshot if empty
    if (!Object.keys(vector).length) {
      const snap = await this.channel.latestSnapshot({ excludeDeviceId: this.deviceId });
      if (snap) {
        const r = await this._applySnapshot(snap);
        result.applied += r.applied;
        result.bootstrapped = true;
        vector = await this.vector();
      }
    }

    const cursor = Number(await this.store.getMetadata(this._listCursorKey)) || null;
    const { items: chunks } = await this.channel.listChunks({ after: cursor });

    const sortedChunks = chunks
      .filter(c => c.deviceId !== this.deviceId && c.end > (vector[c.deviceId] || 0))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.start - b.start);

    const pending = await this._pendingLocalKeys();

    for (const c of sortedChunks) {
      if (c.end <= (vector[c.deviceId] || 0)) continue;

      let chunk;
      try {
        const body = await this.channel.getChunk(c);
        chunk = await openJson(this.key, body, chunkAad(this.channelId, c.deviceId, c.start, c.end));
        if (chunk.channel !== this.channelId || chunk.device_id !== c.deviceId) {
          throw new ReplicationError('MISMATCH', 'A sync file does not belong where it was found.');
        }
      } catch (err) {
        await this._quarantineChunk(c, err.message || 'Corrupt chunk');
        // Recover from latest snapshot if available
        try {
          const snap = await this.channel.latestSnapshot({ deviceId: c.deviceId });
          if (snap) {
            result.applied += (await this._applySnapshot(snap)).applied;
            vector = await this.vector();
          }
        } catch (_) {}
        continue;
      }

      if ((chunk.prev_end || 0) > (vector[c.deviceId] || 0)) {
        try {
          const snap = await this.channel.latestSnapshot({ deviceId: c.deviceId });
          if (!snap) {
            await this._quarantineChunk(c, 'GAP in chunk sequence');
            continue;
          }
          result.applied += (await this._applySnapshot(snap)).applied;
          vector = await this.vector();
          if (c.end <= (vector[c.deviceId] || 0)) continue;
        } catch (err) {
          await this._quarantineChunk(c, err.message || 'Gap recovery failed');
          continue;
        }
      }

      for (const op of chunk.ops || []) {
        const r = await this._applyOp(op, c.deviceId, pending);
        result.applied += r.applied;
        result.conflicts += r.conflict;
      }
      vector[c.deviceId] = Math.max(vector[c.deviceId] || 0, c.end);
      await this.store.setMetadata(this._vectorKey, vector);
    }

    if (cursor !== undefined && cursor !== null) {
      await this.store.setMetadata(this._listCursorKey, cursor);
    }
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
    const incHlc = incoming?._hlc || incoming?.updated_at || '';
    const locHlc = local?._hlc || local?.updated_at || '';
    const cmp = HLC.compare(incHlc, locHlc);
    if (cmp !== 0) return cmp > 0;
    return sourceDevice > this.deviceId;
  }

  async _applyOp(op, sourceDevice, pending) {
    const none = { applied: 0, conflict: 0 };
    if (!(await this._inScope(op, { incoming: true }))) return none;
    if (op.table === '_vault') {
      await this.onVaultOp(op);
      return { applied: 1, conflict: 0 };
    }

    // Resolve blob reference if needed
    if (op.record?._blobRef && typeof this.channel.getBlob === 'function') {
      try {
        const rawBlob = await this.channel.getBlob(op.record._blobRef);
        if (rawBlob) {
          op.record = JSON.parse(rawBlob);
        }
      } catch (_) {}
    }

    // Advance local HLC based on incoming stamp
    const incomingHlc = op.record?._hlc || op.hlc || op.ts || '';
    if (incomingHlc) {
      hlc.observe(incomingHlc, this.deviceId);
    }

    const keyStr = Array.isArray(op.key) ? op.key.join('+') : String(op.key);
    const tombstone = (typeof this.store.getTombstone === 'function')
      ? await this.store.getTombstone(op.table, keyStr)
      : null;

    const local = await this.store.getByChangeKey(op.table, op.key);

    if (op.op === 'delete') {
      const localHlc = local?._hlc || local?.updated_at || '';
      if (local && HLC.compare(localHlc, incomingHlc) > 0) {
        // Local edit after delete wins
        return none;
      }

      // Always record tombstone
      if (typeof this.store.putTombstone === 'function') {
        await this.store.putTombstone({
          table: op.table,
          key: keyStr,
          hlc: incomingHlc,
          deviceId: sourceDevice,
          deleted_at: op.ts || new Date().toISOString()
        });
      }

      if (local) {
        await this.store.applyRemoteChange(op.table, 'delete', op.key, null);
      }
      return { applied: 1, conflict: 0 };
    }

    if (op.op !== 'put' || !op.record) return none;

    // Put op: check against tombstone
    if (tombstone && HLC.compare(tombstone.hlc, incomingHlc) > 0) {
      // Deleted more recently than this incoming put
      return none;
    }
    if (tombstone && typeof this.store.deleteTombstone === 'function') {
      await this.store.deleteTombstone(op.table, keyStr);
    }

    const incomingWins = !local || this._newer(op.record, sourceDevice, local);
    let conflict = 0;
    const conflictTables = ['gradebook_grades', 'assignments', 'tasks', 'gradebook_assignments', 'assignment_submissions', 'task_submissions'];
    if (local && conflictTables.includes(op.table) && pending.has(`${op.table}|${keyString(op.key)}`)
      && comparable(local) !== comparable(op.record)) {
      await this._recordConflict(op, local, incomingWins, sourceDevice);
      conflict = 1;
    }

    const mergedRecord = mergeRecords(op.table, local, op.record, sourceDevice, this.deviceId, incomingWins);
    if (!incomingWins && mergedRecord === local) return { applied: 0, conflict };

    const isDifferentFromBoth = local && (comparable(mergedRecord) !== comparable(local) && comparable(mergedRecord) !== comparable(op.record));
    if (isDifferentFromBoth) {
      // Write back through local put path so other devices converge
      mergedRecord._mergeWrite = true;
      await this.store.table(op.table).put(mergedRecord);
    } else {
      await this.store.applyRemoteChange(op.table, 'put', op.key, mergedRecord);
    }

    return { applied: 1, conflict };
  }

  async _recordConflict(op, local, incomingWins, sourceDevice) {
    const list = (await this.store.getMetadata(CONFLICTS_METADATA)) || [];
    list.unshift({
      id: generateUUID(),
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

  async writeSnapshot({ extra = null } = {}) {
    const createdAt = new Date().toISOString();
    const tables = {};
    for (const t of SYNC_TABLES) {
      const rows = (await this.store.table(t).toArray()).filter(r => this._inScopeSync(t, r));
      if (rows.length) tables[t] = rows;
    }

    const tombstones = (typeof this.store.listTombstones === 'function')
      ? await this.store.listTombstones()
      : [];

    const vector = { ...(await this.vector()), [this.deviceId]: await this.pushedThrough() };
    const body = await sealJson(
      this.key,
      { v: CHUNK_VERSION, channel: this.channelId, device_id: this.deviceId, created_at: createdAt, vector, tables, tombstones, extra },
      snapshotAad(this.channelId, this.deviceId)
    );

    await this.channel.putSnapshot({ deviceId: this.deviceId, createdAt, body });
    return { vector, createdAt };
  }

  async _applySnapshot(snap) {
    const body = await this.channel.getSnapshot(snap);
    const data = await openJson(this.key, body, snapshotAad(this.channelId, snap.deviceId));
    if (data.channel !== this.channelId || data.device_id !== snap.deviceId) {
      throw new ReplicationError('MISMATCH', 'Snapshot does not belong to this channel');
    }

    let applied = 0;
    const pending = await this._pendingLocalKeys();

    // 1. Apply snapshot tombstones first
    for (const ts of data.tombstones || []) {
      if (typeof this.store.putTombstone === 'function') {
        await this.store.putTombstone(ts);
      }
      const local = await this.store.getByChangeKey(ts.table, ts.key);
      if (local && HLC.compare(ts.hlc, local._hlc || local.updated_at || '') >= 0) {
        await this.store.applyRemoteChange(ts.table, 'delete', ts.key, null);
        applied++;
      }
    }

    // 2. Apply table records
    for (const [t, rows] of Object.entries(data.tables || {})) {
      if (!SYNCED.has(t)) continue;
      for (const record of rows) {
        const key = t === 'gradebook_grades' ? [record.student_id, record.assignment_id] : record.id;
        applied += (await this._applyOp({ table: t, op: 'put', key, record }, snap.deviceId, pending)).applied;
      }
    }

    if (data.extra?.vault_ops && this.onVaultOp) {
      for (const op of data.extra.vault_ops) await this.onVaultOp(op);
    }

    const vector = await this.vector();
    for (const [dev, seq] of Object.entries(data.vector || {})) {
      if (dev !== this.deviceId) vector[dev] = Math.max(vector[dev] || 0, seq);
    }
    await this.store.setMetadata(this._vectorKey, vector);

    // GC tombstones older than 180 days
    if (typeof this.store.pruneTombstones === 'function') {
      const cutoff = new Date(Date.now() - 180 * 86400000).toISOString();
      await this.store.pruneTombstones(cutoff);
    }

    return { applied };
  }

  _inScopeSync(table, record) {
    if (!this.courseId) return true;
    if (table === 'gradebook_courses') return record.id === this.courseId;
    return (record.course_id || record.class_id || record.gradebook?.course_id) === this.courseId;
  }

  async pruneOwnChunks(throughSeq) {
    return this.channel.deleteChunks({ deviceId: this.deviceId, throughSeq });
  }
}

function b64ToBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
