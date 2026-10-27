/**
 * Student records export - KB-CORE-012
 *
 * Answers a records request (FERPA inspection, GDPR access/portability) for one student, or a
 * whole class: everything KennisBoost holds about them, as JSON (machine-readable) and CSV, plus
 * the usual PDF grade report per class when available.
 *
 * buildStudentRecord() works on plain table data, so the same code runs in the app and in the
 * school's offline archive tool (scripts/escrow-recover.mjs). Access codes are left out: they are
 * credentials, not records, and including them would let anyone holding the export act as the
 * student.
 */
import { toCSV } from './csv.js';

export const RECORD_FORMAT_VERSION = 1;

const norm = (id) => String(id ?? '').trim().toUpperCase();

/**
 * @param {object} data - table rows: gradebook_courses, gradebook_students, gradebook_assignments,
 *   gradebook_grades, assignments, assignment_submissions (missing tables are treated as empty)
 * @param {string} studentId - the school's student ID (case-insensitive)
 * @param {{ courseIds?: string[]|null, now?: Date }} [opts] - restrict to some classes
 */
export function buildStudentRecord(data, studentId, { courseIds = null, now = new Date() } = {}) {
  const sid = norm(studentId);
  const inScope = (courseId) => !courseIds || courseIds.includes(courseId);
  const rows = (t) => data[t] || [];

  const allStudents = rows('gradebook_students');
  const enrolments = allStudents.filter(s => {
    if (!inScope(s.course_id)) return false;
    if (norm(s.student_id) === sid) return true;
    if (Array.isArray(s.aliases) && s.aliases.some(a => norm(a) === sid)) return true;
    return false;
  });

  const sids = new Set([sid]);
  for (const s of enrolments) {
    if (s.student_id) sids.add(norm(s.student_id));
    if (Array.isArray(s.aliases)) {
      for (const a of s.aliases) if (a) sids.add(norm(a));
    }
  }

  const courses = new Map(rows('gradebook_courses').map(c => [c.id, c]));
  const columns = new Map(rows('gradebook_assignments').map(a => [a.id, a]));
  const assignments = new Map(rows('assignments').map(a => [a.id, a]));
  const tasks = new Map(rows('tasks').map(t => [t.id, t]));
  const courseIdsOfStudent = new Set(enrolments.map(e => e.course_id));

  const grades = rows('gradebook_grades')
    .filter(g => sids.has(norm(g.student_id)) && courseIdsOfStudent.has(g.course_id))
    .map(g => {
      const col = columns.get(g.assignment_id) || {};
      const course = courses.get(g.course_id) || {};
      const category = (course.categories || []).find(c => c.id === col.category_id);
      return {
        course: course.name || g.course_id,
        assignment: col.title || g.assignment_id,
        category: category?.name || null,
        due_date: col.due_date || null,
        score: g.raw_score ?? null,
        max_score: col.max_score ?? null,
        status: g.status || null,
        feedback: g.feedback || null,
        rubric: g.rubric_eval || null,
        standards: g.standards || null,
        recorded_at: g.updated_at || g.created_at || null
      };
    })
    .sort((a, b) => String(a.course).localeCompare(String(b.course)) || String(a.due_date || '').localeCompare(String(b.due_date || '')));

  const submissions = rows('assignment_submissions')
    .filter(s => sids.has(norm(s.student_id)))
    .filter(s => {
      const a = assignments.get(s.assignment_id);
      return !courseIds || (a && courseIds.includes(a.class_id));
    })
    .map(s => {
      const a = assignments.get(s.assignment_id) || {};
      return {
        assignment: a.title || s.assignment_id,
        course: courses.get(a.class_id)?.name || null,
        submitted_at: s.submitted_at || null,
        days_late: s.days_late ?? null,
        identity_check: s.identity || null,
        auto_score: s.auto ? { earned: s.auto.earned ?? null, possible: s.auto.possible ?? null } : null,
        teacher_scores: s.manual || null,
        answers: s.answers || s.body?.answers || null,
        feedback: s.feedback || null
      };
    })
    .sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')));

  const taskSubmissions = rows('task_submissions')
    .filter(s => sids.has(norm(s.student_id)))
    .filter(s => {
      const t = tasks.get(s.task_id);
      return !courseIds || (t && courseIds.includes(t.class_id));
    })
    .map(s => {
      const t = tasks.get(s.task_id) || {};
      return {
        task: t.title || s.task_id,
        course: courses.get(t.class_id)?.name || null,
        submitted_at: s.submitted_at || null,
        days_late: s.days_late ?? null,
        identity_check: s.identity || null,
        points: s.points ?? null,
        review: s.review || null,
        answers: s.answers || s.body?.answers || null
      };
    })
    .sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')));

  const first = enrolments[0] || {};
  return {
    format: 'kennisboost-student-record',
    version: RECORD_FORMAT_VERSION,
    generated_at: now.toISOString(),
    student: {
      student_id: first.student_id || studentId,
      full_name: first.full_name || null,
      given_name: first.given_name || null,
      family_name: first.family_name || null,
      aliases: [...sids].filter(id => id !== norm(first.student_id || studentId)),
      emails: [...new Set(enrolments.map(e => e.email).filter(Boolean))],
      sis_ids: [...new Set(enrolments.map(e => e.sis?.sourced_id).filter(Boolean))],
      classes: enrolments.map(e => {
        const c = courses.get(e.course_id) || {};
        return { course_id: e.course_id, name: c.name || null, section: c.section || null, academic_year: c.academic_year || null, enrolled_at: e.created_at || null };
      })
    },
    grades,
    submissions,
    task_submissions: taskSubmissions,
    notes: [
      'Access codes are not included: they are credentials, not records.',
      'Practice data (flashcard study progress) is not tied to students and is not included.'
    ]
  };
}

