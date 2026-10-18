import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import lzLib from 'lz-string';
import {
  CryptoShareEngine, SHARE_FORMAT_VERSION, PBKDF2_ITERATIONS, deflateRaw, inflateRaw
} from '../src/core/crypto-share.js';
import { SubmissionCrypto, canonicalJSON, bytesToB64, b64ToBytes } from '../src/core/submission-crypto.js';
import { Router } from '../src/router.js';
import { store } from '../src/state/store.js';

const LZString = lzLib.compressToEncodedURIComponent ? lzLib : lzLib.default;

const deck = {
  title: 'Photosynthesis',
  cards: Array.from({ length: 30 }, (_, i) => ({ front: { text: `Term ${i}: chlorophyll absorbs light` }, back: { text: `Definition ${i}` } }))
};

/** A v1 link exactly as earlier releases produced it (LZ-String, PBKDF2 100k, no AAD) */
async function legacyV1(type, payload, passphrase) {
  const envelope = JSON.stringify({ v: 1, type, payload });
  if (!passphrase) return LZString.compressToEncodedURIComponent(envelope);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await CryptoShareEngine.deriveKey(passphrase, salt, 100000);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(envelope)));
  const packed = new Uint8Array([...salt, ...iv, ...ct]);
  return LZString.compressToEncodedURIComponent(String.fromCharCode(...packed));
}

describe('Phase 20: Share format v2 (rev-3 §2.3, §3.3)', () => {
  it('uses deflate-raw + base64url and is much shorter than v1', async () => {
    const v1 = await CryptoShareEngine.createSharePayload('flashcards', deck, '', { version: 1 });
    const v2 = await CryptoShareEngine.createSharePayload('flashcards', deck, '');
    expect(v2.version).toBe(SHARE_FORMAT_VERSION);
    expect(v2.url).toContain('#/share?v=2&enc=0&d=');
    expect(v2.url).toMatch(/d=[A-Za-z0-9_-]+$/);
    expect(v2.length).toBeLessThan(v1.length * 0.6);
    expect(JSON.parse(v2.rawFileContent)).toMatchObject({ v: 2, enc: 0 });
  });

  it('round-trips encrypted payloads with PBKDF2-SHA-256 at ≥ 600k iterations', async () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600000);
    const share = await CryptoShareEngine.createSharePayload('flashcards', deck, 'correct horse');
    const file = CryptoShareEngine.parseShareFile(share.rawFileContent);
    expect(file).toMatchObject({ enc: '1', v: 2 });
    const out = await CryptoShareEngine.unpackSharePayload(file.d, true, 'correct horse', 2);
    expect(out).toEqual({ v: 1, type: 'flashcards', payload: deck });
    await expect(CryptoShareEngine.unpackSharePayload(file.d, true, 'wrong', 2)).rejects.toThrow('INVALID_PASSPHRASE');
  });

  it('packs salt(16) ‖ iv(12) ‖ ciphertext and uses a fresh salt and IV every time', async () => {
    const a = await CryptoShareEngine.createSharePayload('flashcards', deck, 'pw');
    const b = await CryptoShareEngine.createSharePayload('flashcards', deck, 'pw');
    const ba = b64ToBytes(CryptoShareEngine.parseShareFile(a.rawFileContent).d);
    const bb = b64ToBytes(CryptoShareEngine.parseShareFile(b.rawFileContent).d);
    expect(bytesToB64(ba.slice(0, 16))).not.toBe(bytesToB64(bb.slice(0, 16)));
    expect(bytesToB64(ba.slice(16, 28))).not.toBe(bytesToB64(bb.slice(16, 28)));
  });

  it('rejects any modified ciphertext (AES-GCM authentication)', async () => {
    const share = await CryptoShareEngine.createSharePayload('flashcards', deck, 'pw');
    const bytes = b64ToBytes(CryptoShareEngine.parseShareFile(share.rawFileContent).d);
    bytes[bytes.length - 5] ^= 0x01;
    await expect(CryptoShareEngine.unpackSharePayload(bytesToB64(bytes), true, 'pw', 2)).rejects.toThrow('INVALID_PASSPHRASE');
  });

  it('still opens links made by earlier versions (v1, LZ-String, 100k iterations)', async () => {
    const plain = await legacyV1('timeline', { title: 'Old' }, '');
    expect((await CryptoShareEngine.unpackSharePayload(plain, false, '', 1)).payload.title).toBe('Old');
    const locked = await legacyV1('timeline', { title: 'Old locked' }, 'K7M2QX9P');
    expect((await CryptoShareEngine.unpackSharePayload(locked, true, 'K7M2QX9P', 1)).payload.title).toBe('Old locked');
  });

  it('deflate-raw helpers are inverse', async () => {
    const input = new TextEncoder().encode('abc'.repeat(1000));
    const packed = await deflateRaw(input);
    expect(packed.length).toBeLessThan(100);
    expect(new TextDecoder().decode(await inflateRaw(packed))).toBe('abc'.repeat(1000));
  });
});

