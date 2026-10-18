import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { createDatabase } from './db.js';
import { extractBearerToken, hashToken } from './auth.js';

const VERSION = '1.0.0';
const DEFAULT_PORT = 3000;
const MAX_PAYLOAD_SIZE = 512 * 1024; // 512 KB
const MAX_SUBMISSION_SIZE = 256 * 1024; // 256 KB
const RATE_LIMIT_MAX = 30; // 30 requests per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

/**
 * In-memory IP rate limiter for public submission endpoints.
 */
class RateLimiter {
  constructor(limit = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clients = new Map();
  }

  isAllowed(ip) {
    const now = Date.now();
    const entry = this.clients.get(ip);
    if (!entry || now > entry.resetAt) {
      this.clients.set(ip, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.limit) {
      return false;
    }
    entry.count += 1;
    return true;
  }
}

/**
 * Read request body with size enforcement.
 * @param {http.IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];

    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        const err = new Error('PAYLOAD_TOO_LARGE');
        err.code = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', reject);
  });
}

/**
 * Create and configure relay HTTP server.
 * @param {{ dbPath?: string, port?: number, origins?: string }} [opts]
 * @returns {{ server: http.Server, db: any, close: () => Promise<void> }}
 */
export function createRelayServer(opts = {}) {
  const dbPath = opts.dbPath || process.env.KB_RELAY_DB || ':memory:';
  const originsEnv = opts.origins ?? process.env.KB_RELAY_ORIGINS;
  const allowedOrigins = originsEnv ? originsEnv.split(',').map(s => s.trim()) : ['*'];

  const db = createDatabase(dbPath);
  const limiter = new RateLimiter();

  // Hourly pruning
  const pruneInterval = setInterval(() => {
    try {
      db.pruneExpired();
    } catch (e) {
      console.error('[Relay] Prune error:', e);
    }
  }, 3600 * 1000);
  if (pruneInterval.unref) pruneInterval.unref();

  const server = http.createServer(async (req, res) => {
    const origin = req.headers['origin'] || '*';
    const isOriginAllowed = allowedOrigins.includes('*') || allowedOrigins.includes(origin);

    if (isOriginAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    const sendError = (status, message) => {
      sendJson(status, { error: message });
    };

    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      let pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
      // Normalize /api/v1 prefix so endpoints can be reached with or without it
      if (pathname.startsWith('/api/v1/')) {
        pathname = pathname.slice('/api/v1'.length);
      } else if (pathname === '/api/v1') {
        pathname = '/';
      }

      // 1. GET /health
      if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
        sendJson(200, { ok: true, version: VERSION, features: ['payloads', 'drops'] });
        return;
      }

      // Teacher authentication helper
      const authenticateTeacher = () => {
        const token = extractBearerToken(req);
        if (!token) return null;
        const hash = hashToken(token);
        return db.teachers.getByTokenHash(hash);
      };

      // 2. POST /payloads
      if (req.method === 'POST' && pathname === '/payloads') {
        const teacher = authenticateTeacher();
        if (!teacher) {
          sendError(401, 'Unauthorized: valid teacher token required');
          return;
        }

        const rawBody = await readBody(req, MAX_PAYLOAD_SIZE);
        let parsed;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          sendError(400, 'Invalid JSON body');
          return;
        }

        if (!parsed.kind || !parsed.ciphertext) {
          sendError(400, 'Missing kind or ciphertext in payload');
          return;
        }

        const ref = randomBytes(16).toString('base64url').slice(0, 22);
        db.payloads.create({
          ref,
          teacherId: teacher.id,
          kind: parsed.kind,
          ciphertext: parsed.ciphertext,
          meta: parsed.meta,
          expiresAt: parsed.expires_at || null
        });

        sendJson(201, { ref });
        return;
      }

      // 3. GET /payloads/:ref
      const payloadMatch = pathname.match(/^\/payloads\/([A-Za-z0-9_\-]+)$/);
      if (req.method === 'GET' && payloadMatch) {
        const ref = payloadMatch[1];
        const row = db.payloads.get(ref);
        if (!row) {
          sendError(404, 'Payload not found');
          return;
        }
        if (row.expired) {
          sendError(410, 'Payload expired');
          return;
        }

        sendJson(200, {
          kind: row.kind,
          ciphertext: row.ciphertext
        });
        return;
      }

      // 4. POST /drops
      if (req.method === 'POST' && pathname === '/drops') {
        const teacher = authenticateTeacher();
        if (!teacher) {
          sendError(401, 'Unauthorized: valid teacher token required');
          return;
        }

        const rawBody = await readBody(req, MAX_PAYLOAD_SIZE);
        let parsed;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          sendError(400, 'Invalid JSON body');
          return;
        }

        if (!parsed.assignment_id) {
          sendError(400, 'Missing assignment_id');
          return;
        }

        const dropId = randomBytes(12).toString('hex');
        db.drops.create({
          id: dropId,
          teacherId: teacher.id,
          assignmentId: parsed.assignment_id,
          publishVersion: parsed.publish_version ?? null,
          expiresAt: parsed.expires_at || null
        });

        sendJson(201, { drop_id: dropId });
        return;
      }

      // 5. POST /drops/:dropId/submissions
      const dropSubmitMatch = pathname.match(/^\/drops\/([A-Za-z0-9_\-]+)\/submissions$/);
      if (req.method === 'POST' && dropSubmitMatch) {
        const clientIp = req.socket.remoteAddress || '127.0.0.1';
        if (!limiter.isAllowed(clientIp)) {
          sendError(429, 'Rate limit exceeded. Please wait a minute before submitting again.');
          return;
        }

        const dropId = dropSubmitMatch[1];
        const drop = db.drops.get(dropId);
        if (!drop) {
          sendError(404, 'Drop box not found');
          return;
        }
        if (drop.expired) {
          sendError(410, 'Drop box expired');
          return;
        }

        const rawBody = await readBody(req, MAX_SUBMISSION_SIZE);
        const trimmed = rawBody.trim();
        if (!trimmed.startsWith('KBSUB1.')) {
          sendError(400, 'Invalid submission format: envelope must start with KBSUB1.');
          return;
        }

        const receiptId = createHash('sha256').update(trimmed).digest('hex').slice(0, 8).toUpperCase();
        const submissionId = randomBytes(16).toString('hex');
        const resEntry = db.submissions.create({
          id: submissionId,
          dropId,
          text: trimmed
        });

        sendJson(201, {
          receipt_id: receiptId,
          received_at: resEntry.receivedAt
        });
        return;
      }

      // 6. GET /drops/:dropId/submissions
      if (req.method === 'GET' && dropSubmitMatch) {
        const teacher = authenticateTeacher();
        if (!teacher) {
          sendError(401, 'Unauthorized: valid teacher token required');
          return;
        }

        const dropId = dropSubmitMatch[1];
        const drop = db.drops.get(dropId);
        if (!drop) {
          sendError(404, 'Drop box not found');
          return;
        }
        if (drop.teacher_id !== teacher.id) {
          sendError(403, 'Forbidden: you do not own this drop box');
          return;
        }

        const since = parsedUrl.searchParams.get('since') || undefined;
        const items = db.submissions.list(dropId, { since });
        sendJson(200, { items });
        return;
      }

      // 7. DELETE /drops/:dropId
      const dropDeleteMatch = pathname.match(/^\/drops\/([A-Za-z0-9_\-]+)$/);
      if (req.method === 'DELETE' && dropDeleteMatch) {
        const teacher = authenticateTeacher();
        if (!teacher) {
          sendError(401, 'Unauthorized: valid teacher token required');
          return;
        }

        const dropId = dropDeleteMatch[1];
        const deleted = db.drops.delete(dropId, teacher.id);
        if (!deleted) {
          sendError(404, 'Drop not found or not owned by you');
          return;
        }

        res.writeHead(204);
        res.end();
        return;
      }

      sendError(404, 'Route not found');
    } catch (err) {
      if (err.code === 413 || err.message === 'PAYLOAD_TOO_LARGE') {
        sendError(413, 'Payload too large');
      } else {
        console.error('[Relay Server Error]', err);
        sendError(500, 'Internal server error');
      }
    }
  });

  return {
    server,
    db,
    close: () => {
      clearInterval(pruneInterval);
      return new Promise((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    }
  };
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('server/relay/index.js')) {
  const port = parseInt(process.env.PORT || process.env.KB_RELAY_PORT || String(DEFAULT_PORT), 10);
  const dbPath = process.env.KB_RELAY_DB || './data/relay.sqlite';
  const instance = createRelayServer({ dbPath, port });
  instance.server.listen(port, () => {
    const actualPort = instance.server.address().port;
    console.log(`[KennisBoost Relay Server] listening on http://localhost:${actualPort}`);
    console.log(`[KennisBoost Relay Server] SQLite database: ${dbPath}`);
  });
}
