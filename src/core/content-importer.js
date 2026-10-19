/**
 * ContentImporter - Universal Content Ingestion Engine (KB-CORE-IMPORT)
 * Inspects, unpacks, decrypts, validates, and persists content from .kbshare files,
 * JSON payloads, CSV spreadsheets, and student hand-ins.
 */

import { CryptoShareEngine } from './crypto-share.js';
import { normalizeSharedEnvelope, toLibraryRecord, SHARE_TYPES } from './shared-payload.js';
import { storage } from './storage.js';
import { Sanitizer } from './sanitizer.js';
import { generateUUID } from '../utils/uuid.js';
import { splitSubmissionText, classifyText } from './envelope-router.js';
import { extractEnvelopeFromHtml } from './html-launcher.js';
import { cloneQuestion } from '../modules/assignments/question-types.js';

export class ContentImportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ContentImportError';
    this.code = code;
  }
}

export class ContentImporter {
  /**
   * Inspect raw text or filename to identify the content kind and metadata
   * @param {string} text
   * @param {string} [filename='']
   * @returns {{
   *   kind: 'kbshare'|'kbsub'|'feedback'|'json'|'csv'|'unknown',
   *   isEncrypted?: boolean,
   *   version?: number,
   *   shareType?: string,
   *   parsed?: any,
   *   rawText: string,
   *   filename: string
   * }}
   */
  static inspect(text, filename = '') {
    let raw = String(text || '').trim();
    const lowerFilename = (filename || '').toLowerCase();

    if (!raw) {
      return { kind: 'unknown', rawText: '', filename };
    }

    // 0. Unwrap HTML launcher if present
    if (lowerFilename.endsWith('.html') || lowerFilename.endsWith('.htm') || raw.includes('kb-payload')) {
      const extracted = extractEnvelopeFromHtml(raw);
      if (extracted) {
        if (typeof extracted === 'string') raw = extracted;
        else if (typeof extracted === 'object') {
          if (extracted.kind === 'assignment_feedback' || extracted.type === 'assignment_feedback') {
            return { kind: 'feedback', parsed: extracted, rawText: JSON.stringify(extracted), filename };
          }
          return { kind: 'json', parsed: extracted, rawText: JSON.stringify(extracted), filename };
        }
      }
    }

    // 1. Check for KBSUB1 submission
    if (/KBSUB1\.[A-Za-z0-9_-]+/.test(raw)) {
      return { kind: 'kbsub', rawText: raw, filename };
    }

    // 2. Check for .kbshare envelope
    if (lowerFilename.endsWith('.kbshare') || (raw.startsWith('{') && raw.includes('"d"') && (raw.includes('"enc"') || raw.includes('"v"')))) {
      try {
        const file = CryptoShareEngine.parseShareFile(raw);
        return {
          kind: 'kbshare',
          isEncrypted: file.enc === '1',
          version: file.v,
          rawText: raw,
          filename
        };
      } catch (_) {
        if (lowerFilename.endsWith('.kbshare')) {
          return { kind: 'kbshare', isEncrypted: false, corrupted: true, rawText: raw, filename };
        }
      }
    }

    // 3. Check for JSON (shared envelope or direct payload)
    if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          // Could be a raw envelope { type, payload }
          if (parsed.type && SHARE_TYPES.has(parsed.type) && parsed.payload) {
            return {
              kind: 'json',
              isSharedEnvelope: true,
              shareType: parsed.type,
              parsed,
              rawText: raw,
              filename
            };
          }
          // Legacy or direct item format
          return {
            kind: 'json',
            isSharedEnvelope: false,
            parsed,
            rawText: raw,
            filename
          };
        }
      } catch (_) {
        // Fall through
      }
    }

    // 4. Check for CSV / TSV
    if (raw.includes(',') || raw.includes('\t') || raw.includes('\n') || lowerFilename.endsWith('.csv') || lowerFilename.endsWith('.tsv')) {
      return { kind: 'csv', rawText: raw, filename };
    }

    return { kind: 'unknown', rawText: raw, filename };
  }

  /**
   * Parse and unpack a .kbshare file string
   * @param {string} shareText
   * @param {string} [passphrase='']
   * @returns {Promise<{ type: string, payload: any, version: number }>}
   */
  static async unpackKbShare(shareText, passphrase = '') {
    let file;
    try {
      file = CryptoShareEngine.parseShareFile(shareText);
    } catch (_) {
      throw new ContentImportError('Invalid or corrupted .kbshare file format.', 'INVALID_KBSHARE');
    }

    const isEncrypted = file.enc === '1';
    if (isEncrypted && (!passphrase || !passphrase.trim())) {
      throw new ContentImportError('This .kbshare file is encrypted. A passphrase or access code is required.', 'PASSPHRASE_REQUIRED');
    }

    let unpacked;
    try {
      unpacked = await CryptoShareEngine.unpackSharePayload(file.d, isEncrypted, passphrase.trim(), file.v);
    } catch (err) {
      if (isEncrypted) {
        throw new ContentImportError('Incorrect passphrase or access code.', 'BAD_PASSPHRASE');
      }
      throw new ContentImportError('Failed to decompress shared content: payload corrupted.', 'PAYLOAD_CORRUPT');
    }

    try {
      const normalized = normalizeSharedEnvelope(unpacked);
      return {
        type: normalized.type,
        payload: normalized.payload,
        version: file.v
      };
    } catch (err) {
      throw new ContentImportError('Invalid educational content structure: ' + err.message, 'INVALID_ENVELOPE');
    }
  }

  /**
   * Persist an unpacked share payload directly into the user's local database.
   * Cleans foreign identifiers and assigns new UUIDs.
   *
   * @param {string} type - 'flashcards' | 'assignment' | 'timeline' | 'video' | 'gradebook'
   * @param {object} payload - Unpacked payload
   * @param {object} [options]
   * @param {string|null} [options.classId=null] - Optional class ID to assign to
   * @param {string} [options.filename=''] - Original filename for title fallback
   * @returns {Promise<{ success: boolean, type: string, table: string, id: string, title: string, count: number, record: object }>}
   */
  static async importRecordToLibrary(type, payload, { classId = null, filename = '' } = {}) {
    if (!type || !payload) {
      throw new ContentImportError('Missing content type or payload data.', 'MISSING_DATA');
    }

    const now = new Date().toISOString();
    const cleanFilenameTitle = (filename || '')
      .replace(/\.[^/.]+$/, '')
      .replace(/[_\-]+/g, ' ')
      .trim();

    if (type === 'flashcards') {
      const cards = Array.isArray(payload.cards) ? payload.cards : [];
      const title = payload.title || cleanFilenameTitle || 'Imported Flashcard Deck';
      const record = {
        version: 1,
        id: generateUUID(),
        title: Sanitizer.escapeHTML(title),
        description: payload.description ? Sanitizer.escapeHTML(payload.description) : '',
        class_id: classId || null,
        cards: cards.map(c => ({
          id: generateUUID(),
          type: 'text',
          front: typeof c.front === 'string' ? { text: c.front, ttsLang: 'en-US' } : (c.front || { text: '', ttsLang: 'en-US' }),
          back: typeof c.back === 'string' ? { text: c.back, ttsLang: 'en-US' } : (c.back || { text: '', ttsLang: 'en-US' }),
          fsrs: c.fsrs && typeof c.fsrs === 'object' ? c.fsrs : { state: 0, stability: 0, difficulty: 0, due: now }
        })),
        updated_at: now
      };

      await storage.table('flashcards').put(record);
      return {
        success: true,
        type: 'flashcards',
        table: 'flashcards',
        id: record.id,
        title: record.title,
        count: record.cards.length,
        record
      };
    }

    if (type === 'assignment') {
      const questions = Array.isArray(payload.questions) ? payload.questions : [];
      const title = payload.title || cleanFilenameTitle || 'Imported Assignment';
      const record = {
        version: 1,
        id: generateUUID(),
        title: Sanitizer.escapeHTML(title),
        description: payload.description ? Sanitizer.escapeHTML(payload.description) : '',
        class_id: classId || null,
        questions: questions.map(q => ({
          ...q,
          id: generateUUID()
        })),
        gradebook: { ...(payload.gradebook || {}), column_id: null },
        publish: null,
        created_at: now,
        updated_at: now
      };

      await storage.table('assignments').put(record);
      return {
        success: true,
        type: 'assignment',
        table: 'assignments',
        id: record.id,
        title: record.title,
        count: record.questions.length,
        record
      };
    }

    if (type === 'timeline') {
      const events = Array.isArray(payload.events) ? payload.events : [];
      const title = payload.title || cleanFilenameTitle || 'Imported Timeline';
      const record = {
        version: 1,
        id: generateUUID(),
        title: Sanitizer.escapeHTML(title),
        description: payload.description ? Sanitizer.escapeHTML(payload.description) : '',
        class_id: classId || null,
        events: events.map(ev => ({
          ...ev,
          id: generateUUID()
        })),
        updated_at: now
      };

      await storage.table('timelines').put(record);
      return {
        success: true,
        type: 'timeline',
        table: 'timelines',
        id: record.id,
        title: record.title,
        count: record.events.length,
        record
      };
    }

    if (type === 'video') {
      const checkpoints = Array.isArray(payload.checkpoints) ? payload.checkpoints : [];
      const title = payload.title || cleanFilenameTitle || 'Imported Video Assessment';
      const record = {
        version: 1,
        id: generateUUID(),
        title: Sanitizer.escapeHTML(title),
        description: payload.description ? Sanitizer.escapeHTML(payload.description) : '',
        class_id: classId || null,
        video_url: payload.video_url || '',
        provider: payload.provider || 'youtube',
        checkpoints: checkpoints.map(cp => ({
          ...cp,
          id: generateUUID()
        })),
        created_at: now,
        updated_at: now
      };

      await storage.table('video_assessments').put(record);
      return {
        success: true,
        type: 'video',
        table: 'video_assessments',
        id: record.id,
        title: record.title,
        count: record.checkpoints.length,
        record
      };
    }

    if (type === 'gradebook') {
      const title = payload.name || payload.title || cleanFilenameTitle || 'Imported Course';
      const record = {
        ...toLibraryRecord(payload),
        name: Sanitizer.escapeHTML(title),
        updated_at: now
      };
      await storage.table('gradebook_courses').put(record);
      return {
        success: true,
        type: 'gradebook',
        table: 'gradebook_courses',
        id: record.id,
        title: record.name,
        count: 0,
        record
      };
    }

    throw new ContentImportError(`Import for type "${type}" is not supported as a standalone library record.`, 'UNSUPPORTED_TYPE');
  }

  /**
   * Helper to merge imported flashcards into an existing deck
   * @param {object} targetDeck
   * @param {Array<object>} newCards
   * @param {{ replaceIfEmpty?: boolean }} [options]
   * @returns {number} count of cards added
   */
  static mergeCardsIntoDeck(targetDeck, newCards, { replaceIfEmpty = true } = {}) {
    if (!targetDeck || !Array.isArray(targetDeck.cards)) {
      throw new ContentImportError('Invalid target deck provided.', 'INVALID_DECK');
    }
    if (!Array.isArray(newCards) || newCards.length === 0) return 0;

    const formatted = newCards.map(c => ({
      id: generateUUID(),
      type: 'text',
      front: typeof c.front === 'string' ? { text: c.front, ttsLang: 'en-US' } : (c.front || { text: '', ttsLang: 'en-US' }),
      back: typeof c.back === 'string' ? { text: c.back, ttsLang: 'en-US' } : (c.back || { text: '', ttsLang: 'en-US' }),
      fsrs: c.fsrs && typeof c.fsrs === 'object' ? c.fsrs : { state: 0, stability: 0, difficulty: 0, due: new Date().toISOString() }
    }));

    const hasOnlyEmptyCard = replaceIfEmpty && targetDeck.cards.length === 1 &&
      (!targetDeck.cards[0].front?.text || targetDeck.cards[0].front.text.trim() === '') &&
      (!targetDeck.cards[0].back?.text || targetDeck.cards[0].back.text.trim() === '');

    if (hasOnlyEmptyCard) {
      targetDeck.cards = formatted;
    } else {
      targetDeck.cards.push(...formatted);
    }

    targetDeck.updated_at = new Date().toISOString();
    return formatted.length;
  }

  /**
   * Merge imported questions into an existing or new assignment, ensuring fresh UUIDs
   * @param {object} targetAssignment
   * @param {Array<object>} newQuestions
   * @returns {object} updated assignment
   */
  static mergeQuestionsIntoAssignment(targetAssignment, newQuestions = []) {
    const cloned = (newQuestions || []).map(q => cloneQuestion(q));
    const questions = [...(targetAssignment.questions || []), ...cloned];
    return {
      ...targetAssignment,
      questions,
      updated_at: new Date().toISOString()
    };
  }
}
