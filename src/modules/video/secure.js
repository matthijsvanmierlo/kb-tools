import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { KioskReportEngine } from './kiosk-report.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { StudentMatcher } from '../../core/student-matcher.js';

/**
 * Video Assessment Security (KB-VID-004)
 *
 * 1. Student payloads never contain the answer key. Choice checkpoints carry a salted hash of
 *    the correct option set and open responses carry salted keyword hashes, so the kiosk can
 *    give instant feedback without shipping plaintext answers. With instant feedback turned off,
 *    no correctness data is shipped at all.
 * 2. Receipts (.kbr v2) are encrypted to the teacher's public key and signed with the student's
 *    access code (same scheme as Assignments). On import the teacher's device re-grades every
 *    response from the real key, so editing a score inside a receipt achieves nothing.
 * 3. Legacy v1 receipts (plain SHA-256 digest, which anyone can recompute) still open, but are
 *    reported as unverifiable.
 *
 * No DOM or storage access here; callers pass in lookups so this stays unit-testable.
 */

export const RECEIPT_KIND = 'video-receipt';

export function normalizePhrase(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** All 1–3 word phrases in a response, normalized, for matching multi-word keywords like "red spot" */
export function phrasesOf(text, maxWords = 3) {
  const words = normalizePhrase(text).split(' ').filter(Boolean);
  const out = new Set();
  for (let n = 1; n <= maxWords; n++) {
    for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  }
  // Simple plural tolerance for single words: "gases" → "gas", "planets" → "planet"
  for (const w of words) {
    if (w.length > 3 && w.endsWith('es')) out.add(w.slice(0, -2));
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) out.add(w.slice(0, -1));
  }
  return out;
}

const choiceKey = (cpId, ids) => `${cpId}|${[...ids].sort().join(',')}`;
const keywordKey = (cpId, kw) => `${cpId}|kw|${normalizePhrase(kw)}`;

/** Points a checkpoint is worth; notes are informational and never scored */
export function checkpointPoints(cp) {
  if (cp.type === 'note') return 0;
  return Number(cp.points) > 0 ? Number(cp.points) : 1;
}

export function maxScoreOf(checkpoints) {
  return (checkpoints || []).reduce((sum, cp) => sum + checkpointPoints(cp), 0);
}

/**
 * Build the student-safe payload for sharing or for a local kiosk session.
 * @param {object} assessment - full teacher record (with is_correct / keywords)
 * @param {object} opts
 * @param {{ publicJwk: object, fingerprint: string }} opts.teacherKeys
 * @param {Record<string,string>|null} [opts.rosterChecks] - STUDENT_ID_UPPER → access-code check value
 * @param {boolean} [opts.instantFeedback=true]
 */
export async function buildStudentVideoPayload(assessment, { teacherKeys, rosterChecks = null, instantFeedback = true }) {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b => b.toString(16).padStart(2, '0')).join('');
  const checkpoints = [];

  for (const cp of assessment.checkpoints || []) {
    const base = {
      id: cp.id,
      timestamp_sec: cp.timestamp_sec,
      type: cp.type,
      prompt_markdown: cp.prompt_markdown || '',
      points: checkpointPoints(cp)
    };
    if (cp.type === 'single_choice' || cp.type === 'multi_choice') {
      base.options = (cp.options || []).map(o => ({
        id: o.id,
        text: o.text,
        ...(instantFeedback && o.rationale ? { rationale: o.rationale } : {})
      }));
      if (instantFeedback) {
        const correct = (cp.options || []).filter(o => o.is_correct).map(o => o.id);
        base.answer_check = await SubmissionCrypto.hashAnswer(salt, choiceKey(cp.id, correct));
      }
    } else if (cp.type === 'open_response') {
      const keywords = (cp.keywords || []).map(normalizePhrase).filter(Boolean);
      base.auto_graded = keywords.length > 0;
      if (instantFeedback && keywords.length) {
        base.keyword_checks = await Promise.all(keywords.map(k => SubmissionCrypto.hashAnswer(salt, keywordKey(cp.id, k))));
      }
    }
    checkpoints.push(base);
  }

  return {
    version: 2,
    id: assessment.id,
    title: assessment.title,
    description: assessment.description || '',
    class_id: assessment.class_id || null,
    provider: assessment.provider,
    video_source: assessment.video_source,
    checkpoints,
    secure: {
      v: 1,
      salt,
      instant_feedback: !!instantFeedback,
      teacher_public_key: teacherKeys.publicJwk,
      key_fingerprint: teacherKeys.fingerprint,
      roster_checks: rosterChecks && Object.keys(rosterChecks).length ? rosterChecks : null,
      published_at: new Date().toISOString()
    }
  };
}

