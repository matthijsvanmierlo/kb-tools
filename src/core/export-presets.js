/**
 * Export Presets & Row Mappers (KB-EXP-001)
 * Definitions and builders for Submissions CSV, Mail-merge CSV, and Not-submitted lists.
 * Implements Appendix B schemas exactly.
 */

import { splitName } from './names.js';
import { finalScore, totalPoints, feedbackSummary } from '../modules/assignments/grading.js';

// Exact column headers in order (Appendix B)
export const SUBMISSIONS_CSV_HEADERS = [
  'StudentID', 'FullName', 'FirstName', 'LastName', 'Email',
  'Assignment', 'Class', 'Status', 'SubmittedAt', 'DaysLate',
  'Identity', 'Score', 'MaxScore', 'Percent', 'PendingReview', 'Feedback'
];

export const MAIL_MERGE_CSV_HEADERS = [
  'Email', 'FirstName', 'LastName', 'FullName', 'StudentID',
  'Class', 'Assignment', 'DueDate', 'Status', 'Score',
  'MaxScore', 'Percent', 'Feedback', 'Link', 'AssignmentLink'
];

export const NOT_SUBMITTED_CSV_HEADERS = [
  'Email', 'FirstName', 'LastName', 'FullName', 'StudentID',
  'Assignment', 'DueDate', 'Link'
];

export const GRADEBOOK_MAIL_MERGE_HEADERS = [
  'Email', 'FirstName', 'LastName', 'FullName', 'StudentID',
  'Class', 'Section', 'Grade', 'Letter', 'Mastery',
  'MissingCount', 'MissingList', 'LateCount', 'ReportLink'
];

export const GRADEBOOK_WIDE_BASE_HEADERS = ['StudentID', 'FullName', 'Email'];
export const GRADEBOOK_WIDE_TAIL_HEADERS = ['Overall', 'Letter', 'Missing', 'Late'];

export const CANVAS_BASE_HEADERS = ['Student', 'ID', 'SIS User ID', 'SIS Login ID', 'Section'];

/**
 * Build rows for Submissions CSV (Appendix B.1)
 *
 * @param {object} params
 * @param {object} params.assignment
 * @param {Array<object>} params.submissions - List of latest submissions
 * @param {Array<object>} [params.roster]
 * @param {object} [params.course]
 * @param {boolean} [params.includeQuestions]
 * @returns {{ headers: string[], rows: object[] }}
 */
export function buildSubmissionsExportRows({
  assignment,
  submissions = [],
  roster = [],
  course = null,
  includeQuestions = false
}) {
  const rosterMap = new Map((roster || []).map(s => [String(s.student_id).toUpperCase(), s]));
  const questions = assignment?.questions || [];

  const headers = [...SUBMISSIONS_CSV_HEADERS];
  if (includeQuestions && questions.length > 0) {
    questions.forEach((_, idx) => {
      headers.push(`Q${idx + 1}Points`, `Q${idx + 1}Max`, `Q${idx + 1}Feedback`);
    });
  }

  const rows = submissions.map(sub => {
    const student = rosterMap.get(String(sub.student_id).toUpperCase());
    const fullName = student?.full_name || sub.student_name || '';
    const parsedName = splitName(fullName);
    const firstName = student?.given_name || parsedName.given;
    const lastName = student?.family_name || parsedName.family;
    const email = student?.email || '';

    const scoreInfo = finalScore(assignment, sub);
    const maxScore = scoreInfo.possible;
    const earned = scoreInfo.earned;
    const percent = maxScore > 0 ? Number(((earned / maxScore) * 100).toFixed(1)) : 100.0;
    const pendingReview = scoreInfo.pending > 0 ? 'Yes' : 'No';

    const row = {
      StudentID: sub.student_id || '',
      FullName: fullName,
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      Assignment: assignment?.title || '',
      Class: course?.name || '',
      Status: 'Submitted',
      SubmittedAt: sub.submitted_at || '',
      DaysLate: sub.days_late ?? 0,
      Identity: sub.identity || '',
      Score: earned,
      MaxScore: maxScore,
      Percent: percent,
      PendingReview: pendingReview,
      Feedback: feedbackSummary(assignment, sub)
    };

    if (includeQuestions && questions.length > 0) {
      questions.forEach((q, idx) => {
        const auto = sub.auto?.per_question?.[q.id];
        const manual = sub.manual?.[q.id];
        let qPoints = auto?.earned ?? 0;
        if (manual && manual.points !== null && manual.points !== undefined && manual.points !== '') {
          qPoints = Number(manual.points) || 0;
        }
        row[`Q${idx + 1}Points`] = qPoints;
        row[`Q${idx + 1}Max`] = auto?.possible ?? (q.points || 0);
        row[`Q${idx + 1}Feedback`] = manual?.feedback || '';
      });
    }

    return row;
  });

  return { headers, rows };
}

