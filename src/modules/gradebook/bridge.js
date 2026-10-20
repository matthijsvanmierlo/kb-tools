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
  static async upsertLinkedColumn({ courseId, source, sourceType, sourceId, title, maxScore, maxPoints, categoryId, standardIds, dueDate }) {
    const table = storage.table('gradebook_assignments');
    const actualSource = source || (sourceType && sourceId ? { type: sourceType, id: sourceId } : null);
    if (!actualSource) throw new Error('MISSING_SOURCE');

    const existing = (await table.where('course_id').equals(courseId).toArray())
      .find(a => a.source && a.source.type === actualSource.type && a.source.id === actualSource.id);

    const course = await storage.table('gradebook_courses').get(courseId);
    if (!course) throw new Error('COURSE_NOT_FOUND');

    const resolvedMaxScore = maxPoints !== undefined ? maxPoints : (maxScore !== undefined ? maxScore : 100);

    const record = {
      ...(existing || {}),
      id: existing?.id || generateUUID(),
      course_id: courseId,
      term_id: existing?.term_id || course.terms?.[0]?.id || null,
      category_id: categoryId || existing?.category_id || course.categories?.[0]?.id || null,
      title: title || existing?.title || 'Assignment',
      max_score: resolvedMaxScore,
      due_date: dueDate !== undefined ? dueDate : (existing?.due_date || new Date().toISOString().slice(0, 10)),
      standard_ids: standardIds || existing?.standard_ids || [],
      source: actualSource
    };
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

  if (isAssignment) {
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

  if (targetClassId && (isAssignment || isVideo)) {
    let maxPoints = 0;
    if (isAssignment) {
      maxPoints = (item.questions || []).reduce((sum, q) => sum + (Number(q.points) || 0), 0) || 100;
    } else if (isVideo) {
      maxPoints = (item.checkpoints || []).reduce((sum, cp) => sum + (Number(cp.points) || 1), 0) || 10;
    }

    try {
      const col = await GradebookBridge.upsertLinkedColumn({
        courseId: targetClassId,
        sourceType: isAssignment ? 'assignment' : 'video',
        sourceId: item.id,
        title: item.title || item.name || 'Untitled',
        maxPoints,
        dueDate: item.settings?.due_date || undefined
      });
      if (!item.gradebook) item.gradebook = {};
      item.gradebook.column_id = col.id;
      item.gradebook.gradebook_assignment_id = col.id;
    } catch (err) {
      console.warn('GradebookBridge column auto-sync error:', err);
    }
  } else if (!targetClassId && (isAssignment || isVideo) && item.id) {
    // Unassigned: remove linked column from gradebook_assignments if exists
    try {
      const srcType = isAssignment ? 'assignment' : 'video';
      const cols = await storage.table('gradebook_assignments').toArray();
      const stale = cols.filter(c => c.source?.type === srcType && c.source?.id === item.id);
      if (stale.length > 0) {
        await storage.table('gradebook_assignments').bulkDelete(stale.map(c => c.id));
      }
    } catch (_) {}
  }

  item.updated_at = new Date().toISOString();

  // Persist if item belongs to a known table
  const tableName = isAssignment ? 'assignments' : (isVideo ? 'video_assessments' : null);
  if (tableName && item.id) {
    try {
      await storage.table(tableName).put(item);
    } catch (e) {
      // ignore if called before table ready or in mock
    }
  }

  return item;
}

GradebookBridge.syncContentClassLink = syncContentClassLink;

export default GradebookBridge;
