import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { CryptoShareEngine } from '../../core/crypto-share.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { toast } from '../../utils/toast.js';
import { buildStudentVideoPayload } from './secure.js';

/**
 * Student-safe sharing for video assessments (KB-VID-005).
 * Replaces the generic share dialog, which would have sent the full record including the
 * answer key. Links carry the teacher's public key so student receipts come back encrypted.
 */

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

/** Access-code check values for the linked class (lets the kiosk catch typos before starting) */
export async function rosterChecksFor(assessment) {
  if (!assessment.class_id) return { checks: null, students: [] };
  const students = await storage.table('gradebook_students').where('course_id').equals(assessment.class_id).toArray().catch(() => []);
  const checks = {};
  for (const s of students) {
    if (s.access_code) checks[String(s.student_id).toUpperCase()] = await SubmissionCrypto.accessCodeCheck(assessment.id, s.student_id, s.access_code);
  }
  return { checks: Object.keys(checks).length ? checks : null, students };
}

export async function openVideoShareDialog(assessment) {
  document.getElementById('kb-video-share-dialog')?.remove();
  const { students } = await rosterChecksFor(assessment);
  const withoutCode = students.filter(s => !s.access_code).length;
  const course = assessment.class_id ? await storage.table('gradebook_courses').get(assessment.class_id) : null;

  const dialog = document.createElement('sl-dialog');
  dialog.id = 'kb-video-share-dialog';
  dialog.label = 'Share with students';
  dialog.style.setProperty('--width', 'min(600px, 96vw)');
  dialog.innerHTML = `
    <div class="space-y-4">
      <div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3 flex gap-3">
        <sl-icon name="shield-check" class="text-emerald-600 text-xl flex-shrink-0"></sl-icon>
        <p class="text-xs leading-relaxed text-slate-700">The link contains the video and questions but <strong>not the answer key</strong>. Students hand in an encrypted receipt that only this device can open, and every answer is re-graded here when you import it.</p>
      </div>

      <div class="rounded-xl border border-slate-200 p-4 space-y-2">
        <sl-switch id="vs-feedback" checked>Show students right/wrong after each question</sl-switch>
        <p class="text-xs text-slate-500 leading-relaxed">Instant feedback uses scrambled answer fingerprints. A technically skilled student could test choices against them, so turn this off for higher-stakes assessments; answers are then only graded when you import receipts. With feedback on, the explanations you wrote for each option are included too.</p>
      </div>

      ${course ? `
        <div class="rounded-xl border ${withoutCode ? 'border-amber-200 bg-amber-50' : 'border-slate-200'} p-4 text-xs text-slate-700 space-y-1">
          <p class="font-semibold text-slate-900 flex items-center gap-2"><sl-icon name="key" class="text-blue-600"></sl-icon> ${esc(course.name)} · ${students.length} student${students.length === 1 ? '' : 's'}</p>
          <p>${withoutCode
            ? `${withoutCode} student${withoutCode === 1 ? ' has' : 's have'} no access code, so their receipts can't be identity-checked. Generate codes in Gradebook → class settings → Student access, then share again.`
            : 'Students enter their student ID and access code before starting; receipts are signed with their code.'}</p>
        </div>` : `
        <p class="text-xs text-slate-500">Assign this assessment to a class to check student identity with access codes.</p>`}

      <sl-input id="vs-passphrase" type="password" password-toggle size="small" label="Optional link passphrase" placeholder="Leave blank for a link anyone in class can open"></sl-input>

      <div id="vs-result" class="hidden space-y-2 pt-3 border-t border-slate-100">
        <sl-input id="vs-url" readonly size="small" label="Student link"></sl-input>
        <p id="vs-meta" class="text-xs text-slate-500"></p>
      </div>
    </div>
    <div slot="footer" class="flex flex-wrap justify-end gap-2">
      <sl-button id="vs-close">Close</sl-button>
      <sl-button id="vs-download" class="hidden"><sl-icon slot="prefix" name="file-earmark-arrow-down"></sl-icon> .kbshare file</sl-button>
      <sl-button id="vs-copy" class="hidden" variant="primary"><sl-icon slot="prefix" name="clipboard"></sl-icon> Copy link</sl-button>
      <sl-button id="vs-generate" variant="primary"><sl-icon slot="prefix" name="link-45deg"></sl-icon> Create link</sl-button>
    </div>`;

  document.body.appendChild(dialog);
  dialog.show();

  let result = null;
  dialog.querySelector('#vs-close').addEventListener('click', () => dialog.hide());
  dialog.querySelector('#vs-generate').addEventListener('click', async () => {
    const btn = dialog.querySelector('#vs-generate');
    btn.loading = true;
    try {
      const teacherKeys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
      const { checks } = await rosterChecksFor(assessment);
      const payload = await buildStudentVideoPayload(assessment, {
        teacherKeys,
        rosterChecks: checks,
        instantFeedback: dialog.querySelector('#vs-feedback').checked
      });
      result = await CryptoShareEngine.createSharePayload('video', payload, dialog.querySelector('#vs-passphrase').value || '');
      dialog.querySelector('#vs-url').value = result.url;
      dialog.querySelector('#vs-meta').innerHTML = `${result.length.toLocaleString()} characters${result.exceedsUrlLimit ? ' — long link; the .kbshare file is more reliable in an LMS' : ''} · receipts encrypted for key <strong class="font-mono">${esc(teacherKeys.fingerprint)}</strong>`;
      dialog.querySelector('#vs-result').classList.remove('hidden');
      ['#vs-copy', '#vs-download'].forEach(id => dialog.querySelector(id).classList.remove('hidden'));
      btn.classList.add('hidden');
    } catch (err) {
      console.error('Video share failed:', err);
      toast.danger('Could not create the link.');
    } finally {
      btn.loading = false;
    }
  });
  dialog.querySelector('#vs-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(result.url); toast.success('Student link copied!'); } catch (_) { toast.warning('Copy failed — select the link and copy it manually.'); }
  });
  dialog.querySelector('#vs-download').addEventListener('click', () => {
    CryptoShareEngine.downloadKbShareFile(result.rawFileContent, `${(assessment.title || 'video').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.kbshare`);
  });
  dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
}

export default openVideoShareDialog;
