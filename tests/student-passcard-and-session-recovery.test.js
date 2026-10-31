import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { StudentProfile } from '../src/core/student-profile.js';
import {
  exportStudentSession,
  importStudentSession,
  attemptDecryptSessionEnvelope
} from '../src/modules/student/session-portability.js';
import { AccessCodes } from '../src/core/access-codes.js';

describe('Student Passcards, Multi-Recipient Session Recovery & Access Code History', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const tables = [
      'student_courses',
      'student_items',
      'student_ledger',
      'assignment_submissions',
      'task_submissions',
      'flashcards',
      'gradebook_students',
      'gradebook_courses'
    ];
    for (const t of tables) {
      try {
        await storage.table(t).clear();
      } catch (_) {}
    }
  });

  describe('Student Passcard Generation & Import', () => {
    it('creates a full student passcard and restores it cleanly on a new device', async () => {
      // 1. Seed initial student profile on Device A
      await StudentProfile.saveIdentity({
        studentId: 'STU-9901',
        fullName: 'Maya Lin',
        email: 'maya@school.edu',
        courseId: 'chem-101',
        courseName: 'AP Chemistry',
        accessCode: 'CHEM-4421'
      });
      await StudentProfile.saveIdentity({
        courseId: 'hist-202',
        courseName: 'World History',
        accessCode: 'HIST-8812'
      });

      // 2. Generate full passcard token
      const passcard = StudentProfile.createFullStudentPass();
      expect(passcard.kind).toBe('student_passcard');
      expect(passcard.student.student_id).toBe('STU-9901');
      expect(passcard.student.full_name).toBe('Maya Lin');
      expect(passcard.classes.length).toBe(2);

      // Verify normalized codes in passcard
      const chemClass = passcard.classes.find(c => c.course_id === 'chem-101');
      expect(chemClass).toBeDefined();
      expect(chemClass.access_code).toBe('CHEM4421');

      // 3. Clear localStorage on Device B (simulating a clean Chromebook)
      localStorage.clear();
      expect(StudentProfile.get().defaultIdentity.student_id).toBe('');

      // 4. Import passcard on Device B
      const restoredProfile = await StudentProfile.importFullStudentPass(passcard);
      expect(restoredProfile.defaultIdentity.student_id).toBe('STU-9901');
      expect(restoredProfile.defaultIdentity.full_name).toBe('Maya Lin');
      expect(Object.keys(restoredProfile.classes).length).toBe(2);

      const resolved = StudentProfile.resolveForPayload({ course_id: 'chem-101' });
      expect(resolved.access_code).toBe('CHEM-4421');
      expect(resolved.student_id).toBe('STU-9901');
    });
  });

  describe('Multi-Recipient Session Key Decoupling & Teacher Recovery Slots', () => {
    it('encrypts session with student PIN, and unlocks with student PIN OR class access code', async () => {
      // Setup student profile with enrolled class on student machine
      await StudentProfile.saveIdentity({
        studentId: 'STU-7700',
        fullName: 'Alex Mercer',
        courseId: 'bio-1',
        courseName: 'Biology 1',
        accessCode: 'BIO1-9988'
      });

      await storage.table('student_courses').add({
        id: 'bio-1',
        name: 'Biology 1'
      });
      await storage.table('student_items').add({
        id: 'lesson-1',
        course_id: 'bio-1',
        title: 'Cell Mitosis'
      });

      // Student exports their session using their memorable personal PIN/passphrase
      const studentPersonalPin = '789456';
      const exportResult = await exportStudentSession({
        studentId: 'STU-7700',
        passphrase: studentPersonalPin,
        format: 'encrypted',
        includeRecoverySlots: true
      });

      const envelope = exportResult.envelope;
      expect(envelope).toBeDefined();
      expect(envelope.kbsession).toBe(2);
      expect(envelope.format).toBe('encrypted');
      expect(Array.isArray(envelope.recovery_slots)).toBe(true);
      expect(envelope.recovery_slots.length).toBe(1);
      expect(envelope.recovery_slots[0].course_name).toBe('Biology 1');

      // Wipe local state to simulate moving to a completely new device
      localStorage.clear();
      await storage.table('student_courses').clear();
      await storage.table('student_items').clear();

      // Path A: Unlocking directly with the student's personal PIN
      const directDecrypted = await attemptDecryptSessionEnvelope(envelope, studentPersonalPin);
      expect(directDecrypted).toBeDefined();
      expect(directDecrypted.student_id).toBe('STU-7700');
      expect(directDecrypted.courses.length).toBe(1);

      // Path B: Student forgot their PIN! Unlock via Teacher's class access code fallback slot
      const recoveredByClassCode = await attemptDecryptSessionEnvelope(envelope, 'BIO1-9988');
      expect(recoveredByClassCode).toBeDefined();
      expect(recoveredByClassCode.student_id).toBe('STU-7700');
      expect(recoveredByClassCode.items.length).toBe(1);
      expect(recoveredByClassCode.items[0].title).toBe('Cell Mitosis');

      // Path C: Wrong code should fail
      const failedDecrypt = await attemptDecryptSessionEnvelope(envelope, 'WRONG-CODE-0000');
      expect(failedDecrypt).toBeNull();

      // Test end-to-end import using the class code fallback
      const importRes = await importStudentSession(JSON.stringify(envelope), 'BIO1-9988');
      expect(importRes.restoredCourses).toBe(1);
      expect(importRes.restoredItems).toBe(1);

      const restoredItem = await storage.table('student_items').get('lesson-1');
      expect(restoredItem.title).toBe('Cell Mitosis');
    });
  });

  describe('Access Code History & Rotation', () => {
    it('records retired access codes in previous_access_codes and allows custom restoration', async () => {
      const student = {
        id: 's-test-1',
        course_id: 'c-test',
        student_id: 'S500',
        full_name: 'Jordan Lee',
        access_code: 'CODE-1111'
      };
      await storage.table('gradebook_students').put(student);

      // Rotate code
      await AccessCodes.regenerate(student);
      expect(student.access_code).not.toBe('CODE-1111');
      expect(Array.isArray(student.previous_access_codes)).toBe(true);
      expect(student.previous_access_codes.length).toBe(1);
      expect(student.previous_access_codes[0].code).toBe('CODE-1111');

      // Set custom code
      const currentCodeBefore = student.access_code;
      await AccessCodes.setCustom(student, 'JORDAN99');
      expect(student.access_code).toBe('JORD-AN99');
      expect(student.previous_access_codes.length).toBe(2);
      expect(student.previous_access_codes[0].code).toBe(currentCodeBefore);

      // Restore past code
      await AccessCodes.setCustom(student, student.previous_access_codes[1].code);
      expect(student.access_code).toBe('CODE-1111');
      expect(student.previous_access_codes.length).toBe(3);
    });
  });
});
