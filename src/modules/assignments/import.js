/**
 * Reusable assignment submission importer (KB-ASSIGN-007)
 * Decrypts, verifies, and records submissions in Dexie storage.
 */

import { storage } from '../../core/storage.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { evaluateSubmission, DECRYPT_ERRORS } from './pipeline.js';

/**
 * Import an array of submission text records for an assignment.
 *
 * @param {object} options
 * @param {object} options.assignment - The assignment entity
 * @param {Array<string|{text: string, source?: string}>} options.texts - Raw submission texts or objects
 * @param {Array<object>} [options.roster] - List of students in the linked class
 * @param {object} [options.keys] - Optional teacher keypair; fetched from storage if omitted
 * @returns {Promise<{
 *   added: number,
 *   duplicates: number,
 *   errors: Array<{ source: string, message: string, error?: any }>,
 *   rows: Array<object>
 * }>}
 */
export async function importSubmissionTexts({ assignment, texts, roster = [], keys }) {
  if (!keys) {
    keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
  }

  const existingSubmissions = await storage.table('assignment_submissions')
    .where('assignment_id').equals(assignment.id)
    .toArray()
    .catch(() => []);

  const errors = [];
  const rows = [];
  let added = 0;
  let duplicates = 0;

  for (const item of (texts || [])) {
    const text = typeof item === 'string' ? item : item?.text;
    const source = typeof item === 'string' ? 'Pasted code' : (item?.source || 'File');

    if (!text) continue;

    try {
      const sub = await evaluateSubmission({
        text,
        teacherPrivateJwk: keys.privateJwk,
        assignment,
        roster
      });

      const dupe = existingSubmissions.find(s => s.student_id === sub.student_id && s.submitted_at === sub.submitted_at);
      if (dupe) {
        duplicates++;
        continue;
      }

      // Mark older submissions from the same student as not latest
      for (const prev of existingSubmissions.filter(s => String(s.student_id).toUpperCase() === String(sub.student_id).toUpperCase() && s.is_latest !== false)) {
        if ((prev.submitted_at || '') < (sub.submitted_at || '')) {
          prev.is_latest = false;
          await storage.table('assignment_submissions').put(prev);
        } else {
          sub.is_latest = false;
        }
      }

      await storage.table('assignment_submissions').put(sub);
      existingSubmissions.push(sub);
      rows.push(sub);
      added++;
    } catch (err) {
      errors.push({
        source,
        message: DECRYPT_ERRORS[err.message] || err.message,
        error: err
      });
    }
  }

  return { added, duplicates, errors, rows };
}

export default importSubmissionTexts;
