import { storage } from '../../core/storage.js';
import { decryptCourseFeed } from '../../core/course-feed.js';

/**
 * Student Course Store (KB-STUDENT-002)
 * Ingests, decrypts, and persists course feeds into student IndexedDB storage.
 */

export async function mergeCourseFeed(feedEnvelope, { accessCode, etag, relayUrl } = {}) {
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
  const effectiveRelayUrl = relayUrl || course.relay_url || existingCourse?.relay_url || null;
  const effectiveEtag = etag || feedEnvelope?.etag || revision || existingCourse?.etag || 'rev-0';

  const courseRecord = {
    ...(existingCourse || {}),
    id: course.id,
    course_id: course.id,
    name: course.name,
    course_name: course.name,
    section: course.section || '',
    academic_year: course.academic_year || '',
    color: course.color || '#2563eb',
    access_code: accessCode || course.access_code || existingCourse?.access_code || '',
    revision: revision || existingCourse?.revision || 'rev-0',
    etag: effectiveEtag,
    ...(effectiveRelayUrl ? { relay_url: effectiveRelayUrl } : {}),
    units: units,
    updated_at: new Date().toISOString()
  };
  await coursesTable.put(courseRecord);

  // Sync to StudentProfile keychain
  try {
    const { StudentProfile } = await import('../../core/student-profile.js');
    await StudentProfile.saveIdentity({
      courseId: course.id,
      courseName: course.name,
      section: course.section || '',
      accessCode: courseRecord.access_code
    });
  } catch (_) {}

  // 2. Delete stale items no longer present in incoming feed
  const itemsTable = storage.table('student_items');
  const existingCourseItems = await itemsTable.where('course_id').equals(course.id).toArray().catch(() => []);
  const incomingItemIds = new Set(items.map(it => it.id));
  for (const oldItem of existingCourseItems) {
    if (!incomingItemIds.has(oldItem.id)) {
      await itemsTable.delete(oldItem.id).catch(() => {});
    }
  }

  // 3. Upsert items into student_items and local lesson tables
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
          } else {
            // Preserve student's local spaced-repetition progress on matching card IDs
            const existingFsrsMap = new Map();
            if (Array.isArray(existing.cards)) {
              for (const c of existing.cards) {
                if (c.id && c.fsrs) existingFsrsMap.set(c.id, c.fsrs);
              }
            }
            const mergedCards = Array.isArray(payload.cards) ? payload.cards.map(c => {
              if (c.id && existingFsrsMap.has(c.id)) {
                return { ...c, fsrs: existingFsrsMap.get(c.id) };
              }
              return c;
            }) : payload.cards;
            await fcTable.put({
              ...existing,
              ...payload,
              id: payload.id || sourceId,
              cards: mergedCards,
              updated_at: payload.updated_at || new Date().toISOString()
            });
          }
        } else if (kind === 'timeline') {
          const tlTable = storage.table('timelines');
          const existing = await tlTable.get(payload.id || sourceId).catch(() => null);
          if (!existing) {
            await tlTable.put({ ...payload, id: payload.id || sourceId });
          } else {
            await tlTable.put({
              ...existing,
              ...payload,
              id: payload.id || sourceId,
              updated_at: payload.updated_at || new Date().toISOString()
            });
          }
        } else if (kind === 'video') {
          const vidTable = storage.table('video_assessments');
          const existing = await vidTable.get(payload.id || sourceId).catch(() => null);
          if (!existing) {
            await vidTable.put({ ...payload, id: payload.id || sourceId });
          } else {
            await vidTable.put({
              ...existing,
              ...payload,
              id: payload.id || sourceId,
              updated_at: payload.updated_at || new Date().toISOString()
            });
          }
        } else if (kind === 'task') {
          const taskTable = storage.table('tasks');
          const existing = await taskTable.get(payload.id || sourceId).catch(() => null);
          if (!existing) {
            await taskTable.put({ ...payload, id: payload.id || sourceId });
          } else {
            await taskTable.put({
              ...existing,
              ...payload,
              id: payload.id || sourceId,
              updated_at: payload.updated_at || new Date().toISOString()
            });
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

/**
 * Upsert a student course record ensuring consistent schema across the entire app
 */
export async function upsertStudentCourse(courseMeta) {
  if (!courseMeta) return null;
  const courseId = courseMeta.id || courseMeta.course_id;
  if (!courseId) return null;

  const coursesTable = storage.table('student_courses');
  const existing = await coursesTable.get(courseId).catch(() => null);

  const courseName = courseMeta.name || courseMeta.course_name || existing?.name || existing?.course_name || 'Enrolled Course';

  const record = {
    ...(existing || {}),
    id: courseId,
    course_id: courseId,
    name: courseName,
    course_name: courseName,
    section: courseMeta.section || existing?.section || '',
    academic_year: courseMeta.academic_year || existing?.academic_year || '',
    color: courseMeta.color || existing?.color || '#2563eb',
    access_code: courseMeta.access_code || existing?.access_code || '',
    relay_url: courseMeta.relay_url || existing?.relay_url || null,
    teacher_name: courseMeta.teacher_name || existing?.teacher_name || '',
    teacher_fingerprint: courseMeta.teacher_fingerprint || existing?.teacher_fingerprint || '',
    units: courseMeta.units || existing?.units || [],
    updated_at: new Date().toISOString()
  };

  await coursesTable.put(record);

  // Synchronize to StudentProfile.classes
  try {
    const { StudentProfile } = await import('../../core/student-profile.js');
    await StudentProfile.saveIdentity({
      courseId,
      courseName,
      section: record.section,
      accessCode: record.access_code,
      teacherFingerprint: record.teacher_fingerprint
    });
  } catch (_) {}

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('kb-student-feed-updated', { detail: { courseId, course: record } }));
  }

  return record;
}

