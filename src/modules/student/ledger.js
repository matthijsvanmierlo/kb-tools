/**
 * StudentLedger - Persistent Student Gradebook & Feedback Ledger (KB-STUDENT-003)
 *
 * Manages the student's personal gradebook records in IndexedDB.
 * Automatically ingests, deduplicates, and organizes teacher feedback links, files,
 * and submissions into courses and assignments.
 */

import { storage } from '../../core/storage.js';
import { generateUUID } from '../../utils/uuid.js';
import { StudentProfile } from '../../core/student-profile.js';

export class StudentLedger {
  /**
   * Ingest and persist teacher assignment feedback into the student's ledger.
   *
   * @param {object} feedbackPayload - Appendix C / buildFeedbackPayload output
   * @returns {Promise<{ course: object, item: object }>}
   */
  static async ingestAssignmentFeedback(feedbackPayload) {
    if (!feedbackPayload || typeof feedbackPayload !== 'object') {
      throw new Error('INVALID_FEEDBACK_PAYLOAD');
    }

    const now = new Date().toISOString();
    const cMeta = feedbackPayload.course || {};
    const asgMeta = feedbackPayload.assignment || {};
    const sMeta = feedbackPayload.student || {};

    // 1. Resolve or create course in student_courses
    const courseId = cMeta.id || cMeta.course_id || (cMeta.name ? `course_${String(cMeta.name).toLowerCase().replace(/[^a-z0-9]+/g, '_')}` : 'default_class');
    const courseName = cMeta.name || 'My Class';
    const section = cMeta.section || '';

    let course = await storage.table('student_courses').get(courseId).catch(() => null);
    if (!course) {
      course = {
        id: courseId,
        course_id: courseId,
        course_name: courseName,
        section,
        teacher_fingerprint: feedbackPayload.teacher_fingerprint || '',
        created_at: now,
        updated_at: now
      };
      await storage.table('student_courses').put(course);
    } else {
      if (courseName && course.course_name !== courseName) {
        course.course_name = courseName;
        course.updated_at = now;
        await storage.table('student_courses').put(course);
      }
    }

    // 2. Upsert ledger entry in student_ledger
    const assignmentId = asgMeta.id || feedbackPayload.assignment_id || generateUUID();
    const existingArr = await storage.table('student_ledger')
      .where('[course_id+assignment_id]')
      .equals([courseId, assignmentId])
      .toArray()
      .catch(() => []);
    const existing = existingArr?.[0] || null;

    const item = {
      id: existing?.id || generateUUID(),
      course_id: courseId,
      assignment_id: assignmentId,
      title: asgMeta.title || feedbackPayload.title || 'Assignment Feedback',
      item_type: 'assignment_feedback',
      student_id: sMeta.student_id || feedbackPayload.student_id || '',
      student_name: sMeta.full_name || feedbackPayload.student_name || '',
      score: {
        earned: Number(feedbackPayload.score?.earned) || 0,
        possible: Number(feedbackPayload.score?.possible) || Number(asgMeta.total_points) || 0,
        pending: Number(feedbackPayload.score?.pending) || 0
      },
      overall_feedback: feedbackPayload.overall_feedback || feedbackPayload.feedback || '',
      questions: Array.isArray(feedbackPayload.questions) ? feedbackPayload.questions : [],
      due_date: asgMeta.due_date || null,
      submitted_at: feedbackPayload.submission?.submitted_at || existing?.submitted_at || null,
      received_at: feedbackPayload.generated_at || now,
      updated_at: now
    };

    await storage.table('student_ledger').put(item);

    // 3. Sync student identity keychain
    if (item.student_id || item.student_name) {
      StudentProfile.saveIdentity({
        studentId: item.student_id,
        fullName: item.student_name,
        courseId,
        courseName,
        section
      }).catch(() => {});
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kb-student-ledger-updated', { detail: { courseId, item } }));
    }

    return { course, item };
  }

