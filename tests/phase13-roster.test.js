import { describe, it, expect } from 'vitest';
import { detectColumns, normalizeRows, planMerge, parsePastedRoster, applyGradingTemplate, exportRosterCSV } from '../src/core/roster-import.js';
import { parseOneRosterBundle } from '../src/core/oneroster.js';

describe('Phase 2 — Roster Import & Class Configuration', () => {
  describe('detectColumns', () => {
    it('detects English and Dutch headers correctly', () => {
      const dutchHeaders = ['Naam', 'Leerlingnummer', 'E-mail', 'Opmerkingen'];
      const res = detectColumns(dutchHeaders);

      expect(res.mapping.full_name).toBe('Naam');
      expect(res.mapping.student_id).toBe('Leerlingnummer');
      expect(res.mapping.email).toBe('E-mail');
      expect(res.mapping.notes).toBe('Opmerkingen');
      expect(res.confidence).toBeGreaterThan(0.7);
    });

    it('detects Canvas export headers correctly', () => {
      const canvasHeaders = ['Student', 'ID', 'SIS User ID', 'SIS Login ID', 'Section'];
      const res = detectColumns(canvasHeaders);

      expect(res.mapping.full_name).toBe('Student');
      // SIS User ID or ID maps to student_id
      expect(['SIS User ID', 'ID', 'SIS Login ID']).toContain(res.mapping.student_id);
    });

    it('detects Google Classroom headers correctly', () => {
      const gcHeaders = ['Last Name', 'First Name', 'Email'];
      const res = detectColumns(gcHeaders);

      expect(res.mapping.family_name).toBe('Last Name');
      expect(res.mapping.given_name).toBe('First Name');
      expect(res.mapping.email).toBe('Email');
    });

    it('returns empty mapping and 0 confidence for empty headers', () => {
      const res = detectColumns([]);
      expect(res.confidence).toBe(0);
      expect(res.mapping.student_id).toBeNull();
    });
  });

  describe('normalizeRows', () => {
    it('splits full name when given/family are not mapped', () => {
      const rows = [
        { id: '000123', name: 'van der Bilt, Jan', email: 'jan@example.com' }
      ];
      const mapping = {
        student_id: 'id',
        full_name: 'name',
        email: 'email'
      };

      const normalized = normalizeRows(rows, mapping);
      expect(normalized).toHaveLength(1);
      expect(normalized[0].student_id).toBe('000123'); // preserves leading zeros
      expect(normalized[0].full_name).toBe('Jan van der Bilt');
      expect(normalized[0].given_name).toBe('Jan');
      expect(normalized[0].family_name).toBe('van der Bilt');
      expect(normalized[0].email).toBe('jan@example.com');
    });

    it('joins given and family names when full name is not mapped', () => {
      const rows = [
        { id: 'S101', first: 'Emma', last: 'Watson' }
      ];
      const mapping = {
        student_id: 'id',
        given_name: 'first',
        family_name: 'last'
      };

      const normalized = normalizeRows(rows, mapping);
      expect(normalized).toHaveLength(1);
      expect(normalized[0].full_name).toBe('Emma Watson');
      expect(normalized[0].given_name).toBe('Emma');
      expect(normalized[0].family_name).toBe('Watson');
    });

    it('flags invalid rows missing a name or student ID', () => {
      const rows = [
        { id: '', name: 'Jane Doe' },
        { id: 'S102', name: '' }
      ];
      const mapping = {
        student_id: 'id',
        full_name: 'name'
      };

      const normalized = normalizeRows(rows, mapping);
      expect(normalized).toHaveLength(2);
      expect(normalized[0].errors).toBeDefined();
      expect(normalized[1].errors).toBeDefined();
    });
  });

  describe('planMerge', () => {
    const existing = [
      {
        id: 'uuid-1',
        student_id: 'S101',
        full_name: 'Emma Watson',
        given_name: 'Emma',
        family_name: 'Watson',
        email: 'emma@school.org',
        access_code: 'K7M2-QX9P'
      },
      {
        id: 'uuid-2',
        student_id: 'S102',
        full_name: 'Daniel Radcliffe',
        given_name: 'Daniel',
        family_name: 'Radcliffe',
        email: 'daniel@school.org',
        access_code: 'AA22-BB33'
      }
    ];

    it('plans additions for new students', () => {
      const incoming = [
        { student_id: 'S103', full_name: 'Rupert Grint', email: 'rupert@school.org' }
      ];

      const plan = planMerge(existing, incoming);
      expect(plan.add).toHaveLength(1);
      expect(plan.add[0].student_id).toBe('S103');
      expect(plan.update).toHaveLength(0);
      expect(plan.unchanged).toHaveLength(0);
    });

    it('plans updates when existing student details change', () => {
      const incoming = [
        { student_id: 's101', full_name: 'Emma C. Watson', email: 'emma.new@school.org' }
      ];

      const plan = planMerge(existing, incoming, { updateExisting: true });
      expect(plan.add).toHaveLength(0);
      expect(plan.update).toHaveLength(1);
      expect(plan.update[0].existing.student_id).toBe('S101');
      expect(plan.update[0].changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'full_name', to: 'Emma C. Watson' }),
        expect.objectContaining({ field: 'email', to: 'emma.new@school.org' })
      ]));
    });

    it('does not overwrite existing access code unless explicitly allowed', () => {
      const incoming = [
        { student_id: 'S101', full_name: 'Emma Watson', email: 'emma@school.org', access_code: 'NEWCODE1' }
      ];

      // Default: do not allow overwrite
      const planNoOverwrite = planMerge(existing, incoming, { allowAccessCodeOverwrite: false });
      expect(planNoOverwrite.update).toHaveLength(0);
      expect(planNoOverwrite.unchanged).toHaveLength(1);

      // Opted-in: allow overwrite
      const planWithOverwrite = planMerge(existing, incoming, { allowAccessCodeOverwrite: true });
      expect(planWithOverwrite.update).toHaveLength(1);
      expect(planWithOverwrite.update[0].changes).toContainEqual(
        expect.objectContaining({ field: 'access_code', from: 'K7M2-QX9P', to: 'NEWCODE1' })
      );
    });

    it('detects duplicates within the file', () => {
      const incoming = [
        { student_id: 'S104', full_name: 'Tom Felton', email: 'tom@school.org' },
        { student_id: 's104', full_name: 'Tom Felton (Dupe)', email: 'tom2@school.org' }
      ];

      const plan = planMerge(existing, incoming);
      expect(plan.add).toHaveLength(1);
      expect(plan.duplicatesInFile).toHaveLength(1);
      expect(plan.duplicatesInFile[0].student_id).toBe('s104');
    });

    it('records conflicts for invalid or missing student IDs', () => {
      const incoming = [
        { student_id: '', full_name: 'Nobody', errors: ['Missing student ID'] }
      ];

      const plan = planMerge(existing, incoming);
      expect(plan.conflicts).toHaveLength(1);
    });
  });

  describe('parsePastedRoster', () => {
    it('parses TSV copied from spreadsheet with headers', () => {
      const tsv = 'Student ID\tFull Name\tEmail\nS101\tEmma Watson\temma@school.org\nS102\tJohn Doe\tjohn@school.org';
      const res = parsePastedRoster(tsv);

      expect(res.fields).toEqual(['Student ID', 'Full Name', 'Email']);
      expect(res.rows).toHaveLength(2);
      expect(res.rows[0]['Student ID']).toBe('S101');
      expect(res.rows[0]['Full Name']).toBe('Emma Watson');
      expect(res.rows[0]['Email']).toBe('emma@school.org');
    });

    it('parses "Name <email>" formatted lines', () => {
      const text = 'Emma Watson <emma@school.org>\nDaniel Radcliffe <daniel@school.org>';
      const res = parsePastedRoster(text);

      expect(res.fields).toEqual(['full_name', 'email']);
      expect(res.rows).toHaveLength(2);
      expect(res.rows[0].full_name).toBe('Emma Watson');
      expect(res.rows[0].email).toBe('emma@school.org');
      expect(res.rows[1].full_name).toBe('Daniel Radcliffe');
      expect(res.rows[1].email).toBe('daniel@school.org');
    });

    it('handles empty input gracefully', () => {
      const res = parsePastedRoster('');
      expect(res.fields).toEqual([]);
      expect(res.rows).toEqual([]);
    });
  });

  describe('parseOneRosterBundle', () => {
    it('parses 3-file OneRoster bundle correctly', async () => {
      const usersCsv = `sourcedId,status,role,username,givenName,familyName,identifier,email
u1,active,student,ewatson,Emma,Watson,S101,emma@school.org
u2,active,student,dradcliffe,Daniel,Radcliffe,S102,daniel@school.org
u3,active,teacher,mcgonagall,Minerva,McGonagall,T01,minerva@school.org`;

      const classesCsv = `sourcedId,status,title,classCode,schoolYear
c1,active,AP Chemistry,CHEM-101,2026-2027`;

      const enrollmentsCsv = `sourcedId,status,classSourcedId,userSourcedId,role
e1,active,c1,u1,student
e2,active,c1,u2,student
e3,active,c1,u3,teacher`;

      const bundle = await parseOneRosterBundle({ usersCsv, classesCsv, enrollmentsCsv });

      expect(bundle.classes).toHaveLength(1);
      const cls = bundle.classes[0];
      expect(cls.title).toBe('AP Chemistry');
      expect(cls.classCode).toBe('CHEM-101');
      expect(cls.schoolYear).toBe('2026-2027');
      // Only students (not teacher)
      expect(cls.students).toHaveLength(2);
      expect(cls.students[0]).toEqual({
        student_id: 'S101',
        given_name: 'Emma',
        family_name: 'Watson',
        email: 'emma@school.org',
        sourced_id: 'u1'
      });
      expect(cls.students[1].student_id).toBe('S102');
    });
  });

  describe('applyGradingTemplate', () => {
    const baseCourse = {
      id: 'c-test',
      name: 'Biology 1',
      academic_year: '2026-2027'
    };

    it('applies points_two_categories template', () => {
      const templated = applyGradingTemplate(baseCourse, 'points_two_categories');
      expect(templated.grading_scale).toBe('traditional');
      expect(templated.categories).toHaveLength(2);
      expect(templated.categories[0].name).toBe('Assessments');
      expect(templated.categories[0].weight_pct).toBe(60);
      expect(templated.categories[1].name).toBe('Classwork & Homework');
      expect(templated.categories[1].weight_pct).toBe(40);
    });

    it('applies points_single_category template', () => {
      const templated = applyGradingTemplate(baseCourse, 'points_single_category');
      expect(templated.grading_scale).toBe('traditional');
      expect(templated.categories).toHaveLength(1);
      expect(templated.categories[0].name).toBe('All Work');
      expect(templated.categories[0].weight_pct).toBe(100);
    });

    it('applies sbg template', () => {
      const templated = applyGradingTemplate(baseCourse, 'sbg');
      expect(templated.grading_scale).toBe('sbg');
      expect(templated.categories).toHaveLength(1);
      expect(templated.categories[0].name).toBe('Standards Evidence');
    });

    it('copies structure from an existing source class', () => {
      const sourceCourse = {
        id: 'c-source',
        name: 'AP Physics',
        grading_scale: 'sbg',
        categories: [{ id: 'cat-custom', name: 'Labs', weight_pct: 100 }],
        terms: [{ id: 'term-s1', name: 'Semester 1', start_date: '2026-09-01', end_date: '2027-01-30', weight_pct: 100 }]
      };

      const templated = applyGradingTemplate(baseCourse, 'copy', sourceCourse);
      expect(templated.grading_scale).toBe('sbg');
      expect(templated.categories[0].name).toBe('Labs');
      expect(templated.terms[0].name).toBe('Semester 1');
    });
  });

  describe('exportRosterCSV', () => {
    it('generates standard roster CSV according to Appendix A', () => {
      const students = [
        {
          student_id: 'S101',
          full_name: 'Emma Watson',
          given_name: 'Emma',
          family_name: 'Watson',
          email: 'emma@school.org',
          access_code: 'K7M2-QX9P',
          notes: 'Accommodations'
        }
      ];
      const course = {
        name: 'AP Chemistry',
        section: 'Period 1',
        academic_year: '2026-2027'
      };

      // Without access codes
      const csvNoCodes = exportRosterCSV(students, course, { includeAccessCode: false, delimiter: ',' });
      expect(csvNoCodes).toContain('StudentID');
      expect(csvNoCodes).toContain('FullName');
      expect(csvNoCodes).toContain('HasAccessCode');
      expect(csvNoCodes).toContain('"Yes"');
      expect(csvNoCodes).not.toContain('"AccessCode"');

      // With access codes
      const csvWithCodes = exportRosterCSV(students, course, { includeAccessCode: true, delimiter: ',' });
      expect(csvWithCodes).toContain('"AccessCode"');
      expect(csvWithCodes).toContain('"K7M2-QX9P"');
    });
  });
});
