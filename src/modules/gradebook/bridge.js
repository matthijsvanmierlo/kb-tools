import { storage } from '../../core/storage.js';
import { generateUUID } from '../../utils/uuid.js';

/**
 * Gradebook Bridge (KB-GRAD-006)
 *
 * The one place other modules (Assignments, Video receipts) write into the gradebook. Keeps the
 * column ↔ source link (`source: { type, id }`) so re-importing updates the same column.
 */
export class GradebookBridge {
  /**
   * Find or create the gradebook column linked to an external source.
   * @param {object} opts
   * @param {string} opts.courseId
   * @param {{ type: string, id: string }} [opts.source] - e.g. { type: 'assignment', id }
   * @param {string} [opts.sourceType] - 'assignment' | 'video'
   * @param {string} [opts.sourceId] - external source id
   * @param {string} opts.title
   * @param {number} [opts.maxScore]
   * @param {number} [opts.maxPoints]
   * @param {string} [opts.categoryId] - defaults to the course's first category
   * @param {string[]} [opts.standardIds]
   * @param {string} [opts.dueDate]
   * @returns {Promise<object>} gradebook assignment record
   */
  static async upsertLinkedColumn({ courseId, source, sourceType, sourceId, title, maxScore, maxPoints, categoryId, standardIds, dueDate, scoring, rubricId }) {
    const table = storage.table('gradebook_assignments');
    const actualSource = source || (sourceType && sourceId ? { type: sourceType, id: sourceId } : null);
    if (!actualSource) throw new Error('MISSING_SOURCE');

    const existing = (await table.where('course_id').equals(courseId).toArray())
      .find(a => a.source && a.source.type === actualSource.type && a.source.id === actualSource.id);

    const course = await storage.table('gradebook_courses').get(courseId);
    if (!course) throw new Error('COURSE_NOT_FOUND');

    const resolvedMaxScore = maxPoints !== undefined ? maxPoints : (maxScore !== undefined ? maxScore : 100);

    const deterministicId = `gbcol_${courseId}_${actualSource.type}_${actualSource.id}`;
    const record = {
      ...(existing || {}),
      id: existing?.id || deterministicId,
      course_id: courseId,
      term_id: existing?.term_id || course.terms?.[0]?.id || null,
      category_id: categoryId || existing?.category_id || course.categories?.[0]?.id || null,
      title: title || existing?.title || 'Assignment',
      max_score: resolvedMaxScore,
      due_date: dueDate !== undefined ? dueDate : (existing?.due_date || new Date().toISOString().slice(0, 10)),
      standard_ids: standardIds || existing?.standard_ids || [],
      source: actualSource
    };
    if (scoring !== undefined) record.scoring = scoring;
    else if (!record.scoring) record.scoring = 'points';
    if (rubricId !== undefined) record.rubric_id = rubricId;

    await table.put(record);
    return record;
  }

  /**
   * Write (or update) one student's grade in a column without discarding teacher edits such as
   * status or feedback that the source doesn't know about.
   */
  static async writeGrade({ courseId, assignmentId, studentId, rawScore, feedback, status, extra = {} }) {
    const table = storage.table('gradebook_grades');
    const existing = await table.get([studentId, assignmentId]).catch(() => null);
    const record = {
      ...(existing || {}),
      course_id: courseId,
      student_id: studentId,
      assignment_id: assignmentId,
      raw_score: rawScore,
      status: status || (existing?.status === 'late' ? 'late' : 'submitted'),
      ...(feedback !== undefined ? { feedback } : {}),
      ...extra
    };
    await table.put(record);
    return record;
  }

  static async listCourses() {
    return storage.table('gradebook_courses').toArray();
  }

  static async listStudents(courseId) {
    return storage.table('gradebook_students').where('course_id').equals(courseId).toArray();
  }
}

/**
 * Synchronize content item class link and automatic gradebook column creation.
 * Used by ProjectLibraryView, Assignment Editor, Video Editor, and Share dialogs.
 *
 * @param {object} item
 * @param {'assignments' | 'video' | 'flashcards' | 'timeline'} moduleType
 * @param {string|null} classId
 * @returns {Promise<object>} updated item
 */