/**
 * Join course by access code or course ID with automatic local, relay, and fallback resolution.
 */
export async function joinCourseByCode(code, opts = {}) {
  if (!code || typeof code !== 'string') throw new Error('Course code is required');
  const relayUrl = typeof opts === 'string' ? opts : (opts.relayUrl || null);
  const courseName = typeof opts === 'object' ? (opts.courseName || opts.name || '') : '';
  const section = typeof opts === 'object' ? (opts.section || '') : '';
  const color = typeof opts === 'object' ? (opts.color || '#2563eb') : '#2563eb';
  const customId = typeof opts === 'object' ? (opts.courseId || opts.id || null) : null;
  const embeddedFeed = typeof opts === 'object' ? (opts.embeddedFeed || opts.feed || null) : null;

  const cleanCode = code.trim().toUpperCase();
  const normalizedCode = cleanCode.replace(/[^A-Z0-9]/g, '');

  // 0. If embedded feed is provided in opts, merge directly
  if (embeddedFeed) {
    try {
      return await mergeCourseFeed(embeddedFeed, { accessCode: cleanCode, relayUrl });
    } catch (e) {
      console.warn('Failed to merge provided embeddedFeed:', e);
    }
  }

  // 1. First, check if there's a matching course in local gradebook_courses (same device / kiosk / demo / local server)
  try {
    const localCourses = await storage.table('gradebook_courses').toArray().catch(() => []);
    let localMatch = localCourses.find(c => {
      const cNorm = (c.access_code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      return (cNorm && (cNorm === normalizedCode || cNorm === cleanCode)) || c.id === code.trim();
    });

    if (!localMatch) {
      // Check if code belongs to a student seat in gradebook_students
      const localStudents = await storage.table('gradebook_students').toArray().catch(() => []);
      const matchedStudent = localStudents.find(s => {
        const sNorm = (s.access_code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        return sNorm && (sNorm === normalizedCode || sNorm === cleanCode);
      });
      if (matchedStudent) {
        localMatch = localCourses.find(c => c.id === matchedStudent.course_id);
      }
    }

    if (localMatch) {
      const { buildCourseFeed } = await import('../../core/course-feed.js');
      const feed = await buildCourseFeed(localMatch.id, { relayUrl: relayUrl || localMatch.relay_url || null });
      return await mergeCourseFeed(feed.raw_payload, { accessCode: cleanCode, relayUrl });
    }
  } catch (err) {
    console.warn('Local course lookup check failed:', err);
  }

  // 2. Second, if relayUrl is provided or configured in transport, query public course feed from relay
  try {
    const { getTransport, PublicFeedTransport } = await import('../../core/transport.js');
    const { deriveCourseFeedId } = await import('../../core/course-feed.js');
    const transport = await getTransport();
    const effectiveBaseUrl = relayUrl || transport?.baseUrl;
    if (effectiveBaseUrl) {
      const feedTransport = new PublicFeedTransport({ baseUrl: effectiveBaseUrl, token: transport?.token || null });
      const feedId = await deriveCourseFeedId(cleanCode);
      const res = await feedTransport.fetchCourseFeed(feedId);
      if (res && res.ciphertext) {
        return await mergeCourseFeed(res.ciphertext, { accessCode: cleanCode, etag: res.etag, relayUrl: effectiveBaseUrl });
      }
    }
  } catch (err) {
    console.warn('Remote feed lookup by access code failed:', err);
  }

  // 3. Fallback: create enrolled course using real metadata if supplied, so class appears immediately in student hub & keychain
  const displayName = courseName || `Course (${cleanCode})`;
  const targetId = customId || ('course_' + (normalizedCode || cleanCode).toLowerCase());
  return await upsertStudentCourse({
    id: targetId,
    course_id: targetId,
    name: displayName,
    course_name: displayName,
    section: section,
    color: color,
    access_code: cleanCode,
    relay_url: relayUrl || null
  });
}

/**
 * Reconcile student_courses with StudentProfile.classes and student_items
 */
export async function reconcileStudentCoursesWithProfile() {
  try {
    const { StudentProfile } = await import('../../core/student-profile.js');
    const profile = StudentProfile.get();
    const coursesTable = storage.table('student_courses');
    const existingCourses = await coursesTable.toArray().catch(() => []);
    const existingMap = new Map(existingCourses.map(c => [c.id || c.course_id, c]));

    // Check profile.classes
    const classList = profile?.classes
      ? (Array.isArray(profile.classes) ? profile.classes : Object.values(profile.classes))
      : [];
    for (const cls of classList) {
      const cId = cls.course_id || cls.courseId;
      if (!cId) continue;
      const existing = existingMap.get(cId);
      const cName = cls.course_name || cls.courseName || 'Enrolled Class';
      if (!existing) {
        await upsertStudentCourse({
          id: cId,
          name: cName,
          course_name: cName,
          section: cls.section || '',
          access_code: cls.access_code || cls.accessCode || '',
          teacher_fingerprint: cls.teacher_fingerprint || cls.teacherFingerprint || ''
        });
      } else {
        let changed = false;
        if (!existing.name && (existing.course_name || cName)) {
          existing.name = existing.course_name || cName;
          changed = true;
        }
        if (!existing.course_name && (existing.name || cName)) {
          existing.course_name = existing.name || cName;
          changed = true;
        }
        if (changed) {
          await coursesTable.put(existing);
        }
      }
    }

    // Check student_items for any courses missing from student_courses
    const items = await storage.table('student_items').toArray().catch(() => []);
    const orphanedCourseIds = new Set();
    for (const it of items) {
      if (it.course_id && !existingMap.has(it.course_id)) {
        orphanedCourseIds.add(it.course_id);
      }
    }
    for (const cid of orphanedCourseIds) {
      await upsertStudentCourse({
        id: cid,
        name: 'Shared Course',
        course_name: 'Shared Course'
      });
    }

    // Fix any student_courses that have name but not course_name, or vice-versa
    for (const c of existingCourses) {
      if (c.name && !c.course_name) {
        c.course_name = c.name;
        await coursesTable.put(c);
      } else if (c.course_name && !c.name) {
        c.name = c.course_name;
        await coursesTable.put(c);
      }
    }
  } catch (err) {
    console.warn('Reconcile student courses failed:', err);
  }
}
