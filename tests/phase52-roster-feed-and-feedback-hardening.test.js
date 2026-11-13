import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { storage } from '../src/core/storage.js';
import { syncPublishedItemsRosterForCourse, buildRosterChecksAndCards, computeRosterHash } from '../src/core/publish-core.js';
import { FeedbackCapsule } from '../src/core/feedback-capsule.js';
import { StudentLedger } from '../src/modules/student/ledger.js';
import { mergeCourseFeed } from '../src/modules/student/course-store.js';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('Phase 52: Roster Feed Sync & Feedback Hardening', () => {
  beforeEach(async () => {
    await storage.init();
    await storage.table('gradebook_students').clear();
    await storage.table('assignments').clear();
    await storage.table('tasks').clear();
    await storage.table('video_assessments').clear();
    await storage.table('student_courses').clear();
    await storage.table('student_ledger').clear();
    await storage.table('student_items').clear();
  });

  it('1. syncPublishedItemsRosterForCourse updates roster_checks, roster_cards, and roster_hash on published items', async () => {
    const courseId = 'course-sync-1';
    const initialRoster = [
      { id: 'st-1', course_id: courseId, student_id: 'S100', full_name: 'Alice Alpha', access_code: 'AAAA-1111' }
    ];
    const oldHash = await computeRosterHash(initialRoster);
    const oldCards = await buildRosterChecksAndCards('asg-1', { withCode: initialRoster }, true);

    await storage.table('assignments').put({
      id: 'asg-1',
      course_id: courseId,
      title: 'Quiz 1',
      publish: {
        salt: 'salt123',
        roster_hash: oldHash,
        payload: {
          assignment_id: 'asg-1',
          roster_checks: oldCards.rosterChecks,
          roster_cards: oldCards.rosterCards
        }
      }
    });

    // Add a second student to the roster
    await storage.table('gradebook_students').bulkPut([
      ...initialRoster,
      { id: 'st-2', course_id: courseId, student_id: 'S200', full_name: 'Bob Beta', access_code: 'BBBB-2222' }
    ]);

    const res = await syncPublishedItemsRosterForCourse(courseId);
    expect(res.updatedCount).toBe(1);

    const updatedAsg = await storage.table('assignments').get('asg-1');
    expect(updatedAsg.publish.roster_hash).toBe(res.rosterHash);
    expect(updatedAsg.publish.roster_hash).not.toBe(oldHash);
    expect(Object.keys(updatedAsg.publish.payload.roster_cards).length).toBe(2);
  });

  it('2. mergeCourseFeed persists roster_cards onto student_courses', async () => {
    const rosterCards = { hash1: { ct: 'abc', iv: 'def' } };
    await mergeCourseFeed({
      course: { id: 'c-1', name: 'Biology', access_code: 'BIO-1234' },
      units: [],
      items: [],
      roster_cards: rosterCards,
      revision: 'rev-1'
    }, { accessCode: 'BIO-1234', relayUrl: 'https://relay.example.org' });

    const saved = await storage.table('student_courses').get('c-1');
    expect(saved.roster_cards).toEqual(rosterCards);
    expect(saved.relay_url).toBe('https://relay.example.org');
  });

  it('3. FeedbackCapsule.saveFeedbackToStudentStorage merges into StudentLedger without duplicate fb- rows', async () => {
    await StudentLedger.recordSubmission({
      assignmentId: 'asg-99',
      courseId: 'c-1',
      title: 'Lab 99',
      studentId: 'S100',
      studentName: 'Alice Alpha'
    });

    await FeedbackCapsule.saveFeedbackToStudentStorage({
      assignment_id: 'asg-99',
      student_id: 'S100',
      title: 'Lab 99',
      points: 46,
      max_points: 50,
      feedback: 'Great lab report!'
    });

    const rows = await storage.table('student_ledger').toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].assignment_id).toBe('asg-99');
    expect(rows[0].score.earned).toBe(46);
    expect(rows[0].overall_feedback).toBe('Great lab report!');
    expect(rows[0].feedback_unseen).toBe(true);
  });

  it('4. FeedbackCapsule uses /api/v1/feedback/:dropId and tasks/assignments use getTransportConfig()', async () => {
    const tasksSubSrc = fs.readFileSync(path.join(ROOT, 'src/modules/tasks/submissions.js'), 'utf8');
    const asgSubSrc = fs.readFileSync(path.join(ROOT, 'src/modules/assignments/submissions.js'), 'utf8');
    expect(tasksSubSrc).toContain('getTransportConfig()');
    expect(asgSubSrc).toContain('getTransportConfig()');
    expect(asgSubSrc).toContain("id: 'relay_feedback_push'");

    const stored = new Map();
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      if (opts.method === 'PUT') {
        expect(url).toContain('/api/v1/feedback/');
        stored.set(url, JSON.parse(opts.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      expect(url).toContain('/api/v1/feedback/');
      const data = stored.get(url);
      if (!data) return { ok: false, status: 404 };
      return { ok: true, json: async () => data };
    });

    try {
      const pushRes = await FeedbackCapsule.publishBatchToRelay({
        relayUrl: 'https://relay.example.org',
        teacherToken: 'secret-token',
        assignmentId: 'asg-v1',
        items: [{
          studentAccessCode: 'K7M2-QX9P',
          feedback: { assignment_id: 'asg-v1', student_id: 'S1', score: 95, max_points: 100, feedback: 'Nice!' }
        }]
      });
      expect(pushRes.published).toBe(1);

      const fetched = await FeedbackCapsule.fetchStudentRemoteFeedback('https://relay.example.org', 'asg-v1', 'K7M2-QX9P');
      expect(fetched).toBeTruthy();
      expect(fetched.score).toBe(95);
      expect(fetched.feedback).toBe('Nice!');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
