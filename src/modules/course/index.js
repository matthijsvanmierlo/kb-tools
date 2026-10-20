import { ClassManager } from '../../components/class-manager.js';
import { renderCoursePage } from './render.js';
import { storage } from '../../core/storage.js';

/**
 * Teacher Course Module Controller (KB-COURSE-002)
 */
export async function renderCourseView(params, router, container) {
  let courseId = params?.id || params?.courseId;

  if (!courseId) {
    courseId = ClassManager.getActiveFilter();
  }

  if (!courseId) {
    const firstCourse = await storage.table('gradebook_courses').toCollection().first();
    if (firstCourse) {
      courseId = firstCourse.id;
      ClassManager.setActiveFilter(courseId);
    }
  }

  await renderCoursePage(courseId, container);
}
