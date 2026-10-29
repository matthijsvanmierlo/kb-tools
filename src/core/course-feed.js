import { storage } from './storage.js';
import { CryptoShareEngine } from './crypto-share.js';
import { computeCourseRevisionHash } from './course-revision.js';
import { getDue } from './due-dates.js';
import { SubmissionCrypto } from './submission-crypto.js';
import { buildStudentPayload } from '../modules/assignments/grading.js';
import { buildStudentTaskPayload } from '../modules/tasks/publish-core.js';

/**
 * Course Feed Builder & Decryptor (KB-COURSE-001)
 * Encrypts course outlines, units, and items with the course access code for zero-trust delivery.
 */

export async function buildCourseFeed(courseId, opts = {}) {
  const { origin, studentId, relayUrl } = opts;
  if (!courseId) throw new Error('courseId is required to build a course feed');

  // Auto-sync any assignments/materials assigned to this class before building the feed
  try {
    const { reconcileCourseItemsForClass } = await import('../modules/gradebook/bridge.js');
    await reconcileCourseItemsForClass(courseId);
  } catch (e) {
    // Non-blocking in tests or mock environments
  }

  const course = await storage.table('gradebook_courses').get(courseId);
  if (!course) throw new Error(`Course not found: ${courseId}`);

  const [units, items, rosterStudents, keys] = await Promise.all([
    storage.table('course_units').where('course_id').equals(courseId).toArray().catch(() => []),
    storage.table('course_items').where('course_id').equals(courseId).toArray().catch(() => []),
    storage.table('gradebook_students').where('course_id').equals(courseId).toArray().catch(() => []),
    SubmissionCrypto.getOrCreateTeacherKeys(storage)
  ]);
  const rosterWithCode = rosterStudents.filter(s => s.access_code);

  // Filter out items that are hidden or explicitly unpublished
  const visibleItems = items.filter(item => !item.hidden && item.published !== false);

  // Enrich items with due dates, payloads, and clean presentation metadata
  const enrichedItems = await Promise.all(visibleItems.map(async (item) => {
    const kind = item.kind || item.type || 'assignment';
    const sourceId = item.content_id || item.source_id || item.id;
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
          const rawAsg = await storage.table('assignments').get(sourceId).catch(() => null);
          if (rawAsg) {
            if (!rawAsg.publish) {
              rawAsg.publish = { version: 1, salt: 'asg-salt-' + rawAsg.id.slice(0, 8), published_at: new Date().toISOString() };
              await storage.table('assignments').put(rawAsg).catch(() => {});
            }
            const asgSalt = rawAsg.publish?.salt || 'course-salt';
            itemPayload = await buildStudentPayload(rawAsg, {
              teacherKeys: keys,
              salt: asgSalt,
              roster: { withCode: rosterWithCode },
              courseMeta: { id: course.id, course_id: course.id, name: course.name, course_name: course.name, section: course.section, access_code: course.access_code },
              relay: rawAsg.publish?.relay || null
            });
          }
        } else if (kind === 'task') {
          const rawTask = await storage.table('tasks').get(sourceId).catch(() => null);
          if (rawTask) {
            if (!rawTask.publish) {
              rawTask.publish = { version: 1, salt: 'task-salt-' + rawTask.id.slice(0, 8), published_at: new Date().toISOString() };
              await storage.table('tasks').put(rawTask).catch(() => {});
            }
            const taskSalt = rawTask.publish?.salt || 'course-salt';
            let taskRosterChecks = null;
            let taskRosterCards = null;
            if (rosterWithCode.length > 0) {
              taskRosterChecks = await SubmissionCrypto.buildRosterChecks(sourceId, taskSalt, rosterWithCode);
              taskRosterCards = await SubmissionCrypto.buildRosterCards(sourceId, rosterWithCode);
            }
            itemPayload = await buildStudentTaskPayload(rawTask, {
              teacherKeys: keys,
              rosterChecks: taskRosterChecks,
              rosterCards: taskRosterCards,
              courseMeta: { id: course.id, course_id: course.id, name: course.name, course_name: course.name, section: course.section, access_code: course.access_code },
              relay: rawTask.publish?.relay || null
            });
          }
        } else if (kind === 'flashcards' || kind === 'flashcard') {
          itemPayload = await storage.table('flashcards').get(sourceId).catch(() => null);
        } else if (kind === 'timeline') {
          itemPayload = await storage.table('timelines').get(sourceId).catch(() => null);
        } else if (kind === 'video') {
          itemPayload = await storage.table('video_assessments').get(sourceId).catch(() => null);
        }
      } catch (err) {
        console.warn(`[course-feed] Failed to build payload for item ${sourceId}:`, err);
      }
    }

    return {
      id: item.id,
      course_id: courseId,
      unit_id: item.unit_id || null,
      title: item.title || 'Untitled Item',
      kind,
      type: kind,
      source_id: sourceId,
      content_id: item.content_id || sourceId,
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
      color: course.color || '#2563eb',
      access_code: course.access_code,
      ...(relayUrl ? { relay_url: relayUrl } : {})
    },
    units: units.map(u => ({
      id: u.id,
      course_id: u.course_id,
      title: u.title,
      description: u.description || '',
      color: u.color || null,
      order: u.order ?? 0,
      created_at: u.created_at,
      updated_at: u.updated_at
    })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    items: enrichedItems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    published_at: new Date().toISOString(),
    revision: revisionHash
  };

  const rawAccessCode = (opts.accessCode || opts.passphrase || course.access_code || course.passphrase || '').trim();
  const normalizedAccessCode = rawAccessCode.toUpperCase().replace(/[^A-Z0-9]/g, '') || rawAccessCode;
  const packed = await CryptoShareEngine.createSharePayload('course_feed', feedPayload, normalizedAccessCode);
  const parsedFile = CryptoShareEngine.parseShareFile(packed.rawFileContent);

  return {
    course_id: courseId,
    etag: revisionHash,
    ciphertext: parsedFile.d,
    format_version: parsedFile.v,
    published_at: feedPayload.published_at,
    raw_payload: feedPayload,
    feed: feedPayload,
    encryptedEnvelope: parsedFile,
    accessCode: normalizedAccessCode,
    rawFileContent: packed.rawFileContent,
    stats: {
      unitsCount: feedPayload.units.length,
      itemsCount: feedPayload.items.length
    }
  };
}

