import { createHash, randomBytes } from 'node:crypto';

export const RATE_LIMIT_MAX = 30; // 30 requests per window
export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const DRAFT_RATE_LIMIT_MAX = 600;

/**
 * In-memory rate limiter for public endpoints. Clients are keyed by a salted hash of their IP
 * (the salt is random per process/isolate), and entries are dropped when their window ends, so the relay
 * never keeps students' IP addresses, not even in memory.
 */
export class RateLimiter {
  constructor(limit = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clients = new Map();
    this.salt = randomBytes(16).toString('hex');
  }

  _key(ip) {
    return createHash('sha256').update(`${this.salt}|${ip}`).digest('hex').slice(0, 24);
  }

  sweep(now = Date.now()) {
    for (const [k, e] of this.clients) {
      if (now > e.resetAt) this.clients.delete(k);
    }
  }

  isAllowed(ip) {
    const now = Date.now();
    if (this.clients.size > 5000) this.sweep(now);
    const key = this._key(ip);
    const entry = this.clients.get(key);
    if (!entry || now > entry.resetAt) {
      this.clients.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.limit) {
      return false;
    }
    entry.count += 1;
    return true;
  }
}
