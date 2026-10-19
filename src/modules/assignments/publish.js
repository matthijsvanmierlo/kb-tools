import { storage } from '../../core/storage.js';
import { CryptoShareEngine } from '../../core/crypto-share.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { buildStudentPayload, totalPoints } from './grading.js';
import { validateQuestion } from './question-types.js';
import { generateUUID } from '../../utils/uuid.js';
import { syncContentClassLink } from '../gradebook/bridge.js';
import { downloadClickableHtmlFile } from '../../core/html-launcher.js';

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

export async function computeRosterHash(students = []) {
  if (!Array.isArray(students) || !students.length) return '';
  const sorted = [...students]
    .map(s => `${String(s.student_id || '').toUpperCase()}:${String(s.access_code || '')}`)
    .sort()
    .join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

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
  const rosterStudents = roster?.students || roster?.withCode || [];
  const rosterHash = await computeRosterHash(rosterStudents);
  const next = {
    ...assignment,
    publish: {
      version: (assignment.publish?.version || 0) + 1,
      salt: randomSalt(),
      published_at: new Date().toISOString(),
      fingerprint: keys.fingerprint,
      roster_hash: rosterHash
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

  const [transport, allCourses] = await Promise.all([
    getTransport(),
    storage.table('gradebook_courses').toArray().catch(() => [])
  ]);
  const hasShortLinks = Boolean(transport?.capabilities?.hostPayload);
  let roster = await getRosterStatus(assignment);
  const teacherProfile = (await storage.getMetadata('teacher_profile')) || {};
  const issues = (assignment.questions || []).map((q, i) => ({ i, issues: validateQuestion(q) })).filter(x => x.issues.length);
  let qCount = assignment.questions?.length || 0;

  const currentClassId = assignment.gradebook?.course_id || assignment.class_id || '';

  const dialog = document.createElement('sl-dialog');
  dialog.id = 'kb-assignment-publish-dialog';
  dialog.label = 'Share & Deliver Assignment';
  dialog.style.setProperty('--width', '680px');
  dialog.innerHTML = `
    <div class="space-y-4">
      <!-- Assignment Summary Header -->
      <div class="flex items-start gap-3 p-3.5 bg-slate-50 rounded-xl border border-slate-200">
        <span class="w-10 h-10 flex-shrink-0 rounded-xl bg-amber-500 text-white flex items-center justify-center text-xl shadow-xs"><sl-icon name="send"></sl-icon></span>
        <div class="min-w-0 flex-1">
          <h3 class="font-bold text-slate-900 truncate">${Sanitizer.escapeHTML(assignment.title || 'Assignment')}</h3>
          <p class="text-xs text-slate-500 mt-0.5" id="publish-header-stats">${qCount} question${qCount === 1 ? '' : 's'} · ${totalPoints(assignment)} pts</p>
        </div>
      </div>

      ${qCount === 0 ? `
        <sl-alert variant="warning" open id="alert-no-questions">
          <sl-icon slot="icon" name="exclamation-triangle"></sl-icon>
          <div>
            <strong class="text-sm">This assignment has no questions yet.</strong>
            <p class="text-xs text-slate-600 mt-0.5">Add a starter question to generate a shareable student link immediately.</p>
            <sl-button size="small" variant="primary" id="btn-add-starter-q" class="mt-2">
              <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add a starter question to generate link
            </sl-button>
          </div>
        </sl-alert>
      ` : ''}

      ${issues.length ? `
        <sl-alert variant="warning" open>
          <sl-icon slot="icon" name="exclamation-triangle"></sl-icon>
          <strong>${issues.length} question${issues.length === 1 ? ' needs' : 's need'} attention.</strong>
          <ul class="mt-1 text-xs list-disc pl-5">
            ${issues.slice(0, 5).map(x => `<li>Question ${x.i + 1}: ${Sanitizer.escapeHTML(x.issues.join(' '))}</li>`).join('')}
          </ul>
        </sl-alert>
      ` : ''}

      <!-- Instant Student Share Link Box -->
      <div id="publish-result" class="${qCount === 0 ? 'hidden' : ''} p-4 rounded-xl border-2 border-emerald-300 bg-emerald-50/50 space-y-3">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 font-bold text-slate-900 text-sm">
            <sl-icon name="link-45deg" class="text-emerald-600 text-lg"></sl-icon> Student Share Link
          </div>
          <span id="publish-meter" class="text-[11px] px-2 py-0.5 rounded-full font-medium"></span>
        </div>
        
        <div class="flex gap-2">
          <sl-input id="input-publish-url" readonly class="flex-1 font-mono text-xs" aria-label="Student share link"></sl-input>
          <sl-button variant="primary" id="btn-publish-copy" class="flex-shrink-0">
            <sl-icon slot="prefix" name="clipboard"></sl-icon> Copy link
          </sl-button>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-emerald-200/60">
          <div class="flex gap-2 flex-wrap">
            <sl-button size="small" id="btn-publish-download-html" variant="primary">
              <sl-icon slot="prefix" name="file-earmark-code"></sl-icon> Download Clickable File (.html)
            </sl-button>
            <sl-button size="small" id="btn-publish-download" variant="default">
              <sl-icon slot="prefix" name="file-earmark-arrow-down"></sl-icon> Download .kbshare
            </sl-button>
            <sl-button size="small" id="btn-publish-per-student-csv" variant="default" ${!roster.students.length ? 'disabled' : ''}>
              <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Per-student links (CSV)
            </sl-button>
          </div>
          <span class="text-[11px] text-slate-500 font-mono" id="publish-fingerprint"></span>
        </div>
      </div>

      <!-- Mode & Class Delivery Settings -->
      <div class="rounded-xl border border-slate-200 p-4 space-y-3 bg-white">
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">Delivery &amp; Grading Settings</h4>
        
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
          <sl-select id="select-publish-class" label="Delivery Mode / Class" size="small" value="${Sanitizer.escapeHTML(currentClassId)}">
            <sl-option value="">Formative Practice (Ungraded — No sign-in)</sl-option>
            <sl-divider></sl-divider>
            ${allCourses.map(c => `
              <sl-option value="${Sanitizer.escapeHTML(c.id)}">Graded in Class: ${Sanitizer.escapeHTML(c.name)}</sl-option>
            `).join('')}
          </sl-select>

          <div class="pt-4 sm:pt-6">
            <sl-checkbox id="chk-release-grade" ${assignment.settings?.release_grade_immediately !== false ? 'checked' : ''}>
              Release grade immediately on submit
            </sl-checkbox>
          </div>
        </div>

        <div class="text-xs text-slate-500 pt-1" id="publish-mode-hint">
          ${currentClassId ? `
            <span class="text-indigo-700 font-medium">Graded Mode:</span> Students sign in with ID and receive an official Gradebook submission.
          ` : `
            <span class="text-emerald-700 font-medium">Formative Practice:</span> Instant zero-friction practice with no ID required and unlimited retries.
          `}
        </div>
      </div>

      <!-- Security & Link Options -->
      <div class="rounded-xl border border-slate-200 p-3.5 space-y-3 bg-slate-50 text-xs">
        <h4 class="font-bold uppercase tracking-wider text-slate-500 text-[10px]">Options</h4>
        
        <div class="space-y-2">
          ${hasShortLinks ? `
            <sl-checkbox id="chk-publish-short-link" checked>Short link (hosted on school server)</sl-checkbox>
          ` : ''}
          <sl-checkbox id="chk-include-email" ${teacherProfile.email ? 'checked' : ''}>Include my email for submission backup</sl-checkbox>
          <sl-input id="input-teacher-email" type="email" placeholder="teacher@school.edu" size="small" value="${Sanitizer.escapeHTML(teacherProfile.email || '')}" ${teacherProfile.email ? '' : 'disabled'}></sl-input>
          <sl-input id="input-publish-passphrase" type="password" password-toggle label="Optional link password" placeholder="Leave empty for public link" size="small"></sl-input>
        </div>
      </div>

      <div id="publish-instructions-mount"></div>
    </div>

    <div slot="footer" class="flex justify-end gap-2">
      <sl-button id="btn-publish-close">Close</sl-button>
      <sl-button variant="default" id="btn-publish-go" ${qCount === 0 ? 'disabled' : ''}>
        <sl-icon slot="prefix" name="arrow-repeat"></sl-icon> Regenerate link
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
    generateLink(true);
  });
  emailInput?.addEventListener('sl-change', () => generateLink(true));

  const classSelect = dialog.querySelector('#select-publish-class');
  classSelect?.addEventListener('sl-change', async (e) => {
    const targetClassId = e.target.value || null;
    await syncContentClassLink(assignment, 'assignments', targetClassId);
    roster = await getRosterStatus(assignment);
    const hint = dialog.querySelector('#publish-mode-hint');
    if (hint) {
      hint.innerHTML = targetClassId
        ? '<span class="text-indigo-700 font-medium">Graded Mode:</span> Students sign in with ID and receive an official Gradebook submission.'
        : '<span class="text-emerald-700 font-medium">Formative Practice:</span> Instant zero-friction practice with no ID required and unlimited retries.';
    }
    const btnCsv = dialog.querySelector('#btn-publish-per-student-csv');
    if (btnCsv) btnCsv.disabled = !roster.students.length;
    await generateLink(true);
  });

  const releaseChk = dialog.querySelector('#chk-release-grade');
  releaseChk?.addEventListener('sl-change', async () => {
    if (!assignment.settings) assignment.settings = {};
    assignment.settings.release_grade_immediately = releaseChk.checked;
    await storage.table('assignments').put(assignment);
    await generateLink(true);
  });

  const shortLinkChk = dialog.querySelector('#chk-publish-short-link');
  shortLinkChk?.addEventListener('sl-change', () => generateLink(true));

  const passInput = dialog.querySelector('#input-publish-passphrase');
  passInput?.addEventListener('sl-change', () => generateLink(true));

  dialog.querySelector('#btn-add-starter-q')?.addEventListener('click', async () => {
    assignment.questions = [{
      id: generateUUID(),
      type: 'single_choice',
      points: 1,
      prompt: 'Sample Question: What is 2 + 2?',
      options: [
        { id: generateUUID().slice(0, 8), text: '4', is_correct: true },
        { id: generateUUID().slice(0, 8), text: '5', is_correct: false }
      ],
      explanation: 'Basic arithmetic: 2 + 2 = 4.'
    }];
    assignment.updated_at = new Date().toISOString();
    await storage.table('assignments').put(assignment);
    toast.success('Starter question added!');
    dialog.hide();
    openPublishDialog(assignment, { onPublished });
  });

  async function generateLink(silent = false) {
    if (!assignment.questions || assignment.questions.length === 0) return;
    const btnGo = dialog.querySelector('#btn-publish-go');
    if (btnGo) btnGo.loading = true;

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

      const passphrase = passInput?.value || '';
      share = await CryptoShareEngine.createSharePayload('assignment', payload, passphrase);
      activeUrl = share.url;

      if (shortLinkChk?.checked && transport?.capabilities?.hostPayload) {
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

      const urlInput = dialog.querySelector('#input-publish-url');
      if (urlInput) urlInput.value = activeUrl;

      const meter = dialog.querySelector('#publish-meter');
      if (meter) {
        if (activeUrl !== share.url) {
          meter.className = 'text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200';
          meter.textContent = `${activeUrl.length} chars · short link via server`;
        } else if (share.length <= 2048) {
          meter.className = 'text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200';
          meter.textContent = `${share.length.toLocaleString()} chars · fits LMS`;
        } else {
          meter.className = 'text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200';
          meter.textContent = `${share.length.toLocaleString()} chars · .kbshare file recommended`;
        }
      }

      const fp = dialog.querySelector('#publish-fingerprint');
      if (fp) {
        fp.innerHTML = `Encrypted for key <strong class="font-mono text-slate-700">${Sanitizer.escapeHTML(keys.fingerprint)}</strong>`;
      }

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

      dialog.querySelector('#publish-result')?.classList.remove('hidden');
      if (!silent) toast.success(`Share link ready!`);
      if (typeof onPublished === 'function') onPublished(updated);
    } catch (err) {
      console.error('Publish failed:', err);
      if (!silent) toast.danger(`Could not publish: ${err.message}`);
    } finally {
      if (btnGo) btnGo.loading = false;
    }
  }

  dialog.querySelector('#btn-publish-go')?.addEventListener('click', () => generateLink(false));

  dialog.querySelector('#btn-publish-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(activeUrl || share?.url || '');
      toast.success('Link copied to clipboard!');
    } catch (_) {
      toast.warning('Copy failed — select the link and copy it manually.');
    }
  });

  dialog.querySelector('#btn-publish-download')?.addEventListener('click', () => {
    if (!share) return;
    const name = (assignment.title || 'assignment').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
    CryptoShareEngine.downloadKbShareFile(share.rawFileContent, `${name}.kbshare`);
  });

  dialog.querySelector('#btn-publish-download-html')?.addEventListener('click', () => {
    if (!share) return;
    const name = (assignment.title || 'assignment').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
    downloadClickableHtmlFile({
      title: assignment.title || 'Assignment',
      payloadType: 'assignment',
      payload: share.rawFileContent,
      shareUrl: activeUrl || share.url
    }, `${name}.kbshare.html`);
    toast.success('Downloaded clickable lesson (.kbshare.html)!');
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

  // Automatically generate link immediately if questions exist!
  if (qCount > 0) {
    generateLink(true);
  }
}
