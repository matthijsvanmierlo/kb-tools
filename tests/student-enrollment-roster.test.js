import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { renderStudentCoursesView } from '../src/modules/student/courses.js';
import { syncTaskSubmissionsToGradebook } from '../src/modules/tasks/submissions.js';
import { StudentProfile } from '../src/core/student-profile.js';

describe('Student Enrollment & Teacher Roster Reflection', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const tables = [
      'gradebook_courses',
      'gradebook_students',
      'gradebook_assignments',
      'gradebook_grades',
      'student_courses',
      'student_items',
      'task_submissions',
      'tasks',
      'course_units',
      'course_items'
    ];
    for (const t of tables) {
      try {
        await storage.table(t).clear();
      } catch (_) {}
    }
  });

  it('joins a class via access code without ReferenceError', async () => {
    // Seed teacher course
    const courseId = 'course-bio-101';
    await storage.table('gradebook_courses').add({
      id: courseId,
      name: 'AP Biology',
      access_code: 'BIO-9876',
      color: '#10b981'
    });

    const container = document.createElement('div');
    const router = { navigate: () => {} };

    // Joining with code parameter in URL (e.g. #/student/courses?code=BIO-9876)
    await expect(
      renderStudentCoursesView({ code: 'BIO-9876' }, router, container)
    ).resolves.not.toThrow();

    const enrolled = await storage.table('student_courses').get(courseId);
    expect(enrolled).toBeDefined();
    expect(enrolled.name).toBe('AP Biology');

    // Access code must be saved in student profile keychain
    const profile = StudentProfile.get();
    const classEntry = Object.values(profile.classes).find(c => c.course_id === courseId);
    expect(classEntry?.access_code).toBe('BIO9876');
  });

  it('allows student to join using personal student access code and auto-configures identity', async () => {
    const courseId = 'course-chem-202';
    await storage.table('gradebook_courses').add({
      id: courseId,
      name: 'Honors Chemistry',
      access_code: 'CHEM-MAIN',
      color: '#6366f1'
    });

    // Seed student in teacher roster with a personal slip code
    await storage.table('gradebook_students').add({
      id: 'gs-1',
      course_id: courseId,
      student_id: 'STU-EMMA',
      full_name: 'Emma Watson',
      access_code: 'SLIP-4421'
    });

    const container = document.createElement('div');
    const router = { navigate: () => {} };

    // Emma joins with her personal slip code
    await renderStudentCoursesView({ code: 'SLIP-4421' }, router, container);

    const enrolled = await storage.table('student_courses').get(courseId);
    expect(enrolled).toBeDefined();

    // Verify identity was populated in Emma's profile
    const profile = StudentProfile.get();
    expect(profile.defaultIdentity.student_id).toBe('STU-EMMA');
    expect(profile.defaultIdentity.full_name).toBe('Emma Watson');
    const classEntry = Object.values(profile.classes).find(c => c.course_id === courseId);
    expect(classEntry?.access_code).toBe('SLIP4421');
  });

  it('reflects submitted work on teacher roster and auto-enrolls student when synced to gradebook', async () => {
    const courseId = 'course-math-303';
    const course = {
      id: courseId,
      name: 'Calculus BC',
      color: '#f59e0b'
    };
    await storage.table('gradebook_courses').add(course);

    const task = {
      id: 'task-derivatives',
      title: 'Derivatives Problem Set',
      class_id: courseId,
      grading: { max_points: 100, scoring: 'points' }
    };
    await storage.table('tasks').add(task);

    // Initial roster is empty (self-joining classroom)
    const initialRoster = await storage.table('gradebook_students').where('course_id').equals(courseId).toArray();
    expect(initialRoster).toHaveLength(0);

    // Dynamic student Alex submits work
    const submission = {
      id: 'sub-alex-1',
      task_id: 'task-derivatives',
      student_id: 'ALEX_01',
      student_name: 'Alex Rivera',
      is_latest: true,
      review: {
        points: 94,
        reviewed_at: new Date().toISOString()
      }
    };
    await storage.table('task_submissions').add(submission);

    // Teacher syncs to gradebook
    const syncRes = await syncTaskSubmissionsToGradebook({
      task,
      submissions: [submission],
      course,
      roster: []
    });

    expect(syncRes.synced).toBe(1);

    // Verify Alex Rivera was automatically enrolled in gradebook_students for this class
    const updatedRoster = await storage.table('gradebook_students').where('course_id').equals(courseId).toArray();
    expect(updatedRoster).toHaveLength(1);
    expect(updatedRoster[0].student_id).toBe('ALEX_01');
    expect(updatedRoster[0].full_name).toBe('Alex Rivera');

    // Verify the grade was written to gradebook_grades
    const grades = await storage.table('gradebook_grades').toArray();
    expect(grades.length).toBeGreaterThanOrEqual(1);
    expect(grades[0].student_id).toBe('ALEX_01');
    expect(grades[0].raw_score).toBe(94);
  });
});
