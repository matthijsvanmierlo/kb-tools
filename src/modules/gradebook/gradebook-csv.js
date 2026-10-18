/**
 * Gradebook CSV Exporter & Importer (KB-GRAD-012)
 * Handles wide round-trippable CSVs, mail-merge presets with encoded report links,
 * Canvas gradebook exports, OneRoster 1.1 results bundles, and CSV score diffing/imports.
 */

import jszipLib from 'jszip';
import { toCSV, parseCSV } from '../../core/csv.js';
import { splitName } from '../../core/names.js';
import { parseCellEntry } from './virtual-grid.js';
import { computeStudentSummary } from './aggregates.js';
import { getMaxLevel } from './grading-scales.js';
import { GradebookReportGenerator } from './report-generator.js';
import {
  GRADEBOOK_MAIL_MERGE_HEADERS,
  GRADEBOOK_WIDE_BASE_HEADERS,
  GRADEBOOK_WIDE_TAIL_HEADERS,
  CANVAS_BASE_HEADERS
} from '../../core/export-presets.js';

const JSZip = jszipLib.default || jszipLib;

const META_COLUMNS = new Set([
  'studentid', 'id', 'sisuserid', 'sisloginid', 'student', 'fullname',
  'firstname', 'lastname', 'email', 'section', 'class', 'overall',
  'letter', 'missing', 'late', 'mastery', 'pointspossible', 'reportlink',
  'accesscode', 'missingcount', 'missinglist', 'latecount'
]);

/**
 * Format a grade record for wide export cell using grid grammar.
 * Grammar: score, 'M', 'E', '85L2', ''
 */
export function formatWideCell(rec) {
  if (!rec) return '';
  if (rec.status === 'missing') return 'M';
  if (rec.status === 'exempt') return 'E';
  if (rec.status === 'late') {
    const days = rec.days_late || rec.extra?.days_late;
    const score = (rec.raw_score !== null && rec.raw_score !== undefined) ? rec.raw_score : '';
    return `${score}L${days ? days : ''}`;
  }
  if (rec.raw_score !== null && rec.raw_score !== undefined) {
    return rec.raw_score;
  }
  return '';
}

/**
 * Build Gradebook Mail-Merge CSV (Appendix B.3)
 */
