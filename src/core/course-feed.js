import { storage } from './storage.js';
import { CryptoShareEngine } from './crypto-share.js';
import { computeCourseRevisionHash } from './course-revision.js';
import { getDue } from './due-dates.js';
import { SubmissionCrypto } from './submission-crypto.js';
import { buildStudentPayload } from '../modules/assignments/grading.js';
import { buildStudentTaskPayload } from '../modules/tasks/publish-core.js';
import { normalizeAccessCode, formatAccessCode } from './access-codes.js';

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
  const buildErrors = [];

  // Roster cards let a student who only knows their personal code find their own seat from the feed
  // (offline, on any device). Each card is encrypted with that student's code, so classmates learn nothing.
  const rosterCards = rosterWithCode.length ? await SubmissionCrypto.buildRosterCards(courseId, rosterWithCode) : {};

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
            const isPub = Boolean(rawAsg.publish?.published_at || rawAsg.publish?.version || rawAsg.published === true);
            if (!isPub) return null;
            if (!rawAsg.publish) {
              rawAsg.publish = { version: 1, salt: 'asg-salt-' + rawAsg.id.slice(0, 8), published_at: new Date().toISOString() };
            }
            const asgSalt = rawAsg.publish.salt || 'course-salt';
            const asgRosterChecks = rosterWithCode.length ? await SubmissionCrypto.buildRosterChecks(sourceId, rosterWithCode) : null;
            const asgRosterCards = rosterWithCode.length ? await SubmissionCrypto.buildRosterCards(sourceId, rosterWithCode) : null;
            itemPayload = await buildStudentPayload(rawAsg, {
              teacherKeys: keys,
              salt: asgSalt,
              rosterChecks: asgRosterChecks,
              rosterCards: asgRosterCards,
              courseMeta: { id: course.id, course_id: course.id, name: course.name, course_name: course.name, section: course.section, access_code: course.access_code },
              relay: rawAsg.publish?.relay || null
            });
          }
        } else if (kind === 'task') {
          const rawTask = await storage.table('tasks').get(sourceId).catch(() => null);
          if (rawTask) {
            const isPub = Boolean(rawTask.publish?.published_at || rawTask.publish?.version || rawTask.published === true);
            if (!isPub) return null;
            if (!rawTask.publish) {
              rawTask.publish = { version: 1, salt: 'task-salt-' + rawTask.id.slice(0, 8), published_at: new Date().toISOString() };
            }
            const taskSalt = rawTask.publish.salt || 'course-salt';
            let taskRosterChecks = null;
            let taskRosterCards = null;
            if (rosterWithCode.length > 0) {
              taskRosterChecks = await SubmissionCrypto.buildRosterChecks(sourceId, rosterWithCode);
              taskRosterCards = await SubmissionCrypto.buildRosterCards(sourceId, rosterWithCode);
            }
            itemPayload = await buildStudentTaskPayload(rawTask, {
              teacherKeys: keys,
              salt: taskSalt,
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
        // Never swallow this silently: a student would see an item with no content. Surface it in the
        // build/publish status (stats.itemErrors) as well as the console.
        console.warn(`[course-feed] Failed to build payload for item ${sourceId}:`, err);
        buildErrors.push({ item_id: item.id, source_id: sourceId, title: item.title || '', message: err?.message || String(err) });
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

  const baseRevision = await computeCourseRevisionHash(courseId).catch(() => 'rev-0');
  // The roster is part of the feed, so a roster change must change the ETag or students polling with
  // If-None-Match would never see it (this is how "removed by teacher" is detected).
  const rosterDigest = Object.keys(rosterCards).sort().join(',');
  const revisionHash = rosterDigest
    ? `${baseRevision}-${(await sha256Short(`roster|${rosterDigest}|${course.relay_moved_to || ''}`))}`
    : baseRevision;

  const feedPayload = {
    v: 1,
    course: {
      id: course.id,
      name: course.name,
      section: course.section,
      academic_year: course.academic_year,
      color: course.color || '#2563eb',
      access_code: course.access_code,
      ...(keys?.fingerprint ? { teacher_fingerprint: keys.fingerprint } : {}),
      ...(relayUrl ? { relay_url: relayUrl } : {}),
      ...(course.relay_moved_to ? { relay_moved_to: course.relay_moved_to } : {})
    },
    roster_cards: rosterCards,
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
    items: enrichedItems.filter(Boolean).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    published_at: new Date().toISOString(),
    revision: revisionHash
  };

  const rawAccessCode = (opts.accessCode || opts.passphrase || course.access_code || course.passphrase || '').trim();
  const normalizedAccessCode = normalizeAccessCode(rawAccessCode) || rawAccessCode;
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
      itemsCount: feedPayload.items.length,
      rosterCardCount: Object.keys(rosterCards).length,
      itemErrors: buildErrors
    }
  };
}

async function sha256Short(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
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
  const normalizedCode = normalizeAccessCode(rawCode);

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

const FEED_ID_SALT = 'kb-feed-id-v2';
const FEED_ID_ITERATIONS = 150000;
const _feedIdCache = new Map();

/**
 * Derive the feed ID from a class code: base64url(PBKDF2-SHA256(classCode, "kb-feed-id-v2", 150k)).
 *
 * The ID is public (it is the relay path). A slow KDF with 8-char codes (~10^12 values) makes
 * brute-forcing the relay database for class codes impractical. The feed is encrypted with the class
 * code through a different KDF salt (random per payload, see CryptoShareEngine), so knowing the ID
 * reveals nothing about the key. Teachers publish and students look up with this same function.
 * @param {string} accessCodeOrCourseId class code (any case, spaces/dashes allowed) or a course id fallback
 * @returns {Promise<string>} 43-char base64url string (or 'feed-unknown' for empty input)
 */
export async function deriveCourseFeedId(accessCodeOrCourseId) {
  const norm = normalizeAccessCode(accessCodeOrCourseId);
  if (!norm) return 'feed-unknown';
  if (_feedIdCache.has(norm)) return _feedIdCache.get(norm);
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(norm), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(FEED_ID_SALT), iterations: FEED_ID_ITERATIONS },
    material,
    256
  );
  let bin = '';
  for (const byte of new Uint8Array(bits)) bin += String.fromCharCode(byte);
  const id = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  _feedIdCache.set(norm, id);
  return id;
}

