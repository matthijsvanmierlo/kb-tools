/**
 * One-time key exchange for linking a teacher's devices and inviting co-teachers.
 *
 *   1. The receiving device makes a one-time ECDH key and shows it as an "offer" (QR or text).
 *   2. The sending device makes its own one-time key, derives the shared secret and returns an
 *      "answer": its public key plus the payload encrypted with AES-256-GCM.
 *   3. The receiver derives the same secret and decrypts.
 *
 * Both screens show a 6-digit safety number computed from both public keys. If they match, no one
 * swapped a QR code in between. The private keys live only in memory for the length of the dialog.
 */
import { bytesToB64, b64ToBytes, sha256Hex } from '../submission-crypto.js';

const PURPOSES = {
  device: { prefix: 'KBLINK1', info: 'kb-link-device-v1' },
  coteacher: { prefix: 'KBJOIN1', info: 'kb-join-class-v1' }
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export class LinkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LinkError';
    this.code = code;
  }
}

function purposeOf(name) {
  const p = PURPOSES[name];
  if (!p) throw new Error(`Unknown link purpose ${name}`);
  return p;
}

const clean = (code) => String(code || '').replace(/\s+/g, '');

/** @returns {Promise<{ code: string, purpose: string, privateKey: CryptoKey, publicRaw: Uint8Array }>} */
export async function createOffer(purpose) {
  const { prefix } = purposeOf(purpose);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { code: `${prefix}.${bytesToB64(publicRaw)}`, purpose, privateKey: pair.privateKey, publicRaw };
}

function parsePoint(b64) {
  let raw;
  try {
    raw = b64ToBytes(b64);
  } catch (_) {
    raw = null;
  }
  if (!raw || raw.length !== 65 || raw[0] !== 4) throw new LinkError('BAD_CODE', 'That code is incomplete or damaged.');
  return raw;
}

export function parseOffer(code, purpose) {
  const { prefix } = purposeOf(purpose);
  const text = clean(code);
  if (!text.startsWith(`${prefix}.`)) {
    const other = Object.entries(PURPOSES).find(([, p]) => text.startsWith(`${p.prefix}.`));
    throw new LinkError('WRONG_KIND', other
      ? (purpose === 'device' ? 'That is a co-teacher invite code, not a device link code.' : 'That is a device link code, not a co-teacher code.')
      : 'That is not a KennisBoost link code.');
  }
  return parsePoint(text.slice(prefix.length + 1));
}

async function sharedKey(privateKey, peerRaw, offerRaw, answerRaw, info) {
  const peer = await crypto.subtle.importKey('raw', peerRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const salt = new Uint8Array([...offerRaw, ...answerRaw]);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** "123 456": the same on both devices only if each saw the other's real public key */
export async function safetyNumber(offerRaw, answerRaw) {
  const hex = await sha256Hex(`kb-safety|${bytesToB64(offerRaw)}|${bytesToB64(answerRaw)}`);
  const n = String(parseInt(hex.slice(0, 12), 16) % 1000000).padStart(6, '0');
  return `${n.slice(0, 3)} ${n.slice(3)}`;
}

/**
 * Sender side: encrypt `payload` for the device that showed `offerCode`.
 * @returns {Promise<{ code: string, safety: string }>}
 */
export async function answerOffer(offerCode, payload, purpose) {
  const { prefix, info } = purposeOf(purpose);
  const offerRaw = parseOffer(offerCode, purpose);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const answerRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const key = await sharedKey(pair.privateKey, offerRaw, offerRaw, answerRaw, info);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(info) }, key, enc.encode(JSON.stringify(payload))));
  return {
    code: `${prefix}A.${bytesToB64(answerRaw)}.${bytesToB64(new Uint8Array([...iv, ...ct]))}`,
    safety: await safetyNumber(offerRaw, answerRaw)
  };
}

/**
 * Receiver side: open the answer to an offer this device made.
 * @returns {Promise<{ payload: any, safety: string }>}
 */
export async function openAnswer(offer, answerCode) {
  const { prefix, info } = purposeOf(offer.purpose);
  const text = clean(answerCode);
  if (!text.startsWith(`${prefix}A.`)) throw new LinkError('WRONG_KIND', 'That is not the reply code for this screen.');
  const [pointB64, boxB64] = text.slice(prefix.length + 2).split('.');
  const answerRaw = parsePoint(pointB64);
  const box = b64ToBytes(boxB64 || '');
  const key = await sharedKey(offer.privateKey, answerRaw, offer.publicRaw, answerRaw, info);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.slice(0, 12), additionalData: enc.encode(info) }, key, box.slice(12));
    return { payload: JSON.parse(dec.decode(pt)), safety: await safetyNumber(offer.publicRaw, answerRaw) };
  } catch (_) {
    throw new LinkError('NOT_FOR_THIS_SCREEN', 'That reply was made for a different code. Start again on both devices.');
  }
}
