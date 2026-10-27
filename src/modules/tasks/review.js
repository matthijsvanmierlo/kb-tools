import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { createCodeViewer, renderCodeWithComments } from '../../components/code-editor.js';
import { DrawBoardUI } from '../../components/draw-board-ui.js';
import { resolveMediaSrc } from '../../utils/student-media.js';
import { RichTextEditor } from '../../components/rich-text-editor.js';
import { RubricScorer } from '../gradebook/rubric-builder.js';
import { getSbgConfig, getStandards } from '../gradebook/grading-scales.js';
import {
  STATUSES,
  FEEDBACK_SNIPPETS,
  round1,
  renderStatusButtons,
  renderLevelButtons,
  renderPenaltyPreview,
  renderRubricSection,
  renderStandardsSection
} from '../gradebook/grade-widgets.js';
import { identityChip, syncTaskSubmissionsToGradebook } from './submissions.js';
import { DraftHistoryTracker } from '../../core/draft-history.js';

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));
const num = (v, fallback = 0) => esc(Sanitizer.safeNumber(v, fallback));

/**
 * Full-Page Review Platform for a single student task submission.
 */
export async function renderTaskReview(task, activeSub, allSubmissions = [], router = null, container = null) {
  if (!container) container = document.getElementById('main-content');
  if (!container) return;

  // Filter latest submissions for navigation
  const latestSubs = allSubmissions.filter(s => s.is_latest !== false);
  let currentIndex = latestSubs.findIndex(s => s.id === activeSub.id);
  if (currentIndex === -1) currentIndex = 0;

  // Ensure review object structure
  const sub = activeSub;
  if (!sub.review) {
    sub.review = {
      points: null,
      status: sub.days_late > 0 ? 'late' : 'submitted',
      rubric_eval: {},
      rubric_comments: {},
      standard_scores: {},
      standard_comments: {},
      feedback: '',
      code_comments: {},
      drawing_annotations: null,
      reviewed_at: null
    };
  }

  // Load course, standards, rubric
  const courseId = task.gradebook?.course_id || task.class_id;
  let course = null;
  let rubric = null;
  let allStandards = [];
  let sbgLevels = [];

  if (courseId) {
    course = await storage.table('gradebook_courses').get(courseId).catch(() => null);
    if (course) {
      const sbg = getSbgConfig(course);
      sbgLevels = [...(sbg.levels || [])].sort((a, b) => b.value - a.value);
      allStandards = getStandards(course);
    }
  }

  if (task.grading?.rubric_id) {
    rubric = await storage.table('gradebook_rubrics').get(task.grading.rubric_id).catch(() => null);
  }

  const alignedStandards = (task.grading?.standard_ids || [])
    .map(id => allStandards.find(s => s.id === id))
    .filter(Boolean);

  const isProficiency = task.grading?.scoring === 'proficiency';
  const maxScore = Number(task.grading?.max_points) || 100;
  const category = (course?.categories || []).find(c => c.id === task.gradebook?.category_id);
  const policy = category?.policy || {};

  // Fetch local draft process telemetry if available
  const telemetry = await DraftHistoryTracker.getProcessTelemetry(task.id, sub.student_id);

  // Extract content parts
  const content = sub.content || {};
  const textResponse = content.text_md || content.text || '';
  const rawCodeFiles = content.code_files || content.code || [];
  const codeFiles = Array.isArray(rawCodeFiles) ? rawCodeFiles : [];
  const drawingDoc = content.drawing || null;
  const attachments = Array.isArray(content.attachments) ? content.attachments : [];

  let activeCodeIndex = 0;
  let activeCodeViewer = null;
  let activeRichEditor = null;

  container.innerHTML = `
    <div class="h-[calc(100vh-4rem)] flex flex-col bg-slate-100 overflow-hidden -mx-4 -my-6 sm:-mx-6 sm:-my-6">
      <!-- Top Navigation & Header -->
      <header class="bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between flex-shrink-0 z-10">
        <div class="flex items-center gap-3 min-w-0">
          <sl-button size="small" variant="default" id="btn-back-to-subs">
            <sl-icon slot="prefix" name="arrow-left"></sl-icon> Submissions
          </sl-button>
          <div class="h-4 w-px bg-slate-300"></div>
          <div class="min-w-0">
            <h1 class="text-sm font-bold text-slate-900 truncate">${esc(task.title)}</h1>
            <p class="text-xs text-slate-500 flex items-center gap-2">
              <span>${esc(sub.student_name)} (${esc(sub.student_id)})</span>
              ${sub.days_late > 0 ? `<span class="text-amber-600 font-medium">· ${sub.days_late}d late</span>` : ''}
              ${sub.resubmitted_after_feedback ? `<span class="text-purple-600 font-medium">· Resubmitted</span>` : ''}
            </p>
          </div>
        </div>

        <!-- Student Switcher & Save -->
        <div class="flex items-center gap-2 flex-shrink-0">
          <span class="text-[11px] text-slate-400 font-mono hidden xl:inline">Hotkeys: [J] Next · [K] Prev · [⌘↵] Save</span>
          <div class="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg p-0.5 text-xs text-slate-600">
            <sl-button size="small" variant="text" id="btn-prev-student" ${currentIndex <= 0 ? 'disabled' : ''}>
              <sl-icon name="chevron-left"></sl-icon>
            </sl-button>
            <span class="px-2 font-mono">${currentIndex + 1} of ${Math.max(1, latestSubs.length)}</span>
            <sl-button size="small" variant="text" id="btn-next-student" ${currentIndex >= latestSubs.length - 1 ? 'disabled' : ''}>
              <sl-icon name="chevron-right"></sl-icon>
            </sl-button>
          </div>

          <sl-button size="small" variant="primary" id="btn-save-grade">
            <sl-icon slot="prefix" name="check-lg"></sl-icon> Save Grade
          </sl-button>
          <sl-button size="small" variant="default" id="btn-save-and-next">
            Save &amp; Next <sl-icon slot="suffix" name="arrow-right"></sl-icon>
          </sl-button>
        </div>
      </header>

      ${courseId && sub.identity === 'not_in_roster' ? `
        <div class="bg-amber-50 border-b border-amber-200 px-5 py-2 flex items-center justify-between text-xs text-amber-900 z-10 flex-shrink-0">
          <div class="flex items-center gap-2">
            <sl-icon name="exclamation-circle" class="text-amber-700"></sl-icon>
            <span>Student ID "${esc(sub.student_id)}" is not yet on this class roster.</span>
          </div>
          <sl-button size="small" id="btn-review-add-roster" variant="default">
            <sl-icon slot="prefix" name="person-plus"></sl-icon> Add to Class Roster
          </sl-button>
        </div>
      ` : ''}

      <!-- Main Dual Pane View -->
      <div class="flex-1 flex flex-col md:flex-row overflow-hidden">
        <!-- Left Pane: Student Submission Workspace -->
        <div class="flex-1 flex flex-col bg-white border-r border-slate-200 overflow-hidden">
          <!-- Submission Tabs -->
          <div class="flex items-center gap-1 px-4 pt-3 border-b border-slate-200 bg-slate-50 flex-shrink-0 overflow-x-auto" id="review-tabs">
            ${textResponse ? `
              <button type="button" class="rev-tab px-3 py-2 rounded-t-lg text-xs font-semibold border-b-2 border-indigo-600 text-indigo-700 bg-white" data-target="tab-text">
                <sl-icon name="card-text" class="mr-1"></sl-icon> Written Response
              </button>
            ` : ''}
            ${codeFiles.length ? `
              <button type="button" class="rev-tab px-3 py-2 rounded-t-lg text-xs font-semibold ${!textResponse ? 'border-b-2 border-indigo-600 text-indigo-700 bg-white' : 'text-slate-600 hover:text-slate-900'}" data-target="tab-code">
                <sl-icon name="code-slash" class="mr-1"></sl-icon> Code (${codeFiles.length})
              </button>
            ` : ''}
            ${drawingDoc ? `
              <button type="button" class="rev-tab px-3 py-2 rounded-t-lg text-xs font-semibold ${(!textResponse && !codeFiles.length) ? 'border-b-2 border-indigo-600 text-indigo-700 bg-white' : 'text-slate-600 hover:text-slate-900'}" data-target="tab-drawing">
                <sl-icon name="brush" class="mr-1"></sl-icon> Drawing
              </button>
            ` : ''}
            ${attachments.length ? `
              <button type="button" class="rev-tab px-3 py-2 rounded-t-lg text-xs font-semibold ${(!textResponse && !codeFiles.length && !drawingDoc) ? 'border-b-2 border-indigo-600 text-indigo-700 bg-white' : 'text-slate-600 hover:text-slate-900'}" data-target="tab-attachments">
                <sl-icon name="paperclip" class="mr-1"></sl-icon> Files (${attachments.length})
              </button>
            ` : ''}
          </div>

          <!-- Tab Panels Container -->
          <div class="flex-1 overflow-y-auto p-6" id="review-panels">
            <!-- 1. Written Response Panel -->
            ${textResponse ? `
              <div id="panel-tab-text" class="space-y-4">
                <div class="kb-prose bg-white border border-slate-200 rounded-xl p-5 shadow-2xs">
                  ${Sanitizer.renderSTEMMarkdown(textResponse)}
                </div>
              </div>
            ` : ''}

            <!-- 2. Code Files Panel -->
            ${codeFiles.length ? `
              <div id="panel-tab-code" class="space-y-4 ${textResponse ? 'hidden' : ''}">
                <!-- Code Sub-Tabs -->
                <div class="flex items-center gap-1 border-b border-slate-200 pb-2 overflow-x-auto" id="code-sub-tabs">
                  ${codeFiles.map((file, idx) => `
                    <button type="button" class="code-tab-btn px-3 py-1 rounded-lg text-xs font-mono ${idx === 0 ? 'bg-indigo-50 text-indigo-700 font-semibold' : 'text-slate-600 hover:bg-slate-100'}" data-code-idx="${idx}">
                      ${esc(file.filename || `file-${idx + 1}`)}
                    </button>
                  `).join('')}
                </div>

                <!-- Code Mirror Mount -->
                <div id="code-viewer-mount" class="rounded-xl border border-slate-200 overflow-hidden shadow-2xs"></div>

                <!-- Line Comments Section -->
                <div id="code-comments-section" class="space-y-2 pt-2">
                  <h3 class="text-xs font-bold text-slate-700 uppercase tracking-wider">Line Feedback Comments</h3>
                  <div id="code-comments-list" class="space-y-2"></div>
                </div>
              </div>
            ` : ''}

            <!-- 3. Drawing Panel -->
            ${drawingDoc ? `
              <div id="panel-tab-drawing" class="space-y-4 ${(!textResponse && !codeFiles.length) ? '' : 'hidden'}">
                <div class="p-3 bg-indigo-50 border border-indigo-200 rounded-xl text-xs text-indigo-900 flex items-center justify-between">
                  <span>Annotate directly on the student diagram with the red pen or highlighter tools.</span>
                  <span class="font-mono text-[11px]">Vector Overlay Mode</span>
                </div>
                <div id="review-draw-mount" class="rounded-xl border border-slate-200 overflow-hidden shadow-2xs"></div>
              </div>
            ` : ''}

            <!-- 4. Attachments Panel -->
            ${attachments.length ? `
              <div id="panel-tab-attachments" class="space-y-4 ${(!textResponse && !codeFiles.length && !drawingDoc) ? '' : 'hidden'}">
                <div class="grid grid-cols-1 gap-3" id="review-attachment-list"></div>
              </div>
            ` : ''}

            ${(!textResponse && !codeFiles.length && !drawingDoc && !attachments.length) ? `
              <div class="text-center p-12 text-slate-400 text-sm">
                No submission content found.
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Right Pane: Grading & Feedback Drawer -->
        <div class="w-full md:w-96 lg:w-[420px] bg-slate-50 border-t md:border-t-0 md:border-l border-slate-200 flex flex-col flex-shrink-0 overflow-hidden">
          <div class="p-5 flex-1 overflow-y-auto space-y-6">
            <!-- 1. Submission Status -->
            <section class="space-y-2">
              <h3 class="text-xs font-bold text-slate-700 uppercase tracking-wider">Submission Status</h3>
              ${renderStatusButtons(sub.review.status || 'submitted')}
            </section>

            <!-- 2. Score Input -->
            <section class="space-y-2 bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
              <div class="flex items-center justify-between">
                <h3 class="text-xs font-bold text-slate-700 uppercase tracking-wider">${isProficiency ? 'Proficiency Level' : 'Points Score'}</h3>
                ${sub.days_late > 0 ? `<span class="text-xs text-amber-600 font-medium">${sub.days_late} days late</span>` : ''}
              </div>

              ${!isProficiency ? `
                <div class="flex items-center gap-2">
                  <sl-input id="input-review-score" type="number" min="0" max="${maxScore}" step="0.5" value="${sub.review.points !== null ? esc(sub.review.points) : ''}" class="w-32"></sl-input>
                  <span class="text-sm font-semibold text-slate-600">/ ${maxScore} pts</span>
                </div>
                <div id="review-penalty-preview">
                  ${renderPenaltyPreview({ rawScore: sub.review.points, maxScore, status: sub.review.status, daysLate: sub.days_late, policy, assignment: task, course })}
                </div>
              ` : `
                <div class="space-y-2">
                  ${renderLevelButtons(sbgLevels, sub.review.points, 'data-single-proficiency')}
                </div>
              `}
            </section>

            <!-- 3. Rubric Scorer Section -->
            ${rubric ? `
              <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
                ${renderRubricSection({
                  rubric,
                  rubricEval: sub.review.rubric_eval || {},
                  rubricComments: sub.review.rubric_comments || {},
                  maxScore,
                  isProficiency
                })}
              </div>
            ` : ''}

            <!-- 4. Standards Evidence Section -->
            ${alignedStandards.length ? `
              <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
                ${renderStandardsSection({
                  standards: alignedStandards,
                  levels: sbgLevels,
                  standardScores: sub.review.standard_scores || {},
                  standardComments: sub.review.standard_comments || {}
                })}
              </div>
            ` : ''}

            <!-- 5. Feedback Snippets -->
            <section class="space-y-2">
              <h3 class="text-xs font-bold text-slate-700 uppercase tracking-wider">Quick Feedback Snippets</h3>
              <div class="flex flex-wrap gap-1.5">
                ${FEEDBACK_SNIPPETS.map(snip => `
                  <button type="button" class="btn-snippet px-2 py-1 rounded-md bg-white border border-slate-200 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 text-slate-600 text-[11px] text-left transition-colors truncate max-w-full" data-snip="${esc(snip)}">
                    + ${esc(snip)}
                  </button>
                `).join('')}
              </div>
            </section>

            <!-- 6. Work Process & Revision Telemetry -->
            ${telemetry?.has_telemetry ? `
              <details class="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs group" open>
                <summary class="flex items-center justify-between cursor-pointer list-none select-none">
                  <div class="flex items-center gap-2">
                    <sl-icon name="clock-history" class="text-indigo-600"></sl-icon>
                    <h3 class="text-xs font-bold text-slate-700 uppercase tracking-wider">Work Process Timeline</h3>
                  </div>
                  <span class="text-[11px] font-mono text-slate-500">${telemetry.checkpoint_count} saves · ~${telemetry.active_minutes}m</span>
                </summary>
                <div class="mt-3 pt-3 border-t border-slate-100 space-y-2.5 text-xs text-slate-600">
                  <div class="grid grid-cols-2 gap-2 text-center">
                    <div class="bg-slate-50 rounded-lg p-2 border border-slate-100">
                      <div class="font-bold text-slate-800 text-sm">~${telemetry.active_minutes} min</div>
                      <div class="text-[10px] text-slate-400 uppercase">Active Time</div>
                    </div>
                    <div class="bg-slate-50 rounded-lg p-2 border border-slate-100">
                      <div class="font-bold text-slate-800 text-sm">${telemetry.checkpoint_count}</div>
                      <div class="text-[10px] text-slate-400 uppercase">Revisions</div>
                    </div>
                  </div>
                  ${telemetry.paste_count > 0 ? `
                    <div class="flex items-center justify-between text-[11px] text-slate-500 px-1">
                      <span>Paste Events: <strong>${telemetry.paste_count}</strong></span>
                      <span>Max Paste: <strong>${telemetry.largest_paste} chars</strong></span>
                    </div>
                  ` : `
                    <div class="text-[11px] text-emerald-600 px-1">Continuous typing (0 paste bursts detected)</div>
                  `}
                  <div class="text-[10px] text-slate-400 italic">
                    Local revision milestones. No invasive surveillance or keyloggers.
                  </div>
                </div>
              </details>
            ` : ''}

            <!-- 7. Voice Feedback Recorder -->
            <section class="space-y-2 bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-1.5 text-xs font-bold text-slate-700 uppercase tracking-wider">
                  <sl-icon name="mic" class="text-indigo-600"></sl-icon>
                  <span>Voice Feedback</span>
                </div>
                <div id="voice-timer" class="text-[11px] font-mono text-rose-600 font-semibold hidden">00:00</div>
              </div>
              <div id="voice-recorder-controls" class="flex items-center gap-2">
                <sl-button size="small" id="btn-record-voice" variant="default">
                  <sl-icon slot="prefix" name="mic-fill"></sl-icon> Record Clip
                </sl-button>
                <sl-button size="small" id="btn-stop-voice" variant="danger" class="hidden">
                  <sl-icon slot="prefix" name="stop-fill"></sl-icon> Stop Recording
                </sl-button>
                <sl-button size="small" id="btn-delete-voice" variant="text" class="text-rose-600 ${sub.review.audio_note ? '' : 'hidden'}">
                  <sl-icon slot="prefix" name="trash"></sl-icon> Remove Clip
                </sl-button>
              </div>
              <div id="voice-audio-preview" class="${sub.review.audio_note ? '' : 'hidden'}">
                <audio controls src="${sub.review.audio_note || ''}" class="w-full h-8 mt-1.5"></audio>
              </div>
            </section>

            <!-- 8. Overall Feedback Editor -->
            <section class="space-y-2">
              <h3 class="text-xs font-bold text-slate-700 uppercase tracking-wider">Teacher Feedback</h3>
              <div id="review-feedback-mount"></div>
            </section>
          </div>
        </div>
      </div>
    </div>
  `;

  // ---------------------------------------------------------------------------
  // Tab Switching
  // ---------------------------------------------------------------------------
  container.querySelectorAll('.rev-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.rev-tab').forEach(t => {
        t.className = 'rev-tab px-3 py-2 rounded-t-lg text-xs font-semibold text-slate-600 hover:text-slate-900';
      });
      tab.className = 'rev-tab px-3 py-2 rounded-t-lg text-xs font-semibold border-b-2 border-indigo-600 text-indigo-700 bg-white';

      const targetId = tab.dataset.target;
      ['tab-text', 'tab-code', 'tab-drawing', 'tab-attachments'].forEach(id => {
        const p = container.querySelector(`#panel-${id}`);
        if (p) {
          if (id === targetId) p.classList.remove('hidden');
          else p.classList.add('hidden');
        }
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Code Viewer & Line Comments
  // ---------------------------------------------------------------------------
  if (codeFiles.length) {
    const renderActiveCodeFile = () => {
      const mount = container.querySelector('#code-viewer-mount');
      if (!mount) return;
      mount.innerHTML = '';
      if (activeCodeViewer) {
        activeCodeViewer.destroy();
        activeCodeViewer = null;
      }

      const file = codeFiles[activeCodeIndex];
      if (!file) return;

      const fileId = file.id || file.filename || `f-${activeCodeIndex}`;
      const commentsMap = sub.review.code_comments[fileId] || [];

      activeCodeViewer = createCodeViewer(mount, {
        value: file.body || '',
        language: file.language || 'python',
        comments: commentsMap,
        onLineClick: (lineNo) => {
          const text = prompt(`Add comment on line ${lineNo}:`);
          if (text && text.trim()) {
            if (!sub.review.code_comments[fileId]) sub.review.code_comments[fileId] = [];
            sub.review.code_comments[fileId].push({
              id: 'c_' + Date.now(),
              line: lineNo,
              comment: text.trim(),
              created_at: new Date().toISOString()
            });
            renderActiveCodeFile();
            renderCommentsList();
          }
        }
      });

      renderCommentsList();
    };

    const renderCommentsList = () => {
      const listMount = container.querySelector('#code-comments-list');
      if (!listMount) return;

      const file = codeFiles[activeCodeIndex];
      const fileId = file?.id || file?.filename || `f-${activeCodeIndex}`;
      const comments = sub.review.code_comments[fileId] || [];

      if (!comments.length) {
        listMount.innerHTML = '<p class="text-xs text-slate-400 italic">No line comments yet. Click any line number in the gutter to add feedback.</p>';
        return;
      }

      listMount.innerHTML = comments.map((c, cIdx) => `
        <div class="p-2.5 rounded-lg border border-slate-200 bg-white text-xs flex items-start justify-between gap-2 shadow-2xs">
          <div>
            <span class="inline-block px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-mono font-semibold text-[11px] mb-1">Line ${c.line}</span>
            <p class="text-slate-800">${esc(c.comment)}</p>
          </div>
          <button type="button" class="del-comment-btn text-slate-400 hover:text-red-500 flex-shrink-0" data-cidx="${cIdx}" title="Delete comment">
            <sl-icon name="trash"></sl-icon>
          </button>
        </div>
      `).join('');

      listMount.querySelectorAll('.del-comment-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const cIdx = parseInt(btn.dataset.cidx, 10);
          comments.splice(cIdx, 1);
          renderActiveCodeFile();
          renderCommentsList();
        });
      });
    };

    container.querySelectorAll('.code-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.code-tab-btn').forEach(b => {
          b.className = 'code-tab-btn px-3 py-1 rounded-lg text-xs font-mono text-slate-600 hover:bg-slate-100';
        });
        btn.className = 'code-tab-btn px-3 py-1 rounded-lg text-xs font-mono bg-indigo-50 text-indigo-700 font-semibold';
        activeCodeIndex = parseInt(btn.dataset.codeIdx, 10);
        renderActiveCodeFile();
      });
    });

    renderActiveCodeFile();
  }

  // ---------------------------------------------------------------------------
  // Drawing Annotation Mode
  // ---------------------------------------------------------------------------
  if (drawingDoc) {
    const drawMount = container.querySelector('#review-draw-mount');
    if (drawMount) {
      DrawBoardUI.mount(drawMount, {
        baseDoc: drawingDoc,
        doc: sub.review.drawing_annotations || { version: 2, width: drawingDoc.width || 1000, height: drawingDoc.height || 600, elements: [] },
        color: '#dc2626', // Default red annotation pen
        size: 3,
        onChange: (annotations) => {
          sub.review.drawing_annotations = annotations;
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Attachments Preview
  // ---------------------------------------------------------------------------
  if (attachments.length) {
    const listMount = container.querySelector('#review-attachment-list');
    if (listMount) {
      for (const att of attachments) {
        const item = document.createElement('div');
        item.className = 'p-4 rounded-xl border border-slate-200 bg-white space-y-3 shadow-2xs';

        const isImg = (att.mime || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(att.name || '');
        const isPdf = (att.mime || '') === 'application/pdf' || /\.pdf$/i.test(att.name || '');

        item.innerHTML = `
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 truncate">
              <sl-icon name="${isImg ? 'image' : (isPdf ? 'file-earmark-pdf' : 'file-earmark')}" class="text-indigo-600 text-lg"></sl-icon>
              <strong class="text-xs text-slate-800 truncate">${esc(att.name)}</strong>
              <span class="text-[11px] text-slate-400">(${Math.round(att.size / 1024)} KB)</span>
            </div>
            <a href="#" class="download-link text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1" target="_blank" rel="noopener">
              <sl-icon name="download"></sl-icon> Open / Download
            </a>
          </div>
          <div class="preview-area border border-slate-100 rounded-lg overflow-hidden bg-slate-50 flex items-center justify-center min-h-[120px]">
            <span class="text-xs text-slate-400">Loading preview...</span>
          </div>
        `;
        listMount.appendChild(item);

        resolveMediaSrc(att.ref || att.inline_data_b64 || att.dataUrl).then(srcUrl => {
          const dl = item.querySelector('.download-link');
          dl.href = srcUrl;
          if (!isImg && !isPdf) dl.download = att.name;

          const prev = item.querySelector('.preview-area');
          if (isImg) {
            prev.innerHTML = `<img src="${srcUrl}" alt="${esc(att.name)}" class="max-h-96 object-contain rounded-lg">`;
          } else if (isPdf) {
            prev.innerHTML = `<iframe src="${srcUrl}" class="w-full h-96 border-0 rounded-lg"></iframe>`;
          } else {
            prev.innerHTML = `<p class="text-xs text-slate-400">File ready for download.</p>`;
          }
        }).catch(err => {
          console.error(err);
          const prev = item.querySelector('.preview-area');
          prev.innerHTML = `<span class="text-xs text-rose-500">Failed to load preview</span>`;
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Right Pane Grading Bindings
  // ---------------------------------------------------------------------------
  // Status buttons
  container.querySelectorAll('.kb-status-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sub.review.status = btn.dataset.status;
      container.querySelectorAll('.kb-status-btn').forEach(b => {
        b.className = 'kb-status-btn flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors border-slate-200 text-slate-600 hover:bg-slate-50';
      });
      const stObj = STATUSES.find(s => s.value === sub.review.status);
      if (stObj) btn.className = `kb-status-btn flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${stObj.active}`;
    });
  });

  // Score input
  const scoreInput = container.querySelector('#input-review-score');
  if (scoreInput) {
    scoreInput.addEventListener('sl-input', () => {
      const val = parseFloat(scoreInput.value);
      sub.review.points = isNaN(val) ? null : val;
      const prevEl = container.querySelector('#review-penalty-preview');
      if (prevEl) {
        prevEl.innerHTML = renderPenaltyPreview({
          rawScore: sub.review.points,
          maxScore,
          status: sub.review.status,
          daysLate: sub.days_late,
          policy,
          assignment: task,
          course
        });
      }
    });
  }

  // Single proficiency buttons
  container.querySelectorAll('[data-single-proficiency]').forEach(btn => {
    btn.addEventListener('click', () => {
      const levelVal = parseFloat(btn.dataset.level);
      sub.review.points = levelVal;
      container.querySelectorAll('[data-single-proficiency]').forEach(b => {
        b.classList.remove('text-white', 'border-transparent');
        b.classList.add('bg-white', 'border-slate-200', 'text-slate-700');
        b.style.backgroundColor = '';
      });
      const lvl = sbgLevels.find(l => Number(l.value) === levelVal);
      btn.classList.add('text-white', 'border-transparent');
      btn.classList.remove('bg-white', 'border-slate-200', 'text-slate-700');
      if (lvl) btn.style.backgroundColor = Sanitizer.safeColor(lvl.color);
    });
  });

  // Rubric picks
  container.querySelectorAll('.kb-rubric-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      const crit = btn.dataset.crit;
      const tier = btn.dataset.tier;
      if (!sub.review.rubric_eval) sub.review.rubric_eval = {};

      if (sub.review.rubric_eval[crit] === tier) {
        delete sub.review.rubric_eval[crit];
      } else {
        sub.review.rubric_eval[crit] = tier;
      }

      // Re-calculate scaled score
      if (rubric) {
        const sc = RubricScorer.calculateScore(rubric, sub.review.rubric_eval);
        if (sc.totalPossible > 0) {
          const scaled = round1((sc.totalEarned / sc.totalPossible) * maxScore);
          sub.review.points = scaled;
          if (scoreInput) scoreInput.value = scaled;
        }
      }

      // Re-render rubric section
      const rContainer = btn.closest('.bg-white');
      if (rContainer && rubric) {
        rContainer.innerHTML = renderRubricSection({
          rubric,
          rubricEval: sub.review.rubric_eval,
          rubricComments: sub.review.rubric_comments || {},
          maxScore,
          isProficiency
        });
        bindRubricPicks(rContainer);
      }
    });
  });

  function bindRubricPicks(rContainer) {
    rContainer.querySelectorAll('.kb-rubric-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        const crit = btn.dataset.crit;
        const tier = btn.dataset.tier;
        sub.review.rubric_eval[crit] = tier;
        const sc = RubricScorer.calculateScore(rubric, sub.review.rubric_eval);
        if (sc.totalPossible > 0) {
          const scaled = round1((sc.totalEarned / sc.totalPossible) * maxScore);
          sub.review.points = scaled;
          if (scoreInput) scoreInput.value = scaled;
        }
        rContainer.innerHTML = renderRubricSection({
          rubric,
          rubricEval: sub.review.rubric_eval,
          rubricComments: sub.review.rubric_comments || {},
          maxScore,
          isProficiency
        });
        bindRubricPicks(rContainer);
      });
    });
    rContainer.querySelectorAll('.kb-rubric-comment').forEach(inp => {
      inp.addEventListener('sl-input', () => {
        if (!sub.review.rubric_comments) sub.review.rubric_comments = {};
        sub.review.rubric_comments[inp.dataset.crit] = inp.value;
      });
    });
  }

  // Standards buttons
  container.querySelectorAll('[data-std]').forEach(btn => {
    btn.addEventListener('click', () => {
      const stdId = btn.dataset.std;
      const level = parseFloat(btn.dataset.level);
      if (!sub.review.standard_scores) sub.review.standard_scores = {};
      sub.review.standard_scores[stdId] = level;

      const group = btn.closest('[role="radiogroup"]');
      if (group) {
        group.querySelectorAll('.kb-level-btn').forEach(b => {
          b.classList.remove('text-white', 'border-transparent');
          b.classList.add('bg-white', 'border-slate-200', 'text-slate-700');
          b.style.backgroundColor = '';
        });
        const lvl = sbgLevels.find(l => Number(l.value) === level);
        btn.classList.add('text-white', 'border-transparent');
        btn.classList.remove('bg-white', 'border-slate-200', 'text-slate-700');
        if (lvl) btn.style.backgroundColor = Sanitizer.safeColor(lvl.color);
      }
    });
  });

  container.querySelectorAll('.kb-std-comment').forEach(inp => {
    inp.addEventListener('sl-input', () => {
      if (!sub.review.standard_comments) sub.review.standard_comments = {};
      sub.review.standard_comments[inp.dataset.std] = inp.value;
    });
  });

  // Overall Feedback Rich Text Editor
  const fbMount = container.querySelector('#review-feedback-mount');
  if (fbMount) {
    activeRichEditor = new RichTextEditor({
      initialValue: sub.review.feedback || '',
      placeholder: 'Write overall feedback for the student...',
      minHeight: '140px',
      onChange: (val) => {
        sub.review.feedback = val;
      }
    });
    fbMount.appendChild(activeRichEditor.element);
  }

  // Snippets
  container.querySelectorAll('.btn-snippet').forEach(btn => {
    btn.addEventListener('click', () => {
      const snip = btn.dataset.snip;
      if (activeRichEditor) {
        const cur = activeRichEditor.getValue();
        const next = cur ? `${cur}\n\n${snip}` : snip;
        activeRichEditor.setValue(next);
        sub.review.feedback = next;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Save & Navigation Actions
  // ---------------------------------------------------------------------------
  const saveCurrentGrade = async () => {
    sub.review.reviewed_at = new Date().toISOString();
    sub.updated_at = new Date().toISOString();
    await storage.table('task_submissions').put(sub);

    // Sync to Gradebook if class linked
    if (courseId) {
      await syncTaskSubmissionsToGradebook({
        task,
        submissions: [sub],
        course
      });
    }
  };

  const saveBtn = container.querySelector('#btn-save-grade');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.loading = true;
      try {
        await saveCurrentGrade();
        toast.success(`Saved grade for ${sub.student_name}!`);
      } catch (err) {
        console.error(err);
        toast.error('Failed to save grade: ' + err.message);
      } finally {
        saveBtn.loading = false;
      }
    });
  }

  // Add to roster button
  container.querySelector('#btn-review-add-roster')?.addEventListener('click', async () => {
    if (!courseId) return;
    const newStudent = {
      id: crypto.randomUUID(),
      course_id: courseId,
      student_id: sub.student_id,
      full_name: sub.claimed_name || sub.student_name || sub.student_id,
      access_code: sub.access_code || '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await storage.table('gradebook_students').put(newStudent);
    sub.identity = 'no_code_on_file';
    await storage.table('task_submissions').put(sub);
    toast.success(`Added ${newStudent.full_name} to class roster!`);
    await renderTaskReview(task, sub, allSubmissions, router, container);
  });

  const saveAndNextBtn = container.querySelector('#btn-save-and-next');
  if (saveAndNextBtn) {
    saveAndNextBtn.addEventListener('click', async () => {
      saveAndNextBtn.loading = true;
      try {
        await saveCurrentGrade();
        if (currentIndex < latestSubs.length - 1) {
          const nextSub = latestSubs[currentIndex + 1];
          await renderTaskReview(task, nextSub, allSubmissions, router, container);
        } else {
          toast.success('Graded all submissions!');
          const { renderTaskSubmissions } = await import('./submissions.js');
          await renderTaskSubmissions({ id: task.id }, router, container);
        }
      } catch (err) {
        toast.error('Save failed: ' + err.message);
      } finally {
        saveAndNextBtn.loading = false;
      }
    });
  }

  container.querySelector('#btn-prev-student')?.addEventListener('click', async () => {
    if (currentIndex > 0) {
      await saveCurrentGrade();
      const prevSub = latestSubs[currentIndex - 1];
      await renderTaskReview(task, prevSub, allSubmissions, router, container);
    }
  });

  container.querySelector('#btn-next-student')?.addEventListener('click', async () => {
    if (currentIndex < latestSubs.length - 1) {
      await saveCurrentGrade();
      const nextSub = latestSubs[currentIndex + 1];
      await renderTaskReview(task, nextSub, allSubmissions, router, container);
    }
  });

  container.querySelector('#btn-back-to-subs')?.addEventListener('click', async () => {
    await saveCurrentGrade();
    const { renderTaskSubmissions } = await import('./submissions.js');
    await renderTaskSubmissions({ id: task.id }, router, container);
  });

  // ---------------------------------------------------------------------------
  // Voice Feedback Recorder (MediaRecorder API)
  // ---------------------------------------------------------------------------
  let mediaRecorder = null;
  let audioChunks = [];
  let timerInterval = null;
  let secondsElapsed = 0;

  const btnRecordVoice = container.querySelector('#btn-record-voice');
  const btnStopVoice = container.querySelector('#btn-stop-voice');
  const btnDeleteVoice = container.querySelector('#btn-delete-voice');
  const voiceTimer = container.querySelector('#voice-timer');
  const audioPreview = container.querySelector('#voice-audio-preview');

  if (btnRecordVoice) {
    btnRecordVoice.addEventListener('click', async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          toast.warning('Audio recording is not supported in this browser.');
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        mediaRecorder = new MediaRecorder(stream);

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          clearInterval(timerInterval);
          voiceTimer.classList.add('hidden');
          btnStopVoice.classList.add('hidden');
          btnRecordVoice.classList.remove('hidden');

          const mimeType = mediaRecorder.mimeType || 'audio/webm';
          const audioBlob = new Blob(audioChunks, { type: mimeType });
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result;
            sub.review.audio_note = dataUrl;
            if (audioPreview) {
              audioPreview.classList.remove('hidden');
              const aud = audioPreview.querySelector('audio');
              if (aud) aud.src = dataUrl;
            }
            btnDeleteVoice?.classList.remove('hidden');
            toast.success('Voice note recorded!');
          };
          reader.readAsDataURL(audioBlob);
        };

        mediaRecorder.start();
        secondsElapsed = 0;
        voiceTimer.textContent = '00:00';
        voiceTimer.classList.remove('hidden');
        btnRecordVoice.classList.add('hidden');
        btnStopVoice.classList.remove('hidden');

        timerInterval = setInterval(() => {
          secondsElapsed++;
          const mins = String(Math.floor(secondsElapsed / 60)).padStart(2, '0');
          const secs = String(secondsElapsed % 60).padStart(2, '0');
          voiceTimer.textContent = `${mins}:${secs}`;
          if (secondsElapsed >= 90) {
            mediaRecorder.stop();
          }
        }, 1000);
      } catch (err) {
        console.error('Audio recording failed:', err);
        toast.danger('Could not access microphone: ' + err.message);
      }
    });

    btnStopVoice?.addEventListener('click', () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    });

    btnDeleteVoice?.addEventListener('click', () => {
      sub.review.audio_note = null;
      btnDeleteVoice.classList.add('hidden');
      if (audioPreview) {
        audioPreview.classList.add('hidden');
        const aud = audioPreview.querySelector('audio');
        if (aud) aud.src = '';
      }
      toast.info('Voice note removed.');
    });
  }

  // ---------------------------------------------------------------------------
  // SpeedGrader Hotkeys: J (Next), K (Prev), Cmd+Enter (Save & Next)
  // ---------------------------------------------------------------------------
  const keyHandler = (e) => {
    if (!document.body.contains(container)) {
      window.removeEventListener('keydown', keyHandler);
      return;
    }

    const activeEl = document.activeElement;
    const tag = (activeEl?.tagName || '').toLowerCase();
    const isInput = tag === 'input' || tag === 'textarea' ||
      activeEl?.isContentEditable ||
      activeEl?.closest('.cm-editor') ||
      activeEl?.closest('sl-input') ||
      activeEl?.closest('sl-textarea');

    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveAndNextBtn?.click();
      return;
    }

    if (isInput) return;

    if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowRight') {
      e.preventDefault();
      container.querySelector('#btn-next-student')?.click();
    } else if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowLeft') {
      e.preventDefault();
      container.querySelector('#btn-prev-student')?.click();
    }
  };

  window.addEventListener('keydown', keyHandler);
}
