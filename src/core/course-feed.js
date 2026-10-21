import { storage } from './storage.js';
import { CryptoShareEngine } from './crypto-share.js';
import { computeCourseRevisionHash } from './course-revision.js';
import { getDue } from './due-dates.js';

/**
 * Course Feed Builder & Decryptor (KB-COURSE-001)
 * Encrypts course outlines, units, and items with the course access code for zero-trust delivery.
 */

export async function buildCourseFeed(courseId, { origin, studentId, relayUrl } = {}) {
  if (!courseId) throw new Error('courseId is required to build a course feed');

  const course = await storage.table('gradebook_courses').get(courseId);
  if (!course) throw new Error(`Course not found: ${courseId}`);

  const [units, items] = await Promise.all([
    storage.table('course_units').where('course_id').equals(courseId).toArray().catch(() => []),
    storage.table('course_items').where('course_id').equals(courseId).toArray().catch(() => [])
  ]);

  // Enrich items with due dates, payloads, and clean presentation metadata
  const enrichedItems = await Promise.all(items.map(async (item) => {
    const kind = item.kind || item.type || 'assignment';
    const sourceId = item.source_id || item.id;
    let due = null;
    try {
      due = await getDue(kind, sourceId);
    } catch (_) {
      due = { date: item.due_date || null, time: item.due_time || null };
    }

    let itemPayload = item.payload || null;
    if (!itemPayload && sourceId) {
      try {
        if (kind === 'assignment') {
          itemPayload = await storage.table('assignments').get(sourceId).catch(() => null);
        } else if (kind === 'flashcards' || kind === 'flashcard') {
          itemPayload = await storage.table('flashcards').get(sourceId).catch(() => null);
        } else if (kind === 'timeline') {
          itemPayload = await storage.table('timelines').get(sourceId).catch(() => null);
        } else if (kind === 'video') {
          itemPayload = await storage.table('video_assessments').get(sourceId).catch(() => null);
        }
      } catch (_) {}
    }

    return {
      id: item.id,
      course_id: courseId,
      unit_id: item.unit_id || null,
      title: item.title || 'Untitled Item',
      kind,
      source_id: sourceId,
      order: item.order ?? 0,
      due_date: due?.date || item.due_date || null,
      due_time: due?.time || item.due_time || null,
      points: item.points ?? item.max_points ?? 100,
      description: item.description || '',
      settings: item.settings || {},
      payload: itemPayload
    };
  }));

  const revisionHash = await computeCourseRevisionHash(courseId).catch(() => 'rev-0');

  const feedPayload = {
    v: 1,
    course: {
      id: course.id,
      name: course.name,
      section: course.section,
      academic_year: course.academic_year,
      color: course.color,
      access_code: course.access_code,
      ...(relayUrl ? { relay_url: relayUrl } : {})
    },
    units: units.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    items: enrichedItems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    published_at: new Date().toISOString(),
    revision: revisionHash
  };

  const accessCode = (course.access_code || '').trim();
  const packed = await CryptoShareEngine.createSharePayload('course_feed', feedPayload, accessCode);

  return {
    course_id: courseId,
    etag: revisionHash,
    ciphertext: packed.d,
    format_version: packed.v,
    published_at: feedPayload.published_at,
    raw_payload: feedPayload
  };
}

export async function decryptCourseFeed(feedEnvelope, accessCode) {
  if (!feedEnvelope) throw new Error('No feed envelope provided');
  const d = typeof feedEnvelope === 'string' ? feedEnvelope : feedEnvelope.ciphertext || feedEnvelope.d;
  const version = feedEnvelope.format_version || feedEnvelope.v || 2;
  const isEncrypted = Boolean(accessCode && String(accessCode).trim().length > 0);
  const unpacked = await CryptoShareEngine.unpackSharePayload(d, isEncrypted, (accessCode || '').trim(), version);
  const data = typeof unpacked === 'string' ? JSON.parse(unpacked) : unpacked;
  return data?.payload || data;
}

/**
 * Derive deterministic 24-hex feed ID from a course access code (or courseId if no code exists).
 * Both teacher publish and student lookup use this so students can locate feeds without knowing internal UUIDs.
 * @param {string} accessCodeOrCourseId
 * @returns {Promise<string>}
 */
export async function deriveCourseFeedId(accessCodeOrCourseId) {
  const norm = String(accessCodeOrCourseId || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!norm) return 'feed-unknown';
  const buf = new TextEncoder().encode(`kb-course-feed-v1|${norm}`);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}