export async function syncContentClassLink(item, moduleType, classId) {
  const targetClassId = classId && classId !== 'unassigned' ? classId : null;
  item.class_id = targetClassId;

  const isAssignment = moduleType === 'assignments' || moduleType === 'assignment';
  const isVideo = moduleType === 'video' || moduleType === 'videos';
  const isTask = moduleType === 'tasks' || moduleType === 'task';

  if (isAssignment || isTask) {
    item.gradebook = {
      ...(item.gradebook || {}),
      course_id: targetClassId
    };
    if (!targetClassId) {
      item.gradebook.column_id = null;
      item.gradebook.gradebook_assignment_id = null;
    }
  } else if (isVideo) {
    if (item.gradebook || targetClassId) {
      item.gradebook = {
        ...(item.gradebook || {}),
        course_id: targetClassId
      };
      if (!targetClassId) {
        item.gradebook.column_id = null;
        item.gradebook.gradebook_assignment_id = null;
      }
    }
  }

  if (targetClassId && (isAssignment || isVideo || isTask)) {
    let maxPoints = 0;
    if (isAssignment) {
      maxPoints = (item.questions || []).reduce((sum, q) => sum + (Number(q.points) || 0), 0) || 100;
    } else if (isVideo) {
      maxPoints = (item.checkpoints || []).reduce((sum, cp) => sum + (Number(cp.points) || 1), 0) || 10;
    } else if (isTask) {
      maxPoints = item.grading?.max_points ?? 100;
    }

    try {
      const col = await GradebookBridge.upsertLinkedColumn({
        courseId: targetClassId,
        sourceType: isAssignment ? 'assignment' : (isTask ? 'task' : 'video'),
        sourceId: item.id,
        title: item.title || item.name || 'Untitled',
        maxPoints,
        dueDate: item.settings?.due_date || undefined,
        categoryId: item.gradebook?.category_id,
        scoring: isTask ? item.grading?.scoring : undefined,
        rubricId: isTask ? item.grading?.rubric_id : undefined,
        standardIds: isTask ? item.grading?.standard_ids : undefined
      });
      if (!item.gradebook) item.gradebook = {};
      item.gradebook.column_id = col.id;
      item.gradebook.gradebook_assignment_id = col.id;
    } catch (err) {
      console.warn('GradebookBridge column auto-sync error:', err);
    }
  } else if (!targetClassId && (isAssignment || isVideo || isTask) && item.id) {
    // Unassigned: remove linked column from gradebook_assignments if exists
    try {
      const srcType = isAssignment ? 'assignment' : (isTask ? 'task' : 'video');
      const cols = await storage.table('gradebook_assignments').toArray();
      const stale = cols.filter(c => c.source?.type === srcType && c.source?.id === item.id);
      if (stale.length > 0) {
        await storage.table('gradebook_assignments').bulkDelete(stale.map(c => c.id));
      }
    } catch (_) {}
  }

  item.updated_at = new Date().toISOString();

  // Persist if item belongs to a known table
  const tableName = isAssignment ? 'assignments' : (isTask ? 'tasks' : (isVideo ? 'video_assessments' : null));
  if (tableName && item.id) {
    try {
      await storage.table(tableName).put(item);
    } catch (e) {
      // ignore if called before table ready or in mock
    }
  }

  // Auto-sync into course_items so it immediately appears on Course Plan (#/course) and in student course feed
  if (targetClassId && item.id) {
    try {
      await ensureCourseItemForClassContent(targetClassId, moduleType, item);
    } catch (e) {
      console.warn('ensureCourseItemForClassContent error:', e);
    }
  }

  return item;
}

/**
 * Ensure an item linked to a class has a corresponding entry in course_items.
 */
export async function ensureCourseItemForClassContent(courseId, moduleType, item) {
  if (!courseId || !item || !item.id) return null;

  const course = await storage.table('gradebook_courses').get(courseId).catch(() => null);
  if (!course) return null;

  let units = await storage.table('course_units').where('course_id').equals(courseId).toArray().catch(() => []);
  if (units.length === 0) {
    const defaultUnit = {
      id: generateUUID(),
      course_id: courseId,
      title: 'Class Assignments & Materials',
      description: 'Course work and study resources',
      order: 0,
      color: course.color || '#0d9488',
      created_at: new Date().toISOString()
    };
    await storage.table('course_units').put(defaultUnit);
    units = [defaultUnit];
  }

  const existingItems = await storage.table('course_items').where('course_id').equals(courseId).toArray().catch(() => []);
  const existing = existingItems.find(ci => ci.source_id === item.id || ci.content_id === item.id || ci.id === item.id);
  if (existing) {
    // Update title/due if changed
    existing.title = item.title || item.name || existing.title;
    if (item.settings?.due_date !== undefined) existing.due_date = item.settings.due_date;
    await storage.table('course_items').put(existing);
    return existing;
  }

  let kind = 'assignment';
  if (moduleType === 'task' || moduleType === 'tasks') kind = 'task';
  else if (moduleType === 'video' || moduleType === 'videos') kind = 'video';
  else if (moduleType === 'flashcards' || moduleType === 'deck') kind = 'flashcards';
  else if (moduleType === 'timeline' || moduleType === 'timelines') kind = 'timeline';

  const targetUnitId = units.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0].id;
  const isPublished = item.published !== false;

  const newCi = {
    id: generateUUID(),
    course_id: courseId,
    unit_id: targetUnitId,
    title: item.title || item.name || 'Untitled Item',
    kind,
    source_id: item.id,
    order: existingItems.length,
    points: item.total_points || item.grading?.max_points || 100,
    due_date: item.settings?.due_date || item.due_date || null,
    due_time: item.settings?.due_time || item.due_time || null,
    published: isPublished,
    hidden: item.hidden === true,
    created_at: item.created_at || new Date().toISOString()
  };

  await storage.table('course_items').put(newCi);
  return newCi;
}