  /**
   * Ingest a multi-assignment student grade report.
   * @param {object} reportPayload
   * @returns {Promise<{ count: number }>}
   */
  static async ingestGradeReport(reportPayload) {
    if (!reportPayload || !Array.isArray(reportPayload.grades)) {
      throw new Error('INVALID_GRADE_REPORT');
    }

    let count = 0;
    const courseId = reportPayload.course?.id || reportPayload.course_id || 'reported_course';
    const courseName = reportPayload.course?.name || reportPayload.course_name || 'Enrolled Course';

    let course = await storage.table('student_courses').get(courseId).catch(() => null);
    if (!course) {
      course = {
        id: courseId,
        course_id: courseId,
        course_name: courseName,
        section: reportPayload.course?.section || '',
        updated_at: new Date().toISOString()
      };
      await storage.table('student_courses').put(course);
    }

    for (const g of reportPayload.grades) {
      const asgId = g.assignment_id || generateUUID();
      const existingArr = await storage.table('student_ledger')
        .where('[course_id+assignment_id]')
        .equals([courseId, asgId])
        .toArray()
        .catch(() => []);
      const existing = existingArr?.[0] || null;

      const item = {
        id: existing?.id || generateUUID(),
        course_id: courseId,
        assignment_id: asgId,
        title: g.assignment_title || g.title || 'Assignment',
        item_type: 'report_grade',
        student_id: reportPayload.student?.student_id || '',
        student_name: reportPayload.student?.full_name || '',
        score: {
          earned: Number(g.score) || Number(g.earned) || 0,
          possible: Number(g.max_score) || Number(g.possible) || 0,
          pending: 0
        },
        overall_feedback: g.feedback || '',
        questions: [],
        received_at: reportPayload.generated_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      await storage.table('student_ledger').put(item);
      count++;
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kb-student-ledger-updated', { detail: { courseId } }));
    }

    return { count };
  }

  /**
   * Record a locally completed submission into the ledger.
   */
  static async recordSubmission({
    assignmentId,
    courseId = null,
    courseName = '',
    title,
    studentId,
    studentName,
    clientScore = null,
    submittedAt = new Date().toISOString(),
    receiptId = null
  }) {
    const cId = courseId || 'self_study';
    let course = await storage.table('student_courses').get(cId).catch(() => null);
    if (!course) {
      course = {
        id: cId,
        course_id: cId,
        course_name: courseName || 'My Course',
        updated_at: submittedAt
      };
      await storage.table('student_courses').put(course);
    }

    const existingArr = await storage.table('student_ledger')
      .where('[course_id+assignment_id]')
      .equals([cId, assignmentId])
      .toArray()
      .catch(() => []);
    const existing = existingArr?.[0] || null;

    const item = {
      id: existing?.id || generateUUID(),
      course_id: cId,
      assignment_id: assignmentId,
      title: title || 'Submitted Assignment',
      item_type: existing?.item_type === 'assignment_feedback' ? 'assignment_feedback' : 'submission',
      student_id: studentId || '',
      student_name: studentName || '',
      score: existing?.score || {
        earned: clientScore?.earned ?? 0,
        possible: clientScore?.possible ?? 0,
        pending: clientScore?.pending ?? 0
      },
      receipt_id: receiptId || null,
      submitted_at: submittedAt,
      received_at: existing?.received_at || null,
      updated_at: new Date().toISOString()
    };

    await storage.table('student_ledger').put(item);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kb-student-ledger-updated', { detail: { courseId: cId, item } }));
    }

    return item;
  }

  /**
   * Retrieve all enrolled student courses with summary metrics.
   * @returns {Promise<Array<object>>}
   */
  static async getStudentCourses() {
    const [courses, allItems] = await Promise.all([
      storage.table('student_courses').toArray().catch(() => []),
      storage.table('student_ledger').toArray().catch(() => [])
    ]);

    return courses.map(c => {
      const items = allItems.filter(it => it.course_id === c.id);
      const gradedItems = items.filter(it => it.score && it.score.possible > 0);
      const totalEarned = gradedItems.reduce((acc, it) => acc + (it.score.earned || 0), 0);
      const totalPossible = gradedItems.reduce((acc, it) => acc + (it.score.possible || 0), 0);
      const averagePercent = totalPossible > 0 ? Math.round((totalEarned / totalPossible) * 100) : null;

      return {
        ...c,
        assignmentCount: items.length,
        gradedCount: gradedItems.length,
        averagePercent,
        latestReceivedAt: items.reduce((latest, it) => {
          const d = it.received_at || it.submitted_at || '';
          return d > latest ? d : latest;
        }, '')
      };
    }).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }

  /**
   * Get all ledger items for a specific course.
   * @param {string} courseId
   * @returns {Promise<Array<object>>}
   */
  static async getCourseLedger(courseId) {
    const items = await storage.table('student_ledger')
      .where('course_id')
      .equals(courseId)
      .toArray()
      .catch(() => []);

    return items.sort((a, b) => {
      const dateA = a.received_at || a.submitted_at || a.updated_at || '';
      const dateB = b.received_at || b.submitted_at || b.updated_at || '';
      return dateB.localeCompare(dateA);
    });
  }

  /**
   * Get all ledger items across all enrolled courses.
   * @returns {Promise<Array<object>>}
   */
  static async getAllLedgerEntries() {
    const items = await storage.table('student_ledger').toArray().catch(() => []);
    return items.sort((a, b) => {
      const dateA = a.received_at || a.submitted_at || a.updated_at || '';
      const dateB = b.received_at || b.submitted_at || b.updated_at || '';
      return dateB.localeCompare(dateA);
    });
  }

  /**
   * Delete a single entry from the ledger.
   * @param {string} id
   */
  static async deleteLedgerItem(id) {
    await storage.table('student_ledger').delete(id);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kb-student-ledger-updated', { detail: { id } }));
    }
  }
}
