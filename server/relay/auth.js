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
