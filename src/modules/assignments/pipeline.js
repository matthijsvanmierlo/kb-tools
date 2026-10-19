import { SubmissionCrypto, sha256Hex } from '../../core/submission-crypto.js';
import { normalizeAccessCode } from '../../core/access-codes.js';
import { generateUUID } from '../../utils/uuid.js';
import { gradeSubmission } from './grading.js';
import { StudentMatcher } from '../../core/student-matcher.js';

export async function computeAnswersFingerprint(answers) {
  if (!answers || typeof answers !== 'object') return null;
  const entries = Object.entries(answers)
    .filter(([_, v]) => v !== undefined && v !== null && v !== '' && (!Array.isArray(v) || v.length > 0))
    .sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return null;
  const normalized = entries.map(([k, v]) => {
    let str = '';
    if (typeof v === 'string') str = v.trim().toLowerCase().replace(/\s+/g, ' ');
    else if (Array.isArray(v)) str = v.map(x => String(x || '').trim().toLowerCase()).sort().join(',');
    else if (typeof v === 'object' && v !== null) str = JSON.stringify(v);
    else str = String(v);
    return `${k}=${str}`;
  }).join(';');
  return await sha256Hex(normalized);
}

export async function reconcileSubmissionWithAssignment(sub, assignment, roster = null) {
  if (!sub || !assignment) return sub;

  const prevAuto = sub.auto || { earned: 0, possible: 0, per_question: {} };
  const newAuto = gradeSubmission(assignment, sub.answers || {});

  const currentQIds = new Set((assignment.questions || []).map(q => q.id));
  const archived = { ...(sub.archived_answers || {}) };
  for (const [qid, ans] of Object.entries(sub.answers || {})) {
    if (!currentQIds.has(qid)) {
      archived[qid] = ans;
    }
  }

  const manual = { ...(sub.manual || {}) };
  const feedback = sub.feedback || '';

  let identity = sub.identity;
  let student_id = sub.student_id;
  let student_name = sub.student_name;
  let match_type = sub.match_type;
  let match_confidence = sub.match_confidence;
  let suggested_student = sub.suggested_student;

  if (Array.isArray(roster) && roster.length > 0) {
    try {
      const matchResult = await StudentMatcher.resolveStudentForSubmission({
        body: {
          assignment_id: assignment.id,
          student_id: sub.student_id,
          student_name: sub.claimed_name || sub.student_name,
          answers: sub.answers,
          submitted_at: sub.submitted_at
        },
        signature: sub.signature || null,
        roster
      });
      if (matchResult.matchedStudent) {
        student_id = matchResult.matchedStudent.student_id;
        student_name = matchResult.matchedStudent.full_name || matchResult.matchedStudent.name;
      }
      identity = matchResult.identity;
      match_type = matchResult.matchedBy || null;
      match_confidence = matchResult.matchConfidence || 0;
      suggested_student = matchResult.suggestedStudent || null;
    } catch (_) {}
  }

  const scoreChanged = (prevAuto.earned !== newAuto.earned) || (prevAuto.possible !== newAuto.possible);

  return {
    ...sub,
    student_id,
    student_name,
    identity,
    match_type,
    match_confidence,
    suggested_student,
    auto: newAuto,
    manual,
    feedback,
    archived_answers: archived,
    stale_version: (assignment.publish?.version || 1) !== sub.publish_version,
    days_late: daysLate(assignment.settings?.due_date, sub.submitted_at),
    score_reconciled: scoreChanged ? true : (sub.score_reconciled || false),
    synced_at: scoreChanged ? null : sub.synced_at,
    updated_at: scoreChanged ? new Date().toISOString() : (sub.updated_at || sub.received_at)
  };
}

/**
 * Assignment Submission Pipeline (KB-ASSIGN-002)
 *
 * Student side:  answers → access-code HMAC → ECIES encryption to the teacher's key → KBSUB text.
 * Teacher side:  KBSUB text → decrypt → roster match → HMAC check → re-grade from the local key.
 *
 * No DOM and no storage here so the whole round trip is unit-testable.
 */

/**
 * Validate a typed access code against the check value published with the assignment.
 * @returns {'ok'|'mismatch'|'unknown_student'|'not_checked'}
 */
export async function checkAccessCode(payload, studentId, accessCode) {
  if (!payload.roster_checks) return 'not_checked';
  const expected = payload.roster_checks[String(studentId).trim().toUpperCase()];
  if (!expected) return 'unknown_student';
  const got = await SubmissionCrypto.accessCodeCheck(payload.assignment_id, String(studentId).trim(), accessCode);
  return got === expected ? 'ok' : 'mismatch';
}

/**
 * Build the encrypted submission a student hands in.
 * @returns {Promise<{ envelope: object, text: string, body: object }>}
 */
