import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { GradebookBridge } from '../gradebook/bridge.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { RelayTransport } from '../../core/transport.js';
import { evaluateTaskSubmission, IDENTITY_LABELS } from './pipeline.js';
import { renderTaskReview } from './review.js';
import { FeedbackCapsule } from '../../core/feedback-capsule.js';

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

const IDENTITY_CLASSES = {
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rose: 'bg-rose-50 text-rose-700 border-rose-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200'
};

export function identityChip(identity) {
  const info = IDENTITY_LABELS[identity] || IDENTITY_LABELS.no_code_on_file;
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${IDENTITY_CLASSES[info.tone]}" title="${esc(info.help)}"><sl-icon name="${info.icon}"></sl-icon>${info.label}</span>`;
}

/**
 * Record a new or updated task submission into Dexie:
 * - Resubmission logic: sets is_latest = false on all prior submissions for [task_id + student_id]
 * - Detects if new submission postdates a returned submission (resubmitted after feedback)
 *
 * @param {object} submission
 * @returns {Promise<object>}
 */
export async function recordTaskSubmission(submission) {
  const existing = await storage.table('task_submissions')
    .where('task_id').equals(submission.task_id)
    .toArray();

  const studentSubs = existing.filter(s =>
    String(s.student_id).toUpperCase() === String(submission.student_id).toUpperCase()
  );

  // Check if student resubmitted after teacher returned feedback
  const priorReturned = studentSubs.find(s => s.returned_at);
  if (priorReturned) {
    submission.resubmitted_after_feedback = true;
  }

  // Mark all older submissions as is_latest = false
  for (const s of studentSubs) {
    if (s.id !== submission.id && s.is_latest !== false) {
      s.is_latest = false;
      s.updated_at = new Date().toISOString();
      await storage.table('task_submissions').put(s);
    }
  }

  submission.is_latest = true;
  submission.updated_at = new Date().toISOString();
  await storage.table('task_submissions').put(submission);
  return submission;
}

/**
 * Synchronize task submissions to the linked gradebook column.
 * Only submissions that have been reviewed (reviewed_at is set) are written.
 */
export async function syncTaskSubmissionsToGradebook({ task, submissions = [], course = null, roster = [] }) {
  const courseId = task.gradebook?.course_id || task.class_id;
  if (!courseId) return { synced: 0, reason: 'NO_CLASS_LINKED' };

  if (!course) {
    course = await storage.table('gradebook_courses').get(courseId);
  }
  if (!course) return { synced: 0, reason: 'COURSE_NOT_FOUND' };

  if (!roster.length) {
    roster = await storage.table('gradebook_students').where('course_id').equals(courseId).toArray();
  }

  const rosterById = new Map(roster.map(s => [String(s.student_id).toUpperCase(), s]));

  // Filter eligible submissions: latest, reviewed, student on roster
  const eligible = submissions.filter(s =>
    s.is_latest !== false &&
    s.review?.reviewed_at &&
    rosterById.has(String(s.student_id).toUpperCase())
  );

  if (!eligible.length) {
    return { synced: 0, reason: 'NO_REVIEWED_SUBMISSIONS' };
  }

  const column = await GradebookBridge.upsertLinkedColumn({
    courseId: course.id,
    source: { type: 'task', id: task.id },
    title: task.title,
    maxScore: task.grading?.max_points ?? 100,
    scoring: task.grading?.scoring || 'points',
    rubricId: task.grading?.rubric_id || undefined,
    standardIds: task.grading?.standard_ids || [],
    categoryId: task.gradebook?.category_id || undefined,
    dueDate: task.settings?.due_date || undefined
  });

  if (task.gradebook?.column_id !== column.id) {
    task.gradebook = { ...(task.gradebook || {}), course_id: course.id, column_id: column.id };
    await storage.table('tasks').put(task);
  }

  const now = new Date().toISOString();
  let count = 0;

  for (const sub of eligible) {
    const student = rosterById.get(String(sub.student_id).toUpperCase());
    const rawScore = sub.review?.points ?? null;

    let feedbackLinkUrl = undefined;
    try {
      const { createFeedbackLink } = await import('./feedback-link.js');
      const fbRes = await createFeedbackLink({ task, submission: sub, student, course });
      feedbackLinkUrl = fbRes?.url;
    } catch (_) {}

    await GradebookBridge.writeGrade({
      courseId: course.id,
      assignmentId: column.id,
      studentId: student.student_id,
      rawScore,
      status: sub.review?.status || (sub.days_late > 0 ? 'late' : 'submitted'),
      feedback: sub.review?.feedback || '',
      extra: {
        rubric_eval: sub.review?.rubric_eval || {},
        rubric_comments: sub.review?.rubric_comments || {},
        standard_scores: sub.review?.standard_scores || {},
        standard_comments: sub.review?.standard_comments || {},
        days_late: sub.days_late || undefined,
        source_submission_id: sub.id,
        feedback_link: feedbackLinkUrl
      }
    });

    sub.synced_at = now;
    sub.updated_at = now;
    await storage.table('task_submissions').put(sub);
    count++;
  }

  return { synced: count, columnId: column.id };
}

