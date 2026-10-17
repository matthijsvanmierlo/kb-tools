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
   * @param {{ type: string, id: string }} opts.source - e.g. { type: 'assignment', id }
   * @param {string} opts.title
   * @param {number} opts.maxScore
   * @param {string} [opts.categoryId] - defaults to the course's first category
   * @param {string[]} [opts.standardIds]
   * @returns {Promise<object>} gradebook assignment record
   */
  static async upsertLinkedColumn({ courseId, source, title, maxScore, categoryId, standardIds, dueDate }) {
    const table = storage.table('gradebook_assignments');
    const existing = (await table.where('course_id').equals(courseId).toArray())
      .find(a => a.source && a.source.type === source.type && a.source.id === source.id);

    const course = await storage.table('gradebook_courses').get(courseId);
    if (!course) throw new Error('COURSE_NOT_FOUND');

    const record = {
      ...(existing || {}),
      id: existing?.id || generateUUID(),
      course_id: courseId,
      term_id: existing?.term_id || course.terms?.[0]?.id || null,
      category_id: categoryId || existing?.category_id || course.categories?.[0]?.id || null,
      title,
      max_score: maxScore,
      due_date: dueDate || existing?.due_date || new Date().toISOString().slice(0, 10),
      standard_ids: standardIds || existing?.standard_ids || [],
      source
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

export default GradebookBridge;
