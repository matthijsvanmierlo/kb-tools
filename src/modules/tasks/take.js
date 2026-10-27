import { storage } from '../../core/storage.js';
import { store } from '../../state/store.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { generateUUID } from '../../utils/uuid.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { checkTaskAccessCode, createTaskSubmission } from './pipeline.js';
import { buildStudentTaskPayload } from './publish-core.js';
import { RelayTransport } from '../../core/transport.js';
import { StudentLedger } from '../student/ledger.js';
import { StudentProfile } from '../../core/student-profile.js';
import { downloadClickableHtmlFile } from '../../core/html-launcher.js';
import { createCodeEditor } from '../../components/code-editor.js';
import { RichTextEditor } from '../../components/rich-text-editor.js';
import { uploadStudentFile } from '../../utils/student-media.js';
import { DrawBoardUI } from '../../components/draw-board-ui.js';
import { DraftHistoryTracker } from '../../core/draft-history.js';
import {
  prepareDrawingForSubmission,
  processUploadedCodeFile,
  compressDrawDoc
} from './media.js';

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

export const PAYLOAD_SESSION_KEY = 'kb_active_task_payload';

const safeStorage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} },
  remove(key) { try { localStorage.removeItem(key); } catch (_) {} }
};

/**
 * Resolve student task payload from params, ephemeral store, or session cache.
 */
export async function resolvePayload(params = {}) {
  // 1. Preview mode (teacher inspecting student take view)
  if (params.preview) {
    const id = params.id || (typeof params.preview === 'string' && params.preview !== 'true' ? params.preview : null);
    if (id) {
      const task = await storage.table('tasks').get(id);
      if (task) {
        const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
        const payload = await buildStudentTaskPayload(
          {
            ...task,
            publish: {
              version: task.publish?.version || 1,
              salt: task.publish?.salt || 'preview-salt'
            }
          },
          { teacherKeys: keys }
        );
        return { payload, preview: true, teacherTask: task };
      }
    }
  }

  // 2. Ephemeral data from shared URL / QR code
  const eph = store.getState('ephemeralData');
  if (eph && eph.type === 'task' && eph.payload?.kind === 'kb-task') {
    try {
      sessionStorage.setItem(PAYLOAD_SESSION_KEY, JSON.stringify(eph.payload));
    } catch (_) {}
    return { payload: eph.payload, preview: false };
  }

  // 3. By item ID or URL search param
  const searchId = params.itemId || params.id;
  if (searchId) {
    try {
      const items = await storage.table('student_items').toArray();
      const match = items.find(it =>
        it.item_id === searchId ||
        it.id === searchId ||
        it.source_id === searchId ||
        it.payload?.task_id === searchId ||
        it.payload?.id === searchId
      );
      if (match?.payload?.kind === 'kb-task') {
        return { payload: match.payload, preview: false };
      }
      if (match?.source_id) {
        const task = await storage.table('tasks').get(match.source_id);
        if (task) {
          const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
          const payload = await buildStudentTaskPayload(
            {
              ...task,
              publish: {
                version: task.publish?.version || 1,
                salt: task.publish?.salt || 'local-task-salt'
              }
            },
            { teacherKeys: keys }
          );
          return { payload, preview: false, teacherTask: task };
        }
      }
    } catch (_) {}

    try {
      const task = await storage.table('tasks').get(searchId);
      if (task) {
        const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
        const payload = await buildStudentTaskPayload(
          {
            ...task,
            publish: {
              version: task.publish?.version || 1,
              salt: task.publish?.salt || 'local-task-salt'
            }
          },
          { teacherKeys: keys }
        );
        return { payload, preview: false, teacherTask: task };
      }
    } catch (_) {}
  }

  // 4. Fallback to session cached payload
  try {
    const cached = JSON.parse(sessionStorage.getItem(PAYLOAD_SESSION_KEY));
    if (cached?.kind === 'kb-task') return { payload: cached, preview: false };
  } catch (_) {}

  return null;
}

/**
 * Calculate total unencrypted plaintext size in bytes of the task submission.
 */
export function estimatePlaintextSize(content) {
  let bytes = 0;
  if (content.text) {
    bytes += new TextEncoder().encode(content.text).length;
  }
  if (Array.isArray(content.code_files)) {
    for (const f of content.code_files) {
      bytes += new TextEncoder().encode(f.filename || '').length;
      bytes += new TextEncoder().encode(f.body || '').length;
    }
  }
  if (content.drawing) {
    if (content.drawing.compressed) {
      bytes += new TextEncoder().encode(content.drawing.compressed).length;
    } else if (content.drawing.png_ref) {
      bytes += new TextEncoder().encode(content.drawing.png_ref).length;
    } else {
      bytes += new TextEncoder().encode(JSON.stringify(content.drawing)).length;
    }
  }
  if (Array.isArray(content.attachments)) {
    for (const a of content.attachments) {
      bytes += new TextEncoder().encode(JSON.stringify(a)).length;
    }
  }
  return bytes;
}

/**
 * Main student take & submit view controller.
 */
