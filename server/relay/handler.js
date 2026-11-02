import { createHash, createHmac, randomBytes } from 'node:crypto';
import { extractBearerToken, hashToken, sameHash, generateToken, normalizeClaimCode } from './auth.js';
import { verifyOidcToken } from './oidc.js';
import { RateLimiter, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, DRAFT_RATE_LIMIT_MAX } from './rate-limiter.js';
import { createDbPartsStore } from './media-store.js';
import {
  VERSION,
  SCHEMA_VERSION,
  DEFAULT_PORT,
  MAX_PAYLOAD_SIZE,
  MAX_SUBMISSION_SIZE,
  MAX_DRAFT_SIZE,
  MAX_SYNC_CHUNK_SIZE,
  MAX_SYNC_SNAPSHOT_SIZE,
  MAX_STUDENT_MEDIA_SIZE,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TEACHER_QUOTA_MB,
  INLINE_SUBMISSION_THRESHOLD,
  SUBMISSION_RATE_LIMIT_PER_MIN
} from './limits.js';

export {
  RateLimiter,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  DRAFT_RATE_LIMIT_MAX,
  VERSION,
  SCHEMA_VERSION,
  DEFAULT_PORT,
  MAX_PAYLOAD_SIZE,
  MAX_SUBMISSION_SIZE,
  MAX_DRAFT_SIZE,
  MAX_SYNC_CHUNK_SIZE,
  MAX_SYNC_SNAPSHOT_SIZE,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TEACHER_QUOTA_MB
};

// SVG and HTML removed for XSS safety
export const ALLOWED_MEDIA_EXTS = new Set([
  'bin', 'enc', 'webp', 'png', 'jpg', 'jpeg', 'gif',
  'pdf', 'txt', 'md', 'csv', 'json', 'zip', 'css',
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'go', 'rs', 'rb', 'sql', 'xml', 'yaml', 'yml',
  'mp3', 'wav', 'ogg', 'webm', 'mp4', 'm4a', 'kbsub', 'kbshare'
]);

export const EXT_TO_MIME = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/plain',
  jsx: 'text/plain',
  tsx: 'text/plain',
  py: 'text/plain',
  java: 'text/plain',
  c: 'text/plain',
  cpp: 'text/plain',
  h: 'text/plain',
  hpp: 'text/plain',
  cs: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  rb: 'text/plain',
  sql: 'text/plain',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  bin: 'application/octet-stream',
  enc: 'application/octet-stream',
  kbsub: 'application/octet-stream',
  kbshare: 'application/octet-stream'
};

