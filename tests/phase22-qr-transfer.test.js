import { describe, it, expect } from 'vitest';
import qrcode from 'qrcode-generator';
import { encodeQrFrames, parseQrFrame, QrAssembler, QR_FRAME_CHARS } from '../src/core/qr-transfer.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { renderQrSvg } from '../src/components/qr-handoff.js';

async function realSubmission(answerCount = 12) {
  const keys = await SubmissionCrypto.generateKeyPair();
  const answers = Object.fromEntries(Array.from({ length: answerCount }, (_, i) => [`q${i}`, `answer number ${i}`]));
  const body = { assignment_id: 'as-1', student_id: 'S1', student_name: 'Ada Lovelace', answers };
  const envelope = await SubmissionCrypto.encryptForTeacher(keys.publicJwk, { body, signature: 'sig' }, { assignment_id: 'as-1', publish_version: 1 });
  return { keys, text: SubmissionCrypto.serializeEnvelope(envelope) };
}

describe('Phase 22: QR hand-in transfer (rev-3 §4.1)', () => {
  it('splits a submission into small frames and reassembles it exactly, in any order', async () => {
    const { keys, text } = await realSubmission(40);
    const frames = await encodeQrFrames(text);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      expect(f.length).toBeLessThanOrEqual(QR_FRAME_CHARS + 30);
      expect(f).toMatch(/^KBQ1:[0-9a-f]{8}:\d+:\d+:[A-Za-z0-9_-]+$/);
    }

    const assembler = new QrAssembler();
    const shuffled = [...frames].reverse();
    let result;
    for (const f of [shuffled[0], shuffled[0], ...shuffled]) result = await assembler.add(f); // includes a repeat
    expect(result.status).toBe('complete');
    expect(result.text).toBe(text);
    // The reassembled code still decrypts with the teacher's key
    const { body } = await SubmissionCrypto.decryptFromStudent(keys.privateJwk, SubmissionCrypto.parseEnvelope(result.text));
    expect(body.student_name).toBe('Ada Lovelace');
  });

  it('keeps two students\' frames apart and reports progress', async () => {
    const a = await encodeQrFrames((await realSubmission(40)).text);
    const b = await encodeQrFrames((await realSubmission(40)).text);
    const assembler = new QrAssembler();
    const first = await assembler.add(a[0]);
    expect(first).toMatchObject({ status: 'progress', received: 1, total: a.length });
    await assembler.add(b[0]);
    expect(assembler.pending().length).toBe(2);
    let done;
    for (const f of a.slice(1)) done = await assembler.add(f);
    expect(done.status).toBe('complete');
    expect(assembler.pending().length).toBe(1);
    expect((await assembler.add(a[0])).status).toBe('duplicate');
  });

  it('ignores anything that is not a KennisBoost frame', async () => {
    const assembler = new QrAssembler();
    for (const junk of ['https://example.org', 'KBQ1:zz:1:1:abc', 'KBQ1:0123abcd:3:2:abc', 'KBQ1:0123abcd:1:999:abc', '']) {
      expect((await assembler.add(junk)).status).toBe('ignored');
      expect(parseQrFrame(junk)).toBeNull();
    }
  });

  it('produces codes a QR library can render at a scannable size', async () => {
    const frames = await encodeQrFrames((await realSubmission(12)).text);
    const qr = qrcode(0, 'M');
    qr.addData(frames[0], 'Byte');
    qr.make();
    // QR version = (modules − 17) / 4; ≤ 22 stays readable off a screen
    expect((qr.getModuleCount() - 17) / 4).toBeLessThanOrEqual(22);
    expect(renderQrSvg(frames[0])).toMatch(/^<svg[\s\S]*<\/svg>$/);
  });

  it('carries plain text too', async () => {
    const frames = await encodeQrFrames('hello teacher');
    const assembler = new QrAssembler();
    expect((await assembler.add(frames[0])).text).toBe('hello teacher');
  });
});
