// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { createBlankTask } from '../src/modules/tasks/index.js';
import { renderTaskEditor } from '../src/modules/tasks/editor.js';
import { publishTask, computeRosterHash } from '../src/modules/tasks/publish.js';
import { buildStudentTaskPayload } from '../src/modules/tasks/publish-core.js';
import { syncContentClassLink } from '../src/modules/gradebook/bridge.js';
import { setDue, getDue } from '../src/core/due-dates.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';

describe('Phase 39: Tasks Teacher Authoring, Library, and Publish Pipeline', () => {

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await storage.init();
    for (const t of ['tasks', 'task_submissions', 'gradebook_courses', 'gradebook_students', 'gradebook_assignments', 'gradebook_rubrics', 'course_items']) {
      await storage.table(t).clear().catch(() => {});
    }
  });

  describe('1. Task Initialization & Blank Schema', () => {
    it('creates a blank task conforming to TaskSchema with sensible defaults', () => {
      const task = createBlankTask();

      expect(task.id).toBeTruthy();
      expect(task.version).toBe(1);
      expect(task.title).toBe('Untitled assignment');
      expect(task.submission_types.text.enabled).toBe(true);
      expect(task.submission_types.code.enabled).toBe(false);
      expect(task.submission_types.drawing.enabled).toBe(false);
      expect(task.submission_types.files.enabled).toBe(false);
      expect(task.grading.scoring).toBe('points');
      expect(task.grading.max_points).toBe(100);
      expect(task.settings.require_access_code).toBe(true);
      expect(task.settings.allow_resubmit).toBe(true);
      expect(task.publish).toBeNull();
    });
  });

  describe('2. Task Editor Mounting and Autosave', () => {
    it('mounts editor UI and updates storage on change', async () => {
      const task = createBlankTask();
      await storage.table('tasks').put(task);

      const container = document.createElement('div');
      document.body.appendChild(container);

      const mockRouter = { navigate: vi.fn() };
      await renderTaskEditor(task, mockRouter, container);

      const titleInput = container.querySelector('#task-title-input');
      expect(titleInput).toBeTruthy();

      // Change title
      titleInput.value = 'Essay on Photosynthesis';
      titleInput.dispatchEvent(new CustomEvent('sl-input', { bubbles: true }));

      // Wait 450ms for debounced autosave
      await new Promise(resolve => setTimeout(resolve, 450));

      const updated = await storage.table('tasks').get(task.id);
      expect(updated.title).toBe('Essay on Photosynthesis');

      container.remove();
    });
  });

  describe('3. Class Link & Gradebook Column Synchronization', () => {
    const courseId = 'course-bio-101';

    beforeEach(async () => {
      await storage.table('gradebook_courses').put({
        id: courseId,
        name: 'Biology 101',
        grading_scale: 'points'
      });
    });

    it('creates linked gradebook column when assigned to a course', async () => {
      const task = createBlankTask();
      task.title = 'Lab Report 1';
      task.grading.scoring = 'points';
      task.grading.max_points = 50;
      await storage.table('tasks').put(task);

      await syncContentClassLink(task, 'tasks', courseId);

      const columns = await storage.table('gradebook_assignments').where('course_id').equals(courseId).toArray();
      expect(columns.length).toBe(1);
      const col = columns[0];
      expect(col.title).toBe('Lab Report 1');
      expect(col.max_score).toBe(50);
      expect(col.scoring).toBe('points');
      expect(col.source?.type).toBe('task');
      expect(col.source?.id).toBe(task.id);

      // Verify task itself has column_id recorded
      const updatedTask = await storage.table('tasks').get(task.id);
      expect(updatedTask.gradebook?.column_id).toBe(col.id);
    });

    it('updates linked gradebook column scoring and rubric when modified', async () => {
      const task = createBlankTask();
      task.title = 'Project Presentation';
      task.grading.scoring = 'points';
      task.grading.max_points = 100;
      await storage.table('tasks').put(task);

      await syncContentClassLink(task, 'tasks', courseId);

      // Change scoring to proficiency and assign a rubric
      task.grading.scoring = 'proficiency';
      task.grading.rubric_id = 'rubric-stem-4scale';
      await syncContentClassLink(task, 'tasks', courseId);

      const columns = await storage.table('gradebook_assignments').where('course_id').equals(courseId).toArray();
      expect(columns.length).toBe(1);
      const col = columns[0];
      expect(col.scoring).toBe('proficiency');
      expect(col.rubric_id).toBe('rubric-stem-4scale');
    });

    it('deletes linked gradebook column when unlinked from course', async () => {
      const task = createBlankTask();
      await storage.table('tasks').put(task);
      await syncContentClassLink(task, 'tasks', courseId);

      let columns = await storage.table('gradebook_assignments').where('course_id').equals(courseId).toArray();
      expect(columns.length).toBe(1);

      // Unassign (targetCourseId = null)
      await syncContentClassLink(task, 'tasks', null);

      columns = await storage.table('gradebook_assignments').where('course_id').equals(courseId).toArray();
      expect(columns.length).toBe(0);

      const unassignedTask = await storage.table('tasks').get(task.id);
      expect(unassignedTask.gradebook?.column_id).toBeNull();
    });
  });

  describe('4. Due Dates Propagation', () => {
    it('propagates due date/time to tasks, linked gradebook column, and course_items', async () => {
      const courseId = 'course-lit-202';
      await storage.table('gradebook_courses').put({
        id: courseId,
        name: 'Literature 202',
        grading_scale: 'points'
      });

      const task = createBlankTask();
      task.class_id = courseId;
      await storage.table('tasks').put(task);

      // Create linked gradebook column
      await syncContentClassLink(task, 'tasks', courseId);

      // Create referencing course item
      const courseItemId = 'ci-task-1';
      await storage.table('course_items').put({
        id: courseItemId,
        course_id: courseId,
        ref_id: task.id,
        kind: 'task',
        title: task.title,
        due_date: null,
        due_time: null
      });

      // Set due date
      await setDue('task', task.id, { date: '2026-11-15', time: '23:59' });

      // 1. Task record updated
      const updatedTask = await storage.table('tasks').get(task.id);
      expect(updatedTask.due_date).toBe('2026-11-15');
      expect(updatedTask.due_time).toBe('23:59');

      // 2. getDue matches
      const due = await getDue('task', task.id);
      expect(due.date).toBe('2026-11-15');
      expect(due.time).toBe('23:59');

      // 3. Gradebook column updated
      const columns = await storage.table('gradebook_assignments').where('course_id').equals(courseId).toArray();
      expect(columns[0].due_date).toBe('2026-11-15');

      // 4. Course item updated
      const updatedCI = await storage.table('course_items').get(courseItemId);
      expect(updatedCI.due_date).toBe('2026-11-15');
      expect(updatedCI.due_time).toBe('23:59');
    });
  });

  describe('5. Publish Security and Zero-Leak Whitelist', () => {
    it('publishes task, bumps version, generates roster checks, and strips private materials', async () => {
      const teacherKeyPair = await SubmissionCrypto.generateKeyPair();
      const task = createBlankTask();
      task.title = 'Midterm Research Paper';
      task.description = 'Write a 1000-word essay on AI ethics.';
      task.submission_types.text.enabled = true;
      task.submission_types.code.enabled = true;
      task.submission_types.files.enabled = true; // Enabled by teacher
      task.settings.require_access_code = true;

      const roster = {
        course: { id: 'c1', name: 'Computer Ethics', section: 'Sec A' },
        withCode: [
          { student_id: 'S101', name: 'Alice Smith', access_code: 'code-alice-123' },
          { student_id: 'S102', name: 'Bob Jones', access_code: 'code-bob-456' }
        ]
      };

      // Mock CDN disabled scenario
      const publishedWithoutCdn = await publishTask(task, roster, {
        teacherKeys: teacherKeyPair,
        transport: {
          capabilities: {},
          baseUrl: 'http://localhost:3000'
        }
      });

      expect(publishedWithoutCdn.task.publish.version).toBe(1);
      expect(publishedWithoutCdn.task.publish.salt).toHaveLength(24);

      const payload = publishedWithoutCdn.payload;
      expect(payload.kind).toBe('kb-task');
      expect(payload.task_id).toBe(task.id);
      expect(payload.title).toBe(task.title);

      // Student payload must NEVER contain:
      // 1. Raw access codes
      const payloadString = JSON.stringify(payload);
      expect(payloadString).not.toContain('code-alice-123');
      expect(payloadString).not.toContain('code-bob-456');

      // 2. Private teacher cryptographic keys
      expect(payloadString).not.toContain('private');
      expect(payload.teacher_key?.publicJwk).toBeTruthy();
      expect(payload.teacher_key?.fingerprint).toBeTruthy();

      // 3. Files submission type must be force-disabled when CDN is off
      expect(payload.submission_types.files.enabled).toBe(false);

      // 4. Roster check hashes present for authorized student IDs
      expect(payload.roster_checks?.S101).toBeTruthy();
      expect(payload.roster_checks?.S102).toBeTruthy();
    });

    it('enables files in payload when CDN upload is configured', async () => {
      const teacherKeyPair = await SubmissionCrypto.generateKeyPair();
      const task = createBlankTask();
      task.publish = { salt: 'abcd1234ef567890abcd1234', version: 1 };
      task.submission_types.files = { enabled: true, max_files: 3, accept: ['.pdf'] };

      const relayWithCdn = {
        base_url: 'https://relay.myschool.edu',
        drop_id: 'drop-123',
        drop_secret: 'sec-456',
        media: { enabled: true, max_file_bytes: 25 * 1024 * 1024, max_files: 3, accept: ['.pdf'] }
      };

      const payload = await buildStudentTaskPayload(task, {
        teacherKeys: teacherKeyPair,
        relay: relayWithCdn
      });

      expect(payload.submission_types.files.enabled).toBe(true);
      expect(payload.relay.media.enabled).toBe(true);
    });
  });
});
