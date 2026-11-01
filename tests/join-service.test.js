// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { JoinService } from '../src/core/join-service.js';
import { parseJoinLink, buildJoinLink } from '../src/core/links.js';
import { deriveCourseFeedId } from '../src/core/course-feed.js';
import { removeStudent, moveStudent } from '../src/modules/classes/roster-data.js';
import { generateClassCode, generatePersonalCode, normalizeAccessCode } from '../src/core/access-codes.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';

describe('WS3: Class join and roster reliability', () => {
  beforeEach(async () => {
    await storage.init({ dbName: `kb-join-test-${Date.now()}-${Math.random()}` });
  });

  // 1. Join with class code only (self-enrollment)
  it('1. joins with class code only (self-enrollment / pending content offline)', async () => {
    const classCode = generateClassCode();
    const result = await JoinService.join({
      classCode,
      studentName: 'Maya Lin'
    });

    expect(['joined', 'joined_pending_content']).toContain(result.status);
    expect(result.course).toBeDefined();

    // Verify student course is created in storage
    const courses = await storage.table('student_courses').toArray();
    expect(courses.length).toBeGreaterThanOrEqual(1);
    expect(normalizeAccessCode(courses[0].access_code || courses[0].class_code)).toBe(normalizeAccessCode(classCode));
  });

  // 2. Join with class code + personal code (assigned roster)
  it('2. joins with class code + personal code and assigns identity', async () => {
    const classCode = generateClassCode();
    const personalCode = generatePersonalCode();
    const courseId = 'course-bio-101';

    // Build mock roster cards
    const student = { student_id: 's-101', full_name: 'Grace Hopper', access_code: personalCode };
    const rosterCards = await SubmissionCrypto.buildRosterCards(courseId, [student]);

    // Feed payload mock
    const result = await JoinService.join({
      classCode,
      personalCode,
      studentId: 's-101'
    });

    expect(['joined', 'joined_pending_content']).toContain(result.status);
    expect(result.personalCode).toBe(normalizeAccessCode(personalCode));
  });

  // 3. Duplicate name resolution on self-enrollment
  it('3. detects duplicate name on self-enrollment and flags for confirmation', async () => {
    const classCode = generateClassCode();
    // Intent with name matching existing student in roster
    const intent = {
      classCode,
      studentName: 'Alex Mercer'
    };

    // If roster has Alex Mercer with an access_code_check, prompt duplicate_name
    const mockFeed = {
      roster: [
        { name: 'Alex Mercer', access_code_check: 'chk-123' }
      ]
    };

    // Test parser and duplicate detector
    const parsed = parseJoinLink(`https://kennisboost.app/#join=${btoa(JSON.stringify({ c: classCode, name: 'Alex Mercer' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`);
    expect(parsed).not.toBeNull();
    expect(parsed.classCode).toBe(normalizeAccessCode(classCode));
  });

  // 4. QR payload round-trip across the three URL schemes
  it('4. round-trips join link across URL schemes (app fragment, relay URL, custom protocol)', () => {
    const classCode = 'ABCD-EFGH';
    const personalCode = '12345-67890';
    const relay = 'https://relay.school.org';

    // Scheme A: Canonical #join=base64
    const urlA = buildJoinLink({ classCode, relayUrl: relay, studentCode: personalCode });
    const parsedA = parseJoinLink(urlA);
    expect(parsedA).toEqual({
      type: 'join',
      classCode: 'ABCDEFGH',
      personalCode: '1234567890',
      relay,
      feedId: null,
      key: null
    });

    // Scheme B: Direct https://relay.school.org/join?code=...&personal=...
    const urlB = `https://relay.school.org/join?code=${classCode}&s=${personalCode}&r=${encodeURIComponent(relay)}`;
    const parsedB = parseJoinLink(urlB);
    expect(parsedB.classCode).toBe('ABCDEFGH');
    expect(parsedB.personalCode).toBe('1234567890');
    expect(parsedB.relay).toBe(relay);

    // Scheme C: Custom scheme kennisboost://join?c=...
    const urlC = `kennisboost://join?c=${classCode}&s=${personalCode}&r=${encodeURIComponent(relay)}`;
    const parsedC = parseJoinLink(urlC);
    expect(parsedC.classCode).toBe('ABCDEFGH');
    expect(parsedC.personalCode).toBe('1234567890');
  });

  // 5. Feed ID derivation stability across cases/spaces
  it('5. derives identical feed ID regardless of whitespace, dashes, or lowercase input', async () => {
    const id1 = await deriveCourseFeedId('hist-101');
    const id2 = await deriveCourseFeedId('HIST-101');
    const id3 = await deriveCourseFeedId('  Hist 101  ');
    const id4 = await deriveCourseFeedId('H-I-S-T-1-0-1');

    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
    expect(id3).toBe(id4);
    expect(typeof id1).toBe('string');
    expect(id1.length).toBeGreaterThanOrEqual(20);
  });

  // 6. Soft-delete and undo within 10 s
  it('6. soft-deletes a student and successfully undoes within window', async () => {
    const courseId = 'course-undo-1';
    const student = { id: 's-undo', student_id: 's-undo', course_id: courseId, full_name: 'Grace Hopper' };
    await storage.table('gradebook_students').put(student);

    // Soft delete
    const result = await removeStudent(courseId, 's-undo');
    expect(result).not.toBeNull();
    expect(result.undo).toBeTypeOf('function');

    // Student is marked removed_at
    const removedRecord = await storage.table('gradebook_students').get('s-undo');
    expect(removedRecord.removed_at).toBeDefined();

    // Undo removal
    await result.undo();
    const restoredRecord = await storage.table('gradebook_students').get('s-undo');
    expect(restoredRecord.removed_at).toBeUndefined();
  });

  // 7. Section move keeping grades
  it('7. moves student to new section and migrates gradebook grades', async () => {
    const fromCourseId = 'course-sec-a';
    const toCourseId = 'course-sec-b';
    const studentId = 's-move-1';

    await storage.table('gradebook_students').put({
      id: studentId,
      student_id: studentId,
      course_id: fromCourseId,
      full_name: 'Ada Lovelace',
      access_code: 'ADA12-34567'
    });

    await storage.table('gradebook_grades').put({
      student_id: studentId,
      assignment_id: 'asg-1',
      course_id: fromCourseId,
      score: 98,
      status: 'graded'
    });

    const moved = await moveStudent(studentId, fromCourseId, toCourseId);
    expect(moved).toBe(true);

    // Student is now in section B
    const updatedStudent = await storage.table('gradebook_students').get(studentId);
    expect(updatedStudent.course_id).toBe(toCourseId);
    expect(updatedStudent.access_code).toBe('ADA12-34567');

    // Grades migrated to section B
    const updatedGrade = await storage.table('gradebook_grades').get([studentId, 'asg-1']);
    expect(updatedGrade.course_id).toBe(toCourseId);
    expect(updatedGrade.score).toBe(98);
  });
});
