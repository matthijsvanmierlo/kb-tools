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
});