export async function decryptCourseFeed(feedEnvelope, accessCode) {
  if (!feedEnvelope) throw new Error('No feed envelope provided');
  let d = '';
  let version = 2;
  let isEncrypted = Boolean(accessCode && String(accessCode).trim().length > 0);

  if (typeof feedEnvelope === 'string') {
    if (feedEnvelope.startsWith('{')) {
      try {
        const pf = CryptoShareEngine.parseShareFile(feedEnvelope);
        d = pf.d;
        version = pf.v;
        isEncrypted = pf.enc === '1';
      } catch (_) {
        d = feedEnvelope;
      }
    } else {
      d = feedEnvelope;
    }
  } else {
    d = feedEnvelope.ciphertext || feedEnvelope.d || '';
    version = feedEnvelope.format_version || feedEnvelope.v || 2;
    if (feedEnvelope.enc !== undefined) isEncrypted = feedEnvelope.enc === '1' || feedEnvelope.enc === 1;
  }

  const rawCode = String(accessCode || '').trim();
  const normalizedCode = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');

  const candidateCodes = [];
  if (normalizedCode) candidateCodes.push(normalizedCode);
  if (rawCode && rawCode !== normalizedCode) candidateCodes.push(rawCode);
  if (candidateCodes.length === 0) candidateCodes.push('');

  let lastError = null;
  for (const code of candidateCodes) {
    try {
      const unpacked = await CryptoShareEngine.unpackSharePayload(d, isEncrypted, code, version);
      const data = typeof unpacked === 'string' ? JSON.parse(unpacked) : unpacked;
      return data?.payload || data;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Failed to decrypt course feed');
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

/**
 * Automatically sync course feed to relay if transport is configured.
 * @param {string} courseId
 * @returns {Promise<{ feedId: string, etag: string, synced: boolean }|null>}
 */
export async function autoSyncCourseFeed(courseId) {
  if (!courseId) return null;
  try {
    const { getTransport, isTeacherRelayConfigured, PublicFeedTransport } = await import('./transport.js');
    const { markFeedPublished } = await import('./course-revision.js');
    const transport = await getTransport();
    if (!isTeacherRelayConfigured(transport)) return null;

    const freshCourse = await storage.table('gradebook_courses').get(courseId);
    if (!freshCourse) return null;

    const feedResult = await buildCourseFeed(courseId, { relayUrl: transport.baseUrl });
    const codeToUse = feedResult.accessCode || freshCourse.access_code;
    const feedId = await deriveCourseFeedId(codeToUse || courseId);
    const feedTransport = new PublicFeedTransport({ baseUrl: transport.baseUrl, token: transport.token });
    await feedTransport.publishCourseFeed(feedId, feedResult.ciphertext, feedResult.etag);
    await markFeedPublished(courseId, feedResult.etag);
    return { feedId, etag: feedResult.etag, synced: true };
  } catch (err) {
    console.warn('[course-feed] autoSyncCourseFeed failed:', err);
    return null;
  }
}

/**
 * Builds rich, self-contained student course join links and QR codes.
 * Ensures metadata (cname, cid, csec, ccolor) and inline feed ciphertext (d) are packaged when compact.
 * @param {string} courseId
 * @param {object} [opts]
 */
export async function buildStudentCourseJoinLinks(courseId, opts = {}) {
  const feedResult = await buildCourseFeed(courseId, opts);
  const course = feedResult.raw_payload?.course || {};
  const accessCode = feedResult.accessCode || course.access_code || '';
  const origin = opts.origin || (typeof window !== 'undefined' && window.location ? window.location.origin : 'https://kennisboost.local');
  const pathname = (typeof window !== 'undefined' && window.location && window.location.pathname) ? window.location.pathname : '/';
  const basePath = `${origin.replace(/\/+$/, '')}${pathname.startsWith('/') ? pathname : '/' + pathname}`;

  const { getStudentRelayUrl } = await import('./transport.js');
  const relayUrl = opts.relayUrl || course.relay_url || getStudentRelayUrl({ relay_url: course.relay_url }) || '';

  const params = new URLSearchParams();
  if (accessCode) params.set('code', accessCode);
  if (course.id) params.set('cid', course.id);
  if (course.name) params.set('cname', course.name);
  if (course.section) params.set('csec', course.section);
  if (course.color) params.set('ccolor', course.color);
  if (relayUrl) params.set('relay', relayUrl);

  const baseJoinUrl = `${basePath}#/student/courses?${params.toString()}`;

  // If ciphertext fits within safe URL budget (<= 4000 chars), include it so student loads offline with 0 server dependency
  let fullJoinUrl = baseJoinUrl;
  if (feedResult.ciphertext && feedResult.ciphertext.length <= 4000) {
    const fullParams = new URLSearchParams(params);
    fullParams.set('d', feedResult.ciphertext);
    fullJoinUrl = `${basePath}#/student/courses?${fullParams.toString()}`;
  }

  // QR Code URL: if full fits in standard QR budget (<= 1500 chars), use full; otherwise baseJoinUrl
  const qrUrl = (fullJoinUrl.length <= 1500) ? fullJoinUrl : baseJoinUrl;

  return {
    courseId,
    course,
    accessCode,
    joinUrl: fullJoinUrl,
    baseJoinUrl,
    qrUrl,
    ciphertext: feedResult.ciphertext,
    rawFileContent: feedResult.rawFileContent,
    stats: feedResult.stats,
    feedResult
  };
}
