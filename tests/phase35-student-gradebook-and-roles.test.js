import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { RoleMode } from '../src/state/role-mode.js';
import { StudentProfile } from '../src/core/student-profile.js';
import { StudentLedger } from '../src/modules/student/ledger.js';
import { storage } from '../src/core/storage.js';

describe('Phase 35: Student Gradebook, Ledger & Dual Role Architecture', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    RoleMode.set('teacher');
    await storage.init();
    await storage.table('student_courses').clear().catch(() => {});
    await storage.table('student_ledger').clear().catch(() => {});
  });

  describe('RoleMode', () => {
    it('defaults to teacher and toggles cleanly', () => {
      expect(RoleMode.get()).toBe('teacher');
      expect(document.body.dataset.roleMode).toBe('teacher');

      const next = RoleMode.toggle();
      expect(next).toBe('student');
      expect(RoleMode.get()).toBe('student');
      expect(document.body.dataset.roleMode).toBe('student');
      expect(document.body.dataset.mode).toBe('student');

      RoleMode.toggle();
      expect(RoleMode.get()).toBe('teacher');
      expect(document.body.dataset.roleMode).toBe('teacher');
      expect(document.body.dataset.mode).toBeUndefined();
    });

    it('persists chosen role in localStorage', () => {
      expect(RoleMode.hasChosen()).toBe(true);
      RoleMode.set('student');
      expect(localStorage.getItem('kb_role_mode_v1')).toBe('student');
    });
  });

  describe('StudentProfile Keychain', () => {
    it('saves default identity and class-specific access codes', async () => {
      await StudentProfile.saveIdentity({
        studentId: 'ST-007',
        fullName: 'James Bond',
        email: 'jbond@mi6.gov',
        accessCode: 'K7M2-QX9P',
        courseId: 'spy101',
        courseName: 'Espionage 101'
      });

      const profile = StudentProfile.get();
      expect(profile.defaultIdentity.student_id).toBe('ST-007');
      expect(profile.defaultIdentity.full_name).toBe('James Bond');

      const savedClass = profile.classes['spy101'];
      expect(savedClass).toBeTruthy();
      expect(savedClass.course_name).toBe('Espionage 101');
      expect(savedClass.access_code).toBe('K7M2QX9P');
    });

    it('resolves student identity automatically for incoming assignment payload', async () => {
      await StudentProfile.saveIdentity({
        studentId: 'ST-888',
        fullName: 'Doc Brown',
        accessCode: 'TIME-1985',
        courseId: 'phys202',
        courseName: 'Quantum Mechanics'
      });

      const payload = {
        assignment_id: 'flux-capacitor-quiz',
        course_id: 'phys202'
      };

      const resolved = StudentProfile.resolveForPayload(payload);
      expect(resolved.student_id).toBe('ST-888');
      expect(resolved.full_name).toBe('Doc Brown');
      expect(resolved.access_code).toBe('TIME-1985');
      expect(resolved.raw_code).toBe('TIME1985');
    });

    it('returns candidate access codes for zero-click link auto-unlock', async () => {
      await StudentProfile.saveIdentity({
        accessCode: 'CODE-AAAA',
        courseId: 'c1'
      });
      await StudentProfile.saveIdentity({
        accessCode: 'CODE-BBBB',
        courseId: 'c2'
      });

      const candidates = StudentProfile.candidateAccessCodes();
      expect(candidates).toContain('CODEAAAA');
      expect(candidates).toContain('CODEBBBB');
    });
  });

  describe('StudentLedger', () => {
    it('ingests assignment feedback and records course metrics', async () => {
      const feedbackPayload = {
        version: 1,
        kind: 'assignment_feedback',
        generated_at: new Date().toISOString(),
        student: { student_id: 'S101', full_name: 'Harry Potter' },
        course: { id: 'potions_1', name: 'Potions', section: 'Year 1' },
        assignment: { id: 'polyjuice_quiz', title: 'Polyjuice Quiz', total_points: 20 },
        score: { earned: 18, possible: 20, pending: 0 },
        overall_feedback: 'Well brewed.',
        questions: [
          { n: 1, prompt: 'Ingredient 1', student_answer: 'Boomslang skin', earned: 10, possible: 10, correct: true },
          { n: 2, prompt: 'Brewing time', student_answer: '1 month', earned: 8, possible: 10, correct: false }
        ]
      };

      const { course, item } = await StudentLedger.ingestAssignmentFeedback(feedbackPayload);
      expect(course.course_name).toBe('Potions');
      expect(item.title).toBe('Polyjuice Quiz');
      expect(item.score.earned).toBe(18);
      expect(item.questions.length).toBe(2);

      const courses = await StudentLedger.getStudentCourses();
      expect(courses.length).toBe(1);
      expect(courses[0].averagePercent).toBe(90);
      expect(courses[0].assignmentCount).toBe(1);

      const ledger = await StudentLedger.getCourseLedger(course.id);
      expect(ledger.length).toBe(1);
      expect(ledger[0].title).toBe('Polyjuice Quiz');
    });

    it('records local student submissions and updates ledger items', async () => {
      const sub = await StudentLedger.recordSubmission({
        assignmentId: 'asg-defense',
        courseId: 'dada_1',
        courseName: 'Defense Against Dark Arts',
        title: 'Boggart Essay',
        studentId: 'S101',
        studentName: 'Harry Potter',
        clientScore: { earned: 10, possible: 10, pending: 0 },
        receiptId: 'RCPT-1234'
      });

      expect(sub.item_type).toBe('submission');
      expect(sub.receipt_id).toBe('RCPT-1234');

      const all = await StudentLedger.getAllLedgerEntries();
      expect(all.length).toBe(1);
      expect(all[0].title).toBe('Boggart Essay');

      await StudentLedger.deleteLedgerItem(sub.id);
      const afterDelete = await StudentLedger.getAllLedgerEntries();
      expect(afterDelete.length).toBe(0);
    });
  });
});
