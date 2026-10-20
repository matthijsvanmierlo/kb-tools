import { storage } from '../../core/storage.js';
import { computeCourseAggregates } from '../gradebook/aggregates.js';

/**
 * Roster Data Loader (KB-CLASS-002)
 * Loads full roster context for a given class/course.
 */
export async function loadRosterContext(courseId) {
  if (!courseId) return null;

  const course = await storage.table('gradebook_courses').get(courseId);
  if (!course) return null;

  const [students, allAssignments, grades, rubrics] = await Promise.all([
    storage.table('gradebook_students').where('course_id').equals(courseId).toArray().catch(() => []),
    storage.table('gradebook_assignments').where('course_id').equals(courseId).toArray().catch(() => []),
    storage.table('gradebook_grades').where('course_id').equals(courseId).toArray().catch(() => []),
    storage.table('gradebook_rubrics').where('course_id').equals(courseId).toArray().catch(() => [])
  ]);

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
    allAssignments,
    gradesMap,
    rubrics,
    studentAggregates
  };
}
