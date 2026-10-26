// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { createBlankTask } from '../src/modules/tasks/index.js';
import { resolvePayload, estimatePlaintextSize, renderTaskTake } from '../src/modules/tasks/take.js';
import { buildStudentTaskPayload } from '../src/modules/tasks/publish-core.js';
import { createTaskSubmission } from '../src/modules/tasks/pipeline.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { StudentLedger } from '../src/modules/student/ledger.js';

describe('Phase 40: Tasks Student Take & Submit Flow', () => {
  let teacherKeys;

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await storage.init();
    for (const t of ['tasks', 'task_submissions', 'student_items', 'student_ledger', 'student_courses']) {
      await storage.table(t).clear().catch(() => {});
    }
    teacherKeys = await SubmissionCrypto.generateKeyPair();
  });

  describe('1. Payload Resolution', () => {
    it('resolves task payload in preview mode from teacher tasks table', async () => {
      const task = createBlankTask();
      task.title = 'Preview Biology Quiz';
      await storage.table('tasks').put(task);

      const resolved = await resolvePayload({ preview: task.id });
      expect(resolved).toBeTruthy();
      expect(resolved.preview).toBe(true);
      expect(resolved.payload.title).toBe('Preview Biology Quiz');
      expect(resolved.payload.kind).toBe('kb-task');
    });

    it('resolves task payload from student_items table by itemId', async () => {
      const payload = {
        kind: 'kb-task',
        v: 1,
        task_id: 'task-test-456',
        publish_version: 1,
        title: 'History Essay',
        submission_types: { text: { enabled: true } },
        teacher_key: { publicJwk: teacherKeys.publicJwk, fingerprint: teacherKeys.fingerprint },
        salt: 'saltsaltsalt'
      };

      await storage.table('student_items').put({
        id: 'c1_task-test-456',
        course_id: 'c1',
        item_id: 'task-test-456',
        kind: 'task',
        title: 'History Essay',
        payload
      });

      const resolved = await resolvePayload({ itemId: 'task-test-456' });
      expect(resolved).toBeTruthy();
      expect(resolved.preview).toBe(false);
      expect(resolved.payload.title).toBe('History Essay');
    });
  });

  describe('2. Plaintext Envelope Size Meter', () => {
    it('calculates unencrypted plaintext bytes across enabled response types', () => {
      const content = {
        text: 'Hello World', // 11 bytes
        code_files: [
          { filename: 'main.py', body: 'print("hi")' } // 7 + 11 = 18 bytes
        ],
        drawing: { version: 2, elements: [] }, // ~32 bytes
        attachments: [
          { id: '1', name: 'photo.jpg', ref: 'kb-cdn+aes://example.com' } // ~65 bytes
        ]
      };

      const bytes = estimatePlaintextSize(content);
      expect(bytes).toBeGreaterThan(100);
      expect(bytes).toBeLessThan(200);
    });
  });

  describe('3. Student Take, Submit, and ECIES Decryption Round Trip', () => {
    it('encrypts submission end-to-end and teacher key recovers original content', async () => {
      const task = createBlankTask();
      task.title = 'CS101 Lab 3';
      task.publish = { version: 1, salt: 'saltsaltsalt123' };
      task.submission_types.text.enabled = true;
      task.submission_types.code.enabled = true;

      const payload = await buildStudentTaskPayload(task, {
        teacherKeys,
        relay: { base_url: 'http://localhost:3000', drop_id: 'drop-lab3', drop_secret: 'sec' }
      });

      const student = { id: 'STU007', name: 'James Bond' };
      const content = {
        text: 'Completed exercise 1 and 2.',
        code_files: [
          { id: 'f1', filename: 'solution.py', language: 'python', body: 'def solve(): return 42' }
        ],
        drawing: null,
        attachments: []
      };

      // Student client creates encrypted submission
      const { submission, envelopeText } = await createTaskSubmission(payload, student, content);

      expect(envelopeText).toMatch(/^KBSUB1\./);
      expect(envelopeText).not.toContain('James Bond');
      expect(envelopeText).not.toContain('def solve(): return 42');

      // Teacher decrypts using teacher private key
      const envelope = SubmissionCrypto.parseEnvelope(envelopeText);
      const decrypted = await SubmissionCrypto.decryptFromStudent(teacherKeys.privateJwk, envelope);
      expect(decrypted).toBeTruthy();
      expect(decrypted.body.student_id).toBe('STU007');
      expect(decrypted.body.student_name).toBe('James Bond');
      expect(decrypted.body.content.text).toBe('Completed exercise 1 and 2.');
      expect(decrypted.body.content.code_files[0].body).toBe('def solve(): return 42');
    });
  });

  describe('4. Student Ledger Integration', () => {
    it('records task submission in student ledger and creates ledger row', async () => {
      await StudentLedger.recordSubmission({
        assignmentId: 'task-chem-1',
        courseId: 'chem-101',
        courseName: 'Chemistry',
        title: 'Lab 1 Reaction Kinetics',
        studentId: 'S555',
        studentName: 'Marie Curie',
        receiptId: 'REC-CHEM-999',
        submissionText: 'KBSUB1.test',
        submittedAt: '2026-10-26T12:00:00Z'
      });

      const rows = await storage.table('student_ledger').toArray();
      expect(rows.length).toBe(1);
      expect(rows[0].assignment_id).toBe('task-chem-1');
      expect(rows[0].title).toBe('Lab 1 Reaction Kinetics');
      expect(rows[0].student_name).toBe('Marie Curie');
      expect(rows[0].receipt_id).toBe('REC-CHEM-999');
    });
  });
});
