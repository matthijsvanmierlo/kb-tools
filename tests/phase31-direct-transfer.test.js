import { describe, it, expect, beforeEach } from 'vitest';
import { DirectTransfer, encodeSignal, decodeSignal, supportsDirectTransfer, P2P_OFFER_PREFIX, P2P_ANSWER_PREFIX } from '../src/core/p2p.js';
import { rankSendOptions } from '../src/components/send-sheet.js';
import { encodeQrFrames } from '../src/core/qr-transfer.js';

/**
 * A pair of fake RTCPeerConnections joined in memory. `FakePC.reachable = false` simulates a
 * network that isolates clients (connection fails after the codes are exchanged).
 */
const registry = new Map();
let counter = 0;

class FakeChannel extends EventTarget {
  constructor(label) {
    super();
    this.label = label;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.peer = null;
    this.tamper = null;
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error('channel not open');
    const out = this.tamper ? this.tamper(data) : data;
    setTimeout(() => this.peer.dispatchEvent(Object.assign(new Event('message'), { data: out })), 0);
  }
  close() { this.readyState = 'closed'; }
  _open() { this.readyState = 'open'; this.dispatchEvent(new Event('open')); }
}

class FakePC extends EventTarget {
  static reachable = true;
  constructor(config) {
    super();
    this.config = config;
    this.id = `pc${counter++}`;
    this.iceGatheringState = 'new';
    this.connectionState = 'new';
    this.channel = null;
    registry.set(this.id, this);
  }
  createDataChannel(label) { this.channel = new FakeChannel(label); return this.channel; }
  async createOffer() { return { type: 'offer', sdp: `v=0 ${this.id} ${'a=candidate host '.repeat(20)}` }; }
  async createAnswer() { return { type: 'answer', sdp: `v=0 ${this.id} ${'a=candidate host '.repeat(20)}` }; }
  async setLocalDescription(d) {
    this.localDescription = d;
    setTimeout(() => { this.iceGatheringState = 'complete'; this.dispatchEvent(new Event('icegatheringstatechange')); }, 0);
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    if (d.type !== 'answer') return;
    const peer = registry.get(d.sdp.split(' ')[1]);
    setTimeout(() => {
      if (!FakePC.reachable) {
        this.connectionState = 'failed';
        this.dispatchEvent(new Event('connectionstatechange'));
        return;
      }
      const remote = new FakeChannel(this.channel.label);
      remote.peer = this.channel;
      this.channel.peer = remote;
      this.channel._open();
      remote._open();
      peer.dispatchEvent(Object.assign(new Event('datachannel'), { channel: remote }));
    }, 0);
  }
  close() {}
}

const opts = { RTCPeerConnectionImpl: FakePC, connectTimeoutMs: 500, gatherTimeoutMs: 100 };

async function pair() {
  const sender = new DirectTransfer(opts);
  const receiver = new DirectTransfer(opts);
  const offer = await sender.createOffer();
  const answer = await receiver.answerOffer(offer);
  await sender.acceptAnswer(answer);
  return { sender, receiver, offer, answer };
}

describe('Phase 31: Direct transfer (WebRTC, local network only)', () => {
  beforeEach(() => { FakePC.reachable = true; });

  it('uses no STUN/TURN servers, so nothing leaves the local network', async () => {
    const { sender } = await pair();
    expect(sender.pc.config).toEqual({ iceServers: [] });
  });

  it('encodes connection codes compactly and rejects the wrong kind', async () => {
    const desc = { type: 'offer', sdp: 'v=0\r\n'.repeat(100) };
    const code = await encodeSignal(P2P_OFFER_PREFIX, desc);
    expect(code.length).toBeLessThan(desc.sdp.length);
    expect(await decodeSignal(code, P2P_OFFER_PREFIX)).toEqual(desc);
    await expect(decodeSignal(code, P2P_ANSWER_PREFIX)).rejects.toMatchObject({ code: 'WRONG_CODE' });
    await expect(decodeSignal(`${P2P_OFFER_PREFIX}.Zgarbage`, P2P_OFFER_PREFIX)).rejects.toMatchObject({ code: 'BAD_CODE' });
    // A typical offer code fits in one or two QR frames
    const { offer } = await pair();
    expect((await encodeQrFrames(offer)).length).toBeLessThanOrEqual(2);
  });

  it('moves a large text intact and the sender gets a verified receipt', async () => {
    const { sender, receiver } = await pair();
    const text = `KBSUB1.${'x'.repeat(200 * 1024)}`;
    const [sent, received] = await Promise.all([sender.sendText(text), receiver.receiveText()]);
    expect(received).toBe(text);
    expect(sent.bytes).toBe(text.length);
  });

  it('detects damage in transit', async () => {
    const { sender, receiver } = await pair();
    sender.channel.tamper = (data) => data.replace(/"d":"([A-Za-z0-9_-])/, (m, c) => `"d":"${c === 'A' ? 'B' : 'A'}`);
    const results = await Promise.allSettled([sender.sendText('KBSUB1.hello world'), receiver.receiveText()]);
    expect(results[1].reason?.code).toBe('CORRUPTED');
    expect(results[0].reason?.code).toBe('CORRUPTED');
  });

  it('reports an isolated network as unreachable so callers can fall back', async () => {
    FakePC.reachable = false;
    const { sender } = await pair();
    await expect(sender.sendText('KBSUB1.x')).rejects.toMatchObject({ code: 'UNREACHABLE' });
  });

  it('knows when the browser has no WebRTC', () => {
    expect(typeof supportsDirectTransfer()).toBe('boolean');
    expect(() => new DirectTransfer({ RTCPeerConnectionImpl: undefined })).toThrow(/cannot make direct connections/);
  });
});

describe('Phase 31: One "hand in" sheet', () => {
  const base = { hasRelay: false, qrFrames: 3, canDirect: true, canShare: false, hasEmail: false };

  it('puts the school server first when there is one', () => {
    expect(rankSendOptions({ ...base, hasRelay: true })[0].id).toBe('server');
    expect(rankSendOptions(base)[0].id).toBe('qr');
  });

  it('prefers a direct transfer over a long QR sequence, and drops QR when it cannot fit', () => {
    const long = rankSendOptions({ ...base, qrFrames: 30 }).map(o => o.id);
    expect(long.indexOf('direct')).toBeLessThan(long.indexOf('qr'));
    expect(rankSendOptions({ ...base, qrFrames: null }).map(o => o.id)).not.toContain('qr');
  });

  it('always offers the file and the copyable code, and email/share only when possible', () => {
    const ids = rankSendOptions({ ...base, canDirect: false }).map(o => o.id);
    expect(ids).toEqual(expect.arrayContaining(['download', 'copy']));
    expect(ids).not.toContain('email');
    expect(ids).not.toContain('direct');
    expect(rankSendOptions({ ...base, hasEmail: true, canShare: true }).map(o => o.id)).toEqual(expect.arrayContaining(['email', 'share']));
  });
});
