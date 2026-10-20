import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { storage } from '../src/core/storage.js';
import {
  computeCourseRevisionHash,
  isFeedDirty,
  markFeedPublished,
  markCourseFeedDirty,
  contentHash,
  touch
} from '../src/core/course-revision.js';
import { QRCode } from '../src/core/qrcode.js';
import { AppUrl } from '../src/core/app-url.js';
import { renderStudentGradebookView } from '../src/modules/student/gradebook.js';
import { renderStudentCoursesView } from '../src/modules/student/courses.js';
import { RoleMode } from '../src/state/role-mode.js';
import { getEventLaunchUrl, getEventActionLabel, openEventDetailDialog } from '../src/modules/calendar/index.js';
import { loadCalendarEvents } from '../src/modules/calendar/model.js';

describe('Course Revision, QR Code & Dynamic Route Rendering', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await storage.init();
    await storage.table('gradebook_courses').clear().catch(() => {});
    await storage.table('course_units').clear().catch(() => {});
    await storage.table('course_items').clear().catch(() => {});
    await storage.table('student_courses').clear().catch(() => {});
    await storage.table('student_ledger').clear().catch(() => {});
  });

  describe('course-revision.js exports and functionality', () => {
    it('computes deterministic revision hash for a course and its units/items', async () => {
      const courseId = 'course-test-1';
      await storage.table('gradebook_courses').put({
        id: courseId,
        name: 'AP Chemistry',
        updated_at: new Date().toISOString()
      });

      await storage.table('course_units').put({
        id: 'unit-1',
        course_id: courseId,
        title: 'Thermodynamics',
        order: 1,
        updated_at: new Date().toISOString()
      });

      const hash1 = await computeCourseRevisionHash(courseId);
      expect(hash1).toBeDefined();
      expect(typeof hash1).toBe('string');
      expect(hash1.length).toBe(64); // SHA-256 hex string

      // Modifying unit order changes hash
      await storage.table('course_units').put({
        id: 'unit-1',
        course_id: courseId,
        title: 'Thermodynamics',
        order: 2,
        updated_at: new Date().toISOString()
      });
      const hash2 = await computeCourseRevisionHash(courseId);
      expect(hash2).not.toBe(hash1);
    });

    it('manages dirty feed status and markFeedPublished properly', async () => {
      const courseId = 'course-dirty-test';
      await storage.table('gradebook_courses').put({
        id: courseId,
        name: 'Physics',
        feed: {
          last_published: new Date(Date.now() - 10000).toISOString()
        }
      });

      expect(await isFeedDirty(courseId)).toBe(false);

      await markCourseFeedDirty(courseId);
      expect(await isFeedDirty(courseId)).toBe(true);

      await markFeedPublished(courseId, 'etag-12345');
      expect(await isFeedDirty(courseId)).toBe(false);

      const course = await storage.table('gradebook_courses').get(courseId);
      expect(course.feed.last_etag).toBe('etag-12345');
      expect(course.feed.dirty_since).toBeNull();
    });
  });

  describe('qrcode.js utility', () => {
    it('generates valid scalable SVG for access codes and links', () => {
      const svg = QRCode.generateSVG('https://example.com/join?code=ABCDEF', { size: 128 });
      expect(svg).toBeDefined();
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
    });

    it('handles empty inputs gracefully without throwing', () => {
      expect(QRCode.generateSVG('')).toBe('');
      expect(QRCode.generateSVG(null)).toBe('');
    });
  });

  describe('app-url.js namespace export', () => {
    it('exports AppUrl with getPublicAppUrl and isLocalOrigin', () => {
      expect(AppUrl).toBeDefined();
      expect(typeof AppUrl.getPublicAppUrl).toBe('function');
      expect(typeof AppUrl.isLocalOrigin).toBe('function');
      expect(AppUrl.isLocalOrigin('http://localhost:8000')).toBe(true);
      expect(AppUrl.isLocalOrigin('https://example.com')).toBe(false);
    });
  });

  describe('Student Gradebook View rendering', () => {
    it('renders empty student gradebook view without errors', async () => {
      const container = document.createElement('div');
      const router = { navigate: () => {} };
      await renderStudentGradebookView({}, router, container);

      expect(container.innerHTML).toContain('My Gradebook &amp; Feedback');
      expect(container.innerHTML).toContain('No grades or feedback yet');
    });
  });

  describe('Student Courses View rendering', () => {
    it('renders empty student courses view without errors', async () => {
      const container = document.createElement('div');
      const router = { navigate: () => {} };
      await renderStudentCoursesView({}, router, container);

      expect(container.innerHTML).toContain('My Enrolled Courses');
      expect(container.innerHTML).toContain('No courses joined yet');
    });
  });

  describe('Calendar role-aware routing and student action experience', () => {
    it('generates student taking URLs for student role', () => {
      expect(getEventLaunchUrl({ kind: 'assignment', sourceId: 'asg-1' }, true)).toBe('#/assignments/take?id=asg-1');
      expect(getEventLaunchUrl({ kind: 'video', sourceId: 'vid-1' }, true)).toBe('#/video/kiosk?id=vid-1');
      expect(getEventLaunchUrl({ kind: 'flashcards', sourceId: 'deck-1' }, true)).toBe('#/flashcards/study?id=deck-1');
      expect(getEventLaunchUrl({ kind: 'timeline', sourceId: 'time-1' }, true)).toBe('#/timeline/view?id=time-1');
      expect(getEventLaunchUrl({ kind: 'other', courseId: 'chem-101' }, true)).toBe('#/student/course?id=chem-101');
      expect(getEventLaunchUrl({ kind: 'other' }, true)).toBe('#/student');
    });

    it('generates teacher editing URLs for teacher role', () => {
      expect(getEventLaunchUrl({ kind: 'assignment', sourceId: 'asg-1' }, false)).toBe('#/assignments/edit?id=asg-1');
      expect(getEventLaunchUrl({ kind: 'video', sourceId: 'vid-1' }, false)).toBe('#/video/edit?id=vid-1');
      expect(getEventLaunchUrl({ kind: 'flashcards', sourceId: 'deck-1' }, false)).toBe('#/flashcards/edit?id=deck-1');
      expect(getEventLaunchUrl({ kind: 'timeline', sourceId: 'time-1' }, false)).toBe('#/timeline/view?id=time-1');
      expect(getEventLaunchUrl({ kind: 'other', courseId: 'chem-101' }, false)).toBe('#/course?id=chem-101');
      expect(getEventLaunchUrl({ kind: 'other' }, false)).toBe('#/classes');
    });

    it('returns student-friendly action verbs for lessons', () => {
      expect(getEventActionLabel({ kind: 'assignment' }, true)).toBe('Start Assignment');
      expect(getEventActionLabel({ kind: 'video' }, true)).toBe('Watch Video Lesson');
      expect(getEventActionLabel({ kind: 'flashcards' }, true)).toBe('Study Flashcards');
      expect(getEventActionLabel({ kind: 'timeline' }, true)).toBe('Explore Timeline');
      expect(getEventActionLabel({ kind: 'other' }, true)).toBe('Open Lesson');

      expect(getEventActionLabel({ kind: 'assignment' }, false)).toBe('Edit Assignment');
      expect(getEventActionLabel({ kind: 'video' }, false)).toBe('Edit Video');
    });

    it('renders clean read-only due info in event detail dialog when in student mode', () => {
      RoleMode.set('student');
      const ev = {
        id: 'ev-1',
        sourceId: 'asg-123',
        kind: 'assignment',
        title: 'Stoichiometry Lab',
        courseName: 'AP Chemistry',
        points: 50,
        date: '2026-10-25',
        time: '14:30'
      };

      const dialog = openEventDetailDialog(ev);
      try {
        expect(dialog).toBeDefined();
        // Read-only due section rendered
        expect(dialog.innerHTML).toContain('Due Information');
        expect(dialog.innerHTML).toContain('2026-10-25');
        expect(dialog.innerHTML).toContain('14:30');

        // Teacher editing controls NOT rendered
        expect(dialog.querySelector('#input-ev-date')).toBeNull();
        expect(dialog.querySelector('#input-ev-time')).toBeNull();
        expect(dialog.querySelector('#btn-save-ev')).toBeNull();

        // Primary action button is present with student verb
        const actionBtn = dialog.querySelector('#btn-open-lesson');
        expect(actionBtn).not.toBeNull();
        expect(actionBtn.textContent).toContain('Start Assignment');
      } finally {
        dialog.remove();
        RoleMode.set('teacher');
      }
    });

    it('renders editable date inputs and Save button in event detail dialog when in teacher mode', () => {
      RoleMode.set('teacher');
      const ev = {
        id: 'ev-2',
        sourceId: 'asg-456',
        kind: 'assignment',
        title: 'Quiz 1',
        courseName: 'Physics',
        points: 20,
        date: '2026-10-28',
        time: '10:00'
      };

      const dialog = openEventDetailDialog(ev);
      try {
        expect(dialog).toBeDefined();
        // Editable date and time inputs rendered
        expect(dialog.querySelector('#input-ev-date')).not.toBeNull();
        expect(dialog.querySelector('#input-ev-time')).not.toBeNull();
        expect(dialog.querySelector('#btn-save-ev')).not.toBeNull();

        const actionBtn = dialog.querySelector('#btn-open-lesson');
        expect(actionBtn).not.toBeNull();
        expect(actionBtn.textContent).toContain('Edit Assignment');
      } finally {
        dialog.remove();
      }
    });

    it('loadCalendarEvents includes student_items and student_courses', async () => {
      await storage.table('student_courses').put({
        id: 'sc-1',
        name: 'Honors World History',
        color: '#10b981'
      });

      await storage.table('student_items').put({
        id: 'si-1',
        course_id: 'sc-1',
        item_id: 'item-hist-1',
        kind: 'assignment',
        title: 'French Revolution Essay',
        due_date: '2026-10-26',
        due_time: '23:59',
        points: 100
      });

      const events = await loadCalendarEvents({ courseId: 'sc-1' });
      expect(events.length).toBe(1);
      expect(events[0].title).toBe('French Revolution Essay');
      expect(events[0].courseName).toBe('Honors World History');
      expect(events[0].courseColor).toBe('#10b981');
      expect(events[0].date).toBe('2026-10-26');
      expect(events[0].time).toBe('23:59');
    });
  });
});