describe('Phase 20: Address-bar scrubbing (rev-3 §2.2)', () => {
  beforeEach(() => {
    store.setState('ephemeralData', null);
    window.history.replaceState(null, '', '/');
  });

  it('removes the payload from the URL as soon as it is read', async () => {
    const share = await CryptoShareEngine.createSharePayload('flashcards', deck, '');
    const hash = share.url.slice(share.url.indexOf('#'));
    window.history.replaceState(null, '', `/${hash}`);
    const router = new Router();
    const { params } = router.parseHash();
    await router._handleShareRoute(params);
    expect(window.location.href).not.toContain('d=');
    expect(store.getState('ephemeralData')?.type).toBe('flashcards');
  });

  it('removes the payload even while the passphrase dialog is open', async () => {
    if (!customElements.get('sl-dialog')) {
      customElements.define('sl-dialog', class extends HTMLElement { show() {} hide() {} });
    }
    const share = await CryptoShareEngine.createSharePayload('flashcards', deck, 'pw');
    window.history.replaceState(null, '', `/${share.url.slice(share.url.indexOf('#'))}`);
    const router = new Router();
    await router._handleShareRoute(router.parseHash().params);
    expect(window.location.hash).toBe('#/share');
    document.getElementById('sl-decrypt-dialog')?.remove();
  });

  it('refuses share payloads of unknown types', async () => {
    const share = await CryptoShareEngine.createSharePayload('evil', { x: 1 }, '');
    window.history.replaceState(null, '', `/${share.url.slice(share.url.indexOf('#'))}`);
    const router = new Router();
    await router._handleShareRoute(router.parseHash().params);
    expect(store.getState('ephemeralData')).toBeNull();
  });
});

describe('Phase 20: Submission tamper-proofing (rev-3 §2.4)', () => {
  async function makeSubmission() {
    const keys = await SubmissionCrypto.generateKeyPair();
    const body = { assignment_id: 'as-1', student_id: 'S1', student_name: 'Ada', submitted_at: '2026-10-01T10:00:00.000Z', answers: { q1: 'b' }, client_score: { earned: 2 } };
    const signature = await SubmissionCrypto.signWithAccessCode(body, 'K7M2-QX9P');
    const envelope = await SubmissionCrypto.encryptForTeacher(keys.publicJwk, { body, signature }, { assignment_id: 'as-1', publish_version: 1 });
    return { keys, body, signature, envelope };
  }

  it('detects an edited score, name or date in the signed body', async () => {
    const { body, signature } = await makeSubmission();
    expect(await SubmissionCrypto.verifyAccessCodeSignature(body, signature, 'K7M2QX9P')).toBe(true);
    for (const edit of [{ client_score: { earned: 99 } }, { student_name: 'Bob' }, { submitted_at: '2026-09-01T10:00:00.000Z' }, { answers: { q1: 'a' } }]) {
      expect(await SubmissionCrypto.verifyAccessCodeSignature({ ...body, ...edit }, signature, 'K7M2QX9P')).toBe(false);
    }
  });

  it('cannot be decrypted after ciphertext or routing header changes', async () => {
    const { keys, envelope } = await makeSubmission();
    const flipped = b64ToBytes(envelope.ct);
    flipped[3] ^= 0xff;
    await expect(SubmissionCrypto.decryptFromStudent(keys.privateJwk, { ...envelope, ct: bytesToB64(flipped) })).rejects.toThrow('DECRYPTION_FAILED');
    await expect(SubmissionCrypto.decryptFromStudent(keys.privateJwk, { ...envelope, header: { ...envelope.header, publish_version: 9 } })).rejects.toThrow('DECRYPTION_FAILED');
  });

  it('signs a canonical form, so key order does not matter', () => {
    expect(canonicalJSON({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJSON({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