/** Every distinct student ID in the given classes (or all classes) */
export function studentIdsIn(data, courseIds = null) {
  const ids = (data.gradebook_students || [])
    .filter(s => !courseIds || courseIds.includes(s.course_id))
    .map(s => String(s.student_id || '').trim())
    .filter(Boolean);
  const seen = new Map();
  for (const id of ids) if (!seen.has(norm(id))) seen.set(norm(id), id);
  return [...seen.values()];
}

export function recordToCsvFiles(record) {
  const gradeCols = ['course', 'assignment', 'category', 'due_date', 'score', 'max_score', 'status', 'feedback', 'recorded_at'];
  const subCols = ['assignment', 'course', 'submitted_at', 'days_late', 'identity_check', 'auto_earned', 'auto_possible'];
  const taskCols = ['task', 'course', 'submitted_at', 'days_late', 'identity_check', 'earned_points', 'max_points', 'review_status'];

  const files = {
    'grades.csv': toCSV(record.grades.map(g => Object.fromEntries(gradeCols.map(c => [c, g[c] ?? '']))), gradeCols),
    'submissions.csv': toCSV(record.submissions.map(s => ({
      assignment: s.assignment, course: s.course ?? '', submitted_at: s.submitted_at ?? '', days_late: s.days_late ?? '',
      identity_check: s.identity_check ?? '', auto_earned: s.auto_score?.earned ?? '', auto_possible: s.auto_score?.possible ?? ''
    })), subCols)
  };

  if (Array.isArray(record.task_submissions)) {
    files['task_submissions.csv'] = toCSV(record.task_submissions.map(s => ({
      task: s.task,
      course: s.course ?? '',
      submitted_at: s.submitted_at ?? '',
      days_late: s.days_late ?? '',
      identity_check: s.identity_check ? JSON.stringify(s.identity_check) : '',
      earned_points: s.points?.earned ?? '',
      max_points: s.points?.possible ?? '',
      review_status: s.review?.status ?? ''
    })), taskCols);
  }

  return files;
}

const safeName = (s) => String(s || 'student').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60);

/**
 * ZIP of one folder per student: record.json, grades.csv, submissions.csv, README.txt and
 * (optionally) PDF reports.
 * @param {object[]} records - from buildStudentRecord
 * @param {{ JSZip: any, pdfFor?: (record) => Promise<Array<{ name: string, blob: Blob }>>, school?: string }} deps
 */
export async function buildRecordsZip(records, { JSZip, pdfFor = null, school = '' }) {
  const zip = new JSZip();
  for (const r of records) {
    const dir = zip.folder(`${safeName(r.student.student_id)}_${safeName(r.student.full_name)}`);
    dir.file('record.json', JSON.stringify(r, null, 2));
    for (const [name, csv] of Object.entries(recordToCsvFiles(r))) dir.file(name, csv);
    dir.file('README.txt', [
      `Student record export${school ? ` — ${school}` : ''}`,
      `Student: ${r.student.full_name || ''} (${r.student.student_id})`,
      `Generated: ${r.generated_at}`,
      '',
      'record.json          everything KennisBoost holds about this student (machine-readable)',
      'grades.csv           gradebook entries',
      'submissions.csv      handed-in assignments (answers are in record.json)',
      'task_submissions.csv handed-in tasks and projects',
      ...r.notes
    ].join('\n'));
    if (pdfFor) {
      for (const pdf of await pdfFor(r)) dir.file(pdf.name, pdf.blob);
    }
  }
  return zip.generateAsync({ type: 'blob' });
}
