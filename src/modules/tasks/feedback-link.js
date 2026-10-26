import { LinkBuilder } from '../../core/links.js';
import { compressDrawDoc } from './media.js';

/**
 * Task Feedback Link Builder
 * Constructs and encrypts student-facing assignment feedback payloads.
 */

/**
 * Build pure feedback payload according to specifications.
 * Fully self-contained and offline-renderable with zero secret/teacher material.
 *
 * @param {object} params
 * @param {object} params.task
 * @param {object} params.submission
 * @param {object} [params.student]
 * @param {object} [params.course]
 * @param {object} [params.rubric]
 * @param {Array<object>} [params.standards]
 * @param {Array<object>} [params.sbgLevels]
 * @returns {object}
 */
export function buildTaskFeedbackPayload({ task, submission, student, course, rubric, standards = [], sbgLevels = [] }) {
  const sub = submission;
  const review = sub.review || {};
  const content = sub.content || {};

  // Standards mastery snapshot with labels & colors
  const standardEvidence = standards.map(std => {
    const scoreVal = review.standard_scores?.[std.id] ?? null;
    const levelObj = sbgLevels.find(l => Number(l.value) === Number(scoreVal)) || null;
    return {
      id: std.id,
      code: std.code,
      description: std.description,
      score: scoreVal,
      level_label: levelObj?.label || '',
      level_color: levelObj?.color || '#2563eb',
      comment: review.standard_comments?.[std.id] || ''
    };
  });

  // Echoed code files with anchored comments
  const rawCode = content.code_files || content.code || [];
  const codeFiles = (Array.isArray(rawCode) ? rawCode : []).map((f, idx) => {
    const fileId = f.id || f.filename || `f-${idx}`;
    const comments = review.code_comments?.[fileId] || [];
    return {
      id: fileId,
      filename: f.filename || `file-${idx + 1}`,
      language: f.language || 'python',
      body: f.body || '',
      comments
    };
  });

  // Echoed drawing layers (student original + teacher annotations)
  let drawing = null;
  if (content.drawing || review.drawing_annotations) {
    drawing = {
      student: content.drawing || null,
      teacher_annotations: review.drawing_annotations || null
    };
  }

  // Rubric snapshot
  let rubricSnapshot = null;
  if (rubric) {
    rubricSnapshot = {
      id: rubric.id,
      title: rubric.title,
      tiers: rubric.tiers || [],
      criteria: rubric.criteria || [],
      eval: review.rubric_eval || {},
      comments: review.rubric_comments || {}
    };
  }

  return {
    version: 1,
    kind: 'task_feedback',
    generated_at: new Date().toISOString(),
    student: {
      student_id: student?.student_id || sub.student_id || '',
      full_name: student?.full_name || sub.student_name || ''
    },
    course: {
      id: course?.id || task.gradebook?.course_id || task.class_id || '',
      name: course?.name || course?.title || '',
      section: course?.section || ''
    },
    task: {
      id: task.id,
      title: task.title,
      due_date: task.settings?.due_date || null,
      scoring: task.grading?.scoring || 'points',
      max_points: task.grading?.max_points ?? 100,
      publish_version: task.publish?.version ?? sub.publish_version ?? 1
    },
    submission: {
      id: sub.id,
      submitted_at: sub.submitted_at || null,
      days_late: sub.days_late || 0,
      identity: sub.identity || 'unsigned',
      publish_version: sub.publish_version ?? 1
    },
    grade: {
      points: review.points ?? null,
      max_points: task.grading?.max_points ?? 100,
      status: review.status || 'submitted',
      scoring: task.grading?.scoring || 'points',
      standards: standardEvidence
    },
    rubric: rubricSnapshot,
    overall_feedback: review.feedback || '',
    text: content.text_md || content.text || '',
    code_files: codeFiles,
    drawing,
    attachments: content.attachments || []
  };
}

/**
 * Generate an encrypted feedback link for a student task submission.
 * Reuses LinkBuilder.feedback with 'task_feedback' shareType.
 */
export async function createTaskFeedbackLink({ task, submission, student, course, rubric, standards, sbgLevels }) {
  const payload = buildTaskFeedbackPayload({ task, submission, student, course, rubric, standards, sbgLevels });
  const share = await LinkBuilder.feedback(payload, student, 'task_feedback');
  return {
    ...share,
    payload
  };
}

export const createFeedbackLink = createTaskFeedbackLink;
