import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createDatabase } from './db.js';
import { extractBearerToken, hashToken } from './auth.js';

const VERSION = '1.0.0';
const DEFAULT_PORT = 3000;
const MAX_PAYLOAD_SIZE = 512 * 1024; // 512 KB
const MAX_SUBMISSION_SIZE = 256 * 1024; // 256 KB
const RATE_LIMIT_MAX = 30; // 30 requests per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
// A whole class behind one school IP autosaves drafts, so this limit is per IP but generous
const DRAFT_RATE_LIMIT_MAX = 600;
const MAX_DRAFT_SIZE = 256 * 1024; // 256 KB
const MAX_SYNC_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
const MAX_SYNC_SNAPSHOT_SIZE = 32 * 1024 * 1024; // 32 MB
const DEVICE_ID_RE = /^[0-9A-Za-z-]{8,64}$/;
const DRAFT_ID_RE = /^[0-9a-f]{64}$/;

const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');

function sameHash(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const DEFAULT_RETENTION_DAYS = 180;

/**
 * In-memory rate limiter for public endpoints. Clients are keyed by a salted hash of their IP
 * (the salt is random per process), and entries are dropped when their window ends, so the relay
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
    for (const [k, e] of this.clients) if (now > e.resetAt) this.clients.delete(k);
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
 * Create and configure the relay server.
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @param {string} [opts.origins] - comma-separated CORS origins (default *)
 * @param {number} [opts.retentionDays] - delete submissions, drafts and sync chunks older than this (0 = keep)
 * @param {{ cert: string|Buffer, key: string|Buffer }} [opts.tls] - serve HTTPS (needed on a LAN for PWAs)
 * @param {(req, res) => void} [opts.appHandler] - also serve the KennisBoost app for non-/api/ paths,
 *   so app and relay share one origin and the CSP needs no extra entries
 * @returns {{ server: http.Server|https.Server, db: any, limiters: RateLimiter[], close: () => Promise<void> }}
 */
export function createRelayServer(opts = {}) {
  const dbPath = opts.dbPath || process.env.KB_RELAY_DB || ':memory:';
  const originsEnv = opts.origins ?? process.env.KB_RELAY_ORIGINS;
  const allowedOrigins = originsEnv ? originsEnv.split(',').map(s => s.trim()) : ['*'];
  const retentionEnv = process.env.KB_RELAY_RETENTION_DAYS;
  const retentionDays = opts.retentionDays ?? (retentionEnv !== undefined ? Number(retentionEnv) : DEFAULT_RETENTION_DAYS);

  const db = createDatabase(dbPath);
  const limiter = new RateLimiter();
  const draftLimiter = new RateLimiter(DRAFT_RATE_LIMIT_MAX);

  // Hourly pruning of expired data and rate-limit entries
  const prune = () => {
    try {
      db.pruneExpired({ retentionDays });
      limiter.sweep();
      draftLimiter.sweep();
    } catch (e) {
      console.error('[Relay] Prune error:', e);
    }
  };
  prune();
  const pruneInterval = setInterval(prune, 3600 * 1000);
  if (pruneInterval.unref) pruneInterval.unref();

  const handler = async (req, res) => {
    if (opts.appHandler && !String(req.url || '').startsWith('/api/')) {
      opts.appHandler(req, res);
      return;
    }

    const origin = req.headers['origin'] || '*';
    const isOriginAllowed = allowedOrigins.includes('*') || allowedOrigins.includes(origin);

    if (isOriginAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-KB-Workspace-Key, X-KB-Drop-Secret');
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
        sendJson(200, { ok: true, version: VERSION, features: ['payloads', 'drops', 'drafts', 'sync'] });
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

      // Drops created with a secret only accept submissions and drafts that present it. The drop id
      // shows up in the teacher's listing URLs; the secret travels only in a header.
      const dropSecretOk = (drop) => !drop.secret_hash
        || sameHash(drop.secret_hash, sha256(req.headers['x-kb-drop-secret'] || ''));

      const readJson = async (max) => {
        try {
          return JSON.parse(await readBody(req, max));
        } catch (err) {
          if (err.code === 413) throw err;
          return null;
        }
      };

      // Sync workspaces (multi-device / co-teacher replication). Bodies are ciphertext.
      if (req.method === 'POST' && pathname === '/sync') {
        const teacher = authenticateTeacher();
        if (!teacher) {
          sendError(401, 'Unauthorized: valid teacher token required');
          return;
        }
        const workspaceId = randomBytes(12).toString('hex');
        const workspaceKey = randomBytes(32).toString('hex');
        db.workspaces.create({ id: workspaceId, keyHash: sha256(workspaceKey), createdBy: teacher.id });
        sendJson(201, { workspace_id: workspaceId, workspace_key: workspaceKey });
        return;
      }

      const syncMatch = pathname.match(/^\/sync\/([0-9a-f]{24})\/(chunks|snapshots)(?:\/([0-9A-Za-z-]{8,64}))?$/);
      if (syncMatch) {
        // Any teacher on this relay who also holds the workspace key (own devices, co-teachers)
        const teacher = authenticateTeacher();
        if (!teacher) {
          sendError(401, 'Unauthorized: valid teacher token required');
          return;
        }
        const [, workspaceId, resource, deviceParam] = syncMatch;
        const ws = db.workspaces.get(workspaceId);
        if (!ws || !sameHash(ws.key_hash, sha256(req.headers['x-kb-workspace-key'] || ''))) {
          sendError(403, 'Forbidden: unknown workspace or wrong workspace key');
          return;
        }

        if (resource === 'chunks' && !deviceParam) {
          if (req.method === 'POST') {
            const body = await readJson(MAX_SYNC_CHUNK_SIZE);
            const start = Number(body?.start);
            const end = Number(body?.end);
            if (!body || !DEVICE_ID_RE.test(body.device_id || '') || !Number.isInteger(start) || !Number.isInteger(end)
              || start < 1 || end < start || typeof body.body !== 'string') {
              sendError(400, 'Invalid sync chunk');
              return;
            }
            const { created } = db.sync.putChunk({ workspaceId, deviceId: body.device_id, start, end, body: body.body });
            sendJson(created ? 201 : 200, { ok: true });
            return;
          }
          if (req.method === 'GET') {
            const after = Math.max(0, parseInt(parsedUrl.searchParams.get('after') || '0', 10) || 0);
            sendJson(200, db.sync.listChunks(workspaceId, { after }));
            return;
          }
          if (req.method === 'DELETE') {
            const deviceId = parsedUrl.searchParams.get('device_id') || '';
            const through = parseInt(parsedUrl.searchParams.get('through') || '', 10);
            if (!DEVICE_ID_RE.test(deviceId) || !Number.isInteger(through)) {
              sendError(400, 'device_id and through are required');
              return;
            }
            sendJson(200, { deleted: db.sync.deleteChunks(workspaceId, deviceId, through) });
            return;
          }
        }

        if (resource === 'snapshots') {
          if (!deviceParam && req.method === 'GET') {
            sendJson(200, { items: db.sync.listSnapshots(workspaceId) });
            return;
          }
          if (deviceParam && req.method === 'PUT') {
            const body = await readJson(MAX_SYNC_SNAPSHOT_SIZE);
            if (!body || typeof body.body !== 'string' || typeof body.created_at !== 'string') {
              sendError(400, 'Invalid snapshot');
              return;
            }
            db.sync.putSnapshot({ workspaceId, deviceId: deviceParam, createdAt: body.created_at, body: body.body });
            sendJson(200, { ok: true });
            return;
          }
          if (deviceParam && req.method === 'GET') {
            const row = db.sync.getSnapshot(workspaceId, deviceParam);
            if (!row) {
              sendError(404, 'Snapshot not found');
              return;
            }
            sendJson(200, row);
            return;
          }
        }

        sendError(405, 'Method not allowed');
        return;
      }

      // Student draft roaming: an access-code-encrypted draft, addressed by a hash of the
      // student's identity and code, so the relay can neither read nor link it to a student
      const draftMatch = pathname.match(/^\/drops\/([A-Za-z0-9_\-]+)\/drafts\/([^/]+)$/);
      if (draftMatch && (req.method === 'PUT' || req.method === 'GET')) {
        const [, dropId, draftId] = draftMatch;
        if (!DRAFT_ID_RE.test(draftId)) {
          sendError(400, 'Invalid draft id');
          return;
        }
        const clientIp = req.socket.remoteAddress || '127.0.0.1';
        if (!draftLimiter.isAllowed(clientIp)) {
          sendError(429, 'Rate limit exceeded. Please wait a minute.');
          return;
        }
        const drop = db.drops.get(dropId);
        if (!drop) {
          sendError(404, 'Drop box not found');
          return;
        }
        if (drop.expired) {
          sendError(410, 'Drop box expired');
          return;
        }
        if (!dropSecretOk(drop)) {
          sendError(403, 'Forbidden: missing or wrong drop secret');
          return;
        }
        if (req.method === 'PUT') {
          const text = (await readBody(req, MAX_DRAFT_SIZE)).trim();
          if (!text.startsWith('KBDRAFT1.')) {
            sendError(400, 'Invalid draft format');
            return;
          }
          const { updatedAt } = db.drafts.put({ dropId, draftId, ciphertext: text });
          sendJson(200, { updated_at: updatedAt });
          return;
        }
        const row = db.drafts.get(dropId, draftId);
        if (!row) {
          sendError(404, 'No saved draft');
          return;
        }
        sendJson(200, { ciphertext: row.ciphertext, updated_at: row.updated_at });
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
        const dropSecret = randomBytes(24).toString('hex');
        db.drops.create({
          id: dropId,
          teacherId: teacher.id,
          assignmentId: parsed.assignment_id,
          publishVersion: parsed.publish_version ?? null,
          expiresAt: parsed.expires_at || null,
          secretHash: sha256(dropSecret)
        });

        sendJson(201, { drop_id: dropId, drop_secret: dropSecret });
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
        if (!dropSecretOk(drop)) {
          sendError(403, 'Forbidden: missing or wrong drop secret');
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
  };

  const server = opts.tls ? https.createServer(opts.tls, handler) : http.createServer(handler);

  return {
    server,
    db,
    limiters: [limiter, draftLimiter],
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
  const host = process.env.KB_RELAY_HOST || undefined;
  const dbPath = process.env.KB_RELAY_DB || './data/relay.sqlite';
  const certPath = process.env.KB_RELAY_TLS_CERT;
  const keyPath = process.env.KB_RELAY_TLS_KEY;
  const tls = certPath && keyPath ? { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) } : null;
  let appHandler = null;
  if (process.env.KB_RELAY_SERVE_APP === '1') {
    ({ appHandler } = await import('../../server.js'));
  }
  const instance = createRelayServer({ dbPath, port, tls, appHandler });
  instance.server.listen(port, host, () => {
    const actualPort = instance.server.address().port;
    const scheme = tls ? 'https' : 'http';
    console.log(`[KennisBoost Relay Server] listening on ${scheme}://localhost:${actualPort}`);
    console.log(`[KennisBoost Relay Server] SQLite database: ${dbPath}`);
    if (appHandler) console.log('[KennisBoost Relay Server] also serving the KennisBoost app on this origin');
    if (!tls) console.log('[KennisBoost Relay Server] plain HTTP: put it behind HTTPS (or set KB_RELAY_TLS_CERT/KB_RELAY_TLS_KEY) for use on a network');
  });
}
