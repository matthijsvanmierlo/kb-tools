import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { reconcileDraftAnswers } from '../src/modules/assignments/take.js';
import { deriveDraftSecrets, sealDraft, openDraft } from '../src/modules/assignments/draft-roaming.js';
import { reconcileSubmissionWithAssignment, computeAnswersFingerprint } from '../src/modules/assignments/pipeline.js';
import { StudentMatcher } from '../src/core/student-matcher.js';
import { StudentLedger } from '../src/modules/student/ledger.js';
import { generateAccessCode, normalizeAccessCode } from '../src/core/access-codes.js';
import { SubmissionCrypto, sha256Hex } from '../src/core/submission-crypto.js';
import { storage } from '../src/core/storage.js';
import { computeRosterHash } from '../src/modules/assignments/publish.js';

describe('Pillar 1: Non-Destructive Reconciliation', () => {
  describe('Cross-Version Draft Migration (reconcileDraftAnswers)', () => {
    it('migrates valid answers from v1 questions to v2 while dropping removed questions', () => {
      const v1Answers = {
        q1: 'opt_a',
        q2: ['opt_b', 'opt_c', 'stale_opt'],
        q3: '42',
        q_removed: 'should be dropped',
        q_matching: { left1: 'right1', left2: 'stale_right', stale_left: 'right1' },
        q_order: ['item2', 'item1', 'stale_item']
      };

      const v2Questions = [
        { id: 'q1', type: 'single_choice', options: [{ id: 'opt_a' }, { id: 'opt_b' }] },
        { id: 'q2', type: 'multi_choice', options: [{ id: 'opt_b' }, { id: 'opt_c' }] },
        { id: 'q3', type: 'numeric', points: 1 },
        { id: 'q_matching', type: 'matching', pairs: [{ left: 'left1', left_id: 'left1' }, { left: 'left2', left_id: 'left2' }], rights: ['right1', 'right2'] },
        { id: 'q_order', type: 'ordering', items: [{ id: 'item1' }, { id: 'item2' }, { id: 'item3' }] },
        { id: 'q_new', type: 'short_text', points: 1 }
      ];

      const { newAnswers, migratedCount } = reconcileDraftAnswers({ questions: v2Questions }, v1Answers);

      expect(newAnswers.q1).toBe('opt_a');
      expect(newAnswers.q2).toEqual(['opt_b', 'opt_c']);
      expect(newAnswers.q3).toBe('42');
      expect(newAnswers.q_removed).toBeUndefined();
      expect(newAnswers.q_matching).toEqual({ left1: 'right1' });
      expect(newAnswers.q_order).toEqual(['item2', 'item1', 'item3']);
      expect(newAnswers.q_new).toBeUndefined();
      expect(migratedCount).toBe(5);
    });
  });

  describe('Draft Roaming Version-Independent AAD & Cross-Version Open', () => {
    it('allows drafts sealed in v1 to be opened in v2 seamlessly via version-independent AAD', async () => {
      const assignmentId = 'asg-test-123';
      const studentId = 'STU001';
      const accessCode = 'ABC123XYZ';
      const draftData = { answers: { q1: 'test answer' }, progress: 50 };

      const secretsV1 = await deriveDraftSecrets({ assignmentId, studentId, accessCode, publishVersion: 1 });
      const secretsV2 = await deriveDraftSecrets({ assignmentId, studentId, accessCode, publishVersion: 2 });

      // Sealed in version 1
      const sealedV1 = await sealDraft(secretsV1, draftData);

      // Opened in version 2 by student who loaded updated assignment link!
      const openedV2 = await openDraft(secretsV2, sealedV1);
      expect(openedV2).toEqual(draftData);
    });

    it('falls back to legacy versioned AAD for backward compatibility with older saved drafts', async () => {
      const assignmentId = 'asg-legacy-999';
      const studentId = 'STU002';
      const accessCode = 'XYZ987ABC';
      const draftData = { answers: { q1: 'legacy response' } };

      const secrets = await deriveDraftSecrets({ assignmentId, studentId, accessCode, publishVersion: 1 });

      // Seal manually with legacy versioned AAD
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: secrets.legacyAad },
        secrets.key,
        new TextEncoder().encode(JSON.stringify(draftData))
      ));
      const b64 = btoa(String.fromCharCode(...new Uint8Array([...iv, ...ct])));
      const legacySealed = `KBDRAFT1.${b64}`;

      // Open with secrets matching that version
      const opened = await openDraft(secrets, legacySealed);
      expect(opened).toEqual(draftData);
    });
  });

  describe('Answer Key Edit & Submission Re-evaluation (reconcileSubmissionWithAssignment)', () => {
    it('recalculates auto score with updated answer key while preserving manual overrides and archiving removed questions', async () => {
      const sub = {
        id: 'sub-1',
        assignment_id: 'asg-1',
        student_id: 'STU1',
        answers: {
          q1: 'opt_b', // was incorrect in v1, correct in v2
          q2: 'manual essay response',
          q_removed: 'old answer'
        },
        auto: { earned: 0, possible: 2, per_question: { q1: { earned: 0, possible: 1, correct: false }, q2: { earned: 0, possible: 1, needs_manual: true } } },
        manual: { q2: { points: 1, feedback: 'Great essay!' } },
        feedback: 'Overall good work',
        synced_at: '2026-10-01T12:00:00Z',
        publish_version: 1
      };

      const updatedAssignment = {
        id: 'asg-1',
        publish: { version: 2 },
        questions: [
          { id: 'q1', type: 'single_choice', points: 1, options: [{ id: 'opt_a' }, { id: 'opt_b', is_correct: true }] },
          { id: 'q2', type: 'long_text', points: 1 }
        ]
      };

      const reconciled = await reconcileSubmissionWithAssignment(sub, updatedAssignment, []);

      expect(reconciled.auto.earned).toBe(1);
      expect(reconciled.auto.per_question.q1.correct).toBe(true);
      expect(reconciled.manual.q2).toEqual({ points: 1, feedback: 'Great essay!' });
      expect(reconciled.feedback).toBe('Overall good work');
      expect(reconciled.archived_answers.q_removed).toBe('old answer');
      expect(reconciled.score_reconciled).toBe(true);
      expect(reconciled.synced_at).toBeNull(); // Reset sync because score changed
    });
  });

  describe('Student Ledger Deduplication & Revision History (StudentLedger)', () => {
    beforeEach(async () => {
      await storage.init();
      await storage.table('student_courses').clear().catch(() => {});
      await storage.table('student_ledger').clear().catch(() => {});
    });

    it('upserts by course_id and assignment_id without creating duplicate entries and appends to revision history', async () => {
      const courseId = 'course-bio-101';
      const asgId = 'asg-cell-mitosis';

      const initialPayload = {
        course: { id: courseId, name: 'Biology 101' },
        assignment: { id: asgId, title: 'Mitosis Lab', total_points: 20 },
        score: { earned: 16, possible: 20 },
        feedback: 'Good first submission',
        questions: [{ id: 'q1', earned: 4, possible: 5 }]
      };

      await StudentLedger.ingestAssignmentFeedback(initialPayload);
      let items = await storage.table('student_ledger').toArray();
      expect(items.length).toBe(1);
      expect(items[0].score.earned).toBe(16);
      expect(items[0].history.length).toBe(0);

      // Re-ingest with updated score and teacher comment
      const updatedPayload = {
        course: { id: courseId, name: 'Biology 101' },
        assignment: { id: asgId, title: 'Mitosis Lab', total_points: 20 },
        score: { earned: 19, possible: 20 },
        feedback: 'Regraded: Excellent revisions!',
        questions: [{ id: 'q1', earned: 5, possible: 5 }]
      };

      await StudentLedger.ingestAssignmentFeedback(updatedPayload);
      items = await storage.table('student_ledger').toArray();

      // Must be deduplicated (still exactly 1 item)
      expect(items.length).toBe(1);
      expect(items[0].score.earned).toBe(19);
      expect(items[0].overall_feedback).toBe('Regraded: Excellent revisions!');
      // History should record the initial attempt
      expect(items[0].history.length).toBe(1);
      expect(items[0].history[0].score.earned).toBe(16);
      expect(items[0].history[0].overall_feedback).toBe('Good first submission');
    });

    it('records submissions non-destructively alongside receipts and answers', async () => {
      const courseId = 'course-bio-101';
      const asgId = 'asg-cell-mitosis';

      await StudentLedger.recordSubmission({
        assignmentId: asgId,
        courseId,
        title: 'Mitosis Lab',
        receiptId: 'RCPT-123456',
        answers: { q1: 'prophase' },
        submissionText: 'KBSUB1.testdata123'
      });

      const [recorded] = await storage.table('student_ledger').where('[course_id+assignment_id]').equals([courseId, asgId]).toArray();
      expect(recorded).toBeDefined();
      expect(recorded.receipt_id).toBe('RCPT-123456');
      expect(recorded.local_answers.q1).toBe('prophase');
      expect(recorded.submission_text).toBe('KBSUB1.testdata123');

      // Now teacher returns feedback
      await StudentLedger.ingestAssignmentFeedback({
        course: { id: courseId, name: 'Biology 101' },
        assignment: { id: asgId, title: 'Mitosis Lab', total_points: 10 },
        score: { earned: 10, possible: 10 },
        feedback: 'Perfect!'
      });

      const [item] = await storage.table('student_ledger').where('[course_id+assignment_id]').equals([courseId, asgId]).toArray();
      // Receipt, answers, and submission text must still be preserved!
      expect(item.receipt_id).toBe('RCPT-123456');
      expect(item.local_answers.q1).toBe('prophase');
      expect(item.submission_text).toBe('KBSUB1.testdata123');
      expect(item.score.earned).toBe(10);
    });
  });
});

