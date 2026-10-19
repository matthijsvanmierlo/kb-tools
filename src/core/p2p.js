/**
 * Direct transfer between two devices on the same network (WebRTC data channel).
 *
 * There is no signalling server: the sender's connection offer and the receiver's answer travel
 * as QR codes or copied text, exactly like the other hand-in codes. No STUN/TURN servers are
 * configured, so only local (host) candidates are used and nothing leaves the building. The data
 * channel is DTLS-encrypted with fingerprints taken from those codes; what it carries is already
 * end-to-end encrypted anyway (KBSUB1 envelopes, v3 backups), so this is only a faster pipe.
 *
 * School Wi-Fi often isolates clients from each other. When that happens the connection times out
 * and callers fall back to the relay, QR codes or a file (see components/send-sheet.js).
 */
import { deflateRaw, inflateRaw, supportsCompressionStreams } from './crypto-share.js';
import { bytesToB64, b64ToBytes, sha256Hex } from './submission-crypto.js';

export const P2P_OFFER_PREFIX = 'KBP2P1';
export const P2P_ANSWER_PREFIX = 'KBP2P1A';
const CHUNK_BYTES = 16 * 1024;
const MAX_BUFFERED = 1024 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class P2PError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'P2PError';
    this.code = code;
  }
}

export function supportsDirectTransfer() {
  return typeof globalThis.RTCPeerConnection === 'function';
}

/** Session description → short code (deflated, base64url) */
export async function encodeSignal(prefix, description) {
  let bytes = enc.encode(JSON.stringify({ t: description.type, s: description.sdp }));
  const mode = supportsCompressionStreams() ? 'Z' : 'R';
  if (mode === 'Z') bytes = await deflateRaw(bytes);
  return `${prefix}.${mode}${bytesToB64(bytes)}`;
}

export async function decodeSignal(code, prefix) {
  const text = String(code || '').replace(/\s+/g, '');
  if (!text.startsWith(`${prefix}.`)) {
    throw new P2PError('WRONG_CODE', prefix === P2P_ANSWER_PREFIX ? 'That is not the reply code from the receiving device.' : 'That is not a direct-transfer code.');
  }
  try {
    const body = text.slice(prefix.length + 1);
    let bytes = b64ToBytes(body.slice(1));
    if (body[0] === 'Z') bytes = await inflateRaw(bytes);
    const { t, s } = JSON.parse(dec.decode(bytes));
    if (!['offer', 'answer'].includes(t) || typeof s !== 'string') throw new Error('shape');
    return { type: t, sdp: s };
  } catch (_) {
    throw new P2PError('BAD_CODE', 'That code is incomplete or damaged.');
  }
}

/** Resolve once candidate gathering is done (codes are exchanged once, not trickled) */
function gathered(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(resolve, timeoutMs);
    pc.addEventListener('icegatheringstatechange', done);
  });
}

/**
 * One transfer of one text (e.g. a submission or an encrypted backup).
 *
 *   Sender:   const t = new DirectTransfer(); show(await t.createOffer());
 *             await t.acceptAnswer(scannedReply); await t.sendText(text);
 *   Receiver: const t = new DirectTransfer(); show(await t.answerOffer(scannedOffer));
 *             const text = await t.receiveText();
 */
export class DirectTransfer {
  constructor({ RTCPeerConnectionImpl = globalThis.RTCPeerConnection, connectTimeoutMs = 10000, gatherTimeoutMs = 3000 } = {}) {
    if (typeof RTCPeerConnectionImpl !== 'function') throw new P2PError('UNSUPPORTED', 'This browser cannot make direct connections.');
    // No STUN/TURN: local network only
    this.pc = new RTCPeerConnectionImpl({ iceServers: [] });
    this.connectTimeoutMs = connectTimeoutMs;
    this.gatherTimeoutMs = gatherTimeoutMs;
    this.channel = null;
    this._channelReady = new Promise((resolve) => { this._setChannel = resolve; });
    this._incoming = [];
    this._waiters = [];
    this.pc.addEventListener('datachannel', (e) => this._adopt(e.channel));
  }

  _adopt(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = MAX_BUFFERED / 4;
    channel.addEventListener('message', (e) => {
      const msg = typeof e.data === 'string' ? JSON.parse(e.data) : null;
      if (!msg) return;
      const w = this._waiters.shift();
      if (w) w(msg);
      else this._incoming.push(msg);
    });
    this._setChannel(channel);
  }

