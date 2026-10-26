/**
 * Universal Student Work Inbox (KB-INBOX-001)
 * Central drop zone and staging table for .kbsub, .kbr, .txt, and .zip archives.
 */

import { storage } from '../../core/storage.js';
import { store } from '../../state/store.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { classifyText, expandFiles, splitSubmissionText } from '../../core/envelope-router.js';
import { importSubmissionTexts } from '../assignments/import.js';
import { importVideoReceipts, receiptErrorText } from '../video/receipt-import.js';
import { getTransport } from '../../core/transport.js';
import { getPolicy } from '../../core/managed-config.js';

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

export async function renderInboxView(params, router, container) {
  let staged = []; // Session-only staging array: { id, source, text, classification, targetTitle, studentClaim, status, statusTone, errorDetail }
  let lastImportSummary = null; // Stored results after Import All: array of { title, type, added, duplicates, errors, link }
  let watchDirHandle = null;
  let watchInterval = null;
  let watchFolderName = '';
  let autoImport = Boolean(await storage.getMetadata('inbox_auto_import'));
  const seenFiles = new Set();

  const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
  const transport = await getTransport();
  const hasRelaySubmissions = Boolean(transport?.capabilities?.collectSubmissions);

  const classifyAndStage = async (rawItems) => {
    const nextItems = [];

    for (const item of rawItems) {
      const source = item.source || 'Dropped item';
      const text = item.text || '';
      if (!text.trim()) continue;

      const c = classifyText(text);
      let targetTitle = '—';
      let studentClaim = '—';
      let status = 'Ready';
      let statusTone = 'emerald';
      let errorDetail = '';

      if (c.kind === 'assignment') {
        const asg = c.assignment_id ? await storage.table('assignments').get(c.assignment_id) : null;
        if (asg) {
          targetTitle = asg.title || 'Untitled Assessment';
        } else {
          targetTitle = `Assessment (${c.assignment_id || 'unknown'})`;
          status = 'Assessment not found';
          statusTone = 'amber';
          errorDetail = 'This assessment is not in your library on this device.';
        }
      } else if (c.kind === 'task') {
        const tsk = c.task_id ? await storage.table('tasks').get(c.task_id) : null;
        if (tsk) {
          targetTitle = tsk.title || 'Untitled Assignment';
        } else {
          targetTitle = `Assignment (${c.task_id || 'unknown'})`;
          status = 'Assignment not found';
          statusTone = 'amber';
          errorDetail = 'This assignment is not in your library on this device.';
        }
      } else if (c.kind === 'video_receipt') {
        const vid = c.assessment_id ? await storage.table('video_assessments').get(c.assessment_id) : null;
        if (vid) {
          targetTitle = vid.title || 'Untitled Video';
        } else {
          targetTitle = `Video (${c.assessment_id || 'unknown'})`;
          status = 'Video not found';
          statusTone = 'amber';
          errorDetail = 'This video assessment is not in your library on this device.';
        }
      } else if (c.kind === 'legacy_receipt') {
        targetTitle = 'Legacy video receipt';
        status = 'Legacy format';
        statusTone = 'amber';
        try {
          const parsed = JSON.parse(text);
          if (parsed.receipt?.studentId) studentClaim = parsed.receipt.studentId;
          else if (parsed.receipt?.studentName) studentClaim = parsed.receipt.studentName;
        } catch (_) {}
      } else if (c.kind === 'kbshare') {
        targetTitle = 'Lesson share (.kbshare)';
        status = 'Not student work';
        statusTone = 'rose';
        errorDetail = 'This is a shared lesson, not student hand-in work.';
      } else {
        targetTitle = 'Unrecognized data';
        status = 'Unknown format';
        statusTone = 'rose';
        errorDetail = 'Not a valid .kbsub or .kbr file.';
      }

      nextItems.push({
        id: crypto.randomUUID(),
        source,
        text,
        classification: c,
        targetTitle,
        studentClaim,
        status,
        statusTone,
        errorDetail
      });
    }

    staged = [...staged, ...nextItems];
    render();
  };

  const render = () => {
    container.innerHTML = `
      <div class="max-w-6xl mx-auto space-y-6">
        <!-- Header -->
        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
          <div class="flex items-center gap-3">
            <span class="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center text-2xl">
              <sl-icon name="inbox"></sl-icon>
            </span>
            <div>
              <h1 class="text-xl font-bold text-slate-900">Student Work Inbox</h1>
              <p class="text-xs text-slate-500">Collect submissions, video receipts, and batch LMS downloads in one place.</p>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <sl-button size="small" id="btn-watch-folder" variant="${watchDirHandle ? 'primary' : 'default'}">
              <sl-icon slot="prefix" name="${watchDirHandle ? 'folder-check' : 'folder2-open'}"></sl-icon>
              ${watchDirHandle ? `Watching "${esc(watchFolderName)}"` : 'Watch folder'}
            </sl-button>
            ${watchDirHandle ? `
              <sl-button size="small" variant="default" id="btn-stop-watch" title="Stop watching">
                <sl-icon name="x-lg"></sl-icon>
              </sl-button>
            ` : ''}
            <sl-tooltip content="Automatically import matched submissions into gradebook as soon as files appear in the watched folder">
              <sl-switch id="switch-auto-import" size="small" ${autoImport ? 'checked' : ''}>Auto-import</sl-switch>
            </sl-tooltip>
            ${hasRelaySubmissions ? `
              <sl-button size="small" id="btn-check-server">
                <sl-icon slot="prefix" name="cloud-download"></sl-icon> Check server
              </sl-button>
            ` : ''}
            <sl-button size="small" id="btn-scan-qr">
              <sl-icon slot="prefix" name="qr-code-scan"></sl-icon> Scan QR codes
            </sl-button>
            ${getPolicy().allowDirectTransfer ? `<sl-button size="small" id="btn-receive-direct" title="A student sends straight from their device on the same network">
              <sl-icon slot="prefix" name="wifi"></sl-icon> Receive directly
            </sl-button>` : ''}
            <sl-button size="small" id="btn-paste-codes">
              <sl-icon slot="prefix" name="clipboard-plus"></sl-icon> Paste codes
            </sl-button>
            <sl-button size="small" id="btn-browse-files">
              <sl-icon slot="prefix" name="upload"></sl-icon> Select files
            </sl-button>
            <input type="file" id="inbox-file-input" multiple accept=".kbsub,.kbsub.html,.kbr,.zip,.html,.htm,.json,.txt" class="hidden" />
          </div>
        </div>

        <!-- Drop Zone -->
        <div id="inbox-dropzone" class="border-2 border-dashed border-slate-300 hover:border-amber-400 bg-slate-50/60 hover:bg-amber-50/20 transition-all rounded-2xl p-8 text-center cursor-pointer space-y-2">
          <sl-icon name="cloud-arrow-up" class="text-4xl text-slate-400 mx-auto block"></sl-icon>
          <div class="font-semibold text-slate-800">Drop .kbsub, .kbr, .txt or .zip files here — or scan students' QR codes</div>
          <div class="text-xs text-slate-500 max-w-md mx-auto">
            Drop bulk ZIP exports from Canvas, Google Classroom, or Brightspace. Nested archives, LMS-prepended filenames, and multi-code files are unpacked automatically.
          </div>
        </div>

        <!-- Staging Table / State -->
        ${staged.length > 0 ? `
          <div class="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden space-y-4 p-5">
            <div class="flex items-center justify-between">
              <div>
                <h2 class="font-bold text-slate-900 text-base">Staged items (${staged.length})</h2>
                <p class="text-xs text-slate-500">Review detected targets before importing into your records.</p>
              </div>
              <div class="flex items-center gap-2">
                <sl-button size="small" variant="default" id="btn-clear-staged">Clear list</sl-button>
                <sl-button size="small" variant="primary" id="btn-import-all">
                  <sl-icon slot="prefix" name="box-arrow-in-down"></sl-icon> Import all (${staged.length})
                </sl-button>
              </div>
            </div>

            <div class="overflow-x-auto">
              <table class="w-full text-sm text-left">
                <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th class="px-4 py-3 font-semibold">Source</th>
                    <th class="px-4 py-3 font-semibold">Kind</th>
                    <th class="px-4 py-3 font-semibold">Detected target</th>
                    <th class="px-4 py-3 font-semibold">Student ID</th>
                    <th class="px-4 py-3 font-semibold">Status</th>
                    <th class="px-4 py-3 text-right"></th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  ${staged.map(item => `
                    <tr class="hover:bg-slate-50/80">
                      <td class="px-4 py-3 font-medium text-slate-900 max-w-[220px] truncate" title="${esc(item.source)}">
                        ${esc(item.source)}
                      </td>
                      <td class="px-4 py-3">
                        <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${kindBadgeClass(item.classification.kind)}">
                          ${esc(kindLabel(item.classification.kind))}
                        </span>
                      </td>
                      <td class="px-4 py-3">
                        <div class="font-medium text-slate-800">${esc(item.targetTitle)}</div>
                        ${item.classification.publish_version ? `<div class="text-[11px] text-slate-400">Version ${esc(item.classification.publish_version)}</div>` : ''}
                      </td>
                      <td class="px-4 py-3 text-xs font-mono text-slate-600">${esc(item.studentClaim)}</td>
                      <td class="px-4 py-3">
                        <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass(item.statusTone)}" title="${esc(item.errorDetail)}">
                          ${esc(item.status)}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-right">
                        <button type="button" class="btn-remove-item text-slate-400 hover:text-rose-600 p-1" data-id="${esc(item.id)}" title="Remove">
                          <sl-icon name="x-lg"></sl-icon>
                        </button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : ''}

        <!-- Post-import summary cards -->
        ${lastImportSummary && lastImportSummary.length > 0 ? `
          <div class="bg-white rounded-2xl border border-slate-200 shadow-xs p-5 space-y-4">
            <h2 class="font-bold text-slate-900 text-base flex items-center gap-2">
              <sl-icon name="check-circle-fill" class="text-emerald-600 text-lg"></sl-icon>
              Import results
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              ${lastImportSummary.map(res => `
                <div class="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-3">
                  <div class="flex items-start justify-between gap-2">
                    <div>
                      <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">${esc(res.type)}</span>
                      <h3 class="font-semibold text-slate-900 text-sm">${esc(res.title)}</h3>
                    </div>
                    <sl-button size="small" variant="default" href="${esc(res.link)}">Review</sl-button>
                  </div>
                  <div class="flex items-center gap-3 text-xs">
                    <span class="text-emerald-700 font-medium">✓ ${res.added} added</span>
                    ${res.duplicates ? `<span class="text-slate-500">${res.duplicates} duplicates</span>` : ''}
                    ${res.errors?.length ? `<span class="text-rose-700 font-medium">${res.errors.length} errors</span>` : ''}
                  </div>
                  ${res.errors?.length ? `
                    <ul class="text-[11px] text-rose-700 list-disc pl-4 space-y-0.5 max-h-24 overflow-y-auto">
                      ${res.errors.map(e => `<li>${esc(e.source || e)}: ${esc(e.message || e)}</li>`).join('')}
                    </ul>
                  ` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Empty state info card -->
        ${staged.length === 0 && (!lastImportSummary || lastImportSummary.length === 0) ? `
          <div class="bg-white rounded-2xl border border-slate-200 shadow-xs p-8 text-center max-w-xl mx-auto space-y-3">
            <sl-icon name="folder2-open" class="text-4xl text-slate-300 mx-auto"></sl-icon>
            <h3 class="font-semibold text-slate-800">No items staged</h3>
            <p class="text-xs text-slate-500 leading-relaxed">
              When students finish assignments or interactive videos, they hand in a <code>.kbsub</code> or <code>.kbr</code> file. Drop them here or drop a single ZIP from your LMS. Everything is decrypted with your teacher key and routed to the right assignment or gradebook column.
            </p>
          </div>
        ` : ''}
      </div>
    `;

    bindEvents();
  };

  const bindEvents = () => {
    const dropzone = container.querySelector('#inbox-dropzone');
    const fileInput = container.querySelector('#inbox-file-input');
    const browseBtn = container.querySelector('#btn-browse-files');
    const pasteBtn = container.querySelector('#btn-paste-codes');
    const checkServerBtn = container.querySelector('#btn-check-server');
    const clearBtn = container.querySelector('#btn-clear-staged');
    const importBtn = container.querySelector('#btn-import-all');

    checkServerBtn?.addEventListener('click', async () => {
      checkServerBtn.loading = true;
      try {
        const transport = await getTransport();
        if (!transport.capabilities.collectSubmissions) {
          toast.info('No relay server connected. Configure one under Backup & Storage → Connect to a school server.');
          return;
        }

        const [assignments, tasks] = await Promise.all([
          storage.table('assignments').toArray().catch(() => []),
          storage.table('tasks').toArray().catch(() => [])
        ]);
        const dropAssignments = [
          ...assignments.filter(a => a.publish?.relay?.drop_id || a.relay?.drop_id),
          ...tasks.filter(t => t.publish?.relay?.drop_id || t.relay?.drop_id)
        ];
        if (!dropAssignments.length) {
          toast.info('No assignments or tasks with an active server drop box found.');
          return;
        }

        const cursors = (await storage.getMetadata('relay_cursors')) || {};
        const newItems = [];
        let totalCount = 0;

        for (const asg of dropAssignments) {
          const dropId = asg.publish?.relay?.drop_id || asg.relay?.drop_id;
          const since = cursors[dropId] || undefined;
          try {
            const res = await transport.listDrop(dropId, { since });
            if (res.items && res.items.length) {
              let latestDate = since;
              for (const item of res.items) {
                newItems.push({
                  source: `Server: ${asg.title || dropId}`,
                  text: item.text
                });
                if (!latestDate || item.received_at > latestDate) {
                  latestDate = item.received_at;
                }
              }
              cursors[dropId] = latestDate;
              totalCount += res.items.length;
            }
          } catch (e) {
            console.warn(`Failed to query drop ${dropId}:`, e);
          }
        }

        await storage.setMetadata('relay_cursors', cursors);

        if (newItems.length > 0) {
          await classifyAndStage(newItems);
          toast.success(`Fetched ${totalCount} new submission(s) from server.`);
        } else {
          toast.info('Server checked. No new submissions.');
        }
      } catch (err) {
        toast.danger('Check server failed: ' + err.message);
      } finally {
        checkServerBtn.loading = false;
      }
    });

    // Drag and drop handlers
    if (dropzone) {
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('border-amber-500', 'bg-amber-50/50');
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('border-amber-500', 'bg-amber-50/50');
      });
      dropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropzone.classList.remove('border-amber-500', 'bg-amber-50/50');
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length) await ingestFiles(files);
      });
      dropzone.addEventListener('click', () => fileInput?.click());
    }

    browseBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length) await ingestFiles(files);
      fileInput.value = '';
    });

    pasteBtn?.addEventListener('click', () => openPasteCodesDialog());

    container.querySelector('#btn-scan-qr')?.addEventListener('click', async () => {
      const { openQrScanner } = await import('../../components/qr-handoff.js');
      let n = 0;
      await openQrScanner({
        onSubmission: (text) => classifyAndStage([{ source: `QR scan #${++n}`, text }])
      });
    });

    container.querySelector('#btn-receive-direct')?.addEventListener('click', async () => {
      const { receiveDirect } = await import('../../components/direct-transfer.js');
      const text = await receiveDirect({
        label: 'Receive a student\'s work directly',
        senderSteps: 'On the student\'s device: More ways to hand in → "Send directly to your teacher\'s device". Scan or paste the code it shows.'
      });
      if (text) await classifyAndStage([{ source: 'Direct transfer', text }]);
    });

    container.querySelector('#btn-watch-folder')?.addEventListener('click', async () => {
      if (watchDirHandle) {
        stopWatchFolder();
      } else {
        await startWatchFolder();
      }
    });

    container.querySelector('#btn-stop-watch')?.addEventListener('click', () => {
      stopWatchFolder();
    });

    const autoImportSwitch = container.querySelector('#switch-auto-import');
    autoImportSwitch?.addEventListener('sl-change', async (e) => {
      autoImport = e.target.checked;
      await storage.setMetadata('inbox_auto_import', autoImport);
      toast.info(`Inbox auto-import ${autoImport ? 'enabled' : 'disabled'}.`);
    });

    clearBtn?.addEventListener('click', () => {
      staged = [];
      render();
    });

    container.querySelectorAll('.btn-remove-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        staged = staged.filter(item => item.id !== id);
        render();
      });
    });

    importBtn?.addEventListener('click', async () => {
      await runImportAll();
    });
  };

  const openPasteCodesDialog = () => {
    const dialog = document.createElement('sl-dialog');
    dialog.label = 'Paste submission codes';
    dialog.style.setProperty('--width', '640px');
    dialog.innerHTML = `
      <div class="space-y-3">
        <p class="text-sm text-slate-600">
          Paste one or more student submission codes (<code>KBSUB1…</code>) or JSON receipts. Multiple codes can be pasted together with spaces or line breaks.
        </p>
        <sl-textarea id="inbox-pasted-text" rows="8" placeholder="KBSUB1.eyJrYnN1YiI6MS…"></sl-textarea>
      </div>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button id="btn-paste-cancel">Cancel</sl-button>
        <sl-button variant="primary" id="btn-paste-add">
          <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add to staged
        </sl-button>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    dialog.querySelector('#btn-paste-cancel').addEventListener('click', () => dialog.hide());
    dialog.querySelector('#btn-paste-add').addEventListener('click', async () => {
      const raw = dialog.querySelector('#inbox-pasted-text').value;
      const parts = splitSubmissionText(raw);
      if (!parts.length) {
        toast.warning('No codes entered.');
        return;
      }
      dialog.hide();
      const items = parts.map((part, i) => ({
        source: parts.length > 1 ? `Pasted code #${i + 1}` : 'Pasted code',
        text: part
      }));
      await classifyAndStage(items);
    });

    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target === dialog) dialog.remove();
    });
  };

  const runImportAll = async () => {
    if (!staged.length) return;

    const assignmentGroups = new Map(); // assignment_id -> array of items
    const taskGroups = new Map(); // task_id -> array of items
    const videoItems = [];
    const skippedItems = [];

    for (const item of staged) {
      if (item.classification.kind === 'assignment' && item.classification.assignment_id) {
        const aid = item.classification.assignment_id;
        if (!assignmentGroups.has(aid)) assignmentGroups.set(aid, []);
        assignmentGroups.get(aid).push(item);
      } else if (item.classification.kind === 'task' && item.classification.task_id) {
        const tid = item.classification.task_id;
        if (!taskGroups.has(tid)) taskGroups.set(tid, []);
        taskGroups.get(tid).push(item);
      } else if (item.classification.kind === 'video_receipt' || item.classification.kind === 'legacy_receipt') {
        videoItems.push(item);
      } else {
        skippedItems.push(item);
      }
    }

    const summaries = [];

    // 1. Process assignments
    for (const [assignmentId, items] of assignmentGroups.entries()) {
      const assignment = await storage.table('assignments').get(assignmentId);
      if (!assignment) {
        summaries.push({
          type: 'Assessment',
          title: `Assessment (${assignmentId})`,
          added: 0,
          duplicates: 0,
          errors: [{ source: 'Inbox', message: 'Assessment not found in library' }],
          link: '#/assessments'
        });
        continue;
      }

      const courseId = assignment.gradebook?.course_id || assignment.class_id;
      const roster = courseId ? await storage.table('gradebook_students').where('course_id').equals(courseId).toArray().catch(() => []) : [];
      const res = await importSubmissionTexts({
        assignment,
        texts: items.map(it => ({ text: it.text, source: it.source })),
        roster,
        keys
      });

      summaries.push({
        type: 'Assessment',
        title: assignment.title || 'Assessment',
        added: res.added,
        duplicates: res.duplicates,
        errors: res.errors,
        link: `#/assessments/submissions?id=${assignment.id}`
      });
    }

    // 1b. Process tasks (Assignments)
    for (const [taskId, items] of taskGroups.entries()) {
      const task = await storage.table('tasks').get(taskId);
      if (!task) {
        summaries.push({
          type: 'Assignment',
          title: `Assignment (${taskId})`,
          added: 0,
          duplicates: 0,
          errors: [{ source: 'Inbox', message: 'Assignment not found in library' }],
          link: '#/assignments'
        });
        continue;
      }

      const courseId = task.gradebook?.course_id || task.class_id;
      const roster = courseId ? await storage.table('gradebook_students').where('course_id').equals(courseId).toArray().catch(() => []) : [];
      const { importTaskSubmissions } = await import('../tasks/submissions.js');

      let added = 0;
      const errors = [];

      for (const it of items) {
        const res = await importTaskSubmissions({
          text: it.text,
          task,
          teacherPrivateKey: keys.privateJwk,
          roster
        });
        added += res.imported;
        if (res.failed > 0) {
          errors.push(...res.errors.map(m => ({ source: it.source, message: m })));
        }
      }

      summaries.push({
        type: 'Assignment',
        title: task.title || 'Assignment',
        added,
        duplicates: 0,
        errors,
        link: `#/assignments/review?id=${task.id}`
      });
    }

    // 2. Process video receipts
    if (videoItems.length) {
      // Find class contexts for these receipts
      const assessmentsMap = new Map();
      for (const item of videoItems) {
        const aid = item.classification.assessment_id;
        if (aid && !assessmentsMap.has(aid)) {
          const ass = await storage.table('video_assessments').get(aid);
          if (ass) assessmentsMap.set(aid, ass);
        }
      }

      // Group video receipts by class_id
      const classGroups = new Map(); // class_id -> items
      for (const item of videoItems) {
        const ass = assessmentsMap.get(item.classification.assessment_id);
        const cid = ass?.class_id || '__no_class';
        if (!classGroups.has(cid)) classGroups.set(cid, []);
        classGroups.get(cid).push(item);
      }

      for (const [classId, items] of classGroups.entries()) {
        const course = classId !== '__no_class' ? await storage.table('gradebook_courses').get(classId) : null;
        if (!course) {
          summaries.push({
            type: 'Video Receipts',
            title: 'Interactive Videos (unlinked)',
            added: 0,
            duplicates: 0,
            errors: [{ source: 'Inbox', message: 'Video assessments must be linked to a class to record grades' }],
            link: '#/gradebook'
          });
          continue;
        }

        const [students, assignments, grades] = await Promise.all([
          storage.table('gradebook_students').where('course_id').equals(course.id).toArray().catch(() => []),
          storage.table('gradebook_assignments').where('course_id').equals(course.id).toArray().catch(() => []),
          storage.table('gradebook_grades').where('course_id').equals(course.id).toArray().catch(() => [])
        ]);

        const gradesMap = new Map();
        for (const g of grades) {
          gradesMap.set(`${g.student_id}+${g.assignment_id}`, g);
        }

        const res = await importVideoReceipts({
          texts: items.map(it => ({ source: it.source, text: it.text })),
          course,
          students,
          assignments,
          gradesMap,
          mode: 'auto',
          allowLegacy: true,
          keys
        });

        summaries.push({
          type: 'Video Receipts',
          title: course.name || 'Class Gradebook',
          added: res.imported,
          duplicates: 0,
          errors: res.problems.map(p => ({ source: 'Receipt', message: p })),
          link: `#/gradebook?class=${course.id}`
        });
      }
    }

    lastImportSummary = summaries;
    staged = []; // clear staging
    toast.success('Batch import complete!');
    render();
  };

  // Helper styling functions
  function kindBadgeClass(kind) {
    switch (kind) {
      case 'assignment': return 'bg-amber-100 text-amber-800';
      case 'video_receipt': return 'bg-blue-100 text-blue-800';
      case 'legacy_receipt': return 'bg-violet-100 text-violet-800';
      case 'kbshare': return 'bg-slate-100 text-slate-800';
      default: return 'bg-rose-100 text-rose-800';
    }
  }

  function kindLabel(kind) {
    switch (kind) {
      case 'assignment': return 'Assignment';
      case 'video_receipt': return 'Video receipt';
      case 'legacy_receipt': return 'Legacy receipt';
      case 'kbshare': return 'Shared lesson';
      default: return 'Unknown';
    }
  }

  function statusBadgeClass(tone) {
    switch (tone) {
      case 'emerald': return 'bg-emerald-50 text-emerald-700 border border-emerald-200';
      case 'amber': return 'bg-amber-50 text-amber-700 border border-amber-200';
      case 'rose': return 'bg-rose-50 text-rose-700 border border-rose-200';
      default: return 'bg-slate-50 text-slate-600 border border-slate-200';
    }
  }

  // Unpack (zip) and classify any number of files at once; archive limits surface as a toast
  async function ingestFiles(files) {
    try {
      await classifyAndStage(await expandFiles(files));
    } catch (err) {
      const reasons = {
        ZIP_TOO_LARGE: 'That archive is too large to open safely (over 100 MB unpacked).',
        ZIP_TOO_MANY_FILES: 'That archive contains too many files (over 5,000).',
        ZIP_TOO_DEEP: 'That archive nests zip files too deeply.'
      };
      console.error('Inbox import failed:', err);
      toast.danger(reasons[err.message] || 'Could not read those files. Are they KennisBoost submissions?');
      render();
    }
  }

  async function startWatchFolder() {
    try {
      if (!window.showDirectoryPicker) {
        toast.warning('Directory access is not supported by your browser.');
        return;
      }
      watchDirHandle = await window.showDirectoryPicker({ mode: 'read' });
      watchFolderName = watchDirHandle.name || 'Folder';
      seenFiles.clear();

      await checkFolder();

      if (watchInterval) clearInterval(watchInterval);
      watchInterval = setInterval(() => checkFolder(), 4000);
      toast.info(`Now watching folder "${watchFolderName}".`);
      render();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Failed to watch folder:', err);
        toast.danger('Could not watch folder: ' + err.message);
      }
    }
  }

  function stopWatchFolder() {
    if (watchInterval) clearInterval(watchInterval);
    watchInterval = null;
    watchDirHandle = null;
    watchFolderName = '';
    toast.info('Stopped watching folder.');
    render();
  }

  async function checkFolder() {
    if (!watchDirHandle) return;
    try {
      const newFiles = [];
      for await (const entry of watchDirHandle.values()) {
        if (entry.kind === 'file') {
          const name = entry.name.toLowerCase();
          if (name.endsWith('.kbsub') || name.endsWith('.kbsub.html') || name.endsWith('.kbr') || name.endsWith('.zip') || name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.json') || name.endsWith('.txt')) {
            const file = await entry.getFile();
            const sig = `${entry.name}:${file.lastModified}:${file.size}`;
            if (!seenFiles.has(sig)) {
              seenFiles.add(sig);
              newFiles.push(file);
            }
          }
        }
      }

      if (newFiles.length > 0) {
        const expanded = await expandFiles(newFiles);
        if (expanded.length > 0) {
          const prevStagedCount = staged.length;
          await classifyAndStage(expanded);
          if (autoImport) {
            const count = staged.length - prevStagedCount;
            await runImportAll();
            toast.success(`Auto-imported ${count} submission(s) from Inbox folder`);
          } else {
            toast.info(`Detected ${newFiles.length} new file(s) in watched folder. Staged for review.`);
          }
        }
      }
    } catch (err) {
      console.warn('Folder polling error:', err);
    }
  }

  // Handle files passed via global drop (store.getState('inboxDrop'))
  const dropped = store.getState('inboxDrop');
  if (dropped) {
    store.setState('inboxDrop', null);
    await ingestFiles(dropped);
  } else {
    render();
  }

  return () => {
    if (watchInterval) clearInterval(watchInterval);
  };
}

export default renderInboxView;