export function isAllowedMime(mime) {
  if (!mime) return false;
  const m = String(mime).toLowerCase().split(';')[0].trim();
  if (m === 'image/svg+xml' || m.includes('html')) return false;
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

const sha256 = (text) => createHash('sha256').update(typeof text === 'string' ? text : Buffer.from(text)).digest('hex');

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
 */
export function createRelayFetchHandler(options = {}) {
  const {
    db,
    limiter = new RateLimiter(),
    draftLimiter = new RateLimiter(DRAFT_RATE_LIMIT_MAX),
    allowedOrigins = ['*'],
    cdnConfig = {},
    oidcConfig = options.oidcConfig || options.oidc || {},
    presignHook = null,
    mediaSigningSecret = null,
    backend = null
  } = options;

  const blobStore = options.blobStore || options.mediaStore || (db ? createDbPartsStore(db) : null);

  let cachedSigningSecret = mediaSigningSecret ||
    (typeof process !== 'undefined' && process.env?.KB_MEDIA_SIGNING_SECRET) || null;

  async function resolveSigningSecret() {
    if (cachedSigningSecret) return cachedSigningSecret;
    if (typeof db?.getMediaSigningSecret === 'function') {
      try {
        cachedSigningSecret = await db.getMediaSigningSecret();
        if (cachedSigningSecret) return cachedSigningSecret;
      } catch (_) {}
    }
    throw new Error('Media signing secret is not configured');
  }

  const cdnEnabled = Boolean(
    cdnConfig.enabled ||
    blobStore ||
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
      corsHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-KB-Workspace-Key, X-KB-Drop-Secret, X-KB-Device-Token, X-KB-Device-Id';
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

    const error = (status, message, extra = {}, extraHeaders = {}) => {
      return json(status, { error: message, ...extra }, extraHeaders);
    };

    try {
      const url = new URL(request.url);
      let pathname = url.pathname.replace(/\/+$/, '') || '/';
      if (pathname.startsWith('/api/v1/')) {
        pathname = pathname.slice('/api/v1'.length);
      } else if (pathname === '/api/v1') {
        pathname = '/';
      }

      const clientIp = context.clientIp || request.headers.get('cf-connecting-ip') || '127.0.0.1';

      // 1. GET /health
      if (request.method === 'GET' && (pathname === '/health' || pathname === '/')) {
        const detectedBackend = backend || (db?.raw?.prepare && typeof db.raw.prepare('').bind === 'function' ? 'd1' : 'node');
        const detectedBlobKind = blobStore?.kind || 'memory';
        const quotaMb = Number(process.env?.KB_RELAY_TEACHER_QUOTA_MB || DEFAULT_TEACHER_QUOTA_MB);

        const isOidcEnabled = Boolean(oidcConfig.enabled || oidcConfig.googleClientId || oidcConfig.microsoftClientId);
        const authMethods = ['bearer', 'roll', 'claim'];
        if (isOidcEnabled) authMethods.push('oidc');

        return json(200, {
          ok: true,
          version: VERSION,
          schema_version: SCHEMA_VERSION,
          backend: detectedBackend,
          blobStore: detectedBlobKind,
          features: ['payloads', 'drops', 'drafts', 'sync', 'feeds', 'media'],
          auth_methods: authMethods,
          oidc_providers: {
            google: Boolean(oidcConfig.googleClientId),
            microsoft: Boolean(oidcConfig.microsoftClientId)
          },
          limits: {
            maxPayloadSize: MAX_PAYLOAD_SIZE,
            maxChunkSize: MAX_SYNC_CHUNK_SIZE,
            maxSnapshotSize: MAX_SYNC_SNAPSHOT_SIZE,
            maxSubmissionSize: MAX_SUBMISSION_SIZE,
            maxDraftSize: MAX_DRAFT_SIZE,
            defaultRetentionDays: DEFAULT_RETENTION_DAYS,
            defaultTeacherQuotaMb: quotaMb
          }
        });
      }

      // Teacher authentication helper
      const authenticateTeacher = async () => {
        const token = extractBearerToken(request);
        if (!token) return null;
        const hash = hashToken(token);
        const teacher = await db.teachers.getByTokenHash(hash);
        if (!teacher) return null;
        if (teacher.active === 0) {
          const err = new Error('TEACHER_DEACTIVATED');
          err.status = 403;
          throw err;
        }
        return teacher;
      };

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

      // Helper to check drop secret
      const dropSecretOk = (drop) => {
        if (!drop.secret_hash) return true;
        const provided = request.headers.get('x-kb-drop-secret') || '';
        return sameHash(drop.secret_hash, sha256(provided));
      };

      // -------------------------------------------------------------
      // Auth Endpoints: /auth/roll, /auth/claim, /auth/oidc
      // -------------------------------------------------------------

      // POST /auth/roll (Single-use key rotation)
      if (request.method === 'POST' && pathname === '/auth/roll') {
        const rollRateKey = `roll:${clientIp}`;
        if (!limiter.isAllowed(rollRateKey, 20)) {
          return error(429, 'Rate limit exceeded. Please wait a minute before rotating key.');
        }

        const rawToken = extractBearerToken(request);
        if (!rawToken) {
          return error(401, 'Unauthorized: valid bearer token required for key rotation');
        }

        const currentHash = hashToken(rawToken);
        const teacher = await db.teachers.getByTokenHash(currentHash);
        if (!teacher) {
          return error(401, 'Unauthorized: invalid bearer token');
        }
        if (teacher.active === 0) {
          return error(403, 'Forbidden: teacher account deactivated');
        }

        const newToken = generateToken();
        const newHash = hashToken(newToken);
        const rotated = await db.teachers.rotateToken(teacher.id, currentHash, newHash);
        if (!rotated) {
          return error(409, 'Conflict: token rotation failed or token was already rotated');
        }

        const quotaMb = Number(process.env?.KB_RELAY_TEACHER_QUOTA_MB || DEFAULT_TEACHER_QUOTA_MB);
        const quotaBytes = quotaMb * 1024 * 1024;

        return json(200, {
          ok: true,
          token: newToken,
          teacher_id: teacher.id,
          name: teacher.name,
          email: teacher.email,
          teacher: { id: teacher.id, name: teacher.name, email: teacher.email },
          bytes_used: teacher.bytes_used,
          quota_bytes: quotaBytes
        }, { 'Cache-Control': 'no-store' });
      }

      // POST /auth/claim (Short one-time claim code exchange)
      if (request.method === 'POST' && pathname === '/auth/claim') {
        const claimRateKey = `claim:${clientIp}`;
        if (!limiter.isAllowed(claimRateKey, 10)) {
          return error(429, 'Rate limit exceeded. Please wait a minute before claiming code.');
        }

        const body = await readJson(4096);
        const rawCode = body?.code || '';
        const normCode = normalizeClaimCode(rawCode);
        if (!normCode || normCode.length < 8) {
          return error(400, 'Valid claim code required');
        }

        const claimHash = hashToken(normCode);
        const newToken = generateToken();
        const newHash = hashToken(newToken);

        const teacher = await db.teachers.claimByCodeHash(claimHash, newHash);
        if (!teacher) {
          return error(401, 'Invalid or expired claim code');
        }

        const quotaMb = Number(process.env?.KB_RELAY_TEACHER_QUOTA_MB || DEFAULT_TEACHER_QUOTA_MB);
        const quotaBytes = quotaMb * 1024 * 1024;

        return json(200, {
          ok: true,
          token: newToken,
          teacher_id: teacher.id,
          name: teacher.name,
          email: teacher.email,
          teacher: { id: teacher.id, name: teacher.name, email: teacher.email },
          bytes_used: teacher.bytes_used,
          quota_bytes: quotaBytes
        }, { 'Cache-Control': 'no-store' });
      }

      // POST /auth/oidc (School SSO token exchange for Google & Microsoft)
      if (request.method === 'POST' && pathname === '/auth/oidc') {
        const isOidcEnabled = Boolean(oidcConfig.enabled || oidcConfig.googleClientId || oidcConfig.microsoftClientId);
        if (!isOidcEnabled) {
          return error(501, 'School OIDC SSO is not configured on this relay server');
        }

        const oidcRateKey = `oidc:${clientIp}`;
        if (!limiter.isAllowed(oidcRateKey, 15)) {
          return error(429, 'Rate limit exceeded. Please wait a minute before signing in again.');
        }

        const body = await readJson(16384);
        const { provider, id_token } = body || {};
        if (!provider || !id_token) {
          return error(400, 'Both provider and id_token are required');
        }

        let claims;
        try {
          claims = await verifyOidcToken({
            provider,
            idToken: id_token,
            oidcConfig,
            fetchImpl: options.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null)
          });
        } catch (err) {
          return error(401, `OIDC authentication failed: ${err.message}`);
        }

        // Look up teacher by verified email
        let teacher = await db.teachers.getByEmail(claims.email);
        const autoProvision = Boolean(oidcConfig.autoProvisionTeachers);

        if (!teacher && autoProvision) {
          const generatedId = `T-${createHash('sha256').update(claims.email).digest('hex').slice(0, 8).toUpperCase()}`;
          const initialToken = generateToken();
          teacher = await db.teachers.create({
            id: generatedId,
            name: claims.name || claims.email.split('@')[0],
            email: claims.email,
            tokenHash: hashToken(initialToken),
            active: 1
          });
        }

        if (!teacher) {
          return error(403, `Unauthorized: ${claims.email} is not registered on this school relay`);
        }
        if (teacher.active === 0) {
          return error(403, 'Forbidden: teacher account deactivated');
        }

        // Rotate token on SSO sign-in
        const newToken = generateToken();
        const newHash = hashToken(newToken);
        await db.teachers.adminResetToken(teacher.id, newHash);

        const quotaMb = Number(process.env?.KB_RELAY_TEACHER_QUOTA_MB || DEFAULT_TEACHER_QUOTA_MB);
        const quotaBytes = quotaMb * 1024 * 1024;

        return json(200, {
          ok: true,
          token: newToken,
          teacher_id: teacher.id,
          name: teacher.name,
          email: teacher.email || claims.email,
          bytes_used: teacher.bytes_used,
          quota_bytes: quotaBytes
        }, { 'Cache-Control': 'no-store' });
      }

      // -------------------------------------------------------------
      // GET /whoami (authenticated teacher check)
      // -------------------------------------------------------------
      if (request.method === 'GET' && pathname === '/whoami') {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }
        const quotaMb = Number(process.env?.KB_RELAY_TEACHER_QUOTA_MB || DEFAULT_TEACHER_QUOTA_MB);
        const quotaBytes = quotaMb * 1024 * 1024;
        return json(200, {
          teacher_id: teacher.id,
          name: teacher.name,
          bytes_used: teacher.bytes_used,
          quota_bytes: quotaBytes
        });
      }

      // -------------------------------------------------------------
      // GET /usage (authenticated teacher storage usage)
      // -------------------------------------------------------------
      if (request.method === 'GET' && pathname === '/usage') {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }
        const usage = await db.teachers.getUsage(teacher.id);
        return json(200, usage);
      }

      // -------------------------------------------------------------
      // Media endpoints (CDN broker, R2, Fs, and DbPartsStore)
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
        const { sha256: fileHash, mime, ext, size: requestedSize = 0 } = parsed || {};
        if (!fileHash || !/^[a-f0-9]{64}$/i.test(fileHash)) {
          return error(400, 'Valid 64-hex sha256 required');
        }

        // Quota check
        const quotaMb = Number(process.env?.KB_RELAY_TEACHER_QUOTA_MB || DEFAULT_TEACHER_QUOTA_MB);
        const quotaBytes = quotaMb * 1024 * 1024;
        if (teacher.bytes_used + requestedSize > quotaBytes) {
          return json(507, { error: 'quota_exceeded', used: teacher.bytes_used, limit: quotaBytes });
        }

        const safeExt = String(ext || (mime === 'image/webp' ? 'webp' : mime === 'audio/webm' ? 'webm' : 'bin')).toLowerCase().replace(/[^a-z0-9]/gi, '');
        if (!ALLOWED_MEDIA_EXTS.has(safeExt)) {
          return error(400, `File extension .${safeExt} is not permitted`);
        }

        if (typeof presignHook === 'function') {
          const custom = await presignHook({ sha256: fileHash, mime, ext: safeExt, teacherId: teacher.id, size: requestedSize });
          return json(200, custom);
        }

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

        // Record media ref for teacher
        if (typeof db.mediaRefs?.addRef === 'function') {
          await db.mediaRefs.addRef({ sha: filename, ownerKind: 'teacher', ownerId: teacher.id, size: requestedSize });
        }

        if (endpoint && accessKeyId && secretAccessKey) {
          const presignedUrl = generateS3PresignedPutUrl({
            endpoint,
            bucket,
            key: objectKey,
            accessKeyId,
            secretAccessKey,
            region,
            contentType: EXT_TO_MIME[safeExt] || 'application/octet-stream'
          });
          const publicUrl = publicBase ? `${publicBase}/${objectKey}` : `${endpoint}/${bucket ? bucket + '/' : ''}${objectKey}`;
          return json(200, {
            upload_url: presignedUrl,
            public_url: publicUrl,
            method: 'PUT',
            headers: { 'Content-Type': EXT_TO_MIME[safeExt] || 'application/octet-stream' }
          });
        }

        // Direct store fallback
        const exp = Math.floor(Date.now() / 1000) + 3600;
        let signingSecret;
        try {
          signingSecret = await resolveSigningSecret();
        } catch (_) {
          return error(500, 'Media signing secret is not configured');
        }
        const sig = createHmac('sha256', signingSecret).update(`${filename}|${exp}`).digest('hex');

        const uploadUrl = `${proto}://${host}/api/v1/media/upload?key=${encodeURIComponent(filename)}&exp=${exp}&sig=${sig}`;
        const publicUrl = publicBase ? `${publicBase}/${filename}` : `${proto}://${host}/api/v1/media/file/${encodeURIComponent(filename)}`;
        return json(200, {
          upload_url: uploadUrl,
          public_url: publicUrl,
          method: 'PUT',
          headers: { 'Content-Type': EXT_TO_MIME[safeExt] || 'application/octet-stream' }
        });
      }

      // PUT /media/upload?key=<filename>&exp=<unix>&sig=<hmac>[&drop_id=<id>]
      if (request.method === 'PUT' && pathname === '/media/upload') {
        const key = url.searchParams.get('key');
        if (!key || !/^[a-f0-9]{64}\.[a-z0-9]+$/i.test(key)) {
          return error(400, 'Valid key parameter required');
        }

        const ext = key.split('.').pop()?.toLowerCase();
        if (!ALLOWED_MEDIA_EXTS.has(ext)) {
          return error(400, `File extension .${ext} is not permitted`);
        }

        const expStr = url.searchParams.get('exp');
        const sig = url.searchParams.get('sig');
        const dropId = url.searchParams.get('drop_id');
        const maxSizeStr = url.searchParams.get('max_size');

        if (!expStr || !sig) {
          return error(401, 'Unauthorized: exp and sig required');
        }
        const exp = parseInt(expStr, 10);
        if (isNaN(exp) || Math.floor(Date.now() / 1000) > exp) {
          return error(403, 'Media upload URL has expired');
        }

        let signingSecret;
        try {
          signingSecret = await resolveSigningSecret();
        } catch (_) {
          return error(500, 'Media signing secret is not configured');
        }
        const expectedSigPlain = createHmac('sha256', signingSecret).update(`${key}|${exp}`).digest('hex');
        const expectedSigDrop = dropId ? createHmac('sha256', signingSecret).update(`${key}|${exp}|${dropId}`).digest('hex') : null;
        const expectedSigDropMax = (dropId && maxSizeStr) ? createHmac('sha256', signingSecret).update(`${key}|${exp}|${dropId}|${maxSizeStr}`).digest('hex') : null;

        if (sig !== expectedSigPlain && (!expectedSigDrop || sig !== expectedSigDrop) && (!expectedSigDropMax || sig !== expectedSigDropMax)) {
          return error(403, 'Invalid media upload signature');
        }

        const maxAllowedSize = dropId
          ? (maxSizeStr ? Math.min(parseInt(maxSizeStr, 10) || MAX_STUDENT_MEDIA_SIZE, MAX_STUDENT_MEDIA_SIZE) : MAX_STUDENT_MEDIA_SIZE)
          : MAX_SYNC_SNAPSHOT_SIZE;

        const arrayBuf = await request.arrayBuffer();
        if (arrayBuf.byteLength > maxAllowedSize) {
          return error(413, 'Payload too large');
        }

        if (dropId) {
          try {
            if (typeof db?.checkMediaQuota === 'function') {
              await db.checkMediaQuota(dropId, arrayBuf.byteLength);
            } else if (typeof db?.dropMedia?.checkQuota === 'function') {
              await db.dropMedia.checkQuota(dropId, arrayBuf.byteLength);
            }
          } catch (err) {
            if (err.code === 'QUOTA_EXCEEDED') {
              return error(413, 'Media quota exceeded for this drop box');
            }
            throw err;
          }
        }

        // Verify body sha256 matches key
        const expectedHash = key.split('.')[0].toLowerCase();
        const actualHash = sha256(new Uint8Array(arrayBuf)).toLowerCase();
        if (actualHash !== expectedHash) {
          return error(400, 'Body sha256 does not match key');
        }

        // Server-derived Content-Type from extension allowlist
        const contentType = EXT_TO_MIME[ext] || 'application/octet-stream';

        if (!blobStore) {
          return error(503, 'Media storage service unavailable');
        }
        await blobStore.put(key, new Uint8Array(arrayBuf), contentType);

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
        const ext = key.split('.').pop()?.toLowerCase();
        if (!ALLOWED_MEDIA_EXTS.has(ext)) {
          return error(403, 'Forbidden media type');
        }

        const item = blobStore ? await blobStore.get(key) : null;
        if (!item) {
          return error(404, 'Media asset not found');
        }

        // Derive server-side Content-Type from extension
        const contentType = EXT_TO_MIME[ext] || 'application/octet-stream';
        const isInline = contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/');
        const disposition = isInline ? 'inline' : 'attachment';

        return new Response(item.data, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Content-Disposition': disposition,
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

        // Clamped / default expires_at (default 180 days, reject null)
        const defaultExp = new Date(Date.now() + DEFAULT_RETENTION_DAYS * 86400000).toISOString();
        let expiresAt = parsed.expires_at || defaultExp;
        if (parsed.expires_at === null) {
          return error(400, 'expires_at cannot be null');
        }
        const maxExp = defaultExp;
        if (expiresAt > maxExp) expiresAt = maxExp;

        // Quota check
        const payloadBytes = new TextEncoder().encode(parsed.ciphertext).length;
        const quotaMb = Number(process.env?.KB_RELAY_TEACHER_QUOTA_MB || DEFAULT_TEACHER_QUOTA_MB);
        const quotaBytes = quotaMb * 1024 * 1024;
        if (teacher.bytes_used + payloadBytes > quotaBytes) {
          return json(507, { error: 'quota_exceeded', used: teacher.bytes_used, limit: quotaBytes });
        }

        const ref = randomBytes(16).toString('base64url').slice(0, 22);
        await db.payloads.create({
          ref,
          teacherId: teacher.id,
          kind: parsed.kind,
          ciphertext: parsed.ciphertext,
          meta: parsed.meta,
          expiresAt
        });

        if (typeof db.teachers.adjustBytesUsed === 'function') {
          await db.teachers.adjustBytesUsed(teacher.id, payloadBytes);
        }

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
          ref: row.ref,
          kind: row.kind,
          ciphertext: row.ciphertext,
          meta: row.meta ? (typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta) : null,
          created_at: row.created_at,
          expires_at: row.expires_at
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

        const parsed = await readJson(16384);
        if (!parsed || !parsed.assignment_id) {
          return error(400, 'Missing assignment_id in drop creation');
        }

        const dropId = randomBytes(16).toString('base64url').slice(0, 22);
        const secret = (parsed.drop_secret && typeof parsed.drop_secret === 'string')
          ? parsed.drop_secret
          : randomBytes(24).toString('hex');
        const secretHash = sha256(secret);

        const defaultExp = new Date(Date.now() + DEFAULT_RETENTION_DAYS * 86400000).toISOString();
        let expiresAt = parsed.expires_at || defaultExp;
        if (parsed.expires_at === null) {
          return error(400, 'expires_at cannot be null');
        }
        if (expiresAt > defaultExp) expiresAt = defaultExp;

        await db.drops.create({
          id: dropId,
          teacherId: teacher.id,
          assignmentId: parsed.assignment_id,
          publishVersion: parsed.publish_version ?? 1,
          expiresAt,
          secretHash
        });

        return json(201, {
          drop_id: dropId,
          drop_secret: secret,
          expires_at: expiresAt
        });
      }

      // -------------------------------------------------------------
      // Workspaces & Replication Endpoints
      // -------------------------------------------------------------
      if (request.method === 'POST' && pathname === '/sync') {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }

        const workspaceId = randomBytes(16).toString('base64url').slice(0, 22);
        const workspaceKey = randomBytes(32).toString('hex');
        const keyHash = sha256(workspaceKey);

        await db.workspaces.create({
          id: workspaceId,
          keyHash,
          createdBy: teacher.id
        });

        return json(201, {
          workspace_id: workspaceId,
          workspace_key: workspaceKey
        });
      }

      // Sync workspace subroutes: /sync/:ws, /sync/:ws/chunks, /sync/:ws/snapshots/:dev, /sync/:ws/ack, /sync/:ws/devices/:dev
      const syncMatch = pathname.match(/^\/sync\/([A-Za-z0-9_\-]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/);
      if (syncMatch) {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }

        const [, workspaceId, resource, deviceParam] = syncMatch;
        const ws = await db.workspaces.get(workspaceId);
        const reqWorkspaceKey = request.headers.get('x-kb-workspace-key') || '';
        if (!ws || !sameHash(ws.key_hash, sha256(reqWorkspaceKey))) {
          return error(403, 'Forbidden: unknown workspace or wrong workspace key');
        }

        // Touch workspace last_seen_at
        if (typeof db.workspaces.touch === 'function') {
          await db.workspaces.touch(workspaceId);
        }

        // DELETE /sync/:ws (Forget this workspace)
        if (!resource && request.method === 'DELETE') {
          const teacher = await authenticateTeacher();
          if (!teacher || teacher.id !== ws.created_by) {
            return error(403, 'Forbidden: only the teacher who created this workspace can delete it');
          }
          const delRes = await db.workspaces.delete(workspaceId);
          if (delRes.blobKeys?.length > 0 && blobStore) {
            await blobStore.deleteMany(delRes.blobKeys);
          }
          return json(200, { ok: true, deleted: delRes.deleted });
        }

        // POST /sync/:ws/ack
        if (resource === 'ack' && request.method === 'POST') {
          const body = await readJson(16384);
          const deviceId = body?.deviceId || body?.device_id;
          if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
            return error(400, 'Valid deviceId required');
          }
          await db.workspaces.ackVector({ workspaceId, deviceId, vector: body.vector || {} });
          return json(200, { ok: true });
        }

        // DELETE /sync/:ws/devices/:dev (Remove device)
        if (resource === 'devices' && deviceParam && request.method === 'DELETE') {
          const teacher = await authenticateTeacher();
          const deviceToken = request.headers.get('x-kb-device-token');
          const devRow = await db.workspaces.getDevice(workspaceId, deviceParam);

          let authorized = false;
          if (teacher && teacher.id === ws.created_by) {
            authorized = true;
          } else if (devRow && devRow.device_token_hash && deviceToken) {
            if (sameHash(devRow.device_token_hash, hashToken(deviceToken))) {
              authorized = true;
            }
          } else if (!devRow) {
            authorized = true;
          }

          if (!authorized) {
            return error(403, 'Forbidden: you cannot delete this device');
          }

          const delRes = await db.workspaces.deleteDevice(workspaceId, deviceParam);
          if (delRes.blobKeys?.length > 0 && blobStore) {
            await blobStore.deleteMany(delRes.blobKeys);
          }
          return json(200, { ok: true, deleted: delRes.deleted });
        }

        // Chunks
        if (resource === 'chunks' && !deviceParam) {
          if (request.method === 'POST') {
            const body = await readJson(MAX_SYNC_CHUNK_SIZE);
            const start = Number(body?.start);
            const end = Number(body?.end);
            const deviceId = body?.device_id;
            if (!body || !DEVICE_ID_RE.test(deviceId || '') || !Number.isInteger(start) || !Number.isInteger(end)
              || start < 1 || end < start || typeof body.body !== 'string') {
              return error(400, 'Invalid sync chunk');
            }

            // Workspace device registration / token check
            const deviceToken = request.headers.get('x-kb-device-token');
            const devRow = await db.workspaces.getDevice(workspaceId, deviceId);
            if (devRow && devRow.device_token_hash && deviceToken) {
              if (!sameHash(devRow.device_token_hash, hashToken(deviceToken))) {
                return error(403, 'Forbidden: invalid device token');
              }
            } else if (!devRow && deviceToken) {
              await db.workspaces.registerDevice({ workspaceId, deviceId, deviceTokenHash: hashToken(deviceToken) });
            } else if (!devRow) {
              await db.workspaces.registerDevice({ workspaceId, deviceId });
            }

            if (typeof db.workspaces.touchDevice === 'function') {
              await db.workspaces.touchDevice(workspaceId, deviceId);
            }

            // Quota check against workspace owner
            const chunkSize = new TextEncoder().encode(body.body).length;
            const teacher = await db.teachers.getById(ws.created_by);
            const quotaMb = Number(process.env?.KB_RELAY_TEACHER_QUOTA_MB || DEFAULT_TEACHER_QUOTA_MB);
            const quotaBytes = quotaMb * 1024 * 1024;
            if (teacher && teacher.bytes_used + chunkSize > quotaBytes) {
              return json(507, { error: 'quota_exceeded', used: teacher.bytes_used, limit: quotaBytes });
            }

            const chunkSha256 = sha256(body.body);
            const bodyKey = `chunk_${workspaceId}_${deviceId}_${start}_${end}`;

            if (!blobStore) {
              return error(503, 'Blob storage service unavailable');
            }
            await blobStore.put(bodyKey, body.body, 'application/json');

            const { created } = await db.sync.putChunk({
              workspaceId,
              deviceId,
              start,
              end,
              bodyKey,
              size: chunkSize,
              sha256: chunkSha256
            });

            if (created && teacher && typeof db.teachers.adjustBytesUsed === 'function') {
              await db.teachers.adjustBytesUsed(teacher.id, chunkSize);
            }

            return json(created ? 201 : 200, { ok: true });
          }

          if (request.method === 'GET') {
            const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);
            const page = await db.sync.listChunks(workspaceId, { after });

            const items = [];
            for (const item of page.items) {
              let bodyStr = item.body;
              if (!bodyStr && item.body_key && blobStore) {
                const blob = await blobStore.get(item.body_key);
                if (blob) {
                  bodyStr = (blob.data instanceof Uint8Array) ? Buffer.from(blob.data).toString('utf8') : String(blob.data);
                }
              }
              items.push({
                seq: item.seq,
                device_id: item.device_id,
                start: item.start,
                end: item.end,
                body: bodyStr || ''
              });
            }

            return json(200, { items, more: page.more });
          }

          if (request.method === 'DELETE') {
            const deviceId = url.searchParams.get('device_id') || '';
            const through = parseInt(url.searchParams.get('through') || '', 10);
            if (!DEVICE_ID_RE.test(deviceId) || !Number.isInteger(through)) {
              return error(400, 'device_id and through are required');
            }

            const deviceToken = request.headers.get('x-kb-device-token');
            const devRow = await db.workspaces.getDevice(workspaceId, deviceId);
            if (devRow && devRow.device_token_hash && deviceToken) {
              if (!sameHash(devRow.device_token_hash, hashToken(deviceToken))) {
                return error(403, 'Forbidden: invalid device token');
              }
            }

            const delRes = await db.sync.deleteChunks(workspaceId, deviceId, through);
            if (delRes.blobKeys?.length > 0 && blobStore) {
              await blobStore.deleteMany(delRes.blobKeys);
            }
            return json(200, { deleted: delRes.deleted });
          }
        }

        // Snapshots
        if (resource === 'snapshots') {
          if (!deviceParam && request.method === 'GET') {
            return json(200, { items: await db.sync.listSnapshots(workspaceId) });
          }

          if (deviceParam && request.method === 'PUT') {
            const body = await readJson(MAX_SYNC_SNAPSHOT_SIZE);
            if (!body || typeof body.body !== 'string' || typeof body.created_at !== 'string') {
              return error(400, 'Invalid snapshot');
            }

            const deviceToken = request.headers.get('x-kb-device-token');
            const devRow = await db.workspaces.getDevice(workspaceId, deviceParam);
            if (devRow && devRow.device_token_hash && deviceToken) {
              if (!sameHash(devRow.device_token_hash, hashToken(deviceToken))) {
                return error(403, 'Forbidden: invalid device token');
              }
            } else if (!devRow && deviceToken) {
              await db.workspaces.registerDevice({ workspaceId, deviceId: deviceParam, deviceTokenHash: hashToken(deviceToken) });
            } else if (!devRow) {
              await db.workspaces.registerDevice({ workspaceId, deviceId: deviceParam });
            }

            if (typeof db.workspaces.touchDevice === 'function') {
              await db.workspaces.touchDevice(workspaceId, deviceParam);
            }

            const snapSize = new TextEncoder().encode(body.body).length;
            const teacher = await db.teachers.getById(ws.created_by);
            const quotaMb = Number(process.env?.KB_RELAY_TEACHER_QUOTA_MB || DEFAULT_TEACHER_QUOTA_MB);
            const quotaBytes = quotaMb * 1024 * 1024;
            if (teacher && teacher.bytes_used + snapSize > quotaBytes) {
              return json(507, { error: 'quota_exceeded', used: teacher.bytes_used, limit: quotaBytes });
            }

            const snapSha256 = sha256(body.body);
            const bodyKey = `snapshot_${workspaceId}_${deviceParam}_${snapSha256.slice(0, 16)}`;

            if (!blobStore) {
              return error(503, 'Blob storage service unavailable');
            }
            await blobStore.put(bodyKey, body.body, 'application/json');

            const { oldKey } = await db.sync.putSnapshot({
              workspaceId,
              deviceId: deviceParam,
              createdAt: body.created_at,
              bodyKey,
              size: snapSize,
              sha256: snapSha256
            });

            if (oldKey && blobStore) {
              await blobStore.delete(oldKey);
            }

            return json(200, { ok: true });
          }

          if (deviceParam && request.method === 'GET') {
            const row = await db.sync.getSnapshot(workspaceId, deviceParam);
            if (!row) {
              return error(404, 'Snapshot not found');
            }
            let snapBody = '';
            if (row.body_key && blobStore) {
              const blob = await blobStore.get(row.body_key);
              if (blob) {
                snapBody = (blob.data instanceof Uint8Array) ? Buffer.from(blob.data).toString('utf8') : String(blob.data);
              }
            }
            return json(200, { created_at: row.created_at, body: snapBody });
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

        const parsed = await readJson(8192);
        const { sha256: fileHash, mime, ext, size } = parsed || {};
        if (!fileHash || !/^[a-f0-9]{64}$/i.test(fileHash)) {
          return error(400, 'Valid 64-hex sha256 required');
        }

        const safeExt = String(ext || 'bin').toLowerCase().replace(/[^a-z0-9]/gi, '');
        if (!ALLOWED_MEDIA_EXTS.has(safeExt)) {
          return error(400, `File extension .${safeExt} is not permitted`);
        }

        const fileSize = Number(size) || 0;
        if (fileSize > MAX_STUDENT_MEDIA_SIZE) {
          return error(413, `File exceeds maximum allowed student media size (${MAX_STUDENT_MEDIA_SIZE} bytes)`);
        }

        if (fileSize > 0) {
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
        }

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
            contentType: EXT_TO_MIME[safeExt] || 'application/octet-stream'
          });
          const publicUrl = publicBase ? `${publicBase}/${objectKey}` : `${endpoint}/${bucket ? bucket + '/' : ''}${objectKey}`;
          return json(200, {
            upload_url: presignedUrl,
            public_url: publicUrl,
            method: 'PUT',
            headers: { 'Content-Type': EXT_TO_MIME[safeExt] || 'application/octet-stream' }
          });
        }

        const exp = Math.floor(Date.now() / 1000) + 3600;
        let signingSecret;
        try {
          signingSecret = await resolveSigningSecret();
        } catch (_) {
          return error(500, 'Media signing secret is not configured');
        }
        const sig = createHmac('sha256', signingSecret).update(`${filename}|${exp}|${dropId}|${MAX_STUDENT_MEDIA_SIZE}`).digest('hex');

        const uploadUrl = `${proto}://${host}/api/v1/media/upload?key=${encodeURIComponent(filename)}&exp=${exp}&sig=${sig}&drop_id=${encodeURIComponent(dropId)}&max_size=${MAX_STUDENT_MEDIA_SIZE}`;
        const publicUrl = publicBase ? `${publicBase}/${filename}` : `${proto}://${host}/api/v1/media/file/${encodeURIComponent(filename)}`;
        return json(200, {
          upload_url: uploadUrl,
          public_url: publicUrl,
          method: 'PUT',
          headers: { 'Content-Type': EXT_TO_MIME[safeExt] || 'application/octet-stream' }
        });
      }

      // -------------------------------------------------------------
      // Submissions (POST to drop, GET drop submissions, GET stats)
      // -------------------------------------------------------------
      const dropSubmitMatch = pathname.match(/^\/drops\/([A-Za-z0-9_\-]+)\/submissions$/);
      if (request.method === 'POST' && dropSubmitMatch) {
        const dropId = dropSubmitMatch[1];
        const subRateKey = `sub:${dropId}:${clientIp}`;
        if (!limiter.isAllowed(subRateKey, SUBMISSION_RATE_LIMIT_PER_MIN)) {
          return error(429, 'Rate limit exceeded. Please wait a minute before submitting again.');
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

        const rawBody = await readText(MAX_SUBMISSION_SIZE);
        const trimmed = rawBody.trim();
        if (!trimmed.startsWith('KBSUB1.')) {
          return error(400, 'Invalid submission format: envelope must start with KBSUB1.');
        }

        const subBytes = new TextEncoder().encode(trimmed).length;
        const ciphertextSha256 = createHash('sha256').update(trimmed).digest('hex');
        const receiptId = ciphertextSha256.slice(0, 8).toUpperCase();
        const submissionId = createHash('sha256').update(`${dropId}:${trimmed}`).digest('hex').slice(0, 32);

        let bodyKey = null;
        let textToStore = trimmed;

        if (subBytes >= INLINE_SUBMISSION_THRESHOLD) {
          bodyKey = `sub_${submissionId}`;
          textToStore = null;
          if (!blobStore) {
            return error(503, 'Blob storage service unavailable');
          }
          await blobStore.put(bodyKey, trimmed, 'text/plain');
        }

        try {
          const resEntry = await db.submissions.create({
            id: submissionId,
            dropId,
            text: textToStore,
            bodyKey,
            size: subBytes
          });

          let signingSecret;
          try {
            signingSecret = await resolveSigningSecret();
          } catch (_) {
            return error(500, 'Media signing secret is not configured');
          }
          const relayReceiptSig = createHmac('sha256', signingSecret)
            .update(`${dropId}|${ciphertextSha256}|${resEntry.receivedAt}`)
            .digest('hex');

          if (resEntry.duplicate) {
            return json(200, {
              duplicate: true,
              receipt_id: receiptId,
              received_at: resEntry.receivedAt,
              ciphertext_sha256: ciphertextSha256,
              relay_receipt_sig: relayReceiptSig
            });
          }

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

      // GET /drops/:dropId/submissions
      if (request.method === 'GET' && dropSubmitMatch) {
        const dropId = dropSubmitMatch[1];
        const drop = await db.drops.get(dropId);
        if (!drop) {
          return error(404, 'Drop box not found');
        }
        if (drop.expired) {
          return error(410, 'Drop box expired');
        }

        const hasValidSecret = Boolean(request.headers.get('x-kb-drop-secret') && dropSecretOk(drop));
        let teacher = null;
        try {
          teacher = await authenticateTeacher();
        } catch (_) {}

        if (!hasValidSecret && (!teacher || drop.teacher_id !== teacher.id)) {
          if (!teacher && !request.headers.get('x-kb-drop-secret')) {
            return error(401, 'Unauthorized: valid teacher token or drop secret required');
          }
          return error(403, 'Forbidden: you do not own this drop box');
        }

        const since = url.searchParams.get('since') || undefined;
        const after = url.searchParams.get('after') || undefined;
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);
        const listResult = await db.submissions.list(dropId, { since, after, limit });
        const rawItems = Array.isArray(listResult) ? listResult : (listResult.items || []);
        const next_after = listResult.next_after || null;
        const more = !!listResult.more;

        const items = [];
        for (const item of rawItems) {
          let text = item.text;
          if (!text && item.body_key && blobStore) {
            const blob = await blobStore.get(item.body_key);
            if (blob) {
              text = (blob.data instanceof Uint8Array) ? Buffer.from(blob.data).toString('utf8') : String(blob.data);
            }
          }
          items.push({
            id: item.id,
            received_at: item.received_at,
            text: text || ''
          });
        }

        return json(200, { items, next_after, more });
      }

      // GET /drops/:dropId/stats
      const dropStatsMatch = pathname.match(/^\/drops\/([A-Za-z0-9_\-]+)\/stats$/);
      if (request.method === 'GET' && dropStatsMatch) {
        const dropId = dropStatsMatch[1];
        const drop = await db.drops.get(dropId);
        if (!drop) {
          return error(404, 'Drop box not found');
        }
        if (drop.expired) {
          return error(410, 'Drop box expired');
        }

        const hasValidSecret = Boolean(request.headers.get('x-kb-drop-secret') && dropSecretOk(drop));
        let teacher = null;
        try {
          teacher = await authenticateTeacher();
        } catch (_) {}

        if (!hasValidSecret && (!teacher || drop.teacher_id !== teacher.id)) {
          if (!teacher && !request.headers.get('x-kb-drop-secret')) {
            return error(401, 'Unauthorized: valid teacher token or drop secret required');
          }
          return error(403, 'Forbidden: you do not own this drop box');
        }

        const mediaStats = (typeof db.dropMedia?.getStats === 'function')
          ? await db.dropMedia.getStats(dropId)
          : { count: 0, totalSize: 0 };
        const subCount = (typeof db.submissions?.count === 'function')
          ? await db.submissions.count(dropId)
          : (await db.submissions.list(dropId)).length;

        return json(200, {
          drop_id: dropId,
          submissions_count: subCount,
          media_count: mediaStats.count || 0,
          media_bytes: mediaStats.totalSize || 0,
          expires_at: drop.expires_at || null
        });
      }

      // DELETE /drops/:dropId
      const dropDeleteMatch = pathname.match(/^\/drops\/([A-Za-z0-9_\-]+)$/);
      if (request.method === 'DELETE' && dropDeleteMatch) {
        const teacher = await authenticateTeacher();
        if (!teacher) {
          return error(401, 'Unauthorized: valid teacher token required');
        }

        const dropId = dropDeleteMatch[1];
        const { deleted, blobKeys } = await db.drops.delete(dropId, teacher.id);
        if (!deleted) {
          return error(404, 'Drop not found or not owned by you');
        }

        if (blobStore && blobKeys?.length > 0) {
          await blobStore.deleteMany(blobKeys);
        }

        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // Course Feeds: PUT /feed/:id, GET /feed/:id, DELETE /feed/:id
      // -------------------------------------------------------------
      const feedMatch = pathname.match(/^(?:\/api)?\/feed\/([A-Za-z0-9_\-]+)$/);
      if (feedMatch) {
        const courseId = feedMatch[1];

        // PUT /feed/:courseId
        if (request.method === 'PUT') {
          const teacher = await authenticateTeacher();
          if (!teacher) {
            return error(401, 'Unauthorized: valid teacher token required');
          }

          const parsed = await readJson(MAX_PAYLOAD_SIZE);
          if (!parsed) {
            return error(400, 'Invalid JSON body');
          }

          const ciphertext = typeof parsed === 'string' ? parsed : parsed.ciphertext;
          if (!ciphertext) {
            return error(400, 'Missing ciphertext in feed payload');
          }

          // Feed TTL refreshed on each publish
          const defaultExp = new Date(Date.now() + DEFAULT_RETENTION_DAYS * 86400000).toISOString();
          const expiresAt = parsed.expires_at || defaultExp;

          // Quota check
          const feedBytes = new TextEncoder().encode(ciphertext).length;
          const quotaMb = Number(process.env?.KB_RELAY_TEACHER_QUOTA_MB || DEFAULT_TEACHER_QUOTA_MB);
          const quotaBytes = quotaMb * 1024 * 1024;
          if (teacher.bytes_used + feedBytes > quotaBytes) {
            return json(507, { error: 'quota_exceeded', used: teacher.bytes_used, limit: quotaBytes });
          }

          const etag = parsed.etag || createHash('sha256').update(ciphertext).digest('hex').slice(0, 16);
          try {
            await db.feeds.put({
              courseId,
              teacherId: teacher.id,
              ciphertext,
              etag,
              updatedAt: new Date().toISOString(),
              expiresAt
            });
          } catch (err) {
            if (err.code === 'FORBIDDEN' || err.message === 'FEED_OWNERSHIP_CONFLICT') {
              return error(403, 'Forbidden: you do not own this course feed');
            }
            throw err;
          }

          return json(200, { ok: true, etag }, { 'ETag': `"${etag}"` });
        }

        // GET /feed/:courseId
        if (request.method === 'GET') {
          const feedRateKey = `feed:${courseId}:${clientIp}`;
          if (!limiter.isAllowed(feedRateKey, 60)) {
            return error(429, 'Rate limit exceeded. Please wait a minute before querying feed again.');
          }

          const feed = await db.feeds.get(courseId);
          if (!feed) {
            return error(404, 'Course feed not found');
          }
          if (feed.expired) {
            return error(410, 'Course feed expired');
          }

          const ifNoneMatch = request.headers.get('if-none-match');
          if (feed.etag && ifNoneMatch && (ifNoneMatch === feed.etag || ifNoneMatch === `"${feed.etag}"`)) {
            return new Response(null, {
              status: 304,
              headers: {
                'ETag': `"${feed.etag}"`,
                ...corsHeaders
              }
            });
          }

          const responseHeaders = {};
          if (feed.etag) {
            responseHeaders['ETag'] = `"${feed.etag}"`;
          }

          return json(200, {
            course_id: feed.courseId,
            ciphertext: feed.ciphertext,
            etag: feed.etag,
            updated_at: feed.updatedAt
          }, responseHeaders);
        }

        // DELETE /feed/:courseId
        if (request.method === 'DELETE') {
          const teacher = await authenticateTeacher();
          if (!teacher) {
            return error(401, 'Unauthorized: valid teacher token required');
          }
          try {
            const deleted = await db.feeds.delete(courseId, teacher.id);
            if (!deleted) {
              return error(404, 'Course feed not found');
            }
            return new Response(null, { status: 204, headers: corsHeaders });
          } catch (err) {
            if (err.code === 'FORBIDDEN' || err.message === 'FEED_OWNERSHIP_CONFLICT') {
              return error(403, 'Forbidden: you do not own this course feed');
            }
            throw err;
          }
        }
      }

      // -------------------------------------------------------------
      // Feedback Drops
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
          try {
            await db.feedbackDrops.put({ dropId, teacherId: teacher.id, ciphertext, expiresAt });
          } catch (err) {
            if (err.code === 'FORBIDDEN' || err.message === 'FEEDBACK_DROP_OWNERSHIP_CONFLICT') {
              return error(403, 'Forbidden: feedback drop ownership conflict');
            }
            throw err;
          }
          return json(200, { ok: true, drop_id: dropId, expires_at: expiresAt });
        }

        // GET /feedback/:dropId
        if (request.method === 'GET') {
          const fbRateKey = `fb:${dropId}:${clientIp}`;
          if (!limiter.isAllowed(fbRateKey, 60)) {
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
          try {
            const deleted = await db.feedbackDrops.delete(dropId, teacher.id);
            if (!deleted) {
              return error(404, 'Feedback drop not found or not owned by you');
            }
            return new Response(null, { status: 204, headers: corsHeaders });
          } catch (err) {
            if (err.code === 'FORBIDDEN' || err.message === 'FEEDBACK_DROP_OWNERSHIP_CONFLICT') {
              return error(403, 'Forbidden: feedback drop ownership conflict');
            }
            throw err;
          }
        }
      }

      return error(404, 'Not found');
    } catch (err) {
      if (err.status === 403 || err.message === 'TEACHER_DEACTIVATED') {
        return error(403, 'Forbidden: teacher account deactivated');
      }
      if (err.code === 413 || err.message === 'PAYLOAD_TOO_LARGE') {
        return error(413, 'Payload too large');
      }
      console.error('[Relay Fetch Error]', err);
      return error(500, 'Internal server error');
    }
  };
}
