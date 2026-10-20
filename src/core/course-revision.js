import { storage } from './storage.js';

/**
 * Course Revision & Content Hashing (KB-COURSE-REV)
 * Tracks content modifications and manages cache-invalidation dirty state.
 */

function sanitizeForHashing(val) {
  if (val === null || val === undefined) return null;
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(sanitizeForHashing);

  const clean = {};
  const keys = Object.keys(val).sort();
  for (const k of keys) {
    // Exclude internal timestamps or ephemeral UI state
    if (['updated_at', 'created_at', 'dirty_since', 'content_hash', 'revision'].includes(k)) continue;
    clean[k] = sanitizeForHashing(val[k]);
  }
  return clean;
}

export async function contentHash(item) {
  if (!item) return '';
  const clean = sanitizeForHashing(item);
  const json = JSON.stringify(clean);
  const buf = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function touch(item, courseId = null) {
  if (!item) return false;
  const hash = await contentHash(item);
  const changed = item.content_hash !== hash;

  if (changed) {
    item.content_hash = hash;
    item.revision = (item.revision || 0) + 1;
    item.updated_at = new Date().toISOString();

    const targetCourse = courseId || item.course_id || item.class_id;
    if (targetCourse) {
      await markCourseFeedDirty(targetCourse);
    }
    return true;
  }
  return false;
}

export async function markCourseFeedDirty(courseId) {
  if (!courseId) return;
  try {
    const course = await storage.table('gradebook_courses').get(courseId);
    if (course) {
      course.feed = course.feed || {};
      course.feed.dirty_since = new Date().toISOString();
      course.updated_at = new Date().toISOString();
      await storage.table('gradebook_courses').put(course);
    }
  } catch (err) {
    console.warn('[course-revision] Failed to mark course feed dirty:', err);
  }
}

/**
 * Compute canonical course revision hash across the course, its units, and its items.
 * @param {string} courseId
 * @returns {Promise<string>}
 */
export async function computeCourseRevisionHash(courseId) {
  if (!courseId) return 'rev-0';
  try {
    const course = await storage.table('gradebook_courses').get(courseId);
    const [units, items] = await Promise.all([
      storage.table('course_units').where('course_id').equals(courseId).sortBy('order').catch(() => []),
      storage.table('course_items').where('course_id').equals(courseId).sortBy('order').catch(() => [])
    ]);

    const descriptor = {
      course: course ? { id: course.id, name: course.name, updated_at: course.updated_at } : null,
      units: units.map(u => ({ id: u.id, title: u.title, order: u.order, updated_at: u.updated_at })),
      items: items.map(i => ({ id: i.id, title: i.title, order: i.order, content_hash: i.content_hash, updated_at: i.updated_at }))
    };

    return await contentHash(descriptor);
  } catch (err) {
    console.warn('[course-revision] Failed to compute revision hash:', err);
    return 'rev-0';
  }
}

/**
 * Checks whether the course feed has unpublished changes since its last publication.
 * @param {string} courseId
 * @returns {Promise<boolean>}
 */
export async function isFeedDirty(courseId) {
  if (!courseId) return false;
  try {
    const course = await storage.table('gradebook_courses').get(courseId);
    if (!course || !course.feed) return false;
    const dirtySince = course.feed.dirty_since;
    if (!dirtySince) return false;
    const lastPublished = course.feed.last_published;
    if (!lastPublished) return true;
    return new Date(dirtySince).getTime() > new Date(lastPublished).getTime();
  } catch (err) {
    console.warn('[course-revision] Failed to check feed dirty status:', err);
    return false;
  }
}

/**
 * Marks the course feed as clean and records the published timestamp and ETag.
 * @param {string} courseId
 * @param {string} [etag]
 * @returns {Promise<void>}
 */
export async function markFeedPublished(courseId, etag = '') {
  if (!courseId) return;
  try {
    const course = await storage.table('gradebook_courses').get(courseId);
    if (course) {
      course.feed = course.feed || {};
      course.feed.last_published = new Date().toISOString();
      course.feed.last_etag = etag || null;
      course.feed.dirty_since = null;
      course.updated_at = new Date().toISOString();
      await storage.table('gradebook_courses').put(course);
    }
  } catch (err) {
    console.warn('[course-revision] Failed to mark feed published:', err);
  }
}

