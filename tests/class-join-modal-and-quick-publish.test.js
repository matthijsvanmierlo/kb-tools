import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { ConfirmDialog, PromptDialog } from '../src/utils/dialogs.js';
import { buildCourseFeed, decryptCourseFeed, deriveCourseFeedId } from '../src/core/course-feed.js';
import { GradebookBridge, reconcileCourseItemsForClass, syncContentClassLink } from '../src/modules/gradebook/bridge.js';
import { joinCourseByCode, mergeCourseFeed, upsertStudentCourse } from '../src/modules/student/course-store.js';
import { AccessCodes } from '../src/core/access-codes.js';
import { loadDemoWorkspace, removeDemoData } from '../src/core/demo.js';
import '../src/boot/shoelace-setup.js';

describe('Modal Dropdown Safeguard (Prevent child popup events from closing dialogs)', () => {
  it('does not resolve or close ConfirmDialog when a child sl-select or sl-dropdown fires sl-after-hide', async () => {
    let resolved = false;
    const dialogPromise = ConfirmDialog.show({
      title: 'Test Modal',
      message: 'Choose an option',
      confirmText: 'Confirm'
    }).then(res => {
      resolved = true;
      return res;
    });

    const dialog = document.querySelector('sl-dialog');
    expect(dialog).toBeTruthy();

    // Create a mock child select inside the dialog
    const childSelect = document.createElement('sl-select');
    dialog.appendChild(childSelect);

    // Simulate child dropdown closing after an option is picked
    const childHideEvt = new CustomEvent('sl-after-hide', { bubbles: true, composed: true });
    childSelect.dispatchEvent(childHideEvt);

    const childRequestCloseEvt = new CustomEvent('sl-request-close', { bubbles: true, composed: true });
    childSelect.dispatchEvent(childRequestCloseEvt);

    // The dialog should NOT have resolved or closed
    await new Promise(r => setTimeout(r, 50));
    expect(resolved).toBe(false);

    // Clicking confirm now resolves it as expected
    const confirmBtn = dialog.querySelector('#kb-dialog-confirm');
    confirmBtn.click();
    const result = await dialogPromise;
    expect(result).toBe(true);
  });

  it('does not dismiss PromptDialog when a child dropdown fires sl-hide or sl-after-hide', async () => {
    let resolved = false;
    const promptPromise = PromptDialog.show({
      title: 'Prompt',
      label: 'Input'
    }).then(val => {
      resolved = true;
      return val;
    });

    const dialog = document.querySelector('sl-dialog.kb-prompt-dialog');
    expect(dialog).toBeTruthy();

    const childDropdown = document.createElement('sl-dropdown');
    dialog.appendChild(childDropdown);

    childDropdown.dispatchEvent(new CustomEvent('sl-after-hide', { bubbles: true, composed: true }));
    childDropdown.dispatchEvent(new CustomEvent('sl-hide', { bubbles: true, composed: true }));

    await new Promise(r => setTimeout(r, 50));
    expect(resolved).toBe(false);

    const cancelBtn = dialog.querySelector('#kb-dialog-cancel');
    cancelBtn.click();
    const result = await promptPromise;
    expect(result).toBe(null);
  });
});