describe('Pillar 2: Zero-Trust Security Hardening', () => {
  describe('Access Code Rotation History & Historical Code Verification', () => {
    it('verifies signatures using historical retired access codes with verified status', async () => {
      const oldCode = 'OLD12345';
      const newCode = 'NEW67890';
      const studentId = 'STU42';
      const asgId = 'asg-crypto';

      const roster = [
        {
          student_id: studentId,
          full_name: 'Grace Hopper',
          access_code: newCode,
          previous_access_codes: [{ code: oldCode, retired_at: '2026-09-01T00:00:00Z' }]
        }
      ];

      const body = {
        assignment_id: asgId,
        student_id: studentId,
        student_name: 'Grace Hopper',
        answers: { q1: 'binary' },
        submitted_at: '2026-10-15T12:00:00Z'
      };

      // Sign with old code
      const oldSignature = await SubmissionCrypto.signWithAccessCode(body, oldCode);
      const matchWithOld = await StudentMatcher.resolveStudentForSubmission({ body, signature: oldSignature, roster });

      expect(matchWithOld.identity).toBe('verified');
      expect(matchWithOld.matchedStudent.student_id).toBe(studentId);
      expect(matchWithOld.note).toContain('Signed with previous access code');

      // Sign with new code
      const newSignature = await SubmissionCrypto.signWithAccessCode(body, newCode);
      const matchWithNew = await StudentMatcher.resolveStudentForSubmission({ body, signature: newSignature, roster });

      expect(matchWithNew.identity).toBe('verified');
      expect(matchWithNew.note).toBeFalsy();

      // Sign with impostor code
      const wrongSignature = await SubmissionCrypto.signWithAccessCode(body, 'IMPOSTOR99');
      const matchWithWrong = await StudentMatcher.resolveStudentForSubmission({ body, signature: wrongSignature, roster });

      expect(matchWithWrong.identity).toBe('code_mismatch');
    });
  });

  describe('Duplicate Work Detection & Answer Fingerprinting', () => {
    it('generates consistent fingerprint invariant of key order and whitespace, and detects duplicates', async () => {
      const answersA = { q1: '  Hydrogen  ', q2: ['alpha', 'beta'], q3: 'Option A' };
      const answersB = { q3: 'option a', q1: 'hydrogen', q2: ['beta', 'alpha'] };
      const answersDifferent = { q1: 'Oxygen', q2: ['alpha'], q3: 'Option B' };

      const fpA = await computeAnswersFingerprint(answersA);
      const fpB = await computeAnswersFingerprint(answersB);
      const fpDiff = await computeAnswersFingerprint(answersDifferent);

      expect(fpA).toBe(fpB);
      expect(fpA).not.toBe(fpDiff);
      expect(typeof fpA).toBe('string');
      expect(fpA.length).toBe(64); // SHA-256 hex string
    });
  });
});