  _next(timeoutMs = this.connectTimeoutMs * 6) {
    if (this._incoming.length) return Promise.resolve(this._incoming.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new P2PError('TIMEOUT', 'The other device stopped responding.')), timeoutMs);
      this._waiters.push((m) => { clearTimeout(timer); resolve(m); });
    });
  }

  async createOffer() {
    this._adopt(this.pc.createDataChannel('kb-transfer', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gathered(this.pc, this.gatherTimeoutMs);
    return encodeSignal(P2P_OFFER_PREFIX, this.pc.localDescription);
  }

  async answerOffer(offerCode) {
    await this.pc.setRemoteDescription(await decodeSignal(offerCode, P2P_OFFER_PREFIX));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gathered(this.pc, this.gatherTimeoutMs);
    return encodeSignal(P2P_ANSWER_PREFIX, this.pc.localDescription);
  }

  async acceptAnswer(answerCode) {
    await this.pc.setRemoteDescription(await decodeSignal(answerCode, P2P_ANSWER_PREFIX));
  }

  /** Resolves when the channel is open; rejects with UNREACHABLE when the network blocks it */
  connected() {
    if (this.channel?.readyState === 'open') return Promise.resolve(this.channel);
    return new Promise((resolve, reject) => {
      const fail = () => reject(new P2PError('UNREACHABLE', 'The devices could not reach each other on this network.'));
      const timer = setTimeout(fail, this.connectTimeoutMs);
      const onState = () => {
        if (['failed', 'closed'].includes(this.pc.connectionState)) {
          clearTimeout(timer);
          fail();
        }
      };
      this.pc.addEventListener('connectionstatechange', onState);
      this._channelReady.then((channel) => {
        const opened = () => {
          clearTimeout(timer);
          this.pc.removeEventListener('connectionstatechange', onState);
          resolve(channel);
        };
        if (channel.readyState === 'open') opened();
        else channel.addEventListener('open', opened, { once: true });
      });
    });
  }

  async _drain(channel) {
    if (channel.bufferedAmount <= MAX_BUFFERED) return;
    await new Promise((resolve) => channel.addEventListener('bufferedamountlow', resolve, { once: true }));
  }

  /** Send text and wait until the receiver confirms it arrived intact */
  async sendText(text, { onProgress = null } = {}) {
    const channel = await this.connected();
    const bytes = enc.encode(text);
    const hash = await sha256Hex(text);
    channel.send(JSON.stringify({ type: 'begin', size: bytes.length, sha256: hash }));
    for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
      await this._drain(channel);
      channel.send(JSON.stringify({ type: 'data', d: bytesToB64(bytes.subarray(i, i + CHUNK_BYTES)) }));
      onProgress?.(Math.min(1, (i + CHUNK_BYTES) / bytes.length));
    }
    channel.send(JSON.stringify({ type: 'end' }));
    const ack = await this._next();
    if (ack.type !== 'ack' || ack.sha256 !== hash) throw new P2PError('CORRUPTED', 'The transfer arrived damaged. Try again.');
    return { bytes: bytes.length, sha256: hash };
  }

  /** Receive one text; verifies its hash and acknowledges it */
  async receiveText({ maxBytes = 64 * 1024 * 1024 } = {}) {
    const channel = await this.connected();
    const begin = await this._next();
    if (begin.type !== 'begin' || !(begin.size >= 0) || begin.size > maxBytes) throw new P2PError('BAD_TRANSFER', 'Unexpected data from the other device.');
    const parts = [];
    let size = 0;
    for (;;) {
      const msg = await this._next();
      if (msg.type === 'end') break;
      if (msg.type !== 'data') throw new P2PError('BAD_TRANSFER', 'Unexpected data from the other device.');
      const chunk = b64ToBytes(msg.d);
      size += chunk.length;
      if (size > begin.size) throw new P2PError('BAD_TRANSFER', 'The other device sent more than it announced.');
      parts.push(chunk);
    }
    const all = new Uint8Array(size);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    const text = dec.decode(all);
    const hash = await sha256Hex(text);
    if (hash !== begin.sha256) {
      // Tell the sender right away instead of letting it wait for an acknowledgement
      channel.send(JSON.stringify({ type: 'nack' }));
      throw new P2PError('CORRUPTED', 'The transfer arrived damaged. Try again.');
    }
    channel.send(JSON.stringify({ type: 'ack', sha256: hash }));
    return text;
  }

  close() {
    try { this.channel?.close(); } catch (_) {}
    try { this.pc.close(); } catch (_) {}
  }
}
