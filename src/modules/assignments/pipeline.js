import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { normalizeAccessCode } from '../../core/access-codes.js';
import { generateUUID } from '../../utils/uuid.js';
import { gradeSubmission } from './grading.js';

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

  const student = roster.find(s => String(s.student_id).toUpperCase() === String(body.student_id).toUpperCase());
  let identity;
  if (!student) identity = 'not_in_roster';
  else if (!student.access_code) identity = 'no_code_on_file';
  else identity = (await SubmissionCrypto.verifyAccessCodeSignature(body, signature, student.access_code)) ? 'verified' : 'code_mismatch';

  // Never trust client_score: grade again from the key that only the teacher holds
  const auto = gradeSubmission(assignment, body.answers || {});

  return {
    id: generateUUID(),
    assignment_id: assignment.id,
    student_id: student ? student.student_id : body.student_id,
    student_name: student ? student.full_name : body.student_name,
    claimed_name: body.student_name,
    submitted_at: body.submitted_at,
    started_at: body.started_at,
    received_at: new Date().toISOString(),
    publish_version: body.publish_version,
    stale_version: (assignment.publish?.version || 1) !== body.publish_version,
    answers: body.answers || {},
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
  not_in_roster: { label: 'Not in roster', tone: 'amber', icon: 'person-x', help: 'The student ID does not match anyone in the linked class.' }
};

export const DECRYPT_ERRORS = {
  NOT_A_SUBMISSION: 'This is not a KennisBoost submission code or .kbsub file.',
  DECRYPTION_FAILED: 'This submission was encrypted for a different teacher key (another device, or a key that was reset) and cannot be opened here.',
  WRONG_ASSIGNMENT: 'This submission belongs to a different assignment.'
};
