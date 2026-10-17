import { storage } from '../../core/storage.js';
import { CryptoShareEngine } from '../../core/crypto-share.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { buildStudentPayload, totalPoints } from './grading.js';
import { validateQuestion } from './question-types.js';

/**
 * Publish & Share (KB-ASSIGN-003)
 * Builds the key-free student payload, signs nothing secret into it, and produces a link/file.
 */

const randomSalt = () => Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * Roster state for the linked class: who has an access code, and the check values to publish.
 */
export async function getRosterStatus(assignment) {
  const courseId = assignment.gradebook?.course_id || assignment.class_id;
  if (!courseId) return { courseId: null, course: null, students: [], withCode: [], withoutCode: [] };
  const [course, students] = await Promise.all([
    storage.table('gradebook_courses').get(courseId),
    storage.table('gradebook_students').where('course_id').equals(courseId).toArray().catch(() => [])
  ]);
  return {
    courseId,
    course,
    students,
    withCode: students.filter(s => s.access_code),
    withoutCode: students.filter(s => !s.access_code)
  };
}

/**
 * Bump the publish version and build the student payload.
 * @returns {Promise<{ assignment: object, payload: object, keys: object }>}
 */
export async function publishAssignment(assignment, roster) {
  const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
  const next = {
    ...assignment,
    publish: {
      version: (assignment.publish?.version || 0) + 1,
      salt: randomSalt(),
      published_at: new Date().toISOString(),
      fingerprint: keys.fingerprint
    },
    updated_at: new Date().toISOString()
  };

  let rosterChecks = null;
  if (next.settings?.require_access_code && roster?.withCode?.length) {
    rosterChecks = {};
    for (const s of roster.withCode) {
      rosterChecks[String(s.student_id).toUpperCase()] = await SubmissionCrypto.accessCodeCheck(next.id, s.student_id, s.access_code);
    }
  }

  const payload = await buildStudentPayload(next, { teacherKeys: keys, rosterChecks });
  await storage.table('assignments').put(next);
  return { assignment: next, payload, keys };
}

/**
 * Open the publish dialog. Calls onPublished(updatedAssignment) after a successful publish.
 */
