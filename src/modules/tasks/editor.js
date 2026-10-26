import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { generateUUID } from '../../utils/uuid.js';
import { syncContentClassLink } from '../gradebook/bridge.js';
import { setDue, getDue } from '../../core/due-dates.js';
import { isCdnUploadConfigured } from '../../core/transport.js';
import { RichTextEditor } from '../../components/rich-text-editor.js';
import { openTaskPublishDialog } from './publish.js';
import { createBlankTask } from './index.js';

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

export function resolveTaskCourseId(task) {
  if (!task) return null;
  return task.gradebook?.course_id || task.class_id || null;
}

export function syncTaskCourseId(task, courseId) {
  if (!task) return;
  const cid = courseId || null;
  task.class_id = cid;
  task.gradebook = task.gradebook || {};
  task.gradebook.course_id = cid;
}

/**
 * Assignment Editor (route #/assignments/create?id=)
 * @param {object} task
 * @param {object} router
 * @param {HTMLElement} container
 */
export async function renderTaskEditor(task, router, container) {
  const t = task || createBlankTask();

  const currentCourseId = resolveTaskCourseId(t);
  syncTaskCourseId(t, currentCourseId);

  t.submission_types = {
    text: { enabled: true },
    code: { enabled: false, languages: ['python', 'javascript'], default_language: 'python', filename_hint: 'solution.py' },
    code_files: { enabled: false, accept: ['.py', '.js', '.html', '.css', '.java', '.cpp', '.sql'], max_files: 5 },
    files: { enabled: false, accept: ['.pdf', '.png', '.jpg', '.jpeg', '.zip'], max_files: 3, max_mb: 25 },
    drawing: { enabled: false },
    ...(t.submission_types || {})
  };

  t.grading = {
    scoring: 'points',
    max_points: 100,
    rubric_id: null,
    standard_ids: [],
    ...(t.grading || {})
  };

  t.settings = {
    due_date: '',
    due_time: '',
    require_access_code: true,
    allow_resubmit: true,
    release_feedback_immediately: true,
    ...(t.settings || {})
  };

  // Sync existing due date if set in due-dates store
  try {
    const due = await getDue('task', t.id);
    if (due.date && !t.settings.due_date) t.settings.due_date = due.date;
    if (due.time && !t.settings.due_time) t.settings.due_time = due.time;
  } catch (_) {}

  const [courses, rubrics, cdnConfigured, submissionCount] = await Promise.all([
    storage.table('gradebook_courses').toArray().catch(() => []),
    storage.table('gradebook_rubrics').toArray().catch(() => []),
    isCdnUploadConfigured(),
    storage.table('task_submissions').where('task_id').equals(t.id).count().catch(() => 0)
  ]);

  let saveTimer = null;
  const setSaveState = (text) => {
    const el = container.querySelector('#task-save-state');
    if (el) el.textContent = text;
  };

  const save = (immediate = false) => {
    clearTimeout(saveTimer);
    setSaveState('Saving…');
    const run = async () => {
      t.updated_at = new Date().toISOString();
      await storage.table('tasks').put(JSON.parse(JSON.stringify(t)));
      setSaveState('Saved');
      updateSummary();
    };
    if (immediate) return run();
    saveTimer = setTimeout(run, 400);
  };

  const updateSummary = () => {
    const sumEl = container.querySelector('#task-summary');
    if (!sumEl) return;
    const types = [];
    if (t.submission_types.text?.enabled) types.push('Text');
    if (t.submission_types.code?.enabled) types.push('Code');
    if (t.submission_types.code_files?.enabled) types.push('Code files');
    if (t.submission_types.files?.enabled) types.push('Files');
    if (t.submission_types.drawing?.enabled) types.push('Drawing');
    const typeStr = types.length ? types.join(', ') : 'None enabled';
    const ptsStr = t.grading.scoring === 'proficiency' ? 'Proficiency' : `${t.grading.max_points ?? 100} pts`;
    sumEl.textContent = `${typeStr} • ${ptsStr}${submissionCount ? ` • ${submissionCount} submitted` : ''}`;
  };

  container.innerHTML = `
    <div class="space-y-6 max-w-7xl mx-auto pb-16">
      <!-- Header -->
      <div class="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
        <div class="flex items-center gap-3 min-w-0">
          <sl-button size="small" id="task-back-btn"><sl-icon slot="prefix" name="arrow-left"></sl-icon> Assignments</sl-button>
          <div class="min-w-0">
            <h1 class="font-bold text-slate-900 text-lg truncate" id="task-title-display">${esc(t.title || 'Untitled assignment')}</h1>
            <p class="text-xs text-slate-500" id="task-summary"></p>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-xs text-slate-400 mr-1" id="task-save-state" aria-live="polite">Saved</span>
          <sl-button size="small" id="task-preview-btn"><sl-icon slot="prefix" name="eye"></sl-icon> Preview</sl-button>
          <sl-button size="small" id="task-review-btn"><sl-icon slot="prefix" name="inbox"></sl-icon> Submissions (${submissionCount})</sl-button>
          <sl-button size="small" variant="primary" id="task-publish-btn"><sl-icon slot="prefix" name="send"></sl-icon> Publish</sl-button>
        </div>
      </div>

      <!-- Main Layout: 2 Columns on desktop -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <!-- Left: Prompt, Description & Submission Types (2 cols) -->
        <div class="lg:col-span-2 space-y-6">
          <!-- Title & Prompt Card -->
          <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-4">
            <h2 class="text-sm font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-2">
              <sl-icon name="pencil" class="text-slate-400"></sl-icon> Assignment Details
            </h2>
            <sl-input id="task-title-input" label="Title" value="${esc(t.title)}" placeholder="Assignment title..." size="medium"></sl-input>

            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700 block">Instructions & Description</label>
              <div id="task-description-editor-mount"></div>
              <p class="text-xs text-slate-400">Supports Markdown, KaTeX math expressions (\`$...$\`, \`$$...$$\`), and chemical equations.</p>
            </div>
          </div>

          <!-- Submission Types Section -->
          <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-4">
            <div class="flex items-center justify-between">
              <h2 class="text-sm font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-2">
                <sl-icon name="ui-checks-grid" class="text-slate-400"></sl-icon> Allowed Submission Types
              </h2>
              <span class="text-xs text-slate-400">Students can submit any enabled type</span>
            </div>

            <!-- Type 1: Text -->
            <div class="p-4 rounded-xl border ${t.submission_types.text?.enabled ? 'border-blue-200 bg-blue-50/30' : 'border-slate-200 bg-slate-50/50'} space-y-2">
              <div class="flex items-center justify-between">
                <div>
                  <strong class="text-sm text-slate-800">Rich Text & STEM Response</strong>
                  <p class="text-xs text-slate-500">Students type answers directly with formatting, math, and chemistry.</p>
                </div>
                <sl-switch id="task-type-text-toggle" ${t.submission_types.text?.enabled ? 'checked' : ''}></sl-switch>
              </div>
            </div>

            <!-- Type 2: In-App Code Editor -->
            <div class="p-4 rounded-xl border ${t.submission_types.code?.enabled ? 'border-blue-200 bg-blue-50/30' : 'border-slate-200 bg-slate-50/50'} space-y-3">
              <div class="flex items-center justify-between">
                <div>
                  <strong class="text-sm text-slate-800">In-App Code Editor</strong>
                  <p class="text-xs text-slate-500">Full in-browser CodeMirror editor with syntax highlighting and file tabs.</p>
                </div>
                <sl-switch id="task-type-code-toggle" ${t.submission_types.code?.enabled ? 'checked' : ''}></sl-switch>
              </div>

              <div id="task-code-opts" class="${t.submission_types.code?.enabled ? '' : 'hidden'} pt-2 border-t border-slate-200/60 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <sl-select id="task-code-default-lang" label="Default Language" size="small" value="${esc(t.submission_types.code?.default_language || 'python')}">
                  <sl-option value="python">Python</sl-option>
                  <sl-option value="javascript">JavaScript</sl-option>
                  <sl-option value="java">Java</sl-option>
                  <sl-option value="cpp">C++</sl-option>
                  <sl-option value="html">HTML</sl-option>
                  <sl-option value="css">CSS</sl-option>
                  <sl-option value="sql">SQL</sl-option>
                </sl-select>
                <sl-input id="task-code-file-hint" label="Initial File Name" size="small" value="${esc(t.submission_types.code?.filename_hint || 'solution.py')}"></sl-input>
              </div>
            </div>

            <!-- Type 3: Drawing / Sketch -->
            <div class="p-4 rounded-xl border ${t.submission_types.drawing?.enabled ? 'border-blue-200 bg-blue-50/30' : 'border-slate-200 bg-slate-50/50'} space-y-2">
              <div class="flex items-center justify-between">
                <div>
                  <strong class="text-sm text-slate-800">Vector Drawing & Diagram Board</strong>
                  <p class="text-xs text-slate-500">Interactive whiteboard for sketching diagrams, math work, and hand-drawn annotations.</p>
                </div>
                <sl-switch id="task-type-drawing-toggle" ${t.submission_types.drawing?.enabled ? 'checked' : ''}></sl-switch>
              </div>
            </div>

            <!-- Type 4: File Attachments (Requires CDN) -->
            <div class="p-4 rounded-xl border ${t.submission_types.files?.enabled ? 'border-blue-200 bg-blue-50/30' : 'border-slate-200 bg-slate-50/50'} space-y-3">
              <div class="flex items-center justify-between">
                <div>
                  <div class="flex items-center gap-2">
                    <strong class="text-sm text-slate-800">File Attachments</strong>
                    ${!cdnConfigured ? `<sl-badge variant="neutral" pill size="small">Requires CDN</sl-badge>` : ''}
                  </div>
                  <p class="text-xs text-slate-500">Documents, images, or archives uploaded with client-side encryption.</p>
                </div>
                <sl-switch id="task-type-files-toggle" ${t.submission_types.files?.enabled ? 'checked' : ''} ${!cdnConfigured ? 'disabled' : ''}></sl-switch>
              </div>

              ${!cdnConfigured ? `
                <div class="p-2.5 bg-amber-50 rounded-lg text-xs text-amber-800 flex items-center gap-2">
                  <sl-icon name="info-circle" class="text-amber-600 flex-shrink-0"></sl-icon>
                  <span>Generic file attachments require a connected school relay with CDN storage configured.</span>
                </div>
              ` : `
                <div id="task-files-opts" class="${t.submission_types.files?.enabled ? '' : 'hidden'} pt-2 border-t border-slate-200/60 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <sl-input id="task-files-accept" label="Accepted Extensions" size="small" value="${esc((t.submission_types.files?.accept || []).join(', '))}" help-text="Comma separated, e.g. .pdf, .png, .zip"></sl-input>
                  <sl-input id="task-files-max" label="Max Files" type="number" min="1" max="10" size="small" value="${esc(t.submission_types.files?.max_files || 3)}"></sl-input>
                </div>
              `}
            </div>
          </div>
        </div>

        <!-- Right: Settings & Gradebook Integration (1 col) -->
        <div class="space-y-6">
          <!-- Class & Gradebook Card -->
          <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-4">
            <h2 class="text-sm font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-2">
              <sl-icon name="mortarboard" class="text-slate-400"></sl-icon> Class & Gradebook
            </h2>

            <sl-select id="task-class-select" label="Linked Class" size="small" value="${esc(currentCourseId || '')}" clearable>
              <sl-option value="">None (Standalone)</sl-option>
              ${courses.map(c => `<sl-option value="${esc(c.id)}">${esc(c.name || 'Untitled')}${c.section ? ` (${esc(c.section)})` : ''}</sl-option>`).join('')}
            </sl-select>

            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700 block">Grading Scale</label>
              <div class="flex items-center gap-4 text-xs text-slate-700 pt-1">
                <sl-radio-group id="task-scoring-radio" value="${esc(t.grading.scoring || 'points')}">
                  <sl-radio-button value="points" size="small">Points</sl-radio-button>
                  <sl-radio-button value="proficiency" size="small">Proficiency</sl-radio-button>
                </sl-radio-group>
              </div>
            </div>

            <div id="task-points-container" class="${t.grading.scoring === 'proficiency' ? 'hidden' : ''}">
              <sl-input id="task-max-points" label="Max Points" type="number" min="1" max="1000" size="small" value="${esc(t.grading.max_points ?? 100)}"></sl-input>
            </div>

            <sl-select id="task-rubric-select" label="Grading Rubric (optional)" size="small" value="${esc(t.grading.rubric_id || '')}" clearable>
              <sl-option value="">No rubric</sl-option>
              ${rubrics.map(r => `<sl-option value="${esc(r.id)}">${esc(r.title || 'Untitled rubric')}</sl-option>`).join('')}
            </sl-select>

            <!-- Standards Multi-Select Mount -->
            <div id="task-standards-mount" class="space-y-1.5"></div>
          </div>

          <!-- Schedule & Options Card -->
          <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-4">
            <h2 class="text-sm font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-2">
              <sl-icon name="calendar3" class="text-slate-400"></sl-icon> Schedule & Hand-in
            </h2>

            <div class="grid grid-cols-2 gap-3">
              <sl-input id="task-due-date" label="Due Date" type="date" size="small" value="${esc(t.settings.due_date || '')}"></sl-input>
              <sl-input id="task-due-time" label="Due Time" type="time" size="small" value="${esc(t.settings.due_time || '')}"></sl-input>
            </div>

            <div class="space-y-2 pt-2 border-t border-slate-100">
              <sl-checkbox id="task-require-code" ${t.settings.require_access_code ? 'checked' : ''} size="small">
                Require student access code
              </sl-checkbox>
              <sl-checkbox id="task-allow-resubmit" ${t.settings.allow_resubmit !== false ? 'checked' : ''} size="small">
                Allow resubmission
              </sl-checkbox>
              <sl-checkbox id="task-release-feedback" ${t.settings.release_feedback_immediately ? 'checked' : ''} size="small">
                Release feedback immediately
              </sl-checkbox>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Mount RichTextEditor for description
  const descMount = container.querySelector('#task-description-editor-mount');
  const richEditor = new RichTextEditor({
    initialValue: t.description || '',
    placeholder: 'Write instructions, rubric details, or problem statement...',
    minHeight: '180px',
    onChange: (val) => {
      t.description = val;
      save();
    }
  });
  descMount.appendChild(richEditor.element);

  // Wire header buttons
  container.querySelector('#task-back-btn').addEventListener('click', () => {
    router.navigate('#/assignments');
  });

  container.querySelector('#task-preview-btn').addEventListener('click', () => {
    save(true);
    router.navigate(`#/assignments/work?id=${t.id}&preview=true`);
  });

  container.querySelector('#task-review-btn').addEventListener('click', () => {
    save(true);
    router.navigate(`#/assignments/review?id=${t.id}`);
  });

  container.querySelector('#task-publish-btn').addEventListener('click', () => {
    save(true);
    openTaskPublishDialog(t, {
      onPublished: () => {
        save(true);
      }
    });
  });

  // Wire Title
  const titleInput = container.querySelector('#task-title-input');
  titleInput.addEventListener('sl-input', () => {
    t.title = titleInput.value.trim();
    const disp = container.querySelector('#task-title-display');
    if (disp) disp.textContent = t.title || 'Untitled assignment';
    save();
  });

  // Wire Submission Types
  const textToggle = container.querySelector('#task-type-text-toggle');
  textToggle.addEventListener('sl-change', () => {
    t.submission_types.text.enabled = textToggle.checked;
    save();
  });

  const codeToggle = container.querySelector('#task-type-code-toggle');
  const codeOpts = container.querySelector('#task-code-opts');
  codeToggle.addEventListener('sl-change', () => {
    t.submission_types.code.enabled = codeToggle.checked;
    if (codeOpts) codeOpts.classList.toggle('hidden', !codeToggle.checked);
    save();
  });

  const codeLangSelect = container.querySelector('#task-code-default-lang');
  if (codeLangSelect) {
    codeLangSelect.addEventListener('sl-change', () => {
      t.submission_types.code.default_language = codeLangSelect.value;
      save();
    });
  }

  const codeHintInput = container.querySelector('#task-code-file-hint');
  if (codeHintInput) {
    codeHintInput.addEventListener('sl-input', () => {
      t.submission_types.code.filename_hint = codeHintInput.value.trim();
      save();
    });
  }

  const drawToggle = container.querySelector('#task-type-drawing-toggle');
  drawToggle.addEventListener('sl-change', () => {
    t.submission_types.drawing.enabled = drawToggle.checked;
    save();
  });

  const filesToggle = container.querySelector('#task-type-files-toggle');
  const filesOpts = container.querySelector('#task-files-opts');
  if (filesToggle) {
    filesToggle.addEventListener('sl-change', () => {
      t.submission_types.files.enabled = filesToggle.checked;
      if (filesOpts) filesOpts.classList.toggle('hidden', !filesToggle.checked);
      save();
    });
  }

  const filesAcceptInput = container.querySelector('#task-files-accept');
  if (filesAcceptInput) {
    filesAcceptInput.addEventListener('sl-input', () => {
      const arr = filesAcceptInput.value.split(',').map(s => s.trim()).filter(Boolean);
      t.submission_types.files.accept = arr;
      save();
    });
  }

  const filesMaxInput = container.querySelector('#task-files-max');
  if (filesMaxInput) {
    filesMaxInput.addEventListener('sl-input', () => {
      const n = parseInt(filesMaxInput.value, 10);
      if (!isNaN(n) && n > 0) t.submission_types.files.max_files = n;
      save();
    });
  }

  // Wire Class Link
  const classSelect = container.querySelector('#task-class-select');
  classSelect.addEventListener('sl-change', async () => {
    const newCourseId = classSelect.value || null;
    syncTaskCourseId(t, newCourseId);
    await syncContentClassLink(t, 'tasks', newCourseId);
    renderStandards();
    save();
  });

  // Wire Scoring
  const scoringRadio = container.querySelector('#task-scoring-radio');
  const ptsContainer = container.querySelector('#task-points-container');
  scoringRadio.addEventListener('sl-change', () => {
    t.grading.scoring = scoringRadio.value;
    if (ptsContainer) ptsContainer.classList.toggle('hidden', scoringRadio.value === 'proficiency');
    save();
  });

  const maxPtsInput = container.querySelector('#task-max-points');
  if (maxPtsInput) {
    maxPtsInput.addEventListener('sl-input', () => {
      const pts = parseFloat(maxPtsInput.value);
      if (!isNaN(pts) && pts > 0) t.grading.max_points = pts;
      save();
    });
  }

  // Wire Rubric
  const rubricSelect = container.querySelector('#task-rubric-select');
  if (rubricSelect) {
    rubricSelect.addEventListener('sl-change', () => {
      t.grading.rubric_id = rubricSelect.value || null;
      save();
    });
  }

  // Wire Schedule & Settings
  const dueDateInput = container.querySelector('#task-due-date');
  const dueTimeInput = container.querySelector('#task-due-time');
  const onDueChange = async () => {
    t.settings.due_date = dueDateInput.value || '';
    t.settings.due_time = dueTimeInput.value || '';
    await setDue('task', t.id, { date: t.settings.due_date, time: t.settings.due_time });
    save();
  };
  dueDateInput.addEventListener('sl-change', onDueChange);
  dueTimeInput.addEventListener('sl-change', onDueChange);

  container.querySelector('#task-require-code').addEventListener('sl-change', (e) => {
    t.settings.require_access_code = e.target.checked;
    save();
  });

  container.querySelector('#task-allow-resubmit').addEventListener('sl-change', (e) => {
    t.settings.allow_resubmit = e.target.checked;
    save();
  });

  container.querySelector('#task-release-feedback').addEventListener('sl-change', (e) => {
    t.settings.release_feedback_immediately = e.target.checked;
    save();
  });

  // Render course standards if class linked
  async function renderStandards() {
    const stMount = container.querySelector('#task-standards-mount');
    if (!stMount) return;
    const cid = resolveTaskCourseId(t);
    const course = courses.find(c => c.id === cid);
    if (!course) {
      stMount.innerHTML = '';
      return;
    }

    try {
      const { getStandards } = await import('../gradebook/grading-scales.js');
      const standards = getStandards(course);
      if (!standards.length) {
        stMount.innerHTML = '';
        return;
      }

      stMount.innerHTML = `
        <label class="text-xs font-semibold text-slate-700 block">Assessed Standards</label>
        <div class="max-h-36 overflow-y-auto p-2.5 rounded-xl border border-slate-200 bg-slate-50 space-y-1.5 text-xs">
          ${standards.map(s => {
            const checked = (t.grading.standard_ids || []).includes(s.id);
            return `
              <sl-checkbox value="${esc(s.id)}" class="task-std-chk block" ${checked ? 'checked' : ''} size="small">
                <strong>${esc(s.code || s.name)}</strong>: ${esc(s.description || '')}
              </sl-checkbox>
            `;
          }).join('')}
        </div>
      `;

      stMount.querySelectorAll('.task-std-chk').forEach(chk => {
        chk.addEventListener('sl-change', () => {
          const sid = chk.value;
          t.grading.standard_ids = t.grading.standard_ids || [];
          if (chk.checked) {
            if (!t.grading.standard_ids.includes(sid)) t.grading.standard_ids.push(sid);
          } else {
            t.grading.standard_ids = t.grading.standard_ids.filter(id => id !== sid);
          }
          save();
        });
      });
    } catch (_) {
      stMount.innerHTML = '';
    }
  }

  await renderStandards();
  updateSummary();
}
