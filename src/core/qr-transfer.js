/**
 * QR hand-in transfer (KB-CORE-QR)
 *
 * A student's encrypted submission travels from their screen to the teacher's camera as a short
 * looping sequence of QR codes. Nothing here adds trust: the payload is the same end-to-end
 * encrypted, access-code-signed KBSUB1 envelope as a .kbsub file, and the teacher's device
 * re-grades it from the answers. The QR layer only has to move bytes reliably.
 *
 * Frame format (ASCII, QR byte mode):   KBQ1:<msgId>:<index>:<total>:<data>
 *   msgId  8 hex chars identifying one submission (frames of different students never mix)
 *   data   a slice of base64url(deflate-raw(body)), where body is the envelope JSON when the
 *          input is a KBSUB1 code (smaller than re-compressing its base64), else the raw text
 */
import { deflateRaw, inflateRaw, supportsCompressionStreams } from './crypto-share.js';
import { bytesToB64, b64ToBytes } from './submission-crypto.js';

export const QR_FRAME_PREFIX = 'KBQ1';
// ~600 characters per frame keeps each code around QR version 20 at error-correction level M:
// dense enough to need few frames, sparse enough for a phone or laptop camera to read off a screen.
export const QR_FRAME_CHARS = 600;
const MAX_FRAMES = 64;

const enc = new TextEncoder();
const dec = new TextDecoder();

async function compress(bytes) {
  return supportsCompressionStreams() ? deflateRaw(bytes) : bytes;
}

/**
 * Split a submission (KBSUB1 code or any text) into QR frame strings.
 * @param {string} text
 * @param {{ frameChars?: number }} [opts]
 * @returns {Promise<string[]>}
 */
export async function encodeQrFrames(text, { frameChars = QR_FRAME_CHARS } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('EMPTY_PAYLOAD');

  // 'J' = KBSUB1 envelope JSON, 'T' = plain text; 'Z' suffix = deflate-raw compressed
  let kind = 'T';
  let body = enc.encode(trimmed);
  if (trimmed.startsWith('KBSUB1.')) {
    kind = 'J';
    body = b64ToBytes(trimmed.slice(7));
  }
  const compressed = supportsCompressionStreams();
  const data = `${kind}${compressed ? 'Z' : 'R'}${bytesToB64(await compress(body))}`;

  const total = Math.ceil(data.length / frameChars);
  if (total > MAX_FRAMES) throw new Error('PAYLOAD_TOO_LARGE_FOR_QR');
  const msgId = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('');

  const frames = [];
  for (let i = 0; i < total; i++) {
    frames.push(`${QR_FRAME_PREFIX}:${msgId}:${i + 1}:${total}:${data.slice(i * frameChars, (i + 1) * frameChars)}`);
  }
  return frames;
}

/** @returns {{ msgId: string, index: number, total: number, data: string } | null} */
export function parseQrFrame(raw) {
  const m = String(raw || '').trim().match(/^KBQ1:([0-9a-f]{8}):(\d{1,3}):(\d{1,3}):([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const index = Number(m[2]);
  const total = Number(m[3]);
  if (total < 1 || total > MAX_FRAMES || index < 1 || index > total) return null;
  return { msgId: m[1], index, total, data: m[4] };
}

async function decodeData(data) {
  const kind = data[0];
  const mode = data[1];
  if (!['J', 'T'].includes(kind) || !['Z', 'R'].includes(mode)) throw new Error('UNKNOWN_QR_PAYLOAD');
  let bytes = b64ToBytes(data.slice(2));
  if (mode === 'Z') bytes = await inflateRaw(bytes);
  return kind === 'J' ? `KBSUB1.${bytesToB64(bytes)}` : dec.decode(bytes);
}

/**
 * Collects frames from any number of students in any order, tolerating repeats.
 * Usage: `const r = await assembler.add(rawQrText)` → r.status is 'ignored' | 'duplicate' | 'progress' | 'complete'.
 */
export class QrAssembler {
  constructor() {
    this.messages = new Map(); // msgId → { total, parts: Map<index, data> }
    this.completed = new Set();
  }

  /** @returns {Promise<{ status: string, msgId?: string, received?: number, total?: number, text?: string }>} */
  async add(raw) {
    const frame = parseQrFrame(raw);
    if (!frame) return { status: 'ignored' };
    if (this.completed.has(frame.msgId)) return { status: 'duplicate', msgId: frame.msgId };

    let msg = this.messages.get(frame.msgId);
    if (!msg) {
      msg = { total: frame.total, parts: new Map() };
      this.messages.set(frame.msgId, msg);
    }
    if (msg.total !== frame.total) return { status: 'ignored' };
    const isNew = !msg.parts.has(frame.index);
    msg.parts.set(frame.index, frame.data);

    if (msg.parts.size < msg.total) {
      return { status: isNew ? 'progress' : 'duplicate', msgId: frame.msgId, received: msg.parts.size, total: msg.total };
    }

    const data = Array.from({ length: msg.total }, (_, i) => msg.parts.get(i + 1)).join('');
    this.messages.delete(frame.msgId);
    this.completed.add(frame.msgId);
    try {
      return { status: 'complete', msgId: frame.msgId, received: msg.total, total: msg.total, text: await decodeData(data) };
    } catch (_) {
      return { status: 'error', msgId: frame.msgId };
    }
  }

  /** Progress of submissions that are still incomplete */
  pending() {
    return [...this.messages.entries()].map(([msgId, m]) => ({ msgId, received: m.parts.size, total: m.total }));
  }
}