export async function buildGradebookMailMergeRows({
  course,
  students = [],
  assignments = [],
  gradesMap = new Map(),
  rubrics = [],
  includeAssignmentScores = false,
  includeAccessCodes = false,
  compact = false
}) {
  const map = gradesMap.get ? gradesMap : new Map(Object.entries(gradesMap));
  const headers = [...GRADEBOOK_MAIL_MERGE_HEADERS];

  if (includeAssignmentScores && assignments.length > 0) {
    assignments.forEach(a => {
      headers.push(`${a.title} [${a.scoring === 'proficiency' ? getMaxLevel(course) : a.max_score}]`);
    });
  }

  if (includeAccessCodes) {
    headers.push('AccessCode');
  }

  const rows = [];
  for (const student of students) {
    const summary = computeStudentSummary(student, course, assignments, map);
    const fullName = student.full_name || '';
    const parsedName = splitName(fullName);
    const firstName = student.given_name || parsedName.given;
    const lastName = student.family_name || parsedName.family;

    const studentRecs = assignments.map(a => map.get(`${student.student_id}+${a.id}`)).filter(Boolean);
    const missingRecs = studentRecs.filter(r => r.status === 'missing');
    const lateRecs = studentRecs.filter(r => r.status === 'late');

    const missingAssignments = assignments.filter(a => map.get(`${student.student_id}+${a.id}`)?.status === 'missing');
    const missingList = missingAssignments.map(a => a.title).join('; ');

    // Generate individual student report share link
    let reportLink = '';
    try {
      const shareRes = await GradebookReportGenerator.createStudentShareLink(
        student,
        course,
        assignments,
        map,
        rubrics,
        { compact }
      );
      reportLink = shareRes.url;
    } catch (e) {
      console.error('Error generating report link for student:', student.student_id, e);
    }

    const row = {
      Email: student.email || '',
      FirstName: firstName,
      LastName: lastName,
      FullName: fullName,
      StudentID: student.student_id || '',
      Class: course.name || '',
      Section: course.section || '',
      Grade: summary.score !== null ? Number(summary.score) : '',
      Letter: summary.letter || '',
      Mastery: summary.mastery !== null && summary.mastery !== undefined ? Number(summary.mastery) : '',
      MissingCount: missingRecs.length,
      MissingList: missingList,
      LateCount: lateRecs.length,
      ReportLink: reportLink
    };

    if (includeAssignmentScores && assignments.length > 0) {
      assignments.forEach(a => {
        const colHeader = `${a.title} [${a.scoring === 'proficiency' ? getMaxLevel(course) : a.max_score}]`;
        const rec = map.get(`${student.student_id}+${a.id}`);
        row[colHeader] = formatWideCell(rec);
      });
    }

    if (includeAccessCodes) {
      row.AccessCode = student.access_code || '';
    }

    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Build Grades (Wide, Round-Trippable) CSV (Appendix B.4)
 */
export function buildGradebookWideRows({
  course,
  students = [],
  assignments = [],
  gradesMap = new Map()
}) {
  const map = gradesMap.get ? gradesMap : new Map(Object.entries(gradesMap));
  const asgnHeaders = assignments.map(a => `${a.title} [${a.scoring === 'proficiency' ? getMaxLevel(course) : a.max_score}]`);
  const headers = [...GRADEBOOK_WIDE_BASE_HEADERS, ...asgnHeaders, ...GRADEBOOK_WIDE_TAIL_HEADERS];

  const rows = students.map(student => {
    const summary = computeStudentSummary(student, course, assignments, map);
    const row = {
      StudentID: student.student_id || '',
      FullName: student.full_name || '',
      Email: student.email || ''
    };

    assignments.forEach(a => {
      const colHeader = `${a.title} [${a.scoring === 'proficiency' ? getMaxLevel(course) : a.max_score}]`;
      const rec = map.get(`${student.student_id}+${a.id}`);
      row[colHeader] = formatWideCell(rec);
    });

    row.Overall = summary.score !== null ? Number(summary.score) : '';
    row.Letter = summary.letter || '';
    row.Missing = assignments.filter(a => map.get(`${student.student_id}+${a.id}`)?.status === 'missing').length;
    row.Late = assignments.filter(a => map.get(`${student.student_id}+${a.id}`)?.status === 'late').length;

    return row;
  });

  return { headers, rows };
}

/**
 * Build Canvas Gradebook Format (Appendix B.5)
 */
export function buildCanvasExportRows({
  course,
  students = [],
  assignments = [],
  gradesMap = new Map()
}) {
  const map = gradesMap.get ? gradesMap : new Map(Object.entries(gradesMap));
  const asgnHeaders = assignments.map(a => `${a.title} (${a.id})`);
  const headers = [...CANVAS_BASE_HEADERS, ...asgnHeaders];

  // Second row: Points Possible
  const pointsRow = {
    Student: 'Points Possible',
    ID: '',
    'SIS User ID': '',
    'SIS Login ID': '',
    Section: ''
  };
  assignments.forEach(a => {
    pointsRow[`${a.title} (${a.id})`] = a.max_score;
  });

  const studentRows = students.map(student => {
    const parsedName = splitName(student.full_name);
    const studentName = parsedName.family ? `${parsedName.family}, ${parsedName.given}` : student.full_name;

    const row = {
      Student: studentName,
      ID: student.sis?.canvas_id || student.student_id || '',
      'SIS User ID': student.sis?.user_id || student.student_id || '',
      'SIS Login ID': student.sis?.login_id || student.email || '',
      Section: course.section || ''
    };

    assignments.forEach(a => {
      const rec = map.get(`${student.student_id}+${a.id}`);
      row[`${a.title} (${a.id})`] = (rec && rec.raw_score !== null && rec.raw_score !== undefined) ? rec.raw_score : '';
    });

    return row;
  });

  return { headers, rows: [pointsRow, ...studentRows] };
}

export const GOOGLE_CLASSROOM_HEADERS = ['Email Address', 'Assignment Score', 'Feedback'];

/**
 * Google Classroom / SIS preset: one assignment, three columns. Import it into a Google Sheet,
 * then in Classroom use Grades → Import grades from Sheets (students are matched by email).
 * Students without an email can't be matched and are left out.
 */
export function buildGoogleClassroomRows({
  assignment,
  students = [],
  gradesMap = new Map()
}) {
  const map = gradesMap.get ? gradesMap : new Map(Object.entries(gradesMap));
  const rows = [];
  for (const student of students) {
    if (!student.email) continue;
    const rec = map.get(`${student.student_id}+${assignment.id}`);
    const hasScore = rec && rec.raw_score !== null && rec.raw_score !== undefined && rec.raw_score !== '';
    rows.push({
      'Email Address': student.email,
      'Assignment Score': hasScore ? rec.raw_score : '',
      Feedback: rec?.feedback || ''
    });
  }
  return { headers: [...GOOGLE_CLASSROOM_HEADERS], rows, skipped: students.length - rows.length };
}

/**
 * Build OneRoster 1.1 CSV Results Bundle (Zip)
 */
export async function buildOneRosterExportZip({
  course,
  students = [],
  assignments = [],
  gradesMap = new Map()
}) {
  const map = gradesMap.get ? gradesMap : new Map(Object.entries(gradesMap));
  const now = new Date().toISOString();

  // 1. lineItems.csv
  const lineItemHeaders = [
    'sourcedId', 'status', 'dateLastModified', 'title', 'description',
    'assignDate', 'dueDate', 'classSourcedId', 'categorySourcedId',
    'resultValueMin', 'resultValueMax'
  ];
  const lineItemRows = assignments.map(a => ({
    sourcedId: a.sis?.sourced_id || a.id,
    status: 'active',
    dateLastModified: a.updated_at || now,
    title: a.title,
    description: '',
    assignDate: '',
    dueDate: a.due_date || '',
    classSourcedId: course.sis?.sourced_id || course.id,
    categorySourcedId: a.category_id || '',
    resultValueMin: 0,
    resultValueMax: a.max_score
  }));

  // 2. results.csv
  const resultHeaders = [
    'sourcedId', 'status', 'dateLastModified', 'lineItemSourcedId',
    'studentSourcedId', 'scoreStatus', 'score', 'scoreDate', 'comment'
  ];
  const resultRows = [];
  for (const student of students) {
    const studentSourcedId = student.sis?.sourced_id || student.student_id;
    for (const a of assignments) {
      const rec = map.get(`${student.student_id}+${a.id}`);
      if (!rec) continue;

      let scoreStatus = 'fully graded';
      if (rec.status === 'exempt') scoreStatus = 'exempt';
      else if (rec.status === 'missing') scoreStatus = 'not submitted';

      resultRows.push({
        sourcedId: rec.id || `${studentSourcedId}_${a.id}`,
        status: 'active',
        dateLastModified: rec.updated_at || now,
        lineItemSourcedId: a.sis?.sourced_id || a.id,
        studentSourcedId: studentSourcedId,
        scoreStatus,
        score: rec.raw_score !== null && rec.raw_score !== undefined ? rec.raw_score : '',
        scoreDate: rec.updated_at || now,
        comment: rec.feedback || ''
      });
    }
  }

  const zip = new JSZip();
  zip.file('lineItems.csv', toCSV(lineItemRows, lineItemHeaders));
  zip.file('results.csv', toCSV(resultRows, resultHeaders));

  const blob = await zip.generateAsync({ type: 'blob' });
  const filename = `${(course.name || 'class').replace(/[^a-z0-9_-]+/gi, '_')}_oneroster_results.zip`;

  return { blob, filename };
}

/**
 * Parse wide or LMS CSV file of student grades.
 *
 * @param {string} text
 * @returns {{ students: Array<{ student_id: string, cells: Record<string, string> }>, headers: string[] }}
 */
export function parseGradesCSV(text) {
  const parsed = parseCSV(text);
  if (!parsed.fields || !parsed.fields.length) {
    return { students: [], headers: [] };
  }

  // Find student ID field
  const idField = parsed.fields.find(f => {
    const norm = f.toLowerCase().replace(/[^a-z0-9]/g, '');
    return norm === 'studentid' || norm === 'id' || norm === 'sisuserid' || norm === 'sisid' || norm === 'studentnumber' || norm === 'leerlingnummer';
  });

  if (!idField) {
    throw new Error('Could not identify a Student ID column in the CSV file.');
  }

  // Identify assignment columns (fields not in metadata set)
  const assignmentHeaders = parsed.fields.filter(f => {
    const norm = f.toLowerCase().replace(/[^a-z0-9]/g, '');
    return !META_COLUMNS.has(norm);
  });

  const students = [];
  for (const row of parsed.rows) {
    const rawId = String(row[idField] || '').trim();
    if (!rawId) continue;
    // Skip Canvas "Points Possible" second header row
    if (rawId.toLowerCase() === 'points possible' || String(row['Student'] || '').toLowerCase() === 'points possible') {
      continue;
    }

    const cells = {};
    for (const h of assignmentHeaders) {
      cells[h] = row[h] !== undefined && row[h] !== null ? String(row[h]).trim() : '';
    }

    students.push({
      student_id: rawId,
      cells
    });
  }

  return { students, headers: assignmentHeaders };
}

/**
 * Plan a grade import by matching columns and diffing cell values against current state.
 *
 * @param {object} params
 * @param {object} params.parsed - Result of parseGradesCSV
 * @param {object} params.course
 * @param {Array<object>} params.students - Class roster
 * @param {Array<object>} params.assignments - Course assignments
 * @param {Map<string, object>} params.gradesMap - Current grades
 * @returns {{
 *   matchedColumns: Array<{ header: string, assignment: object }>,
 *   unmatchedColumns: string[],
 *   unknownStudents: string[],
 *   changes: Array<{
 *     student_id: string,
 *     student_name: string,
 *     assignment_id: string,
 *     assignment_title: string,
 *     before: object|null,
 *     after: object,
 *     parsedCell: object
 *   }>
 * }}
 */
export function planGradesImport({
  parsed,
  course,
  students = [],
  assignments = [],
  gradesMap = new Map()
}) {
  const map = gradesMap.get ? gradesMap : new Map(Object.entries(gradesMap));
  const matchedColumns = [];
  const unmatchedColumns = [];

  for (const header of parsed.headers) {
    const cleanHeader = header.trim();
    let matchedAsgn = null;

    // 1. Exact title match
    matchedAsgn = assignments.find(a => a.title.toLowerCase() === cleanHeader.toLowerCase());

    // 2. Title [max] match
    if (!matchedAsgn) {
      const matchBracket = cleanHeader.match(/^(.+?)\s*\[.*?\]$/);
      if (matchBracket) {
        const titlePart = matchBracket[1].trim().toLowerCase();
        matchedAsgn = assignments.find(a => a.title.toLowerCase() === titlePart);
      }
    }

    // 3. Title (id) match (Canvas format)
    if (!matchedAsgn) {
      const matchParen = cleanHeader.match(/^(.+?)\s*\((.+?)\)$/);
      if (matchParen) {
        const idPart = matchParen[2].trim();
        const titlePart = matchParen[1].trim().toLowerCase();
        matchedAsgn = assignments.find(a => a.id === idPart || a.title.toLowerCase() === titlePart);
      }
    }

    if (matchedAsgn) {
      matchedColumns.push({ header, assignment: matchedAsgn });
    } else {
      unmatchedColumns.push(header);
    }
  }

  const studentMap = new Map(students.map(s => [String(s.student_id).toUpperCase(), s]));
  const unknownStudents = [];
  const changes = [];

  for (const entry of parsed.students) {
    const normId = entry.student_id.toUpperCase();
    const student = studentMap.get(normId);

    if (!student) {
      unknownStudents.push(entry.student_id);
      continue;
    }

    for (const { header, assignment } of matchedColumns) {
      const rawVal = entry.cells[header];
      if (rawVal === undefined || rawVal === null || rawVal === '') {
        // Blank cells do not modify existing grades
        continue;
      }

      const parsedCell = parseCellEntry(rawVal);
      if (parsedCell.kind === 'invalid') continue;

      const current = map.get(`${student.student_id}+${assignment.id}`) || null;

      let after = null;
      if (parsedCell.kind === 'clear') {
        after = { raw_score: null, status: 'submitted' };
      } else if (parsedCell.kind === 'score') {
        after = { raw_score: parsedCell.score, status: 'submitted' };
      } else if (parsedCell.kind === 'missing') {
        after = { raw_score: null, status: 'missing' };
      } else if (parsedCell.kind === 'exempt') {
        after = { raw_score: null, status: 'exempt' };
      } else if (parsedCell.kind === 'late') {
        after = {
          raw_score: parsedCell.score !== undefined ? parsedCell.score : null,
          status: 'late',
          extra: parsedCell.days ? { days_late: parsedCell.days } : {}
        };
      }

      let hasChanged = false;
      if (!current) {
        hasChanged = true;
      } else {
        if (current.status !== after.status) hasChanged = true;
        else if (current.raw_score !== after.raw_score) hasChanged = true;
        else if (after.status === 'late' && (current.days_late || current.extra?.days_late) !== after.extra?.days_late) hasChanged = true;
      }

      if (hasChanged) {
        changes.push({
          student_id: student.student_id,
          student_name: student.full_name,
          assignment_id: assignment.id,
          assignment_title: assignment.title,
          before: current,
          after,
          parsedCell
        });
      }
    }
  }

  return {
    matchedColumns,
    unmatchedColumns,
    unknownStudents: [...new Set(unknownStudents)],
    changes
  };
}
