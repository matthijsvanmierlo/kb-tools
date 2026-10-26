/**
 * Student media CDN upload utilities with unconditional client-side AES-GCM encryption.
 * Encrypts files in the browser before transmission so that the relay server / CDN
 * only ever stores opaque ciphertext blocks.
 */

/**
 * Base64URL encode a Uint8Array.
 * @param {Uint8Array} uint8
 * @returns {string}
 */
export function toBase64Url(uint8) {
  let binary = '';
  for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Base64URL decode to a Uint8Array.
 * @param {string} base64url
 * @returns {Uint8Array}
 */
export function fromBase64Url(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Extract raw Uint8Array from Blob, File, ArrayBuffer, or TypedArray.
 * @param {any} blob
 * @returns {Promise<Uint8Array>}
 */
export async function getBytesFromBlob(blob) {
  if (!blob) return new Uint8Array();
  if (blob instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(blob))) {
    return new Uint8Array(blob);
  }
  if (ArrayBuffer.isView(blob)) {
    return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  }
  if (blob instanceof ArrayBuffer) {
    return new Uint8Array(blob);
  }
  if (blob._buffer) {
    return new Uint8Array(blob._buffer);
  }
  if (typeof blob.arrayBuffer === 'function') {
    try {
      return new Uint8Array(await blob.arrayBuffer());
    } catch (_) {}
  }
  if (typeof blob.bytes === 'function') {
    try {
      return await blob.bytes();
    } catch (_) {}
  }
  if (typeof FileReader !== 'undefined') {
    try {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
      });
    } catch (_) {}
  }
  return new Uint8Array();
}

/**
 * Encrypt a buffer or blob using AES-GCM (256-bit key, 96-bit IV) and compute its SHA-256.
 * @param {Blob|File|Uint8Array|ArrayBuffer} plainData
 * @returns {Promise<{ ciphertextBytes: Uint8Array, keyB64: string, ivB64: string, sha256Hex: string }>}
 */
export async function encryptBufferAesGcm(plainData) {
  const plainBytes = await getBytesFromBlob(plainData);
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const ctBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plainBytes);
  const ciphertextBytes = new Uint8Array(ctBuffer);

  const digest = await crypto.subtle.digest('SHA-256', ciphertextBytes);
  const sha256Hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    ciphertextBytes,
    keyB64: toBase64Url(rawKey),
    ivB64: toBase64Url(iv),
    sha256Hex
  };
}

/**
 * Upload a student file to the relay CDN with mandatory client-side AES-GCM encryption.
 * Authorized by the task drop secret without requiring teacher credentials.
 *
 * @param {File|Blob} file - The file or blob to upload
 * @param {object} relayInfo - Relay transport parameters
 * @param {string} [relayInfo.endpoint] - Relay server base URL (or relayInfo.baseUrl)
 * @param {string} [relayInfo.drop_id] - Drop box ID (or relayInfo.dropId)
 * @param {string} [relayInfo.drop_secret] - Drop authorization secret (or relayInfo.dropSecret)
 * @param {object} [options]
 * @param {Function} [options.onProgress] - Optional progress callback ({ loaded, total, percent })
 * @returns {Promise<string>} The canonical kb-cdn+aes:// URI
 */
