/**
 * FeedbackCapsule - KB-FEEDBACK-001
 *
 * Proposal #1: Blind Dead-Drop Feedback Mailbox & Offline Class Capsules (.kbclasspack)
 *
 * Facilitates zero-knowledge delivery of grades, rubric criteria, vector drawings,
 * line code comments, and voice notes back to students without cloud accounts.
 *
 * 1. Blind Dead-Drop:
 *    DropID = SHA-256(TeacherDropSecret | StudentAccessCode)
 *    Teacher uploads encrypted envelope to PUT /feedback/:dropId.
 *    Student queries GET /feedback/:dropId with their own access code.
 *
 * 2. Offline Class Capsule (.kbclasspack):
 *    Single JSON package containing encrypted capsules for all roster students.
 *    Student imports file; personal access code decrypts ONLY their own feedback.
 */

import { CryptoShareEngine } from './crypto-share.js';
import { normalizeAccessCode } from './access-codes.js';
import { storage } from './storage.js';

const subtle = () => {
  const s = typeof crypto !== 'undefined' ? crypto.subtle : globalThis.crypto?.subtle;
  if (!s) throw new Error('Web Crypto API is not available');
  return s;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToB64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64ToBytes(b64) {
  const norm = String(b64).replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '==='.slice((norm.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(text) {
  const buf = await subtle().digest('SHA-256', enc.encode(String(text)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export class FeedbackCapsule {
  /**
   * Derive blind pseudonym drop ID for relay lookup.
   * Neither relay nor eavesdroppers can determine student identity from this hash.
   *
   * @param {string} assignmentId
   * @param {string} studentAccessCode
   * @returns {Promise<string>} 64-char hex string
   */
  static async deriveBlindDropId(assignmentId, studentAccessCode) {
    const normCode = normalizeAccessCode(studentAccessCode);
    const key = `kb-fb-drop|${String(assignmentId || '').trim()}|${normCode}`;
    return await sha256Hex(key);
  }

  /**
   * Encrypt a student's feedback object using their private access code.
   *
   * @param {object} feedbackData
   * @param {string} studentAccessCode
   * @returns {Promise<object>} self-describing envelope
   */
  static async createFeedbackEnvelope(feedbackData, studentAccessCode) {
    const normCode = normalizeAccessCode(studentAccessCode);
    if (!normCode) {
      throw new Error('Valid student access code is required to encrypt feedback.');
    }

    const shareResult = await CryptoShareEngine.createSharePayload(
      'student_feedback',
      feedbackData,
      normCode
    );

    let d = '';
    try {
      const parsed = JSON.parse(shareResult.rawFileContent);
      d = parsed.d;
    } catch (_) {
      throw new Error('Failed to pack encrypted feedback payload.');
    }

    const envelope = {
      kbfb: 1,
      v: shareResult.version || 2,
      format: 'encrypted',
      assignment_id: feedbackData.assignment_id || null,
      student_id: feedbackData.student_id ? String(feedbackData.student_id).toUpperCase() : null,
      reviewed_at: feedbackData.reviewed_at || new Date().toISOString(),
      d
    };

    const token = `KBFB1.${bytesToB64(enc.encode(JSON.stringify(envelope)))}`;
    return { envelope, token };
  }

  /**
   * Open and decrypt a feedback envelope using student's access code.
   *
   * @param {string|object} envelopeOrToken
   * @param {string} studentAccessCode
   * @returns {Promise<object>} decrypted feedback data
   */
  static async openFeedbackEnvelope(envelopeOrToken, studentAccessCode) {
    const normCode = normalizeAccessCode(studentAccessCode);
    if (!normCode) {
      throw new Error('Valid student access code is required to decrypt feedback.');
    }

    let envelope = envelopeOrToken;
    if (typeof envelopeOrToken === 'string') {
      const trimmed = envelopeOrToken.trim();
      if (trimmed.startsWith('KBFB1.')) {
        try {
          envelope = JSON.parse(dec.decode(b64ToBytes(trimmed.slice(6).replace(/\s+/g, ''))));
        } catch (_) {
          throw new Error('MALFORMED_FEEDBACK_TOKEN');
        }
      } else {
        try {
          envelope = JSON.parse(trimmed);
        } catch (_) {
          throw new Error('INVALID_FEEDBACK_JSON');
        }
      }
    }

    if (!envelope || !envelope.d) {
      throw new Error('INVALID_FEEDBACK_ENVELOPE');
    }

    const unpacked = await CryptoShareEngine.unpackSharePayload(
      envelope.d,
      true,
      normCode,
      envelope.v || 2
    );

    return unpacked.payload;
  }

  /**
   * Generate an offline single-file Class Capsule (.kbclasspack).
   * Contains an array of individually encrypted student feedback records.
   *
   * @param {object} params
   * @param {string} params.assignmentId
   * @param {string} [params.classId]
   * @param {string} [params.title]
   * @param {Array<{ studentId: string, studentAccessCode: string, feedback: object }>} params.items
   * @returns {Promise<object>} .kbclasspack JSON object
   */
  static async createClassCapsulePack({ assignmentId, classId = '', title = '', items = [] }) {
    const capsules = [];

    for (const item of items) {
      if (!item.studentAccessCode || !item.feedback) continue;
      const normCode = normalizeAccessCode(item.studentAccessCode);
      const blindId = (await sha256Hex(`blind|${normCode}`)).slice(0, 16);
      const { envelope } = await this.createFeedbackEnvelope(item.feedback, normCode);

      capsules.push({
        blind_id: blindId,
        envelope
      });
    }

    return {
      kbclasspack: 1,
      version: 1,
      assignment_id: assignmentId,
      class_id: classId,
      title,
      created_at: new Date().toISOString(),
      count: capsules.length,
      capsules
    };
  }

  /**
   * Student imports a .kbclasspack file.
   * Tries personal access code against capsules; decrypts and updates student ledger/items.
   *
   * @param {string|object} packOrJson
   * @param {string} studentAccessCode
   * @param {boolean} [persistToStorage=true]
   * @returns {Promise<object>} { success: true, feedback: object } or { success: false, error: string }
   */
  static async unpackClassCapsule(packOrJson, studentAccessCode, persistToStorage = true) {
    const normCode = normalizeAccessCode(studentAccessCode);
    if (!normCode) {
      return { success: false, error: 'NO_ACCESS_CODE' };
    }

    let pack = packOrJson;
    if (typeof packOrJson === 'string') {
      try {
        pack = JSON.parse(packOrJson);
      } catch (_) {
        return { success: false, error: 'INVALID_CLASSPACK_JSON' };
      }
    }

    if (!pack || !Array.isArray(pack.capsules)) {
      return { success: false, error: 'NOT_A_CLASSPACK' };
    }

    let decryptedFeedback = null;

    // Scan capsules to find the one matching the student's code
    for (const item of pack.capsules) {
      if (!item.envelope) continue;
      try {
        const fb = await this.openFeedbackEnvelope(item.envelope, normCode);
        if (fb) {
          decryptedFeedback = fb;
          break;
        }
      } catch (_) {
        // Not matching this student's access code, continue
      }
    }

    if (!decryptedFeedback) {
      return { success: false, error: 'NO_MATCHING_FEEDBACK_FOR_CODE' };
    }

    // Persist to local student tables if requested
    if (persistToStorage) {
      await this.saveFeedbackToStudentStorage(decryptedFeedback);
    }

    return {
      success: true,
      feedback: decryptedFeedback
    };
  }

  /**
   * Save decrypted feedback into student's local ledger and items table.
   *
   * @param {object} feedback
   */
  static async saveFeedbackToStudentStorage(feedback) {
    try {
      const studentId = String(feedback.student_id || '').toUpperCase();
      const asgId = feedback.assignment_id || feedback.task_id;
      if (!asgId) return;

      const ledgerId = `fb-${asgId}-${studentId || 'me'}`;
      const existingLedger = await storage.table('student_ledger').get(ledgerId).catch(() => null);

      const ledgerEntry = {
        id: ledgerId,
        student_id: studentId,
        assignment_id: asgId,
        points: feedback.points ?? feedback.score ?? null,
        status: feedback.status || 'graded',
        feedback: feedback.feedback || '',
        rubric_eval: feedback.rubric_eval || null,
        standard_scores: feedback.standard_scores || null,
        audio_note: feedback.audio_note || null,
        drawing_annotations: feedback.drawing_annotations || null,
        reviewed_at: feedback.reviewed_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      await storage.table('student_ledger').put(ledgerEntry);

      // Update student_items status if existing
      const existingItem = await storage.table('student_items').get(asgId).catch(() => null);
      if (existingItem) {
        existingItem.status = 'reviewed';
        existingItem.grade = feedback.points ?? feedback.score;
        existingItem.teacher_feedback = feedback.feedback;
        existingItem.reviewed_at = ledgerEntry.reviewed_at;
        await storage.table('student_items').put(existingItem);
      }

      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('kb-feedback-imported', { detail: feedback }));
      }
    } catch (err) {
      console.warn('[FeedbackCapsule] Storage update warning:', err);
    }
  }

  /**
   * Teacher publishes a batch of feedback capsules to the blind dead-drop relay.
   *
   * @param {object} params
   * @param {string} params.relayUrl
   * @param {string} params.teacherToken
   * @param {string} params.assignmentId
   * @param {Array<{ studentAccessCode: string, feedback: object }>} params.items
   * @returns {Promise<{ published: number, failed: number }>}
   */
  static async publishBatchToRelay({ relayUrl, teacherToken, assignmentId, items = [] }) {
    let published = 0;
    let failed = 0;

    const base = relayUrl.replace(/\/+$/, '');

    for (const item of items) {
      try {
        if (!item.studentAccessCode || !item.feedback) {
          failed++;
          continue;
        }

        const blindDropId = await this.deriveBlindDropId(assignmentId, item.studentAccessCode);
        const { token } = await this.createFeedbackEnvelope(item.feedback, item.studentAccessCode);

        const res = await fetch(`${base}/api/feedback/${blindDropId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${teacherToken}`
          },
          body: JSON.stringify({ ciphertext: token })
        });

        if (res.ok) {
          published++;
        } else {
          failed++;
        }
      } catch (_) {
        failed++;
      }
    }

    return { published, failed };
  }

  /**
   * Student polls the relay for their feedback.
   *
   * @param {string} relayUrl
   * @param {string} assignmentId
   * @param {string} studentAccessCode
   * @returns {Promise<object|null>}
   */
  static async fetchStudentRemoteFeedback(relayUrl, assignmentId, studentAccessCode) {
    const normCode = normalizeAccessCode(studentAccessCode);
    if (!normCode) return null;

    const blindDropId = await this.deriveBlindDropId(assignmentId, normCode);
    const base = relayUrl.replace(/\/+$/, '');

    const res = await fetch(`${base}/api/feedback/${blindDropId}`);
    if (!res.ok) return null;

    const data = await res.json();
    if (!data || !data.ciphertext) return null;

    const feedback = await this.openFeedbackEnvelope(data.ciphertext, normCode);
    if (feedback) {
      await this.saveFeedbackToStudentStorage(feedback);
    }

    return feedback;
  }
}

export default FeedbackCapsule;
