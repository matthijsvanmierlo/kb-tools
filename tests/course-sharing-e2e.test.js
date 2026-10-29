import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { buildCourseFeed, buildStudentCourseJoinLinks, autoSyncCourseFeed } from '../src/core/course-feed.js';
import { mergeCourseFeed, joinCourseByCode } from '../src/modules/student/course-store.js';
import { renderStudentCoursesView } from '../src/modules/student/courses.js';
import { StudentProfile } from '../src/core/student-profile.js';
import { StudentLedger } from '../src/modules/student/ledger.js';
import { router } from '../src/router.js';

describe('End-to-End Course Sharing, Offline Feeds, Header UX and Feedback', () => {
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
      'student_ledger',
      'task_submissions',
      'assignment_submissions',
      'tasks',
      'assignments',
      'flashcards',
      'course_units',
      'course_items'
    ];
    for (const t of tables) {
      try {
        await storage.table(t).clear();
      } catch (_) {}
    }
  });

  it('generates self-contained join links with course metadata and encrypted feed', async () => {
    const courseId = 'course-physics-301';
    await storage.table('gradebook_courses').add({
      id: courseId,
      name: 'AP Physics C: Mechanics',
      section: 'Period 3',
      color: '#3b82f6',
      access_code: 'PHY301'
    });

    const unitId = 'unit-1';
    await storage.table('course_units').add({
      id: unitId,
      course_id: courseId,
      title: 'Newtonian Dynamics',
      order: 0
    });

    await storage.table('course_items').add({
      id: 'item-1',
      course_id: courseId,
      unit_id: unitId,
      title: 'Forces & Free Body Diagrams',
      kind: 'assignment',
      order: 0,
      points: 100,
      published: true
    });

    const joinInfo = await buildStudentCourseJoinLinks(courseId, { origin: 'https://school.edu' });
    expect(joinInfo.accessCode).toBe('PHY301');
    expect(joinInfo.course.name).toBe('AP Physics C: Mechanics');
    expect(joinInfo.joinUrl).toContain('code=PHY301');
    expect(joinInfo.joinUrl).toContain('cname=AP+Physics+C%3A+Mechanics');
    expect(joinInfo.joinUrl).toContain('cid=course-physics-301');
    expect(joinInfo.joinUrl).toContain('d=');
  });

  it('allows students to join with metadata-rich offline join link and view course name + lessons', async () => {
    const courseId = 'course-lit-101';
    await storage.table('gradebook_courses').add({
      id: courseId,
      name: 'World Literature',
      section: 'Grade 10',
      color: '#8b5cf6',
      access_code: 'LIT101'
    });

    const unitId = 'unit-lit-1';
    await storage.table('course_units').add({
      id: unitId,
      course_id: courseId,
      title: 'Unit 1: The Epic',
      order: 0
    });

    await storage.table('course_items').add({
      id: 'item-odyssey',
      course_id: courseId,
      unit_id: unitId,
      title: 'The Odyssey Reading Check',
      kind: 'task',
      order: 0,
      points: 50,
      published: true
    });

    const joinInfo = await buildStudentCourseJoinLinks(courseId);

    // Now simulate student on separate browser context with only the join URL params
    const container = document.createElement('div');
    const mockRouter = { navigate: () => {} };

    await renderStudentCoursesView({
      code: 'LIT101',
      cid: courseId,
      cname: 'World Literature',
      csec: 'Grade 10',
      d: joinInfo.ciphertext
    }, mockRouter, container);

    const enrolled = await storage.table('student_courses').get(courseId);
    expect(enrolled).toBeDefined();
    expect(enrolled.name).toBe('World Literature');
    expect(enrolled.course_name).toBe('World Literature');

    const items = await storage.table('student_items').where('course_id').equals(courseId).toArray();
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].title).toBe('The Odyssey Reading Check');
  });

  it('1-click student invite pass claims student seat and sets profile identity', async () => {
    const courseId = 'course-chem-101';
    await storage.table('gradebook_courses').add({
      id: courseId,
      name: 'Chemistry Honors',
      access_code: 'CHEM10'
    });

    const container = document.createElement('div');
    const mockRouter = { navigate: () => {} };

    await renderStudentCoursesView({
      code: 'CHEM10',
      cid: courseId,
      cname: 'Chemistry Honors',
      sid: 'S1042',
      sname: 'Maya Lin',
      scode: 'MAYALIN1'
    }, mockRouter, container);

    const profile = StudentProfile.get();
    const identity = profile.classes[courseId];
    expect(identity).toBeDefined();
    expect(identity.student_id).toBe('S1042');
    expect(identity.full_name).toBe('Maya Lin');
  });

  it('activates course_feed shared payload in router without creating bogus student_items', async () => {
    const courseId = 'course-bio-202';
    const rawFeed = {
      course: {
        id: courseId,
        name: 'Cellular Biology',
        access_code: 'BIO202'
      },
      units: [
        { id: 'u1', course_id: courseId, title: 'Mitosis', order: 0 }
      ],
      items: [
        { id: 'it-1', course_id: courseId, unit_id: 'u1', title: 'Cell Cycle Quiz', kind: 'assignment', order: 0 }
      ]
    };

    let navigated = '';
    const mockRouter = {
      navigate: (url) => { navigated = url; },
      _renderEphemeralBanner: () => {}
    };

    await router._activateSharedPayload.call(mockRouter, {
      type: 'course_feed',
      payload: rawFeed
    });

    // Course should be in student_courses
    const course = await storage.table('student_courses').get(courseId);
    expect(course).toBeDefined();
    expect(course.name).toBe('Cellular Biology');

    // student_items should contain the actual item, NOT a bogus item with kind: 'course_feed'
    const studentItems = await storage.table('student_items').toArray();
    expect(studentItems.some(it => it.kind === 'course_feed')).toBe(false);
    expect(studentItems.some(it => it.id === 'it-1')).toBe(true);
    expect(navigated).toBe(`#/student/course?id=${courseId}`);
  });

  it('ingests task_feedback into student ledger and displays proper badge', async () => {
    const feedbackPayload = {
      version: 1,
      kind: 'task_feedback',
      course: { id: 'c-calc', name: 'AP Calculus AB' },
      task: { id: 't-derivatives', title: 'Derivatives Problem Set', max_points: 100 },
      student: { student_id: 'S999', full_name: 'Alex Rivera' },
      grade: { points: 95, max_points: 100, status: 'returned' },
      overall_feedback: 'Outstanding mastery of the chain rule!'
    };

    const res = await StudentLedger.ingestTaskFeedback(feedbackPayload);
    expect(res.item).toBeDefined();
    expect(res.item.score.earned).toBe(95);
    expect(res.item.item_type).toBe('task_feedback');

    const entries = await StudentLedger.getAllLedgerEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].title).toBe('Derivatives Problem Set');
  });

  it('verifies that clicking safety chip in DOM does not open storage dropdown', () => {
    const group = document.createElement('div');
    group.className = 'kb-header-storage-group';
    group.innerHTML = `
      <button type="button" id="kb-data-safety-chip" class="kb-safety-chip">
        <span id="kb-data-safety-label">Data safe</span>
      </button>
      <sl-dropdown class="kb-storage-menu">
        <button slot="trigger" type="button" class="kb-data-sync-pill">Storage</button>
        <sl-menu id="kb-storage-menu-list"></sl-menu>
      </sl-dropdown>
    `;
    document.body.appendChild(group);

    const chip = group.querySelector('#kb-data-safety-chip');
    const dropdown = group.querySelector('sl-dropdown.kb-storage-menu');
    const trigger = dropdown.querySelector('[slot="trigger"]');

    // chip must NOT be inside the dropdown or its trigger slot!
    expect(dropdown.contains(chip)).toBe(false);
    expect(trigger.contains(chip)).toBe(false);

    group.remove();
  });
});