/**
 * Parse and evaluate one or more submission envelopes from a pasted string or array of strings.
 */
export async function importTaskSubmissions({ text, task, teacherPrivateKey, roster = [] }) {
  if (!text) return { imported: 0, failed: 0, errors: [] };

  const trimmed = String(text || '').trim();
  const codes = trimmed.match(/KBSUB1\.[A-Za-z0-9+/=_-]+/g);
  const lines = codes && codes.length ? codes : trimmed.split('\n').map(s => s.trim()).filter(Boolean);

  let imported = 0;
  let failed = 0;
  const errors = [];

  for (const chunk of lines) {
    try {
      const sub = await evaluateTaskSubmission({
        text: chunk,
        teacherPrivateKey,
        task,
        roster
      });
      await recordTaskSubmission(sub);
      imported++;
    } catch (err) {
      failed++;
      errors.push(err.message || String(err));
    }
  }

  return { imported, failed, errors };
}

/**
 * Main controller for the Submissions roster board view (`#/assignments/review?id=`).
 */
export async function renderTaskSubmissions(params = {}, router = null, container = null) {
  if (!container) container = document.getElementById('main-content');
  if (!container) return;

  const taskId = params.id;
  if (!taskId) {
    container.innerHTML = `
      <div class="max-w-md mx-auto p-8 text-center space-y-4">
        <h2 class="text-lg font-bold text-slate-800">No Assignment Specified</h2>
        <sl-button variant="primary" href="#/assignments">Back to Assignments</sl-button>
      </div>
    `;
    return;
  }

  const task = await storage.table('tasks').get(taskId);
  if (!task) {
    container.innerHTML = `
      <div class="max-w-md mx-auto p-8 text-center space-y-4">
        <h2 class="text-lg font-bold text-slate-800">Assignment Not Found</h2>
        <sl-button variant="primary" href="#/assignments">Back to Assignments</sl-button>
      </div>
    `;
    return;
  }

  const courseId = task.gradebook?.course_id || task.class_id;
  let course = null;
  let roster = [];
  if (courseId) {
    course = await storage.table('gradebook_courses').get(courseId);
    roster = await storage.table('gradebook_students').where('course_id').equals(courseId).toArray();
  }

  const allSubmissions = await storage.table('task_submissions').where('task_id').equals(taskId).toArray();

  // If subId parameter is present, launch directly into full-page review screen
  if (params.subId) {
    const targetSub = allSubmissions.find(s => s.id === params.subId);
    if (targetSub) {
      await renderTaskReview(task, targetSub, allSubmissions, router, container);
      return;
    }
  }

  // Group latest submissions by student ID
  const latestSubsByStudent = new Map();
  for (const sub of allSubmissions) {
    if (sub.is_latest !== false) {
      latestSubsByStudent.set(String(sub.student_id).toUpperCase(), sub);
    }
  }

  // Calculate statistics
  const totalEnrolled = roster.length;
  const submittedCount = latestSubsByStudent.size;
  const reviewedCount = Array.from(latestSubsByStudent.values()).filter(s => !!s.review?.reviewed_at).length;
  const missingCount = Math.max(0, totalEnrolled - submittedCount);

  container.innerHTML = `
    <div class="max-w-6xl mx-auto space-y-6 pb-20 pt-2">
      <!-- Header -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
        <div>
          <div class="flex items-center gap-2">
            <sl-button size="small" variant="default" href="#/assignments">
              <sl-icon slot="prefix" name="arrow-left"></sl-icon> Assignments
            </sl-button>
            ${course ? `<span class="px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-xs font-medium border border-indigo-200">${esc(course.name)}</span>` : ''}
          </div>
          <h1 class="text-xl font-bold text-slate-900 mt-2">${esc(task.title)}</h1>
          <p class="text-xs text-slate-500 mt-0.5">Submissions &amp; Grading Review Board</p>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <sl-button size="small" id="btn-import-subs">
            <sl-icon slot="prefix" name="box-arrow-in-down"></sl-icon> Import Submissions
          </sl-button>
          ${task.publish?.relay?.drop_id ? `
            <sl-button size="small" id="btn-pull-relay">
              <sl-icon slot="prefix" name="cloud-download"></sl-icon> Pull from Relay
            </sl-button>
          ` : ''}
          <sl-dropdown id="dropdown-feedback-capsule">
            <sl-button size="small" slot="trigger" caret ${reviewedCount === 0 ? 'disabled' : ''}>
              <sl-icon slot="prefix" name="capsule"></sl-icon> Distribute Feedback
            </sl-button>
            <sl-menu>
              <sl-menu-item id="action-export-classpack">
                <sl-icon slot="prefix" name="file-earmark-zip"></sl-icon> Export Capsule (.kbclasspack)
              </sl-menu-item>
              ${task.publish?.relay?.relay_url ? `
                <sl-menu-item id="action-push-relay-feedback">
                  <sl-icon slot="prefix" name="cloud-upload"></sl-icon> Push to Blind Relay
                </sl-menu-item>
              ` : ''}
            </sl-menu>
          </sl-dropdown>
          <sl-button size="small" variant="primary" id="btn-sync-gradebook" ${!courseId ? 'disabled' : ''}>
            <sl-icon slot="prefix" name="arrow-repeat"></sl-icon> Sync to Gradebook
          </sl-button>
        </div>
      </div>

      <!-- Stats Bar -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <p class="text-xs text-slate-500 font-medium">Enrolled</p>
          <p class="text-2xl font-bold text-slate-900 mt-1">${totalEnrolled}</p>
        </div>
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <p class="text-xs text-slate-500 font-medium">Handed In</p>
          <p class="text-2xl font-bold text-indigo-600 mt-1">${submittedCount} <span class="text-xs text-slate-400 font-normal">(${totalEnrolled ? Math.round((submittedCount / totalEnrolled) * 100) : 0}%)</span></p>
        </div>
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <p class="text-xs text-slate-500 font-medium">Reviewed &amp; Graded</p>
          <p class="text-2xl font-bold text-emerald-600 mt-1">${reviewedCount} <span class="text-xs text-slate-400 font-normal">(${submittedCount ? Math.round((reviewedCount / submittedCount) * 100) : 0}%)</span></p>
        </div>
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <p class="text-xs text-slate-500 font-medium">Missing</p>
          <p class="text-2xl font-bold text-rose-600 mt-1">${missingCount}</p>
        </div>
      </div>

      <!-- Roster Submissions Table -->
      <div class="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 class="text-sm font-bold text-slate-900">Student Roster</h2>
          <span class="text-xs text-slate-400">Click a student to review work &amp; score</span>
        </div>

        <div class="divide-y divide-slate-100">
          ${roster.length === 0 && allSubmissions.length === 0 ? `
            <div class="p-8 text-center text-slate-500 text-sm">
              No students enrolled in this class or no submissions yet.
            </div>
          ` : ''}

          ${roster.map(student => {
            const sid = String(student.student_id).toUpperCase();
            const sub = latestSubsByStudent.get(sid);

            return `
              <div class="p-4 hover:bg-slate-50 transition-colors flex items-center justify-between gap-4 cursor-pointer student-row" data-sid="${esc(sid)}" data-sub-id="${sub ? esc(sub.id) : ''}">
                <div class="flex items-center gap-3 min-w-0">
                  <div class="w-9 h-9 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center text-xs font-bold uppercase flex-shrink-0">
                    ${esc((student.full_name || student.name || 'S').slice(0, 2))}
                  </div>
                  <div class="min-w-0">
                    <p class="text-sm font-semibold text-slate-900 truncate">${esc(student.full_name || student.name)}</p>
                    <p class="text-xs text-slate-400">${esc(student.student_id)}</p>
                  </div>
                </div>

                <div class="flex items-center gap-3 flex-shrink-0">
                  ${sub ? `
                    ${sub.resubmitted_after_feedback ? `
                      <span class="px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200 text-xs font-medium">
                        Resubmitted
                      </span>
                    ` : ''}

                    ${sub.days_late > 0 ? `
                      <span class="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs font-medium">
                        ${sub.days_late}d late
                      </span>
                    ` : ''}

                    ${identityChip(sub.identity)}

                    ${sub.review?.reviewed_at ? `
                      <span class="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold">
                        ${sub.review.points !== null ? `${sub.review.points} pts` : 'Graded'}
                      </span>
                    ` : `
                      <span class="px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-medium">
                        Ready to Grade
                      </span>
                    `}
                  ` : `
                    <span class="text-xs text-slate-400 italic">Not submitted</span>
                  `}
                  <sl-icon name="chevron-right" class="text-slate-300"></sl-icon>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;

  // Row clicks -> open review
  container.querySelectorAll('.student-row').forEach(row => {
    row.addEventListener('click', () => {
      const subId = row.dataset.subId;
      if (subId) {
        const sub = allSubmissions.find(s => s.id === subId);
        if (sub) {
          renderTaskReview(task, sub, allSubmissions, router, container);
        }
      } else {
        toast.info('Student has not submitted work yet.');
      }
    });
  });

  // Gradebook sync button
  const syncBtn = container.querySelector('#btn-sync-gradebook');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      syncBtn.loading = true;
      try {
        const res = await syncTaskSubmissionsToGradebook({ task, submissions: allSubmissions, course, roster });
        if (res.synced > 0) {
          toast.success(`Synced ${res.synced} grade(s) to Gradebook!`);
        } else if (res.reason === 'NO_REVIEWED_SUBMISSIONS') {
          toast.info('No reviewed grades to sync yet. Grade student submissions first.');
        } else {
          toast.info('Sync completed.');
        }
      } catch (err) {
        console.error(err);
        toast.error('Gradebook sync failed: ' + (err.message || String(err)));
      } finally {
        syncBtn.loading = false;
      }
    });
  }

  // Export Class Capsule (.kbclasspack)
  container.querySelector('#action-export-classpack')?.addEventListener('click', async () => {
    const reviewedSubs = Array.from(latestSubsByStudent.values()).filter(s => !!s.review?.reviewed_at);
    if (!reviewedSubs.length) {
      toast.warning('No reviewed submissions to export.');
      return;
    }

    const items = [];
    const rosterById = new Map(roster.map(s => [String(s.student_id).toUpperCase(), s]));

    for (const s of reviewedSubs) {
      const student = rosterById.get(String(s.student_id).toUpperCase());
      const accessCode = student?.access_code || s.access_code;
      if (accessCode) {
        items.push({
          studentId: s.student_id,
          studentAccessCode: accessCode,
          feedback: {
            task_id: task.id,
            assignment_id: task.id,
            student_id: s.student_id,
            points: s.review.points,
            status: s.review.status,
            rubric_eval: s.review.rubric_eval,
            standard_scores: s.review.standard_scores,
            feedback: s.review.feedback,
            audio_note: s.review.audio_note,
            drawing_annotations: s.review.drawing_annotations,
            reviewed_at: s.review.reviewed_at
          }
        });
      }
    }

    if (!items.length) {
      toast.danger('None of the reviewed students have an access code on the roster to encrypt feedback.');
      return;
    }

    const pack = await FeedbackCapsule.createClassCapsulePack({
      assignmentId: task.id,
      classId: courseId || '',
      title: task.title,
      items
    });

    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kennisboost-${task.id}-feedback.kbclasspack`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported feedback capsule for ${items.length} student(s) (.kbclasspack)!`);
  });

  // Push Feedback to Blind Relay
  container.querySelector('#action-push-relay-feedback')?.addEventListener('click', async () => {
    const relayUrl = task.publish?.relay?.relay_url || task.publish?.relay?.base_url;
    if (!relayUrl) {
      toast.warning('No relay URL configured for this assignment.');
      return;
    }

    const teacherToken = (await storage.getMetadata('relay_teacher_token')) || '';
    if (!teacherToken) {
      toast.warning('No relay teacher token found in settings.');
      return;
    }

    const reviewedSubs = Array.from(latestSubsByStudent.values()).filter(s => !!s.review?.reviewed_at);
    const rosterById = new Map(roster.map(s => [String(s.student_id).toUpperCase(), s]));
    const items = [];

    for (const s of reviewedSubs) {
      const student = rosterById.get(String(s.student_id).toUpperCase());
      const accessCode = student?.access_code || s.access_code;
      if (accessCode) {
        items.push({
          studentAccessCode: accessCode,
          feedback: {
            task_id: task.id,
            assignment_id: task.id,
            student_id: s.student_id,
            points: s.review.points,
            status: s.review.status,
            rubric_eval: s.review.rubric_eval,
            standard_scores: s.review.standard_scores,
            feedback: s.review.feedback,
            audio_note: s.review.audio_note,
            reviewed_at: s.review.reviewed_at
          }
        });
      }
    }

    if (!items.length) {
      toast.warning('No reviewed students with access codes found.');
      return;
    }

    toast.info(`Publishing ${items.length} feedback drops to relay...`);
    const res = await FeedbackCapsule.publishBatchToRelay({
      relayUrl,
      teacherToken,
      assignmentId: task.id,
      items
    });

    toast.success(`Published ${res.published} feedback drop(s) to relay! (${res.failed} failed)`);
  });

  // Import Submissions Modal
  const importBtn = container.querySelector('#btn-import-subs');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      openImportDialog(task, roster, async () => {
        await renderTaskSubmissions(params, router, container);
      });
    });
  }

  // Pull from Relay Drop
  const pullRelayBtn = container.querySelector('#btn-pull-relay');
  if (pullRelayBtn) {
    pullRelayBtn.addEventListener('click', async () => {
      pullRelayBtn.loading = true;
      try {
        const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
        const transport = new RelayTransport({ baseUrl: task.publish.relay.base_url });
        const res = await transport.pullDrop(task.publish.relay.drop_id, task.publish.relay.drop_secret);
        if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);

        const items = res.items || [];
        let imported = 0;
        for (const item of items) {
          try {
            const sub = await evaluateTaskSubmission({
              text: item.payload || item,
              teacherPrivateKey: keys.privateJwk,
              task,
              roster
            });
            await recordTaskSubmission(sub);
            imported++;
          } catch (_) {}
        }

        toast.success(`Pulled ${imported} new submission(s) from relay!`);
        await renderTaskSubmissions(params, router, container);
      } catch (err) {
        toast.error('Relay pull failed: ' + (err.message || String(err)));
      } finally {
        pullRelayBtn.loading = false;
      }
    });
  }
}

