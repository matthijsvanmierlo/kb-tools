import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { storage } from '../src/core/storage.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { createBlankTask } from '../src/modules/tasks/index.js';
import {
  checkTaskAccessCode,
  createTaskSubmission,
  evaluateTaskSubmission
} from '../src/modules/tasks/pipeline.js';
import {
  buildStudentTaskPayload,
  estimateEnvelopeSize
} from '../src/modules/tasks/publish-core.js';
import { classifyText } from '../src/core/envelope-router.js';
import { BACKUP_TABLES } from '../src/core/backup.js';
import {
  TaskSchema,
  GradebookAssignmentSchema,
  GradebookGradeSchema,
  DrawDocSchema,
  normalizeSketchData
} from '../src/core/validator.js';
import { GradebookBridge, syncContentClassLink } from '../src/modules/gradebook/bridge.js';

describe('Phase 38: Task Module Core - Schema, Crypto Pipeline, and Registration', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await storage.init();
    await storage.table('tasks').clear().catch(() => {});
    await storage.table('task_submissions').clear().catch(() => {});
    await storage.table('gradebook_courses').clear().catch(() => {});
    await storage.table('gradebook_assignments').clear().catch(() => {});
    await storage.table('gradebook_grades').clear().catch(() => {});
  });

  describe('Dexie v7 & Storage Registration', () => {
    it('initializes db with version 7 and supports tasks and task_submissions tables', async () => {
      expect(storage.db.verno).toBeGreaterThanOrEqual(7);

      const task = createBlankTask();
      task.title = 'Essay on Photosynthesis';
      await storage.table('tasks').put(task);

      const retrieved = await storage.table('tasks').get(task.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved.title).toBe('Essay on Photosynthesis');

      const sub = {
        id: 'sub-1',
        task_id: task.id,
        student_id: 'STU101',
        submitted_at: new Date().toISOString(),
        synced_at: null,
        is_latest: true
      };
      await storage.table('task_submissions').put(sub);

      const retrievedSub = await storage.table('task_submissions').get('sub-1');
      expect(retrievedSub).not.toBeNull();
      expect(retrievedSub.student_id).toBe('STU101');
    });

    it('includes tasks and task_submissions in BACKUP_TABLES', () => {
      expect(BACKUP_TABLES).toContain('tasks');
      expect(BACKUP_TABLES).toContain('task_submissions');
    });
  });

  describe('Task Schema and Blank Task Record', () => {
    it('creates a blank task adhering to TaskSchema', () => {
      const blank = createBlankTask();
      const parsed = TaskSchema.safeParse(blank);
      expect(parsed.success).toBe(true);
      expect(blank.submission_types.text.enabled).toBe(true);
      expect(blank.grading.scoring).toBe('points');
      expect(blank.settings.allow_resubmit).toBe(true);
    });

    it('validates DrawDoc and normalizes legacy sketch data', () => {
      const legacy = {
        strokes: [
          { points: [[10, 20], [30, 40]], color: '#ff0000', size: 4 }
        ]
      };
      const normalized = normalizeSketchData(legacy);
      expect(normalized.version).toBe(2);
      expect(normalized.elements.length).toBe(1);
      expect(normalized.elements[0].type).toBe('stroke');

      const validated = DrawDocSchema.safeParse(normalized);
      expect(validated.success).toBe(true);
    });
  });

  describe('Refreshed Gradebook Schemas', () => {
    it('validates GradebookAssignmentSchema with scoring, standard_ids, rubric_id and source', () => {
      const col = {
        id: crypto.randomUUID(),
        course_id: crypto.randomUUID(),
        term_id: 'term-1',
        category_id: 'cat-1',
        title: 'Project Submission',
        due_date: '2026-11-01',
        max_score: 100,
        scoring: 'proficiency',
        standard_ids: ['std-1', 'std-2'],
        rubric_id: 'rub-1',
        source: { type: 'task', id: 'task-123' }
      };
      const parsed = GradebookAssignmentSchema.safeParse(col);
      expect(parsed.success).toBe(true);
    });

    it('validates GradebookGradeSchema with standard_scores, rubric_comments, feedback_link, and source_submission_id', () => {
      const grade = {
        course_id: crypto.randomUUID(),
        student_id: 'S101',
        assignment_id: 'asg-1',
        raw_score: 85,
        status: 'submitted',
        days_late: 0,
        rubric_eval: { crit1: 'tier2' },
        rubric_comments: { crit1: 'Great work on analysis' },
        standard_scores: { 'std-1': 'proficient' },
        standard_comments: { 'std-1': 'Mastered standard' },
        feedback: 'Overall good job',
        feedback_link: 'http://localhost/#/feedback?key=abc',
        source_submission_id: 'sub-xyz'
      };
      const parsed = GradebookGradeSchema.safeParse(grade);
      expect(parsed.success).toBe(true);
    });
  });

  describe('Task Publishing and Student Payload', () => {
    it('builds student task payload without leaking teacher private materials', async () => {
      const keys = await SubmissionCrypto.generateKeyPair();
      const task = createBlankTask();
      task.id = 'task-456';
      task.title = 'History Document Analysis';
      task.description = 'Analyze the attached sources and write your response.';
      task.submission_types.files.enabled = true; // should be stripped if CDN not enabled
      task.publish = {
        version: 1,
        salt: 'salt-123',
        published_at: new Date().toISOString(),
        cdn_student_upload: false
      };

      const payload = await buildStudentTaskPayload(task, {
        teacherKeys: keys,
        rosterChecks: { 'S101': 'chk101' }
      });

      expect(payload.kind).toBe('kb-task');
      expect(payload.task_id).toBe('task-456');
      expect(payload.title).toBe('History Document Analysis');
      expect(payload.submission_types.files.enabled).toBe(false); // gated
      expect(payload.teacher_key.publicJwk).toBeDefined();
      expect(payload.teacher_key.privateJwk).toBeUndefined(); // no private key
      expect(payload.roster_checks['S101']).toBe('chk101');
    });

    it('estimates envelope size deterministically', () => {
      const obj = { message: 'hello world', data: [1, 2, 3] };
      const size = estimateEnvelopeSize(obj);
      expect(size).toBeGreaterThan(JSON.stringify(obj).length);
    });
  });

  describe('Pipeline: Create, Check Access Code, Submit, and Evaluate', () => {
    it('completes the full student take → encrypt → teacher decrypt → evaluate cycle', async () => {
      const keys = await SubmissionCrypto.generateKeyPair();
      const task = createBlankTask();
      task.id = 'task-789';
      task.settings.due_date = '2026-10-25'; // submitted 2026-10-26 is 1 day late

      const studentId = 'STU99';
      const accessCode = 'ABCDEF12';
      const checkVal = await SubmissionCrypto.accessCodeCheck(task.id, studentId, accessCode);

      task.publish = {
        version: 1,
        salt: 'salt-xyz',
        published_at: new Date().toISOString()
      };

      const payload = await buildStudentTaskPayload(task, {
        teacherKeys: keys,
        rosterChecks: { [studentId]: checkVal }
      });

      // Verify access code check
      const codeCheck = await checkTaskAccessCode(payload, studentId, accessCode);
      expect(codeCheck).toBe('ok');

      const badCodeCheck = await checkTaskAccessCode(payload, studentId, 'WRONGCODE');
      expect(badCodeCheck).toBe('mismatch');

      // Student submits work
      const content = {
        text_md: '## My Response\nThis is my essay.',
        code: [{ id: 'code-1', filename: 'main.py', language: 'python', body: 'print("hello")', origin: 'editor' }],
        attachments: [],
        drawing: null
      };

      const submission = await createTaskSubmission({
        payload,
        studentId,
        studentName: 'Alice Smith',
        accessCode,
        content
      });

      expect(submission.text).toContain('KBSUB1.');

      // Teacher classifies the text
      const classified = classifyText(submission.text);
      expect(classified.kind).toBe('task');
      expect(classified.task_id).toBe(task.id);

      // Teacher evaluates submission
      const roster = [{ student_id: studentId, full_name: 'Alice Smith', access_code: accessCode }];
      const evaluated = await evaluateTaskSubmission({
        text: submission.text,
        teacherPrivateKey: keys.privateJwk,
        task,
        roster
      });

      expect(evaluated.task_id).toBe(task.id);
      expect(evaluated.student_id).toBe(studentId);
      expect(evaluated.student_name).toBe('Alice Smith');
      expect(evaluated.identity).toBe('verified');
      expect(evaluated.content.text_md).toBe('## My Response\nThis is my essay.');
      expect(evaluated.content.code[0].body).toBe('print("hello")');
      expect(evaluated.days_late).toBeGreaterThan(0);
      expect(evaluated.review.status).toBe('submitted');
      expect(evaluated.review.points).toBeNull();
    });
  });

  describe('GradebookBridge Task Integration', () => {
    it('syncContentClassLink creates gradebook column with task sourceType and grading options', async () => {
      const course = {
        id: 'course-gb-1',
        name: 'Physics 101',
        terms: [{ id: 'term-1', name: 'Fall' }],
        categories: [{ id: 'cat-1', name: 'Homework' }]
      };
      await storage.table('gradebook_courses').put(course);

      const task = createBlankTask();
      task.id = 'task-gb-sync';
      task.title = 'Lab Report 1';
      task.grading.max_points = 50;
      task.grading.scoring = 'points';
      task.grading.rubric_id = 'rubric-101';
      task.settings.due_date = '2026-11-15';

      await syncContentClassLink(task, 'tasks', course.id);

      expect(task.class_id).toBe(course.id);
      expect(task.gradebook.column_id).toBeDefined();

      const col = await storage.table('gradebook_assignments').get(task.gradebook.column_id);
      expect(col).not.toBeNull();
      expect(col.source.type).toBe('task');
      expect(col.source.id).toBe(task.id);
      expect(col.max_score).toBe(50);
      expect(col.rubric_id).toBe('rubric-101');
      expect(col.due_date).toBe('2026-11-15');

      // Unassigning removes the linked column
      await syncContentClassLink(task, 'tasks', null);
      const staleCol = await storage.table('gradebook_assignments').get(col.id);
      expect(staleCol).toBeUndefined();
    });
  });
});