/**
 * Scan all content tables and sync any items assigned to courseId into course_items.
 * Also ensures the course has an access_code.
 */
export async function reconcileCourseItemsForClass(courseId) {
  if (!courseId) return [];
  const course = await storage.table('gradebook_courses').get(courseId).catch(() => null);
  if (!course) return [];

  // Ensure course has access_code
  if (!course.access_code) {
    const { AccessCodes } = await import('../../core/access-codes.js');
    course.access_code = AccessCodes.generateCode();
    await storage.table('gradebook_courses').put(course);
  }

  let units = await storage.table('course_units').where('course_id').equals(courseId).toArray().catch(() => []);
  let items = await storage.table('course_items').where('course_id').equals(courseId).toArray().catch(() => []);

  const [tasks, assignments, decks, timelines, videos] = await Promise.all([
    storage.table('tasks').toArray().catch(() => []),
    storage.table('assignments').toArray().catch(() => []),
    storage.table('flashcards').toArray().catch(() => []),
    storage.table('timelines').toArray().catch(() => []),
    storage.table('video_assessments').toArray().catch(() => [])
  ]);

  const matches = [];
  tasks.forEach(t => {
    if (t.class_id === courseId || t.gradebook?.course_id === courseId) matches.push({ kind: 'task', item: t });
  });
  assignments.forEach(a => {
    if (a.class_id === courseId || a.gradebook?.course_id === courseId) matches.push({ kind: 'assignment', item: a });
  });
  decks.forEach(d => {
    if (d.class_id === courseId) matches.push({ kind: 'flashcards', item: d });
  });
  timelines.forEach(t => {
    if (t.class_id === courseId) matches.push({ kind: 'timeline', item: t });
  });
  videos.forEach(v => {
    if (v.class_id === courseId || v.gradebook?.course_id === courseId) matches.push({ kind: 'video', item: v });
  });

  if (matches.length === 0) return items;

  if (units.length === 0) {
    const defaultUnit = {
      id: generateUUID(),
      course_id: courseId,
      title: 'Class Assignments & Materials',
      description: 'Course work and study resources',
      order: 0,
      color: course.color || '#0d9488',
      created_at: new Date().toISOString()
    };
    await storage.table('course_units').put(defaultUnit);
    units = [defaultUnit];
  }

  const primaryUnitId = units.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0].id;
  const existingSourceIds = new Set(items.map(ci => ci.source_id || ci.content_id || ci.id));

  let orderCount = items.length;
  let addedAny = false;

  for (const { kind, item } of matches) {
    if (!existingSourceIds.has(item.id) && !item.course_plan_excluded) {
      const isPublished = item.published !== false;

      const newCi = {
        id: generateUUID(),
        course_id: courseId,
        unit_id: primaryUnitId,
        title: item.title || item.name || 'Untitled Item',
        kind,
        source_id: item.id,
        order: orderCount++,
        points: item.total_points || item.grading?.max_points || 100,
        due_date: item.settings?.due_date || item.due_date || null,
        due_time: item.settings?.due_time || item.due_time || null,
        published: isPublished,
        hidden: item.hidden === true,
        created_at: item.created_at || new Date().toISOString()
      };
      await storage.table('course_items').put(newCi);
      existingSourceIds.add(item.id);
      addedAny = true;
    }
  }

  if (addedAny) {
    items = await storage.table('course_items').where('course_id').equals(courseId).toArray().catch(() => []);
  }

  return items;
}

GradebookBridge.reconcileCourseItemsForClass = reconcileCourseItemsForClass;
GradebookBridge.ensureCourseItemForClassContent = ensureCourseItemForClassContent;


GradebookBridge.syncContentClassLink = syncContentClassLink;

export default GradebookBridge;
