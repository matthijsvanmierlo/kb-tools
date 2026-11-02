import { createD1Database } from './d1-db.js';
import { createR2MediaStore, createDbPartsStore } from './media-store.js';
import {
  createRelayFetchHandler,
  RateLimiter,
  DRAFT_RATE_LIMIT_MAX,
  DEFAULT_RETENTION_DAYS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS
} from './handler.js';

export default {
  async fetch(request, env, ctx) {
    if (!env?.DB) {
      return new Response(JSON.stringify({ error: 'D1 database binding (DB) is not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const db = createD1Database(env.DB);
    // Initialize schema if not already initialized
    await db.initSchema();

    const originsEnv = env.KB_RELAY_ORIGINS || '*';
    const allowedOrigins = originsEnv.split(',').map(s => s.trim()).filter(Boolean);

    // Select BlobStore: R2 if MEDIA_BUCKET bound, otherwise DbPartsStore
    const blobStore = env.MEDIA_BUCKET
      ? createR2MediaStore(env.MEDIA_BUCKET)
      : createDbPartsStore(db);

    const limiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, db);
    const draftLimiter = new RateLimiter(DRAFT_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, db);

    const handler = createRelayFetchHandler({
      db,
      limiter,
      draftLimiter,
      allowedOrigins,
      blobStore,
      backend: 'd1',
      mediaSigningSecret: env.KB_MEDIA_SIGNING_SECRET || null,
      oidcConfig: {
        enabled: Boolean(env.KB_OIDC_GOOGLE_CLIENT_ID || env.KB_OIDC_MS_CLIENT_ID),
        googleClientId: env.KB_OIDC_GOOGLE_CLIENT_ID,
        googleDomain: env.KB_OIDC_GOOGLE_DOMAIN,
        microsoftClientId: env.KB_OIDC_MS_CLIENT_ID,
        microsoftTenant: env.KB_OIDC_MS_TENANT,
        autoProvisionTeachers: env.KB_OIDC_AUTO_PROVISION === 'true' || env.KB_OIDC_AUTO_PROVISION === '1'
      },
      cdnConfig: {
        enabled: Boolean(blobStore || env.KB_CDN_ENDPOINT || env.KB_CDN_PUBLIC_URL),
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
    const blobStore = env.MEDIA_BUCKET
      ? createR2MediaStore(env.MEDIA_BUCKET)
      : createDbPartsStore(db);

    const retentionDays = env.KB_RELAY_RETENTION_DAYS !== undefined
      ? Number(env.KB_RELAY_RETENTION_DAYS)
      : DEFAULT_RETENTION_DAYS;

    const doPrune = async () => {
      const pruneRes = await db.pruneExpired({ retentionDays });
      if (pruneRes?.expiredBlobKeys?.length > 0 && blobStore) {
        await blobStore.deleteMany(pruneRes.expiredBlobKeys);
      }
    };

    if (ctx?.waitUntil) {
      ctx.waitUntil(doPrune());
    } else {
      await doPrune();
    }
  }
};
