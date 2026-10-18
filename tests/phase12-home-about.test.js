import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { computeHomeStats } from '../src/modules/home/home-stats.js';
import { loadDemoWorkspace, removeDemoData, hasDemoData } from '../src/core/demo.js';
import { storage } from '../src/core/storage.js';
import { APP_VERSION } from '../src/version.js';

describe('Phase 12: Home & About Modules', () => {
  describe('computeHomeStats', () => {
    it('returns empty checklist (0/6) for fresh profile', () => {
      const stats = computeHomeStats();
      expect(stats.checklistItems).toHaveLength(6);
      expect(stats.checklistAllDone).toBe(false);
      expect(stats.showChecklist).toBe(true);
      expect(stats.checklistItems.every(i => !i.completed)).toBe(true);
      expect(stats.attentionItems).toEqual([]);
    });

    it('marks checklist complete when all conditions are fulfilled', () => {
      const courses = [{ id: 'c1', name: 'AP Chem', is_demo: false }];
      const students = [{ id: 's1', course_id: 'c1', access_code: 'CODE-1234', is_demo: false }];
      const assignments = [{ id: 'a1', title: 'Task 1', publish: { version: 1 }, is_demo: false }];
      const metadata = { last_manual_export_timestamp: Date.now(), autosync_configured: true, recovery_kit_saved: true };

      const stats = computeHomeStats({ courses, students, assignments, metadata });
      expect(stats.checklistAllDone).toBe(true);
      expect(stats.showChecklist).toBe(false);
    });

    it('needs automatic backup and a saved recovery kit, unless the browser cannot auto-sync', () => {
      const done = (meta) => computeHomeStats({ metadata: meta }).checklistItems;
      const item = (meta, id) => done(meta).find(i => i.id === id);
      expect(item({ last_manual_export_timestamp: Date.now() }, 'make_backup').completed).toBe(false);
      expect(item({ last_manual_export_timestamp: Date.now(), autosync_supported: false }, 'make_backup').completed).toBe(true);
      expect(item({ autosync_configured: true }, 'make_backup').completed).toBe(true);
      expect(item({}, 'recovery_kit').completed).toBe(false);
      expect(item({ recovery_kit_saved: true }, 'recovery_kit').completed).toBe(true);
    });

    it('hides checklist if teacher dismissed it', () => {
      const metadata = { setup_checklist_dismissed_at: new Date().toISOString() };
      const stats = computeHomeStats({ metadata });
      expect(stats.showChecklist).toBe(false);
    });

    it('generates attention items for unsynced submissions and missing access codes', () => {
      const courses = [{ id: 'c1', name: 'Biology', is_demo: false }];
      const students = [
        { id: 's1', course_id: 'c1', full_name: 'Alice', is_demo: false }, // no code
        { id: 's2', course_id: 'c1', full_name: 'Bob', access_code: 'BIO-1111', is_demo: false }
      ];
      const assignments = [{ id: 'a1', title: 'Cell Quiz', class_id: 'c1' }];
      const submissions = [
        { id: 'sub1', assignment_id: 'a1', student_id: 's1', synced_at: null, is_latest: true },
        { id: 'sub2', assignment_id: 'a1', student_id: 's2', synced_at: null, is_latest: true }
      ];

      const stats = computeHomeStats({ courses, students, assignments, submissions });
      expect(stats.attentionItems.some(i => i.type === 'submissions_to_review')).toBe(true);
      expect(stats.attentionItems.some(i => i.type === 'missing_access_codes')).toBe(true);
    });

    it('flags stale backup (>3 days) and storage quota (>80%)', () => {
      const fourDaysAgo = Date.now() - 4 * 86400000;
      const metadata = { last_manual_export_timestamp: fourDaysAgo };
      const quota = { ratio: 0.85, usageMB: '85.0', quotaMB: '100.0' };

      const stats = computeHomeStats({ metadata, quota });
      expect(stats.attentionItems.some(i => i.type === 'stale_backup')).toBe(true);
      expect(stats.attentionItems.some(i => i.type === 'storage_quota')).toBe(true);
    });
  });

  describe('Demo Workspace Lifecycle (demo.js)', () => {
    beforeEach(async () => {
      await storage.init();
      await removeDemoData();
    });

    it('loads sample workspace with is_demo tagged records', async () => {
      expect(await hasDemoData()).toBe(false);

      await loadDemoWorkspace();
      expect(await hasDemoData()).toBe(true);

      const courses = await storage.table('gradebook_courses').toArray();
      expect(courses.some(c => c.is_demo === true)).toBe(true);

      const students = await storage.table('gradebook_students').toArray();
      expect(students.some(s => s.is_demo === true)).toBe(true);

      const assignments = await storage.table('assignments').toArray();
      expect(assignments.some(a => a.is_demo === true)).toBe(true);

      // Clean up sample data
      await removeDemoData();
      expect(await hasDemoData()).toBe(false);

      const remainingCourses = await storage.table('gradebook_courses').toArray();
      expect(remainingCourses.filter(c => c.is_demo)).toHaveLength(0);
    });
  });

  describe('Version & Constants', () => {
    it('exports version 1.1.0', () => {
      expect(APP_VERSION).toBe('1.1.0');
    });
  });
});
