import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { exportStudentSession, importStudentSession, wipeStudentKioskSession } from '../src/modules/student/session-portability.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { DraftHistoryTracker, MAX_RING_BUFFER_SLOTS } from '../src/core/draft-history.js';
import { StudentProfile } from '../src/core/student-profile.js';

describe('Phase 2: Session Keystores, Submission Proofs, and Draft History', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    // Clear test tables
    const tables = [
      'student_courses',
      'student_items',
      'student_ledger',
      'assignment_submissions',
      'task_submissions',
      'flashcards',
      'draft_history',
      'outbox'
    ];
    for (const t of tables) {
      try {
        await storage.table(t).clear();
      } catch (_) {}
    }
  });

  describe('Initiative #2: Encrypted Session Keystores & Kiosk Wipe', () => {
    it('encrypts and exports student session, and decrypts with passphrase', async () => {
      // Seed student data
      await storage.table('student_courses').add({
        id: 'course-101',
        title: 'Physics 101',
        teacher_name: 'Dr. Jane'
      });
      await storage.table('student_ledger').add({
        id: 'ledger-1',
        student_id: 'STUDENT_A',
        assignment_id: 'asg-1',
        score: 95
      });
      await storage.table('assignment_submissions').add({
        id: 'sub-1',
        assignment_id: 'asg-1',
        student_id: 'STUDENT_A',
        score: 95
      });
      await storage.table('task_submissions').add({
        id: 'tsub-1',
        task_id: 'task-1',
        student_id: 'STUDENT_A',
        review: { points: 100 }
      });

      const passphrase = 'MySuperSecretPassword123!';
      const exportResult = await exportStudentSession({
        studentId: 'STUDENT_A',
        passphrase,
        format: 'encrypted'
      });

      expect(exportResult).toBeDefined();
      expect(exportResult.envelope).toBeDefined();
      expect(exportResult.envelope.kbsession).toBe(2);
      expect(exportResult.envelope.format).toBe('encrypted');
      expect(typeof exportResult.envelope.d).toBe('string');
      expect(exportResult.filename).toContain('.kbsession.enc');

      // Clear the tables to simulate a clean device or session restore
      await storage.table('student_courses').clear();
      await storage.table('student_ledger').clear();
      await storage.table('assignment_submissions').clear();
      await storage.table('task_submissions').clear();

      // Test decrypting with invalid password fails
      await expect(
        importStudentSession(JSON.stringify(exportResult.envelope), 'WrongPassword!')
      ).rejects.toThrow();

      // Test decrypting with correct password restores data
      const importResult = await importStudentSession(
        JSON.stringify(exportResult.envelope),
        passphrase
      );

      expect(importResult.restoredCourses).toBe(1);
      expect(importResult.restoredLedger).toBe(1);
      expect(importResult.restoredSubmissions).toBe(1);
      expect(importResult.restoredTasks).toBe(1);

      const restoredCourse = await storage.table('student_courses').get('course-101');
      expect(restoredCourse).toBeDefined();
      expect(restoredCourse.title).toBe('Physics 101');

      const restoredSub = await storage.table('task_submissions').get('tsub-1');
      expect(restoredSub).toBeDefined();
      expect(restoredSub.review.points).toBe(100);
    });

    it('safely wipes kiosk device on departure', async () => {
      // Seed data and localStorage
      await storage.table('student_courses').add({ id: 'c1', title: 'Biology' });
      await storage.table('student_ledger').add({ id: 'l1', score: 88 });
      localStorage.setItem('kb_student_profile_v1', JSON.stringify({ name: 'Alice' }));
      localStorage.setItem('kb_active_class_filter', 'c1');

      const wiped = await wipeStudentKioskSession({ verifySaved: false });
      expect(wiped).toBe(true);

      const courses = await storage.table('student_courses').toArray();
      const ledger = await storage.table('student_ledger').toArray();
      expect(courses.length).toBe(0);
      expect(ledger.length).toBe(0);
      expect(localStorage.getItem('kb_student_profile_v1')).toBeNull();
      expect(localStorage.getItem('kb_active_class_filter')).toBeNull();
    });
  });

  describe('Initiative #6: Cryptographic Submission Proofs & Verifiable Audit Log', () => {
    it('creates SHA-256 Merkle receipt tokens and verifies immutability', async () => {
      const envelopeText = JSON.stringify({
        kbsub: 2,
        student_id: 'STUDENT_B',
        assignment_id: 'asg-algebra',
        ciphertext: 'FAKE_AES_CIPHERTEXT_1234567890'
      });
      const studentAccessCode = 'KB-CODE-9876';

      const receipt = await SubmissionCrypto.createSubmissionReceipt({
        envelopeText,
        studentAccessCode,
        dropId: 'drop-chem-1',
        assignmentId: 'asg-algebra',
        studentId: 'STUDENT_B',
        relayReceipt: {
          ciphertext_sha256: receipt => receipt?.ciphertext_sha256,
          relay_receipt_sig: 'sig-abc-123'
        }
      });

      expect(receipt.receipt_id).toBeDefined();
      expect(receipt.ciphertext_sha256).toBeDefined();
      expect(receipt.token).toMatch(/^KBR1\./);

      // Verify legitimate token
      const verifySuccess = await SubmissionCrypto.verifySubmissionReceipt({
        receiptOrToken: receipt.token,
        envelopeText,
        studentAccessCode
      });

      expect(verifySuccess.valid).toBe(true);
      expect(verifySuccess.matchesCiphertext).toBe(true);
      expect(verifySuccess.studentSignatureValid).toBe(true);
      expect(verifySuccess.studentId).toBe('STUDENT_B');

      // Tamper test: modify 1 byte of envelope text
      const tamperedEnvelopeText = envelopeText.replace('FAKE_AES', 'TAMPERED_');
      const verifyTampered = await SubmissionCrypto.verifySubmissionReceipt({
        receiptOrToken: receipt.token,
        envelopeText: tamperedEnvelopeText,
        studentAccessCode
      });

      expect(verifyTampered.valid).toBe(false);
      expect(verifyTampered.matchesCiphertext).toBe(false);

      // Impersonation test: verify with different student access code
      const verifyImpersonated = await SubmissionCrypto.verifySubmissionReceipt({
        receiptOrToken: receipt.token,
        envelopeText,
        studentAccessCode: 'WRONG-CODE-5555'
      });

      expect(verifyImpersonated.valid).toBe(false);
      expect(verifyImpersonated.studentSignatureValid).toBe(false);
    });
  });

  describe('Initiative #10: Non-Invasive Draft History & Ring Buffer', () => {
    it('records draft checkpoints and enforces 60-slot ring buffer', async () => {
      const itemId = 'task-geo-101';
      const studentId = 'STU-101';

      // Insert 65 checkpoints using force=true to bypass 8-second throttle
      for (let i = 1; i <= 65; i++) {
        await DraftHistoryTracker.recordCheckpoint({
          itemId,
          studentId,
          content: { text: `Revision draft version ${i}` },
          isPaste: i % 10 === 0,
          pasteLength: i % 10 === 0 ? 150 : 0,
          force: true
        });
      }

      const checkpoints = await DraftHistoryTracker.getCheckpoints(itemId, studentId);
      // Ring buffer must enforce MAX_RING_BUFFER_SLOTS (60)
      expect(checkpoints.length).toBe(MAX_RING_BUFFER_SLOTS);

      // Ensure oldest entries (1 to 5) were dropped, and entry 65 is present
      const latest = checkpoints[checkpoints.length - 1];
      expect(latest.content.text).toBe('Revision draft version 65');

      const earliest = checkpoints[0];
      expect(earliest.content.text).toBe('Revision draft version 6');
    });

    it('computes non-invasive process telemetry accurately', async () => {
      const itemId = 'task-chem-202';
      const studentId = 'STU-202';

      await DraftHistoryTracker.recordCheckpoint({
        itemId,
        studentId,
        content: { text: 'Initial paragraph written by student.' },
        force: true
      });

      await DraftHistoryTracker.recordCheckpoint({
        itemId,
        studentId,
        content: { text: 'Initial paragraph written by student. Additional pasted citation.' },
        isPaste: true,
        pasteLength: 250,
        force: true
      });

      const telemetry = await DraftHistoryTracker.getProcessTelemetry(itemId, studentId);
      expect(telemetry.has_telemetry).toBe(true);
      expect(telemetry.checkpoint_count).toBe(2);
      expect(telemetry.paste_count).toBe(1);
      expect(telemetry.largest_paste).toBe(250);
      expect(telemetry.active_minutes).toBeGreaterThanOrEqual(1);
      expect(telemetry.evolution_curve.length).toBeGreaterThanOrEqual(1);
    });

    it('guarantees zero writes to outbox table (no sync replication flood)', async () => {
      const itemId = 'task-bio-303';
      const studentId = 'STU-303';

      await DraftHistoryTracker.recordCheckpoint({
        itemId,
        studentId,
        content: { text: 'Draft 1' },
        force: true
      });
      await DraftHistoryTracker.recordCheckpoint({
        itemId,
        studentId,
        content: { text: 'Draft 2' },
        force: true
      });

      const outboxEntries = await storage.table('outbox').toArray();
      expect(outboxEntries.length).toBe(0);
    });
  });
});
