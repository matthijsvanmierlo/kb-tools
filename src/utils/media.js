/**
 * Card media helpers (KB-UTIL-MEDIA)
 *  - Images are re-encoded on a canvas: max 800 px, WebP at 75 % quality (≈40–60 KB), which also
 *    strips EXIF metadata such as GPS location from phone photos.
 *  - Audio clips are recorded with MediaRecorder as Opus (≈1–2 KB per second).
 *  - Media is stored as Blobs (no base64 overhead) and referenced from cards by URI; it is only
 *    inlined as data: URLs when a deck leaves the device (share link / .kbshare).
 */
import { storage } from '../core/storage.js';

export const IMAGE_MAX_DIMENSION = 800;
export const IMAGE_QUALITY = 0.75;
export const AUDIO_MAX_MS = 10000;
export const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;

const SAFE_IMAGE_DATA = /^data:image\/(?:webp|png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/;
const SAFE_AUDIO_DATA = /^data:audio\/(?:webm|ogg|mp4|mpeg)(?:;codecs=[\w.]+)?;base64,[A-Za-z0-9+/=]+$/;

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

/**
 * Resolve a card media reference to something an <img>/<audio> can load, or '' if unsafe.
 * Shared decks carry data: URLs; local decks carry idb-blob:// references.
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
  return '';
}

async function refToDataUrl(ref, kind) {
  if (!ref || String(ref).startsWith('data:')) return ref;
  const blob = await storage.getBinaryBlob(ref);
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const type = blob.type || (kind === 'image' ? 'image/webp' : 'audio/webm');
  return `data:${type};base64,${btoa(bin)}`;
}

/** Copy of a deck whose card media is embedded, so it works on another device */
export async function inlineDeckMedia(deck) {
  if (!deck || !Array.isArray(deck.cards)) return deck;
  const cards = await Promise.all(deck.cards.map(async (card) => {
    const out = { ...card };
    for (const side of ['front', 'back']) {
      if (!card[side] || typeof card[side] !== 'object') continue;
      const s = { ...card[side] };
      if (s.imageRef) s.imageRef = await refToDataUrl(s.imageRef, 'image');
      if (s.audioRef) s.audioRef = await refToDataUrl(s.audioRef, 'audio');
      out[side] = s;
    }
    return out;
  }));
  return { ...deck, cards };
}
