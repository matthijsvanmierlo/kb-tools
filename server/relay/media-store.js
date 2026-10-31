import fs from 'node:fs';
import path from 'node:path';

/**
 * In-memory media store (for tests, dev, or ephemeral setups).
 */
export function createMemoryMediaStore(backingMap = new Map()) {
  return {
    kind: 'memory',
    enabled: true,
    async put(key, data, contentType = 'application/octet-stream') {
      const bytes = data instanceof Uint8Array ? data : Buffer.from(data);
      backingMap.set(key, { data: bytes, contentType });
      return { ok: true, key };
    },
    async get(key) {
      const item = backingMap.get(key);
      if (!item) return null;
      return { data: item.data, contentType: item.contentType || 'application/octet-stream' };
    },
    async delete(key) {
      return backingMap.delete(key);
    },
    async deleteMany(keys = []) {
      for (const k of keys) backingMap.delete(k);
      return true;
    },
    raw: backingMap
  };
}

/**
 * Local filesystem media store for Node.js (when KB_CDN_LOCAL_DIR is set).
 */
export function createFsMediaStore(dirPath) {
  const dir = path.resolve(dirPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}

  return {
    kind: 'fs',
    enabled: true,
    async put(key, data, contentType = 'application/octet-stream') {
      const filePath = path.join(dir, key);
      const metaPath = path.join(dir, `${key}.meta.json`);
      const bytes = data instanceof Uint8Array ? data : Buffer.from(data);
      await fs.promises.writeFile(filePath, bytes);
      await fs.promises.writeFile(metaPath, JSON.stringify({ contentType }), 'utf8');
      return { ok: true, key };
    },
    async get(key) {
      const filePath = path.join(dir, key);
      const metaPath = path.join(dir, `${key}.meta.json`);
      if (!fs.existsSync(filePath)) return null;
      const data = await fs.promises.readFile(filePath);
      let contentType = 'application/octet-stream';
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
          contentType = meta.contentType || contentType;
        } catch (_) {}
      }
      return { data, contentType };
    },
    async delete(key) {
      const filePath = path.join(dir, key);
      const metaPath = path.join(dir, `${key}.meta.json`);
      try { await fs.promises.unlink(filePath); } catch (_) {}
      try { await fs.promises.unlink(metaPath); } catch (_) {}
      return true;
    },
    async deleteMany(keys = []) {
      for (const k of keys) {
        await this.delete(k);
      }
      return true;
    }
  };
}

/**
 * Native Cloudflare R2 bucket media store for Cloudflare Workers (env.MEDIA_BUCKET).
 */
export function createR2MediaStore(r2Bucket) {
  return {
    kind: 'r2',
    enabled: true,
    async put(key, data, contentType = 'application/octet-stream') {
      const objectKey = `assets/${key}`;
      await r2Bucket.put(objectKey, data, {
        httpMetadata: {
          contentType: contentType || 'application/octet-stream',
          cacheControl: 'public, max-age=31536000, immutable'
        }
      });
      return { ok: true, key };
    },
    async get(key) {
      const objectKey = `assets/${key}`;
      const obj = await r2Bucket.get(objectKey);
      if (!obj) return null;
      const arrayBuf = await obj.arrayBuffer();
      return {
        data: new Uint8Array(arrayBuf),
        contentType: obj.httpMetadata?.contentType || 'application/octet-stream'
      };
    },
    async delete(key) {
      const objectKey = `assets/${key}`;
      try {
        await r2Bucket.delete(objectKey);
      } catch (_) {}
      return true;
    },
    async deleteMany(keys = []) {
      for (const k of keys) {
        await this.delete(k);
      }
      return true;
    },
    raw: r2Bucket
  };
}