/**
 * Build rows for Mail-Merge CSV (Appendix B.2)
 *
 * @param {object} params
 * @param {object} params.assignment
 * @param {Array<object>} params.submissions - List of latest submissions
 * @param {Array<object>} params.roster - Students on class roster
 * @param {object} [params.course]
 * @param {Record<string, string>} [params.feedbackLinksMap] - Map of student_id -> feedback URL
 * @param {Record<string, string>} [params.assignmentLinksMap] - Map of student_id -> take URL with params
 * @param {boolean} [params.includeAccessCodes] - Opt-in to include AccessCode column
 * @returns {{ headers: string[], rows: object[] }}
 */
export function buildMailMergeExportRows({
  assignment,
  submissions = [],
  roster = [],
  course = null,
  feedbackLinksMap = {},
  assignmentLinksMap = {},
  includeAccessCodes = false
}) {
  const latestSubMap = new Map();
  (submissions || []).forEach(s => {
    if (s.is_latest !== false) {
      latestSubMap.set(String(s.student_id).toUpperCase(), s);
    }
  });

  const headers = [...MAIL_MERGE_CSV_HEADERS];
  if (includeAccessCodes) {
    headers.push('AccessCode');
  }

  const rows = (roster || []).map(student => {
    const sub = latestSubMap.get(String(student.student_id).toUpperCase());
    const fullName = student.full_name || '';
    const parsedName = splitName(fullName);
    const firstName = student.given_name || parsedName.given;
    const lastName = student.family_name || parsedName.family;

    let status = 'NotSubmitted';
    let score = '';
    let maxScore = totalPoints(assignment) || '';
    let percent = '';
    let feedback = '';
    let feedbackLink = '';

    if (sub) {
      status = 'Submitted';
      const scoreInfo = finalScore(assignment, sub);
      score = scoreInfo.earned;
      maxScore = scoreInfo.possible;
      percent = maxScore > 0 ? Number(((score / maxScore) * 100).toFixed(1)) : 100.0;
      feedback = feedbackSummary(assignment, sub);
      feedbackLink = feedbackLinksMap[student.student_id] || feedbackLinksMap[String(student.student_id).toUpperCase()] || '';
    }

    const row = {
      Email: student.email || '',
      FirstName: firstName,
      LastName: lastName,
      FullName: fullName,
      StudentID: student.student_id || '',
      Class: course?.name || '',
      Assignment: assignment?.title || '',
      DueDate: assignment?.settings?.due_date || '',
      Status: status,
      Score: score,
      MaxScore: maxScore,
      Percent: percent,
      Feedback: feedback,
      Link: feedbackLink,
      AssignmentLink: assignmentLinksMap[student.student_id] || assignmentLinksMap[String(student.student_id).toUpperCase()] || ''
    };

    if (includeAccessCodes) {
      row.AccessCode = student.access_code || '';
    }

    return row;
  });

  return { headers, rows };
}

/**
 * Build rows for Not Submitted CSV (Appendix B.6)
 *
 * @param {object} params
 * @param {object} params.assignment
 * @param {Array<object>} params.roster - Students on class roster who have not submitted
 * @param {Record<string, string>} [params.assignmentLinksMap] - Map of student_id -> take URL with params
 * @returns {{ headers: string[], rows: object[] }}
 */
export function buildNotSubmittedExportRows({
  assignment,
  roster = [],
  assignmentLinksMap = {}
}) {
  const headers = [...NOT_SUBMITTED_CSV_HEADERS];

  const rows = (roster || []).map(student => {
    const fullName = student.full_name || '';
    const parsedName = splitName(fullName);
    const firstName = student.given_name || parsedName.given;
    const lastName = student.family_name || parsedName.family;

    return {
      Email: student.email || '',
      FirstName: firstName,
      LastName: lastName,
      FullName: fullName,
      StudentID: student.student_id || '',
      Assignment: assignment?.title || '',
      DueDate: assignment?.settings?.due_date || '',
      Link: assignmentLinksMap[student.student_id] || assignmentLinksMap[String(student.student_id).toUpperCase()] || ''
    };
  });

  return { headers, rows };
}
