/**
 * Card media helpers (KB-UTIL-MEDIA)
 *  - Images are re-encoded on a canvas: max 800 px, WebP at 75 % quality (≈40–60 KB), which also
 *    strips EXIF metadata such as GPS location from phone photos.
 *  - Audio clips are recorded with MediaRecorder as Opus (≈1–2 KB per second).
 *  - Media is stored as Blobs (no base64 overhead) and referenced from cards by URI; it is only
 *    inlined as data: URLs when a deck leaves the device (share link / .kbshare).
 */
import { storage } from '../core/storage.js';
import { getTransport, isCdnUploadConfigured } from '../core/transport.js';

export const IMAGE_MAX_DIMENSION = 800;
export const IMAGE_QUALITY = 0.75;
export const AUDIO_MAX_MS = 10000;
export const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;

const SAFE_IMAGE_DATA = /^data:image\/(?:webp|png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/;
const SAFE_AUDIO_DATA = /^data:audio\/(?:webm|ogg|mp4|mpeg)(?:;codecs=[\w.]+)?;base64,[A-Za-z0-9+/=]+$/;

function toBase64Url(uint8) {
  let binary = '';
  for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Fit (w, h) inside a max × max box without upscaling */
export function fitWithin(width, height, max = IMAGE_MAX_DIMENSION) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('ENCODE_FAILED'))), type, quality);
  });
}

/**
 * Downscale and re-encode an image file.
 * @param {File|Blob} file
 * @returns {Promise<Blob>} image/webp (or image/jpeg where the browser can't encode WebP)
 */
export async function downscaleImage(file, { max = IMAGE_MAX_DIMENSION, quality = IMAGE_QUALITY } = {}) {
  if (!file || !/^image\//.test(file.type)) throw new Error('NOT_AN_IMAGE');
  if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new Error('IMAGE_TOO_LARGE');

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { width, height } = fitWithin(bitmap.width, bitmap.height, max);
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  let blob = await canvasToBlob(canvas, 'image/webp', quality);
  // Browsers without a WebP encoder silently return PNG; JPEG is far smaller for photos
  if (blob.type !== 'image/webp') blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  return blob;
}

export function pickAudioMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
  return candidates.find(t => MediaRecorder.isTypeSupported?.(t)) || '';
}

/**
 * Start recording a short clip from the microphone. Stops by itself after maxMs.
 * @returns {Promise<{ stop: () => void, result: Promise<Blob> }>}
 */
export async function startAudioClip({ maxMs = AUDIO_MAX_MS } = {}) {
  const mimeType = pickAudioMimeType();
  if (mimeType === null || !navigator.mediaDevices?.getUserMedia) throw new Error('RECORDING_UNSUPPORTED');

  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 16000 });
  const chunks = [];
  recorder.addEventListener('dataavailable', (e) => { if (e.data?.size) chunks.push(e.data); });

  const result = new Promise((resolve, reject) => {
    recorder.addEventListener('stop', () => {
      stream.getTracks().forEach(t => t.stop());
      clearTimeout(limit);
      const type = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0];
      chunks.length ? resolve(new Blob(chunks, { type })) : reject(new Error('EMPTY_RECORDING'));
    });
    recorder.addEventListener('error', (e) => {
      stream.getTracks().forEach(t => t.stop());
      reject(e.error || new Error('RECORDING_FAILED'));
    });
  });
  const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
  const limit = setTimeout(stop, maxMs);
  recorder.start();
  return { stop, result };
}

/** Store a media blob locally and return the URI to keep on the card */
export async function storeMediaBlob(blob) {
  const id = `media-${crypto.randomUUID()}`;
  return storage.saveBinaryAsset(id, blob, { preferIndexedDb: true });
}

async function resolveEncryptedCdnMedia(rawUrl, keyB64, ivB64, mime) {
  const res = await fetch(rawUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctBuffer = await res.arrayBuffer();
  const rawKey = fromBase64Url(keyB64);
  const iv = fromBase64Url(ivB64);
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const ptBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ctBuffer);
  const blob = new Blob([ptBuffer], { type: mime });
  const objectUrl = URL.createObjectURL(blob);
  storage.objectUrls.add(objectUrl);
  return objectUrl;
}

/**
 * Resolve a card media reference to something an <img>/<audio> can load, or '' if unsafe.
 * Shared decks carry data: URLs or https:// CDN URLs; local decks carry idb-blob:// references.
 */
export async function resolveMediaSrc(ref, kind) {
  const value = String(ref || '');
  if (!value) return '';
  if (value.startsWith('data:')) {
    return (kind === 'image' ? SAFE_IMAGE_DATA : SAFE_AUDIO_DATA).test(value) ? value : '';
  }
  if (value.startsWith('idb-blob://') || value.startsWith('opfs://')) {
    try {
      return await storage.loadBinaryAsset(value);
    } catch (_) {
      return '';
    }
  }
  if (value.startsWith('kb-cdn+aes://')) {
    try {
      const hashIndex = value.indexOf('#');
      if (hashIndex !== -1) {
        const rawUrl = value.slice('kb-cdn+aes://'.length, hashIndex);
        const hashParams = new URLSearchParams(value.slice(hashIndex + 1));
        const keyB64 = hashParams.get('key');
        const ivB64 = hashParams.get('iv');
        const mime = hashParams.get('mime') || (kind === 'image' ? 'image/webp' : 'audio/webm');
        if (rawUrl && keyB64 && ivB64) {
          return await resolveEncryptedCdnMedia(rawUrl, keyB64, ivB64, mime);
        }
      }
    } catch (err) {
      console.warn('Failed to resolve encrypted CDN media:', err);
      return '';
    }
  }
  if (value.startsWith('https://')) {
    try {
      const u = new URL(value);
      if (u.protocol === 'https:') {
        return value;
      }
    } catch (_) {}
    return '';
  }
  return '';
}