describe('Pillar 3: Class Linking & Roster Staleness Guarantees', () => {
  it('computes deterministic roster hash and detects staleness when roster changes', async () => {
    const rosterInitial = [
      { student_id: 'STU1', full_name: 'Alice Smith', access_code: 'CODE1' },
      { student_id: 'STU2', full_name: 'Bob Jones', access_code: 'CODE2' }
    ];

    const hash1 = await computeRosterHash(rosterInitial);
    expect(hash1).toBeTruthy();

    // Invariant to roster sort order
    const rosterReversed = [rosterInitial[1], rosterInitial[0]];
    const hashReversed = await computeRosterHash(rosterReversed);
    expect(hashReversed).toBe(hash1);

    // Changes when a student is added
    const rosterAdded = [...rosterInitial, { student_id: 'STU3', full_name: 'Charlie', access_code: 'CODE3' }];
    const hashAdded = await computeRosterHash(rosterAdded);
    expect(hashAdded).not.toBe(hash1);

    // Changes when an access code is rotated
    const rosterRotated = [
      { student_id: 'STU1', full_name: 'Alice Smith', access_code: 'NEWCODE' },
      rosterInitial[1]
    ];
    const hashRotated = await computeRosterHash(rosterRotated);
    expect(hashRotated).not.toBe(hash1);
  });
});
