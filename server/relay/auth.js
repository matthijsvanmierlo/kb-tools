import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Hash a plain bearer token using SHA-256 for secure storage.
 * @param {string} token
 * @returns {string} Hex encoded hash
 */
export function hashToken(token) {
  return createHash('sha256').update(String(token || '').trim()).digest('hex');
}

/**
 * Generate a random 32-byte secret token for teachers.
 * @returns {string} Hex encoded 64-character token
 */
export function generateToken() {
  return randomBytes(32).toString('hex');
}

/**
 * Extract bearer token string from request Authorization header.
 * Works with Node.js IncomingMessage (req.headers), Web Standard Request, or Headers.
 * @param {any} req
 * @returns {string|null}
 */
export function extractBearerToken(req) {
  if (!req) return null;
  let auth = '';
  if (typeof req.headers?.get === 'function') {
    auth = req.headers.get('authorization') || '';
  } else if (req.headers && typeof req.headers === 'object') {
    auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  } else if (typeof req === 'string') {
    auth = req;
  }
  if (!auth) return null;
  const match = String(auth).match(/^Bearer\s+([A-Za-z0-9_\-\.]+)/i);
  return match ? match[1] : null;
}

/**
 * Constant-time comparison of two hex-encoded hashes to prevent timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export const CONNECT_CAPSULE_PREFIX = 'KBCON1.';

/**
 * Encode { relayUrl, baseUrl, token, teacherId, name } into an opaque URL-safe capsule.
 * @param {{ relayUrl?: string, baseUrl?: string, token: string, teacherId?: string, name?: string }} param0
 * @returns {string}
 */
export function encodeConnectCapsule({ relayUrl, baseUrl, token, teacherId, name }) {
  const url = relayUrl || baseUrl || '';
  const payload = JSON.stringify({
    v: 1,
    r: String(url || '').replace(/\/+$/, ''),
    t: String(token || '').trim(),
    id: String(teacherId || '').trim(),
    n: String(name || '').trim() || undefined
  });
  return CONNECT_CAPSULE_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decode a KBCON1. capsule string.
 * @param {string} capsuleStr
 * @returns {{ baseUrl: string, relayUrl: string, token: string, teacherId?: string, name?: string }|null}
 */
export function decodeConnectCapsule(capsuleStr) {
  const raw = String(capsuleStr || '').trim();
  if (!raw.startsWith(CONNECT_CAPSULE_PREFIX)) return null;
  try {
    const jsonStr = Buffer.from(raw.slice(CONNECT_CAPSULE_PREFIX.length), 'base64url').toString('utf8');
    const parsed = JSON.parse(jsonStr);
    if (!parsed || !parsed.r || !parsed.t) return null;
    return {
      baseUrl: parsed.r,
      relayUrl: parsed.r,
      token: parsed.t,
      teacherId: parsed.id || undefined,
      name: parsed.n || undefined
    };
  } catch (_) {
    return null;
  }
}

/**
 * Generate a 12-character Crockford Base32 one-time claim code: KBC-XXXX-XXXX-XXXX
 * @returns {string}
 */
export function generateClaimCode() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = randomBytes(12);
  let chars = '';
  for (let i = 0; i < 12; i++) chars += alphabet[bytes[i] & 31];
  return `KBC-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/**
 * Normalize human-entered claim code (strips KBC prefix, dashes, spaces; maps O->0, I/L->1).
 * @param {string} code
 * @returns {string}
 */
export function normalizeClaimCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/^KBC-?/i, '')
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/**
 * Hash a normalized claim code using SHA-256 for database storage and verification.
 * @param {string} code
 * @returns {string}
 */
export function hashClaimCode(code) {
  return hashToken(normalizeClaimCode(code));
}