/**
 * Instant check for a choice checkpoint in a student payload.
 * @returns {Promise<boolean|null>} null when the payload carries no correctness data
 */
export async function checkChoiceAnswer(cp, selectedIds, salt) {
  if (!cp.answer_check || !salt) return null;
  return (await SubmissionCrypto.hashAnswer(salt, choiceKey(cp.id, selectedIds))) === cp.answer_check;
}

/** Instant keyword check for an open response; null when not auto-graded or feedback is off */
export async function checkKeywords(cp, text, salt) {
  if (!cp.keyword_checks || !cp.keyword_checks.length || !salt) return null;
  const wanted = new Set(cp.keyword_checks);
  for (const phrase of phrasesOf(text)) {
    if (wanted.has(await SubmissionCrypto.hashAnswer(salt, keywordKey(cp.id, phrase)))) return true;
  }
  return false;
}

/**
 * Authoritative grading from the teacher's full record. Never trusts client-side scores.
 * @param {object} assessment - teacher record with answer key
 * @param {Array<{ checkpointId: string, studentAnswer: any }>} responses
 */
export function gradeVideoResponses(assessment, responses) {
  const byId = new Map((responses || []).map(r => [r.checkpointId, r]));
  let earned = 0;
  let max = 0;
  const perCheckpoint = [];

  for (const cp of assessment.checkpoints || []) {
    const possible = checkpointPoints(cp);
    max += possible;
    const resp = byId.get(cp.id);
    let isCorrect = null;
    let got = 0;

    if (cp.type === 'single_choice' || cp.type === 'multi_choice') {
      const selected = Array.isArray(resp?.studentAnswer) ? resp.studentAnswer : (resp?.studentAnswer ? [resp.studentAnswer] : []);
      const correct = (cp.options || []).filter(o => o.is_correct).map(o => o.id);
      isCorrect = selected.length > 0 && correct.length === selected.length && correct.every(id => selected.includes(id));
      got = isCorrect ? possible : 0;
    } else if (cp.type === 'open_response') {
      const text = typeof resp?.studentAnswer === 'string' ? resp.studentAnswer : '';
      const keywords = (cp.keywords || []).map(normalizePhrase).filter(Boolean);
      if (!text.trim()) {
        isCorrect = false;
      } else if (keywords.length === 0) {
        isCorrect = true; // completion credit, matching the kiosk's original behaviour
      } else {
        const phrases = phrasesOf(text);
        isCorrect = keywords.some(k => phrases.has(k));
      }
      got = isCorrect ? possible : 0;
    }

    earned += got;
    perCheckpoint.push({ checkpointId: cp.id, type: cp.type, earned: got, possible, isCorrect, answered: !!resp, studentAnswer: resp?.studentAnswer ?? null });
  }

  return { earned, max, percent: max > 0 ? Math.round((earned / max) * 100) : 0, perCheckpoint };
}

/**
 * Build an encrypted, access-code-signed receipt for the teacher.
 * @returns {Promise<{ text: string, filename: string, body: object }>}
 */
export async function createSecureReceipt({ payload, studentName, studentId, accessCode, responseLogs }) {
  const sec = payload.secure;
  if (!sec?.teacher_public_key) throw new Error('NO_TEACHER_KEY');
  const clientEarned = responseLogs.reduce((s, r) => s + (Number(r.earnedPoints) || 0), 0);
  const body = {
    kind: RECEIPT_KIND,
    v: 2,
    assignment_id: payload.id, // field name shared with submission-crypto's HMAC salt
    published_at: sec.published_at,
    student_id: String(studentId || '').trim(),
    student_name: String(studentName || '').trim(),
    completed_at: new Date().toISOString(),
    responses: responseLogs.map(r => ({ checkpointId: r.checkpointId, studentAnswer: r.studentAnswer, latencyMs: r.latencyMs })),
    client_score: { earned: clientEarned, max: maxScoreOf(payload.checkpoints) }
  };
  const signature = accessCode ? await SubmissionCrypto.signWithAccessCode(body, accessCode) : null;
  const envelope = await SubmissionCrypto.encryptForTeacher(sec.teacher_public_key, { body, signature }, { kind: RECEIPT_KIND, assessment_id: payload.id });
  return {
    text: SubmissionCrypto.serializeEnvelope(envelope),
    filename: `${(studentName || 'student').replace(/[^a-z0-9]+/gi, '_')}_${(payload.title || 'video').replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.kbr`,
    body
  };
}

