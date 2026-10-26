import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { FeedbackCapsule } from '../src/core/feedback-capsule.js';
import { createDatabase } from '../server/relay/db.js';

describe('Phase 3: Blind Dead-Drop Feedback Mailbox & Offline Class Capsules', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const tables = ['student_ledger', 'student_items'];
    for (const t of tables) {
      try {
        await storage.table(t).clear();
      } catch (_) {}
    }
  });

  describe('Initiative #1: Cryptographic Feedback Envelopes & Blind Drop IDs', () => {
    it('derives deterministic blind drop IDs and prevents correlation', async () => {
      const assignmentId = 'asg-phys-101';
      const codeA = 'KB-CODE-1111';
      const codeB = 'KB-CODE-2222';

      const dropIdA1 = await FeedbackCapsule.deriveBlindDropId(assignmentId, codeA);
      const dropIdA2 = await FeedbackCapsule.deriveBlindDropId(assignmentId, codeA);
      const dropIdB = await FeedbackCapsule.deriveBlindDropId(assignmentId, codeB);

      expect(dropIdA1).toBe(dropIdA2);
      expect(dropIdA1).toHaveLength(64);
      expect(dropIdA1).not.toBe(dropIdB);
      // Ensure no raw codes leak into blind drop id
      expect(dropIdA1).not.toContain('1111');
      expect(dropIdA1).not.toContain('KB-CODE');
    });

    it('encrypts feedback envelope and decrypts only with student access code', async () => {
      const accessCode = 'ALICE-ACCESS-987';
      const feedbackData = {
        assignment_id: 'task-chem-1',
        student_id: 'ALICE_W',
        points: 92,
        status: 'graded',
        feedback: 'Excellent explanation of covalent bonds!',
        audio_note: 'data:audio/webm;base64,GkXfo59ChoEBQveBAULygQ8=',
        rubric_eval: { 'crit-1': 'tier-mastery' },
        reviewed_at: '2026-10-26T12:00:00.000Z'
      };

      const { envelope, token } = await FeedbackCapsule.createFeedbackEnvelope(feedbackData, accessCode);
      expect(envelope).toBeDefined();
      expect(envelope.kbfb).toBe(1);
      expect(token).toMatch(/^KBFB1\./);

      // Decrypt using token and correct access code
      const decrypted = await FeedbackCapsule.openFeedbackEnvelope(token, accessCode);
      expect(decrypted.student_id).toBe('ALICE_W');
      expect(decrypted.points).toBe(92);
      expect(decrypted.feedback).toBe('Excellent explanation of covalent bonds!');
      expect(decrypted.audio_note).toContain('data:audio/webm');

      // Attempt decryption with wrong access code fails
      await expect(
        FeedbackCapsule.openFeedbackEnvelope(token, 'BOB-ACCESS-123')
      ).rejects.toThrow();
    });

    it('bundles multi-student class capsule and decrypts per student access code', async () => {
      const assignmentId = 'task-math-final';
      const items = [
        {
          studentId: 'STU_A',
          studentAccessCode: 'CODE-STUDENT-AAA',
          feedback: {
            assignment_id: assignmentId,
            student_id: 'STU_A',
            points: 98,
            feedback: 'Flawless calculus proof.'
          }
        },
        {
          studentId: 'STU_B',
          studentAccessCode: 'CODE-STUDENT-BBB',
          feedback: {
            assignment_id: assignmentId,
            student_id: 'STU_B',
            points: 75,
            feedback: 'Review integration by parts.'
          }
        }
      ];

      const classPack = await FeedbackCapsule.createClassCapsulePack({
        assignmentId,
        classId: 'class-math-202',
        title: 'Calculus Final Exam',
        items
      });

      expect(classPack.kbclasspack).toBe(1);
      expect(classPack.capsules).toHaveLength(2);

      // Student A unpacks with code A
      const resultA = await FeedbackCapsule.unpackClassCapsule(classPack, 'CODE-STUDENT-AAA');
      expect(resultA.success).toBe(true);
      expect(resultA.feedback.student_id).toBe('STU_A');
      expect(resultA.feedback.points).toBe(98);

      // Verify student ledger was updated for Student A
      const ledgerA = await storage.table('student_ledger').get(`fb-${assignmentId}-STU_A`);
      expect(ledgerA).toBeDefined();
      expect(ledgerA.points).toBe(98);

      // Student B unpacks with code B
      const resultB = await FeedbackCapsule.unpackClassCapsule(classPack, 'CODE-STUDENT-BBB');
      expect(resultB.success).toBe(true);
      expect(resultB.feedback.student_id).toBe('STU_B');
      expect(resultB.feedback.points).toBe(75);

      // Unregistered access code fails cleanly
      const resultC = await FeedbackCapsule.unpackClassCapsule(classPack, 'CODE-STUDENT-CCC');
      expect(resultC.success).toBe(false);
      expect(resultC.error).toBe('NO_MATCHING_FEEDBACK_FOR_CODE');
    });
  });

  describe('Relay Server Dead-Drop Mailbox Integration', () => {
    it('stores, retrieves, and prunes feedback drops in relay sqlite db', () => {
      const db = createDatabase(':memory:');
      const dropId = 'drop-blind-hash-1234567890abcdef1234567890abcdef';
      const ciphertext = 'KBFB1.FAKE_CIPHERTEXT_ABC_XYZ';
      const expiresAt = new Date(Date.now() + 3600000).toISOString();

      db.feedbackDrops.put({ dropId, ciphertext, expiresAt });

      const fetched = db.feedbackDrops.get(dropId);
      expect(fetched).toBeDefined();
      expect(fetched.ciphertext).toBe(ciphertext);

      // Test expiration prune
      const expiredDropId = 'drop-blind-hash-expired-1111222233334444';
      db.feedbackDrops.put({
        dropId: expiredDropId,
        ciphertext: 'KBFB1.EXPIRED',
        expiresAt: new Date(Date.now() - 10000).toISOString()
      });

      const pruned = db.pruneExpired();
      expect(pruned.feedbackPruned).toBeGreaterThanOrEqual(1);

      const afterPrune = db.feedbackDrops.get(expiredDropId);
      expect(afterPrune).toBeNull();
    });
  });
});
