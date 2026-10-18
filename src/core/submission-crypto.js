/**
 * SubmissionCrypto - KB-CORE-006
 *
 * Zero-server cryptography for student work flowing back to the teacher:
 *
 *  1. Confidentiality — every submission is encrypted to the teacher's ECDH P-256 public key
 *     (ECIES: ephemeral ECDH → HKDF-SHA-256 → AES-256-GCM). Only the teacher's device, which holds
 *     the private key, can read it. Classmates passing files around learn nothing.
 *  2. Identity — the payload carries an HMAC-SHA-256 keyed by the student's private access code
 *     (PBKDF2-stretched). The teacher re-derives it from the code stored in the roster, so a
 *     submission made under another student's name is flagged unless the code was known.
 *  3. Score integrity — the teacher never trusts a score computed in the student's browser. The
 *     answer key stays on the teacher's device and every submission is re-graded on import.
 *
 * Self-describing envelopes are serialized as compact JSON and can be downloaded as `.kbsub`
 * files or copied as text for pasting into an LMS.
 */

import { KeyVault } from './keyvault.js';

const subtle = () => {
  const s = typeof crypto !== 'undefined' ? crypto.subtle : globalThis.crypto?.subtle;
  if (!s) throw new Error('Web Crypto API is not available');
  return s;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToB64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64ToBytes(b64) {
  const norm = String(b64).replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '==='.slice((norm.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(text) {
  const buf = await subtle().digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministic JSON (sorted keys) so HMACs survive re-serialization.
 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

export const SUBMISSION_FILE_EXT = '.kbsub';

const isCryptoKey = (k) => Boolean(k && typeof k === 'object' && 'algorithm' in k && 'usages' in k && 'type' in k);

export class SubmissionCrypto {
  // ---------------------------------------------------------------------------
  // Teacher key pair
  // ---------------------------------------------------------------------------

  static async generateKeyPair() {
    const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const [publicJwk, privateJwk] = await Promise.all([
      subtle().exportKey('jwk', pair.publicKey),
      subtle().exportKey('jwk', pair.privateKey)
    ]);
    return {
      publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
      privateJwk,
      fingerprint: await this.fingerprint(publicJwk),
      created_at: new Date().toISOString()
    };
  }

  /** Short, human-comparable fingerprint of a public key (e.g. "4F2A-91C0") */
  static async fingerprint(publicJwk) {
    const hex = await sha256Hex(`${publicJwk.crv}|${publicJwk.x}|${publicJwk.y}`);
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`.toUpperCase();
  }

  /**
   * Load the teacher key pair, creating it on first use: `{ publicJwk, fingerprint, privateKey }`.
   * The private key is a non-extractable CryptoKey kept by the KeyVault; backups carry it only
   * encrypted under the teacher's recovery code.
   * @param {{ getMetadata: Function, setMetadata: Function }} store
   */
  static async getOrCreateTeacherKeys(store) {
    return KeyVault.getTeacherKeys(store);
  }

  // ---------------------------------------------------------------------------
  // Identity: access-code HMAC
  // ---------------------------------------------------------------------------

  static normalizeAccessCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  static async _hmacKey(accessCode, saltText) {
    const material = await subtle().importKey('raw', enc.encode(this.normalizeAccessCode(accessCode)), { name: 'PBKDF2' }, false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'PBKDF2', salt: enc.encode(`kb-sub|${saltText}`), iterations: 100000, hash: 'SHA-256' },
      material,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify']
    );
  }

  /**
   * Sign a submission body with the student's access code.
   * @param {object} body - must contain assignment_id and student_id
   */
  static async signWithAccessCode(body, accessCode) {
    const key = await this._hmacKey(accessCode, `${body.assignment_id}|${String(body.student_id).toUpperCase()}`);
    const sig = await subtle().sign('HMAC', key, enc.encode(canonicalJSON(body)));
    return bytesToB64(sig);
  }

  static async verifyAccessCodeSignature(body, signature, accessCode) {
    if (!signature || !accessCode) return false;
    try {
      const key = await this._hmacKey(accessCode, `${body.assignment_id}|${String(body.student_id).toUpperCase()}`);
      return await subtle().verify('HMAC', key, b64ToBytes(signature), enc.encode(canonicalJSON(body)));
    } catch (_) {
      return false;
    }
  }

  /**
   * Short check value published with an assignment so the student's browser can catch a mistyped
   * access code before submitting. Only 16 bits are exposed, which is enough to catch typos while
   * revealing almost nothing that would help guess a code.
   */
  static async accessCodeCheck(assignmentId, studentId, accessCode) {
    const hex = await sha256Hex(`kb-check|${assignmentId}|${String(studentId).toUpperCase()}|${this.normalizeAccessCode(accessCode)}`);
    return hex.slice(0, 4);
  }

  // ---------------------------------------------------------------------------
  // Confidentiality: ECIES envelope
  // ---------------------------------------------------------------------------

  static async _deriveAesKey(privateKey, publicKey, info) {
    const bits = await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    const hkdfKey = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt any JSON-serializable object to the teacher's public key.
   * @param {object} teacherPublicJwk
   * @param {object} plainObject
   * @param {object} [header] - unencrypted routing hints (e.g. assignment_id); never put answers here
   * @returns {Promise<object>} envelope
   */
  static async encryptForTeacher(teacherPublicJwk, plainObject, header = {}) {
    const recipient = await subtle().importKey('jwk', { ...teacherPublicJwk, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const eph = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const ephPublicJwk = await subtle().exportKey('jwk', eph.publicKey);
    const headerJson = canonicalJSON(header);
    const aesKey = await this._deriveAesKey(eph.privateKey, recipient, 'kb-submission-v1');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(headerJson) },
      aesKey,
      enc.encode(JSON.stringify(plainObject))
    );
    return {
      kbsub: 1,
      header,
      epk: { kty: ephPublicJwk.kty, crv: ephPublicJwk.crv, x: ephPublicJwk.x, y: ephPublicJwk.y },
      iv: bytesToB64(iv),
      ct: bytesToB64(ct)
    };
  }

  /**
   * Decrypt an envelope with the teacher's private key (a CryptoKey from the KeyVault, or a JWK).
   * The header is authenticated, so a tampered routing header causes decryption to fail.
   */
  static async decryptFromStudent(teacherPrivateKey, envelope) {
    if (!envelope || envelope.kbsub !== 1 || !envelope.epk || !envelope.ct) {
      throw new Error('NOT_A_SUBMISSION');
    }
    const priv = isCryptoKey(teacherPrivateKey)
      ? teacherPrivateKey
      : await subtle().importKey('jwk', teacherPrivateKey, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const ephPub = await subtle().importKey('jwk', { ...envelope.epk, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const aesKey = await this._deriveAesKey(priv, ephPub, 'kb-submission-v1');
    try {
      const pt = await subtle().decrypt(
        { name: 'AES-GCM', iv: b64ToBytes(envelope.iv), additionalData: enc.encode(canonicalJSON(envelope.header || {})) },
        aesKey,
        b64ToBytes(envelope.ct)
      );
      return JSON.parse(dec.decode(pt));
    } catch (_) {
      throw new Error('DECRYPTION_FAILED');
    }
  }

  // ---------------------------------------------------------------------------
  // Text transport (.kbsub files and copy/paste)
  // ---------------------------------------------------------------------------

  static serializeEnvelope(envelope) {
    return `KBSUB1.${bytesToB64(enc.encode(JSON.stringify(envelope)))}`;
  }

  /** Accepts the KBSUB1 text form or raw envelope JSON (as found in a .kbsub file) */
  static parseEnvelope(text) {
    const trimmed = String(text || '').trim();
    if (trimmed.startsWith('KBSUB1.')) {
      return JSON.parse(dec.decode(b64ToBytes(trimmed.slice(7).replace(/\s+/g, ''))));
    }
    return JSON.parse(trimmed);
  }

  // ---------------------------------------------------------------------------
  // Answer-key hashing for instant student feedback
  // ---------------------------------------------------------------------------

  /**
   * Salted hash of a normalized answer, so a published assignment can check answers locally
   * without shipping the key in plain text. Teachers re-grade from the true key on import.
   */
  static async hashAnswer(salt, normalizedAnswer) {
    return (await sha256Hex(`kb-ans|${salt}|${normalizedAnswer}`)).slice(0, 24);
  }
}

export default SubmissionCrypto;
