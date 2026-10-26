/**
 * EnvelopeRouter - KB-CORE-008
 * Pure classification and archive unpacking for student submissions, receipts, and shares.
 */

import jszipLib from 'jszip';
import lzLib from 'lz-string';
import { SubmissionCrypto } from './submission-crypto.js';
import { extractEnvelopeFromHtml } from './html-launcher.js';

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

  // 0. Try extracting from HTML launcher wrapper
  if (trimmed.includes('<html') || trimmed.includes('<!DOCTYPE html') || trimmed.includes('kb-payload')) {
    const extracted = extractEnvelopeFromHtml(trimmed);
    if (extracted) {
      if (typeof extracted === 'string') {
        return classifyText(extracted);
      }
      if (typeof extracted === 'object') {
        if (extracted.kind === 'assignment_feedback' || extracted.type === 'assignment_feedback') {
          return {
            kind: 'assignment_feedback',
            assignment_id: extracted.assignment?.id || null,
            course_id: extracted.course?.id || null,
            text: JSON.stringify(extracted)
          };
        }
        if (extracted.kind === 'task_feedback' || extracted.type === 'task_feedback') {
          return {
            kind: 'task_feedback',
            task_id: extracted.task?.id || extracted.task_id || null,
            course_id: extracted.course?.id || null,
            text: JSON.stringify(extracted)
          };
        }
        if (extracted.kbsub === 1 || extracted.epk) {
          return classifyText(JSON.stringify(extracted));
        }
        if (extracted.kind === 'kb-task' || extracted.task_id) {
          return {
            kind: 'task',
            task_id: extracted.task_id,
            publish_version: headerVersion(extracted.publish_version),
            text: JSON.stringify(extracted)
          };
        }
        if (extracted.kind === 'kb-assignment' || extracted.assignment_id) {
          return {
            kind: 'assignment',
            assignment_id: extracted.assignment_id,
            publish_version: headerVersion(extracted.publish_version),
            text: JSON.stringify(extracted)
          };
        }
        return classifyText(JSON.stringify(extracted));
      }
    }
  }

  // 1. Try parsing as KBSUB envelope (KBSUB1. string or raw envelope JSON)
  try {
    const envelope = SubmissionCrypto.parseEnvelope(trimmed);
    if (envelope && (envelope.kbsub === 1 || envelope.epk || envelope.ct)) {
      const header = envelope.header || {};
      if (header.kind === 'video-receipt') {
        return {
          kind: 'video_receipt',
          assessment_id: headerId(header.assessment_id || header.assignment_id),
          assignment_id: headerId(header.assignment_id || header.assessment_id),
          publish_version: headerVersion(header.publish_version),
          text: trimmed
        };
      }
      if (header.kind === 'task' || headerId(header.task_id)) {
        return {
          kind: 'task',
          task_id: headerId(header.task_id || header.id),
          publish_version: headerVersion(header.publish_version),
          text: trimmed
        };
      }
      if (headerId(header.assignment_id)) {
        return {
          kind: 'assignment',
          assignment_id: header.assignment_id,
          publish_version: headerVersion(header.publish_version),
          text: trimmed
        };
      }
      return { kind: 'unknown', text: trimmed };
    }
  } catch (_) {
    // Not a valid KBSUB envelope
  }

  // 2. Try parsing as plain JSON (legacy video receipt, shared deck/lesson, feedback, etc.)
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      // Assignment Feedback
      if (parsed.kind === 'assignment_feedback' || parsed.type === 'assignment_feedback') {
        return {
          kind: 'assignment_feedback',
          assignment_id: parsed.assignment?.id || null,
          course_id: parsed.course?.id || null,
          text: trimmed
        };
      }
      // Task Feedback
      if (parsed.kind === 'task_feedback' || parsed.type === 'task_feedback') {
        return {
          kind: 'task_feedback',
          task_id: parsed.task?.id || parsed.task_id || null,
          course_id: parsed.course?.id || null,
          text: trimmed
        };
      }
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

/** Header fields are written by the student before encryption: accept only plain values */
function headerVersion(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function headerId(v) {
  return typeof v === 'string' && v.length <= 200 ? v : null;
}

const ALLOWED_EXTENSIONS = ['.kbsub', '.kbr', '.kbshare', '.kbfeedback', '.html', '.htm', '.txt', '.json'];

// Archive limits: an LMS bulk download of a class is a few MB; anything far beyond is hostile
export const ZIP_LIMITS = { maxEntries: 5000, maxTotalBytes: 100 * 1024 * 1024, maxEntryBytes: 10 * 1024 * 1024, maxDepth: 3 };

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
  const budget = { entries: 0, bytes: 0 };

  async function processZipData(zipData, parentName = '', depth = 1) {
    if (depth > ZIP_LIMITS.maxDepth) throw new Error('ZIP_TOO_DEEP');
    const zip = await JSZip.loadAsync(zipData);
    const entries = Object.entries(zip.files);

    for (const [relativePath, entry] of entries) {
      if (entry.dir || relativePath.endsWith('/')) continue;
      if (++budget.entries > ZIP_LIMITS.maxEntries) throw new Error('ZIP_TOO_MANY_FILES');
      // Declared size from the central directory; checked again after inflating below
      const declared = entry._data?.uncompressedSize ?? 0;
      if (declared > ZIP_LIMITS.maxEntryBytes) continue;
      if (relativePath.includes('__MACOSX')) continue;

      const segments = relativePath.split('/');
      // Skip hidden files or files in hidden folders (e.g. .DS_Store)
      if (segments.some(s => s.startsWith('.'))) continue;

      const filename = segments[segments.length - 1];
      const lower = filename.toLowerCase();

      if (lower.endsWith('.zip')) {
        const nestedData = await entry.async('arraybuffer');
        budget.bytes += nestedData.byteLength;
        if (budget.bytes > ZIP_LIMITS.maxTotalBytes) throw new Error('ZIP_TOO_LARGE');
        await processZipData(nestedData, filename, depth + 1);
        continue;
      }

      const isAllowed = ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext));
      if (!isAllowed) continue;

      const content = await entry.async('string');
      budget.bytes += content.length;
      if (budget.bytes > ZIP_LIMITS.maxTotalBytes) throw new Error('ZIP_TOO_LARGE');
      if (content.length > ZIP_LIMITS.maxEntryBytes) continue;
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
