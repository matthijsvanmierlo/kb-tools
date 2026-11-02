import { storage } from '../../core/storage.js';
import { CryptoShareEngine } from '../../core/crypto-share.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { buildStudentTaskPayload } from './publish-core.js';
import { getTransport, isCdnUploadConfigured } from '../../core/transport.js';
import { replication } from '../../core/replication/manager.js';
import { downloadClickableHtmlFile } from '../../core/html-launcher.js';
import { HandinInstructions } from '../../components/handin-instructions.js';
import { LinkBuilder } from '../../core/links.js';
import {
  computeRosterHash,
  getTaskRosterStatus,
  randomSalt,
  buildRosterChecksAndCards,
  ensureDropBox,
  computeContentHash
} from '../../core/publish-core.js';

export { computeRosterHash, getTaskRosterStatus };

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

/**
 * Publishes a task: bumps version if content changed, derives keys, establishes drop box if relay enabled,
 * and builds the student-safe payload.
 *
 * @param {object} task
 * @param {object} [roster]
 * @param {object} [opts]
 * @returns {Promise<{ task: object, payload: object, keys: object }>}
 */
export async function publishTask(task, roster = null, { transport = null, handinEmail = '', teacherKeys = null } = {}) {
  const activeTransport = transport || await getTransport();
  const keys = teacherKeys || await replication.publishKeysFor(task.class_id);

  const rosterStudents = roster?.students || roster?.withCode || [];
  const rosterHash = await computeRosterHash(rosterStudents);
  const cdnActive = await isCdnUploadConfigured();

  const { rosterChecks, rosterCards } = await buildRosterChecksAndCards(
    task.id,
    roster,
    !!task.settings?.require_access_code
  );

  const courseMeta = roster?.course ? {
    course_id: roster.course.id,
    course_name: roster.course.name || '',
    section: roster.course.section || ''
  } : null;

  // Load rubric and standards if referenced
  let rubric = null;
  if (task.grading?.rubric_id) {
    rubric = await storage.table('gradebook_rubrics').get(task.grading.rubric_id).catch(() => null);
  }
  let standards = [];
  if (Array.isArray(task.grading?.standard_ids) && task.grading.standard_ids.length && roster?.course) {
    const { getStandards } = await import('../gradebook/grading-scales.js');
    const allStds = getStandards(roster.course);
    standards = allStds.filter(s => task.grading.standard_ids.includes(s.id));
  }

  const salt = task.publish?.salt || randomSalt();
  const relayInfo = await ensureDropBox(task, activeTransport, {
    cdnActive,
    filesConfig: task.submission_types?.files
  });

  const tempNext = {
    ...task,
    publish: {
      ...(task.publish || {}),
      salt,
      cdn_student_upload: cdnActive,
      relay: relayInfo
    }
  };

  const candidatePayload = await buildStudentTaskPayload(tempNext, {
    teacherKeys: keys,
    rosterChecks,
    rosterCards,
    courseMeta,
    relay: relayInfo,
    rubric,
    standards
  });

  if (handinEmail) {
    candidatePayload.handin = { email: handinEmail };
  }

  const contentHash = await computeContentHash(candidatePayload);
  let version = task.publish?.version || 1;
  if (!task.publish?.content_hash) {
    version = task.publish?.version || 1;
  } else if (task.publish.content_hash !== contentHash) {
    version = (task.publish?.version || 0) + 1;
  }

  const next = {
    ...task,
    publish: {
      version,
      salt,
      published_at: new Date().toISOString(),
      fingerprint: keys.fingerprint,
      roster_hash: rosterHash,
      cdn_student_upload: cdnActive,
      relay: relayInfo,
      relay_history: task.publish?.relay_history || [],
      content_hash: contentHash
    },
    updated_at: new Date().toISOString()
  };

  candidatePayload.publish_version = version;

  await storage.table('tasks').put(next);
  return { task: next, payload: candidatePayload, keys };
}

