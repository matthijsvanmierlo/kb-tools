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
        name: courseName,
        course_name: courseName,
        section,
        teacher_fingerprint: feedbackPayload.teacher_fingerprint || '',
        created_at: now,
        updated_at: now
      };
      await storage.table('student_courses').put(course);
    } else {
      if (courseName && (course.course_name !== courseName || !course.name)) {
        course.name = courseName;
        course.course_name = courseName;
        course.updated_at = now;
        await storage.table('student_courses').put(course);
      }
    }

    // 2. Upsert ledger entry in student_ledger
    const assignmentId = asgMeta.id || feedbackPayload.assignment_id || generateUUID();
    let existing = null;
    const existingArr = await storage.table('student_ledger')
      .where('[course_id+assignment_id]')
      .equals([courseId, assignmentId])
      .toArray()
      .catch(() => []);
    if (existingArr?.length) {
      existing = existingArr[0];
    } else {
      // Fallback matching by normalized title within the course
      const titleTarget = String(asgMeta.title || feedbackPayload.title || '').trim().toLowerCase();
      if (titleTarget) {
        const courseEntries = await storage.table('student_ledger').where('course_id').equals(courseId).toArray().catch(() => []);
        const matched = courseEntries.find(e => String(e.title || '').trim().toLowerCase() === titleTarget);
        if (matched) existing = matched;
      }
    }

    const newScore = {
      earned: Number(feedbackPayload.score?.earned) || 0,
      possible: Number(feedbackPayload.score?.possible) || Number(asgMeta.total_points) || 0,
      pending: Number(feedbackPayload.score?.pending) || 0
    };
    const newOverallFeedback = feedbackPayload.overall_feedback || feedbackPayload.feedback || '';

    // Record revision history if the score or overall comment was updated
    const history = Array.isArray(existing?.history) ? [...existing.history] : [];
    if (existing && existing.score && (
      existing.score.earned !== newScore.earned ||
      existing.score.possible !== newScore.possible ||
      (existing.overall_feedback || '') !== newOverallFeedback
    )) {
      history.push({
        score: { ...existing.score },
        overall_feedback: existing.overall_feedback || '',
        received_at: existing.received_at || existing.updated_at || now,
        updated_by: 'teacher'
      });
    }

    const questions = (Array.isArray(feedbackPayload.questions) && feedbackPayload.questions.length > 0)
      ? feedbackPayload.questions
      : (Array.isArray(existing?.questions) ? existing.questions : []);

    const item = {
      id: existing?.id || generateUUID(),
      course_id: courseId,
      assignment_id: assignmentId,
      title: asgMeta.title || feedbackPayload.title || existing?.title || 'Assignment Feedback',
      item_type: 'assignment_feedback',
      student_id: sMeta.student_id || feedbackPayload.student_id || existing?.student_id || '',
      student_name: sMeta.full_name || feedbackPayload.student_name || existing?.student_name || '',
      score: newScore,
      overall_feedback: newOverallFeedback,
      questions,
      history,
      due_date: asgMeta.due_date || existing?.due_date || null,
      submitted_at: feedbackPayload.submission?.submitted_at || existing?.submitted_at || null,
      received_at: feedbackPayload.generated_at || now,
      feedback_unseen: true,
      feedback_received_at: feedbackPayload.generated_at || now,
      receipt_id: existing?.receipt_id || null,
      submission_text: existing?.submission_text || null,
      local_answers: existing?.local_answers || null,
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
   * Ingest student feedback for a task (kind: 'task_feedback').
   * Merges by [course_id + task_id] and updates the student ledger.
   *
   * @param {object} feedbackPayload
   * @returns {Promise<{ course: object, item: object }>}
   */
  static async ingestTaskFeedback(feedbackPayload) {
    if (!feedbackPayload || typeof feedbackPayload !== 'object') {
      throw new Error('INVALID_FEEDBACK_PAYLOAD');
    }

    const now = new Date().toISOString();
    const cMeta = feedbackPayload.course || {};
    const taskMeta = feedbackPayload.task || {};
    const sMeta = feedbackPayload.student || {};

    const courseId = cMeta.id || cMeta.course_id || (cMeta.name ? `course_${String(cMeta.name).toLowerCase().replace(/[^a-z0-9]+/g, '_')}` : 'default_class');
    const courseName = cMeta.name || 'My Class';
    const section = cMeta.section || '';

    let course = await storage.table('student_courses').get(courseId).catch(() => null);
    if (!course) {
      course = {
        id: courseId,
        course_id: courseId,
        name: courseName,
        course_name: courseName,
        section,
        created_at: now,
        updated_at: now
      };
      await storage.table('student_courses').put(course);
    } else if (!course.name && course.course_name) {
      course.name = course.course_name;
      await storage.table('student_courses').put(course);
    }

    const taskId = taskMeta.id || feedbackPayload.task_id || feedbackPayload.assignment_id || generateUUID();
    let existing = null;
    const existingArr = await storage.table('student_ledger')
      .where('[course_id+assignment_id]')
      .equals([courseId, taskId])
      .toArray()
      .catch(() => []);

    if (existingArr?.length) {
      existing = existingArr[0];
    } else {
      const titleTarget = String(taskMeta.title || feedbackPayload.title || '').trim().toLowerCase();
      if (titleTarget) {
        const courseEntries = await storage.table('student_ledger').where('course_id').equals(courseId).toArray().catch(() => []);
        const matched = courseEntries.find(e => String(e.title || '').trim().toLowerCase() === titleTarget);
        if (matched) existing = matched;
      }
    }

    const rawScore = feedbackPayload.grade?.points ?? feedbackPayload.score?.earned ?? null;
    const maxScore = feedbackPayload.grade?.max_points ?? feedbackPayload.task?.max_points ?? 100;
    const newScore = {
      earned: rawScore !== null ? Number(rawScore) : null,
      possible: Number(maxScore),
      status: feedbackPayload.grade?.status || 'submitted',
      scoring: feedbackPayload.task?.scoring || feedbackPayload.grade?.scoring || 'points'
    };
    const newOverallFeedback = feedbackPayload.overall_feedback || feedbackPayload.feedback || '';

    const history = Array.isArray(existing?.history) ? [...existing.history] : [];
    if (existing && existing.score && (
      existing.score.earned !== newScore.earned ||
      (existing.overall_feedback || '') !== newOverallFeedback
    )) {
      history.push({
        score: { ...existing.score },
        overall_feedback: existing.overall_feedback || '',
        received_at: existing.received_at || existing.updated_at || now,
        updated_by: 'teacher'
      });
    }

    const item = {
      id: existing?.id || generateUUID(),
      course_id: courseId,
      assignment_id: taskId,
      title: taskMeta.title || feedbackPayload.title || existing?.title || 'Assignment Feedback',
      item_type: 'task_feedback',
      student_id: sMeta.student_id || feedbackPayload.student_id || existing?.student_id || '',
      student_name: sMeta.full_name || feedbackPayload.student_name || existing?.student_name || '',
      score: newScore,
      overall_feedback: newOverallFeedback,
      rubric: feedbackPayload.rubric || existing?.rubric || null,
      standards: feedbackPayload.grade?.standards || existing?.standards || [],
      code_files: feedbackPayload.code_files || existing?.code_files || [],
      drawing: feedbackPayload.drawing || existing?.drawing || null,
      attachments: feedbackPayload.attachments || existing?.attachments || [],
      text: feedbackPayload.text || existing?.text || '',
      history,
      due_date: taskMeta.due_date || existing?.due_date || null,
      submitted_at: feedbackPayload.submission?.submitted_at || existing?.submitted_at || null,
      received_at: feedbackPayload.generated_at || now,
      feedback_unseen: true,
      feedback_received_at: feedbackPayload.generated_at || now,
      receipt_id: existing?.receipt_id || null,
      submission_text: existing?.submission_text || null,
      updated_at: now
    };

    await storage.table('student_ledger').put(item);

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
   * Supports both reportPayload.assignments and reportPayload.grades.
   * @param {object} reportPayload
   * @returns {Promise<{ count: number }>}
   */
  static async ingestGradeReport(reportPayload) {
    if (!reportPayload) {
      throw new Error('INVALID_GRADE_REPORT');
    }

    const gradesList = Array.isArray(reportPayload.assignments)
      ? reportPayload.assignments
      : (Array.isArray(reportPayload.grades) ? reportPayload.grades : null);

    if (!gradesList) {
      throw new Error('INVALID_GRADE_REPORT');
    }

    let count = 0;
    const now = new Date().toISOString();
    const courseId = reportPayload.course?.id || reportPayload.course?.course_id || reportPayload.course_id || 'reported_course';
    const courseName = reportPayload.course?.name || reportPayload.course_name || 'Enrolled Course';

    let course = await storage.table('student_courses').get(courseId).catch(() => null);
    if (!course) {
      course = {
        id: courseId,
        course_id: courseId,
        name: courseName,
        course_name: courseName,
        section: reportPayload.course?.section || '',
        updated_at: now
      };
      await storage.table('student_courses').put(course);
    } else if (!course.name && course.course_name) {
      course.name = course.course_name;
      await storage.table('student_courses').put(course);
    }

    for (const g of gradesList) {
      const asgId = g.assignment_id || g.id || generateUUID();
      let existing = null;
      const existingArr = await storage.table('student_ledger')
        .where('[course_id+assignment_id]')
        .equals([courseId, asgId])
        .toArray()
        .catch(() => []);

      if (existingArr?.length) {
        existing = existingArr[0];
      } else {
        const titleTarget = String(g.assignment_title || g.title || '').trim().toLowerCase();
        if (titleTarget) {
          const courseEntries = await storage.table('student_ledger').where('course_id').equals(courseId).toArray().catch(() => []);
          const matched = courseEntries.find(e => String(e.title || '').trim().toLowerCase() === titleTarget);
          if (matched) existing = matched;
        }
      }

      const earned = g.grade?.raw_score != null ? Number(g.grade.raw_score) : (g.score != null ? Number(g.score) : Number(g.earned || 0));
      const possible = g.max_score != null ? Number(g.max_score) : (g.possible != null ? Number(g.possible) : (existing?.score?.possible || 0));
      const overall_feedback = g.grade?.feedback || g.feedback || existing?.overall_feedback || '';

      const history = Array.isArray(existing?.history) ? [...existing.history] : [];
      if (existing && existing.score && (existing.score.earned !== earned || existing.score.possible !== possible)) {
        history.push({
          score: { ...existing.score },
          overall_feedback: existing.overall_feedback || '',
          received_at: existing.received_at || existing.updated_at || now,
          updated_by: 'report'
        });
      }

      const item = {
        id: existing?.id || generateUUID(),
        course_id: courseId,
        assignment_id: asgId,
        title: g.assignment_title || g.title || existing?.title || 'Assignment',
        item_type: existing?.item_type === 'assignment_feedback' ? 'assignment_feedback' : 'report_grade',
        student_id: reportPayload.student?.student_id || existing?.student_id || '',
        student_name: reportPayload.student?.full_name || existing?.student_name || '',
        score: {
          earned,
          possible,
          pending: existing?.score?.pending || 0
        },
        overall_feedback,
        // Never wipe question-level breakdown if student previously ingested detailed feedback
        questions: Array.isArray(existing?.questions) && existing.questions.length > 0 ? existing.questions : [],
        history,
        due_date: g.due_date || existing?.due_date || null,
        submitted_at: existing?.submitted_at || null,
        receipt_id: existing?.receipt_id || null,
        submission_text: existing?.submission_text || null,
        local_answers: existing?.local_answers || null,
        received_at: reportPayload.generated_at || now,
        updated_at: now
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
   * Apply feedback for an item (assessment or task) into the student's ledger.
   *
   * @param {object} params
   * @param {'assignment'|'task'} [params.kind='assignment']
   * @param {string} params.itemId - assignment_id or task_id
   * @param {string} [params.courseId]
   * @param {string} [params.title]
   * @param {number} [params.score]
   * @param {number} [params.maxScore]
   * @param {number} [params.percent]
   * @param {string} [params.feedback]
   * @param {string} [params.released_at]
   * @param {string} [params.source]
   * @returns {Promise<object>}
   */
  static async applyFeedback({
    kind = 'assignment',
    itemId,
    courseId = 'default_class',
    title = '',
    score = null,
    maxScore = null,
    percent = null,
    feedback = '',
    released_at = null,
    source = 'relay',
    ...rest
  }) {
    if (!itemId) throw new Error('MISSING_ITEM_ID');

    const now = new Date().toISOString();
    const resolvedCourseId = courseId || 'default_class';

    // Find existing entry by [course_id + assignment_id] or assignment_id or id
    let existing = null;
    const byCompound = await storage.table('student_ledger')
      .where('[course_id+assignment_id]')
      .equals([resolvedCourseId, itemId])
      .toArray()
      .catch(() => []);
    if (byCompound?.length) {
      existing = byCompound[0];
    } else {
      const all = await storage.table('student_ledger').toArray().catch(() => []);
      existing = all.find(e => e.assignment_id === itemId || e.id === itemId || e.id === `fb-${itemId}-${e.student_id || 'me'}`);
    }

    const earned = score !== null ? Number(score) : (existing?.score?.earned ?? null);
    const possible = maxScore !== null ? Number(maxScore) : (existing?.score?.possible ?? null);
    const scoreObj = (earned !== null || possible !== null) ? {
      earned: earned ?? 0,
      possible: possible ?? 0,
      percent: percent ?? (possible > 0 ? Math.round((earned / possible) * 100) : null)
    } : (existing?.score || null);

    const history = Array.isArray(existing?.history) ? [...existing.history] : [];
    if (existing && existing.score && (existing.score.earned !== earned || existing.score.possible !== possible)) {
      history.push({
        score: { ...existing.score },
        overall_feedback: existing.overall_feedback || '',
        received_at: existing.received_at || existing.updated_at || now,
        updated_by: source || 'teacher'
      });
    }

    const item = {
      ...existing,
      ...rest,
      id: existing?.id || generateUUID(),
      course_id: resolvedCourseId,
      assignment_id: itemId,
      title: title || existing?.title || (kind === 'task' ? 'Assignment' : 'Assessment'),
      item_type: kind === 'task' ? 'task_feedback' : 'assignment_feedback',
      score: scoreObj,
      overall_feedback: feedback || existing?.overall_feedback || '',
      feedback: feedback || existing?.feedback || '',
      feedback_unseen: true,
      feedback_received_at: released_at || now,
      received_at: released_at || now,
      history,
      status: 'Reviewed',
      submission_status: 'Reviewed',
      updated_at: now
    };

    await storage.table('student_ledger').put(item);

    // Also update student_items if it exists
    const existingItem = await storage.table('student_items').get(itemId).catch(() => null);
    if (existingItem) {
      existingItem.status = 'reviewed';
      if (score !== null) existingItem.grade = score;
      if (feedback) existingItem.teacher_feedback = feedback;
      existingItem.reviewed_at = item.feedback_received_at;
      await storage.table('student_items').put(existingItem).catch(() => {});
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kb-student-ledger-updated', { detail: { courseId: resolvedCourseId, item } }));
      window.dispatchEvent(new CustomEvent('kb-feedback-imported', { detail: item }));
    }

    return item;
  }

  /**
   * Mark feedback as seen by the student.
   * @param {string} itemId
   */
  static async markFeedbackSeen(itemId) {
    const all = await storage.table('student_ledger').toArray().catch(() => []);
    const items = all.filter(e => e.assignment_id === itemId || e.id === itemId);
    for (const it of items) {
      it.feedback_unseen = false;
      await storage.table('student_ledger').put(it);
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kb-student-ledger-updated', { detail: { itemId, seen: true } }));
    }
  }

  /**
   * Count how many feedback items have not been seen yet by the student.
   * @returns {Promise<number>}
   */
  static async getUnseenFeedbackCount() {
    const all = await storage.table('student_ledger').toArray().catch(() => []);
    return all.filter(e => e.feedback_unseen === true).length;
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
    receiptId = null,
    answers = null,
    submissionText = null,
    status = null,
    releaseGradeImmediately = null
  }) {
    const cId = courseId || 'self_study';
    let course = await storage.table('student_courses').get(cId).catch(() => null);
    const resolvedName = courseName || (cId === 'self_study' ? 'Self Study' : 'My Course');
    if (!course) {
      course = {
        id: cId,
        course_id: cId,
        name: resolvedName,
        course_name: resolvedName,
        updated_at: submittedAt
      };
      await storage.table('student_courses').put(course);
    } else {
      let changed = false;
      if (courseName && course.course_name !== courseName) {
        course.course_name = courseName;
        course.name = courseName;
        changed = true;
      } else if (!course.name && course.course_name) {
        course.name = course.course_name;
        changed = true;
      }
      if (changed) {
        course.updated_at = submittedAt;
        await storage.table('student_courses').put(course);
      }
    }

    const existingArr = await storage.table('student_ledger')
      .where('[course_id+assignment_id]')
      .equals([cId, assignmentId])
      .toArray()
      .catch(() => []);
    const existing = existingArr?.[0] || null;

    let score = existing?.score || null;
    const shouldRelease = releaseGradeImmediately === true || (releaseGradeImmediately !== false && (cId === 'self_study' || releaseGradeImmediately === null));
    if (!score && shouldRelease && clientScore) {
      score = {
        earned: clientScore.earned ?? 0,
        possible: clientScore.possible ?? 0,
        pending: clientScore.pending ?? 0
      };
    }

    let resolvedStatus = status;
    if (!resolvedStatus) {
      if (receiptId) {
        resolvedStatus = `Handed in (server receipt ${receiptId})`;
      } else {
        resolvedStatus = 'Ready to hand in';
      }
    }

    const item = {
      id: existing?.id || generateUUID(),
      course_id: cId,
      assignment_id: assignmentId,
      title: title || existing?.title || 'Submitted Assignment',
      item_type: existing?.item_type === 'assignment_feedback' ? 'assignment_feedback' : 'submission',
      student_id: studentId || existing?.student_id || '',
      student_name: studentName || existing?.student_name || '',
      score,
      client_score: clientScore || existing?.client_score || null,
      status: resolvedStatus,
      overall_feedback: existing?.overall_feedback || '',
      questions: Array.isArray(existing?.questions) ? existing.questions : [],
      history: Array.isArray(existing?.history) ? existing.history : [],
      receipt_id: receiptId || existing?.receipt_id || null,
      submission_text: submissionText || existing?.submission_text || null,
      local_answers: answers || existing?.local_answers || null,
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
