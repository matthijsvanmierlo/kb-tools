import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { CryptoShareEngine } from '../../core/crypto-share.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { toast } from '../../utils/toast.js';
import { buildStudentVideoPayload } from './secure.js';
import { LinkBuilder } from '../../core/links.js';
import { toCSV, downloadCSV } from '../../core/csv.js';
import { splitName, joinName } from '../../core/names.js';
import { getTransport } from '../../core/transport.js';
import { replication } from '../../core/replication/manager.js';
import { syncContentClassLink } from '../gradebook/bridge.js';
import { downloadClickableHtmlFile } from '../../core/html-launcher.js';

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
  const [transport, courses] = await Promise.all([
    getTransport(),
    storage.table('gradebook_courses').toArray().catch(() => [])
  ]);
  const hasShortLinks = Boolean(transport?.capabilities?.hostPayload);
  let { checks, students } = await rosterChecksFor(assessment);
  let course = assessment.class_id ? courses.find(c => c.id === assessment.class_id) || null : null;

  if (!assessment.settings) {
    assessment.settings = { release_grade_immediately: true, feedback_mode: 'immediate', show_correct_answers: true };
  }

  const dialog = document.createElement('sl-dialog');
  dialog.id = 'kb-video-share-dialog';
  dialog.label = 'Share Video Assessment';
  dialog.style.setProperty('--width', 'min(640px, 96vw)');
  dialog.innerHTML = `
    <div class="space-y-4">
      <!-- Title & Safety Banner -->
      <div class="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5 flex gap-3 items-center">
        <sl-icon name="shield-check" class="text-emerald-600 text-2xl flex-shrink-0"></sl-icon>
        <div class="min-w-0 flex-1">
          <h3 class="font-bold text-slate-900 truncate">${esc(assessment.title || 'Video Assessment')}</h3>
          <p class="text-xs leading-relaxed text-slate-600 mt-0.5">Answer key remains protected on this device. Student submissions are cryptographically encrypted.</p>
        </div>
      </div>

      <!-- Instant Student Share Link Box -->
      <div id="vs-result" class="p-4 rounded-xl border-2 border-emerald-300 bg-emerald-50/50 space-y-3">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 font-bold text-slate-900 text-sm">
            <sl-icon name="link-45deg" class="text-emerald-600 text-lg"></sl-icon> Student Share Link
          </div>
          <span id="vs-meter" class="text-[11px] px-2 py-0.5 rounded-full font-medium"></span>
        </div>

        <div class="flex gap-2">
          <sl-input id="vs-url" readonly class="flex-1 font-mono text-xs" aria-label="Student share link"></sl-input>
          <sl-button variant="primary" id="vs-copy" class="flex-shrink-0">
            <sl-icon slot="prefix" name="clipboard"></sl-icon> Copy link
          </sl-button>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-emerald-200/60">
          <div class="flex gap-2 flex-wrap">
            <sl-button size="small" id="vs-project-qr" variant="primary">
              <sl-icon slot="prefix" name="qr-code-scan"></sl-icon> Project QR Code
            </sl-button>
            <sl-button size="small" id="vs-download-html" variant="default">
              <sl-icon slot="prefix" name="file-earmark-code"></sl-icon> Clickable File (.html)
            </sl-button>
            <sl-button size="small" id="vs-download" variant="default">
              <sl-icon slot="prefix" name="file-earmark-arrow-down"></sl-icon> Download .kbshare
            </sl-button>
            <sl-button size="small" id="vs-per-student-csv" variant="default" ${!students.length ? 'disabled' : ''}>
              <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Per-student links (CSV)
            </sl-button>
          </div>
          <p id="vs-meta" class="text-[11px] text-slate-500 font-mono"></p>
        </div>
      </div>

      <!-- Delivery Mode & Grading Settings -->
      <div class="rounded-xl border border-slate-200 p-4 space-y-3 bg-white">
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">Delivery &amp; Grading Settings</h4>
        
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
          <sl-select id="vs-class" label="Delivery Mode / Class" size="small" value="${esc(assessment.class_id || '')}">
            <sl-option value="">Formative Practice (Ungraded — No sign-in)</sl-option>
            <sl-divider></sl-divider>
            ${courses.map(c => `
              <sl-option value="${esc(c.id)}">Graded in Class: ${esc(c.name)}</sl-option>
            `).join('')}
          </sl-select>

          <div class="pt-4 sm:pt-6">
            <sl-checkbox id="vs-release-grade" ${assessment.settings?.release_grade_immediately !== false ? 'checked' : ''}>
              Release grade immediately on completion
            </sl-checkbox>
          </div>
        </div>

        <div class="pt-2 border-t border-slate-100 space-y-2">
          <sl-switch id="vs-feedback" ${assessment.settings?.feedback_mode !== 'none' ? 'checked' : ''}>Show instant right/wrong feedback at checkpoints</sl-switch>
        </div>
      </div>

      <!-- Options -->
      <div class="rounded-xl border border-slate-200 p-3.5 space-y-3 bg-slate-50 text-xs">
        <h4 class="font-bold uppercase tracking-wider text-slate-500 text-[10px]">Options</h4>
        
        <div class="space-y-2">
          ${hasShortLinks ? `
            <sl-checkbox id="vs-short-link" checked>Short link (hosted on school server)</sl-checkbox>
          ` : ''}
          <sl-input id="vs-passphrase" type="password" password-toggle size="small" label="Optional link passphrase" placeholder="Leave empty for public link"></sl-input>
        </div>
      </div>
    </div>

    <div slot="footer" class="flex flex-wrap justify-end gap-2">
      <sl-button id="vs-close">Close</sl-button>
      <sl-button id="vs-generate" variant="default">
        <sl-icon slot="prefix" name="arrow-repeat"></sl-icon> Regenerate link
      </sl-button>
    </div>`;

  document.body.appendChild(dialog);
  dialog.show();

  let result = null;
  let activeUrl = '';
  dialog.querySelector('#vs-close').addEventListener('click', () => dialog.hide());

  const classSelect = dialog.querySelector('#vs-class');
  classSelect?.addEventListener('sl-change', async (e) => {
    const targetClassId = e.target.value || null;
    await syncContentClassLink(assessment, 'video', targetClassId);
    const rc = await rosterChecksFor(assessment);
    checks = rc.checks;
    students = rc.students;
    const btnCsv = dialog.querySelector('#vs-per-student-csv');
    if (btnCsv) btnCsv.disabled = !students.length;
    await generateLink(true);
  });

  const releaseChk = dialog.querySelector('#vs-release-grade');
  releaseChk?.addEventListener('sl-change', async () => {
    if (!assessment.settings) assessment.settings = {};
    assessment.settings.release_grade_immediately = releaseChk.checked;
    await storage.table('video_assessments').put(assessment);
    await generateLink(true);
  });

  const feedbackSwitch = dialog.querySelector('#vs-feedback');
  feedbackSwitch?.addEventListener('sl-change', async () => {
    if (!assessment.settings) assessment.settings = {};
    assessment.settings.feedback_mode = feedbackSwitch.checked ? 'immediate' : 'none';
    await storage.table('video_assessments').put(assessment);
    await generateLink(true);
  });

  const shortLinkChk = dialog.querySelector('#vs-short-link');
  shortLinkChk?.addEventListener('sl-change', () => generateLink(true));

  const passInput = dialog.querySelector('#vs-passphrase');
  passInput?.addEventListener('sl-change', () => generateLink(true));

  async function generateLink(silent = false) {
    const btn = dialog.querySelector('#vs-generate');
    if (btn) btn.loading = true;
    try {
      const teacherKeys = await replication.publishKeysFor(assessment.class_id);
      const isInstant = feedbackSwitch ? feedbackSwitch.checked : true;

      let rosterCards = null;
      if (students?.length) {
        rosterCards = {};
        for (const s of students) {
          if (s.access_code) {
            const card = await SubmissionCrypto.buildRosterCard(assessment.id, s, s.access_code);
            if (card?.tag) rosterCards[card.tag] = card.ct;
          }
        }
      }
      const courseMeta = course ? {
        course_id: course.id,
        course_name: course.name || '',
        section: course.section || ''
      } : null;

      const payload = await buildStudentVideoPayload(assessment, {
        teacherKeys,
        rosterChecks: checks,
        rosterCards,
        courseMeta,
        instantFeedback: isInstant
      });

      if (transport?.capabilities?.collectSubmissions) {
        try {
          const drop = await transport.createDrop({
            assignmentId: assessment.id,
            expiresAt: new Date(Date.now() + 180 * 86400000).toISOString()
          });
          payload.relay = { base_url: transport.baseUrl, drop_id: drop.dropId, drop_secret: drop.dropSecret };
        } catch (e) {
          console.warn('Could not create drop on relay for video:', e);
        }
      }

      result = await CryptoShareEngine.createSharePayload('video', payload, passInput?.value || '');
      activeUrl = result.url;

      if (shortLinkChk?.checked && transport?.capabilities?.hostPayload) {
        try {
          const wrapped = await CryptoShareEngine.wrapForHosting(result.rawFileContent);
          const pub = await transport.publishPayload({
            kind: 'video',
            ciphertext: wrapped.ciphertext,
            expiresAt: new Date(Date.now() + 180 * 86400000).toISOString(),
            meta: { title: assessment.title }
          });
          activeUrl = LinkBuilder.hosted(pub.ref, wrapped.key);
        } catch (e) {
          console.warn('Failed to publish video short link to relay:', e);
        }
      }

      const urlInput = dialog.querySelector('#vs-url');
      if (urlInput) urlInput.value = activeUrl;

      const meter = dialog.querySelector('#vs-meter');
      if (meter) {
        if (activeUrl !== result.url) {
          meter.className = 'text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200';
          meter.textContent = `${activeUrl.length} chars · short link via server`;
        } else if (result.length <= 2048) {
          meter.className = 'text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200';
          meter.textContent = `${result.length.toLocaleString()} chars · fits LMS`;
        } else {
          meter.className = 'text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200';
          meter.textContent = `${result.length.toLocaleString()} chars · .kbshare file recommended`;
        }
      }

      const meta = dialog.querySelector('#vs-meta');
      if (meta) {
        meta.innerHTML = `Key <strong class="font-mono text-slate-700">${esc(teacherKeys.fingerprint)}</strong>`;
      }

      dialog.querySelector('#vs-result')?.classList.remove('hidden');
      if (!silent) toast.success('Share link ready!');
    } catch (err) {
      console.error('Video share failed:', err);
      if (!silent) toast.danger('Could not create the link.');
    } finally {
      if (btn) btn.loading = false;
    }
  }

  dialog.querySelector('#vs-generate')?.addEventListener('click', () => generateLink(false));

  dialog.querySelector('#vs-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(activeUrl || result?.url || '');
      toast.success('Student link copied!');
    } catch (_) {
      toast.warning('Copy failed — select the link and copy it manually.');
    }
  });

  dialog.querySelector('#vs-project-qr')?.addEventListener('click', async () => {
    const targetPayload = activeUrl || result?.url || result?.rawFileContent;
    if (!targetPayload) {
      toast.warning('Generate a link or save assessment first.');
      return;
    }
    const { showQrSequence } = await import('../../components/qr-handoff.js');
    showQrSequence(targetPayload, {
      title: `Video Assessment: ${assessment.title || 'Untitled'}`,
      intro: 'Have students scan this code to open the interactive video lesson.',
      preferDirectUrl: true
    });
  });

  dialog.querySelector('#vs-download')?.addEventListener('click', () => {
    if (!result) return;
    CryptoShareEngine.downloadKbShareFile(result.rawFileContent, `${(assessment.title || 'video').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.kbshare`);
  });

  dialog.querySelector('#vs-download-html')?.addEventListener('click', () => {
    if (!result) return;
    const cleanName = (assessment.title || 'video').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    downloadClickableHtmlFile({
      title: assessment.title || 'Video Assessment',
      payloadType: 'lesson',
      payload: result.rawFileContent,
      shareUrl: activeUrl || result.url
    }, `${cleanName}.kbshare.html`);
    toast.success('Downloaded clickable video assessment (.kbshare.html)!');
  });

  dialog.querySelector('#vs-per-student-csv')?.addEventListener('click', () => {
    if ((!activeUrl && !result) || !students.length) return;
    const targetUrl = activeUrl || result.url;
    const rows = students.map(s => {
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
    downloadCSV(`${(assessment.title || 'video').replace(/[^a-z0-9_-]+/gi, '_')}_student_links.csv`, text);
    toast.success(`Exported ${rows.length} per-student links.`);
  });

  dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });

  // Generate link immediately!
  generateLink(true);
}

export default openVideoShareDialog;
