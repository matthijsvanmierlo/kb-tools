import { createHash, createHmac, randomBytes } from 'node:crypto';
import { extractBearerToken, hashToken, sameHash } from './auth.js';
import { RateLimiter, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, DRAFT_RATE_LIMIT_MAX } from './rate-limiter.js';

export { RateLimiter, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, DRAFT_RATE_LIMIT_MAX };

export const VERSION = '1.0.0';
export const DEFAULT_PORT = 3000;
export const MAX_PAYLOAD_SIZE = 512 * 1024; // 512 KB
export const MAX_SUBMISSION_SIZE = 5 * 1024 * 1024; // 5 MB
export const MAX_DRAFT_SIZE = 64 * 1024; // 64 KB
export const MAX_SYNC_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
export const MAX_SYNC_SNAPSHOT_SIZE = 32 * 1024 * 1024; // 32 MB
export const MAX_STUDENT_MEDIA_SIZE = 25 * 1024 * 1024; // 25 MB
export const DEFAULT_RETENTION_DAYS = 180;

export const ALLOWED_MEDIA_EXTS = new Set([
  'bin', 'enc', 'webp', 'png', 'jpg', 'jpeg', 'gif', 'svg',
  'pdf', 'txt', 'md', 'csv', 'json', 'zip', 'html', 'css',
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'go', 'rs', 'rb', 'sql', 'xml', 'yaml', 'yml',
  'mp3', 'wav', 'ogg', 'webm', 'mp4', 'm4a', 'kbsub', 'kbshare'
]);

export function isAllowedMime(mime) {
  if (!mime) return false;
  const m = String(mime).toLowerCase().split(';')[0].trim();
  return (
    m.startsWith('image/') ||
    m.startsWith('audio/') ||
    m.startsWith('video/') ||
    m.startsWith('text/') ||
    m === 'application/pdf' ||
    m === 'application/zip' ||
    m === 'application/x-zip-compressed' ||
    m === 'application/json' ||
    m === 'application/octet-stream'
  );
}

const DEVICE_ID_RE = /^[0-9A-Za-z-]{8,64}$/;
const DRAFT_ID_RE = /^[0-9a-f]{64}$/;

const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');

