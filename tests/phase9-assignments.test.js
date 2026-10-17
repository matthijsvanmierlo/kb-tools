import { describe, it, expect } from 'vitest';
import {
  gradeQuestion, gradeSubmission, finalScore, normalizeText, parseNumber, levenshtein,
  buildStudentPayload, checkAnswerLocally, countBlanks, describeCorrectAnswer
} from '../src/modules/assignments/grading.js';
import { createSubmission, evaluateSubmission, checkAccessCode, splitSubmissionText, daysLate } from '../src/modules/assignments/pipeline.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { generateAccessCode } from '../src/core/access-codes.js';

const mc = { id: 'q1', type: 'single_choice', points: 2, options: [{ id: 'a', text: 'A', is_correct: false }, { id: 'b', text: 'B', is_correct: true }] };
const multi = { id: 'q2', type: 'multi_choice', points: 4, scoring: 'partial', options: [
  { id: 'a', text: 'A', is_correct: true }, { id: 'b', text: 'B', is_correct: true }, { id: 'c', text: 'C', is_correct: false }, { id: 'd', text: 'D', is_correct: false }
] };
const tf = { id: 'q3', type: 'true_false', points: 1, correct: false };
const st = { id: 'q4', type: 'short_text', points: 2, accepted: ['Le Chatelier', 'Le Châtelier'], allow_typo: true };
const num = { id: 'q5', type: 'numeric', points: 3, target: 6.022e23, tolerance: 1, tolerance_type: 'percent' };
const fb = { id: 'q6', type: 'fill_blank', points: 2, prompt: 'Water is [[blank]] and salt is [[blank]].', blanks: [{ accepted: ['H2O', 'H₂O'] }, { accepted: ['NaCl'] }] };
const ord = { id: 'q7', type: 'ordering', points: 3, items: [{ id: 'i1', text: '1' }, { id: 'i2', text: '2' }, { id: 'i3', text: '3' }, { id: 'i4', text: '4' }] };
const match = { id: 'q8', type: 'matching', points: 3, pairs: [{ id: 'p1', left: 'Na', right: 'Sodium' }, { id: 'p2', left: 'K', right: 'Potassium' }, { id: 'p3', left: 'Fe', right: 'Iron' }], distractors: ['Gold'] };
const long = { id: 'q9', type: 'long_text', points: 5 };
const assignment = {
  id: 'as-1', title: 'Quiz', questions: [mc, multi, tf, st, num, fb, ord, match, long],
  settings: { feedback_mode: 'immediate', due_date: '2026-10-10' },
  publish: { version: 2, salt: 'salt-123' }
};

