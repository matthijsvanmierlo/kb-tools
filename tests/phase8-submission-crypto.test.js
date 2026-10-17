import { describe, it, expect } from 'vitest';
import { SubmissionCrypto, canonicalJSON } from '../src/core/submission-crypto.js';
import { generateAccessCode, normalizeAccessCode, formatAccessCode } from '../src/core/access-codes.js';

describe('Phase 8: Submission cryptography', () => {
  it('round-trips a submission encrypted to the teacher key', async () => {
    const keys = await SubmissionCrypto.generateKeyPair();
    const body = { assignment_id: 'a-1', student_id: 'S101', answers: { q1: 'opt-b' } };
    const env = await SubmissionCrypto.encryptForTeacher(keys.publicJwk, body, { assignment_id: 'a-1' });
    const text = SubmissionCrypto.serializeEnvelope(env);
    expect(text.startsWith('KBSUB1.')).toBe(true);
    const parsed = SubmissionCrypto.parseEnvelope(text);
    const out = await SubmissionCrypto.decryptFromStudent(keys.privateJwk, parsed);
    expect(out).toEqual(body);
  });

  it('rejects envelopes with a tampered header or the wrong key', async () => {
    const keys = await SubmissionCrypto.generateKeyPair();
    const other = await SubmissionCrypto.generateKeyPair();
    const env = await SubmissionCrypto.encryptForTeacher(keys.publicJwk, { a: 1 }, { assignment_id: 'a-1' });
    await expect(SubmissionCrypto.decryptFromStudent(other.privateJwk, env)).rejects.toThrow('DECRYPTION_FAILED');
    const tampered = { ...env, header: { assignment_id: 'a-2' } };
    await expect(SubmissionCrypto.decryptFromStudent(keys.privateJwk, tampered)).rejects.toThrow('DECRYPTION_FAILED');
  });

  it('verifies access-code signatures and detects impersonation or edits', async () => {
    const code = generateAccessCode();
    const body = { assignment_id: 'a-1', student_id: 's101', answers: { q1: ['x'] }, submitted_at: '2026-10-17T10:00:00Z' };
    const sig = await SubmissionCrypto.signWithAccessCode(body, code);
    expect(await SubmissionCrypto.verifyAccessCodeSignature(body, sig, code.toLowerCase())).toBe(true);
    expect(await SubmissionCrypto.verifyAccessCodeSignature(body, sig, generateAccessCode())).toBe(false);
    expect(await SubmissionCrypto.verifyAccessCodeSignature({ ...body, answers: { q1: ['y'] } }, sig, code)).toBe(false);
  });

  it('produces stable canonical JSON and readable access codes', async () => {
    expect(canonicalJSON({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    const code = generateAccessCode();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(formatAccessCode(normalizeAccessCode(code.toLowerCase()))).toBe(code);
    const c1 = await SubmissionCrypto.accessCodeCheck('a', 'S1', code);
    expect(c1).toHaveLength(4);
    expect(await SubmissionCrypto.accessCodeCheck('a', 's1', code.replace('-', ''))).toBe(c1);
  });
});
