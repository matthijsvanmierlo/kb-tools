/**
 * Video Receipt Importer (KB-VID-007)
 * Decrypts, verifies, grades, and records video assessment receipts (.kbr) into the gradebook.
 */

import { storage } from '../../core/storage.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { GradebookBridge } from '../gradebook/bridge.js';
import { openReceipt, IDENTITY_LABELS } from './secure.js';

export const RECEIPT_ERROR_TEXT = {
  NOT_FOR_THIS_TEACHER: 'encrypted for a different teacher key (another device or browser profile)',
  CORRUPTED_RECEIPT: 'damaged or incomplete file',
  NOT_A_VIDEO_RECEIPT: 'not a video assessment receipt',
  ASSESSMENT_NOT_FOUND: 'its video assessment is not in your library',
  CRYPTOGRAPHIC_SIGNATURE_MISMATCH: 'contents were changed after it was created',
  CORRUPTED_OR_INVALID_FILE: 'not a readable receipt'
};

export function receiptErrorText(code) {
  return RECEIPT_ERROR_TEXT[code] || 'could not be read';
}

/**
 * Import a collection of video receipt text files into a course gradebook.
 *
 * @param {object} options
 * @param {Array<string|{source?: string, file?: string, text: string}>} options.texts
 * @param {object} options.course
 * @param {Array<object>} options.students
 * @param {Array<object>} options.assignments
 * @param {Map<string, object>} [options.gradesMap]
 * @param {'auto'|string} [options.mode='auto'] - 'auto' creates/links columns automatically, or a specific assignment ID
 * @param {boolean} [options.allowLegacy=false]
 * @param {object} [options.keys]
 * @returns {Promise<{
 *   imported: number,
 *   createdColumns: boolean,
 *   problems: Array<string>
 * }>}
 */
export async function importVideoReceipts({
  texts,
  course,
  students,
  assignments = [],
  gradesMap,
  mode = 'auto',
  allowLegacy = false,
  keys
}) {
  if (!keys) {
    keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
  }

  const autoColumns = mode === 'auto' || mode === '__auto';
  const chosenColumn = !autoColumns ? assignments.find(a => a.id === mode) : null;

  const ctx = {
    teacherPrivateJwk: keys.privateJwk,
    getAssessment: (id) => storage.table('video_assessments').get(id),
    getStudents: (courseId) => storage.table('gradebook_students').where('course_id').equals(courseId).toArray()
  };

  const opened = [];
  for (const item of (texts || [])) {
    const rawText = typeof item === 'string' ? item : item?.text;
    const file = typeof item === 'string' ? 'Pasted code' : (item?.source || item?.file || 'file.kbr');
    if (!rawText) continue;

    try {
      opened.push({ file, result: await openReceipt(rawText, ctx) });
    } catch (err) {
      opened.push({ file, result: { ok: false, error: 'CORRUPTED_RECEIPT' } });
    }
  }

  const problems = [];
  let imported = 0;
  let createdColumns = false;

  for (const { file, result: r } of opened) {
    if (!r.ok) {
      problems.push(`${file}: ${receiptErrorText(r.error)}`);
      continue;
    }
    if (r.format === 'legacy' && !allowLegacy) continue;
    if (autoColumns && r.format === 'legacy') {
      problems.push(`${file}: old-format receipts need a specific column — import again and choose one`);
      continue;
    }

    // Target column: the chosen one, or a column linked to this video (created on first import)
    let targetAssignment = chosenColumn;
    if (autoColumns) {
      targetAssignment = assignments.find(a => a.source?.type === 'video' && a.source.id === r.assessment?.id);
      if (!targetAssignment && r.assessment) {
        targetAssignment = await GradebookBridge.upsertLinkedColumn({
          courseId: course.id,
          source: { type: 'video', id: r.assessment.id },
          title: r.assessment.title,
          maxScore: r.max
        });
        assignments.push(targetAssignment);
        createdColumns = true;
      }
    }

    if (!targetAssignment) {
      problems.push(`${file}: no gradebook column found for this video assessment`);
      continue;
    }

    if (r.format === 'v2' && targetAssignment.source?.type === 'video' && targetAssignment.source.id !== r.assessment?.id) {
      problems.push(`${file}: receipt is for "${r.assessment?.title}", not this column`);
      continue;
    }

    // Match by student ID first; fall back to name only for legacy receipts without IDs
    const matchedStudent = students.find(s => r.studentId && String(s.student_id).toLowerCase() === String(r.studentId).toLowerCase())
      || (r.format === 'legacy' ? students.find(s => s.full_name && s.full_name.toLowerCase() === (r.studentName || '').toLowerCase()) : null);

    if (!matchedStudent) {
      problems.push(`${file}: ${r.studentName || 'unknown student'} is not in this class`);
      continue;
    }
    if (r.identity === 'code_mismatch') {
      problems.push(`${file}: not signed with ${matchedStudent.full_name}'s access code — skipped`);
      continue;
    }

    // Scale the video score onto this column's points
    const max = Number(targetAssignment.max_score) || r.max || 1;
    const raw = r.max > 0 ? Math.round((r.earned / r.max) * max * 10) / 10 : 0;
    const key = `${matchedStudent.student_id}+${targetAssignment.id}`;
    const existing = gradesMap ? gradesMap.get(key) || {} : {};
    const identityNote = r.format === 'legacy' ? 'old-format receipt, unverified' : (IDENTITY_LABELS[r.identity]?.text || r.identity).toLowerCase();

    const gradeRec = {
      ...existing,
      course_id: course.id,
      student_id: matchedStudent.student_id,
      assignment_id: targetAssignment.id,
      raw_score: raw,
      status: existing.status === 'late' ? 'late' : 'submitted',
      feedback: existing.feedback || `Video assessment: ${r.earned} / ${r.max} (${r.percent}%) — ${identityNote}.`,
      receipt: { format: r.format, identity: r.identity, completed_at: r.completedAt, earned: r.earned, max: r.max }
    };

    if (gradesMap) {
      gradesMap.set(key, gradeRec);
    }
    await storage.table('gradebook_grades').put(gradeRec);
    imported++;

    if (r.identity && !['verified', 'legacy'].includes(r.identity)) {
      problems.push(`${file}: imported, but identity is "${IDENTITY_LABELS[r.identity]?.text || r.identity}"`);
    }
  }

  return { imported, createdColumns, problems };
}

export default importVideoReceipts;