describe('Phase 9: Assignment grading engine', () => {
  it('normalizes text and numbers', () => {
    expect(normalizeText('  The  ANSWER. ')).toBe('the answer');
    expect(normalizeText('Abc', { caseSensitive: true })).toBe('Abc');
    expect(parseNumber('3,5')).toBe(3.5);
    expect(parseNumber('1,000.5')).toBe(1000.5);
    expect(parseNumber('6.02 x 10^23')).toBeCloseTo(6.02e23, -20);
    expect(parseNumber('6.02e23')).toBeCloseTo(6.02e23, -20);
    expect(parseNumber('12.5 mL')).toBe(12.5);
    expect(parseNumber('abc')).toBeNull();
    expect(levenshtein('kitten', 'sitten')).toBe(1);
    expect(countBlanks(fb.prompt)).toBe(2);
  });

  it('grades single choice and true/false', () => {
    expect(gradeQuestion(mc, 'b')).toMatchObject({ earned: 2, correct: true });
    expect(gradeQuestion(mc, 'a')).toMatchObject({ earned: 0, correct: false });
    expect(gradeQuestion(mc, undefined).detail.unanswered).toBe(true);
    expect(gradeQuestion(tf, false).earned).toBe(1);
    expect(gradeQuestion(tf, 'false').earned).toBe(1);
    expect(gradeQuestion(tf, true).earned).toBe(0);
  });

  it('grades multi-select with partial credit and a floor of zero', () => {
    expect(gradeQuestion(multi, ['a', 'b'])).toMatchObject({ earned: 4, correct: true });
    expect(gradeQuestion(multi, ['a'])).toMatchObject({ earned: 2, correct: false });
    expect(gradeQuestion(multi, ['a', 'c'])).toMatchObject({ earned: 0 });
    expect(gradeQuestion(multi, ['c', 'd']).earned).toBe(0);
    expect(gradeQuestion({ ...multi, scoring: 'all_or_nothing' }, ['a']).earned).toBe(0);
  });

  it('grades short text with normalization and single-typo tolerance', () => {
    expect(gradeQuestion(st, 'le chatelier.').earned).toBe(2);
    expect(gradeQuestion(st, 'Le Chatlier').earned).toBe(2);
    expect(gradeQuestion(st, 'Le Chtlier').earned).toBe(0);
    expect(gradeQuestion({ ...st, allow_typo: false }, 'Le Chatlier').earned).toBe(0);
  });

  it('grades numeric answers with absolute or percent tolerance', () => {
    expect(gradeQuestion(num, '6.05e23').earned).toBe(3);
    expect(gradeQuestion(num, '6.2e23').earned).toBe(0);
    const abs = { ...num, target: 9.81, tolerance: 0.05, tolerance_type: 'absolute' };
    expect(gradeQuestion(abs, '9,8').earned).toBe(3);
    expect(gradeQuestion(abs, '9.7').earned).toBe(0);
    expect(gradeQuestion({ ...abs, tolerance: 0 }, 9.81).earned).toBe(3);
  });

  it('grades fill-in-the-blank per blank', () => {
    expect(gradeQuestion(fb, ['h2o', 'NaCl'])).toMatchObject({ earned: 2, correct: true });
    expect(gradeQuestion(fb, ['h2o', 'KCl'])).toMatchObject({ earned: 1, correct: false });
    expect(gradeQuestion({ ...fb, scoring: 'all_or_nothing' }, ['h2o', 'KCl']).earned).toBe(0);
  });

  it('grades ordering by adjacent relative order', () => {
    expect(gradeQuestion(ord, ['i1', 'i2', 'i3', 'i4'])).toMatchObject({ earned: 3, correct: true });
    // one swap in the middle: pairs (1,3) ok, (3,2) wrong, (2,4) ok -> 2/3
    expect(gradeQuestion(ord, ['i1', 'i3', 'i2', 'i4']).earned).toBe(2);
    expect(gradeQuestion(ord, ['i4', 'i3', 'i2', 'i1']).earned).toBe(0);
    expect(gradeQuestion({ ...ord, scoring: 'all_or_nothing' }, ['i1', 'i3', 'i2', 'i4']).earned).toBe(0);
    expect(gradeQuestion(ord, ['i1', 'i2']).earned).toBe(0);
  });

  it('grades matching per pair and leaves long text for manual review', () => {
    expect(gradeQuestion(match, { p1: 'Sodium', p2: 'Potassium', p3: 'Iron' })).toMatchObject({ earned: 3, correct: true });
    expect(gradeQuestion(match, { p1: 'Sodium', p2: 'Gold', p3: 'Iron' }).earned).toBe(2);
    expect(gradeQuestion(long, 'An essay')).toMatchObject({ needs_manual: true, correct: null, earned: 0 });
  });

  it('totals submissions and applies manual overrides', () => {
    const answers = { q1: 'b', q2: ['a', 'b'], q3: false, q4: 'Le Chatelier', q5: '6.022e23', q6: ['H2O', 'NaCl'], q7: ['i1', 'i2', 'i3', 'i4'], q8: { p1: 'Sodium', p2: 'Potassium', p3: 'Iron' }, q9: 'Essay' };
    const auto = gradeSubmission(assignment, answers);
    expect(auto).toMatchObject({ earned: 20, possible: 25, needs_manual: 1 });
    expect(finalScore(assignment, { answers, auto, manual: {} })).toMatchObject({ earned: 20, pending: 1 });
    expect(finalScore(assignment, { answers, auto, manual: { q9: { points: 4 }, q1: { points: 1 } } })).toMatchObject({ earned: 23, pending: 0 });
    expect(finalScore(assignment, { answers, auto, manual: { q9: { points: 99 } } }).earned).toBe(25);
  });

  it('describes correct answers for review', () => {
    expect(describeCorrectAnswer(ord)).toBe('1 → 2 → 3 → 4');
    expect(describeCorrectAnswer(tf)).toBe('False');
  });
});

describe('Phase 9: Published payload and instant feedback', () => {
  it('strips the answer key and checks answers via hashes', async () => {
    const keys = await SubmissionCrypto.generateKeyPair();
    const payload = await buildStudentPayload(assignment, { teacherKeys: keys });
    const json = JSON.stringify(payload);
    expect(json).not.toContain('is_correct');
    expect(json).not.toContain('accepted');
    expect(json).not.toContain('Le Chatelier');
    expect(json).not.toContain('6.022');
    expect(payload.reveal).toBeUndefined();

    const q = Object.fromEntries(payload.questions.map(x => [x.id, x]));
    const salt = payload.salt;
    expect(await checkAnswerLocally(q.q1, 'b', salt)).toBe(true);
    expect(await checkAnswerLocally(q.q1, 'a', salt)).toBe(false);
    expect(await checkAnswerLocally(q.q2, ['b', 'a'], salt)).toBe(true);
    expect(await checkAnswerLocally(q.q3, false, salt)).toBe(true);
    expect(await checkAnswerLocally(q.q4, 'le chatelier', salt)).toBe(true);
    expect(await checkAnswerLocally(q.q5, '6.022e23', salt)).toBeNull();
    expect(await checkAnswerLocally(q.q6, ['h2o', 'nacl'], salt)).toBe(true);
    expect(await checkAnswerLocally(q.q6, ['h2o', 'kcl'], salt)).toBe(false);
    expect(await checkAnswerLocally(q.q7, ['i1', 'i2', 'i3', 'i4'], salt)).toBe(true);
    expect(await checkAnswerLocally(q.q8, { p1: 'Sodium', p2: 'Potassium', p3: 'Iron' }, salt)).toBe(true);
    expect(await checkAnswerLocally(q.q8, { p1: 'Sodium', p2: 'Iron', p3: 'Potassium' }, salt)).toBe(false);
    expect(await checkAnswerLocally(q.q9, 'essay', salt)).toBeNull();
    // ordering items are never published in the correct order
    expect(q.q7.items.map(i => i.id).join()).not.toBe('i1,i2,i3,i4');
  });

  it('omits hashes when feedback is off and includes reveal text only when allowed', async () => {
    const keys = await SubmissionCrypto.generateKeyPair();
    const none = await buildStudentPayload({ ...assignment, settings: { feedback_mode: 'none' } }, { teacherKeys: keys });
    expect(none.questions.every(x => !x.check)).toBe(true);
    const reveal = await buildStudentPayload({ ...assignment, settings: { feedback_mode: 'after_submit', show_correct_answers: true } }, { teacherKeys: keys });
    expect(reveal.reveal.q1.answer).toBe('B');
  });
});

