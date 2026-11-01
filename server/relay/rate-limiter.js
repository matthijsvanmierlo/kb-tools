import { createHash, randomBytes } from 'node:crypto';
import { SUBMISSION_RATE_LIMIT_PER_MIN } from './limits.js';

export const RATE_LIMIT_MAX = 30; // 30 requests per window
export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const DRAFT_RATE_LIMIT_MAX = 600;

/**
 * In-memory / optional DB rate limiter for public endpoints.
 * Keyed by route class + target ID + salted hash of IP.
 */
export class RateLimiter {
  constructor(limit = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS, db = null) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.db = db;
    this.clients = new Map();
    this.salt = randomBytes(16).toString('hex');
  }

  _key(id) {
    return createHash('sha256').update(`${this.salt}|${id}`).digest('hex').slice(0, 24);
  }

  sweep(now = Date.now()) {
    for (const [k, e] of this.clients) {
      if (now > e.resetAt) this.clients.delete(k);
    }
  }

  isAllowed(identifier, customLimit = this.limit) {
    const now = Date.now();
    if (this.clients.size > 5000) this.sweep(now);
    const key = this._key(identifier);
    const entry = this.clients.get(key);
    if (!entry || now > entry.resetAt) {
      this.clients.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= customLimit) {
      return false;
    }
    entry.count += 1;
    return true;
  }

  async isAllowedAsync(identifier, customLimit = this.limit) {
    if (!this.db || !this.db.raw) {
      return this.isAllowed(identifier, customLimit);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const key = this._key(identifier);
    const target = this.db.raw;

    try {
      if (typeof target.prepare === 'function') {
        const prep = target.prepare('SELECT count, expires_at FROM rate_buckets WHERE key = ?');
        let row;
        if (typeof prep.bind === 'function') {
          row = await prep.bind(key).first();
        } else {
          row = prep.get(key);
        }

        if (!row || nowSec > row.expires_at) {
          const insertStmt = target.prepare('INSERT INTO rate_buckets (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, expires_at = excluded.expires_at');
          if (typeof insertStmt.bind === 'function') {
            await insertStmt.bind(key, nowSec + 60).run();
          } else {
            insertStmt.run(key, nowSec + 60);
          }
          return true;
        }

        if (row.count >= customLimit) {
          return false;
        }

        const updateStmt = target.prepare('UPDATE rate_buckets SET count = count + 1 WHERE key = ?');
        if (typeof updateStmt.bind === 'function') {
          await updateStmt.bind(key).run();
        } else {
          updateStmt.run(key);
        }
        return true;
      }
    } catch (_) {
      // Fallback to in-memory
    }
    return this.isAllowed(identifier, customLimit);
  }
}
