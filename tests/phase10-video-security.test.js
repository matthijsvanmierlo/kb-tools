import { describe, it, expect } from 'vitest';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { generateAccessCode } from '../src/core/access-codes.js';
import { KioskReportEngine } from '../src/modules/video/kiosk-report.js';
import {
  buildStudentVideoPayload, checkChoiceAnswer, checkKeywords, gradeVideoResponses,
  createSecureReceipt, openReceipt, maxScoreOf
} from '../src/modules/video/secure.js';

const assessment = {
  id: 'vid-1',
  title: 'Edge of the Solar System',
  class_id: 'course-1',
  provider: 'html5',
  video_source: 'https://example.org/v.mp4',
  checkpoints: [
    { id: 'n1', type: 'note', timestamp_sec: 5, prompt_markdown: 'Watch', points: 0 },
    { id: 'c1', type: 'single_choice', timestamp_sec: 10, prompt_markdown: 'Outermost planet?', points: 1,
      options: [{ id: 'a', text: 'Neptune', is_correct: true, rationale: 'Yes' }, { id: 'b', text: 'Pluto', is_correct: false }] },
    { id: 'c2', type: 'multi_choice', timestamp_sec: 20, prompt_markdown: 'Edges?', points: 2,
      options: [{ id: 'x', text: 'Heliosphere', is_correct: true }, { id: 'y', text: 'Oort Cloud', is_correct: true }, { id: 'z', text: 'Moon', is_correct: false }] },
    { id: 'o1', type: 'open_response', timestamp_sec: 30, prompt_markdown: 'Why?', points: 2, keywords: ['Oort', 'red spot'] }
  ]
};

const keysP = SubmissionCrypto.generateKeyPair();

describe('Phase 10: Video assessment answer-key protection', () => {
  it('ships no answer key in the student payload', async () => {
    const keys = await keysP;
    const payload = await buildStudentVideoPayload(assessment, { teacherKeys: keys });
    const json = JSON.stringify(payload);
    expect(json).not.toContain('is_correct');
    expect(json).not.toContain('keywords');
    expect(json.toLowerCase()).not.toContain('red spot');
    expect(payload.secure.teacher_public_key).toEqual(keys.publicJwk);
    expect(maxScoreOf(payload.checkpoints)).toBe(5);
  });

  it('gives instant feedback from hashes, and nothing when feedback is off', async () => {
    const keys = await keysP;
    const p = await buildStudentVideoPayload(assessment, { teacherKeys: keys });
    const [, c1, c2, o1] = p.checkpoints;
    expect(await checkChoiceAnswer(c1, ['a'], p.secure.salt)).toBe(true);
    expect(await checkChoiceAnswer(c1, ['b'], p.secure.salt)).toBe(false);
    expect(await checkChoiceAnswer(c2, ['y', 'x'], p.secure.salt)).toBe(true);
    expect(await checkChoiceAnswer(c2, ['x'], p.secure.salt)).toBe(false);
    expect(await checkKeywords(o1, 'Because of the great Red Spot!', p.secure.salt)).toBe(true);
    expect(await checkKeywords(o1, 'no idea', p.secure.salt)).toBe(false);

    const silent = await buildStudentVideoPayload(assessment, { teacherKeys: keys, instantFeedback: false });
    expect(silent.checkpoints[1].answer_check).toBeUndefined();
    expect(silent.checkpoints[1].options[0].rationale).toBeUndefined();
    expect(await checkChoiceAnswer(silent.checkpoints[1], ['a'], silent.secure.salt)).toBeNull();
  });
});

describe('Phase 10: Encrypted, signed video receipts', () => {
  const roster = [{ student_id: 'S101', full_name: 'Emma Watson', access_code: generateAccessCode() }];
  const ctx = async () => {
    const keys = await keysP;
    return {
      keys,
      open: (text) => openReceipt(text, {
        teacherPrivateJwk: keys.privateJwk,
        getAssessment: async (id) => (id === assessment.id ? assessment : null),
        getStudents: async () => roster
      })
    };
  };

  it('re-grades from the teacher key and ignores the client score', async () => {
    const { keys, open } = await ctx();
    const payload = await buildStudentVideoPayload(assessment, { teacherKeys: keys });
    const logs = [
      { checkpointId: 'c1', studentAnswer: ['b'], earnedPoints: 999, latencyMs: 100 },
      { checkpointId: 'c2', studentAnswer: ['x', 'y'], earnedPoints: 2, latencyMs: 100 },
      { checkpointId: 'o1', studentAnswer: 'The Oort cloud is far', earnedPoints: 2, latencyMs: 100 }
    ];
    const { text } = await createSecureReceipt({ payload, studentName: 'Emma Watson', studentId: 's101', accessCode: roster[0].access_code, responseLogs: logs });
    const res = await open(text);
    expect(res.ok).toBe(true);
    expect(res.identity).toBe('verified');
    expect(res.earned).toBe(4);
    expect(res.max).toBe(5);
    expect(res.clientScore.earned).toBe(1003);
  });

  it('flags impersonation and refuses receipts for another teacher', async () => {
    const { keys, open } = await ctx();
    const payload = await buildStudentVideoPayload(assessment, { teacherKeys: keys });
    const { text } = await createSecureReceipt({ payload, studentName: 'Emma Watson', studentId: 'S101', accessCode: generateAccessCode(), responseLogs: [] });
    expect((await open(text)).identity).toBe('code_mismatch');

    const other = await SubmissionCrypto.generateKeyPair();
    const foreign = await buildStudentVideoPayload(assessment, { teacherKeys: other });
    const r2 = await createSecureReceipt({ payload: foreign, studentName: 'X', studentId: 'S101', accessCode: roster[0].access_code, responseLogs: [] });
    const res = await open(r2.text);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('NOT_FOR_THIS_TEACHER');
  });

  it('opens legacy v1 receipts but marks them unverifiable', async () => {
    const { open } = await ctx();
    const { kbrString } = await KioskReportEngine.generateReceipt('Emma Watson', 'vid-1', 'T', [], 5, 5);
    const res = await open(kbrString);
    expect(res.format).toBe('legacy');
    expect(res.identity).toBe('legacy');
  });

  it('grades open responses on whole words and phrases', () => {
    const g = gradeVideoResponses(assessment, [{ checkpointId: 'o1', studentAnswer: 'spotted a redshift' }]);
    expect(g.perCheckpoint.find(p => p.checkpointId === 'o1').isCorrect).toBe(false);
    const plural = gradeVideoResponses({ checkpoints: [{ id: 'k', type: 'open_response', points: 1, keywords: ['gas', 'planet'] }] }, [{ checkpointId: 'k', studentAnswer: 'Both are gases.' }]);
    expect(plural.earned).toBe(1);
  });
});
