import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { storage } from '../src/core/storage.js';
import { buildStudentPayload } from '../src/modules/assignments/grading.js';
import { buildStudentVideoPayload } from '../src/modules/video/secure.js';
import { syncContentClassLink } from '../src/modules/gradebook/bridge.js';
import { StudentLedger } from '../src/modules/student/ledger.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';

describe('Unified Sharing, Class-Grading, and Formative Practice', () => {
  let teacherKeys;

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await storage.init();
    teacherKeys = await SubmissionCrypto.generateKeyPair();
    await storage.table('gradebook_courses').clear().catch(() => {});
    await storage.table('gradebook_assignments').clear().catch(() => {});
    await storage.table('assignments').clear().catch(() => {});
    await storage.table('video_assessments').clear().catch(() => {});
    await storage.table('student_courses').clear().catch(() => {});
    await storage.table('student_ledger').clear().catch(() => {});
  });

  describe('1. Formative Practice vs Graded Payload Construction', () => {
    const sampleQuestions = [
      {
        id: 'q1',
        type: 'single_choice',
        points: 2,
        options: [
          { id: 'opt1', text: 'Option 1', is_correct: true },
          { id: 'opt2', text: 'Option 2', is_correct: false }
        ]
      }
    ];

    it('builds assignment payload as Formative Practice when class_id / course_id is null', async () => {
      const assignment = {
        id: 'asg-practice',
        title: 'Formative Chemistry Quiz',
        class_id: null,
        gradebook: { course_id: null },
        publish: { salt: 'salt-practice-123', version: 1 },
        questions: sampleQuestions,
        settings: {
          feedback_mode: 'immediate'
        }
      };

      const payload = await buildStudentPayload(assignment, {
        teacherKeys,
        publishVersion: 1
      });

      expect(payload.mode).toBe('practice');
      expect(payload.course_id).toBeNull();
      expect(payload.settings.release_grade_immediately).toBe(true);
      expect(payload.questions.length).toBe(1);
    });

    it('builds assignment payload as Graded when class_id is set', async () => {
      const assignment = {
        id: 'asg-graded',
        title: 'Midterm Exam',
        class_id: 'class-bio-101',
        gradebook: { course_id: 'class-bio-101' },
        publish: { salt: 'salt-graded-123', version: 1 },
        questions: sampleQuestions,
        settings: {
          feedback_mode: 'immediate',
          release_grade_immediately: false
        }
      };

      const payload = await buildStudentPayload(assignment, {
        teacherKeys,
        publishVersion: 1
      });

      expect(payload.mode).toBe('graded');
      expect(payload.course_id).toBe('class-bio-101');
      expect(payload.settings.release_grade_immediately).toBe(false);
    });

    it('builds video payload as Formative Practice when class_id is null', async () => {
      const videoAssessment = {
        id: 'vid-practice',
        title: 'Photosynthesis Video Checkpoint',
        class_id: null,
        provider: 'html5',
        video_source: 'https://example.com/test.mp4',
        checkpoints: [
          {
            id: 'cp1',
            type: 'single_choice',
            timestamp_sec: 12,
            points: 1,
            options: [
              { id: 'o1', text: 'Chloroplasts', is_correct: true },
              { id: 'o2', text: 'Mitochondria', is_correct: false }
            ]
          }
        ]
      };

      const payload = await buildStudentVideoPayload(videoAssessment, {
        teacherKeys
      });

      expect(payload.mode).toBe('practice');
      expect(payload.class_id).toBeNull();
      expect(payload.settings.release_grade_immediately).toBe(true);
      expect(payload.checkpoints.length).toBe(1);
    });

    it('builds video payload as Graded when class_id is set', async () => {
      const videoAssessment = {
        id: 'vid-graded',
        title: 'Cell Biology Graded Checkpoint',
        class_id: 'class-bio-101',
        provider: 'youtube',
        video_source: 'https://youtube.com/watch?v=xyz',
        settings: {
          release_grade_immediately: false
        },
        checkpoints: [
          {
            id: 'cp1',
            type: 'single_choice',
            timestamp_sec: 12,
            points: 2,
            options: [{ id: 'o1', text: 'Yes', is_correct: true }]
          }
        ]
      };

      const payload = await buildStudentVideoPayload(videoAssessment, {
        teacherKeys
      });

      expect(payload.mode).toBe('graded');
      expect(payload.class_id).toBe('class-bio-101');
      expect(payload.settings.release_grade_immediately).toBe(false);
    });
  });

  describe('2. syncContentClassLink and Gradebook Bridge Synchronization', () => {
    it('synchronizes assignment to class and creates a linked gradebook column', async () => {
      // Create course
      const course = { id: 'course-chem', name: 'Chemistry Honors' };
      await storage.table('gradebook_courses').put(course);

      const assignment = {
        id: 'asg-atomic',
        title: 'Atomic Structure Quiz',
        class_id: null,
        gradebook: { course_id: null },
        questions: [
          { id: 'q1', type: 'single_choice', points: 5, options: [] },
          { id: 'q2', type: 'single_choice', points: 5, options: [] }
        ]
      };
      await storage.table('assignments').put(assignment);

      // Assign to course-chem
      const result = await syncContentClassLink(assignment, 'assignment', 'course-chem');
      expect(result.class_id).toBe('course-chem');
      expect(result.gradebook.course_id).toBe('course-chem');
      expect(result.gradebook.column_id).toBeTruthy();

      // Check Dexie
      const savedInDb = await storage.table('assignments').get('asg-atomic');
      expect(savedInDb.class_id).toBe('course-chem');
      expect(savedInDb.gradebook.course_id).toBe('course-chem');

      const linkedCols = await storage.table('gradebook_assignments')
        .where('course_id').equals('course-chem')
        .toArray();
      expect(linkedCols.length).toBe(1);
      expect(linkedCols[0].title).toBe('Atomic Structure Quiz');
      expect(linkedCols[0].max_score).toBe(10);
      expect(linkedCols[0].source).toEqual({ type: 'assignment', id: 'asg-atomic' });
    });

    it('synchronizes video assessment to class and creates linked gradebook column', async () => {
      const course = { id: 'course-physics', name: 'AP Physics' };
      await storage.table('gradebook_courses').put(course);

      const video = {
        id: 'vid-kinematics',
        title: 'Kinematics Lesson',
        class_id: null,
        provider: 'html5',
        video_source: 'test.mp4',
        checkpoints: [
          { id: 'cp1', type: 'single_choice', timestamp_sec: 10, points: 3, options: [] },
          { id: 'cp2', type: 'single_choice', timestamp_sec: 20, points: 2, options: [] }
        ]
      };
      await storage.table('video_assessments').put(video);

      const result = await syncContentClassLink(video, 'video', 'course-physics');
      expect(result.class_id).toBe('course-physics');

      const linkedCols = await storage.table('gradebook_assignments')
        .where('course_id').equals('course-physics')
        .toArray();
      expect(linkedCols.length).toBe(1);
      expect(linkedCols[0].title).toBe('Kinematics Lesson');
      expect(linkedCols[0].max_score).toBe(5);
      expect(linkedCols[0].source).toEqual({ type: 'video', id: 'vid-kinematics' });
    });

    it('unassigns class and cleans up stale Gradebook column linkage', async () => {
      const course = { id: 'course-math', name: 'Calculus' };
      await storage.table('gradebook_courses').put(course);

      const assignment = {
        id: 'asg-calc',
        title: 'Derivatives Quiz',
        class_id: 'course-math',
        gradebook: { course_id: 'course-math' },
        questions: [{ id: 'q1', type: 'single_choice', points: 10, options: [] }]
      };
      await storage.table('assignments').put(assignment);

      // First link
      await syncContentClassLink(assignment, 'assignment', 'course-math');
      let cols = await storage.table('gradebook_assignments').where('course_id').equals('course-math').toArray();
      expect(cols.length).toBe(1);

      // Now unassign
      const unassigned = await syncContentClassLink(assignment, 'assignment', null);
      expect(unassigned.class_id).toBeNull();
      expect(unassigned.gradebook.course_id).toBeNull();
      expect(unassigned.gradebook.column_id).toBeNull();

      cols = await storage.table('gradebook_assignments').where('course_id').equals('course-math').toArray();
      expect(cols.length).toBe(0);
    });
  });

  describe('3. StudentLedger Recording', () => {
    it('records self-study formative submissions without requiring a course_id', async () => {
      await StudentLedger.recordSubmission({
        assignmentId: 'asg-self-1',
        courseId: null,
        title: 'Self-Paced Practice',
        studentId: 'self_study',
        studentName: 'Learner',
        clientScore: { earned: 8, possible: 10, pending: 0 }
      });

      const courses = await storage.table('student_courses').toArray();
      expect(courses.some(c => c.course_id === 'self_study')).toBe(true);

      const items = await storage.table('student_ledger').toArray();
      expect(items.length).toBe(1);
      expect(items[0].assignment_id).toBe('asg-self-1');
      expect(items[0].score.earned).toBe(8);
      expect(items[0].score.possible).toBe(10);
    });

    it('records graded submissions with course and receipt metadata', async () => {
      await StudentLedger.recordSubmission({
        assignmentId: 'asg-graded-1',
        courseId: 'class-history',
        courseName: 'World History',
        title: 'Renaissance Exam',
        studentId: 'S105',
        studentName: 'Alex Rivera',
        clientScore: { earned: 95, possible: 100, pending: 0 },
        receiptId: 'receipt-12345.kbr'
      });

      const course = await storage.table('student_courses').get('class-history');
      expect(course).toBeTruthy();
      expect(course.course_name).toBe('World History');

      const items = await storage.table('student_ledger')
        .where('[course_id+assignment_id]')
        .equals(['class-history', 'asg-graded-1'])
        .toArray();
      expect(items.length).toBe(1);
      expect(items[0].student_name).toBe('Alex Rivera');
      expect(items[0].score.earned).toBe(95);
    });
  });
});
