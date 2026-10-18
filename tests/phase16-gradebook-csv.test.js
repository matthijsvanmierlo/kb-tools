import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import jszipLib from 'jszip';
import {
  buildGradebookMailMergeRows,
  buildGradebookWideRows,
  buildCanvasExportRows,
  buildOneRosterExportZip,
  parseGradesCSV,
  planGradesImport,
  formatWideCell
} from '../src/modules/gradebook/gradebook-csv.js';
import { toCSV } from '../src/core/csv.js';
import { generateAccessCode } from '../src/core/access-codes.js';

const JSZip = jszipLib.default || jszipLib;

describe('Phase 16: Gradebook CSV Export & Import', () => {
  const course = {
    id: 'c-phys',
    name: 'AP Physics',
    section: 'Period 1',
    academic_year: '2026-2027',
    grading_scale: 'standard',
    categories: [
      { id: 'cat-tests', name: 'Tests', weight: 60 },
      { id: 'cat-labs', name: 'Labs', weight: 40 }
    ],
    terms: [{ id: 't1', name: 'Term 1' }]
  };

  const students = [
    { student_id: 'S001', full_name: 'Isaac Newton', email: 'inewton@cambridge.edu', access_code: generateAccessCode() },
    { student_id: 'S002', full_name: 'Albert Einstein', email: 'aeinstein@princeton.edu', access_code: generateAccessCode() },
    { student_id: 'S003', full_name: 'Marie Curie', email: 'mcurie@sorbonne.edu', access_code: generateAccessCode() }
  ];

  const assignments = [
    { id: 'asgn-1', title: 'Kinematics Exam', category_id: 'cat-tests', term_id: 't1', max_score: 100, scoring: 'points' },
    { id: 'asgn-2', title: 'Pendulum Lab', category_id: 'cat-labs', term_id: 't1', max_score: 50, scoring: 'points' }
  ];

  const gradesMap = new Map([
    // Newton: 95 on exam, 48 on lab
    ['S001+asgn-1', { id: 'g1', course_id: 'c-phys', student_id: 'S001', assignment_id: 'asgn-1', raw_score: 95, status: 'submitted' }],
    ['S001+asgn-2', { id: 'g2', course_id: 'c-phys', student_id: 'S001', assignment_id: 'asgn-2', raw_score: 48, status: 'submitted' }],
    // Einstein: 85 with 2 days late on exam, exempt on lab
    ['S002+asgn-1', { id: 'g3', course_id: 'c-phys', student_id: 'S002', assignment_id: 'asgn-1', raw_score: 85, status: 'late', extra: { days_late: 2 } }],
    ['S002+asgn-2', { id: 'g4', course_id: 'c-phys', student_id: 'S002', assignment_id: 'asgn-2', raw_score: null, status: 'exempt' }],
    // Curie: missing exam, 50 on lab
    ['S003+asgn-1', { id: 'g5', course_id: 'c-phys', student_id: 'S003', assignment_id: 'asgn-1', raw_score: null, status: 'missing' }],
    ['S003+asgn-2', { id: 'g6', course_id: 'c-phys', student_id: 'S003', assignment_id: 'asgn-2', raw_score: 50, status: 'submitted' }]
  ]);

  describe('formatWideCell grammar', () => {
    it('formats score, missing, exempt, and late with days', () => {
      expect(formatWideCell({ raw_score: 90, status: 'submitted' })).toBe(90);
      expect(formatWideCell({ raw_score: null, status: 'missing' })).toBe('M');
      expect(formatWideCell({ raw_score: null, status: 'exempt' })).toBe('E');
      expect(formatWideCell({ raw_score: 85, status: 'late', extra: { days_late: 2 } })).toBe('85L2');
      expect(formatWideCell({ raw_score: 70, status: 'late' })).toBe('70L');
      expect(formatWideCell(null)).toBe('');
    });
  });

  describe('Wide export and import round-trip', () => {
    it('round-trips without changes and preserves 85L2, M, and E', () => {
      // 1. Export wide
      const { headers, rows } = buildGradebookWideRows({
        course,
        students,
        assignments,
        gradesMap
      });

      expect(headers).toContain('Kinematics Exam [100]');
      expect(headers).toContain('Pendulum Lab [50]');
      expect(headers).toContain('Overall');
      expect(headers).toContain('Letter');

      const newtonRow = rows.find(r => r.StudentID === 'S001');
      expect(newtonRow['Kinematics Exam [100]']).toBe(95);

      const einsteinRow = rows.find(r => r.StudentID === 'S002');
      expect(einsteinRow['Kinematics Exam [100]']).toBe('85L2');
      expect(einsteinRow['Pendulum Lab [50]']).toBe('E');

      const curieRow = rows.find(r => r.StudentID === 'S003');
      expect(curieRow['Kinematics Exam [100]']).toBe('M');
      expect(curieRow['Pendulum Lab [50]']).toBe(50);

      // 2. Convert to CSV string and parse back
      const csvString = toCSV(rows, headers);
      const parsed = parseGradesCSV(csvString);

      expect(parsed.students).toHaveLength(3);
      expect(parsed.headers).toContain('Kinematics Exam [100]');
      expect(parsed.headers).toContain('Pendulum Lab [50]');

      // 3. Plan import against the current state
      const plan = planGradesImport({
        parsed,
        course,
        students,
        assignments,
        gradesMap
      });

      expect(plan.matchedColumns).toHaveLength(2);
      expect(plan.unmatchedColumns).toHaveLength(0);
      expect(plan.unknownStudents).toHaveLength(0);
      // Since data is identical, zero changes should be planned
      expect(plan.changes).toHaveLength(0);
    });

    it('detects changes when grades are updated in wide CSV', () => {
      const csv = `StudentID,FullName,Email,Kinematics Exam [100],Pendulum Lab [50]\nS001,"Isaac Newton",inewton@cambridge.edu,98,M\nS999,"Unknown Person",unknown@school.edu,100,50`;
      const parsed = parseGradesCSV(csv);
      const plan = planGradesImport({
        parsed,
        course,
        students,
        assignments,
        gradesMap
      });

      expect(plan.unknownStudents).toContain('S999');
      expect(plan.changes).toHaveLength(2);

      const changeExam = plan.changes.find(c => c.assignment_id === 'asgn-1');
      expect(changeExam.after.raw_score).toBe(98);
      expect(changeExam.before.raw_score).toBe(95);

      const changeLab = plan.changes.find(c => c.assignment_id === 'asgn-2');
      expect(changeLab.after.status).toBe('missing');
      expect(changeLab.before.raw_score).toBe(48);
    });
  });

  describe('Canvas Export & Parsing', () => {
    it('produces valid Canvas header structure and Points Possible second row', () => {
      const { headers, rows } = buildCanvasExportRows({
        course,
        students,
        assignments,
        gradesMap
      });

      expect(headers.slice(0, 5)).toEqual(['Student', 'ID', 'SIS User ID', 'SIS Login ID', 'Section']);
      expect(headers).toContain('Kinematics Exam (asgn-1)');

      // Row 0 is Points Possible
      expect(rows[0].Student).toBe('Points Possible');
      expect(rows[0]['Kinematics Exam (asgn-1)']).toBe(100);
      expect(rows[0]['Pendulum Lab (asgn-2)']).toBe(50);

      // Student rows format Last, First
      expect(rows[1].Student).toBe('Newton, Isaac');
      expect(rows[1]['Kinematics Exam (asgn-1)']).toBe(95);

      // Round trip parse
      const csvString = toCSV(rows, headers);
      const parsed = parseGradesCSV(csvString);

      // Should skip the Points Possible row
      expect(parsed.students).toHaveLength(3);
      expect(parsed.students[0].student_id).toBe('S001');

      const plan = planGradesImport({
        parsed,
        course,
        students,
        assignments,
        gradesMap
      });

      expect(plan.matchedColumns).toHaveLength(2);
      expect(plan.matchedColumns.map(c => c.assignment.id)).toEqual(['asgn-1', 'asgn-2']);
      expect(plan.unknownStudents).toHaveLength(0);
    });
  });

  describe('OneRoster Results Bundle', () => {
    it('creates zip bundle with lineItems.csv and results.csv', async () => {
      const { blob, filename } = await buildOneRosterExportZip({
        course,
        students,
        assignments,
        gradesMap
      });

      expect(filename).toContain('_oneroster_results.zip');
      const zip = await JSZip.loadAsync(blob);
      expect(zip.file('lineItems.csv')).toBeDefined();
      expect(zip.file('results.csv')).toBeDefined();

      const lineItemsText = await zip.file('lineItems.csv').async('string');
      expect(lineItemsText).toContain('Kinematics Exam');
      expect(lineItemsText).toContain('classSourcedId');

      const resultsText = await zip.file('results.csv').async('string');
      expect(resultsText).toContain('scoreStatus');
      expect(resultsText).toContain('exempt');
      expect(resultsText).toContain('not submitted');
    });
  });

  describe('Mail-Merge CSV with Report Links', () => {
    it('generates report link for every student and includes AccessCode only when opted in', async () => {
      const withoutCodes = await buildGradebookMailMergeRows({
        course,
        students,
        assignments,
        gradesMap,
        includeAccessCodes: false
      });

      expect(withoutCodes.headers).not.toContain('AccessCode');
      expect(withoutCodes.headers).toContain('ReportLink');
      expect(withoutCodes.rows).toHaveLength(3);
      expect(withoutCodes.rows[0].ReportLink).toContain('#/share?');
      expect(withoutCodes.rows[0].ReportLink).toContain('enc=1');
      expect(withoutCodes.rows[0].MissingCount).toBe(0);
      expect(withoutCodes.rows[2].MissingCount).toBe(1);
      expect(withoutCodes.rows[2].MissingList).toBe('Kinematics Exam');

      const withCodes = await buildGradebookMailMergeRows({
        course,
        students,
        assignments,
        gradesMap,
        includeAccessCodes: true
      });

      expect(withCodes.headers).toContain('AccessCode');
      expect(withCodes.rows[0].AccessCode).toBe(students[0].access_code);
    });
  });
});
