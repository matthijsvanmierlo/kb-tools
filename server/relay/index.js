import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { createDatabase } from './db.js';
import {
  createRelayFetchHandler,
  RateLimiter,
  generateS3PresignedPutUrl,
  VERSION,
  SCHEMA_VERSION,
  DEFAULT_PORT,
  MAX_PAYLOAD_SIZE,
  MAX_SUBMISSION_SIZE,
  MAX_DRAFT_SIZE,
  MAX_SYNC_CHUNK_SIZE,
  MAX_SYNC_SNAPSHOT_SIZE,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TEACHER_QUOTA_MB,
  DRAFT_RATE_LIMIT_MAX
} from './handler.js';
import {
  createFsMediaStore,
  createMemoryMediaStore,
  createDbPartsStore,
  createBlobStore
} from './media-store.js';

export {
  createDatabase,
  createRelayFetchHandler,
  RateLimiter,
  generateS3PresignedPutUrl,
  VERSION,
  SCHEMA_VERSION,
  DEFAULT_PORT,
  MAX_PAYLOAD_SIZE,
  MAX_SUBMISSION_SIZE,
  MAX_DRAFT_SIZE,
  MAX_SYNC_CHUNK_SIZE,
  MAX_SYNC_SNAPSHOT_SIZE,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TEACHER_QUOTA_MB,
  DRAFT_RATE_LIMIT_MAX
};

/**
 * Convert a Node.js IncomingMessage to a Web Standard Request.
 * @param {http.IncomingMessage} req
 * @param {string} host
 * @param {boolean} isEncrypted
 * @returns {Promise<Request>}
 */
async function nodeReqToWebRequest(req, host, isEncrypted) {
  const proto = isEncrypted ? 'https' : (req.headers['x-forwarded-proto'] || 'http');
  const fullUrl = `${proto}://${host}${req.url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const method = req.method ? req.method.toUpperCase() : 'GET';
  let body = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = [];
    let bytesRead = 0;
    // 70MB (safely accommodates max 64MB sync snapshots plus JSON overhead)
    const MAX_REQ_BYTES = 70 * 1024 * 1024;
    for await (const chunk of req) {
      bytesRead += chunk.length;
      if (bytesRead > MAX_REQ_BYTES) {
        const err = new Error('PAYLOAD_TOO_LARGE');
        err.code = 413;
        throw err;
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }

  return new Request(fullUrl, {
    method,
    headers,
    body
  });
}

/**
 * Send a Web Standard Response back to a Node.js ServerResponse.
 * @param {Response} webRes
 * @param {http.ServerResponse} nodeRes
 */
async function sendWebResponse(webRes, nodeRes) {
  const headersObj = {};
  webRes.headers.forEach((val, key) => {
    headersObj[key] = val;
  });

  nodeRes.writeHead(webRes.status, headersObj);

  if (webRes.body) {
    const reader = webRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeRes.write(value);
    }
  }
  nodeRes.end();
}

/**
 * Create and configure the relay server.
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

  // Configure unified BlobStore
  let blobStore = null;
  if (opts.cdn?.mediaStore) {
    blobStore = createMemoryMediaStore(opts.cdn.mediaStore);
  } else if (opts.cdn?.localDir || process.env.KB_CDN_LOCAL_DIR) {
    const dir = opts.cdn?.localDir || process.env.KB_CDN_LOCAL_DIR;
    blobStore = createFsMediaStore(dir);
  } else if (db) {
    blobStore = createDbPartsStore(db);
  } else {
    blobStore = createMemoryMediaStore();
  }

  // Hourly pruning of expired data and blobs
  const prune = async () => {
    try {
      const pruneRes = await db.pruneExpired({ retentionDays });
      if (pruneRes?.expiredBlobKeys?.length > 0 && blobStore) {
        await blobStore.deleteMany(pruneRes.expiredBlobKeys);
      }
      limiter.sweep();
      draftLimiter.sweep();
    } catch (e) {
      console.error('[Relay] Prune error:', e);
    }
  };
  prune();
  const pruneInterval = setInterval(prune, 3600 * 1000);
  if (pruneInterval.unref) pruneInterval.unref();

  const cdnConfig = {
    enabled: Boolean(
      opts.cdn ||
      process.env.KB_CDN_ENDPOINT ||
      process.env.KB_CDN_BUCKET ||
      process.env.KB_CDN_PUBLIC_URL ||
      process.env.KB_CDN_LOCAL_DIR
    ),
    endpoint: process.env.KB_CDN_ENDPOINT || opts.cdn?.endpoint,
    bucket: process.env.KB_CDN_BUCKET || opts.cdn?.bucket,
    accessKeyId: process.env.KB_CDN_ACCESS_KEY_ID || opts.cdn?.accessKeyId,
    secretAccessKey: process.env.KB_CDN_SECRET_ACCESS_KEY || opts.cdn?.secretAccessKey,
    region: process.env.KB_CDN_REGION || opts.cdn?.region || 'auto',
    publicUrl: process.env.KB_CDN_PUBLIC_URL || opts.cdn?.publicUrl
  };

  const oidcConfig = {
    enabled: Boolean(opts.oidc || process.env.KB_OIDC_GOOGLE_CLIENT_ID || process.env.KB_OIDC_MS_CLIENT_ID),
    googleClientId: process.env.KB_OIDC_GOOGLE_CLIENT_ID || opts.oidc?.googleClientId,
    googleDomain: process.env.KB_OIDC_GOOGLE_DOMAIN || opts.oidc?.googleDomain,
    microsoftClientId: process.env.KB_OIDC_MS_CLIENT_ID || opts.oidc?.microsoftClientId,
    microsoftTenant: process.env.KB_OIDC_MS_TENANT || opts.oidc?.microsoftTenant,
    autoProvisionTeachers: (process.env.KB_OIDC_AUTO_PROVISION === 'true' || process.env.KB_OIDC_AUTO_PROVISION === '1' || opts.oidc?.autoProvisionTeachers)
  };

  const fetchHandler = createRelayFetchHandler({
    db,
    limiter,
    draftLimiter,
    allowedOrigins,
    cdnConfig,
    oidcConfig,
    blobStore,
    backend: 'node',
    presignHook: opts.cdn?.presign
  });

  const handler = async (req, res) => {
    if (opts.appHandler && !String(req.url || '').startsWith('/api/')) {
      opts.appHandler(req, res);
      return;
    }

    try {
      const host = req.headers.host || `localhost:${DEFAULT_PORT}`;
      const isEncrypted = Boolean(req.socket?.encrypted || opts.tls);
      const webReq = await nodeReqToWebRequest(req, host, isEncrypted);
      const clientIp = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1');

      const webRes = await fetchHandler(webReq, { clientIp });
      await sendWebResponse(webRes, res);
    } catch (err) {
      if (err.code === 413 || err.message === 'PAYLOAD_TOO_LARGE') {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
        }
        return;
      }
      console.error('[Relay Adapter Error]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  };

  const server = opts.tls ? https.createServer(opts.tls, handler) : http.createServer(handler);

  return {
    server,
    db,
    blobStore,
    limiters: [limiter, draftLimiter],
    close: () => {
      clearInterval(pruneInterval);
      return new Promise((resolve) => {
        if (server.listening) {
          server.close(() => resolve());
        } else {
          resolve();
        }
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
