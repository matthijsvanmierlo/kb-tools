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

import { HandinInstructions } from '../../components/handin-instructions.js';
import { LinkBuilder } from '../../core/links.js';
import { toCSV, downloadCSV } from '../../core/csv.js';
import { splitName, joinName } from '../../core/names.js';
import { getTransport } from '../../core/transport.js';
import { replication } from '../../core/replication/manager.js';

/**
 * Bump the publish version and build the student payload.
 * @param {object} assignment
 * @param {object} roster
 * @param {object} [opts]
 * @param {string} [opts.handinEmail]
 * @param {object} [opts.transport]
 * @returns {Promise<{ assignment: object, payload: object, keys: object }>}
 */
export async function publishAssignment(assignment, roster, { handinEmail = '', transport = null } = {}) {
  const activeTransport = transport || await getTransport();
  // A class shared with co-teachers gets work encrypted to the class key they all hold
  const keys = await replication.publishKeysFor(assignment.class_id);
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
  let rosterCards = null;
  if (roster?.withCode?.length) {
    if (next.settings?.require_access_code) {
      rosterChecks = {};
      for (const s of roster.withCode) {
        rosterChecks[String(s.student_id).toUpperCase()] = await SubmissionCrypto.accessCodeCheck(next.id, s.student_id, s.access_code);
      }
    }
    rosterCards = {};
    for (const s of roster.withCode) {
      const card = await SubmissionCrypto.buildRosterCard(next.id, s, s.access_code);
      if (card?.tag) {
        rosterCards[card.tag] = card.ct;
      }
    }
  }

  const courseMeta = roster?.course ? {
    course_id: roster.course.id,
    course_name: roster.course.name || '',
    section: roster.course.section || ''
  } : null;

  const payload = await buildStudentPayload(next, { teacherKeys: keys, rosterChecks, rosterCards, courseMeta });
  if (handinEmail) {
    payload.handin = { email: handinEmail };
  }

  if (activeTransport?.capabilities?.collectSubmissions) {
    try {
      const drop = await activeTransport.createDrop({
        assignmentId: next.id,
        publishVersion: next.publish.version,
        expiresAt: new Date(Date.now() + 180 * 86400000).toISOString()
      });
      payload.relay = { base_url: activeTransport.baseUrl, drop_id: drop.dropId, drop_secret: drop.dropSecret };
      next.publish.relay = payload.relay;
    } catch (e) {
      console.warn('Could not create drop on relay:', e);
    }
  }

  await storage.table('assignments').put(next);
  return { assignment: next, payload, keys };
}

/**
 * Open the publish dialog. Calls onPublished(updatedAssignment) after a successful publish.
 */