function looksLikeEnvelope(text) {
  const t = String(text || '').trim();
  return t.startsWith('KBSUB1.') || t.startsWith('{"kbsub"') || t.startsWith('{\n  "kbsub"');
}

/**
 * Open and verify a .kbr receipt on the teacher's device.
 *
 * @param {string} text - file contents
 * @param {object} ctx
 * @param {CryptoKey|object} ctx.teacherPrivateKey
 * @param {(id: string) => Promise<object|null>} ctx.getAssessment - teacher record lookup
 * @param {(courseId: string) => Promise<object[]>} ctx.getStudents - roster lookup
 * @returns {Promise<object>} { ok, format: 'v2'|'legacy', error?, studentName, studentId, identity, earned, max, percent, completedAt, assessment, detail }
 */
export async function openReceipt(text, { teacherPrivateKey, getAssessment, getStudents }) {
  if (looksLikeEnvelope(text)) {
    let opened;
    try {
      opened = await SubmissionCrypto.decryptFromStudent(teacherPrivateKey, SubmissionCrypto.parseEnvelope(text));
    } catch (err) {
      return { ok: false, format: 'v2', error: err.message === 'DECRYPTION_FAILED' ? 'NOT_FOR_THIS_TEACHER' : 'CORRUPTED_RECEIPT' };
    }
    const { body, signature } = opened || {};
    if (!body || body.kind !== RECEIPT_KIND) return { ok: false, format: 'v2', error: 'NOT_A_VIDEO_RECEIPT' };

    const assessment = await getAssessment(body.assignment_id);
    if (!assessment) return { ok: false, format: 'v2', error: 'ASSESSMENT_NOT_FOUND', studentName: body.student_name, studentId: body.student_id };

    const graded = gradeVideoResponses(assessment, body.responses);

    let identity = 'unsigned';
    let rosterStudent = null;
    if (assessment.class_id && (body.student_id || body.student_name)) {
      const roster = await getStudents(assessment.class_id);
      const matchResult = await StudentMatcher.resolveStudentForSubmission({
        body,
        signature,
        roster
      });
      rosterStudent = matchResult.matchedStudent || null;
      if (matchResult.identity === 'verified') identity = 'verified';
      else if (matchResult.identity === 'code_mismatch') identity = 'code_mismatch';
      else if (!rosterStudent) identity = 'not_in_roster';
      else if (!rosterStudent.access_code) identity = signature ? 'no_code_on_file' : 'unsigned';
      else identity = matchResult.identity;
    }

    return {
      ok: true,
      format: 'v2',
      studentName: body.student_name,
      studentId: body.student_id,
      rosterStudent,
      identity,
      earned: graded.earned,
      max: graded.max,
      percent: graded.percent,
      // Student-controlled: coerce so it can only ever be rendered as a number
      clientScore: body.client_score
        ? { earned: Sanitizer.safeNumber(body.client_score.earned), max: Sanitizer.safeNumber(body.client_score.max) }
        : null,
      completedAt: body.completed_at,
      assessment,
      detail: graded.perCheckpoint
    };
  }

  // Legacy v1: plain digest, which a student can recompute after editing — never trusted
  const legacy = await KioskReportEngine.verifyReceipt(text);
  if (!legacy.receipt) return { ok: false, format: 'legacy', error: legacy.error };
  const r = legacy.receipt;
  return {
    ok: legacy.isValid,
    format: 'legacy',
    error: legacy.isValid ? null : legacy.error,
    studentName: r.studentName,
    studentId: r.studentId || '',
    identity: 'legacy',
    // Student-controlled values: coerce to numbers at the source
    earned: Sanitizer.safeNumber(r.totalScore),
    max: Sanitizer.safeNumber(r.maxScore),
    percent: Sanitizer.safeNumber(r.percent),
    completedAt: r.completedAt,
    assessment: null,
    detail: null
  };
}

export const IDENTITY_LABELS = {
  verified: { text: 'Verified', tone: 'emerald', help: 'Signed with this student\'s access code.' },
  code_mismatch: { text: 'Code mismatch', tone: 'rose', help: 'Not signed with this student\'s current access code — possibly submitted by someone else.' },
  no_code_on_file: { text: 'No code on file', tone: 'amber', help: 'The student has no access code in your roster, so identity can\'t be checked.' },
  not_in_roster: { text: 'Not in roster', tone: 'amber', help: 'No student with this ID in the linked class.' },
  unsigned: { text: 'Unsigned', tone: 'amber', help: 'Submitted without an access code.' },
  legacy: { text: 'Old format', tone: 'amber', help: 'Created before receipts were encrypted; the score inside can be edited by the student and cannot be verified.' }
};
