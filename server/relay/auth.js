import { createHash, randomBytes } from 'node:crypto';

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
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
export function extractBearerToken(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (!auth) return null;
  const match = String(auth).match(/^Bearer\s+([A-Za-z0-9_\-\.]+)/i);
  return match ? match[1] : null;
}
