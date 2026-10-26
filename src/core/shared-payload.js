/**
 * Shared payload hygiene (KB-CORE-SHARE-GUARD)
 *
 * Anything that arrives through a share link or .kbshare file was written by someone else. Views
 * escape what they render, but this normalizer is the second line of defence: it rejects unknown
 * share types and coerces fields that templates treat as numbers, colors or enums, so a crafted
 * payload cannot smuggle markup through them. It is deliberately lenient about shape (older
 * exports must keep opening) and strict about value types.
 */
import { Sanitizer } from './sanitizer.js';

export const SHARE_TYPES = new Set([
  'flashcards', 'timeline', 'video', 'gradebook', 'student_grade_report', 'assignment', 'assignment_feedback', 'course_feed',
  'task', 'task_feedback'
]);

const MAX_DEPTH = 32;
const MAX_NODES = 250000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Keys rendered as numbers somewhere in the UI. Only primitive values are coerced, so an object
// under the same key (e.g. `score: { earned, possible }`) is walked instead.
const NUMERIC_KEYS = new Set([
  'points', 'timestamp_sec', 'max_score', 'raw_score', 'score', 'earned', 'possible', 'checkable',
  'days_late', 'pending', 'needs_manual', 'percent', 'weight', 'default_points', 'pts', 'n',
  'stability', 'difficulty', 'reps', 'lapses', 'due_timestamp', 'elapsed_days', 'scheduled_days',
  'publish_version', 'zoom_level', 'focal_epoch_ms', 'high_score', 'longest_streak',
  'accuracy', 'totalScore', 'maxScore',
  'max_points', 'line', 'end_line', 'max_files', 'max_mb', 'size', 'w', 'h'
]);
const COLOR_KEYS = new Set(['color', 'background', 'background_color', 'accent']);
const ENUMS = {
  provider: new Set(['html5', 'youtube', 'vimeo'])
};

export class SharedPayloadError extends Error {}

function normalizeValue(key, value, depth, budget) {
  if (++budget.nodes > MAX_NODES) throw new SharedPayloadError('PAYLOAD_TOO_LARGE');
  if (depth > MAX_DEPTH) throw new SharedPayloadError('PAYLOAD_TOO_DEEP');

  if (Array.isArray(value)) {
    return value.map(v => normalizeValue(key, v, depth + 1, budget));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      out[k] = normalizeValue(k, v, depth + 1, budget);
    }
    return out;
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return null;

  if (NUMERIC_KEYS.has(key) && value !== null && value !== undefined && typeof value !== 'number') {
    if (typeof value === 'boolean') return value;
    return Sanitizer.safeNumber(value, 0);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 0;
  if (COLOR_KEYS.has(key) && typeof value === 'string') return Sanitizer.safeColor(value);
  if (ENUMS[key] && !ENUMS[key].has(value)) return [...ENUMS[key]][0];
  return value;
}

/**
 * Validate an unpacked share envelope `{ v, type, payload }`.
 * @returns {{ type: string, payload: object }}
 * @throws {SharedPayloadError}
 */
export function normalizeSharedEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') throw new SharedPayloadError('NOT_AN_ENVELOPE');
  const { type, payload } = envelope;
  if (typeof type !== 'string' || !SHARE_TYPES.has(type)) throw new SharedPayloadError('UNKNOWN_SHARE_TYPE');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SharedPayloadError('MISSING_PAYLOAD');
  return { type, payload: normalizeValue('', payload, 0, { nodes: 0 }) };
}

/**
 * Prepare a shared item for the local library: fresh id, and no references to the sender's
 * local records (classes) that would dangle or collide.
 */
export function toLibraryRecord(payload) {
  const { id: _id, class_id: _cls, created_at: _c, updated_at: _u, ...rest } = payload || {};
  return { ...rest, id: crypto.randomUUID(), class_id: null };
}
