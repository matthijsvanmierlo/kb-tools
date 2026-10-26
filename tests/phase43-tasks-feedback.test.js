// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { createBlankTask } from '../src/modules/tasks/index.js';
import { buildTaskFeedbackPayload, createTaskFeedbackLink } from '../src/modules/tasks/feedback-link.js';
import { renderTaskFeedbackView } from '../src/modules/tasks/feedback-view.js';
import { StudentLedger } from '../src/modules/student/ledger.js';
import { classifyText } from '../src/core/envelope-router.js';
import { createTaskSubmission } from '../src/modules/tasks/pipeline.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { store } from '../src/state/store.js';

describe('Phase 43: Tasks Student Feedback Return & Display', () => {
  let teacherKeys;

  beforeEach(async () => {
    store.setState('ephemeralData', null);
    await storage.init();
    for (const t of [
      'tasks',
      'task_submissions',
      'student_courses',
      'student_ledger',
      'student_items'
    ]) {
      const tbl = storage.table(t);
      if (tbl) await tbl.clear().catch(() => {});
    }
    teacherKeys = await SubmissionCrypto.generateKeyPair();
  });

  describe('1. Self-Contained Feedback Payload & Security', () => {
    it('produces feedback payload containing grades, rubric, code comments, but zero secret keys or roster material', () => {
      const task = createBlankTask();
      task.id = 'task-fb-sec';
      task.title = 'Algorithms Problem Set';
      task.publish = { salt: 'secret-salt', teacher_key: { privateJwk: teacherKeys.privateJwk } };

      const sub = {
        id: 'sub-sec-1',
        student_id: 'STU100',
        student_name: 'Grace Hopper',
        submitted_at: '2026-10-22T10:00:00Z',
        days_late: 0,
        content: {
          text: 'My analysis of binary search trees.',
          code_files: [
            { id: 'f1', filename: 'bst.py', language: 'python', body: 'class Node:\n    pass\n' }
          ]
        },
        review: {
          points: 98,
          status: 'submitted',
          rubric_eval: { correctness: 'tier-1' },
          rubric_comments: { correctness: 'All tests pass.' },
          standard_scores: { 'STD-CS-1': 4 },
          standard_comments: { 'STD-CS-1': 'Excellent complexity analysis' },
          code_comments: {
            f1: [{ line: 1, comment: 'Clean class structure' }]
          },
          feedback: 'Outstanding implementation!'
        }
      };

      const rubric = {
        id: 'rub-algo',
        title: 'Algo Rubric',
        tiers: [{ id: 'tier-1', label: 'Exemplary', default_points: 4 }],
        criteria: [{ id: 'correctness', name: 'Correctness' }]
      };

      const standards = [
        { id: 'STD-CS-1', code: 'CS.1', description: 'Data Structures' }
      ];

      const sbgLevels = [
        { value: 4, label: 'Mastery', color: '#10b981' }
      ];

      const payload = buildTaskFeedbackPayload({
        task,
        submission: sub,
        student: { student_id: 'STU100', full_name: 'Grace Hopper' },
        course: { id: 'c-cs101', name: 'CS 101' },
        rubric,
        standards,
        sbgLevels
      });

      expect(payload.kind).toBe('task_feedback');
      expect(payload.student.student_id).toBe('STU100');
      expect(payload.grade.points).toBe(98);
      expect(payload.grade.standards[0].level_label).toBe('Mastery');
      expect(payload.grade.standards[0].level_color).toBe('#10b981');
      expect(payload.code_files[0].comments[0].comment).toBe('Clean class structure');
      expect(payload.rubric.eval.correctness).toBe('tier-1');

      // Security checks: NO private keys, NO salts, NO other students
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('privateJwk');
      expect(serialized).not.toContain('secret-salt');
      expect(serialized).not.toContain('preview-salt');
    });

    it('renders completely standalone in empty database without throwing', async () => {
      const payload = {
        kind: 'task_feedback',
        task: { title: 'Poetry Essay', max_points: 50 },
        student: { full_name: 'Emily Dickinson', student_id: 'ED01' },
        course: { name: 'Literature 201' },
        grade: { points: 48, max_points: 50, status: 'submitted' },
        overall_feedback: 'Beautiful metaphor analysis.',
        text: 'Hope is the thing with feathers...',
        code_files: [],
        drawing: null,
        attachments: []
      };

      store.setState('ephemeralData', { type: 'task_feedback', payload });

      const container = document.createElement('div');
      await renderTaskFeedbackView({}, null, container);

      expect(container.innerHTML).toContain('Poetry Essay');
      expect(container.innerHTML).toContain('Literature 201');
      expect(container.innerHTML).toContain('Emily Dickinson');
      expect(container.innerHTML).toContain('Beautiful metaphor analysis');
      expect(container.innerHTML).toContain('48');
    });
  });

  describe('2. Student Ledger Ingestion & Deduplication Merge', () => {
    it('ingests task feedback into student ledger and merges revisions under [course_id+task_id]', async () => {
      const initialFeedback = {
        kind: 'task_feedback',
        task: { id: 'task-lab-9', title: 'Physics Pendulum Lab', max_points: 100 },
        course: { id: 'phys-1', name: 'AP Physics' },
        student: { student_id: 'STU42', full_name: 'Isaac Newton' },
        grade: { points: 85, max_points: 100, status: 'submitted' },
        overall_feedback: 'Check pendulum angle calculations.'
      };

      const res1 = await StudentLedger.ingestTaskFeedback(initialFeedback);
      expect(res1.item.score.earned).toBe(85);
      expect(res1.item.overall_feedback).toContain('Check pendulum angle calculations');

      // Check record in DB
      let ledger = await storage.table('student_ledger').toArray();
      expect(ledger).toHaveLength(1);
      expect(ledger[0].assignment_id).toBe('task-lab-9');
      expect(ledger[0].score.earned).toBe(85);

      // Teacher re-grades with updated score
      const revisedFeedback = {
        kind: 'task_feedback',
        task: { id: 'task-lab-9', title: 'Physics Pendulum Lab', max_points: 100 },
        course: { id: 'phys-1', name: 'AP Physics' },
        student: { student_id: 'STU42', full_name: 'Isaac Newton' },
        grade: { points: 95, max_points: 100, status: 'submitted' },
        overall_feedback: 'Updated calculations are correct!'
      };

      await StudentLedger.ingestTaskFeedback(revisedFeedback);

      // Should merge into the same row (no duplicate) and preserve revision history!
      ledger = await storage.table('student_ledger').toArray();
      expect(ledger).toHaveLength(1);
      expect(ledger[0].score.earned).toBe(95);
      expect(ledger[0].overall_feedback).toContain('Updated calculations are correct');
      expect(ledger[0].history).toHaveLength(1);
      expect(ledger[0].history[0].score.earned).toBe(85);
    });
  });

  describe('3. Inbox Classification & Task Pull', () => {
    it('classifies encrypted task envelopes by task_id', async () => {
      const taskPayload = {
        task_id: 'task-inbox-check',
        publish_version: 1,
        title: 'Midterm Coding Project',
        teacher_key: { publicJwk: teacherKeys.publicJwk, fingerprint: teacherKeys.fingerprint }
      };

      const { envelopeText } = await createTaskSubmission(
        taskPayload,
        { id: 'STU77', name: 'Alan Turing' },
        { text: 'Turing machine simulator' }
      );

      const classification = classifyText(envelopeText);
      expect(classification.kind).toBe('task');
      expect(classification.task_id).toBe('task-inbox-check');
    });
  });
});