describe('Class Content Auto-Sync & Course Plan Quick-Publish', () => {
  beforeEach(async () => {
    await removeDemoData();
  });

  it('automatically reconciles class-assigned content into course_items with full student playable payload', async () => {
    const courseId = 'course-chem-101';
    await storage.table('gradebook_courses').put({
      id: courseId,
      name: 'Organic Chemistry',
      section: 'Period 3',
      access_code: 'ORGC-9900',
      color: '#059669'
    });

    // Create an assignment assigned to courseId
    const asgId = 'asg-sn2-mechanisms';
    const asg = {
      id: asgId,
      title: 'SN2 Reaction Mechanisms',
      class_id: courseId,
      questions: [
        { id: 'q1', type: 'single_choice', points: 5, prompt: 'Which solvent favours SN2?', options: [{ id: 'opt1', text: 'DMSO', is_correct: true }] }
      ],
      settings: { due_date: '2026-11-15' },
      published: true
    };
    await storage.table('assignments').put(asg);

    // Reconcile items
    const items = await reconcileCourseItemsForClass(courseId);
    expect(items.length).toBeGreaterThan(0);
    const matchedItem = items.find(i => i.source_id === asgId);
    expect(matchedItem).toBeTruthy();
    expect(matchedItem.title).toBe('SN2 Reaction Mechanisms');

    // Build course feed and verify the item and student snapshot payload are included
    const feed = await buildCourseFeed(courseId);
    expect(feed.stats.itemsCount).toBe(1);
    const feedItem = feed.raw_payload.items[0];
    expect(feedItem.title).toBe('SN2 Reaction Mechanisms');
    expect(feedItem.payload).toBeTruthy();
    expect(feedItem.payload.questions).toHaveLength(1);
    expect(feedItem.payload.course_meta.name).toBe('Organic Chemistry');
  });

  it('excludes hidden or unpublished items from student feed', async () => {
    const courseId = 'course-phys-201';
    await storage.table('gradebook_courses').put({
      id: courseId,
      name: 'AP Physics C',
      access_code: 'PHYS-2026'
    });

    const unit = { id: 'unit-1', course_id: courseId, title: 'Mechanics', order: 0 };
    await storage.table('course_units').put(unit);

    const itemPublished = {
      id: 'item-pub',
      course_id: courseId,
      unit_id: 'unit-1',
      title: 'Kinematics Lab',
      kind: 'assignment',
      source_id: 'src-1',
      published: true,
      hidden: false,
      order: 0
    };
    const itemHidden = {
      id: 'item-hid',
      course_id: courseId,
      unit_id: 'unit-1',
      title: 'Draft Exam',
      kind: 'assignment',
      source_id: 'src-2',
      published: false,
      hidden: true,
      order: 1
    };
    await storage.table('course_items').bulkPut([itemPublished, itemHidden]);

    const feed = await buildCourseFeed(courseId);
    expect(feed.stats.itemsCount).toBe(1);
    expect(feed.raw_payload.items[0].title).toBe('Kinematics Lab');
  });
});

describe('Reliable Class Join Links & AES-GCM Access Code Normalization', () => {
  beforeEach(async () => {
    await removeDemoData();
  });

  it('encrypts and decrypts feeds whether access code has hyphens or is normalized', async () => {
    const courseId = 'course-bio-101';
    const hyphenatedCode = 'BIOL-7788';
    const normalizedCode = 'BIOL7788';

    await storage.table('gradebook_courses').put({
      id: courseId,
      name: 'General Biology',
      access_code: hyphenatedCode
    });

    const unit = { id: 'u1', course_id: courseId, title: 'Cell Structure', order: 0 };
    await storage.table('course_units').put(unit);

    const feedResult = await buildCourseFeed(courseId);

    // Decrypting using normalized code (what student UI sends) must succeed
    const decryptedNorm = await decryptCourseFeed(feedResult.ciphertext, normalizedCode);
    expect(decryptedNorm.course.name).toBe('General Biology');

    // Decrypting using hyphenated code must also succeed
    const decryptedHyphen = await decryptCourseFeed(feedResult.ciphertext, hyphenatedCode);
    expect(decryptedHyphen.course.name).toBe('General Biology');
  });

  it('joins demo course via student personal access code and resolves class name and content', async () => {
    const { apChem } = await loadDemoWorkspace();
    expect(apChem.access_code).toBe('CHEM-2026');

    // Emma Watson's personal access code from demo.js is CHEM-4421
    const studentCode = 'CHEM-4421';
    const joinResult = await joinCourseByCode(studentCode);

    expect(joinResult.course.name).toBe('AP Chemistry');
    expect(joinResult.items.length).toBeGreaterThan(0);

    // Verify student course is saved in student_courses
    const studentCourses = await storage.table('student_courses').toArray();
    const enrolled = studentCourses.find(c => c.id === apChem.id);
    expect(enrolled).toBeTruthy();
    expect(enrolled.name).toBe('AP Chemistry');
  });

  it('uses URL parameters (cname, csec, ccolor) when joining an offline class without placeholder name', async () => {
    const freshCode = 'LATN-101';
    const joinResult = await joinCourseByCode(freshCode, {
      courseId: 'course_latn_101',
      courseName: 'Introductory Latin',
      section: 'Period 5',
      color: '#7c3aed'
    });

    expect(joinResult.name).toBe('Introductory Latin');
    expect(joinResult.section).toBe('Period 5');
    expect(joinResult.color).toBe('#7c3aed');
    expect(joinResult.name).not.toContain('Course (');
  });

  it('creates enriched onboarding pass URL containing course code, student code, and metadata', () => {
    const student = { student_id: 'S204', full_name: 'Lucas Gray', access_code: 'GRAY-9912' };
    const course = { id: 'c-lit', name: 'World Literature', section: 'Sec 1', access_code: 'LITR-2026' };
    const passUrl = AccessCodes.createOnboardingPassUrl(student, course, 'https://school.edu/');

    expect(passUrl).toContain('code=LITR-2026');
    expect(passUrl).toContain('scode=GRAY-9912');
    expect(passUrl).toContain('cname=World+Literature');
    expect(passUrl).toContain('sid=S204');
  });
});
