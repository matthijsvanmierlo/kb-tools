import lzLib from 'lz-string';

const LZString = lzLib.compressToEncodedURIComponent ? lzLib : (lzLib.default || lzLib);

/**
 * CryptoShareEngine - KB-CORE-004
 * Zero-backend sharing with the Web Crypto API.
 *
 * Format v2 (default when CompressionStream exists):
 *   JSON → deflate-raw → [PBKDF2-SHA-256 600k → AES-256-GCM, packed salt(16)‖iv(12)‖ct] → base64url
 *   URL: #/share?v=2&enc=0|1&d=…    file: {"v":2,"enc":0|1,"d":"…"}
 * Format v1 (legacy, still decoded): LZ-String, PBKDF2 100k.
 *
 * Everything after `#` stays in the browser (RFC 3986 fragments are never sent to the server),
 * and the router scrubs it from the address bar as soon as it has been read.
 */
export const SHARE_FORMAT_VERSION = 2;
export const PBKDF2_ITERATIONS = 600000;
const LEGACY_PBKDF2_ITERATIONS = 100000;
// Binds ciphertext to this format so a v2 blob can never be reinterpreted as something else
const V2_AAD = new TextEncoder().encode('kb-share-v2');

const getSubtle = () => {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto API is not available');
  return subtle;
};

