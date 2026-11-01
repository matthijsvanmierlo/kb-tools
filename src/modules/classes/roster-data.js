import { storage } from '../../core/storage.js';
import { computeCourseAggregates } from '../gradebook/aggregates.js';

/**
 * Roster Data Loader & Mutations (KB-CLASS-002)
 * Loads full roster context for a given class/course and manages roster lifecycle.
 */
export async function loadRosterContext(courseId) {
  if (!courseId) return null;

  const course = await storage.table('gradebook_courses').get(courseId);
  if (!course) return null;

  const [rawStudents, allAssignments, grades, rubrics] = await Promise.all([
    storage.table('gradebook_students').where('course_id').equals(courseId).toArray().catch(() => []),
    storage.table('gradebook_assignments').where('course_id').equals(courseId).toArray().catch(() => []),
    storage.table('gradebook_grades').where('course_id').equals(courseId).toArray().catch(() => []),
    storage.table('gradebook_rubrics').where('course_id').equals(courseId).toArray().catch(() => [])
  ]);

  const students = rawStudents.filter(s => !s.removed_at);

  const gradesMap = new Map();
  for (const g of grades) {
    gradesMap.set(`${g.student_id}+${g.assignment_id}`, g);
  }

  let studentAggregates = {};
  try {
    studentAggregates = computeCourseAggregates(students, course, allAssignments, gradesMap);
  } catch (err) {
    console.warn('Failed to compute course aggregates for roster:', err);
  }

  return {
    course,
    students,
    allStudents: rawStudents,
    allAssignments,
    gradesMap,
    rubrics,
    studentAggregates
  };
}

/**
 * Soft delete a student from a course with an undo handle.
 * Preserves the student record and existing grades while marking removed_at.
 *
 * @param {string} courseId
 * @param {string} studentId
 * @returns {Promise<{ student: object, undo: () => Promise<void> } | null>}
 */
export async function removeStudent(courseId, studentId) {
  if (!courseId || !studentId) return null;
  const student = await storage.table('gradebook_students').get(studentId);
  if (!student) return null;

  const previousRemovedAt = student.removed_at || null;
  const now = new Date().toISOString();
  student.removed_at = now;
  student.updated_at = now;
  await storage.table('gradebook_students').put(student);

  // Soft-drop in student_courses if present
  const studentCourse = await storage.table('student_courses').get(courseId).catch(() => null);
  let previousStudentCourseStatus = null;
  if (studentCourse) {
    previousStudentCourseStatus = studentCourse.status;
    studentCourse.status = 'dropped';
    studentCourse.updated_at = now;
    await storage.table('student_courses').put(studentCourse);
  }

  // Debounced/immediate feed re-publish
  try {
    const { autoSyncCourseFeed } = await import('../../core/course-feed.js');
    await autoSyncCourseFeed(courseId).catch(() => {});
  } catch (_) {}

  const undo = async () => {
    const s = await storage.table('gradebook_students').get(studentId);
    if (s) {
      if (previousRemovedAt) s.removed_at = previousRemovedAt;
      else delete s.removed_at;
      s.updated_at = new Date().toISOString();
      await storage.table('gradebook_students').put(s);
    }
    if (studentCourse) {
      studentCourse.status = previousStudentCourseStatus || 'active';
      studentCourse.updated_at = new Date().toISOString();
      await storage.table('student_courses').put(studentCourse);
    }
    try {
      const { autoSyncCourseFeed } = await import('../../core/course-feed.js');
      await autoSyncCourseFeed(courseId).catch(() => {});
    } catch (_) {}
  };

  return { student, undo };
}

/**
 * Move a student to another section/class while keeping access_code and grades intact.
 *
 * @param {string} studentId
 * @param {string} fromClassId
 * @param {string} toClassId
 * @returns {Promise<boolean>}
 */
export async function moveStudent(studentId, fromClassId, toClassId) {
  if (!studentId || !toClassId) return false;
  const student = await storage.table('gradebook_students').get(studentId);
  if (!student) return false;

  const now = new Date().toISOString();
  student.course_id = toClassId;
  student.updated_at = now;
  delete student.removed_at;
  await storage.table('gradebook_students').put(student);

  if (fromClassId) {
    const grades = await storage.table('gradebook_grades').where('course_id').equals(fromClassId).toArray().catch(() => []);
    for (const g of grades) {
      if (g.student_id === studentId || g.student_id === student.student_id) {
        g.course_id = toClassId;
        g.updated_at = now;
        await storage.table('gradebook_grades').put(g);
      }
    }
  }

  try {
    const { autoSyncCourseFeed } = await import('../../core/course-feed.js');
    if (fromClassId) await autoSyncCourseFeed(fromClassId).catch(() => {});
    await autoSyncCourseFeed(toClassId).catch(() => {});
  } catch (_) {}

  return true;
}

export const RosterData = {
  loadRosterContext,
  removeStudent,
  moveStudent
};