describe('Phase 9: Encrypted submission round trip', () => {
  const setup = async () => {
    const keys = await SubmissionCrypto.generateKeyPair();
    const code = generateAccessCode();
    const roster = [{ student_id: 'S101', full_name: 'Emma Watson', access_code: code }, { student_id: 'S102', full_name: 'Liam Chen' }];
    const rosterChecks = { S101: await SubmissionCrypto.accessCodeCheck(assignment.id, 'S101', code) };
    const payload = await buildStudentPayload(assignment, { teacherKeys: keys, rosterChecks });
    return { keys, code, roster, payload };
  };

  it('validates access codes on the student side', async () => {
    const { payload, code } = await setup();
    expect(await checkAccessCode(payload, 's101', code.toLowerCase())).toBe('ok');
    expect(await checkAccessCode(payload, 'S101', 'WRONG-CODE')).toBe('mismatch');
    expect(await checkAccessCode(payload, 'S999', code)).toBe('unknown_student');
  });

  it('re-grades from the local key and ignores a tampered client score', async () => {
    const { keys, code, roster, payload } = await setup();
    const { text } = await createSubmission({ payload, studentId: 's101', studentName: 'Emma', accessCode: code, answers: { q1: 'a', q3: false }, clientScore: { earned: 25, possible: 25 } });
    expect(splitSubmissionText(`noise ${text} more`)).toEqual([text]);
    const row = await evaluateSubmission({ text, teacherPrivateJwk: keys.privateJwk, assignment, roster });
    expect(row.identity).toBe('verified');
    expect(row.student_id).toBe('S101');
    expect(row.student_name).toBe('Emma Watson');
    expect(row.auto.earned).toBe(1);
    expect(row.client_score.earned).toBe(25);
    expect(row.stale_version).toBe(false);
  });

  it('flags impersonation, missing codes and unknown students', async () => {
    const { keys, roster, payload } = await setup();
    const forged = await createSubmission({ payload, studentId: 'S101', studentName: 'Emma', accessCode: generateAccessCode(), answers: {} });
    expect((await evaluateSubmission({ text: forged.text, teacherPrivateJwk: keys.privateJwk, assignment, roster })).identity).toBe('code_mismatch');
    const nocode = await createSubmission({ payload, studentId: 'S102', studentName: 'Liam', accessCode: '', answers: {} });
    expect((await evaluateSubmission({ text: nocode.text, teacherPrivateJwk: keys.privateJwk, assignment, roster })).identity).toBe('no_code_on_file');
    const stranger = await createSubmission({ payload, studentId: 'X1', studentName: 'X', accessCode: '', answers: {} });
    expect((await evaluateSubmission({ text: stranger.text, teacherPrivateJwk: keys.privateJwk, assignment, roster })).identity).toBe('not_in_roster');
  });

  it('rejects other teachers, other assignments and garbage', async () => {
    const { roster, payload, code } = await setup();
    const other = await SubmissionCrypto.generateKeyPair();
    const { text } = await createSubmission({ payload, studentId: 'S101', accessCode: code, answers: {} });
    await expect(evaluateSubmission({ text, teacherPrivateJwk: other.privateJwk, assignment, roster })).rejects.toThrow('DECRYPTION_FAILED');
    await expect(evaluateSubmission({ text, teacherPrivateJwk: other.privateJwk, assignment: { ...assignment, id: 'as-2' }, roster })).rejects.toThrow('WRONG_ASSIGNMENT');
    await expect(evaluateSubmission({ text: 'hello', teacherPrivateJwk: other.privateJwk, assignment, roster })).rejects.toThrow('NOT_A_SUBMISSION');
  });

  it('computes days late against the end of the due date', () => {
    expect(daysLate('2026-10-10', '2026-10-10T20:00:00')).toBe(0);
    expect(daysLate('2026-10-10', '2026-10-11T09:00:00')).toBe(1);
    expect(daysLate('2026-10-10', '2026-10-13T09:00:00')).toBe(3);
    expect(daysLate(null, '2026-10-13T09:00:00')).toBe(0);
  });
});
