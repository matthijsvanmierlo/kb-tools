import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { normalizeAccessCode } from '../../core/access-codes.js';
import { generateUUID } from '../../utils/uuid.js';
import { StudentMatcher } from '../../core/student-matcher.js';
import { daysLate } from '../assignments/pipeline.js';

export { daysLate };

/**
 * Validate a typed access code against the check value published with the task.
 * @returns {Promise<'ok'|'mismatch'|'unknown_student'|'not_checked'>}
 */
export async function checkTaskAccessCode(payload, studentId, accessCode) {
  if (!payload.roster_checks) return 'not_checked';
  const expected = payload.roster_checks[String(studentId).trim().toUpperCase()];
  if (!expected) return 'unknown_student';
  const got = await SubmissionCrypto.accessCodeCheck(payload.task_id, String(studentId).trim(), accessCode);
  return got === expected ? 'ok' : 'mismatch';
}

/**
 * Build the encrypted submission a student hands in for a task.
 * @returns {Promise<{ envelope: object, text: string, body: object }>}
 */
export async function createTaskSubmission(arg1, arg2, arg3, arg4) {
  let payload, studentId, studentName, accessCode, content, startedAt, clientScore, commitment;
  if (arg1 && arg1.payload) {
    ({ payload, studentId, studentName, accessCode, content, startedAt, clientScore, commitment } = arg1);
  } else {
    payload = arg1;
    const student = arg2 || {};
    studentId = student.id || student.studentId || '';
    studentName = student.name || student.studentName || '';
    accessCode = student.code || student.accessCode || '';
    content = arg3;
    if (arg4) {
      startedAt = arg4.startedAt;
      clientScore = arg4.clientScore;
      commitment = arg4.commitment;
    }
  }

  const body = {
    id: generateUUID(),
    task_id: payload.task_id,
    publish_version: payload.publish_version,
    student_id: String(studentId).trim(),
    student_name: String(studentName || '').trim(),
    started_at: startedAt || null,
    submitted_at: new Date().toISOString(),
    content: content || { text: '', code_files: [], attachments: [], drawing: null },
    client_score: clientScore,
    commitment: commitment || null
  };
  const signature = normalizeAccessCode(accessCode)
    ? await SubmissionCrypto.signWithAccessCode(body, accessCode)
    : null;
  const envelope = await SubmissionCrypto.encryptForTeacher(
    payload.teacher_key.publicJwk,
    { body, signature },
    { kind: 'task', task_id: payload.task_id, publish_version: payload.publish_version }
  );
  const serialized = SubmissionCrypto.serializeEnvelope(envelope);
  return {
    envelope,
    text: serialized,
    envelopeText: serialized,
    body,
    submission: body
  };
}

/**
 * Decrypt and authenticate one task submission.
 *
 * @param {object} opts
 * @param {string} opts.text - KBSUB1 code or envelope JSON
 * @param {CryptoKey|object} opts.teacherPrivateKey
 * @param {object} opts.task - local teacher record
 * @param {Array<object>} opts.roster - students of the linked course
 * @returns {Promise<object>} submission row for `task_submissions`
 * @throws {Error} NOT_A_SUBMISSION | DECRYPTION_FAILED | WRONG_ASSIGNMENT
 */
export async function evaluateTaskSubmission({ text, teacherPrivateKey, task, roster = [] }) {
  let envelope;
  try {
    envelope = SubmissionCrypto.parseEnvelope(text);
  } catch (_) {
    throw new Error('NOT_A_SUBMISSION');
  }
  const header = envelope?.header || {};
  if (header.task_id && header.task_id !== task.id) {
    throw new Error('WRONG_ASSIGNMENT');
  }

  const { body, signature } = await SubmissionCrypto.decryptFromStudent(teacherPrivateKey, envelope);
  if (!body || body.task_id !== task.id) throw new Error('WRONG_ASSIGNMENT');

  const matchResult = await StudentMatcher.resolveStudentForSubmission({
    body,
    signature,
    roster
  });

  const student = matchResult.matchedStudent || null;
  const identity = matchResult.identity;
  const days_late = daysLate(task.settings?.due_date, body.submitted_at);

  return {
    id: generateUUID(),
    task_id: task.id,
    student_id: student ? student.student_id : body.student_id,
    student_name: student ? (student.full_name || student.name) : body.student_name,
    claimed_name: body.student_name,
    suggested_student: matchResult.suggestedStudent || null,
    match_type: matchResult.matchedBy || null,
    match_confidence: matchResult.matchConfidence || 0,
    identity,
    days_late,
    content: body.content || { text_md: '', code: [], attachments: [], drawing: null },
    review: {
      points: null,
      status: 'submitted',
      rubric_eval: {},
      rubric_comments: {},
      standard_scores: {},
      standard_comments: {},
      feedback: '',
      code_comments: {},
      drawing_annotations: null,
      reviewed_at: null
    },
    started_at: body.started_at || null,
    submitted_at: body.submitted_at,
    received_at: new Date().toISOString(),
    synced_at: null,
    returned_at: null,
    is_latest: true,
    publish_version: body.publish_version,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
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
