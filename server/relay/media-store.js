import fs from 'node:fs';
import path from 'node:path';
import { MAX_BLOB_PART_SIZE } from './limits.js';

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
 * Local filesystem media store for Node.js (when disk storage is configured).
 */
export function createFsMediaStore(dirPath) {
  const dir = path.resolve(dirPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}

  return {
    kind: 'disk',
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
      return { data: new Uint8Array(data), contentType };
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
      const bytes = data instanceof Uint8Array ? data : Buffer.from(data);
      await r2Bucket.put(objectKey, bytes, {
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

/**
 * Database-backed parts store that splits large values into rows of <= 900 KB
 * in the blob_parts(key, idx, data) table.
 * Compatible with Node.js SQLite (DatabaseSync) and Cloudflare D1.
 */
export function createDbPartsStore(db) {
  // Database runner helper for Node sqlite vs D1
  const target = db?.raw || db;

  async function execRun(sql, params = []) {
    if (typeof target?.prepare === 'function') {
      const prep = target.prepare(sql);
      if (typeof prep.bind === 'function') {
        return await prep.bind(...params).run();
      }
      return prep.run(...params);
    }
    throw new Error('Database does not support prepare');
  }

  async function execAll(sql, params = []) {
    if (typeof target?.prepare === 'function') {
      const prep = target.prepare(sql);
      if (typeof prep.bind === 'function') {
        const res = await prep.bind(...params).all();
        return res?.results || [];
      }
      return prep.all(...params);
    }
    throw new Error('Database does not support prepare');
  }

  // Split binary into parts of 600 KB raw binary (which turns into ~800 KB base64, <= 900 KB)
  const RAW_CHUNK_SIZE = 600 * 1024;

  return {
    kind: 'db',
    enabled: true,
    async put(key, data, contentType = 'application/octet-stream') {
      let bytes;
      if (typeof data === 'string') {
        bytes = Buffer.from(data, 'utf8');
      } else if (data instanceof Uint8Array) {
        bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      } else {
        bytes = Buffer.from(data);
      }

      // First remove any existing parts for this key
      await execRun('DELETE FROM blob_parts WHERE key = ?', [key]);

      const totalBytes = bytes.length;
      const numParts = Math.ceil(totalBytes / RAW_CHUNK_SIZE) || 1;

      // Store metadata at idx = 0
      const metaJson = JSON.stringify({
        contentType: contentType || 'application/octet-stream',
        size: totalBytes,
        parts: numParts
      });
      await execRun('INSERT INTO blob_parts (key, idx, data) VALUES (?, ?, ?)', [key, 0, metaJson]);

      // Store parts starting at idx = 1
      for (let i = 0; i < numParts; i++) {
        const start = i * RAW_CHUNK_SIZE;
        const end = Math.min(start + RAW_CHUNK_SIZE, totalBytes);
        const slice = bytes.subarray(start, end);
        const b64 = slice.toString('base64');
        await execRun('INSERT INTO blob_parts (key, idx, data) VALUES (?, ?, ?)', [key, i + 1, b64]);
      }

      return { ok: true, key };
    },

    async get(key) {
      const rows = await execAll('SELECT idx, data FROM blob_parts WHERE key = ? ORDER BY idx ASC', [key]);
      if (!rows || rows.length === 0) return null;

      let contentType = 'application/octet-stream';
      const partBuffers = [];

      for (const row of rows) {
        if (row.idx === 0) {
          try {
            const meta = JSON.parse(row.data);
            contentType = meta.contentType || contentType;
          } catch (_) {}
        } else {
          partBuffers.push(Buffer.from(row.data, 'base64'));
        }
      }

      const combined = Buffer.concat(partBuffers);
      return {
        data: new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength),
        contentType
      };
    },

    async delete(key) {
      await execRun('DELETE FROM blob_parts WHERE key = ?', [key]);
      return true;
    },

    async deleteMany(keys = []) {
      for (const k of keys) {
        await this.delete(k);
      }
      return true;
    },

    raw: target
  };
}

/**
 * Main factory for BlobStore, selecting backend in order:
 * 1. R2 if r2Bucket (env.MEDIA_BUCKET) is provided
 * 2. Disk on Node if dirPath is provided
 * 3. DbPartsStore if db is provided
 * 4. In-memory store fallback
 */
export function createBlobStore({ r2Bucket, dirPath, db, memoryMap } = {}) {
  if (r2Bucket) {
    return createR2MediaStore(r2Bucket);
  }
  if (dirPath) {
    return createFsMediaStore(dirPath);
  }
  if (db) {
    return createDbPartsStore(db);
  }
  if (memoryMap) {
    return createMemoryMediaStore(memoryMap);
  }
  return createMemoryMediaStore();
}
