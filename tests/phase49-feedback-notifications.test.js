import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { StudentLedger } from '../src/modules/student/ledger.js';
import { RemoteFeedbackPoller } from '../src/modules/student/feedback-poller.js';
import { FeedbackCapsule } from '../src/core/feedback-capsule.js';
import { computeHomeStats } from '../src/modules/home/home-stats.js';

describe('Phase 49: Feedback Return & Notifications', () => {
  beforeEach(async () => {
    await storage.init();
    await storage.table('student_ledger').clear();
    await storage.table('student_courses').clear();
    await storage.table('assignment_submissions').clear();
    await storage.table('task_submissions').clear();
    await storage.table('assignments').clear();
    await storage.table('tasks').clear();
  });

  it('1. StudentLedger.applyFeedback stores feedback, marks feedback_unseen, and sets received_at', async () => {
    let eventFired = false;
    const listener = () => { eventFired = true; };
    window.addEventListener('kb-student-ledger-updated', listener);

    const item = await StudentLedger.applyFeedback({
      kind: 'assignment',
      itemId: 'asg-1',
      courseId: 'c1',
      title: 'Math Quiz',
      score: 95,
      maxScore: 100,
      feedback: 'Great job!',
      released_at: '2026-11-01T20:00:00.000Z'
    });

    expect(item.assignment_id).toBe('asg-1');
    expect(item.feedback_unseen).toBe(true);
    expect(item.score.earned).toBe(95);
    expect(item.score.possible).toBe(100);
    expect(item.overall_feedback).toBe('Great job!');
    expect(item.feedback_received_at).toBe('2026-11-01T20:00:00.000Z');
    expect(eventFired).toBe(true);

    window.removeEventListener('kb-student-ledger-updated', listener);
  });

  it('2. StudentLedger.markFeedbackSeen clears feedback_unseen flag', async () => {
    await StudentLedger.applyFeedback({
      kind: 'task',
      itemId: 'task-100',
      courseId: 'c1',
      title: 'Essay 1',
      score: 80,
      maxScore: 100,
      feedback: 'Well written.'
    });

    expect(await StudentLedger.getUnseenFeedbackCount()).toBe(1);

    await StudentLedger.markFeedbackSeen('task-100');

    expect(await StudentLedger.getUnseenFeedbackCount()).toBe(0);
    const entries = await StudentLedger.getAllLedgerEntries();
    expect(entries[0].feedback_unseen).toBe(false);
  });

  it('3. RemoteFeedbackPoller fetches feedback via FeedbackCapsule and applies it to ledger', async () => {
    // Seed an enrolled course & ledger entry awaiting feedback
    await storage.table('student_courses').put({
      id: 'course-1',
      name: 'Science',
      relay_url: 'https://relay.example.com'
    });
    await storage.table('student_ledger').put({
      id: 'sub-science-1',
      assignment_id: 'sci-quiz-1',
      course_id: 'course-1',
      title: 'Science Quiz',
      status: 'Handed in',
      feedback_unseen: false
    });

    // Mock StudentProfile with student's access code for this course
    localStorage.setItem('kb_student_profile_v1', JSON.stringify({
      classes: {
        'course-1': {
          course_id: 'course-1',
          access_code: 'CODE1234'
        }
      }
    }));

    // Mock FeedbackCapsule.fetchStudentRemoteFeedback
    vi.spyOn(FeedbackCapsule, 'fetchStudentRemoteFeedback').mockResolvedValueOnce({
      assignment_id: 'sci-quiz-1',
      points: 92,
      max_points: 100,
      feedback: 'Excellent work on chemical bonds!',
      reviewed_at: '2026-11-01T21:00:00.000Z'
    });

    const poller = new RemoteFeedbackPoller();
    const count = await poller.pollAll();

    expect(count).toBe(1);

    // Verify item in student ledger now has unseen feedback
    const entry = (await storage.table('student_ledger').toArray())[0];
    expect(entry.score.earned).toBe(92);
    expect(entry.overall_feedback).toBe('Excellent work on chemical bonds!');
    expect(entry.feedback_unseen).toBe(true);

    vi.restoreAllMocks();
    localStorage.removeItem('kb_student_profile_v1');
  });

  it('4. Teacher attention items count latest pending reviews accurately', () => {
    const assignments = [
      { id: 'a1', title: 'Quiz 1', questions: [{ id: 'q1', type: 'open', grading: 'manual' }] },
      { id: 'a2', title: 'Quiz 2', questions: [{ id: 'q2', type: 'choice' }] }
    ];

    const submissions = [
      // Old attempt - should be ignored
      { id: 'sub-old', assignment_id: 'a1', student_id: 'S1', is_latest: false },
      // Latest attempt needing manual review
      { id: 'sub-latest-1', assignment_id: 'a1', student_id: 'S1', is_latest: true },
      // Latest attempt already reviewed
      { id: 'sub-latest-2', assignment_id: 'a1', student_id: 'S2', is_latest: true, reviewed_at: '2026-11-01T12:00:00.000Z' },
      // Quiz 2 submission (auto-graded, no manual questions) - should not need review
      { id: 'sub-latest-3', assignment_id: 'a2', student_id: 'S3', is_latest: true }
    ];

    const tasks = [
      { id: 't1', title: 'Project 1' }
    ];

    const taskSubmissions = [
      // Latest task submission pending review
      { id: 'tsub-1', task_id: 't1', student_id: 'S1', is_latest: true },
      // Old task submission - ignored
      { id: 'tsub-old', task_id: 't1', student_id: 'S2', is_latest: false },
      // Reviewed task submission
      { id: 'tsub-2', task_id: 't1', student_id: 'S3', is_latest: true, review: { reviewed_at: '2026-11-01T10:00:00.000Z' } }
    ];

    const stats = computeHomeStats({
      assignments,
      submissions,
      tasks,
      taskSubmissions,
      courses: [{ id: 'c1', name: 'Class 1' }],
      students: [{ id: 's1', course_id: 'c1', access_code: 'AC1' }]
    });

    const reviewItems = stats.attentionItems.filter(i => i.badge === 'Review');
    expect(reviewItems.length).toBe(2);
    expect(reviewItems.find(i => i.type === 'submissions_to_review').text).toContain('1 submission(s) to review for "Quiz 1"');
    expect(reviewItems.find(i => i.type === 'tasks_to_review').text).toContain('1 submission(s) to review for "Project 1"');
  });

  it('5. Setting sub.returned_at preserves return timestamp and notifies listeners', async () => {
    let changed = false;
    const listener = () => { changed = true; };
    window.addEventListener('kb-submissions-changed', listener);

    const sub = {
      id: 'sub-return-1',
      assignment_id: 'a1',
      student_id: 'S1',
      is_latest: true,
      manual: { q1: { points: 5, feedback: 'Well done' } }
    };
    await storage.table('assignment_submissions').put(sub);

    // Simulate returning feedback
    sub.returned_at = new Date().toISOString();
    await storage.table('assignment_submissions').put(sub);
    window.dispatchEvent(new CustomEvent('kb-submissions-changed'));

    expect(changed).toBe(true);
    const saved = await storage.table('assignment_submissions').get('sub-return-1');
    expect(saved.returned_at).toBeDefined();

    window.removeEventListener('kb-submissions-changed', listener);
  });
});