/**
 * Dialog to import submissions by paste text or file upload.
 */
function openImportDialog(task, roster, onComplete) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Import Submissions';
  dialog.style.setProperty('--width', '540px');

  dialog.innerHTML = `
    <div class="space-y-4">
      <p class="text-xs text-slate-500">
        Paste student KBSUB1 codes or select downloaded <strong>.kbsub</strong> files.
      </p>

      <sl-textarea id="import-paste-text" rows="5" placeholder="Paste KBSUB1-... envelope text here"></sl-textarea>

      <div class="flex items-center gap-2">
        <input type="file" id="import-file-input" class="hidden" multiple accept=".kbsub,.txt">
        <sl-button size="small" id="import-file-btn">
          <sl-icon slot="prefix" name="folder2-open"></sl-icon> Choose .kbsub Files
        </sl-button>
        <span class="text-xs text-slate-400" id="import-file-count"></span>
      </div>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="import-cancel-btn">Cancel</sl-button>
      <sl-button variant="primary" id="import-confirm-btn">Import</sl-button>
    </div>
  `;

  document.body.appendChild(dialog);
  dialog.show();

  const fileInput = dialog.querySelector('#import-file-input');
  const fileBtn = dialog.querySelector('#import-file-btn');
  const countSpan = dialog.querySelector('#import-file-count');
  const pasteArea = dialog.querySelector('#import-paste-text');
  const confirmBtn = dialog.querySelector('#import-confirm-btn');
  const cancelBtn = dialog.querySelector('#import-cancel-btn');

  fileBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const num = fileInput.files?.length || 0;
    countSpan.textContent = num ? `${num} file(s) selected` : '';
  };

  cancelBtn.onclick = () => dialog.hide();
  dialog.addEventListener('sl-after-hide', () => dialog.remove());

  confirmBtn.onclick = async () => {
    confirmBtn.loading = true;
    try {
      const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
      let texts = [];

      if (pasteArea.value.trim()) {
        texts.push(pasteArea.value.trim());
      }

      if (fileInput.files?.length) {
        for (const file of fileInput.files) {
          const t = await file.text();
          if (t.trim()) texts.push(t.trim());
        }
      }

      const combined = texts.join('\n');
      const res = await importTaskSubmissions({
        text: combined,
        task,
        teacherPrivateKey: keys.privateJwk,
        roster
      });

      if (res.imported > 0) {
        toast.success(`Successfully imported ${res.imported} submission(s)!`);
        dialog.hide();
        if (typeof onComplete === 'function') onComplete();
      } else {
        toast.error('No valid submissions could be imported.');
      }
    } catch (err) {
      toast.error('Import error: ' + (err.message || String(err)));
    } finally {
      confirmBtn.loading = false;
    }
  };
}
