import { storage } from '../../core/storage.js';
import { decryptCourseFeed } from '../../core/course-feed.js';

/**
 * Student Course Store (KB-STUDENT-002)
 * Ingests, decrypts, and persists course feeds into student IndexedDB storage.
 */

export async function mergeCourseFeed(feedEnvelope, { accessCode } = {}) {
  let feed = null;

  if (feedEnvelope && feedEnvelope.course && Array.isArray(feedEnvelope.items)) {
    // Already decrypted payload
    feed = feedEnvelope;
  } else {
    feed = await decryptCourseFeed(feedEnvelope, accessCode);
  }

  if (!feed || !feed.course || !feed.course.id) {
    throw new Error('Invalid course feed structure');
  }

  const { course, units = [], items = [], revision } = feed;

  // 1. Upsert course record into student_courses
  const coursesTable = storage.table('student_courses');
  const existingCourse = await coursesTable.get(course.id).catch(() => null);

  const courseRecord = {
    ...(existingCourse || {}),
    id: course.id,
    name: course.name,
    section: course.section || '',
    academic_year: course.academic_year || '',
    color: course.color || '#2563eb',
    access_code: accessCode || course.access_code || existingCourse?.access_code || '',
    revision: revision || existingCourse?.revision || 'rev-0',
    units: units,
    updated_at: new Date().toISOString()
  };
  await coursesTable.put(courseRecord);

  // 2. Upsert items into student_items and local lesson tables
  const itemsTable = storage.table('student_items');
  for (const item of items) {
    const existingItem = await itemsTable.get(item.id).catch(() => null);
    const payload = item.payload || existingItem?.payload || null;
    const kind = item.kind || item.type || 'assignment';
    const sourceId = item.source_id || item.id;

    const itemRecord = {
      ...(existingItem || {}),
      id: item.id,
      course_id: course.id,
      unit_id: item.unit_id || null,
      title: item.title,
      kind,
      type: kind,
      source_id: sourceId,
      order: item.order ?? 0,
      due_date: item.due_date || null,
      due_time: item.due_time || null,
      points: item.points ?? 100,
      description: item.description || '',
      settings: item.settings || {},
      payload,
      updated_at: new Date().toISOString()
    };
    await itemsTable.put(itemRecord);

    // If payload is present, also populate local tables so players work seamlessly
    if (payload && typeof payload === 'object') {
      try {
        if (kind === 'flashcards' || kind === 'flashcard') {
          const fcTable = storage.table('flashcards');
          const existing = await fcTable.get(payload.id || sourceId).catch(() => null);
          if (!existing) {
            await fcTable.put({ ...payload, id: payload.id || sourceId });
          }
        } else if (kind === 'timeline') {
          const tlTable = storage.table('timelines');
          const existing = await tlTable.get(payload.id || sourceId).catch(() => null);
          if (!existing) {
            await tlTable.put({ ...payload, id: payload.id || sourceId });
          }
        } else if (kind === 'video') {
          const vidTable = storage.table('video_assessments');
          const existing = await vidTable.get(payload.id || sourceId).catch(() => null);
          if (!existing) {
            await vidTable.put({ ...payload, id: payload.id || sourceId });
          }
        }
      } catch (err) {
        console.warn('Failed to cache course item locally:', err);
      }
    }
  }

  // 3. Dispatch event for UI reactivity
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('kb-student-feed-updated', {
      detail: { courseId: course.id, course: courseRecord }
    }));
  }

  return { course: courseRecord, units, items };
}

export async function getStudentCourses() {
  try {
    return await storage.table('student_courses').toArray();
  } catch (err) {
    console.warn('Failed to load student courses:', err);
    return [];
  }
}

export async function getStudentCourse(courseId) {
  if (!courseId) return null;
  try {
    const course = await storage.table('student_courses').get(courseId);
    if (!course) return null;

    const items = await storage.table('student_items').where('course_id').equals(courseId).toArray().catch(() => []);
    return {
      course,
      units: course.units || [],
      items: items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    };
  } catch (err) {
    console.warn('Failed to load student course context:', err);
    return null;
  }
}