export async function openPublishDialog(assignment, { onPublished } = {}) {
  const existing = document.getElementById('kb-assignment-publish-dialog');
  if (existing) existing.remove();

  const roster = await getRosterStatus(assignment);
  const issues = (assignment.questions || []).map((q, i) => ({ i, issues: validateQuestion(q) })).filter(x => x.issues.length);
  const settings = assignment.settings || {};
  const feedbackText = { immediate: 'Instant feedback per question', after_submit: 'Score shown after submitting', none: 'No feedback until you return grades' }[settings.feedback_mode || 'after_submit'];
  const qCount = assignment.questions?.length || 0;

  const dialog = document.createElement('sl-dialog');
  dialog.id = 'kb-assignment-publish-dialog';
  dialog.label = 'Publish & share';
  dialog.style.setProperty('--width', '620px');
  dialog.innerHTML = `
    <div class="space-y-5">
      <div class="flex items-start gap-3">
        <span class="w-10 h-10 flex-shrink-0 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center text-xl"><sl-icon name="send"></sl-icon></span>
        <div class="min-w-0">
          <h3 class="font-semibold text-slate-900 truncate">${Sanitizer.escapeHTML(assignment.title || 'Assignment')}</h3>
          <p class="text-sm text-slate-500">${qCount} question${qCount === 1 ? '' : 's'} · ${totalPoints(assignment)} pts · ${feedbackText}</p>
        </div>
      </div>

      ${qCount === 0 ? `
        <sl-alert variant="danger" open><sl-icon slot="icon" name="exclamation-octagon"></sl-icon>Add at least one question before publishing.</sl-alert>
      ` : ''}

      ${issues.length ? `
        <sl-alert variant="warning" open>
          <sl-icon slot="icon" name="exclamation-triangle"></sl-icon>
          <strong>${issues.length} question${issues.length === 1 ? ' needs' : 's need'} attention.</strong>
          <ul class="mt-1 text-sm list-disc pl-5">
            ${issues.slice(0, 5).map(x => `<li>Question ${x.i + 1}: ${Sanitizer.escapeHTML(x.issues.join(' '))}</li>`).join('')}
          </ul>
        </sl-alert>
      ` : ''}

      <div class="rounded-xl border border-slate-200 divide-y divide-slate-200 text-sm">
        <div class="flex items-start gap-3 p-3">
          <sl-icon name="shield-lock" class="text-emerald-600 text-lg mt-0.5 flex-shrink-0"></sl-icon>
          <div>
            <div class="font-medium text-slate-800">Answer key stays on this device</div>
            <div class="text-slate-500">${settings.feedback_mode === 'none'
              ? 'The link contains questions only.'
              : 'The link contains questions plus one-way hashes used for instant feedback. Every submission is re-graded here from the real key.'}
              ${settings.show_correct_answers ? ' <strong class="text-amber-700">Correct answers are included so students can review them after submitting</strong> — turn this off for high-stakes tests.' : ''}</div>
          </div>
        </div>
        <div class="flex items-start gap-3 p-3">
          <sl-icon name="people" class="text-blue-600 text-lg mt-0.5 flex-shrink-0"></sl-icon>
          <div>
            ${roster.course ? `
              <div class="font-medium text-slate-800">Linked to ${Sanitizer.escapeHTML(roster.course.name)}</div>
              <div class="text-slate-500">${roster.withCode.length} of ${roster.students.length} students have an access code${settings.require_access_code ? ' (checked when they start)' : ''}.</div>
              ${roster.withoutCode.length && settings.require_access_code ? `
                <div class="mt-1 text-amber-700">Missing codes: ${roster.withoutCode.slice(0, 6).map(s => Sanitizer.escapeHTML(s.full_name)).join(', ')}${roster.withoutCode.length > 6 ? '…' : ''}. Generate them in <strong>Gradebook → class settings → Student access</strong>, then publish again. Their submissions will show as “Unverified”.</div>
              ` : ''}
            ` : `
              <div class="font-medium text-slate-800">No class linked</div>
              <div class="text-slate-500">Students can still submit, but identities can't be verified and grades can't sync. Link a class in the assignment settings.</div>
            `}
          </div>
        </div>
      </div>

      <sl-input id="input-publish-passphrase" type="password" password-toggle label="Optional link password" help-text="Leave empty for a link anyone in your class can open." size="medium">
        <sl-icon slot="prefix" name="key"></sl-icon>
      </sl-input>

      <div id="publish-result" class="hidden space-y-3 pt-4 border-t border-slate-200">
        <div class="flex items-center justify-between gap-2 text-sm">
          <span class="font-semibold text-slate-800">Student link</span>
          <span id="publish-meter" class="text-[11px] px-2 py-0.5 rounded-full"></span>
        </div>
        <sl-input id="input-publish-url" readonly></sl-input>
        <div class="flex flex-wrap gap-2 justify-end">
          <sl-button size="small" id="btn-publish-download"><sl-icon slot="prefix" name="file-earmark-arrow-down"></sl-icon> Download .kbshare</sl-button>
          <sl-button size="small" variant="primary" id="btn-publish-copy"><sl-icon slot="prefix" name="clipboard"></sl-icon> Copy link</sl-button>
        </div>
        <p class="text-xs text-slate-500" id="publish-fingerprint"></p>
      </div>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button id="btn-publish-close">Close</sl-button>
      <sl-button variant="primary" id="btn-publish-go" ${qCount === 0 ? 'disabled' : ''}>
        <sl-icon slot="prefix" name="send"></sl-icon> ${assignment.publish ? 'Publish new version' : 'Publish'}
      </sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
  dialog.show();

  let share = null;
  const close = () => dialog.hide();
  dialog.querySelector('#btn-publish-close').addEventListener('click', close);

  dialog.querySelector('#btn-publish-go').addEventListener('click', async () => {
    const btn = dialog.querySelector('#btn-publish-go');
    btn.setAttribute('loading', '');
    try {
      const { assignment: updated, payload, keys } = await publishAssignment(assignment, roster);
      Object.assign(assignment, updated);
      share = await CryptoShareEngine.createSharePayload('assignment', payload, dialog.querySelector('#input-publish-passphrase').value || '');
      dialog.querySelector('#input-publish-url').value = share.url;
      const meter = dialog.querySelector('#publish-meter');
      if (share.length <= 2048) {
        meter.className = 'text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200';
        meter.textContent = `${share.length.toLocaleString()} chars · fits in any LMS`;
      } else {
        meter.className = 'text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200';
        meter.textContent = `${share.length.toLocaleString()} chars · share the .kbshare file if the link gets cut off`;
      }
      dialog.querySelector('#publish-fingerprint').innerHTML = `Version ${updated.publish.version}. Submissions are encrypted to your key <strong class="font-mono">${keys.fingerprint}</strong> — students see the same code on their receipt.`;
      dialog.querySelector('#publish-result').classList.remove('hidden');
      btn.innerHTML = '<sl-icon slot="prefix" name="arrow-repeat"></sl-icon> Publish again';
      toast.success(`Published version ${updated.publish.version}.`);
      if (typeof onPublished === 'function') onPublished(updated);
    } catch (err) {
      console.error('Publish failed:', err);
      toast.danger(`Could not publish: ${err.message}`);
    } finally {
      btn.removeAttribute('loading');
    }
  });

  dialog.querySelector('#btn-publish-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(share.url);
      toast.success('Link copied.');
    } catch (_) {
      toast.warning('Copy failed — select the link and copy it manually.');
    }
  });

  dialog.querySelector('#btn-publish-download').addEventListener('click', () => {
    if (!share) return;
    const name = (assignment.title || 'assignment').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
    CryptoShareEngine.downloadKbShareFile(share.rawFileContent, `${name}.kbshare`);
  });
}