function feedApiBase(relayUrl) {
  const base = String(relayUrl || '').replace(/\/+$/, '');
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
}

/**
 * Fetch a course feed from a relay and report the outcome as a status instead of throwing, so the join
 * flow can tell "no such class" from "relay unreachable".
 * @returns {Promise<{ status: 'ok', ciphertext: string, etag: string }|{ status: 'not_found' }|{ status: 'offline', error: string }|{ status: 'error', httpStatus: number, error: string }>}
 */
export async function fetchCourseFeedByCode(relayUrl, classCode, { timeoutMs = 10000 } = {}) {
  const feedId = await deriveCourseFeedId(classCode);
  return fetchCourseFeedById(relayUrl, feedId, { timeoutMs });
}

export async function fetchCourseFeedById(relayUrl, feedId, { timeoutMs = 10000 } = {}) {
  if (!relayUrl) return { status: 'offline', error: 'No relay configured' };
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${feedApiBase(relayUrl)}/feed/${encodeURIComponent(feedId)}`, ctrl ? { signal: ctrl.signal } : {});
    if (res.status === 404 || res.status === 410) return { status: 'not_found' };
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { status: 'error', httpStatus: res.status, error: body.error || res.statusText || `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (!data?.ciphertext) return { status: 'not_found' };
    const etag = (res.headers?.get?.('ETag') || '').replace(/^"|"$/g, '') || data.etag || '';
    return { status: 'ok', ciphertext: data.ciphertext, etag, updatedAt: data.updated_at };
  } catch (err) {
    return { status: 'offline', error: err?.message || String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Remove a feed from the relay (owner only). Used when a class code is rotated so the old code stops
 * resolving. Resolves true when the feed is gone (including "already gone").
 */
export async function deleteCourseFeedById(relayUrl, token, feedId) {
  try {
    const res = await fetch(`${feedApiBase(relayUrl)}/feed/${encodeURIComponent(feedId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    return res.ok || res.status === 404 || res.status === 410;
  } catch (_) {
    return false;
  }
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
