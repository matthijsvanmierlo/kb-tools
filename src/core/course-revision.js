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
