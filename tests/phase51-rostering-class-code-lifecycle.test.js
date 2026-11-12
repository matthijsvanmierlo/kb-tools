import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { AccessCodes, normalizeAccessCode } from '../src/core/access-codes.js';
import { rotateClassAccessCode } from '../src/core/course-feed.js';
import RosterImportDialog from '../src/components/roster-import-dialog.js';

describe('Phase 51: Rostering & Class Code Lifecycle', () => {
  beforeEach(async () => {
    await storage.init();
    await storage.table('gradebook_courses').clear();
    await storage.table('gradebook_students').clear();
  });

  it('1. rotateClassAccessCode uses 8-character class code format and updates course', async () => {
    await storage.table('gradebook_courses').put({
      id: 'c-rot-1',
      name: 'Physics',
      access_code: 'OLDCODE1'
    });

    const res = await rotateClassAccessCode('c-rot-1', { forwardOldCode: true });
    expect(normalizeAccessCode(res.newCode)).toHaveLength(8);
    expect(res.formattedCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.oldCode).toBe('OLDCODE1');

    const updated = await storage.table('gradebook_courses').get('c-rot-1');
    expect(updated.access_code).toBe(res.newCode);
  });

  it('2. importOneRosterClassesBatch provisions multiple classes, 8-char class codes, and student passcodes', async () => {
    const summary = await RosterImportDialog.importOneRosterClassesBatch([
      {
        sourcedId: 'or-cls-1',
        title: 'Algebra I',
        classCode: 'P1',
        schoolYear: '2026-2027',
        students: [
          { student_id: 'S101', given_name: 'Ada', family_name: 'Lovelace', email: 'ada@school.edu' },
          { student_id: 'S102', given_name: 'Alan', family_name: 'Turing', email: 'alan@school.edu' }
        ]
      },
      {
        sourcedId: 'or-cls-2',
        title: 'Geometry',
        classCode: 'P2',
        schoolYear: '2026-2027',
        students: [
          { student_id: 'S201', given_name: 'Grace', family_name: 'Hopper', email: 'grace@school.edu' }
        ]
      }
    ]);

    expect(summary.createdCourses).toBe(2);
    expect(summary.addedStudents).toBe(3);

    const courses = await storage.table('gradebook_courses').toArray();
    expect(courses).toHaveLength(2);
    for (const c of courses) {
      expect(normalizeAccessCode(c.access_code)).toHaveLength(8);
    }

    const students = await storage.table('gradebook_students').toArray();
    expect(students).toHaveLength(3);
    for (const s of students) {
      expect(s.access_code).toBeTruthy();
    }
  });
});
