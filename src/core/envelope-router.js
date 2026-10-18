/**
 * EnvelopeRouter - KB-CORE-008
 * Pure classification and archive unpacking for student submissions, receipts, and shares.
 */

import jszipLib from 'jszip';
import lzLib from 'lz-string';
import { SubmissionCrypto } from './submission-crypto.js';

const JSZip = jszipLib.default || jszipLib;
const LZString = lzLib.compressToEncodedURIComponent ? lzLib : (lzLib.default || lzLib);

/**
 * Split text containing multiple KBSUB1 codes or a single raw JSON envelope.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSubmissionText(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const codes = t.match(/KBSUB1\.[A-Za-z0-9_-]+/g);
  if (codes && codes.length > 0) return codes;
  return [t];
}

/**
 * Classify a string of text into its envelope kind without decrypting the payload body.
 *
 * @param {string} text
 * @returns {{
 *   kind: 'assignment'|'video_receipt'|'legacy_receipt'|'kbshare'|'unknown',
 *   assignment_id?: string|null,
 *   assessment_id?: string|null,
 *   publish_version?: number|null,
 *   text: string
 * }}
 */
export function classifyText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return { kind: 'unknown', text: '' };
  }

  // 1. Try parsing as KBSUB envelope (KBSUB1. string or raw envelope JSON)
  try {
    const envelope = SubmissionCrypto.parseEnvelope(trimmed);
    if (envelope && (envelope.kbsub === 1 || envelope.epk || envelope.ct)) {
      const header = envelope.header || {};
      if (header.kind === 'video-receipt') {
        return {
          kind: 'video_receipt',
          assessment_id: header.assessment_id || header.assignment_id || null,
          assignment_id: header.assignment_id || header.assessment_id || null,
          publish_version: header.publish_version ?? null,
          text: trimmed
        };
      }
      if (header.assignment_id) {
        return {
          kind: 'assignment',
          assignment_id: header.assignment_id,
          publish_version: header.publish_version ?? null,
          text: trimmed
        };
      }
      return { kind: 'unknown', text: trimmed };
    }
  } catch (_) {
    // Not a valid KBSUB envelope
  }

  // 2. Try parsing as plain JSON (legacy video receipt, shared deck/lesson, etc.)
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      // Legacy video receipt: { receipt, signature } or receipt object with quizId / assessmentId / totalScore
      if (parsed.receipt && (parsed.signature || parsed.receipt.quizId || parsed.receipt.assessmentId || parsed.receipt.totalScore !== undefined)) {
        return {
          kind: 'legacy_receipt',
          assessment_id: parsed.receipt.assessmentId || parsed.receipt.quizId || parsed.receipt.assignment_id || null,
          text: trimmed
        };
      }
      if ((parsed.assessmentId || parsed.quizId) && (parsed.signature || parsed.totalScore !== undefined)) {
        return {
          kind: 'legacy_receipt',
          assessment_id: parsed.assessmentId || parsed.quizId || null,
          text: trimmed
        };
      }
      // Shared lesson / kbshare: { d } or { type, payload }
      if (parsed.d || (parsed.type && parsed.payload)) {
        return {
          kind: 'kbshare',
          text: trimmed
        };
      }
    }
  } catch (_) {
    // Not valid JSON
  }

  // 3. Try decompressing with LZ-string (legacy .kbr files are compressed JSON)
  try {
    const decompressed = LZString.decompressFromEncodedURIComponent(trimmed);
    if (decompressed && (decompressed.startsWith('{') || decompressed.startsWith('['))) {
      const parsed = JSON.parse(decompressed);
      if (parsed && typeof parsed === 'object') {
        if (parsed.assessmentId || parsed.quizId || parsed.receipt) {
          return {
            kind: 'legacy_receipt',
            assessment_id: parsed.assessmentId || parsed.quizId || parsed.receipt?.quizId || parsed.receipt?.assessmentId || null,
            text: trimmed
          };
        }
      }
    }
  } catch (_) {
    // Not valid compressed data
  }

  return { kind: 'unknown', text: trimmed };
}

const ALLOWED_EXTENSIONS = ['.kbsub', '.kbr', '.txt', '.json'];

/**
 * Expand a list of files or file-like objects, recursively opening .zip archives.
 * Preserves LMS bulk-download filenames, ignores __MACOSX and hidden files, and
 * splits multi-code text files using splitSubmissionText.
 *
 * @param {Array<File|Blob|{name: string, text?: string, data?: ArrayBuffer}>|FileList} files
 * @returns {Promise<Array<{ source: string, text: string }>>}
 */
export async function expandFiles(files) {
  const fileList = Array.from(files || []);
  const results = [];

  async function processZipData(zipData, parentName = '') {
    const zip = await JSZip.loadAsync(zipData);
    const entries = Object.entries(zip.files);

    for (const [relativePath, entry] of entries) {
      if (entry.dir || relativePath.endsWith('/')) continue;
      if (relativePath.includes('__MACOSX')) continue;

      const segments = relativePath.split('/');
      // Skip hidden files or files in hidden folders (e.g. .DS_Store)
      if (segments.some(s => s.startsWith('.'))) continue;

      const filename = segments[segments.length - 1];
      const lower = filename.toLowerCase();

      if (lower.endsWith('.zip')) {
        const nestedData = await entry.async('arraybuffer');
        await processZipData(nestedData, filename);
        continue;
      }

      const isAllowed = ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext));
      if (!isAllowed) continue;

      const content = await entry.async('string');
      const parts = splitSubmissionText(content);
      const sourceName = filename || parentName || relativePath;

      if (parts.length > 1) {
        parts.forEach((part, i) => {
          results.push({ source: `${sourceName} (#${i + 1})`, text: part });
        });
      } else if (parts.length === 1) {
        results.push({ source: sourceName, text: parts[0] });
      }
    }
  }

  for (const item of fileList) {
    if (!item) continue;
    const name = item.name || 'file';
    const lower = name.toLowerCase();

    if (lower.endsWith('.zip') || item.type === 'application/zip' || item.type === 'application/x-zip-compressed') {
      let data = item.data;
      if (!data) {
        if (typeof item.arrayBuffer === 'function') {
          data = await item.arrayBuffer();
        } else if (item instanceof Blob) {
          data = await item.arrayBuffer();
        }
      }
      if (data) {
        await processZipData(data, name);
      }
    } else {
      let rawText = '';
      if (typeof item.text === 'string') {
        rawText = item.text;
      } else if (typeof item.text === 'function') {
        rawText = await item.text();
      }
      const parts = splitSubmissionText(rawText);
      if (parts.length > 1) {
        parts.forEach((part, i) => {
          results.push({ source: `${name} (#${i + 1})`, text: part });
        });
      } else if (parts.length === 1) {
        results.push({ source: name, text: parts[0] });
      }
    }
  }

  return results;
}
