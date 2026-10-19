/**
 * Assignment Feedback Link Builder (KB-ASSIGN-008)
 * Constructs and encrypts student-facing assignment feedback payloads (Appendix C).
 */

import { answerToText, describeCorrectAnswer, finalScore, totalPoints } from './grading.js';
import { LinkBuilder } from '../../core/links.js';

/**
 * Build pure feedback payload according to Appendix C specification.
 * Correct answers and explanations are stripped unless show_correct_answers is true.
 *
 * @param {object} params
 * @param {object} params.assignment
 * @param {object} params.submission
 * @param {object} [params.student]
 * @param {object} [params.course]
 * @returns {object} Appendix C JSON structure
 */
export function buildFeedbackPayload({ assignment, submission, student, course }) {
  const allowAnswers = !!assignment?.settings?.show_correct_answers;
  const questions = (assignment?.questions || []).map((q, idx) => {
    const auto = submission.auto?.per_question?.[q.id];
    const manual = submission.manual?.[q.id];
    let earned = auto?.earned ?? 0;
    if (manual && manual.points !== null && manual.points !== undefined && manual.points !== '') {
      earned = Number(manual.points) || 0;
    }
    const possible = auto?.possible ?? (q.points || 0);
    const correct = earned >= possible && possible > 0;
    const studentAnswer = answerToText(q, submission.answers?.[q.id]);
    const feedback = manual?.feedback || '';

    return {
      n: idx + 1,
      type: q.type,
      prompt: q.prompt || '',
      student_answer: studentAnswer,
      earned,
      possible,
      correct,
      feedback,
      correct_answer: allowAnswers ? (describeCorrectAnswer(q) || null) : null,
      explanation: allowAnswers ? (q.explanation || null) : null
    };
  });

  const s = finalScore(assignment, submission);

  return {
    version: 1,
    kind: 'assignment_feedback',
    generated_at: new Date().toISOString(),
    student: {
      student_id: student?.student_id || submission.student_id || '',
      full_name: student?.full_name || submission.student_name || ''
    },
    course: {
      id: course?.id || course?.course_id || assignment?.gradebook?.course_id || assignment?.class_id || '',
      name: course?.name || course?.course_name || '',
      section: course?.section || '',
      teacher_fingerprint: course?.teacher_fingerprint || ''
    },
    assignment: {
      id: assignment?.id || '',
      title: assignment?.title || '',
      due_date: assignment?.settings?.due_date || null,
      total_points: totalPoints(assignment),
      publish_version: assignment?.publish?.version ?? submission.publish_version ?? 1
    },
    submission: {
      id: submission?.id || '',
      submitted_at: submission.submitted_at || null,
      days_late: submission.days_late ?? 0,
      identity: submission.identity || 'unsigned',
      publish_version: submission.publish_version ?? 1
    },
    score: {
      earned: s.earned,
      possible: s.possible,
      pending: s.pending
    },
    overall_feedback: submission.feedback || '',
    questions
  };
}

/**
 * Generate an encrypted feedback link for a given student and submission.
 *
 * @param {object} params
 * @param {object} params.assignment
 * @param {object} params.submission
 * @param {object} params.student
 * @param {object} [params.course]
 * @returns {Promise<{ url: string, payload: object, exceedsUrlLimit: boolean }>}
 */
export async function createFeedbackLink({ assignment, submission, student, course }) {
  const payload = buildFeedbackPayload({ assignment, submission, student, course });
  const share = await LinkBuilder.feedback(payload, student);
  return {
    ...share,
    payload
  };
}
