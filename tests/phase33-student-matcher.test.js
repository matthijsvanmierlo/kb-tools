import { describe, it, expect, beforeEach } from 'vitest';
import { StudentMatcher, parseLmsFilename } from '../src/core/student-matcher.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { generateAccessCode } from '../src/core/access-codes.js';
import { storage } from '../src/core/storage.js';

describe('Phase 33: StudentMatcher Multi-Signal Resolution', () => {
  let roster;
  let code1;
  let code2;

  beforeEach(async () => {
    code1 = generateAccessCode();
    code2 = generateAccessCode();

    roster = [
      {
        id: 'rec-1',
        course_id: 'c1',
        student_id: 'S00142',
        full_name: 'Emma Watson',
        given_name: 'Emma',
        family_name: 'Watson',
        email: 'ewatson@school.edu',
        access_code: code1
      },
      {
        id: 'rec-2',
        course_id: 'c1',
        student_id: 'S00143',
        full_name: 'Liam Chen',
        given_name: 'Liam',
        family_name: 'Chen',
        email: 'lchen@school.edu',
        access_code: code2
      },
      {
        id: 'rec-3',
        course_id: 'c1',
        student_id: 'S00144',
        full_name: 'María García-López',
        given_name: 'María',
        family_name: 'García-López',
        email: 'mgarcia@school.edu',
        access_code: null
      }
    ];
  });

  it('matches exact student ID case-insensitively', async () => {
    const res = await StudentMatcher.resolveStudentForSubmission({
      claimedId: 's00142',
      claimedName: 'Emma Watson',
      roster
    });
    expect(res.matchedStudent).toBeTruthy();
    expect(res.matchedStudent.student_id).toBe('S00142');
    expect(res.matchedBy).toBe('exact_id');
    expect(res.matchConfidence).toBe(1.0);
  });

  it('matches normalized ID stripping leading zeros and spaces', async () => {
    const res = await StudentMatcher.resolveStudentForSubmission({
      claimedId: '142', // Typed 142 instead of S00142
      claimedName: 'Emma Watson',
      roster
    });
    expect(res.matchedStudent).toBeTruthy();
    expect(res.matchedStudent.student_id).toBe('S00142');
    expect(res.matchedBy).toBe('norm_id');
  });

  it('matches by student email or email username', async () => {
    const res = await StudentMatcher.resolveStudentForSubmission({
      claimedId: 'lchen@school.edu',
      claimedName: 'Liam',
      roster
    });
    expect(res.matchedStudent).toBeTruthy();
    expect(res.matchedStudent.student_id).toBe('S00143');
    expect(res.matchedBy).toBe('email');
  });

  it('resolves via cryptographic HMAC scan even if student ID was completely mistyped', async () => {
    const body = {
      assignment_id: 'asg-test',
      publish_version: 1,
      student_id: 'TYPO-WRONG-ID',
      student_name: 'Emma',
      answers: { q1: 'a' }
    };
    const signature = await SubmissionCrypto.signWithAccessCode(body, code1);

    const res = await StudentMatcher.resolveStudentForSubmission({
      body,
      signature,
      roster
    });

    expect(res.matchedStudent).toBeTruthy();
    expect(res.matchedStudent.student_id).toBe('S00142');
    expect(res.matchedBy).toBe('access_code');
    expect(res.identity).toBe('verified');
  });

  it('matches diacritics and inverted names (e.g. Maria Garcia-Lopez vs María)', async () => {
    const res = await StudentMatcher.resolveStudentForSubmission({
      claimedId: '',
      claimedName: 'Garcia-Lopez, Maria',
      roster
    });
    expect(res.matchedStudent).toBeTruthy();
    expect(res.matchedStudent.student_id).toBe('S00144');
    expect(res.matchedBy).toBe('canonical_name');
  });

  it('parses LMS bulk-download filenames', () => {
    const canvas = parseLmsFilename('chenliam_12345_67890_MidtermQuiz.kbsub');
    expect(canvas).toEqual({ token: 'chenliam', lms: 'canvas' });

    const moodle = parseLmsFilename('Emma Watson_9876_assignsubmission_file_quiz.kbsub');
    expect(moodle).toEqual({ name: 'Emma Watson', lms: 'moodle' });

    const classroom = parseLmsFilename('Emma Watson - Period 2 Quiz.kbsub');
    expect(classroom).toEqual({ token: 'Emma Watson', lms: 'generic' });
  });

  it('provides fuzzy suggestion scoring when name is similar but not exact', async () => {
    const res = await StudentMatcher.resolveStudentForSubmission({
      claimedId: 'UNKNOWN-999',
      claimedName: 'Ema Watsen', // Typos in first and last name
      roster
    });
    expect(res.matchedStudent).toBeNull();
    expect(res.suggestedStudent).toBeTruthy();
    expect(res.suggestedStudent.student_id).toBe('S00142');
    expect(res.identity).toBe('suggested_match');
    expect(res.matchConfidence).toBeGreaterThan(0.65);
  });
});