export async function createSubmission({ payload, studentId, studentName, accessCode, answers, startedAt, clientScore = null }) {
  const body = {
    assignment_id: payload.assignment_id,
    publish_version: payload.publish_version,
    student_id: String(studentId).trim(),
    student_name: String(studentName || '').trim(),
    started_at: startedAt || null,
    submitted_at: new Date().toISOString(),
    answers: answers || {},
    client_score: clientScore
  };
  const signature = normalizeAccessCode(accessCode)
    ? await SubmissionCrypto.signWithAccessCode(body, accessCode)
    : null;
  const envelope = await SubmissionCrypto.encryptForTeacher(
    payload.teacher_key.publicJwk,
    { body, signature },
    { assignment_id: payload.assignment_id, publish_version: payload.publish_version }
  );
  return { envelope, text: SubmissionCrypto.serializeEnvelope(envelope), body };
}

/**
 * Split pasted text or file contents into individual submissions. Accepts KBSUB1 codes separated
 * by whitespace, or one raw JSON envelope.
 */
export function splitSubmissionText(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const codes = t.match(/KBSUB1\.[A-Za-z0-9_-]+/g);
  if (codes) return codes;
  return [t];
}

/**
 * Days between the due date (end of day, local) and submission time; 0 when on time.
 */
export function daysLate(dueDate, submittedAt) {
  if (!dueDate || !submittedAt) return 0;
  const due = new Date(`${dueDate}T23:59:59`);
  const sub = new Date(submittedAt);
  if (Number.isNaN(due.getTime()) || Number.isNaN(sub.getTime()) || sub <= due) return 0;
  return Math.ceil((sub - due) / 86400000);
}

/**
 * Decrypt, authenticate and re-grade one submission.
 *
 * @param {object} opts
 * @param {string} opts.text - KBSUB1 code or envelope JSON
 * @param {CryptoKey|object} opts.teacherPrivateKey
 * @param {object} opts.assignment - local teacher record with the true answer key
 * @param {Array<object>} opts.roster - students of the linked course
 * @returns {Promise<object>} submission row for `assignment_submissions`
 * @throws {Error} NOT_A_SUBMISSION | DECRYPTION_FAILED | WRONG_ASSIGNMENT
 */
export async function evaluateSubmission({ text, teacherPrivateKey, assignment, roster = [] }) {
  let envelope;
  try {
    envelope = SubmissionCrypto.parseEnvelope(text);
  } catch (_) {
    throw new Error('NOT_A_SUBMISSION');
  }
  if (envelope?.header?.assignment_id && envelope.header.assignment_id !== assignment.id) {
    throw new Error('WRONG_ASSIGNMENT');
  }

  const { body, signature } = await SubmissionCrypto.decryptFromStudent(teacherPrivateKey, envelope);
  if (!body || body.assignment_id !== assignment.id) throw new Error('WRONG_ASSIGNMENT');

  const matchResult = await StudentMatcher.resolveStudentForSubmission({
    body,
    signature,
    roster
  });

  const student = matchResult.matchedStudent || null;
  const identity = matchResult.identity;

  // Never trust client_score: grade again from the key that only the teacher holds
  const auto = gradeSubmission(assignment, body.answers || {});
  const answers_fingerprint = await computeAnswersFingerprint(body.answers || {});

  return {
    id: generateUUID(),
    assignment_id: assignment.id,
    student_id: student ? student.student_id : body.student_id,
    student_name: student ? (student.full_name || student.name) : body.student_name,
    claimed_name: body.student_name,
    suggested_student: matchResult.suggestedStudent || null,
    match_type: matchResult.matchedBy || null,
    match_confidence: matchResult.matchConfidence || 0,
    submitted_at: body.submitted_at,
    started_at: body.started_at,
    received_at: new Date().toISOString(),
    publish_version: body.publish_version,
    stale_version: (assignment.publish?.version || 1) !== body.publish_version,
    answers: body.answers || {},
    signature: signature || null,
    answers_fingerprint,
    client_score: body.client_score ?? null,
    auto,
    manual: {},
    feedback: '',
    identity,
    days_late: daysLate(assignment.settings?.due_date, body.submitted_at),
    synced_at: null,
    is_latest: true
  };
}

export const IDENTITY_LABELS = {
  verified: { label: 'Verified', tone: 'emerald', icon: 'patch-check', help: 'Signed with this student\'s access code.' },
  code_mismatch: { label: 'Code mismatch', tone: 'rose', icon: 'exclamation-triangle', help: 'The access code used does not match this student. Someone else may have submitted under this name.' },
  no_code_on_file: { label: 'Unverified', tone: 'amber', icon: 'question-circle', help: 'This student has no access code yet, so identity could not be checked.' },
  suggested_match: { label: 'Suggested match', tone: 'indigo', icon: 'person-check', help: 'Auto-detected likely student based on name or LMS pattern.' },
  not_in_roster: { label: 'Not in roster', tone: 'amber', icon: 'person-x', help: 'The student ID does not match anyone in the linked class.' }
};

export const DECRYPT_ERRORS = {
  NOT_A_SUBMISSION: 'This is not a KennisBoost submission code or .kbsub file.',
  DECRYPTION_FAILED: 'This submission was encrypted for a different teacher key (another device, or a key that was reset) and cannot be opened here.',
  WRONG_ASSIGNMENT: 'This submission belongs to a different assignment.'
};