export function generateS3PresignedPutUrl({ endpoint, bucket, key, accessKeyId, secretAccessKey, region = 'auto', contentType, expiresIn = 3600 }) {
  const dateObj = new Date();
  const amzDate = dateObj.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const service = 's3';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const url = new URL(endpoint);
  let host = url.host;
  let path = `/${key}`;
  if (bucket) {
    path = `/${bucket}/${key}`;
  }

  const queryParams = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'content-type;host'
  };

  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  const canonicalHeaders = `content-type:${contentType || 'application/octet-stream'}\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [
    'PUT',
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const hashedCanonicalRequest = createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hashedCanonicalRequest
  ].join('\n');

  const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `${url.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * Creates a runtime-agnostic Web Standard Request -> Response handler.
 * Compatible with Node.js adapters and Cloudflare Workers (fetch event).
 *
 * @param {object} options
 * @param {any} options.db - Awaitable repository (from createDatabase or createD1Database)
 * @param {RateLimiter} [options.limiter]
 * @param {RateLimiter} [options.draftLimiter]
 * @param {string[]} [options.allowedOrigins]
 * @param {object} [options.cdnConfig]
 * @param {any} [options.mediaStore]
 * @param {Function} [options.presignHook]
 * @returns {(req: Request, context?: { clientIp?: string, publicOrigin?: string }) => Promise<Response>}
 */
export function createRelayFetchHandler(options = {}) {
  const {
    db,
    limiter = new RateLimiter(),
    draftLimiter = new RateLimiter(DRAFT_RATE_LIMIT_MAX),
    allowedOrigins = ['*'],
    cdnConfig = {},
    mediaStore = null,
    presignHook = null,
    mediaSigningSecret = null
  } = options;

  let cachedSigningSecret = mediaSigningSecret ||
    (typeof process !== 'undefined' && process.env?.KB_MEDIA_SIGNING_SECRET) || null;

  async function resolveSigningSecret() {
    if (cachedSigningSecret) return cachedSigningSecret;
    if (typeof db?.getMediaSigningSecret === 'function') {
      try {
        cachedSigningSecret = await db.getMediaSigningSecret();
        if (cachedSigningSecret) return cachedSigningSecret;
      } catch (e) {
        // fallback
      }
    }
    cachedSigningSecret = 'kb-media-secret';
    return cachedSigningSecret;
  }

  const cdnEnabled = Boolean(
    cdnConfig.enabled ||
    mediaStore ||
    cdnConfig.endpoint ||
    cdnConfig.bucket ||
    cdnConfig.publicUrl
  );

  return async function handleFetch(request, context = {}) {
    const originHeader = request.headers.get('origin') || '*';
    const isOriginAllowed = allowedOrigins.includes('*') || allowedOrigins.includes(originHeader);

    // Default CORS headers
    const corsHeaders = {};
    if (isOriginAllowed) {
      corsHeaders['Access-Control-Allow-Origin'] = originHeader;
      corsHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
      corsHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-KB-Workspace-Key, X-KB-Drop-Secret';
    }

    if (request.method === 'OPTIONS') {
      if (request.headers.get('Access-Control-Request-Private-Network')) {
        corsHeaders['Access-Control-Allow-Private-Network'] = 'true';
      }
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const json = (status, data, extraHeaders = {}) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
          ...extraHeaders
        }
      });
    };

    const error = (status, message, extraHeaders = {}) => {
      return json(status, { error: message }, extraHeaders);
    };

    try {
      const url = new URL(request.url);
      let pathname = url.pathname.replace(/\/+$/, '') || '/';
      // Normalize /api/v1 prefix
      if (pathname.startsWith('/api/v1/')) {
        pathname = pathname.slice('/api/v1'.length);
      } else if (pathname === '/api/v1') {
        pathname = '/';
      }

      // 1. GET /health
      if (request.method === 'GET' && (pathname === '/health' || pathname === '/')) {
        const features = ['payloads', 'drops', 'drafts', 'sync', 'feeds'];
        if (cdnEnabled) features.push('media');
        return json(200, { ok: true, version: VERSION, features });
      }

      // Teacher authentication helper
      const authenticateTeacher = async () => {
        const token = extractBearerToken(request);
        if (!token) return null;
        const hash = hashToken(token);
        return await db.teachers.getByTokenHash(hash);
      };

      const clientIp = context.clientIp || request.headers.get('cf-connecting-ip') || '127.0.0.1';

      // Helper to read text body with byte size limit
      const readText = async (maxBytes) => {
        const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
        if (contentLength > maxBytes) {
          const err = new Error('PAYLOAD_TOO_LARGE');
          err.code = 413;
          throw err;
        }
        const text = await request.text();
        if (new TextEncoder().encode(text).length > maxBytes) {
          const err = new Error('PAYLOAD_TOO_LARGE');
          err.code = 413;
          throw err;
        }
        return text;
      };

      const readJson = async (maxBytes) => {
        try {
          const text = await readText(maxBytes);
          return JSON.parse(text);
        } catch (err) {
          if (err.code === 413) throw err;
          return null;
        }
      };

      // -------------------------------------------------------------
      // Media endpoints (CDN broker, R2, and local fallback)
      // -------------------------------------------------------------
      if (request.method === 'POST' && pathname === '/media/presign') {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }
        if (!cdnEnabled) {
          return error(501, 'Media CDN offloading is not configured on this relay server');
        }

        const parsed = await readJson(16384);
        const { sha256: fileHash, mime, ext } = parsed || {};
        if (!fileHash || !/^[a-f0-9]{64}$/i.test(fileHash)) {
          return error(400, 'Valid 64-hex sha256 required');
        }

        if (typeof presignHook === 'function') {
          const custom = await presignHook({ sha256: fileHash, mime, ext, teacherId: teacher.id });
          return json(200, custom);
        }

        const safeExt = String(ext || (mime === 'image/webp' ? 'webp' : mime === 'audio/webm' ? 'webm' : 'bin')).replace(/[^a-z0-9]/gi, '');
        const filename = `${fileHash}.${safeExt}`;
        const objectKey = `assets/${filename}`;

        const host = request.headers.get('host') || url.host || `localhost:${DEFAULT_PORT}`;
        const proto = url.protocol === 'https:' ? 'https' : (request.headers.get('x-forwarded-proto') || 'http');

        const endpoint = (cdnConfig.endpoint || '').replace(/\/+$/, '');
        const bucket = cdnConfig.bucket || '';
        const accessKeyId = cdnConfig.accessKeyId;
        const secretAccessKey = cdnConfig.secretAccessKey;
        const region = cdnConfig.region || 'auto';
        const publicBase = (cdnConfig.publicUrl || '').replace(/\/+$/, '');

        if (endpoint && accessKeyId && secretAccessKey) {
          const presignedUrl = generateS3PresignedPutUrl({
            endpoint,
            bucket,
            key: objectKey,
            accessKeyId,
            secretAccessKey,
            region,
            contentType: mime || 'application/octet-stream'
          });
          const publicUrl = publicBase ? `${publicBase}/${objectKey}` : `${endpoint}/${bucket ? bucket + '/' : ''}${objectKey}`;
          return json(200, {
            upload_url: presignedUrl,
            public_url: publicUrl,
            method: 'PUT',
            headers: { 'Content-Type': mime || 'application/octet-stream' }
          });
        }

        // Direct store fallback (R2, Fs, or Memory)
        const exp = Math.floor(Date.now() / 1000) + 3600;
        const signingSecret = await resolveSigningSecret();
        const sig = createHmac('sha256', signingSecret).update(`${filename}|${exp}`).digest('hex');

        const uploadUrl = `${proto}://${host}/api/v1/media/upload?key=${encodeURIComponent(filename)}&exp=${exp}&sig=${sig}`;
        const publicUrl = publicBase ? `${publicBase}/${filename}` : `${proto}://${host}/api/v1/media/file/${encodeURIComponent(filename)}`;
        return json(200, {
          upload_url: uploadUrl,
          public_url: publicUrl,
          method: 'PUT',
          headers: { 'Content-Type': mime || 'application/octet-stream' }
        });
      }

      // PUT /media/upload?key=<filename>&exp=<unix>&sig=<hmac>[&drop_id=<id>]
      if (request.method === 'PUT' && pathname === '/media/upload') {
        const key = url.searchParams.get('key');
        if (!key || !/^[a-f0-9]{64}\.[a-z0-9]+$/i.test(key)) {
          return error(400, 'Valid key parameter required');
        }

        const expStr = url.searchParams.get('exp');
        const sig = url.searchParams.get('sig');
        const dropId = url.searchParams.get('drop_id');

        if (!expStr || !sig) {
          return error(401, 'Unauthorized: exp and sig required');
        }
        const exp = parseInt(expStr, 10);
        if (isNaN(exp) || Math.floor(Date.now() / 1000) > exp) {
          return error(403, 'Media upload URL has expired');
        }

        const signingSecret = await resolveSigningSecret();
        const expectedSigPlain = createHmac('sha256', signingSecret).update(`${key}|${exp}`).digest('hex');
        const expectedSigDrop = dropId ? createHmac('sha256', signingSecret).update(`${key}|${exp}|${dropId}`).digest('hex') : null;

        if (sig !== expectedSigPlain && (!expectedSigDrop || sig !== expectedSigDrop)) {
          return error(403, 'Invalid media upload signature');
        }

        const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
        if (contentLength > MAX_SYNC_SNAPSHOT_SIZE) {
          return error(413, 'Payload too large');
        }
        const arrayBuf = await request.arrayBuffer();
        if (arrayBuf.byteLength > MAX_SYNC_SNAPSHOT_SIZE) {
          return error(413, 'Payload too large');
        }

        // Verify body sha256 matches key
        const expectedHash = key.split('.')[0].toLowerCase();
        const actualHash = createHash('sha256').update(new Uint8Array(arrayBuf)).digest('hex').toLowerCase();
        if (actualHash !== expectedHash) {
          return error(400, 'Body sha256 does not match key');
        }

        const contentType = request.headers.get('content-type') || 'application/octet-stream';
        if (mediaStore) {
          await mediaStore.put(key, new Uint8Array(arrayBuf), contentType);
        }

        if (dropId) {
          if (typeof db?.recordMediaUpload === 'function') {
            await db.recordMediaUpload({ dropId, key, size: arrayBuf.byteLength });
          } else if (typeof db?.dropMedia?.record === 'function') {
            await db.dropMedia.record({ dropId, key, size: arrayBuf.byteLength });
          }
        }

        return json(200, { ok: true, key });
      }

      // GET /media/file/:filename
      const mediaFileMatch = pathname.match(/^\/media\/file\/([a-f0-9]{64}\.[a-z0-9]+)$/i);
      if (request.method === 'GET' && mediaFileMatch) {
        const key = mediaFileMatch[1];
        const item = mediaStore ? await mediaStore.get(key) : null;
        if (!item) {
          return error(404, 'Media asset not found');
        }
        return new Response(item.data, {
          status: 200,
          headers: {
            'Content-Type': item.contentType || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000, immutable',
            ...corsHeaders
          }
        });
      }

      // -------------------------------------------------------------
      // 2. POST /payloads
      // -------------------------------------------------------------
      if (request.method === 'POST' && pathname === '/payloads') {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }

        const parsed = await readJson(MAX_PAYLOAD_SIZE);
        if (!parsed || !parsed.kind || !parsed.ciphertext) {
          return error(400, 'Missing kind or ciphertext in payload');
        }

        const ref = randomBytes(16).toString('base64url').slice(0, 22);
        await db.payloads.create({
          ref,
          teacherId: teacher.id,
          kind: parsed.kind,
          ciphertext: parsed.ciphertext,
          meta: parsed.meta,
          expiresAt: parsed.expires_at || null
        });

        return json(201, { ref });
      }

      // 3. GET /payloads/:ref
      const payloadMatch = pathname.match(/^\/payloads\/([A-Za-z0-9_\-]+)$/);
      if (request.method === 'GET' && payloadMatch) {
        const ref = payloadMatch[1];
        const row = await db.payloads.get(ref);
        if (!row) {
          return error(404, 'Payload not found');
        }
        if (row.expired) {
          return error(410, 'Payload expired');
        }

        return json(200, {
          kind: row.kind,
          ciphertext: row.ciphertext
        });
      }

      // Drop secret verification
      const dropSecretOk = (drop) => !drop.secret_hash
        || sameHash(drop.secret_hash, sha256(request.headers.get('x-kb-drop-secret') || ''));

      // -------------------------------------------------------------
      // Sync workspaces (Option B replication)
      // -------------------------------------------------------------
      if (request.method === 'POST' && pathname === '/sync') {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }
        const workspaceId = randomBytes(12).toString('hex');
        const workspaceKey = randomBytes(32).toString('hex');
        await db.workspaces.create({ id: workspaceId, keyHash: sha256(workspaceKey), createdBy: teacher.id });
        return json(201, { workspace_id: workspaceId, workspace_key: workspaceKey });
      }

      const syncMatch = pathname.match(/^\/sync\/([0-9a-f]{24})\/(chunks|snapshots)(?:\/([0-9A-Za-z-]{8,64}))?$/);
      if (syncMatch) {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }
        const [, workspaceId, resource, deviceParam] = syncMatch;
        const ws = await db.workspaces.get(workspaceId);
        if (!ws || !sameHash(ws.key_hash, sha256(request.headers.get('x-kb-workspace-key') || ''))) {
          return error(403, 'Forbidden: unknown workspace or wrong workspace key');
        }

        if (resource === 'chunks' && !deviceParam) {
          if (request.method === 'POST') {
            const body = await readJson(MAX_SYNC_CHUNK_SIZE);
            const start = Number(body?.start);
            const end = Number(body?.end);
            if (!body || !DEVICE_ID_RE.test(body.device_id || '') || !Number.isInteger(start) || !Number.isInteger(end)
              || start < 1 || end < start || typeof body.body !== 'string') {
              return error(400, 'Invalid sync chunk');
            }
            const { created } = await db.sync.putChunk({ workspaceId, deviceId: body.device_id, start, end, body: body.body });
            return json(created ? 201 : 200, { ok: true });
          }
          if (request.method === 'GET') {
            const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);
            return json(200, await db.sync.listChunks(workspaceId, { after }));
          }
          if (request.method === 'DELETE') {
            const deviceId = url.searchParams.get('device_id') || '';
            const through = parseInt(url.searchParams.get('through') || '', 10);
            if (!DEVICE_ID_RE.test(deviceId) || !Number.isInteger(through)) {
              return error(400, 'device_id and through are required');
            }
            return json(200, { deleted: await db.sync.deleteChunks(workspaceId, deviceId, through) });
          }
        }

        if (resource === 'snapshots') {
          if (!deviceParam && request.method === 'GET') {
            return json(200, { items: await db.sync.listSnapshots(workspaceId) });
          }
          if (deviceParam && request.method === 'PUT') {
            const body = await readJson(MAX_SYNC_SNAPSHOT_SIZE);
            if (!body || typeof body.body !== 'string' || typeof body.created_at !== 'string') {
              return error(400, 'Invalid snapshot');
            }
            await db.sync.putSnapshot({ workspaceId, deviceId: deviceParam, createdAt: body.created_at, body: body.body });
            return json(200, { ok: true });
          }
          if (deviceParam && request.method === 'GET') {
            const row = await db.sync.getSnapshot(workspaceId, deviceParam);
            if (!row) {
              return error(404, 'Snapshot not found');
            }
            return json(200, row);
          }
        }

        return error(405, 'Method not allowed');
      }

      // -------------------------------------------------------------
      // Student draft roaming
      // -------------------------------------------------------------
      const draftMatch = pathname.match(/^\/drops\/([A-Za-z0-9_\-]+)\/drafts\/([^/]+)$/);
      if (draftMatch && (request.method === 'PUT' || request.method === 'GET')) {
        const [, dropId, draftId] = draftMatch;
        if (!DRAFT_ID_RE.test(draftId)) {
          return error(400, 'Invalid draft id');
        }
        if (!draftLimiter.isAllowed(clientIp)) {
          return error(429, 'Rate limit exceeded. Please wait a minute.');
        }
        const drop = await db.drops.get(dropId);
        if (!drop) {
          return error(404, 'Drop box not found');
        }
        if (drop.expired) {
          return error(410, 'Drop box expired');
        }
        if (!dropSecretOk(drop)) {
          return error(403, 'Forbidden: missing or wrong drop secret');
        }
        if (request.method === 'PUT') {
          const text = (await readText(MAX_DRAFT_SIZE)).trim();
          if (!text.startsWith('KBDRAFT1.')) {
            return error(400, 'Invalid draft format');
          }
          try {
            const { updatedAt } = await db.drafts.put({ dropId, draftId, ciphertext: text });
            return json(200, { updated_at: updatedAt });
          } catch (err) {
            if (err.code === 'QUOTA_EXCEEDED') {
              return error(413, 'Draft quota exceeded for this drop box');
            }
            throw err;
          }
        }
        const row = await db.drafts.get(dropId, draftId);
        if (!row) {
          return error(404, 'No saved draft');
        }
        return json(200, { ciphertext: row.ciphertext, updated_at: row.updated_at });
      }

      // -------------------------------------------------------------
      // Student media presign (drop-authorized CDN upload)
      // -------------------------------------------------------------
      const dropMediaPresignMatch = pathname.match(/^\/drops\/([A-Za-z0-9_\-]+)\/media\/presign$/);
      if (request.method === 'POST' && dropMediaPresignMatch) {
        const [, dropId] = dropMediaPresignMatch;
        if (!cdnEnabled) {
          return error(501, 'Media CDN offloading is not configured on this relay server');
        }
        if (!draftLimiter.isAllowed(clientIp)) {
          return error(429, 'Rate limit exceeded. Please wait a minute.');
        }
        const drop = await db.drops.get(dropId);
        if (!drop) {
          return error(404, 'Drop box not found');
        }
        if (drop.expired) {
          return error(410, 'Drop box expired');
        }
        if (!dropSecretOk(drop)) {
          return error(403, 'Forbidden: missing or wrong drop secret');
        }

        const parsed = await readJson(16384);
        const { sha256: fileHash, mime, ext, size } = parsed || {};
        if (!fileHash || !/^[a-f0-9]{64}$/i.test(fileHash)) {
          return error(400, 'Valid 64-hex sha256 required');
        }
        const fileSize = parseInt(size, 10);
        if (isNaN(fileSize) || fileSize <= 0) {
          return error(400, 'Valid positive size required');
        }
        if (fileSize > MAX_STUDENT_MEDIA_SIZE) {
          return error(413, 'File size exceeds 25MB limit');
        }

        const safeExt = String(ext || (mime === 'image/webp' ? 'webp' : mime === 'audio/webm' ? 'webm' : 'bin')).toLowerCase().replace(/[^a-z0-9]/gi, '');
        if (!ALLOWED_MEDIA_EXTS.has(safeExt)) {
          return error(400, `File extension .${safeExt} is not permitted`);
        }
        const safeMime = String(mime || 'application/octet-stream').toLowerCase().split(';')[0].trim();
        if (!isAllowedMime(safeMime)) {
          return error(400, `Content-Type ${safeMime} is not permitted`);
        }

        try {
          if (typeof db?.checkMediaQuota === 'function') {
            await db.checkMediaQuota(dropId, fileSize);
          } else if (typeof db?.dropMedia?.checkQuota === 'function') {
            await db.dropMedia.checkQuota(dropId, fileSize);
          }
        } catch (err) {
          if (err.code === 'QUOTA_EXCEEDED') {
            return error(413, 'Media quota exceeded for this drop box');
          }
          throw err;
        }

        const filename = `${fileHash}.${safeExt}`;
        const host = request.headers.get('host') || url.host || `localhost:${DEFAULT_PORT}`;
        const proto = url.protocol === 'https:' ? 'https' : (request.headers.get('x-forwarded-proto') || 'http');
        const publicBase = (cdnConfig.publicUrl || '').replace(/\/+$/, '');

        const exp = Math.floor(Date.now() / 1000) + 3600;
        const signingSecret = await resolveSigningSecret();
        const sig = createHmac('sha256', signingSecret).update(`${filename}|${exp}|${dropId}`).digest('hex');

        const uploadUrl = `${proto}://${host}/api/v1/media/upload?key=${encodeURIComponent(filename)}&exp=${exp}&sig=${sig}&drop_id=${encodeURIComponent(dropId)}`;
        const publicUrl = publicBase ? `${publicBase}/${filename}` : `${proto}://${host}/api/v1/media/file/${encodeURIComponent(filename)}`;

        return json(200, {
          upload_url: uploadUrl,
          public_url: publicUrl,
          method: 'PUT',
          headers: { 'Content-Type': mime || 'application/octet-stream' }
        });
      }

      // -------------------------------------------------------------
      // 4. POST /drops
      // -------------------------------------------------------------
      if (request.method === 'POST' && pathname === '/drops') {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }

        const parsed = await readJson(MAX_PAYLOAD_SIZE);
        if (!parsed || !parsed.assignment_id) {
          return error(400, 'Missing assignment_id');
        }

        const dropId = randomBytes(12).toString('hex');
        const dropSecret = randomBytes(24).toString('hex');
        await db.drops.create({
          id: dropId,
          teacherId: teacher.id,
          assignmentId: parsed.assignment_id,
          publishVersion: parsed.publish_version ?? null,
          expiresAt: parsed.expires_at || null,
          secretHash: sha256(dropSecret)
        });

        return json(201, { drop_id: dropId, drop_secret: dropSecret });
      }

      // -------------------------------------------------------------
      // 5. POST /drops/:dropId/submissions
      // -------------------------------------------------------------
      const dropSubmitMatch = pathname.match(/^\/drops\/([A-Za-z0-9_\-]+)\/submissions$/);
      if (request.method === 'POST' && dropSubmitMatch) {
        if (!limiter.isAllowed(clientIp)) {
          return error(429, 'Rate limit exceeded. Please wait a minute before submitting again.');
        }

        const dropId = dropSubmitMatch[1];
        const drop = await db.drops.get(dropId);
        if (!drop) {
          return error(404, 'Drop box not found');
        }
        if (drop.expired) {
          return error(410, 'Drop box expired');
        }
        if (!dropSecretOk(drop)) {
          return error(403, 'Forbidden: missing or wrong drop secret');
        }

        const rawBody = await readText(MAX_SUBMISSION_SIZE);
        const trimmed = rawBody.trim();
        if (!trimmed.startsWith('KBSUB1.')) {
          return error(400, 'Invalid submission format: envelope must start with KBSUB1.');
        }

        const ciphertextSha256 = createHash('sha256').update(trimmed).digest('hex');
        const receiptId = ciphertextSha256.slice(0, 8).toUpperCase();
        const submissionId = randomBytes(16).toString('hex');
        try {
          const resEntry = await db.submissions.create({
            id: submissionId,
            dropId,
            text: trimmed
          });

          const signingSecret = await resolveSigningSecret();
          const relayReceiptSig = createHmac('sha256', signingSecret)
            .update(`${dropId}|${ciphertextSha256}|${resEntry.receivedAt}`)
            .digest('hex');

          return json(201, {
            receipt_id: receiptId,
            received_at: resEntry.receivedAt,
            ciphertext_sha256: ciphertextSha256,
            relay_receipt_sig: relayReceiptSig
          });
        } catch (err) {
          if (err.code === 'QUOTA_EXCEEDED') {
            return error(413, 'Submission quota exceeded for this drop box');
          }
          throw err;
        }
      }

      // 6. GET /drops/:dropId/submissions
      if (request.method === 'GET' && dropSubmitMatch) {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }

        const dropId = dropSubmitMatch[1];
        const drop = await db.drops.get(dropId);
        if (!drop) {
          return error(404, 'Drop box not found');
        }
        if (drop.teacher_id !== teacher.id) {
          return error(403, 'Forbidden: you do not own this drop box');
        }

        const since = url.searchParams.get('since') || undefined;
        const items = await db.submissions.list(dropId, { since });
        return json(200, { items });
      }

      // 6b. GET /drops/:dropId/stats
      const dropStatsMatch = pathname.match(/^\/drops\/([A-Za-z0-9_\-]+)\/stats$/);
      if (request.method === 'GET' && dropStatsMatch) {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }

        const dropId = dropStatsMatch[1];
        const drop = await db.drops.get(dropId);
        if (!drop) {
          return error(404, 'Drop box not found');
        }
        if (drop.teacher_id !== teacher.id) {
          return error(403, 'Forbidden: you do not own this drop box');
        }

        const mediaStats = (typeof db.dropMedia?.getStats === 'function')
          ? db.dropMedia.getStats(dropId)
          : { count: 0, totalSize: 0 };
        const subList = (typeof db.submissions?.list === 'function')
          ? await db.submissions.list(dropId)
          : [];

        return json(200, {
          drop_id: dropId,
          submissions_count: subList.length,
          media_count: mediaStats.count || 0,
          media_bytes: mediaStats.totalSize || 0,
          expires_at: drop.expires_at || null
        });
      }

      // 7. DELETE /drops/:dropId
      const dropDeleteMatch = pathname.match(/^\/drops\/([A-Za-z0-9_\-]+)$/);
      if (request.method === 'DELETE' && dropDeleteMatch) {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }

        const dropId = dropDeleteMatch[1];
        const deleted = await db.drops.delete(dropId, teacher.id);
        if (!deleted) {
          return error(404, 'Drop not found or not owned by you');
        }

        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // 8. PUT /api/feed/:courseId or /feed/:courseId
      // -------------------------------------------------------------
      const feedMatch = pathname.match(/^(?:\/api)?\/feed\/([A-Za-z0-9_\-]+)$/);
      if (request.method === 'PUT' && feedMatch) {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }

        const courseId = feedMatch[1];
        const parsed = await readJson(MAX_PAYLOAD_SIZE);
        if (!parsed) {
          return error(400, 'Invalid JSON body');
        }

        const ciphertext = typeof parsed === 'string' ? parsed : parsed.ciphertext;
        if (!ciphertext) {
          return error(400, 'Missing ciphertext in feed payload');
        }

        const etag = parsed.etag || createHash('sha256').update(ciphertext).digest('hex').slice(0, 16);
        await db.feeds.put({
          courseId,
          teacherId: teacher.id,
          ciphertext,
          etag,
          updatedAt: new Date().toISOString()
        });

        return json(200, { ok: true, etag }, { 'ETag': `"${etag}"` });
      }

      // 9. GET /api/feed/:courseId or /feed/:courseId
      if (request.method === 'GET' && feedMatch) {
        const courseId = feedMatch[1];
        const feed = await db.feeds.get(courseId);
        if (!feed) {
          return error(404, 'Course feed not found');
        }

        const ifNoneMatch = request.headers.get('if-none-match');
        if (ifNoneMatch && (ifNoneMatch === feed.etag || ifNoneMatch === `"${feed.etag}"`)) {
          return new Response(null, {
            status: 304,
            headers: {
              'ETag': `"${feed.etag}"`,
              ...corsHeaders
            }
          });
        }

        return json(200, {
          course_id: feed.courseId,
          ciphertext: feed.ciphertext,
          etag: feed.etag,
          updated_at: feed.updatedAt
        }, { 'ETag': `"${feed.etag}"` });
      }

      // -------------------------------------------------------------
      // 10. Blind Dead-Drop Feedback Mailbox (KB-DROP-FB-001)
      // -------------------------------------------------------------
      const feedbackMatch = pathname.match(/^(?:\/api)?\/feedback\/([A-Za-z0-9_\-]+)$/);
      if (feedbackMatch) {
        const dropId = feedbackMatch[1];

        // PUT /feedback/:dropId
        if (request.method === 'PUT' || request.method === 'POST') {
          const teacher = await authenticateTeacher();
          if (!teacher) {
            return error(401, 'Unauthorized: valid teacher token required');
          }

          const parsed = await readJson(MAX_PAYLOAD_SIZE);
          if (!parsed) {
            return error(400, 'Invalid JSON body');
          }

          const ciphertext = typeof parsed === 'string' ? parsed : (parsed.ciphertext || parsed.text);
          if (!ciphertext) {
            return error(400, 'Missing ciphertext in feedback payload');
          }

          const expiresAt = parsed.expires_at || new Date(Date.now() + 30 * 86400000).toISOString();
          await db.feedbackDrops.put({ dropId, ciphertext, expiresAt });
          return json(200, { ok: true, drop_id: dropId, expires_at: expiresAt });
        }

        // GET /feedback/:dropId
        if (request.method === 'GET') {
          if (!limiter.isAllowed(clientIp)) {
            return error(429, 'Rate limit exceeded. Please wait a minute before querying feedback again.');
          }

          const row = await db.feedbackDrops.get(dropId);
          if (!row) {
            return error(404, 'Feedback drop not found');
          }
          if (row.expired) {
            return error(410, 'Feedback drop expired');
          }

          return json(200, {
            drop_id: dropId,
            ciphertext: row.ciphertext,
            created_at: row.created_at
          });
        }

        // DELETE /feedback/:dropId
        if (request.method === 'DELETE') {
          const teacher = await authenticateTeacher();
          if (!teacher) {
            return error(401, 'Unauthorized: valid teacher token required');
          }
          const deleted = db.feedbackDrops.delete(dropId);
          if (!deleted) {
            return error(404, 'Feedback drop not found');
          }
          return new Response(null, { status: 204, headers: corsHeaders });
        }
      }

      return error(404, 'Route not found');
    } catch (err) {
      if (err.code === 413 || err.message === 'PAYLOAD_TOO_LARGE') {
        return error(413, 'Payload too large');
      }
      console.error('[Relay Fetch Error]', err);
      return error(500, 'Internal server error');
    }
  };
}