async function getBytesFromBlob(blob) {
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
 * Upload a media blob to the configured CDN (deduplicated by sha256).
 * Returns the public URL, or kb-cdn+aes:// if encrypt=true, or null if CDN not configured.
 * @param {Blob|string} blobOrRef
 * @param {object} [opts]
 * @returns {Promise<string|null>}
 */
export async function uploadMediaToCdn(blobOrRef, { mime, ext, encrypt = false } = {}) {
  const canUpload = await isCdnUploadConfigured();
  if (!canUpload) return null;

  let blob = null;
  if (typeof blobOrRef === 'string') {
    blob = await storage.getBinaryBlob(blobOrRef);
  } else if (blobOrRef && (typeof blobOrRef === 'object')) {
    blob = blobOrRef;
  }
  if (!blob) return null;

  let uploadBlob = blob;
  let keyB64 = null;
  let ivB64 = null;
  const actualMime = mime || blob.type || 'application/octet-stream';

  if (encrypt) {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
    const plainBuffer = await getBytesFromBlob(blob);
    const ctBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plainBuffer);
    uploadBlob = new Blob([ctBuffer], { type: 'application/octet-stream' });
    keyB64 = toBase64Url(rawKey);
    ivB64 = toBase64Url(iv);
  }

  const bytes = await getBytesFromBlob(uploadBlob);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256Hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');

  const transport = await getTransport();
  const fileExt = ext || (actualMime === 'image/webp' ? 'webp' : actualMime === 'audio/webm' ? 'webm' : 'bin');
  const presigned = await transport.presignMediaUpload({
    sha256: sha256Hex,
    mime: uploadBlob.type,
    ext: fileExt,
    size: bytes.length
  });

  const uploadRes = await fetch(presigned.upload_url, {
    method: presigned.method || 'PUT',
    headers: {
      ...(presigned.headers || {}),
      'Content-Type': uploadBlob.type
    },
    body: bytes
  });

  if (!uploadRes.ok) {
    throw new Error(`Failed to upload media to CDN: HTTP ${uploadRes.status}`);
  }

  if (encrypt) {
    return `kb-cdn+aes://${presigned.public_url}#key=${keyB64}&iv=${ivB64}&mime=${encodeURIComponent(actualMime)}`;
  }
  return presigned.public_url;
}

async function refToDataUrl(ref, kind) {
  if (!ref || String(ref).startsWith('data:') || String(ref).startsWith('https://') || String(ref).startsWith('kb-cdn+aes://')) return ref;
  const blob = await storage.getBinaryBlob(ref);
  if (!blob) return null;
  const bytes = await getBytesFromBlob(blob);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const type = blob.type || (kind === 'image' ? 'image/webp' : 'audio/webm');
  return `data:${type};base64,${btoa(bin)}`;
}

/**
 * Copy of a deck whose card media is embedded or offloaded to CDN.
 * If cdn=true and CDN upload is configured, media is offloaded to CDN (zero student storage).
 * Otherwise inlined as data: URLs for self-contained offline files.
 */
export async function inlineDeckMedia(deck, { cdn = false, encrypt = false } = {}) {
  if (!deck || !Array.isArray(deck.cards)) return deck;
  const cdnActive = cdn && (await isCdnUploadConfigured());

  const cards = await Promise.all(deck.cards.map(async (card) => {
    const out = { ...card };
    for (const side of ['front', 'back']) {
      if (!card[side] || typeof card[side] !== 'object') continue;
      const s = { ...card[side] };
      if (s.imageRef) {
        let uploaded = null;
        if (cdnActive && (s.imageRef.startsWith('idb-blob://') || s.imageRef.startsWith('opfs://'))) {
          try {
            uploaded = await uploadMediaToCdn(s.imageRef, { mime: 'image/webp', ext: 'webp', encrypt });
          } catch (_) {}
        }
        s.imageRef = uploaded || (await refToDataUrl(s.imageRef, 'image'));
      }
      if (s.audioRef) {
        let uploaded = null;
        if (cdnActive && (s.audioRef.startsWith('idb-blob://') || s.audioRef.startsWith('opfs://'))) {
          try {
            uploaded = await uploadMediaToCdn(s.audioRef, { mime: 'audio/webm', ext: 'webm', encrypt });
          } catch (_) {}
        }
        s.audioRef = uploaded || (await refToDataUrl(s.audioRef, 'audio'));
      }
      out[side] = s;
    }
    return out;
  }));
  return { ...deck, cards };
}
