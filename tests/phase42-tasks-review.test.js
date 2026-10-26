// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { createBlankTask } from '../src/modules/tasks/index.js';
import {
  recordTaskSubmission,
  syncTaskSubmissionsToGradebook,
  importTaskSubmissions
} from '../src/modules/tasks/submissions.js';
import { createTaskSubmission } from '../src/modules/tasks/pipeline.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { renderCodeWithComments } from '../src/components/code-editor.js';
import { RubricScorer } from '../src/modules/gradebook/rubric-builder.js';
import { round1 } from '../src/modules/gradebook/grade-widgets.js';

describe('Phase 42: Tasks Teacher Review & Grading Platform', () => {
  let teacherKeys;

  beforeEach(async () => {
    await storage.init();
    for (const t of [
      'tasks',
      'task_submissions',
      'gradebook_courses',
      'gradebook_students',
      'gradebook_assignments',
      'gradebook_grades',
      'gradebook_rubrics'
    ]) {
      await storage.table(t).clear().catch(() => {});
    }
    teacherKeys = await SubmissionCrypto.generateKeyPair();
  });

  describe('1. Import Paste & File', () => {
    it('imports single or multiple pasted KBSUB1 envelopes and stores submissions', async () => {
      const task = createBlankTask();
      task.id = 'task-rev-1';
      task.title = 'Essay on Photosynthesis';
      await storage.table('tasks').put(task);

      const taskPayload = {
        task_id: task.id,
        publish_version: 1,
        title: task.title,
        teacher_key: { publicJwk: teacherKeys.publicJwk, fingerprint: teacherKeys.fingerprint }
      };

      const sub1 = await createTaskSubmission(
        taskPayload,
        { id: 'STU1', name: 'Alice' },
        { text: 'Light reactions take place in the thylakoid membranes.' }
      );

      const sub2 = await createTaskSubmission(
        taskPayload,
        { id: 'STU2', name: 'Bob' },
        { text: 'Calvin cycle occurs in the stroma.' }
      );

      const combinedText = `${sub1.envelopeText}\n${sub2.envelopeText}`;

      const res = await importTaskSubmissions({
        text: combinedText,
        task,
        teacherPrivateKey: teacherKeys.privateJwk,
        roster: [{ student_id: 'STU1', name: 'Alice' }, { student_id: 'STU2', name: 'Bob' }]
      });

      expect(res.imported).toBe(2);
      expect(res.failed).toBe(0);

      const inDb = await storage.table('task_submissions').where('task_id').equals(task.id).toArray();
      expect(inDb).toHaveLength(2);
      expect(inDb.map(s => s.student_id).sort()).toEqual(['STU1', 'STU2']);
    });
  });

  describe('2. Resubmission & is_latest State', () => {
    it('sets is_latest: false on older submissions when a student resubmits', async () => {
      const task = createBlankTask();
      task.id = 'task-rev-2';
      await storage.table('tasks').put(task);

      const subInitial = {
        id: 'sub-init-1',
        task_id: task.id,
        student_id: 'STU99',
        student_name: 'Carol',
        submitted_at: '2026-10-20T10:00:00Z',
        is_latest: true,
        content: { text: 'Draft 1' }
      };
      await recordTaskSubmission(subInitial);

      let saved = await storage.table('task_submissions').get('sub-init-1');
      expect(saved.is_latest).toBe(true);

      // Student resubmits
      const subUpdated = {
        id: 'sub-updated-2',
        task_id: task.id,
        student_id: 'STU99',
        student_name: 'Carol',
        submitted_at: '2026-10-21T10:00:00Z',
        is_latest: true,
        content: { text: 'Draft 2 with improvements' }
      };
      await recordTaskSubmission(subUpdated);

      const all = await storage.table('task_submissions').where('task_id').equals(task.id).toArray();
      expect(all).toHaveLength(2);

      const oldSub = all.find(s => s.id === 'sub-init-1');
      const newSub = all.find(s => s.id === 'sub-updated-2');

      expect(oldSub.is_latest).toBe(false);
      expect(newSub.is_latest).toBe(true);
    });

    it('marks submission with resubmitted_after_feedback if a previous submission had returned_at', async () => {
      const task = createBlankTask();
      task.id = 'task-rev-3';
      await storage.table('tasks').put(task);

      const firstSub = {
        id: 'sub-fb-1',
        task_id: task.id,
        student_id: 'STU55',
        student_name: 'David',
        submitted_at: '2026-10-18T10:00:00Z',
        returned_at: '2026-10-19T10:00:00Z', // Teacher already returned feedback
        is_latest: true
      };
      await storage.table('task_submissions').put(firstSub);

      const secondSub = {
        id: 'sub-fb-2',
        task_id: task.id,
        student_id: 'STU55',
        student_name: 'David',
        submitted_at: '2026-10-20T12:00:00Z',
        is_latest: true
      };
      await recordTaskSubmission(secondSub);

      const savedNew = await storage.table('task_submissions').get('sub-fb-2');
      expect(savedNew.resubmitted_after_feedback).toBe(true);
    });
  });

  describe('3. Code Comments CRUD & Safe XSS Escaping', () => {
    it('escapes hostile code and comments in renderCodeWithComments', () => {
      const hostileFile = {
        filename: 'malicious.js',
        language: 'javascript',
        body: 'const evil = "<script>alert(1)</script>";\nconsole.log(evil);'
      };

      const hostileComments = [
        { line: 1, comment: '<img src=x onerror=alert(2)> Good variable!' }
      ];

      const html = renderCodeWithComments(hostileFile, hostileComments);

      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img src=x onerror=alert(2)>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
      expect(html).toContain('Teacher');
    });
  });

  describe('4. Rubric Scaling & Proficiency Standard Scores', () => {
    it('calculates weighted rubric score scaled to max points', () => {
      const rubric = {
        id: 'rub-1',
        title: 'Project Rubric',
        tiers: [
          { id: 't1', label: 'Exemplary', default_points: 4 },
          { id: 't2', label: 'Proficient', default_points: 3 },
          { id: 't3', label: 'Developing', default_points: 2 }
        ],
        criteria: [
          { id: 'c1', name: 'Code Quality', weight: 2 }, // max 4*2 = 8
          { id: 'c2', name: 'Documentation', weight: 1 }  // max 4*1 = 4 -> total max = 12
        ]
      };

      // Student earned t2 on c1 (3*2 = 6), t1 on c2 (4*1 = 4) -> total earned = 10 / 12 (83.33%)
      const evalMap = { c1: 't2', c2: 't1' };
      const score = RubricScorer.calculateScore(rubric, evalMap);
      expect(score.totalEarned).toBe(10);
      expect(score.totalPossible).toBe(12);

      const maxPoints = 50;
      const scaled = round1((score.totalEarned / score.totalPossible) * maxPoints);
      // (10 / 12) * 50 = 41.666... -> 41.7
      expect(scaled).toBe(41.7);
    });
  });

  describe('5. Gradebook Synchronization with Extras', () => {
    it('only syncs submissions with reviewed_at set, creating one column and grade extras', async () => {
      // 1. Create linked course & students
      const course = {
        id: 'course-chem',
        name: 'Chemistry 101',
        terms: [{ id: 't1', name: 'Fall' }],
        categories: [{ id: 'cat-labs', name: 'Labs', weight: 30 }]
      };
      await storage.table('gradebook_courses').put(course);

      const student1 = { student_id: 'CHEM01', course_id: course.id, full_name: 'Eve Curie' };
      const student2 = { student_id: 'CHEM02', course_id: course.id, full_name: 'Leo Szilard' };
      await storage.table('gradebook_students').bulkPut([student1, student2]);

      // 2. Create task linked to this class
      const task = createBlankTask();
      task.id = 'task-chem-lab';
      task.title = 'Titration Lab Report';
      task.class_id = course.id;
      task.gradebook = { course_id: course.id, category_id: 'cat-labs' };
      task.grading = { scoring: 'points', max_points: 100, standard_ids: ['STD-SCI-1'] };
      await storage.table('tasks').put(task);

      // 3. Create two submissions: one reviewed, one unreviewed
      const subReviewed = {
        id: 'sub-chem-1',
        task_id: task.id,
        student_id: 'CHEM01',
        student_name: 'Eve Curie',
        is_latest: true,
        days_late: 0,
        content: { text: 'Titration data complete.' },
        review: {
          points: 95,
          status: 'submitted',
          rubric_eval: { accuracy: 'tier-1' },
          rubric_comments: { accuracy: 'Very accurate' },
          standard_scores: { 'STD-SCI-1': 4 },
          standard_comments: { 'STD-SCI-1': 'Mastered technique' },
          feedback: 'Excellent laboratory report!',
          reviewed_at: '2026-10-22T14:00:00Z'
        }
      };

      const subUnreviewed = {
        id: 'sub-chem-2',
        task_id: task.id,
        student_id: 'CHEM02',
        student_name: 'Leo Szilard',
        is_latest: true,
        days_late: 1,
        content: { text: 'Draft calculations.' },
        review: {
          points: null,
          status: 'submitted',
          reviewed_at: null // Not reviewed yet!
        }
      };

      await storage.table('task_submissions').bulkPut([subReviewed, subUnreviewed]);

      // 4. Run sync
      const res = await syncTaskSubmissionsToGradebook({
        task,
        submissions: [subReviewed, subUnreviewed],
        course,
        roster: [student1, student2]
      });

      expect(res.synced).toBe(1); // Only subReviewed was synced!

      // 5. Verify linked column was created in gradebook_assignments
      const columns = await storage.table('gradebook_assignments').where('course_id').equals(course.id).toArray();
      expect(columns).toHaveLength(1);
      expect(columns[0].title).toBe('Titration Lab Report');
      expect(columns[0].source).toEqual({ type: 'task', id: task.id });

      // 6. Verify grade record with populated extras in gradebook_grades
      const grade = await storage.table('gradebook_grades').get(['CHEM01', columns[0].id]);
      expect(grade).toBeTruthy();
      expect(grade.raw_score).toBe(95);
      expect(grade.feedback).toBe('Excellent laboratory report!');
      expect(grade.rubric_eval).toEqual({ accuracy: 'tier-1' });
      expect(grade.rubric_comments).toEqual({ accuracy: 'Very accurate' });
      expect(grade.standard_scores).toEqual({ 'STD-SCI-1': 4 });
      expect(grade.standard_comments).toEqual({ 'STD-SCI-1': 'Mastered technique' });
      expect(grade.source_submission_id).toBe('sub-chem-1');

      // Unreviewed student should not have a grade record
      const unreviewedGrade = await storage.table('gradebook_grades').get(['CHEM02', columns[0].id]);
      expect(unreviewedGrade).toBeUndefined();
    });
  });
});
