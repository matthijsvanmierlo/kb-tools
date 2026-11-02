import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { storage } from '../src/core/storage.js';
import { toast, Toast } from '../src/utils/toast.js';
import { publishAssignment, openPublishDialog } from '../src/modules/assignments/publish.js';
import { publishTask, openTaskPublishDialog } from '../src/modules/tasks/publish.js';
import { renderEditor } from '../src/modules/assignments/editor.js';
import { renderTaskEditor } from '../src/modules/tasks/editor.js';
import { ensureSampleAssignment } from '../src/modules/assignments/seed.js';
import { buildCourseFeed } from '../src/core/course-feed.js';
import { renderCoursePage } from '../src/modules/course/render.js';
import '../src/boot/shoelace-setup.js';

describe('Phase 45: Publish Integrity & R0 Hotfixes', () => {
  beforeEach(async () => {
    document.body.innerHTML = '';
    // Clear storage tables
    const tableNames = [
      'assignments', 'tasks', 'gradebook_courses', 'gradebook_students',
      'gradebook_assignments', 'gradebook_grades', 'course_items', 'course_units',
      'app_metadata'
    ];
    for (const t of tableNames) {
      await storage.table(t).clear().catch(() => {});
    }
  });

  describe('R0.1: Toast Method Integrity', () => {
    it('defines toast.error and all toast methods invoked in src/', () => {
      expect(typeof toast.error).toBe('function');
      expect(typeof Toast.error).toBe('function');

      const srcDir = path.join(process.cwd(), 'src');
      const files = [];

      function collectFiles(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) collectFiles(full);
          else if (entry.name.endsWith('.js')) files.push(full);
        }
      }
      collectFiles(srcDir);

      const toastCallRegex = /toast\.([a-zA-Z0-9_]+)\s*\(/g;
      const calledMethods = new Set();

      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        let match;
        while ((match = toastCallRegex.exec(content)) !== null) {
          calledMethods.add(match[1]);
        }
      }

      for (const method of calledMethods) {
        expect(typeof Toast[method], `Toast should define method: ${method}`).toBe('function');
      }
    });
  });

  describe('R1.1 & R1.4: Task Publish followed by Editor Save preserves Drop Box', () => {
    it('retains publish.relay.drop_id when editor saves after publish', async () => {
      const task = {
        id: 'task-test-1',
        title: 'Essay Assignment',
        submission_types: { text: { enabled: true } },
        grading: { max_points: 100 },
        created_at: new Date().toISOString()
      };
      await storage.table('tasks').put(task);

      const mockTransport = {
        baseUrl: 'https://relay.test',
        capabilities: { collectSubmissions: true },
        createDrop: vi.fn().mockResolvedValue({ dropId: 'drop-task-123', dropSecret: 'secret-xyz' })
      };

      const published = await publishTask(task, null, { transport: mockTransport });
      expect(published.task.publish.relay.drop_id).toBe('drop-task-123');

      // Now simulate task editor being open with older local object without publish
      const container = document.createElement('div');
      document.body.appendChild(container);
      const staleTaskCopy = { ...task }; // local copy without publish

      await renderTaskEditor(staleTaskCopy, { navigate: vi.fn() }, container);

      // Simulate a title input / auto-save in editor
      const titleInput = container.querySelector('#task-title-input');
      titleInput.value = 'Essay Assignment Updated Title';
      titleInput.dispatchEvent(new Event('sl-input', { bubbles: true }));

      // Wait for debounce save
      await new Promise(r => setTimeout(r, 600));

      const savedTask = await storage.table('tasks').get('task-test-1');
      expect(savedTask.title).toBe('Essay Assignment Updated Title');
      expect(savedTask.publish?.relay?.drop_id).toBe('drop-task-123');
    });
  });

  describe('R1.3: Assessment Dialog Opening & Stable Drop Boxes', () => {
    it('leaves publish.version and drop_id unchanged when opened multiple times', async () => {
      const asg = {
        id: 'asg-test-1',
        title: 'Quiz 1',
        questions: [
          { id: 'q1', type: 'single_choice', points: 1, prompt: '2+2?', options: [{ id: 'o1', text: '4', is_correct: true }] }
        ],
        created_at: new Date().toISOString()
      };
      await storage.table('assignments').put(asg);

      const mockTransport = {
        baseUrl: 'https://relay.test',
        capabilities: { collectSubmissions: true },
        createDrop: vi.fn().mockResolvedValue({ dropId: 'drop-asg-999', dropSecret: 'secret-asg-999' })
      };

      const pubResult = await publishAssignment(asg, null, { transport: mockTransport });
      const version1 = pubResult.assignment.publish.version;
      const dropId1 = pubResult.assignment.publish.relay.drop_id;
      expect(dropId1).toBe('drop-asg-999');

      // Open the publish dialog once
      await openPublishDialog(pubResult.assignment);
      let dialog = document.getElementById('kb-assignment-publish-dialog');
      expect(dialog).toBeTruthy();

      let currentAsg = await storage.table('assignments').get('asg-test-1');
      expect(currentAsg.publish.version).toBe(version1);
      expect(currentAsg.publish.relay.drop_id).toBe(dropId1);

      // Close and open dialog second time
      dialog.remove();
      await openPublishDialog(currentAsg);
      currentAsg = await storage.table('assignments').get('asg-test-1');
      expect(currentAsg.publish.version).toBe(version1);
      expect(currentAsg.publish.relay.drop_id).toBe(dropId1);
    });

    it('keeps drop_id when republishing with new content if drop box is still valid', async () => {
      const asg = {
        id: 'asg-test-2',
        title: 'Math Quiz',
        questions: [
          { id: 'q1', type: 'single_choice', points: 1, prompt: '2+2?', options: [{ id: 'o1', text: '4', is_correct: true }] }
        ],
        created_at: new Date().toISOString()
      };
      await storage.table('assignments').put(asg);

      let dropCounter = 1;
      const mockTransport = {
        baseUrl: 'https://relay.test',
        capabilities: { collectSubmissions: true },
        createDrop: vi.fn().mockImplementation(async () => ({
          dropId: `drop-asg-${dropCounter++}`,
          dropSecret: 'sec'
        }))
      };

      const res1 = await publishAssignment(asg, null, { transport: mockTransport });
      expect(res1.assignment.publish.version).toBe(1);
      expect(res1.assignment.publish.relay.drop_id).toBe('drop-asg-1');

      // Change content (question prompt)
      res1.assignment.questions[0].prompt = 'What is 3+3?';
      const res2 = await publishAssignment(res1.assignment, null, { transport: mockTransport });

      // Version should bump because content changed, but drop box is retained!
      expect(res2.assignment.publish.version).toBe(2);
      expect(res2.assignment.publish.relay.drop_id).toBe('drop-asg-1');
      expect(mockTransport.createDrop).toHaveBeenCalledTimes(1);
    });
  });

  describe('R1.2 & R1.5: Course Page Publish Preserves Relay and Validates Items', () => {
    it('preserves publish.relay when publishing from the Course page', async () => {
      const course = { id: 'c1', name: 'Science 101', access_code: 'SCI101' };
      await storage.table('gradebook_courses').put(course);

      const asg = {
        id: 'asg-c1',
        title: 'Bio Quiz',
        class_id: 'c1',
        questions: [
          { id: 'q1', type: 'single_choice', points: 1, prompt: 'Mitochondria?', options: [{ id: 'o1', text: 'Powerhouse', is_correct: true }] }
        ],
        publish: {
          version: 1,
          salt: 'salt-bio-1',
          published_at: new Date().toISOString(),
          relay: { drop_id: 'drop-bio-c1', base_url: 'https://relay.test', drop_secret: 'sec' },
          content_hash: 'chash-1'
        }
      };
      await storage.table('assignments').put(asg);

      const courseItem = {
        id: 'ci-asg-1',
        course_id: 'c1',
        kind: 'assignment',
        source_id: 'asg-c1',
        title: 'Bio Quiz',
        published: false,
        hidden: false
      };
      await storage.table('course_items').put(courseItem);

      const container = document.createElement('div');
      document.body.appendChild(container);
      await renderCoursePage('c1', container);

      // Click Publish all drafts
      const pubAllBtn = container.querySelector('#btn-publish-all-drafts');
      expect(pubAllBtn).toBeTruthy();
      pubAllBtn.click();

      await new Promise(r => setTimeout(r, 200));

      const storedAsg = await storage.table('assignments').get('asg-c1');
      expect(storedAsg.publish.relay).toBeTruthy();
      expect(storedAsg.publish.relay.drop_id).toBe('drop-bio-c1');
    });
  });

  describe('R1.4 & R1.6: Course Feed Draft Exclusion and Sample Quiz Seeding', () => {
    it('leaves never-published items out of the course feed', async () => {
      const course = { id: 'c-feed-1', name: 'History 201', access_code: 'HIST201' };
      await storage.table('gradebook_courses').put(course);

      const draftTask = {
        id: 'task-draft-1',
        title: 'Civil War Paper',
        submission_types: { text: { enabled: true } },
        class_id: 'c-feed-1'
        // Notice: no publish field!
      };
      await storage.table('tasks').put(draftTask);

      await storage.table('course_items').put({
        id: 'ci-task-draft',
        course_id: 'c-feed-1',
        kind: 'task',
        source_id: 'task-draft-1',
        title: 'Civil War Paper',
        published: true, // Course item marked published, but source task was never published!
        hidden: false
      });

      const feedRes = await buildCourseFeed('c-feed-1');
      const items = feedRes.feed?.items || feedRes.items || [];
      const found = items.find(i => i.source_id === 'task-draft-1');
      expect(found).toBeUndefined();
    });

    it('does not re-seed sample assessment once deleted', async () => {
      const seededFirst = await ensureSampleAssignment();
      expect(seededFirst).toBeTruthy();
      expect(seededFirst.class_id).toBeNull(); // Never linked to a class automatically

      // Count is 1
      expect(await storage.table('assignments').count()).toBe(1);

      // Delete the sample
      await storage.table('assignments').clear();
      expect(await storage.table('assignments').count()).toBe(0);

      // Second call should return null and not recreate
      const seededSecond = await ensureSampleAssignment();
      expect(seededSecond).toBeNull();
      expect(await storage.table('assignments').count()).toBe(0);
    });
  });

  describe('R0.3: Editor Back Button Navigation', () => {
    it('navigates to returnCourseId without ReferenceError in assignments editor', async () => {
      const asg = {
        id: 'asg-nav-1',
        title: 'Nav Quiz',
        questions: []
      };
      await storage.table('assignments').put(asg);

      const mockRouter = { navigate: vi.fn() };
      const container = document.createElement('div');
      document.body.appendChild(container);

      try {
        await renderEditor(asg, mockRouter, container, { returnCourseId: 'course-nav-789' });
      } catch (err) {
        console.error('renderEditor error:', err);
      }

      const backBtn = container.querySelector('#asg-back');
      expect(backBtn).toBeTruthy();
      backBtn.click();

      await vi.waitFor(() => {
        expect(mockRouter.navigate).toHaveBeenCalledWith('#/course?id=course-nav-789');
      }, { timeout: 2000 });
      container.remove();
    });

    it('navigates to returnCourseId without ReferenceError in tasks editor', async () => {
      const task = {
        id: 'task-nav-1',
        title: 'Nav Task',
        submission_types: { text: { enabled: true } },
        grading: { max_points: 100 }
      };
      await storage.table('tasks').put(task);

      const mockRouter = { navigate: vi.fn() };
      const container = document.createElement('div');
      document.body.appendChild(container);

      await renderTaskEditor(task, mockRouter, container, { returnCourseId: 'course-nav-456' });

      const backBtn = container.querySelector('#task-back-btn');
      expect(backBtn).toBeTruthy();
      backBtn.click();

      await vi.waitFor(() => {
        expect(mockRouter.navigate).toHaveBeenCalledWith('#/course?id=course-nav-456');
      }, { timeout: 2000 });
      container.remove();
    });
  });
});
