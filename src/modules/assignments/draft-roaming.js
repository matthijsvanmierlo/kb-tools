/**
 * Draft roaming: a student who starts an assignment on one Chromebook can continue on another.
 *
 * When the assignment has a relay drop box and the student entered their access code, the draft
 * is also saved to the relay, encrypted with a key derived from the access code. The relay
 * address of the draft is derived the same way, so the server can neither read a draft nor tell
 * whose it is. Without an access code nothing leaves the device (the address would be guessable).
 */
import { bytesToB64, b64ToBytes } from '../../core/submission-crypto.js';
import { normalizeAccessCode } from '../../core/access-codes.js';
import { RelayTransport } from '../../core/transport.js';

export const DRAFT_PREFIX = 'KBDRAFT1.';
const PBKDF2_ITERATIONS = 100000;
const SAVE_DELAY_MS = 20000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * @returns {Promise<{ id: string, key: CryptoKey, aad: Uint8Array }>} id is 64 hex characters
 */
export async function deriveDraftSecrets({ assignmentId, publishVersion, studentId, accessCode }) {
  const sid = String(studentId || '').trim().toUpperCase();
  const material = await crypto.subtle.importKey('raw', enc.encode(normalizeAccessCode(accessCode)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(`kb-draft|${assignmentId}|${sid}`), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    512
  ));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const id = Array.from(bits.slice(32), b => b.toString(16).padStart(2, '0')).join('');
  return { id, key, aad: enc.encode(`kb-draft-v1|${assignmentId}|${publishVersion}|${sid}`) };
}

export async function sealDraft(secrets, draft) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: secrets.aad }, secrets.key, enc.encode(JSON.stringify(draft))));
  return `${DRAFT_PREFIX}${bytesToB64(new Uint8Array([...iv, ...ct]))}`;
}

export async function openDraft(secrets, text) {
  if (!String(text || '').startsWith(DRAFT_PREFIX)) return null;
  try {
    const box = b64ToBytes(text.slice(DRAFT_PREFIX.length));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.slice(0, 12), additionalData: secrets.aad }, secrets.key, box.slice(12));
    return JSON.parse(dec.decode(pt));
  } catch (_) {
    return null;
  }
}

/** Debounced save/load of one student's draft for one assignment version */
export class DraftRoamer {
  /**
   * @param {object} opts
   * @param {{ base_url?: string, drop_id: string, drop_secret?: string }} opts.relay - from the assignment payload
   * @param {string} opts.assignmentId
   * @param {number} opts.publishVersion
   * @param {string} opts.studentId
   * @param {string} opts.accessCode
   * @param {object} [opts.transport] - injectable for tests
   */
  constructor({ relay, assignmentId, publishVersion, studentId, accessCode, transport = null }) {
    this.dropId = relay.drop_id;
    this.dropOpts = { dropSecret: relay.drop_secret || null };
    this.transport = transport || new RelayTransport({ baseUrl: relay.base_url || '' });
    this.params = { assignmentId, publishVersion, studentId, accessCode };
    this._secrets = null;
    this._timer = null;
    this._pending = null;
  }

  static canRoam(payload, accessCode) {
    return Boolean(payload?.relay?.drop_id && normalizeAccessCode(accessCode));
  }

  async _getSecrets() {
    this._secrets ??= await deriveDraftSecrets(this.params);
    return this._secrets;
  }

  /** The newest saved draft, or null (none, unreadable, or the work was already handed in) */
  async load() {
    const secrets = await this._getSecrets();
    const row = await this.transport.getDraft(this.dropId, secrets.id, this.dropOpts);
    if (!row) return null;
    const draft = await openDraft(secrets, row.ciphertext);
    return draft && !draft.submitted ? draft : null;
  }

  schedule(draft) {
    this._pending = draft;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush().catch(() => {}), SAVE_DELAY_MS);
  }

  async flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this._pending) return;
    const draft = this._pending;
    this._pending = null;
    const secrets = await this._getSecrets();
    await this.transport.putDraft(this.dropId, secrets.id, await sealDraft(secrets, draft), this.dropOpts);
  }

  /** After handing in: overwrite the draft so another device doesn't offer stale answers */
  async markSubmitted() {
    this._pending = { submitted: true, saved_at: new Date().toISOString() };
    await this.flush();
  }
}