/**
 * Open the publish dialog for an assignment.
 * @param {object} task
 * @param {object} [opts]
 * @param {(t: object) => void} [opts.onPublished]
 */
export async function openTaskPublishDialog(task, { onPublished } = {}) {
  const existing = document.getElementById('kb-task-publish-dialog');
  if (existing) existing.remove();

  // Validate at least one submission type is enabled
  const types = task.submission_types || {};
  const hasType = Object.values(types).some(t => t && t.enabled);
  if (!hasType) {
    toast.error('Please enable at least one submission type (Text, Code, Files, or Drawing) before publishing.');
    return;
  }

  const [transport, allCourses] = await Promise.all([
    getTransport(),
    storage.table('gradebook_courses').toArray().catch(() => [])
  ]);
  const hasShortLinks = Boolean(transport?.capabilities?.hostPayload);
  const cdnActive = await isCdnUploadConfigured();
  let roster = await getTaskRosterStatus(task);
  const teacherProfile = (await storage.getMetadata('teacher_profile')) || {};

  const dialog = document.createElement('sl-dialog');
  dialog.id = 'kb-task-publish-dialog';
  dialog.label = 'Share & Deliver Assignment';
  dialog.style.setProperty('--width', '680px');

  const courseName = roster.course?.name || 'No Class Selected';

  dialog.innerHTML = `
    <div class="space-y-5">
      <!-- Target Class Info -->
      <div class="p-3.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between text-xs">
        <div>
          <span class="text-slate-500">Target Class:</span>
          <strong class="text-slate-800 ml-1.5">${esc(courseName)}</strong>
          ${roster.course?.section ? `<span class="text-slate-500 ml-1">(${esc(roster.course.section)})</span>` : ''}
        </div>
        <span class="text-slate-500">${roster.students.length} student${roster.students.length === 1 ? '' : 's'} enrolled</span>
      </div>

      ${types.files?.enabled && !cdnActive ? `
        <div class="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 flex items-start gap-2">
          <sl-icon name="exclamation-triangle" class="text-amber-600 text-base mt-0.5 flex-shrink-0"></sl-icon>
          <div>
            <strong>File uploads are enabled, but Media CDN is not configured on this server.</strong>
            File attachments will be disabled for students until CDN storage is configured.
          </div>
        </div>
      ` : ''}

      <!-- Email Handin (Optional fallback) -->
      <sl-input id="task-pub-email" label="Hand-in Email (optional)" placeholder="teacher@school.edu" value="${esc(teacherProfile.email || '')}" size="small" help-text="Offers mailto submission fallback on student devices without relay access."></sl-input>

      <!-- Action Button -->
      <div class="space-y-2">
        <sl-button variant="primary" id="task-pub-go-btn" class="w-full">
          <sl-icon slot="prefix" name="send"></sl-icon> Publish Assignment
        </sl-button>
        <sl-button variant="default" id="task-pub-copy-existing-btn" class="w-full ${task.publish?.published_at ? '' : 'hidden'}">
          <sl-icon slot="prefix" name="copy"></sl-icon> Copy existing link
        </sl-button>
      </div>

      <!-- Results Container -->
      <div id="task-pub-results" class="hidden space-y-4 pt-3 border-t border-slate-200">
        <div class="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <sl-icon name="check-circle-fill" class="text-emerald-600 text-base"></sl-icon>
            <span><strong>Published successfully!</strong> Version <span id="task-pub-ver"></span></span>
          </div>
          <span class="text-slate-500" id="task-pub-time"></span>
        </div>

        <!-- Share URL -->
        <div class="space-y-1.5">
          <label class="text-xs font-semibold text-slate-700">Student Link</label>
          <div class="flex gap-2">
            <sl-input id="task-pub-link-input" readonly size="small" class="flex-1 font-mono text-xs"></sl-input>
            <sl-button size="small" id="task-pub-copy-link-btn" title="Copy Link"><sl-icon name="copy"></sl-icon></sl-button>
          </div>
        </div>

        <!-- Download Buttons -->
        <div class="flex flex-wrap gap-2 pt-1">
          <sl-button size="small" id="task-pub-dl-share"><sl-icon slot="prefix" name="download"></sl-icon> Download .kbshare</sl-button>
          <sl-button size="small" id="task-pub-dl-html"><sl-icon slot="prefix" name="file-earmark-code"></sl-icon> Download Clickable .html</sl-button>
        </div>

        <!-- Handin Sheet View -->
        <div id="task-pub-handin-container"></div>
      </div>
    </div>
    <sl-button slot="footer" variant="default" id="task-pub-close-btn">Close</sl-button>
  `;

  document.body.appendChild(dialog);
  dialog.show();

  const goBtn = dialog.querySelector('#task-pub-go-btn');
  const resultsDiv = dialog.querySelector('#task-pub-results');
  const linkInput = dialog.querySelector('#task-pub-link-input');
  const copyBtn = dialog.querySelector('#task-pub-copy-link-btn');
  const dlShareBtn = dialog.querySelector('#task-pub-dl-share');
  const dlHtmlBtn = dialog.querySelector('#task-pub-dl-html');
  const closeBtn = dialog.querySelector('#task-pub-close-btn');

  closeBtn.addEventListener('click', () => dialog.hide());
  dialog.addEventListener('sl-after-hide', (e) => {
    if (e.target !== dialog) return;
    dialog.remove();
  });

  let currentPublished = null;
  let currentShareUrl = '';

  const copyExistingBtn = dialog.querySelector('#task-pub-copy-existing-btn');

  const buildExistingLink = async () => {
    if (!task.publish?.published_at) return null;
    const keys = await replication.publishKeysFor(task.class_id);
    const { rosterChecks, rosterCards } = await buildRosterChecksAndCards(
      task.id,
      roster,
      !!task.settings?.require_access_code
    );
    const courseMeta = roster?.course ? {
      course_id: roster.course.id,
      course_name: roster.course.name || '',
      section: roster.course.section || ''
    } : null;
    let rubric = null;
    if (task.grading?.rubric_id) {
      rubric = await storage.table('gradebook_rubrics').get(task.grading.rubric_id).catch(() => null);
    }
    let standards = [];
    if (Array.isArray(task.grading?.standard_ids) && task.grading.standard_ids.length && roster?.course) {
      const { getStandards } = await import('../gradebook/grading-scales.js');
      const allStds = getStandards(roster.course);
      standards = allStds.filter(s => task.grading.standard_ids.includes(s.id));
    }
    const payload = await buildStudentTaskPayload(task, {
      teacherKeys: keys,
      rosterChecks,
      rosterCards,
      courseMeta,
      relay: task.publish?.relay || null,
      rubric,
      standards
    });
    const share = await CryptoShareEngine.createSharePayload('task', payload);
    let shareUrl = share.url;
    if (hasShortLinks && transport?.capabilities?.hostPayload) {
      try {
        const wrapped = await CryptoShareEngine.wrapForHosting(share.rawFileContent);
        const pub = await transport.publishPayload({
          kind: 'task',
          ciphertext: wrapped.ciphertext,
          expiresAt: new Date(Date.now() + 180 * 86400000).toISOString(),
          meta: { title: task.title }
        });
        shareUrl = LinkBuilder.hosted(pub.ref, wrapped.key);
      } catch (_) {}
    }
    return { task, payload, keys, shareUrl };
  };

  if (task.publish?.published_at) {
    buildExistingLink().then(res => {
      if (!res) return;
      currentPublished = { task: res.task, payload: res.payload, keys: res.keys };
      currentShareUrl = res.shareUrl;
      linkInput.value = res.shareUrl;
      dialog.querySelector('#task-pub-ver').textContent = String(task.publish.version || 1);
      dialog.querySelector('#task-pub-time').textContent = new Date(task.publish.published_at).toLocaleTimeString();
      resultsDiv.classList.remove('hidden');

      const handinContainer = dialog.querySelector('#task-pub-handin-container');
      if (handinContainer) {
        handinContainer.innerHTML = '';
        handinContainer.appendChild(HandinInstructions.render({
          assignment: task,
          link: res.shareUrl,
          dueDate: task.settings?.due_date,
          dueTime: task.settings?.due_time
        }));
      }
    }).catch(e => console.warn('Could not build existing task link:', e));
  }

  copyExistingBtn?.addEventListener('click', async () => {
    if (!currentShareUrl) {
      const res = await buildExistingLink();
      if (res) currentShareUrl = res.shareUrl;
    }
    if (currentShareUrl) {
      try {
        await navigator.clipboard.writeText(currentShareUrl);
        toast.success('Existing link copied!');
      } catch (_) {
        linkInput.select();
        document.execCommand('copy');
        toast.success('Existing link copied!');
      }
    }
  });

  goBtn.addEventListener('click', async () => {
    goBtn.loading = true;
    try {
      const email = dialog.querySelector('#task-pub-email')?.value?.trim() || '';
      const published = await publishTask(task, roster, { handinEmail: email, transport });
      currentPublished = published;

      const share = await CryptoShareEngine.createSharePayload('task', published.payload);
      let shareUrl = share.url;

      if (hasShortLinks && transport?.capabilities?.hostPayload) {
        try {
          const wrapped = await CryptoShareEngine.wrapForHosting(share.rawFileContent);
          const pub = await transport.publishPayload({
            kind: 'task',
            ciphertext: wrapped.ciphertext,
            expiresAt: new Date(Date.now() + 180 * 86400000).toISOString(),
            meta: { title: task.title }
          });
          shareUrl = LinkBuilder.hosted(pub.ref, wrapped.key);
        } catch (e) {
          console.warn('Hosted link failed, falling back to full hash fragment:', e);
        }
      }

      currentShareUrl = shareUrl;
      linkInput.value = shareUrl;
      dialog.querySelector('#task-pub-ver').textContent = String(published.task.publish.version);
      dialog.querySelector('#task-pub-time').textContent = new Date(published.task.publish.published_at).toLocaleTimeString();
      resultsDiv.classList.remove('hidden');

      // Hand-in sheet component
      const handinContainer = dialog.querySelector('#task-pub-handin-container');
      if (handinContainer) {
        handinContainer.innerHTML = '';
        handinContainer.appendChild(HandinInstructions.render({
          assignment: published.task,
          link: shareUrl,
          dueDate: task.settings?.due_date,
          dueTime: task.settings?.due_time,
          teacherEmail: email
        }));
      }

      toast.success('Assignment published!');
      if (typeof onPublished === 'function') {
        onPublished(published.task);
      }
    } catch (err) {
      console.error(err);
      toast.error('Failed to publish: ' + (err.message || String(err)));
    } finally {
      goBtn.loading = false;
    }
  });

  copyBtn.addEventListener('click', async () => {
    if (!currentShareUrl) return;
    try {
      await navigator.clipboard.writeText(currentShareUrl);
      toast.success('Link copied to clipboard!');
    } catch (_) {
      linkInput.select();
      document.execCommand('copy');
      toast.success('Link copied!');
    }
  });

  dlShareBtn.addEventListener('click', async () => {
    if (!currentPublished) return;
    const share = await CryptoShareEngine.createSharePayload('task', currentPublished.payload);
    const blob = new Blob([share.rawFileContent], { type: 'application/json' });
    const filename = `${(task.title || 'Assignment').replace(/[^a-z0-9_-]/gi, '_')}.kbshare`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  dlHtmlBtn.addEventListener('click', async () => {
    if (!currentPublished || !currentShareUrl) return;
    const filename = `${(task.title || 'Assignment').replace(/[^a-z0-9_-]/gi, '_')}.html`;
    downloadClickableHtmlFile({
      title: task.title || 'Assignment',
      payloadType: 'task',
      payload: currentPublished.payload,
      shareUrl: currentShareUrl
    }, filename);
  });
}
