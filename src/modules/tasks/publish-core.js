/**
 * Core builder for student task payloads (offline-testable, no UI or network)
 */

export function estimateEnvelopeSize(plainObj) {
  const jsonStr = typeof plainObj === 'string' ? plainObj : JSON.stringify(plainObj || {});
  const bytes = new TextEncoder().encode(jsonStr).length;
  return Math.ceil(bytes * 1.37);
}

/**
 * Builds the student-safe task payload for publishing.
 * Whitelists allowed fields; never spreads private teacher data.
 */
export async function buildStudentTaskPayload(task, {
  teacherKeys,
  rosterChecks = null,
  rosterCards = null,
  courseMeta = null,
  relay = null,
  rubric = null,
  standards = []
}) {
  const settings = task.settings || {};
  const salt = task.publish?.salt;
  if (!salt) throw new Error('MISSING_PUBLISH_SALT');

  // Deep clone submission types and enforce CDN rules
  const subTypes = JSON.parse(JSON.stringify(task.submission_types || {}));
  const cdnActive = Boolean(task.publish?.cdn_student_upload || (relay && relay.media?.enabled));
  if (subTypes.files && !cdnActive) {
    subTypes.files.enabled = false;
  }

  const payload = {
    kind: 'kb-task',
    v: 1,
    task_id: task.id,
    publish_version: task.publish?.version || 1,
    course_id: task.gradebook?.course_id || task.class_id || null,
    title: task.title || 'Assignment',
    description: task.description || '',
    submission_types: subTypes,
    due_date: settings.due_date || null,
    due_time: settings.due_time || null,
    settings: {
      require_access_code: !!settings.require_access_code,
      allow_resubmit: settings.allow_resubmit !== false,
      release_feedback_immediately: !!settings.release_feedback_immediately
    },
    scoring: task.grading?.scoring || 'points',
    max_points: task.grading?.max_points ?? 100,
    rubric_preview: rubric ? {
      id: rubric.id,
      title: rubric.title,
      criteria: (rubric.criteria || []).map(c => ({
        id: c.id,
        title: c.title,
        description: c.description || '',
        levels: c.levels || []
      }))
    } : null,
    standards_preview: (standards || []).map(s => ({
      id: s.id,
      code: s.code || s.name || '',
      description: s.description || ''
    })),
    teacher_key: {
      publicJwk: teacherKeys.publicJwk,
      fingerprint: teacherKeys.fingerprint
    },
    roster_checks: rosterChecks && Object.keys(rosterChecks).length ? rosterChecks : null,
    salt
  };

  if (rosterCards && typeof rosterCards === 'object' && Object.keys(rosterCards).length) {
    payload.roster_cards = rosterCards;
  }
  if (courseMeta && typeof courseMeta === 'object') {
    payload.course_meta = courseMeta;
  }
  if (relay) {
    payload.relay = {
      base_url: relay.base_url,
      drop_id: relay.drop_id,
      drop_secret: relay.drop_secret,
      media: relay.media || null
    };
  }

  return payload;
}