export async function openPublishDialog(assignment, { onPublished } = {}) {
  const existing = document.getElementById('kb-assignment-publish-dialog');
  if (existing) existing.remove();

  const transport = await getTransport();
  const hasShortLinks = Boolean(transport?.capabilities?.hostPayload);
  const roster = await getRosterStatus(assignment);
  const teacherProfile = (await storage.getMetadata('teacher_profile')) || {};
  const issues = (assignment.questions || []).map((q, i) => ({ i, issues: validateQuestion(q) })).filter(x => x.issues.length);
  const settings = assignment.settings || {};
  const feedbackText = { immediate: 'Instant feedback per question', after_submit: 'Score shown after submitting', none: 'No feedback until you return grades' }[settings.feedback_mode || 'after_submit'];
  const qCount = assignment.questions?.length || 0;

  const dialog = document.createElement('sl-dialog');
  dialog.id = 'kb-assignment-publish-dialog';
  dialog.label = 'Publish & share';
  dialog.style.setProperty('--width', '640px');
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

      ${hasShortLinks ? `
        <div class="rounded-xl border border-blue-200 p-3 space-y-1 bg-blue-50/60 text-sm">
          <sl-checkbox id="chk-publish-short-link" checked>Short link (hosted on school server)</sl-checkbox>
          <p class="text-[11px] text-slate-500">Creates a compact link (~60 chars). Payload is encrypted client-side; server cannot read it.</p>
        </div>
      ` : ''}

      <div class="rounded-xl border border-slate-200 p-3 space-y-2 text-sm bg-slate-50">
        <sl-checkbox id="chk-include-email" ${teacherProfile.email ? 'checked' : ''}>Include my email as a hand-in method</sl-checkbox>
        <sl-input id="input-teacher-email" type="email" placeholder="teacher@school.edu" size="small" value="${Sanitizer.escapeHTML(teacherProfile.email || '')}" ${teacherProfile.email ? '' : 'disabled'}></sl-input>
        <p class="text-[11px] text-slate-500">Students get an "Email to teacher" button on the submission screen with instructions to attach their file.</p>
      </div>

      <sl-input id="input-publish-passphrase" type="password" password-toggle label="Optional link password" help-text="Leave empty for a link anyone in your class can open." size="medium">
        <sl-icon slot="prefix" name="key"></sl-icon>
      </sl-input>

      <div id="publish-result" class="hidden space-y-4 pt-4 border-t border-slate-200">
        <div class="flex items-center justify-between gap-2 text-sm">
          <span class="font-semibold text-slate-800">Student link</span>
          <span id="publish-meter" class="text-[11px] px-2 py-0.5 rounded-full"></span>
        </div>
        <sl-input id="input-publish-url" readonly></sl-input>
        <div class="flex flex-wrap gap-2 justify-end">
          <sl-button size="small" id="btn-publish-download"><sl-icon slot="prefix" name="file-earmark-arrow-down"></sl-icon> Download .kbshare</sl-button>
          <sl-button size="small" id="btn-publish-per-student-csv" ${!roster.students.length ? 'disabled' : ''}><sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Per-student links (CSV)</sl-button>
          <sl-button size="small" variant="primary" id="btn-publish-copy"><sl-icon slot="prefix" name="clipboard"></sl-icon> Copy link</sl-button>
        </div>
        <p class="text-xs text-slate-500" id="publish-fingerprint"></p>
        <div id="publish-instructions-mount" class="pt-2"></div>
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
  let activeUrl = '';
  const close = () => dialog.hide();
  dialog.querySelector('#btn-publish-close').addEventListener('click', close);

  const emailChk = dialog.querySelector('#chk-include-email');
  const emailInput = dialog.querySelector('#input-teacher-email');
  emailChk?.addEventListener('sl-change', () => {
    if (emailInput) emailInput.disabled = !emailChk.checked;
  });

  dialog.querySelector('#btn-publish-go').addEventListener('click', async () => {
    const btn = dialog.querySelector('#btn-publish-go');
    btn.setAttribute('loading', '');
    try {
      const includeEmail = emailChk?.checked;
      const teacherEmail = emailInput?.value.trim() || '';
      if (teacherEmail) {
        await storage.setMetadata('teacher_profile', { ...teacherProfile, email: teacherEmail });
      }

      const { assignment: updated, payload, keys } = await publishAssignment(assignment, roster, {
        handinEmail: includeEmail ? teacherEmail : '',
        transport
      });
      Object.assign(assignment, updated);
      share = await CryptoShareEngine.createSharePayload('assignment', payload, dialog.querySelector('#input-publish-passphrase').value || '');

      activeUrl = share.url;
      const chkShortLink = dialog.querySelector('#chk-publish-short-link');
      if (chkShortLink?.checked && transport?.capabilities?.hostPayload) {
        try {
          const wrapped = await CryptoShareEngine.wrapForHosting(share.rawFileContent);
          const pub = await transport.publishPayload({
            kind: 'assignment',
            ciphertext: wrapped.ciphertext,
            expiresAt: new Date(Date.now() + 180 * 86400000).toISOString(),
            meta: { title: assignment.title }
          });
          activeUrl = LinkBuilder.hosted(pub.ref, wrapped.key);
        } catch (e) {
          console.warn('Failed to publish short link to relay:', e);
        }
      }

      dialog.querySelector('#input-publish-url').value = activeUrl;
      const meter = dialog.querySelector('#publish-meter');
      if (activeUrl !== share.url) {
        meter.className = 'text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200';
        meter.textContent = `${activeUrl.length} chars · short link via school server`;
      } else if (share.length <= 2048) {
        meter.className = 'text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200';
        meter.textContent = `${share.length.toLocaleString()} chars · fits in any LMS`;
      } else {
        meter.className = 'text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200';
        meter.textContent = `${share.length.toLocaleString()} chars · share the .kbshare file if the link gets cut off`;
      }
      dialog.querySelector('#publish-fingerprint').innerHTML = `Version ${Sanitizer.escapeHTML(updated.publish.version)}. Submissions are encrypted to your key <strong class="font-mono">${Sanitizer.escapeHTML(keys.fingerprint)}</strong> — students see the same code on their receipt.`;

      const mount = dialog.querySelector('#publish-instructions-mount');
      if (mount) {
        mount.innerHTML = '';
        mount.appendChild(HandinInstructions.render({
          assignment: updated,
          link: activeUrl,
          dueDate: updated.settings?.due_date,
          teacherEmail: includeEmail ? teacherEmail : ''
        }));
      }

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
      await navigator.clipboard.writeText(activeUrl || share?.url || '');
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

  dialog.querySelector('#btn-publish-per-student-csv')?.addEventListener('click', () => {
    if ((!activeUrl && !share) || !roster.students?.length) return;
    const targetUrl = activeUrl || share.url;
    const rows = roster.students.map(s => {
      const nameParts = splitName(s.full_name || `${s.given_name || ''} ${s.family_name || ''}`.trim());
      const firstName = s.given_name || nameParts.given || '';
      const lastName = s.family_name || nameParts.family || '';
      const fullName = s.full_name || joinName({ given: firstName, family: lastName });
      const link = LinkBuilder.withParams(targetUrl, { sid: s.student_id, sname: fullName });
      return {
        Email: s.email || '',
        FirstName: firstName,
        LastName: lastName,
        FullName: fullName,
        StudentID: s.student_id,
        Link: link
      };
    });
    const cols = ['Email', 'FirstName', 'LastName', 'FullName', 'StudentID', 'Link'];
    const text = toCSV(rows, cols);
    downloadCSV(`${(assignment.title || 'assignment').replace(/[^a-z0-9_-]+/gi, '_')}_student_links.csv`, text);
    toast.success(`Exported ${rows.length} per-student links.`);
  });
}
