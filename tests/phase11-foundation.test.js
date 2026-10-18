import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { StorageManager, storage } from '../src/core/storage.js';
import { splitName, joinName, sortKey } from '../src/core/names.js';
import { defaultAcademicYear } from '../src/core/academic-year.js';
import { toCSV, parseCSV, guardCell, suggestDelimiter } from '../src/core/csv.js';
import { RosterRowSchema, ROSTER_HEADER_ALIASES, parseCSVWithValidation } from '../src/core/validator.js';
import { ClassManager } from '../src/components/class-manager.js';
import { generateUUID } from '../src/utils/uuid.js';

describe('Phase 11: Foundation & Defect Fixes', () => {
  describe('Name Utilities (names.js)', () => {
    it('splits standard First Last names', () => {
      const res = splitName('Emma Watson');
      expect(res.given).toBe('Emma');
      expect(res.family).toBe('Watson');
    });

    it('splits "Last, First" formatted names', () => {
      const res = splitName('Watson, Emma');
      expect(res.given).toBe('Emma');
      expect(res.family).toBe('Watson');
    });

    it('handles Dutch/Flemish/European surname particles', () => {
      const res1 = splitName('Matthijs van Mierlo');
      expect(res1.given).toBe('Matthijs');
      expect(res1.family).toBe('van Mierlo');

      const res2 = splitName('Vincent van Gogh');
      expect(res2.given).toBe('Vincent');
      expect(res2.family).toBe('van Gogh');

      const res3 = splitName('Robin van der Meer');
      expect(res3.given).toBe('Robin');
      expect(res3.family).toBe('van der Meer');

      const res4 = splitName('Jan de Boer');
      expect(res4.given).toBe('Jan');
      expect(res4.family).toBe('de Boer');
    });

    it('handles single token and joins names', () => {
      const res = splitName('Plato');
      expect(res.given).toBe('Plato');
      expect(res.family).toBe('');

      expect(joinName({ given: 'Emma', family: 'Watson' })).toBe('Emma Watson');
      expect(joinName({ given: 'Plato' })).toBe('Plato');
      expect(joinName({ family: 'Cher' })).toBe('Cher');
    });

    it('generates consistent sortKey', () => {
      const k1 = sortKey({ full_name: 'Matthijs van Mierlo' });
      expect(k1).toBe('van mierlo matthijs');

      const k2 = sortKey({ given_name: 'Emma', family_name: 'Watson' });
      expect(k2).toBe('watson emma');
    });
  });

  describe('Academic Year (academic-year.js)', () => {
    it('determines academic year correctly around August', () => {
      const aug = new Date(2026, 7, 1); // 2026-08-01
      expect(defaultAcademicYear(aug)).toBe('2026-2027');

      const jul = new Date(2027, 6, 31); // 2027-07-31
      expect(defaultAcademicYear(jul)).toBe('2026-2027');

      const mar = new Date(2027, 2, 15); // 2027-03-15
      expect(defaultAcademicYear(mar)).toBe('2026-2027');

      const nov = new Date(2025, 10, 1); // 2025-11-01
      expect(defaultAcademicYear(nov)).toBe('2025-2026');
    });
  });

  describe('CSV Engine (csv.js)', () => {
    it('outputs UTF-8 BOM, CRLF, and quotes all fields', () => {
      const rows = [
        { ID: '00123', Name: 'Smith, John', Grade: 95 }
      ];
      const csv = toCSV(rows, ['ID', 'Name', 'Grade']);
      expect(csv.startsWith('\uFEFF')).toBe(true);
      expect(csv).toContain('\r\n');
      expect(csv).toContain('"00123"');
      expect(csv).toContain('"Smith, John"');
    });

    it('guards against formula injection', () => {
      expect(guardCell('=1+1')).toBe("'=1+1");
      expect(guardCell('+1+1')).toBe("'+1+1");
      expect(guardCell('-5')).toBe("'-5");
      expect(guardCell('@SUM(A1)')).toBe("'@SUM(A1)");
      expect(guardCell('Normal text')).toBe('Normal text');

      const rows = [{ val: '=SUM(1,2)' }];
      const csv = toCSV(rows, ['val']);
      expect(csv).toContain('"\'=SUM(1,2)"');
    });

    it('supports delimiter and decimal options', () => {
      const rows = [{ Score: 85.5 }];
      const csv = toCSV(rows, ['Score'], { delimiter: ';', decimal: ',' });
      expect(csv).toContain('"85,5"');
    });

    it('suggests delimiter based on locale', () => {
      const delim = suggestDelimiter();
      expect([',', ';']).toContain(delim);
    });

    it('parses CSV safely preserving string IDs with leading zeros', () => {
      const input = 'student_id,name\n00123,"Alice"\n00456,"Bob"';
      const parsed = parseCSV(input);
      expect(parsed.fields).toEqual(['student_id', 'name']);
      expect(parsed.rows[0].student_id).toBe('00123');
    });
  });

  describe('Validator & Roster Schema (validator.js)', () => {
    it('validates roster CSV with blank emails and preserves leading zeroes', () => {
      const csv = `Student ID,Student Name,Email\n000123,Emma Watson,\n000124,Liam Chen,lchen@school.edu`;
      const res = parseCSVWithValidation(csv, RosterRowSchema, {
        aliases: ROSTER_HEADER_ALIASES,
        dynamicTyping: false
      });
      expect(res.success).toBe(true);
      expect(res.data).toHaveLength(2);
      expect(res.data[0].student_id).toBe('000123');
      expect(res.data[0].email).toBeUndefined();
      expect(res.data[1].student_id).toBe('000124');
      expect(res.data[1].email).toBe('lchen@school.edu');
    });

    it('accepts given_name and family_name columns', () => {
      const csv = `ID,First Name,Last Name\nS101,John,Doe`;
      const res = parseCSVWithValidation(csv, RosterRowSchema, {
        aliases: ROSTER_HEADER_ALIASES,
        dynamicTyping: false
      });
      expect(res.success).toBe(true);
      expect(res.data[0].student_id).toBe('S101');
      expect(res.data[0].given_name).toBe('John');
      expect(res.data[0].family_name).toBe('Doe');
    });
  });

  describe('Database v4 & Wrapper Stamping', () => {
    it('stamps id, created_at, updated_at on put', async () => {
      const mgr = new StorageManager();
      await mgr.init();

      const table = mgr.table('flashcards');
      const savedKey = await table.put({ title: 'New Test Deck', cards: [] });
      const record = await table.get(savedKey);

      expect(record.id).toBeDefined();
      expect(record.created_at).toBeDefined();
      expect(record.updated_at).toBeDefined();

      const prevUpdated = record.updated_at;
      // Sleep slightly to guarantee different timestamp
      await new Promise(r => setTimeout(r, 10));
      record.title = 'Updated Test Deck';
      await table.put(record);

      const updatedRecord = await table.get(savedKey);
      expect(updatedRecord.created_at).toBe(record.created_at);
      expect(updatedRecord.updated_at >= prevUpdated).toBe(true);
    });

    it('ephemeral mode memory shim supports compound keys and count', async () => {
      const mgr = new StorageManager();
      mgr.ephemeralMode = true;

      const gradesTable = mgr.table('gradebook_grades');
      await gradesTable.put({
        course_id: 'c1',
        student_id: 's1',
        assignment_id: 'a1',
        raw_score: 90
      });

      expect(await gradesTable.count()).toBe(1);

      // Compound get using array
      const record = await gradesTable.get(['s1', 'a1']);
      expect(record).toBeDefined();
      expect(record.raw_score).toBe(90);

      // Where query
      const courseGrades = await gradesTable.where('course_id').equals('c1').toArray();
      expect(courseGrades).toHaveLength(1);

      // bulkDelete
      await gradesTable.bulkDelete([['s1', 'a1']]);
      expect(await gradesTable.count()).toBe(0);
    });
  });

  describe('Cascade Class Deletion and Scoped Student Removal', () => {
    it('cascade deletes course, students, assignments, rubrics, and grades', async () => {
      const mgr = storage;
      await mgr.init();

      const course = await ClassManager.saveClass({ name: 'Physics 101' });
      const studentId = generateUUID();
      await mgr.table('gradebook_students').put({
        id: studentId,
        course_id: course.id,
        student_id: 'PHY-01',
        full_name: 'Isaac Newton'
      });
      const asgnId = generateUUID();
      await mgr.table('gradebook_assignments').put({
        id: asgnId,
        course_id: course.id,
        term_id: 't1',
        category_id: 'c1',
        title: 'Gravity Lab',
        due_date: '2026-11-01'
      });
      await mgr.table('gradebook_grades').put({
        course_id: course.id,
        student_id: 'PHY-01',
        assignment_id: asgnId,
        raw_score: 100
      });

      // Delete the class
      await ClassManager.deleteClass(course.id);

      expect(await mgr.table('gradebook_courses').get(course.id)).toBeUndefined();
      const students = await mgr.table('gradebook_students').where('course_id').equals(course.id).toArray();
      expect(students).toHaveLength(0);
      const asgns = await mgr.table('gradebook_assignments').where('course_id').equals(course.id).toArray();
      expect(asgns).toHaveLength(0);
      const grades = await mgr.table('gradebook_grades').where('course_id').equals(course.id).toArray();
      expect(grades).toHaveLength(0);
    });

    it('archive and unarchive preserves class data', async () => {
      const course = await ClassManager.saveClass({ name: 'Bio 201' });
      await ClassManager.archiveClass(course.id);

      const archived = await ClassManager.getClass(course.id);
      expect(archived.archived_at).toBeDefined();

      const activeClasses = await ClassManager.getClasses({ includeArchived: false });
      expect(activeClasses.some(c => c.id === course.id)).toBe(false);

      const all = await ClassManager.getClasses({ includeArchived: true });
      expect(all.some(c => c.id === course.id)).toBe(true);

      await ClassManager.unarchiveClass(course.id);
      const restored = await ClassManager.getClass(course.id);
      expect(restored.archived_at).toBeNull();
    });
  });
});