export function supportsCompressionStreams() {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

async function pipeBytes(bytes, transform) {
  const writer = transform.writable.getWriter();
  // Write and read concurrently: awaiting the write first can deadlock on backpressure
  const written = writer.write(bytes).then(() => writer.close());
  const reader = transform.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await written;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export const deflateRaw = (bytes) => pipeBytes(bytes, new CompressionStream('deflate-raw'));
export const inflateRaw = (bytes) => pipeBytes(bytes, new DecompressionStream('deflate-raw'));

export class CryptoShareEngine {
  /**
   * Derive AES-GCM key from passphrase and 16-byte salt via PBKDF2-SHA-256
   * @param {string} passphrase
   * @param {Uint8Array} saltUint8
   * @param {number} [iterations]
   * @returns {Promise<CryptoKey>}
   */
  static async deriveKey(passphrase, saltUint8, iterations = PBKDF2_ITERATIONS) {
    const subtle = getSubtle();
    const keyMaterial = await subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return subtle.deriveKey(
      { name: 'PBKDF2', salt: saltUint8, iterations, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Serialize and optionally encrypt a payload for URL or .kbshare file sharing
   * @param {string} moduleType - 'flashcards' | 'timeline' | 'video' | 'gradebook' | 'student_grade_report' | …
   * @param {object} dataObject - Dataset to share
   * @param {string} [passphrase=''] - Optional encryption passphrase
   * @param {{ version?: 1|2 }} [options] - force a format (tests / compatibility)
   * @returns {Promise<{ url: string, exceedsUrlLimit: boolean, rawFileContent: string, length: number, version: number }>}
   */
  static async createSharePayload(moduleType, dataObject, passphrase = '', options = {}) {
    const envelope = JSON.stringify({ v: 1, type: moduleType, payload: dataObject });
    const isEncrypted = Boolean(passphrase && passphrase.trim().length > 0);
    const version = options.version || (supportsCompressionStreams() ? SHARE_FORMAT_VERSION : 1);

    const d = version === 2
      ? await this._packV2(envelope, isEncrypted ? passphrase : '')
      : await this._packV1(envelope, isEncrypted ? passphrase : '');

    const baseUrl = typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : 'http://localhost/';
    const versionParam = version === 2 ? 'v=2&' : '';
    const shareUrl = `${baseUrl}#/share?${versionParam}enc=${isEncrypted ? '1' : '0'}&d=${d}`;

    const file = { enc: isEncrypted ? 1 : 0, d };
    if (version === 2) file.v = 2;

    return {
      url: shareUrl,
      exceedsUrlLimit: shareUrl.length > 2048,
      length: shareUrl.length,
      version,
      rawFileContent: JSON.stringify(file)
    };
  }

  static async _packV2(envelope, passphrase) {
    const compressed = await deflateRaw(new TextEncoder().encode(envelope));
    if (!passphrase) return bytesToB64Url(compressed);

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
    const ct = new Uint8Array(await getSubtle().encrypt({ name: 'AES-GCM', iv, additionalData: V2_AAD }, key, compressed));
    const packed = new Uint8Array(28 + ct.byteLength);
    packed.set(salt, 0);
    packed.set(iv, 16);
    packed.set(ct, 28);
    return bytesToB64Url(packed);
  }

  static async _packV1(envelope, passphrase) {
    if (!passphrase) return LZString.compressToEncodedURIComponent(envelope);

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveKey(passphrase, salt, LEGACY_PBKDF2_ITERATIONS);
    const ct = await getSubtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(envelope));
    const packed = new Uint8Array(28 + ct.byteLength);
    packed.set(salt, 0);
    packed.set(iv, 16);
    packed.set(new Uint8Array(ct), 28);
    let binStr = '';
    for (let i = 0; i < packed.byteLength; i++) binStr += String.fromCharCode(packed[i]);
    return LZString.compressToEncodedURIComponent(binStr);
  }

  /**
   * Parse a .kbshare file body into share parameters.
   * @param {string} text
   * @returns {{ d: string, enc: '0'|'1', v: number }}
   */
  static parseShareFile(text) {
    let parsed;
    try {
      parsed = JSON.parse(String(text || '').trim());
    } catch (_) {
      throw new Error('CORRUPTED_PAYLOAD');
    }
    if (!parsed || typeof parsed.d !== 'string') throw new Error('CORRUPTED_PAYLOAD');
    const enc = parsed.enc === 1 || parsed.enc === '1' || parsed.enc === true ? '1' : '0';
    return { d: parsed.d, enc, v: Number(parsed.v) === 2 ? 2 : 1 };
  }

  /**
   * Unpack and optionally decrypt a shared payload
   * @param {string} dParam - encoded payload string
   * @param {boolean} isEncrypted - Whether AES-GCM decryption is required
   * @param {string} [passphrase=''] - User-entered passphrase
   * @param {number} [version] - share format version: the `v` URL/file parameter (absent → 1).
   *   Defaults to the format createSharePayload produces in this browser.
   * @returns {Promise<{ v: number, type: string, payload: any }>}
   */
  static async unpackSharePayload(dParam, isEncrypted, passphrase = '', version = supportsCompressionStreams() ? SHARE_FORMAT_VERSION : 1) {
    if (Number(version) === 2) return this._unpackV2(dParam, isEncrypted, passphrase);
    return this._unpackV1(dParam, isEncrypted, passphrase);
  }

  static async _unpackV2(dParam, isEncrypted, passphrase) {
    if (!supportsCompressionStreams()) throw new Error('UNSUPPORTED_BROWSER');
    let bytes;
    try {
      bytes = b64UrlToBytes(dParam);
    } catch (_) {
      throw new Error('CORRUPTED_PAYLOAD');
    }

    if (isEncrypted) {
      if (bytes.length < 28 + 16) throw new Error('CORRUPTED_PAYLOAD');
      const key = await this.deriveKey(passphrase, bytes.slice(0, 16), PBKDF2_ITERATIONS);
      try {
        bytes = new Uint8Array(await getSubtle().decrypt(
          { name: 'AES-GCM', iv: bytes.slice(16, 28), additionalData: V2_AAD }, key, bytes.slice(28)
        ));
      } catch (_) {
        throw new Error('INVALID_PASSPHRASE');
      }
    }

    try {
      return JSON.parse(new TextDecoder().decode(await inflateRaw(bytes)));
    } catch (_) {
      throw new Error('CORRUPTED_PAYLOAD');
    }
  }

  static async _unpackV1(dParam, isEncrypted, passphrase) {
    const decompressed = LZString.decompressFromEncodedURIComponent(dParam);
    if (!decompressed) throw new Error('CORRUPTED_PAYLOAD');

    if (!isEncrypted) {
      try {
        return JSON.parse(decompressed);
      } catch (e) {
        throw new Error('CORRUPTED_PAYLOAD');
      }
    }

    const packed = new Uint8Array(decompressed.length);
    for (let i = 0; i < decompressed.length; i++) {
      packed[i] = decompressed.charCodeAt(i);
    }

    if (packed.length < 28) {
      throw new Error('CORRUPTED_PAYLOAD');
    }

    const key = await this.deriveKey(passphrase, packed.slice(0, 16), LEGACY_PBKDF2_ITERATIONS);
    try {
      const decryptedBuf = await getSubtle().decrypt({ name: 'AES-GCM', iv: packed.slice(16, 28) }, key, packed.slice(28));
      return JSON.parse(new TextDecoder().decode(decryptedBuf));
    } catch (err) {
      throw new Error('INVALID_PASSPHRASE');
    }
  }

  /**
   * Helper to trigger download of a .kbshare file
   */
  static downloadKbShareFile(rawFileContent, filename = 'lesson.kbshare') {
    if (typeof document === 'undefined') return;
    const blob = new Blob([rawFileContent], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * Wrap rawFileContent for relay hosting (short links).
   * Encrypts with a random 256-bit AES-GCM key and returns base64url ciphertext and key.
   *
   * @param {string|object} rawFileContent
   * @returns {Promise<{ ciphertext: string, key: string }>}
   */
  static async wrapForHosting(rawFileContent) {
    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : globalThis.crypto?.subtle;
    if (!subtle) throw new Error('Web Crypto API is not available');

    const text = typeof rawFileContent === 'string' ? rawFileContent : JSON.stringify(rawFileContent);
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const cryptoKey = await subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
    const ciphertextBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(text));

    const packed = new Uint8Array(12 + ciphertextBuf.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(ciphertextBuf), 12);

    return {
      ciphertext: bytesToB64Url(packed),
      key: bytesToB64Url(rawKey)
    };
  }

  /**
   * Decrypt hosted ciphertext using the key from the URL fragment.
   *
   * @param {string} ciphertext
   * @param {string} key
   * @returns {Promise<string>} Plain rawFileContent string
   */
  static async unwrapHosted(ciphertext, key) {
    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : globalThis.crypto?.subtle;
    if (!subtle) throw new Error('Web Crypto API is not available');

    try {
      const rawKey = b64UrlToBytes(key);
      const packed = b64UrlToBytes(ciphertext);

      if (packed.byteLength < 13) throw new Error('CORRUPTED_CIPHERTEXT');

      const iv = packed.slice(0, 12);
      const data = packed.slice(12);

      const cryptoKey = await subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
      const decryptedBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, data);

      return new TextDecoder().decode(decryptedBuf);
    } catch (err) {
      throw new Error('DECRYPTION_FAILED');
    }
  }
}

function bytesToB64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToBytes(str) {
  let b64 = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export { bytesToB64Url, b64UrlToBytes };
export default CryptoShareEngine;
