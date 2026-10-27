import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { storage } from '../src/core/storage.js';
import { buildCourseFeed, decryptCourseFeed } from '../src/core/course-feed.js';
import { stringSimilarity } from '../src/core/student-matcher.js';
import { mergeStudents } from '../src/modules/classes/student-actions.js';
import { buildStudentRecord, recordToCsvFiles } from '../src/core/records-export.js';
import { updateInboxBadge } from '../src/components/app-nav.js';

describe('Phase 44: Course Feed, Roster Deduplication & Audit', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await storage.init();
    for (const tbl of [
      'gradebook_courses', 'gradebook_students', 'course_units', 'course_items',
      'assignments', 'tasks', 'gradebook_grades', 'assignment_submissions', 'task_submissions'
    ]) {
      await storage.table(tbl).clear().catch(() => {});
    }
  });

  describe('Course Feed generation and decryption with units, colors & student payloads', () => {
    it('builds and decrypts a complete course feed with units, colors, and embedded payloads', async () => {
      const courseId = 'course-bio-101';
      await storage.table('gradebook_courses').put({
        id: courseId,
        name: 'Biology 101',
        section: 'Period 3',
        academic_year: '2026-2027',
        passphrase: 'feed-secret-password-123'
      });

      await storage.table('course_units').put({
        id: 'unit-cells',
        course_id: courseId,
        title: 'Unit 1: Cellular Biology',
        description: 'Introduction to cell structures and organelles',
        color: 'emerald',
        order: 1
      });

      await storage.table('tasks').put({
        id: 'task-cell-lab',
        class_id: courseId,
        title: 'Cell Organelle Lab Report',
        description: 'Complete the organelle identification report',
        points_possible: 100,
        submission_types: ['file'],
        created_at: new Date().toISOString()
      });

      await storage.table('course_items').put({
        id: 'item-task-1',
        course_id: courseId,
        unit_id: 'unit-cells',
        type: 'task',
        title: 'Cell Organelle Lab Report',
        content_id: 'task-cell-lab',
        order: 1,
        created_at: new Date().toISOString()
      });

      // Build feed
      const result = await buildCourseFeed(courseId, { passphrase: 'feed-secret-password-123' });
      expect(result).toBeDefined();
      expect(result.rawFileContent).toBeDefined();
      expect(result.stats.unitsCount).toBe(1);
      expect(result.stats.itemsCount).toBe(1);

      // Decrypt feed
      const decrypted = await decryptCourseFeed(result.rawFileContent, 'feed-secret-password-123');
      expect(decrypted).toBeDefined();
      expect(decrypted.course.id).toBe(courseId);
      expect(decrypted.units.length).toBe(1);
      expect(decrypted.units[0].title).toBe('Unit 1: Cellular Biology');
      expect(decrypted.units[0].description).toBe('Introduction to cell structures and organelles');
      expect(decrypted.units[0].color).toBe('emerald');

      expect(decrypted.items.length).toBe(1);
      expect(decrypted.items[0].type).toBe('task');
      expect(decrypted.items[0].content_id).toBe('task-cell-lab');
      expect(decrypted.items[0].payload).toBeDefined();
      expect(decrypted.items[0].payload.kind).toBe('kb-task');
    });
  });

  describe('Roster deduplication & student record merging', () => {
    it('detects name similarity with stringSimilarity', () => {
      expect(stringSimilarity('Alex Smith', 'alex smith')).toBe(1);
      expect(stringSimilarity('Alex Smith', 'Alex Smyth')).toBeGreaterThanOrEqual(0.75);
      expect(stringSimilarity('Alexander Smith', 'Alex Smith')).toBeGreaterThanOrEqual(0.65);
      expect(stringSimilarity('John Doe', 'Jane Roe')).toBeLessThan(0.6);
    });

    it('merges duplicate student, re-parenting submissions and grades and combining aliases', async () => {
      const courseId = 'course-chem-201';
      const primary = {
        id: 'stud-canon-1',
        course_id: courseId,
        student_id: 'S101',
        full_name: 'Alex Rivera',
        email: 'alex.rivera@school.edu',
        aliases: ['A. Rivera']
      };
      const duplicate = {
        id: 'stud-dup-2',
        course_id: courseId,
        student_id: 'S-TEMP-99',
        full_name: 'Alex R.',
        email: 'arivera@school.edu',
        aliases: ['Lex']
      };

      await storage.table('gradebook_students').put(primary);
      await storage.table('gradebook_students').put(duplicate);

      // Add grades for duplicate
      await storage.table('gradebook_grades').put({
        course_id: courseId,
        student_id: 'S-TEMP-99',
        assignment_id: 'asg-quiz-1',
        raw_score: 95
      });

      // Add assignment submission for duplicate
      await storage.table('assignment_submissions').put({
        id: 'asg-sub-1',
        assignment_id: 'asg-quiz-1',
        student_id: 'S-TEMP-99',
        submitted_at: new Date().toISOString()
      });

      // Add task submission for duplicate
      await storage.table('task_submissions').put({
        id: 'task-sub-1',
        task_id: 'task-chem-lab',
        student_id: 'S-TEMP-99',
        submitted_at: new Date().toISOString()
      });

      // Execute merge
      const { primaryStudent: merged } = await mergeStudents({
        courseId,
        primaryStudent: primary,
        duplicateStudent: duplicate
      });

      expect(merged.student_id).toBe('S101');
      expect(merged.aliases).toContain('S-TEMP-99');
      expect(merged.aliases).toContain('Alex R.');
      expect(merged.aliases).toContain('Lex');

      // Check IndexedDB
      const remainingStudents = await storage.table('gradebook_students').where('course_id').equals(courseId).toArray();
      expect(remainingStudents.length).toBe(1);
      expect(remainingStudents[0].student_id).toBe('S101');

      // Check reparented grade
      const updatedGrade = await storage.table('gradebook_grades').get(['S101', 'asg-quiz-1']);
      expect(updatedGrade.student_id).toBe('S101');
      expect(updatedGrade.raw_score).toBe(95);

      const oldGrade = await storage.table('gradebook_grades').get(['S-TEMP-99', 'asg-quiz-1']);
      expect(oldGrade).toBeUndefined();

      // Check reparented submissions
      const updatedAsgSub = await storage.table('assignment_submissions').get('asg-sub-1');
      expect(updatedAsgSub.student_id).toBe('S101');

      const updatedTaskSub = await storage.table('task_submissions').get('task-sub-1');
      expect(updatedTaskSub.student_id).toBe('S101');
    });
  });

  describe('Student Records Export (FERPA / GDPR) with Aliases and Task Submissions', () => {
    it('resolves student across known aliases and includes task submissions in JSON and CSV', () => {
      const mockData = {
        gradebook_courses: [
          { id: 'c1', name: 'Physics 101' }
        ],
        gradebook_students: [
          { id: 'e1', course_id: 'c1', student_id: 'STU-100', full_name: 'Jordan Lee', aliases: ['JL-TEMP', 'Jordan L.'] }
        ],
        gradebook_assignments: [
          { id: 'ga1', course_id: 'c1', title: 'Midterm', max_score: 100 }
        ],
        gradebook_grades: [
          { student_id: 'JL-TEMP', assignment_id: 'ga1', course_id: 'c1', raw_score: 92, status: 'graded' }
        ],
        assignments: [
          { id: 'as1', class_id: 'c1', title: 'Newton Laws Quiz' }
        ],
        assignment_submissions: [
          { id: 'sub1', assignment_id: 'as1', student_id: 'JL-TEMP', submitted_at: '2026-10-15T10:00:00Z', auto: { earned: 18, possible: 20 } }
        ],
        tasks: [
          { id: 't1', class_id: 'c1', title: 'Projectile Motion Project' }
        ],
        task_submissions: [
          {
            id: 'tsub1',
            task_id: 't1',
            student_id: 'STU-100',
            submitted_at: '2026-10-20T14:00:00Z',
            points: { earned: 48, possible: 50 },
            review: { status: 'reviewed' }
          }
        ]
      };

      // Query using alias JL-TEMP
      const record = buildStudentRecord(mockData, 'JL-TEMP', { courseIds: ['c1'] });
      expect(record.student.student_id).toBe('STU-100');
      expect(record.grades.length).toBe(1);
      expect(record.grades[0].score).toBe(92);
      expect(record.submissions.length).toBe(1);
      expect(record.submissions[0].auto_score.earned).toBe(18);
      expect(record.task_submissions.length).toBe(1);
      expect(record.task_submissions[0].task).toBe('Projectile Motion Project');
      expect(record.task_submissions[0].points.earned).toBe(48);

      // Verify CSV generation
      const csvFiles = recordToCsvFiles(record);
      expect(csvFiles['grades.csv']).toContain('Midterm');
      expect(csvFiles['submissions.csv']).toContain('Newton Laws Quiz');
      expect(csvFiles['task_submissions.csv']).toBeDefined();
      expect(csvFiles['task_submissions.csv']).toContain('Projectile Motion Project');
      expect(csvFiles['task_submissions.csv']).toContain('48');
    });
  });

  describe('Inbox Navigation Badge', () => {
    it('renders and clears badge and dot indicators', () => {
      document.body.innerHTML = `
        <div id="kb-app-nav">
          <a href="#/inbox" data-route-link="#/inbox">Inbox</a>
          <button id="btn-kb-nav-more">More</button>
        </div>
      `;

      updateInboxBadge(5);
      const link = document.querySelector('a[data-route-link="#/inbox"]');
      const badge = link.querySelector('.kb-inbox-badge-count');
      expect(badge).not.toBeNull();
      expect(badge.textContent).toBe('5');

      const moreBtn = document.getElementById('btn-kb-nav-more');
      const dot = moreBtn.querySelector('.kb-inbox-more-dot');
      expect(dot).not.toBeNull();

      // Clear badge
      updateInboxBadge(0);
      expect(link.querySelector('.kb-inbox-badge-count')).toBeNull();
      expect(moreBtn.querySelector('.kb-inbox-more-dot')).toBeNull();
    });
  });
});
