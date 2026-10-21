import { createD1Database } from './d1-db.js';
import { createR2MediaStore } from './media-store.js';
import {
  createRelayFetchHandler,
  RateLimiter,
  DRAFT_RATE_LIMIT_MAX,
  DEFAULT_RETENTION_DAYS
} from './handler.js';

// Per-isolate rate limiters (salted SHA-256 IP hashes in memory)
const limiter = new RateLimiter();
const draftLimiter = new RateLimiter(DRAFT_RATE_LIMIT_MAX);

export default {
  async fetch(request, env, ctx) {
    if (!env?.DB) {
      return new Response(JSON.stringify({ error: 'D1 database binding (DB) is not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const db = createD1Database(env.DB);
    const originsEnv = env.KB_RELAY_ORIGINS || '*';
    const allowedOrigins = originsEnv.split(',').map(s => s.trim()).filter(Boolean);
    const mediaStore = env.MEDIA_BUCKET ? createR2MediaStore(env.MEDIA_BUCKET) : null;

    const handler = createRelayFetchHandler({
      db,
      limiter,
      draftLimiter,
      allowedOrigins,
      mediaStore,
      cdnConfig: {
        enabled: Boolean(mediaStore || env.KB_CDN_ENDPOINT || env.KB_CDN_PUBLIC_URL),
        endpoint: env.KB_CDN_ENDPOINT,
        bucket: env.KB_CDN_BUCKET,
        accessKeyId: env.KB_CDN_ACCESS_KEY_ID,
        secretAccessKey: env.KB_CDN_SECRET_ACCESS_KEY,
        region: env.KB_CDN_REGION || 'auto',
        publicUrl: env.KB_CDN_PUBLIC_URL
      }
    });

    const clientIp = request.headers.get('cf-connecting-ip')
      || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || '127.0.0.1';

    return handler(request, { clientIp });
  },

  async scheduled(event, env, ctx) {
    if (!env?.DB) return;
    const db = createD1Database(env.DB);
    const retentionDays = env.KB_RELAY_RETENTION_DAYS !== undefined
      ? Number(env.KB_RELAY_RETENTION_DAYS)
      : DEFAULT_RETENTION_DAYS;
    if (ctx?.waitUntil) {
      ctx.waitUntil(db.pruneExpired({ retentionDays }));
    } else {
      await db.pruneExpired({ retentionDays });
    }
  }
};