export async function renderTaskTake(params = {}, router = null, container = null) {
  if (!container) container = document.getElementById('main-content');
  if (!container) return;

  const resolved = await resolvePayload(params);
  if (!resolved || !resolved.payload) {
    container.innerHTML = `
      <div class="max-w-md mx-auto p-8 text-center space-y-4">
        <sl-icon name="exclamation-circle" class="text-4xl text-amber-500"></sl-icon>
        <h2 class="text-lg font-bold text-slate-800">No Assignment Loaded</h2>
        <p class="text-sm text-slate-500">Scan an assignment QR code, open a student link, or launch an assignment from My Courses.</p>
        <sl-button variant="primary" href="#/student">Go to Student Hub</sl-button>
      </div>
    `;
    return;
  }

  const { payload, preview } = resolved;
  const initialSid = params.sid || '';
  const initialSname = params.sname || '';

  const state = {
    screen: 'start', // 'start' | 'composer' | 'receipt'
    student: {
      name: initialSname,
      id: initialSid,
      code: ''
    },
    content: {
      text: '',
      code_files: [],
      drawing: null,
      attachments: []
    },
    activeFileIndex: 0,
    activeCodeEditor: null,
    submittedReceipt: null,
    startedAt: new Date().toISOString()
  };

  // Default initial code file if code enabled
  if (payload.submission_types?.code?.enabled) {
    const hint = payload.submission_types.code.filename_hint || 'solution.py';
    const lang = payload.submission_types.code.default_language || 'python';
    state.content.code_files = [
      { id: 'f1', filename: hint, language: lang, body: '' }
    ];
  }

  const draftKey = () => `kb_task_draft_${payload.task_id}_${String(state.student.id || 'anon').toUpperCase()}`;

  const saveLocalDraft = (isPaste = false, pasteLength = 0) => {
    if (preview) return;
    const draft = {
      publish_version: payload.publish_version,
      student: state.student,
      content: state.content,
      saved_at: new Date().toISOString()
    };
    safeStorage.set(draftKey(), draft);

    // Record non-invasive local checkpoint (#10)
    if (state.student?.id) {
      DraftHistoryTracker.recordCheckpoint({
        itemId: payload.task_id,
        studentId: state.student.id,
        content: state.content,
        isPaste,
        pasteLength
      }).catch(() => {});
    }
  };

  const loadLocalDraft = () => {
    const draft = safeStorage.get(draftKey());
    if (!draft) return null;
    return draft;
  };

  // Auto-fill student from StudentProfile if exists
  try {
    const profile = StudentProfile.resolveForPayload(payload, params);
    if (profile.student_id && !state.student.id) state.student.id = profile.student_id;
    if (profile.full_name && !state.student.name) state.student.name = profile.full_name;
    if (profile.access_code && !state.student.code) state.student.code = profile.access_code;
  } catch (_) {}

  // ---------------------------------------------------------------------------
  // Render Start Screen
  // ---------------------------------------------------------------------------
  function renderStart() {
    const needsCode = !!payload.settings?.require_access_code && !!payload.roster_checks;

    container.innerHTML = `
      <div class="max-w-xl mx-auto space-y-6 pt-4">
        ${preview ? `
          <div class="p-3 bg-indigo-50 border border-indigo-200 rounded-xl text-xs text-indigo-900 flex items-center justify-between">
            <span class="flex items-center gap-2">
              <sl-icon name="eye"></sl-icon>
              <strong>Teacher Preview Mode:</strong> Submitting will not record grades.
            </span>
            <sl-button size="small" variant="default" href="#/assignments/create?id=${payload.task_id}">Edit Assignment</sl-button>
          </div>
        ` : ''}

        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 space-y-6">
          <div class="space-y-3 text-center">
            <span class="w-14 h-14 mx-auto rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center text-2xl">
              <sl-icon name="journal-text"></sl-icon>
            </span>
            <h1 class="text-2xl font-bold text-slate-900">${esc(payload.title)}</h1>
            <div class="flex flex-wrap justify-center gap-2 text-xs">
              ${payload.course_meta?.course_name ? `<span class="px-2.5 py-1 rounded-full bg-indigo-100 text-indigo-800 font-medium">${esc(payload.course_meta.course_name)}</span>` : ''}
              ${payload.due_date ? `<span class="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">Due ${esc(new Date(`${payload.due_date}T12:00:00`).toLocaleDateString())}${payload.due_time ? ` at ${esc(payload.due_time)}` : ''}</span>` : ''}
              <span class="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">${payload.scoring === 'proficiency' ? 'Proficiency Rubric' : `${payload.max_points ?? 100} points`}</span>
            </div>
          </div>

          ${payload.description ? `
            <div class="kb-prose text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-xl p-4 max-h-60 overflow-y-auto">
              ${Sanitizer.renderSTEMMarkdown(payload.description)}
            </div>
          ` : ''}

          <form id="task-start-form" class="space-y-4" novalidate>
            <sl-input id="task-student-name" label="Your full name" required autocomplete="name" value="${esc(state.student.name)}"></sl-input>
            <sl-input id="task-student-id" label="Student ID" required autocomplete="off" value="${esc(state.student.id)}"></sl-input>
            <sl-input id="task-student-code" label="Access code${needsCode ? '' : ' (if given one)'}" ${needsCode ? 'required' : ''} autocomplete="off" placeholder="e.g. K7M2-QX9P" value="${esc(state.student.code)}">
              <sl-icon slot="prefix" name="key"></sl-icon>
            </sl-input>

            <div id="task-start-error" class="hidden text-xs text-rose-600 bg-rose-50 border border-rose-200 p-2.5 rounded-lg flex items-center gap-2">
              <sl-icon name="exclamation-circle" class="flex-shrink-0"></sl-icon>
              <span id="task-start-error-text"></span>
            </div>

            <sl-button type="submit" variant="primary" size="large" class="w-full" id="task-start-btn">
              <sl-icon slot="prefix" name="pencil-square"></sl-icon> Open Workspace
            </sl-button>
          </form>

          <p class="text-xs text-slate-400 text-center">
            Encrypted end-to-end to your teacher's key (<span class="font-mono text-[11px]">${esc(payload.teacher_key?.fingerprint)}</span>).
          </p>
        </div>
      </div>
    `;

    const form = container.querySelector('#task-start-form');
    const nameInput = container.querySelector('#task-student-name');
    const idInput = container.querySelector('#task-student-id');
    const codeInput = container.querySelector('#task-student-code');
    const errorBox = container.querySelector('#task-start-error');
    const errorText = container.querySelector('#task-start-error-text');

    const tryUnlockWithCode = async (code) => {
      if (!code || !payload.roster_cards) return;
      try {
        const unlocked = await SubmissionCrypto.unlockRosterCard(payload.task_id, payload.roster_cards, code);
        if (unlocked) {
          if (nameInput && (!nameInput.value || !state.student.name)) {
            nameInput.value = unlocked.name || '';
            state.student.name = unlocked.name || '';
          }
          if (idInput && (!idInput.value || !state.student.id)) {
            idInput.value = unlocked.sid || '';
            state.student.id = unlocked.sid || '';
          }
        }
      } catch (_) {}
    };

    if (state.student.code && (!state.student.name || !state.student.id)) {
      tryUnlockWithCode(state.student.code);
    }

    codeInput?.addEventListener('sl-input', (e) => {
      const val = (e.target.value || '').trim();
      if (val.length >= 6) {
        tryUnlockWithCode(val);
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.classList.add('hidden');

      const name = nameInput.value.trim();
      const sid = idInput.value.trim().toUpperCase();
      const code = codeInput.value.trim();

      if (!name) {
        errorText.textContent = 'Please enter your name.';
        errorBox.classList.remove('hidden');
        return;
      }
      if (!sid) {
        errorText.textContent = 'Please enter your Student ID.';
        errorBox.classList.remove('hidden');
        return;
      }

      // Validate access code if required
      if (payload.settings?.require_access_code && payload.roster_checks) {
        const ok = await checkTaskAccessCode(payload, sid, code);
        if (!ok) {
          errorText.textContent = 'Access code does not match this Student ID. Please check with your teacher.';
          errorBox.classList.remove('hidden');
          return;
        }
      }

      state.student.name = name;
      state.student.id = sid;
      state.student.code = code;

      // Persist to StudentProfile keychain
      StudentProfile.saveIdentity({
        studentId: sid,
        fullName: name,
        accessCode: code,
        courseId: payload.course_id,
        courseName: payload.course_meta?.course_name,
        section: payload.course_meta?.section,
        teacherFingerprint: payload.teacher_key?.fingerprint
      }).catch(() => {});

      // Check if previous draft exists
      const priorDraft = loadLocalDraft();
      if (priorDraft) {
        if (priorDraft.publish_version !== payload.publish_version) {
          const keep = confirm('The teacher published an updated version of this assignment. Do you want to restore your previous draft?');
          if (keep && priorDraft.content) {
            state.content = priorDraft.content;
          }
        } else if (priorDraft.content) {
          state.content = priorDraft.content;
        }
      }

      state.screen = 'composer';
      renderComposer();
    });
  }

  // ---------------------------------------------------------------------------
  // Render Composer Screen
  // ---------------------------------------------------------------------------
  function renderComposer() {
    const types = payload.submission_types || {};
    const hasText = !!types.text?.enabled;
    const hasCode = !!types.code?.enabled;
    const hasDrawing = !!types.drawing?.enabled;
    const hasFiles = !!types.files?.enabled && !!payload.relay?.media?.enabled;

    container.innerHTML = `
      <div class="max-w-5xl mx-auto space-y-6 pb-20 pt-2">
        <!-- Top Toolbar -->
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div class="min-w-0">
            <h1 class="text-base font-bold text-slate-900 truncate">${esc(payload.title)}</h1>
            <p class="text-xs text-slate-500">${esc(state.student.name)} (${esc(state.student.id)})</p>
          </div>

          <div class="flex items-center gap-3 self-end sm:self-auto flex-wrap">
            <!-- Plaintext Size Meter -->
            <div id="task-size-meter" class="text-xs font-mono px-2.5 py-1 rounded-full border border-slate-200 bg-slate-50 text-slate-600 flex items-center gap-1.5" title="Estimated payload size for submission">
              <span class="w-2 h-2 rounded-full bg-emerald-500" id="task-meter-dot"></span>
              <span id="task-meter-text">0 KB</span>
            </div>

            <!-- Draft History & Rollback (#10) -->
            <sl-button size="small" variant="default" id="task-history-btn" title="View draft timeline and restore checkpoints">
              <sl-icon slot="prefix" name="clock-history"></sl-icon> History
            </sl-button>

            <sl-button size="small" variant="primary" id="task-submit-btn">
              <sl-icon slot="prefix" name="send-check"></sl-icon> Hand In
            </sl-button>
          </div>
        </div>

        <!-- Instructions Card -->
        ${payload.description ? `
          <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-2">
            <h2 class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Instructions</h2>
            <div class="kb-prose text-sm text-slate-800">
              ${Sanitizer.renderSTEMMarkdown(payload.description)}
            </div>
          </div>
        ` : ''}

        <!-- 1. Text Section -->
        ${hasText ? `
          <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
            <div class="flex items-center justify-between">
              <h2 class="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <sl-icon name="card-text" class="text-indigo-600"></sl-icon> Written Response
              </h2>
            </div>
            <div id="task-text-mount"></div>
          </div>
        ` : ''}

        <!-- 2. In-App Code Editor Section -->
        ${hasCode ? `
          <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
            <div class="flex items-center justify-between flex-wrap gap-2">
              <h2 class="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <sl-icon name="code-slash" class="text-indigo-600"></sl-icon> Code Files
              </h2>
              <div class="flex items-center gap-2">
                <sl-select size="small" id="task-active-file-lang" class="w-32">
                  <sl-option value="python">Python</sl-option>
                  <sl-option value="javascript">JavaScript</sl-option>
                  <sl-option value="java">Java</sl-option>
                  <sl-option value="cpp">C++</sl-option>
                  <sl-option value="html">HTML</sl-option>
                  <sl-option value="css">CSS</sl-option>
                  <sl-option value="sql">SQL</sl-option>
                </sl-select>
                <input type="file" id="task-code-file-input" class="hidden">
                <sl-button size="small" id="task-upload-code-btn"><sl-icon slot="prefix" name="upload"></sl-icon> Upload Code</sl-button>
                <sl-button size="small" id="task-add-file-btn"><sl-icon slot="prefix" name="plus"></sl-icon> Add File</sl-button>
              </div>
            </div>

            <!-- File Tabs -->
            <div class="flex items-center gap-1 border-b border-slate-200 pb-2 overflow-x-auto" id="task-code-tabs"></div>

            <!-- Code Editor Mount -->
            <div id="task-code-editor-mount" class="rounded-xl overflow-hidden border border-slate-200 min-h-[300px]"></div>
          </div>
        ` : ''}

        <!-- 3. Vector Drawing Section -->
        ${hasDrawing ? `
          <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
            <h2 class="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <sl-icon name="brush" class="text-indigo-600"></sl-icon> Drawing & Diagram
            </h2>
            <div id="task-draw-mount" class="rounded-xl overflow-hidden"></div>
          </div>
        ` : ''}

        <!-- 4. File Attachments Section -->
        ${hasFiles ? `
          <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
            <div class="flex items-center justify-between">
              <h2 class="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <sl-icon name="paperclip" class="text-indigo-600"></sl-icon> Attached Files
              </h2>
              <span class="text-xs text-slate-400">Encrypted with AES-GCM before upload</span>
            </div>
            <div class="space-y-3">
              <input type="file" id="task-file-input" class="hidden" accept="${esc((payload.submission_types.files?.accept || []).join(','))}">
              <div class="flex items-center gap-2">
                <sl-button size="small" id="task-upload-file-btn"><sl-icon slot="prefix" name="upload"></sl-icon> Choose File</sl-button>
                <span class="text-xs text-slate-400" id="task-upload-hint">Uploads are encrypted directly in your browser</span>
              </div>

              <!-- Upload Progress Indicator -->
              <div id="task-upload-progress" class="hidden space-y-1 p-3 bg-slate-50 border border-slate-200 rounded-xl">
                <div class="flex justify-between text-xs text-slate-600">
                  <span id="task-upload-filename" class="font-medium truncate max-w-[70%]">Uploading...</span>
                  <span id="task-upload-percent" class="font-mono">0%</span>
                </div>
                <sl-progress-bar value="0" id="task-upload-bar"></sl-progress-bar>
              </div>

              <!-- Offline / Upload Error Banner with Retry -->
              <div id="task-upload-retry" class="hidden p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <sl-icon name="exclamation-circle" class="text-rose-600 text-base flex-shrink-0"></sl-icon>
                  <span id="task-upload-error-msg">Upload failed. Check your internet connection.</span>
                </div>
                <sl-button size="small" variant="danger" id="task-upload-retry-btn">Retry</sl-button>
              </div>

              <div id="task-attachment-list" class="space-y-2"></div>
            </div>
          </div>
        ` : ''}
      </div>
    `;

    // 1. Mount RichTextEditor if text enabled
    if (hasText) {
      const textMount = container.querySelector('#task-text-mount');
      const rich = new RichTextEditor({
        initialValue: state.content.text || '',
        placeholder: 'Type your response here...',
        minHeight: '220px',
        onChange: (val) => {
          state.content.text = val;
          updateSizeMeter();
          saveLocalDraft();
        }
      });
      textMount.appendChild(rich.element);
    }

    // 2. Mount Code Editor if code enabled
    if (hasCode) {
      renderCodeTabs();
      mountCodeEditor();
    }

    // 3. Mount Drawing if enabled
    if (hasDrawing) {
      const drawMount = container.querySelector('#task-draw-mount');
      if (drawMount) {
        DrawBoardUI.mount(drawMount, {
          doc: state.content.drawing,
          onChange: (doc) => {
            state.content.drawing = doc;
            updateSizeMeter();
            saveLocalDraft();
          }
        });
      }
    }

    // 4. File attachments handlers
    if (hasFiles) {
      const fileInput = container.querySelector('#task-file-input');
      const uploadBtn = container.querySelector('#task-upload-file-btn');
      const attachList = container.querySelector('#task-attachment-list');
      const progressWrap = container.querySelector('#task-upload-progress');
      const progressFilename = container.querySelector('#task-upload-filename');
      const progressPercent = container.querySelector('#task-upload-percent');
      const progressBar = container.querySelector('#task-upload-bar');
      const retryWrap = container.querySelector('#task-upload-retry');
      const retryMsg = container.querySelector('#task-upload-error-msg');
      const retryBtn = container.querySelector('#task-upload-retry-btn');

      let lastFailedFile = null;

      const performUpload = async (file) => {
        if (!file) return;
        uploadBtn.loading = true;
        retryWrap.classList.add('hidden');
        progressWrap.classList.remove('hidden');
        progressFilename.textContent = `Encrypting & uploading "${file.name}"...`;
        progressPercent.textContent = '0%';
        progressBar.value = 0;

        try {
          const relayInfo = {
            endpoint: payload.relay?.base_url,
            drop_id: payload.relay?.drop_id,
            drop_secret: payload.relay?.drop_secret
          };

          const cdnRef = await uploadStudentFile(file, relayInfo, {
            onProgress: (p) => {
              const pct = Math.round(p.percent || (p.loaded / (p.total || 1)) * 100);
              progressPercent.textContent = `${pct}%`;
              progressBar.value = pct;
            }
          });

          state.content.attachments.push({
            id: generateUUID(),
            name: file.name,
            size: file.size,
            mime: file.type || 'application/octet-stream',
            ref: cdnRef
          });

          lastFailedFile = null;
          renderAttachmentList();
          updateSizeMeter();
          saveLocalDraft();
          toast.success(`Attached "${file.name}"`);
        } catch (err) {
          // If <= 4MB, fall back to inline base64 attachment for offline / no-CDN relay hand-in
          if (file.size <= 4 * 1024 * 1024) {
            try {
              const reader = new FileReader();
              const b64Promise = new Promise((resolve, reject) => {
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
              });
              const inlineData = await b64Promise;
              state.content.attachments.push({
                id: generateUUID(),
                name: file.name,
                size: file.size,
                mime: file.type || 'application/octet-stream',
                ref: null,
                inline_data_b64: inlineData
              });
              lastFailedFile = null;
              renderAttachmentList();
              updateSizeMeter();
              saveLocalDraft();
              toast.warning(`Server media upload not available; attached "${file.name}" inline.`);
              return;
            } catch (_) {}
          }
          console.error(err);
          lastFailedFile = file;
          retryMsg.textContent = !navigator.onLine
            ? 'You are offline. Reconnect to internet and click Retry.'
            : `Upload failed: ${err.message || 'Network error'}`;
          retryWrap.classList.remove('hidden');
          toast.error('File upload failed: ' + (err.message || ''));
        } finally {
          uploadBtn.loading = false;
          progressWrap.classList.add('hidden');
          fileInput.value = '';
        }
      };

      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) performUpload(file);
      });

      retryBtn.addEventListener('click', () => {
        if (lastFailedFile) performUpload(lastFailedFile);
      });

      function renderAttachmentList() {
        attachList.innerHTML = state.content.attachments.map((att, idx) => `
          <div class="flex items-center justify-between p-2.5 rounded-lg border border-slate-200 bg-slate-50 text-xs">
            <div class="flex items-center gap-2 truncate">
              <sl-icon name="file-earmark-lock2" class="text-indigo-600 text-base"></sl-icon>
              <strong class="text-slate-800 truncate">${esc(att.name)}</strong>
              <span class="text-slate-400">(${Math.round(att.size / 1024)} KB)</span>
            </div>
            <sl-button size="small" variant="text" class="text-red-600 remove-att-btn" data-idx="${idx}">
              <sl-icon name="trash"></sl-icon>
            </sl-button>
          </div>
        `).join('');

        attachList.querySelectorAll('.remove-att-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx, 10);
            state.content.attachments.splice(idx, 1);
            renderAttachmentList();
            updateSizeMeter();
            saveLocalDraft();
          });
        });
      }
      renderAttachmentList();
    }

    // History & Rollback button handler
    const historyBtn = container.querySelector('#task-history-btn');
    historyBtn?.addEventListener('click', async () => {
      openDraftHistoryModal();
    });

    // Submit button handler
    const submitBtn = container.querySelector('#task-submit-btn');
    submitBtn.addEventListener('click', () => {
      openSubmitSheet();
    });

    updateSizeMeter();
  }

  // ---------------------------------------------------------------------------
  // Code Editor Tab Management
  // ---------------------------------------------------------------------------
  function renderCodeTabs() {
    const tabsContainer = container.querySelector('#task-code-tabs');
    if (!tabsContainer) return;

    tabsContainer.innerHTML = state.content.code_files.map((file, idx) => {
      const active = idx === state.activeFileIndex;
      return `
        <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono cursor-pointer transition-colors ${active ? 'bg-indigo-50 text-indigo-700 font-semibold border border-indigo-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}" data-tab-idx="${idx}">
          <span>${esc(file.filename)}</span>
          ${state.content.code_files.length > 1 ? `
            <button type="button" class="del-file-btn text-slate-400 hover:text-red-500 ml-1" data-del-idx="${idx}" title="Delete file">×</button>
          ` : ''}
        </div>
      `;
    }).join('');

    tabsContainer.querySelectorAll('[data-tab-idx]').forEach(tab => {
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('del-file-btn')) return;
        const idx = parseInt(tab.dataset.tabIdx, 10);
        state.activeFileIndex = idx;
        renderCodeTabs();
        mountCodeEditor();
      });
    });

    tabsContainer.querySelectorAll('.del-file-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.delIdx, 10);
        if (confirm(`Delete file "${state.content.code_files[idx].filename}"?`)) {
          state.content.code_files.splice(idx, 1);
          if (state.activeFileIndex >= state.content.code_files.length) {
            state.activeFileIndex = Math.max(0, state.content.code_files.length - 1);
          }
          renderCodeTabs();
          mountCodeEditor();
          updateSizeMeter();
          saveLocalDraft();
        }
      });
    });

    const addBtn = container.querySelector('#task-add-file-btn');
    if (addBtn) {
      addBtn.onclick = () => {
        const name = prompt('File name (e.g. helper.py, utils.js):', 'helper.py');
        if (name && name.trim()) {
          const ext = name.split('.').pop().toLowerCase();
          const lang = ext === 'js' ? 'javascript' : (ext === 'html' ? 'html' : (ext === 'css' ? 'css' : (ext === 'java' ? 'java' : (ext === 'cpp' ? 'cpp' : 'python'))));
          state.content.code_files.push({
            id: generateUUID(),
            filename: name.trim(),
            language: lang,
            body: ''
          });
          state.activeFileIndex = state.content.code_files.length - 1;
          renderCodeTabs();
          mountCodeEditor();
          updateSizeMeter();
          saveLocalDraft();
        }
      };
    }

    const uploadCodeBtn = container.querySelector('#task-upload-code-btn');
    const codeFileInput = container.querySelector('#task-code-file-input');
    if (uploadCodeBtn && codeFileInput) {
      uploadCodeBtn.onclick = () => codeFileInput.click();
      codeFileInput.onchange = async () => {
        const file = codeFileInput.files?.[0];
        if (!file) return;
        uploadCodeBtn.loading = true;
        try {
          const relayInfo = {
            endpoint: payload.relay?.base_url,
            drop_id: payload.relay?.drop_id,
            drop_secret: payload.relay?.drop_secret
          };
          const res = await processUploadedCodeFile(file, relayInfo);
          if (res.type === 'code') {
            state.content.code_files.push(res.file);
            state.activeFileIndex = state.content.code_files.length - 1;
            renderCodeTabs();
            mountCodeEditor();
            toast.success(`Loaded code file "${file.name}"`);
          } else if (res.type === 'attachment') {
            state.content.attachments.push(res.attachment);
            toast.info(`Large file "${file.name}" (>64KB) attached as file submission`);
          }
          updateSizeMeter();
          saveLocalDraft();
        } catch (err) {
          toast.error('Failed to read code file: ' + (err.message || String(err)));
        } finally {
          uploadCodeBtn.loading = false;
          codeFileInput.value = '';
        }
      };
    }
  }

  function mountCodeEditor() {
    const mount = container.querySelector('#task-code-editor-mount');
    if (!mount) return;

    if (state.activeCodeEditor) {
      state.activeCodeEditor.destroy();
      state.activeCodeEditor = null;
    }
    mount.innerHTML = '';

    const currentFile = state.content.code_files[state.activeFileIndex];
    if (!currentFile) return;

    const langSelect = container.querySelector('#task-active-file-lang');
    if (langSelect) {
      langSelect.value = currentFile.language || 'python';
      langSelect.onchange = () => {
        currentFile.language = langSelect.value;
        mountCodeEditor();
        saveLocalDraft();
      };
    }

    state.activeCodeEditor = createCodeEditor(mount, {
      language: currentFile.language || 'python',
      value: currentFile.body || '',
      onChange: (val) => {
        currentFile.body = val;
        updateSizeMeter();
        saveLocalDraft();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Envelope Size Meter
  // ---------------------------------------------------------------------------
  function updateSizeMeter() {
    const meterDot = container.querySelector('#task-meter-dot');
    const meterText = container.querySelector('#task-meter-text');
    if (!meterDot || !meterText) return;

    const bytes = estimatePlaintextSize(state.content);
    const kb = (bytes / 1024).toFixed(1);
    meterText.textContent = `${kb} KB`;

    meterDot.className = 'w-2 h-2 rounded-full';
    if (bytes < 180 * 1024) {
      meterDot.classList.add('bg-emerald-500');
    } else if (bytes < 256 * 1024) {
      meterDot.classList.add('bg-amber-500');
    } else {
      meterDot.classList.add('bg-rose-500');
    }
  }

  // ---------------------------------------------------------------------------
  // Draft History & Rollback Modal (#10)
  // ---------------------------------------------------------------------------
  async function openDraftHistoryModal() {
    const checkpoints = await DraftHistoryTracker.getCheckpoints(payload.task_id, state.student.id);

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'task-history-dialog';
    dialog.label = 'Draft History & Rollback';
    dialog.style.setProperty('--width', '640px');

    if (!checkpoints.length) {
      dialog.innerHTML = `
        <div class="py-8 text-center text-slate-500 space-y-2">
          <sl-icon name="clock-history" class="text-3xl text-slate-300 mx-auto block"></sl-icon>
          <p class="font-medium">No previous checkpoints recorded yet.</p>
          <p class="text-xs text-slate-400">Revisions are saved automatically every few seconds as you write or edit code.</p>
        </div>
        <div slot="footer" class="flex justify-end">
          <sl-button id="btn-close-history">Close</sl-button>
        </div>
      `;
    } else {
      let selectedIdx = checkpoints.length - 1;

      dialog.innerHTML = `
        <div class="space-y-4 text-xs">
          <p class="text-slate-600">
            Select a previous revision from this work session to preview or restore it.
          </p>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <!-- Checkpoints list -->
            <div class="sm:col-span-1 max-h-64 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100 bg-slate-50" id="history-cp-list">
              ${checkpoints.map((cp, idx) => {
                const isSelected = idx === selectedIdx;
                const time = new Date(cp.saved_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                return `
                  <button type="button" class="w-full text-left p-2.5 hover:bg-white transition-colors history-cp-btn ${isSelected ? 'bg-white font-bold text-indigo-700 shadow-2xs' : 'text-slate-600'}" data-cp-idx="${idx}">
                    <div class="flex items-center justify-between">
                      <span>${esc(time)}</span>
                      <span class="text-[10px] text-slate-400 font-mono">${cp.text_length || 0} ch</span>
                    </div>
                    ${cp.is_paste ? `<span class="text-[9px] text-amber-600 font-semibold">+ paste</span>` : ''}
                  </button>
                `;
              }).reverse().join('')}
            </div>

            <!-- Preview panel -->
            <div class="sm:col-span-2 border border-slate-200 rounded-xl p-3 bg-white max-h-64 overflow-y-auto space-y-2">
              <div class="flex items-center justify-between border-b border-slate-100 pb-1.5">
                <span class="font-semibold text-slate-700" id="history-preview-title">Checkpoint Preview</span>
                <span class="text-[10px] text-slate-400" id="history-preview-time"></span>
              </div>
              <pre id="history-preview-content" class="text-xs font-mono text-slate-800 whitespace-pre-wrap break-all"></pre>
            </div>
          </div>
        </div>

        <div slot="footer" class="flex justify-between items-center gap-2">
          <sl-button id="btn-close-history">Cancel</sl-button>
          <sl-button variant="primary" id="btn-restore-history">
            <sl-icon slot="prefix" name="arrow-counterclockwise"></sl-icon> Restore This Revision
          </sl-button>
        </div>
      `;
    }

    document.body.appendChild(dialog);
    dialog.show();

    const updatePreview = (idx) => {
      const cp = checkpoints[idx];
      if (!cp) return;
      const previewTitle = dialog.querySelector('#history-preview-title');
      const previewTime = dialog.querySelector('#history-preview-time');
      const previewContent = dialog.querySelector('#history-preview-content');

      if (previewTitle) previewTitle.textContent = `Revision #${idx + 1}`;
      if (previewTime) previewTime.textContent = new Date(cp.saved_at).toLocaleTimeString();

      let previewText = '';
      if (typeof cp.content === 'string') previewText = cp.content;
      else if (typeof cp.content === 'object') {
        if (cp.content.text) previewText = cp.content.text;
        else if (cp.content.code_files?.length) {
          previewText = cp.content.code_files.map(f => `--- ${f.filename} ---\n${f.body || ''}`).join('\n\n');
        }
      }
      if (previewContent) previewContent.textContent = previewText || '(Empty content)';
    };

    if (checkpoints.length) {
      updatePreview(checkpoints.length - 1);

      dialog.querySelectorAll('.history-cp-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          dialog.querySelectorAll('.history-cp-btn').forEach(b => b.classList.remove('bg-white', 'font-bold', 'text-indigo-700', 'shadow-2xs'));
          btn.classList.add('bg-white', 'font-bold', 'text-indigo-700', 'shadow-2xs');
          const idx = parseInt(btn.dataset.cpIdx, 10);
          updatePreview(idx);
          dialog.querySelector('#btn-restore-history').dataset.selectedIdx = String(idx);
        });
      });

      dialog.querySelector('#btn-restore-history')?.addEventListener('click', () => {
        const selIdx = parseInt(dialog.querySelector('#btn-restore-history').dataset.selectedIdx ?? (checkpoints.length - 1), 10);
        const targetCp = checkpoints[selIdx];
        if (targetCp && targetCp.content) {
          if (typeof targetCp.content === 'object') {
            state.content = JSON.parse(JSON.stringify(targetCp.content));
          } else {
            state.content.text = String(targetCp.content);
          }
          saveLocalDraft();
          toast.success(`Draft restored to checkpoint from ${new Date(targetCp.saved_at).toLocaleTimeString()}!`);
          dialog.hide();
          renderWorkspace();
        }
      });
    }

    dialog.querySelector('#btn-close-history')?.addEventListener('click', () => dialog.hide());
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target === dialog) dialog.remove();
    });
  }

  // ---------------------------------------------------------------------------
  // Submit & Hand-in Sheet
  // ---------------------------------------------------------------------------
  async function openSubmitSheet() {
    const plainBytes = estimatePlaintextSize(state.content);
    const exceedsRelay = plainBytes > 256 * 1024;

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'task-handin-dialog';
    dialog.label = 'Hand In Assignment';
    dialog.style.setProperty('--width', '580px');

    dialog.innerHTML = `
      <div class="space-y-4">
        <p class="text-sm text-slate-600">
          Your assignment work will be encrypted directly to your teacher's public key.
        </p>

        ${exceedsRelay ? `
          <div class="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 flex items-start gap-2">
            <sl-icon name="exclamation-triangle" class="text-amber-600 text-base flex-shrink-0 mt-0.5"></sl-icon>
            <div>
              <strong>Payload size exceeds server relay limit (256 KB).</strong>
              Please submit by downloading the <strong>.kbsub</strong> file and emailing or uploading it to your school LMS.
            </div>
          </div>
        ` : ''}

        <div class="space-y-2 pt-2">
          ${payload.relay?.drop_id && !exceedsRelay ? `
            <sl-button variant="primary" id="btn-submit-relay" class="w-full" size="medium">
              <sl-icon slot="prefix" name="cloud-upload"></sl-icon> Submit via School Relay (1-Click)
            </sl-button>
          ` : ''}

          <sl-button variant="${exceedsRelay ? 'primary' : 'default'}" id="btn-submit-file" class="w-full" size="medium">
            <sl-icon slot="prefix" name="download"></sl-icon> Download .kbsub Encrypted File
          </sl-button>

          <sl-button variant="default" id="btn-submit-html" class="w-full" size="medium">
            <sl-icon slot="prefix" name="file-earmark-code"></sl-icon> Download Self-Submitting .html File
          </sl-button>
        </div>
      </div>
      <sl-button slot="footer" variant="default" id="btn-submit-close">Cancel</sl-button>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    const closeBtn = dialog.querySelector('#btn-submit-close');
    closeBtn.addEventListener('click', () => dialog.hide());
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target !== dialog) return;
      dialog.remove();
    });

    // Prepare encrypted submission
    const relayInfo = {
      endpoint: payload.relay?.base_url,
      drop_id: payload.relay?.drop_id,
      drop_secret: payload.relay?.drop_secret
    };

    const getPreparedContent = async (isOffline = false) => {
      const preparedDrawing = await prepareDrawingForSubmission(
        state.content.drawing,
        relayInfo,
        { offline: isOffline }
      );
      return {
        text: state.content.text || null,
        text_md: state.content.text || null,
        code_files: state.content.code_files.length ? state.content.code_files : null,
        code: state.content.code_files.length ? state.content.code_files : null,
        drawing: preparedDrawing,
        attachments: state.content.attachments.length ? state.content.attachments : null
      };
    };

    const resolvedCourseId = payload.course_id || payload.class_id || payload.course_meta?.course_id || payload.course_meta?.id || null;
    const resolvedCourseName = payload.course_meta?.course_name || payload.course_meta?.name || payload.course_name || '';

    const recordSuccess = async (subId, envelopeText, submittedAt) => {
      StudentProfile.saveIdentity({
        studentId: state.student.id,
        fullName: state.student.name,
        accessCode: state.student.code,
        courseId: resolvedCourseId,
        courseName: resolvedCourseName,
        section: payload.course_meta?.section || '',
        teacherFingerprint: payload.teacher_key?.fingerprint || ''
      }).catch(() => {});

      await StudentLedger.recordSubmission({
        assignmentId: payload.task_id,
        courseId: resolvedCourseId,
        courseName: resolvedCourseName,
        title: payload.title,
        studentId: state.student.id,
        studentName: state.student.name,
        receiptId: subId,
        submissionText: envelopeText,
        submittedAt
      });
    };

    const relayBtn = dialog.querySelector('#btn-submit-relay');
    if (relayBtn) {
      relayBtn.addEventListener('click', async () => {
        relayBtn.loading = true;
        try {
          const submissionContent = await getPreparedContent(false);
          const { submission, envelopeText } = await createTaskSubmission(
            payload,
            { id: state.student.id, name: state.student.name, code: state.student.code },
            submissionContent
          );

          const transport = new RelayTransport({ baseUrl: payload.relay.base_url });
          const res = await transport.submitToDrop(payload.relay.drop_id, envelopeText, { dropSecret: payload.relay.drop_secret });
          if (!res || !res.receiptId) {
            throw new Error('Relay server did not return a valid receipt');
          }
          if (res.receiptId) {
            submission.id = res.receiptId;
          }

          // Record in Student Ledger & Keychain
          await recordSuccess(submission.id, envelopeText, submission.submitted_at);

          dialog.hide();
          state.submittedReceipt = submission;
          state.screen = 'receipt';
          renderReceipt();
        } catch (err) {
          console.error(err);
          toast.error('Relay submission failed: ' + (err.message || String(err)));
        } finally {
          relayBtn.loading = false;
        }
      });
    }

    const fileBtn = dialog.querySelector('#btn-submit-file');
    fileBtn.addEventListener('click', async () => {
      fileBtn.loading = true;
      try {
        const submissionContent = await getPreparedContent(true);
        const { submission, envelopeText } = await createTaskSubmission(
          payload,
          { id: state.student.id, name: state.student.name, code: state.student.code },
          submissionContent
        );

        const filename = `${state.student.id || 'student'}_${(payload.title || 'Assignment').replace(/[^a-z0-9_-]/gi, '_')}.kbsub`;
        const blob = new Blob([envelopeText], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);

        await recordSuccess(submission.id, envelopeText, submission.submitted_at);

        dialog.hide();
        state.submittedReceipt = submission;
        state.screen = 'receipt';
        renderReceipt();
      } catch (err) {
        console.error(err);
        toast.error('File generation failed: ' + (err.message || String(err)));
      } finally {
        fileBtn.loading = false;
      }
    });

    const htmlBtn = dialog.querySelector('#btn-submit-html');
    htmlBtn.addEventListener('click', async () => {
      htmlBtn.loading = true;
      try {
        const submissionContent = await getPreparedContent(true);
        const { submission, envelopeText } = await createTaskSubmission(
          payload,
          { id: state.student.id, name: state.student.name, code: state.student.code },
          submissionContent
        );

        const filename = `${state.student.id || 'student'}_${(payload.title || 'Assignment').replace(/[^a-z0-9_-]/gi, '_')}.kbsub.html`;
        downloadClickableHtmlFile({
          title: `${payload.title} - ${state.student.name}`,
          payloadType: 'submission',
          payload: envelopeText,
          shareUrl: ''
        }, filename);

        await recordSuccess(submission.id, envelopeText, submission.submitted_at);

        dialog.hide();
        state.submittedReceipt = submission;
        state.screen = 'receipt';
        renderReceipt();
      } catch (err) {
        console.error(err);
        toast.error('HTML generation failed: ' + (err.message || String(err)));
      } finally {
        htmlBtn.loading = false;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Render Receipt Screen
  // ---------------------------------------------------------------------------
  function renderReceipt() {
    const sub = state.submittedReceipt;
    container.innerHTML = `
      <div class="max-w-xl mx-auto space-y-6 pt-6">
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 space-y-6 text-center">
          <div class="w-16 h-16 mx-auto rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center text-3xl">
            <sl-icon name="check-circle-fill"></sl-icon>
          </div>
          <div class="space-y-1">
            <h1 class="text-2xl font-bold text-slate-900">Work Handed In!</h1>
            <p class="text-sm text-slate-500">${esc(payload.title)}</p>
          </div>

          <div class="p-4 bg-slate-50 rounded-xl border border-slate-200 text-left space-y-2 text-xs font-mono">
            <div class="flex justify-between">
              <span class="text-slate-500">Student:</span>
              <strong class="text-slate-800">${esc(state.student.name)} (${esc(state.student.id)})</strong>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-500">Receipt ID:</span>
              <strong class="text-slate-800">${esc(sub?.id || 'SUB-OK')}</strong>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-500">Submitted at:</span>
              <span class="text-slate-700">${esc(new Date(sub?.submitted_at || Date.now()).toLocaleString())}</span>
            </div>
          </div>

          <div class="flex justify-center gap-3 pt-2">
            <sl-button variant="primary" href="#/student/gradebook">
              <sl-icon slot="prefix" name="journal-check"></sl-icon> View in My Grades
            </sl-button>
            <sl-button variant="default" href="#/student">
              Student Hub
            </sl-button>
          </div>
        </div>
      </div>
    `;
  }

  // Initial screen selection
  renderStart();
}