export async function uploadStudentFile(file, relayInfo = {}, options = {}) {
  const endpoint = (relayInfo.endpoint || relayInfo.baseUrl || relayInfo.url || '').replace(/\/+$/, '');
  const dropId = relayInfo.drop_id || relayInfo.dropId;
  const dropSecret = relayInfo.drop_secret || relayInfo.dropSecret || '';

  if (!endpoint || !dropId) {
    throw new Error('Relay endpoint and drop_id are required for student file uploads');
  }

  const fileName = file.name || 'file';
  const fileMime = file.type || 'application/octet-stream';
  const dotIndex = fileName.lastIndexOf('.');
  const fileExt = dotIndex !== -1 ? fileName.slice(dotIndex + 1).toLowerCase() : (fileMime === 'image/webp' ? 'webp' : 'bin');

  // 1. Client-side unconditional encryption
  const { ciphertextBytes, keyB64, ivB64, sha256Hex } = await encryptBufferAesGcm(file);

  // 2. Presign upload URL via drop endpoint
  const presignHeaders = { 'Content-Type': 'application/json' };
  if (dropSecret) {
    presignHeaders['X-KB-Drop-Secret'] = dropSecret;
  }

  const presignRes = await fetch(`${endpoint}/api/v1/drops/${encodeURIComponent(dropId)}/media/presign`, {
    method: 'POST',
    headers: presignHeaders,
    body: JSON.stringify({
      sha256: sha256Hex,
      mime: 'application/octet-stream',
      ext: fileExt || 'bin',
      size: ciphertextBytes.byteLength
    })
  });

  if (!presignRes.ok) {
    let msg = `HTTP ${presignRes.status}`;
    try {
      const errJson = await presignRes.json();
      if (errJson?.error) msg = errJson.error;
    } catch (_) {}
    throw new Error(`Media presign failed: ${msg}`);
  }

  const presigned = await presignRes.json();
  if (!presigned?.upload_url) {
    throw new Error('Relay server did not return a valid upload URL');
  }

  // 3. PUT encrypted bytes to presigned URL
  const uploadRes = await fetch(presigned.upload_url, {
    method: presigned.method || 'PUT',
    headers: {
      ...(presigned.headers || {}),
      'Content-Type': 'application/octet-stream'
    },
    body: ciphertextBytes
  });

  if (!uploadRes.ok) {
    throw new Error(`Media upload failed: HTTP ${uploadRes.status}`);
  }

  if (typeof options.onProgress === 'function') {
    options.onProgress({ loaded: ciphertextBytes.byteLength, total: ciphertextBytes.byteLength, percent: 100 });
  }

  // 4. Return canonical kb-cdn+aes URI
  return `kb-cdn+aes://${presigned.public_url}#key=${keyB64}&iv=${ivB64}&mime=${encodeURIComponent(fileMime)}&name=${encodeURIComponent(fileName)}`;
}

/**
 * Parse an encrypted CDN URI into its components.
 * @param {string} ref
 * @returns {{ rawUrl: string, keyB64: string, ivB64: string, mime: string, name: string } | null}
 */
export function parseEncryptedCdnUrl(ref) {
  const value = String(ref || '');
  if (!value.startsWith('kb-cdn+aes://')) return null;
  const hashIndex = value.indexOf('#');
  if (hashIndex === -1) return null;
  const rawUrl = value.slice('kb-cdn+aes://'.length, hashIndex);
  const hashParams = new URLSearchParams(value.slice(hashIndex + 1));
  const keyB64 = hashParams.get('key');
  const ivB64 = hashParams.get('iv');
  const mime = hashParams.get('mime') || 'application/octet-stream';
  const name = hashParams.get('name') ? decodeURIComponent(hashParams.get('name')) : '';
  if (!rawUrl || !keyB64 || !ivB64) return null;
  return { rawUrl, keyB64, ivB64, mime, name };
}

/**
 * Fetch and decrypt media referenced by a kb-cdn+aes:// URL.
 * @param {string} ref
 * @returns {Promise<Blob>}
 */
export async function decryptAndFetchCdnMedia(ref) {
  const parsed = parseEncryptedCdnUrl(ref);
  if (!parsed) throw new Error('Invalid kb-cdn+aes URL');

  const res = await fetch(parsed.rawUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching media`);

  const ciphertextBytes = new Uint8Array(await res.arrayBuffer());
  const keyBytes = fromBase64Url(parsed.keyB64);
  const ivBytes = fromBase64Url(parsed.ivB64);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, cryptoKey, ciphertextBytes);
  return new Blob([plainBuffer], { type: parsed.mime || 'application/octet-stream' });
}

/**
 * Resolves a media ref (data:, blob:, http, or kb-cdn+aes://) into a browser-renderable src URL.
 * @param {string} ref
 * @returns {Promise<string>}
 */
export async function resolveMediaSrc(ref) {
  if (!ref) return '';
  if (ref.startsWith('data:') || ref.startsWith('blob:') || ref.startsWith('http://') || ref.startsWith('https://')) {
    return ref;
  }
  if (ref.startsWith('kb-cdn+aes://')) {
    const blob = await decryptAndFetchCdnMedia(ref);
    return URL.createObjectURL(blob);
  }
  return ref;
}
