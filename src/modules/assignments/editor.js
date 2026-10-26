import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { generateUUID } from '../../utils/uuid.js';
import { QUESTION_TYPE_META, QUESTION_TYPE_ORDER, createQuestion, cloneQuestion, validateQuestion } from './question-types.js';
import { countBlanks, totalPoints } from './grading.js';
import { openPublishDialog, computeRosterHash } from './publish.js';
import { syncContentClassLink } from '../gradebook/bridge.js';
import { CSVImportDialog } from '../../components/csv-import-dialog.js';
import { downloadCSVTemplate, ASSIGNMENT_CSV_TEMPLATE } from '../../core/csv-templates.js';
import { AssignmentQuestionRowSchema, Exporter } from '../../core/validator.js';
import { ContentImporter } from '../../core/content-importer.js';
import { downloadCSV } from '../../core/csv.js';
import { setDue } from '../../core/due-dates.js';

export function resolveAssignmentCourseId(assignment) {
  if (!assignment) return null;
  return assignment.gradebook?.course_id || assignment.class_id || null;
}

export function syncAssignmentCourseId(assignment, courseId) {
  if (!assignment) return;
  const cid = courseId || null;
  assignment.class_id = cid;
  assignment.gradebook = assignment.gradebook || {};
  assignment.gradebook.course_id = cid;
}

/**
 * Assignment Editor (KB-ASSIGN-004)
 * Settings on the left, question cards on the right. Every change auto-saves.
 */

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));
const shortId = () => generateUUID().slice(0, 8);

export async function renderEditor(assignment, router, container) {
  const a = assignment;
  const currentCourseId = resolveAssignmentCourseId(a);
  syncAssignmentCourseId(a, currentCourseId);
  a.settings = { feedback_mode: 'after_submit', shuffle_options: true, require_access_code: true, release_grade_immediately: true, ...(a.settings || {}) };
  a.gradebook = { category_id: null, column_id: null, ...(a.gradebook || {}), course_id: currentCourseId };
  a.questions = a.questions || [];

  const [courses, submissionCount, rosterStudents] = await Promise.all([
    storage.table('gradebook_courses').toArray().catch(() => []),
    storage.table('assignment_submissions').where('assignment_id').equals(a.id).count().catch(() => 0),
    currentCourseId ? storage.table('gradebook_students').where('course_id').equals(currentCourseId).toArray().catch(() => []) : []
  ]);

  let isRosterStale = false;
  if (a.publish?.published_at && currentCourseId && a.publish?.roster_hash) {
    const currentHash = await computeRosterHash(rosterStudents);
    if (currentHash && currentHash !== a.publish.roster_hash) {
      isRosterStale = true;
    }
  }

  let saveTimer = null;
  const setSaveState = (text) => {
    const el = container.querySelector('#asg-save-state');
    if (el) el.textContent = text;
  };
  const save = (immediate = false) => {
    clearTimeout(saveTimer);
    setSaveState('Saving…');
    const run = async () => {
      a.updated_at = new Date().toISOString();
      await storage.table('assignments').put(JSON.parse(JSON.stringify(a)));
      setSaveState('Saved');
      updateSummary();
    };
    if (immediate) return run();
    saveTimer = setTimeout(run, 400);
  };

  const linkedCourse = () => courses.find(c => c.id === a.gradebook.course_id) || null;

  container.innerHTML = `
    <div class="space-y-6 max-w-7xl mx-auto">
      ${isRosterStale ? `
        <div class="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-amber-900" id="asg-roster-stale-banner">
          <div class="flex items-center gap-2">
            <sl-icon name="exclamation-triangle" class="text-amber-600 text-lg flex-shrink-0"></sl-icon>
            <span><strong>Class roster or access codes were modified since this assignment was published.</strong> Students added or re-keyed since then will not be recognized until you publish an updated version.</span>
          </div>
          <sl-button size="small" variant="warning" id="asg-republish-stale-btn" class="flex-shrink-0">
            <sl-icon slot="prefix" name="arrow-repeat"></sl-icon> Re-publish
          </sl-button>
        </div>
      ` : ''}

      <!-- Header -->
      <div class="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
        <div class="flex items-center gap-3 min-w-0">
          <sl-button size="small" id="asg-back"><sl-icon slot="prefix" name="arrow-left"></sl-icon> Library</sl-button>
          <div class="min-w-0">
            <h1 class="font-bold text-slate-900 text-lg truncate" id="asg-title-display">${esc(a.title)}</h1>
            <p class="text-xs text-slate-500" id="asg-summary"></p>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-xs text-slate-400 mr-1" id="asg-save-state" aria-live="polite">Saved</span>
          <sl-dropdown placement="bottom-end" hoist id="asg-import-export-dropdown">
            <sl-button slot="trigger" size="small" caret variant="default">
              <sl-icon slot="prefix" name="arrow-down-up"></sl-icon> Import / Export
            </sl-button>
            <sl-menu id="asg-import-export-menu">
              <sl-menu-item value="import-csv">
                <sl-icon slot="prefix" name="upload"></sl-icon> Import Questions (.kbshare / JSON / CSV)…
              </sl-menu-item>
              <sl-menu-item value="download-template">
                <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Download Assignment CSV Template
              </sl-menu-item>
              <sl-divider></sl-divider>
              <sl-menu-item value="export-csv">
                <sl-icon slot="prefix" name="download"></sl-icon> Export Questions to CSV
              </sl-menu-item>
            </sl-menu>
          </sl-dropdown>
          <sl-button size="small" id="asg-preview"><sl-icon slot="prefix" name="eye"></sl-icon> Preview</sl-button>
          <sl-button size="small" id="asg-submissions">
            <sl-icon slot="prefix" name="inbox"></sl-icon> Submissions
            ${submissionCount ? `<sl-badge slot="suffix" variant="warning" pill>${submissionCount}</sl-badge>` : ''}
          </sl-button>
          <sl-button size="small" variant="primary" id="asg-publish"><sl-icon slot="prefix" name="send"></sl-icon> Publish &amp; share</sl-button>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <!-- Settings -->
        <aside class="lg:col-span-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-4 lg:sticky lg:top-[88px]">
          <div class="flex items-center gap-2">
            <sl-icon name="sliders" class="text-amber-600"></sl-icon>
            <h2 class="font-semibold text-slate-900">Settings</h2>
          </div>
          <sl-input id="asg-title" label="Title" value="${esc(a.title)}"></sl-input>
          <sl-textarea id="asg-instructions" label="Instructions for students" rows="3" resize="auto" placeholder="Markdown and $math$ supported" value="${esc(a.instructions)}"></sl-textarea>
          <div class="space-y-1">
            <span class="text-xs font-medium text-slate-700 block">Assessment Mode Preset</span>
            <div class="grid grid-cols-2 gap-2">
              <sl-button size="small" id="asg-preset-formative" variant="${a.settings.feedback_mode === 'immediate' ? 'primary' : 'default'}">Formative Practice</sl-button>
              <sl-button size="small" id="asg-preset-summative" variant="${a.settings.feedback_mode === 'none' ? 'primary' : 'default'}">Summative (Blind)</sl-button>
            </div>
          </div>
          <sl-select id="asg-course" label="Class & gradebook" value="${esc(a.gradebook.course_id || '')}" placeholder="Not linked" clearable>
            ${courses.map(c => `<sl-option value="${esc(c.id)}">${esc(c.name)}${c.section ? ` · ${esc(c.section)}` : ''}</sl-option>`).join('')}
          </sl-select>
          <div id="asg-category-wrap"></div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <sl-input id="asg-due" type="date" label="Due date" value="${esc(a.settings.due_date || '')}"></sl-input>
            <sl-input id="asg-due-time" type="time" label="Due time" value="${esc(a.settings.due_time || '')}"></sl-input>
          </div>
          <sl-select id="asg-feedback" label="Feedback for students" value="${esc(a.settings.feedback_mode)}">
            <sl-option value="immediate">Instant, after each question</sl-option>
            <sl-option value="after_submit">Score after submitting</sl-option>
            <sl-option value="none">None until you return grades</sl-option>
          </sl-select>
          <div class="space-y-3 pt-1">
            <sl-switch id="asg-release-grade" ${a.settings.release_grade_immediately !== false ? 'checked' : ''}>Release grade immediately on submit (autograded)</sl-switch>
            <sl-switch id="asg-show-answers" ${a.settings.show_correct_answers ? 'checked' : ''}>Show correct answers after submitting</sl-switch>
            <sl-switch id="asg-shuffle-q" ${a.settings.shuffle_questions ? 'checked' : ''}>Shuffle question order</sl-switch>
            <sl-switch id="asg-shuffle-o" ${a.settings.shuffle_options ? 'checked' : ''}>Shuffle answer options</sl-switch>
            <sl-switch id="asg-require-code" ${a.settings.require_access_code ? 'checked' : ''}>Check student access codes</sl-switch>
          </div>
          ${a.publish ? `<p class="text-xs text-slate-500 pt-2 border-t border-slate-200">Published version ${esc(a.publish.version)} · ${new Date(a.publish.published_at).toLocaleString()}. Edits apply after you publish again.</p>` : ''}
        </aside>

        <!-- Questions -->
        <section class="lg:col-span-8 space-y-4" aria-label="Questions">
          <div class="flex items-center justify-between gap-3">
            <h2 class="font-semibold text-slate-900">Questions</h2>
            <div class="flex items-center gap-2">
              <sl-button size="small" variant="default" id="asg-quick-import-csv">
                <sl-icon slot="prefix" name="upload"></sl-icon> Import CSV
              </sl-button>
              ${addQuestionMenu('asg-add-top')}
            </div>
          </div>
          <div id="asg-questions" class="space-y-4"></div>
          <div class="flex justify-center pt-2">${addQuestionMenu('asg-add-bottom', true)}</div>
        </section>
      </div>
    </div>
  `;

  function addQuestionMenu(id, large = false) {
    return `
      <sl-dropdown placement="bottom-end" hoist>
        <sl-button slot="trigger" ${large ? '' : 'size="small"'} variant="${large ? 'default' : 'primary'}" caret id="${id}">
          <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add question
        </sl-button>
        <sl-menu class="asg-add-menu">
          ${QUESTION_TYPE_ORDER.map(t => `
            <sl-menu-item value="${t}">
              <sl-icon slot="prefix" name="${QUESTION_TYPE_META[t].icon}"></sl-icon>
              ${QUESTION_TYPE_META[t].label}
              <div class="text-[11px] text-slate-400">${QUESTION_TYPE_META[t].help}</div>
            </sl-menu-item>
          `).join('')}
        </sl-menu>
      </sl-dropdown>
    `;
  }

  function updateSummary() {
    const el = container.querySelector('#asg-summary');
    const course = linkedCourse();
    if (el) el.textContent = `${a.questions.length} question${a.questions.length === 1 ? '' : 's'} · ${totalPoints(a)} pts${course ? ` · ${course.name}` : ''}`;
    const title = container.querySelector('#asg-title-display');
    if (title) title.textContent = a.title || 'Untitled assignment';
  }

  function renderCategory() {
    const wrap = container.querySelector('#asg-category-wrap');
    const course = linkedCourse();
    if (!course || !(course.categories || []).length) {
      wrap.innerHTML = '';
      return;
    }
    if (!course.categories.some(c => c.id === a.gradebook.category_id)) a.gradebook.category_id = course.categories[0].id;
    wrap.innerHTML = `
      <sl-select id="asg-category" label="Gradebook category" value="${esc(a.gradebook.category_id)}">
        ${course.categories.map(c => `<sl-option value="${esc(c.id)}">${esc(c.name)} (${esc(c.weight_pct || 0)}%)</sl-option>`).join('')}
      </sl-select>`;
    wrap.querySelector('#asg-category').addEventListener('sl-change', (e) => { a.gradebook.category_id = e.target.value; save(); });
  }

  // ---------------------------------------------------------------------------
  // Question cards
  // ---------------------------------------------------------------------------

  const listEl = container.querySelector('#asg-questions');

  const chips = (values, field, extra = '') => `
    <div class="flex flex-wrap items-center gap-1.5" data-chips="${field}" ${extra}>
      ${(values || []).map((v, i) => `
        <span class="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-sm">
          ${esc(v)}
          <button type="button" class="kb-icon-btn !w-5 !h-5 !text-xs" data-chip-remove="${i}" aria-label="Remove ${esc(v)}"><sl-icon name="x-lg"></sl-icon></button>
        </span>`).join('')}
      <sl-input size="small" class="flex-1 min-w-[10rem]" data-chip-input placeholder="Type an answer, press Enter"></sl-input>
    </div>`;

  const scoringSelect = (q, label = 'Scoring') => `
    <sl-select size="small" data-field="scoring" value="${esc(q.scoring || 'partial')}" label="${label}" class="sm:w-56">
      <sl-option value="partial">Partial credit</sl-option>
      <sl-option value="all_or_nothing">All or nothing</sl-option>
    </sl-select>`;

  function typeBody(q) {
    switch (q.type) {
      case 'single_choice':
      case 'multi_choice': {
        const multi = q.type === 'multi_choice';
        return `
          <div class="space-y-2" role="group" aria-label="Answer options">
            ${(q.options || []).map((o, i) => `
              <div class="flex items-center gap-2">
                <button type="button" data-opt-correct="${i}" class="kb-icon-btn ${o.is_correct ? '!text-emerald-600 bg-emerald-50' : ''}" aria-pressed="${!!o.is_correct}" aria-label="Mark option ${i + 1} correct" title="${o.is_correct ? 'Correct answer' : 'Mark as correct'}">
                  <sl-icon name="${o.is_correct ? (multi ? 'check-square-fill' : 'check-circle-fill') : (multi ? 'square' : 'circle')}"></sl-icon>
                </button>
                <sl-input size="small" class="flex-1" data-opt-text="${i}" value="${esc(o.text)}" placeholder="Option ${i + 1}"></sl-input>
                <button type="button" class="kb-icon-btn hover:!text-red-600" data-opt-remove="${i}" aria-label="Remove option ${i + 1}"><sl-icon name="x-lg"></sl-icon></button>
              </div>`).join('')}
            <div class="flex flex-wrap items-end justify-between gap-3 pt-1">
              <sl-button size="small" variant="text" data-opt-add><sl-icon slot="prefix" name="plus-lg"></sl-icon> Add option</sl-button>
              ${multi ? scoringSelect(q) : ''}
            </div>
          </div>`;
      }
      case 'true_false':
        return `
          <div class="flex items-center gap-3">
            <span class="text-sm text-slate-600">Correct answer</span>
            <div class="flex items-center p-0.5 rounded-lg bg-slate-100 text-sm" role="group" aria-label="Correct answer">
              ${['true', 'false'].map(v => `
                <button type="button" data-tf="${v}" class="px-3 py-1 rounded-md font-medium ${String(!!q.correct) === v ? 'bg-white shadow-xs text-slate-900' : 'text-slate-500 hover:text-slate-800'}">${v === 'true' ? 'True' : 'False'}</button>`).join('')}
            </div>
          </div>`;
      case 'short_text':
        return `
          <div class="space-y-3">
            <div class="text-sm font-medium text-slate-700">Accepted answers</div>
            ${chips(q.accepted, 'accepted')}
            <div class="flex flex-wrap gap-x-6 gap-y-2">
              <sl-switch size="small" data-bool="allow_typo" ${q.allow_typo ? 'checked' : ''}>Allow one typo</sl-switch>
              <sl-switch size="small" data-bool="case_sensitive" ${q.case_sensitive ? 'checked' : ''}>Case-sensitive</sl-switch>
            </div>
          </div>`;
      case 'numeric':
        return `
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <sl-input size="small" data-num="target" type="text" inputmode="decimal" label="Correct value" value="${esc(q.target)}"></sl-input>
            <sl-input size="small" data-num="tolerance" type="text" inputmode="decimal" label="Tolerance ±" value="${esc(q.tolerance)}"></sl-input>
            <sl-select size="small" data-field="tolerance_type" label="Tolerance type" value="${esc(q.tolerance_type || 'absolute')}">
              <sl-option value="absolute">Absolute</sl-option>
              <sl-option value="percent">Percent</sl-option>
            </sl-select>
            <sl-input size="small" data-text="unit" label="Unit (shown)" value="${esc(q.unit || '')}" placeholder="e.g. mol"></sl-input>
          </div>
          <p class="text-xs text-slate-500 mt-2">Students may type 6.02e23, 6.02 × 10^23, or use a comma decimal.</p>`;
      case 'fill_blank':
        return `
          <div class="space-y-3">
            <p class="text-xs text-slate-500">Type <code class="px-1 rounded bg-slate-100">[[blank]]</code> in the prompt for each gap, or use the button.</p>
            ${(q.blanks || []).map((b, i) => `
              <div class="flex flex-col sm:flex-row sm:items-start gap-2" data-blank="${i}">
                <span class="text-sm font-semibold text-slate-600 w-20 pt-1">Blank ${i + 1}</span>
                <div class="flex-1">${chips(b.accepted, `blank-${i}`)}</div>
              </div>`).join('') || '<p class="text-sm text-amber-700">No blanks in the prompt yet.</p>'}
            <div class="flex flex-wrap items-end justify-between gap-3">
              <div class="flex flex-wrap gap-x-6 gap-y-2">
                <sl-switch size="small" data-bool="allow_typo" ${q.allow_typo ? 'checked' : ''}>Allow one typo</sl-switch>
                <sl-switch size="small" data-bool="case_sensitive" ${q.case_sensitive ? 'checked' : ''}>Case-sensitive</sl-switch>
              </div>
              ${scoringSelect(q)}
            </div>
          </div>`;
      case 'ordering':
        return `
          <div class="space-y-2">
            <p class="text-xs text-slate-500">List items in the <strong>correct</strong> order. Students see them shuffled.</p>
            ${(q.items || []).map((it, i) => `
              <div class="flex items-center gap-2">
                <span class="w-7 h-7 flex-shrink-0 rounded-lg bg-slate-100 text-slate-600 text-sm font-semibold flex items-center justify-center tabular-nums">${i + 1}</span>
                <sl-input size="small" class="flex-1" data-item-text="${i}" value="${esc(it.text)}" placeholder="Item ${i + 1}"></sl-input>
                <button type="button" class="kb-icon-btn" data-item-move="${i}:-1" aria-label="Move item up" ${i === 0 ? 'disabled' : ''}><sl-icon name="arrow-up"></sl-icon></button>
                <button type="button" class="kb-icon-btn" data-item-move="${i}:1" aria-label="Move item down" ${i === q.items.length - 1 ? 'disabled' : ''}><sl-icon name="arrow-down"></sl-icon></button>
                <button type="button" class="kb-icon-btn hover:!text-red-600" data-item-remove="${i}" aria-label="Remove item"><sl-icon name="x-lg"></sl-icon></button>
              </div>`).join('')}
            <div class="flex flex-wrap items-end justify-between gap-3 pt-1">
              <sl-button size="small" variant="text" data-item-add><sl-icon slot="prefix" name="plus-lg"></sl-icon> Add item</sl-button>
              ${scoringSelect(q)}
            </div>
          </div>`;
      case 'matching':
        return `
          <div class="space-y-2">
            ${(q.pairs || []).map((p, i) => `
              <div class="flex flex-col sm:flex-row sm:items-center gap-2">
                <sl-input size="small" class="flex-1" data-pair-left="${i}" value="${esc(p.left)}" placeholder="Prompt ${i + 1}"></sl-input>
                <sl-icon name="arrow-right" class="hidden sm:block text-slate-400 flex-shrink-0"></sl-icon>
                <div class="flex items-center gap-2 flex-1">
                  <sl-input size="small" class="flex-1" data-pair-right="${i}" value="${esc(p.right)}" placeholder="Match ${i + 1}"></sl-input>
                  <button type="button" class="kb-icon-btn hover:!text-red-600" data-pair-remove="${i}" aria-label="Remove pair"><sl-icon name="x-lg"></sl-icon></button>
                </div>
              </div>`).join('')}
            <sl-button size="small" variant="text" data-pair-add><sl-icon slot="prefix" name="plus-lg"></sl-icon> Add pair</sl-button>
            <div class="pt-2 space-y-2">
              <div class="text-sm font-medium text-slate-700">Extra wrong answers <span class="font-normal text-slate-400">(optional)</span></div>
              ${chips(q.distractors, 'distractors')}
            </div>
            <div class="flex justify-end">${scoringSelect(q)}</div>
          </div>`;
      case 'long_text':
        return `
          <sl-textarea size="small" data-text="rubric_hint" rows="2" resize="auto" label="Grading notes (only you see these)" value="${esc(q.rubric_hint || '')}" placeholder="What does a full-credit answer include?"></sl-textarea>`;
      default:
        return '';
    }
  }

  function questionCard(q, idx) {
    const meta = QUESTION_TYPE_META[q.type] || { label: q.type, icon: 'question' };
    const issues = validateQuestion(q);
    const showPreview = /\$|\\ce|\*\*/.test(q.prompt || '');
    return `
      <article class="bg-white rounded-2xl border border-slate-200 shadow-xs" data-q-index="${idx}" aria-label="Question ${idx + 1}">
        <header class="flex items-center gap-3 px-5 py-3 border-b border-slate-200">
          <span class="w-8 h-8 flex-shrink-0 rounded-lg bg-amber-50 text-amber-700 flex items-center justify-center font-semibold text-sm tabular-nums">${idx + 1}</span>
          <span class="flex items-center gap-1.5 text-sm font-medium text-slate-700 min-w-0">
            <sl-icon name="${meta.icon}" class="text-slate-500 flex-shrink-0"></sl-icon><span class="truncate">${esc(meta.label)}</span>
          </span>
          <div class="ml-auto flex items-center gap-1">
            <sl-input size="small" type="number" min="0" step="0.5" data-points value="${esc(q.points)}" class="w-20" aria-label="Points"><span slot="suffix" class="text-xs text-slate-400">pts</span></sl-input>
            <button type="button" class="kb-icon-btn" data-q-move="-1" aria-label="Move question up" ${idx === 0 ? 'disabled' : ''}><sl-icon name="chevron-up"></sl-icon></button>
            <button type="button" class="kb-icon-btn" data-q-move="1" aria-label="Move question down" ${idx === a.questions.length - 1 ? 'disabled' : ''}><sl-icon name="chevron-down"></sl-icon></button>
            <button type="button" class="kb-icon-btn" data-q-dup aria-label="Duplicate question"><sl-icon name="copy"></sl-icon></button>
            <button type="button" class="kb-icon-btn hover:!text-red-600" data-q-del aria-label="Delete question"><sl-icon name="trash"></sl-icon></button>
          </div>
        </header>
        <div class="p-5 space-y-4">
          <div class="space-y-2">
            <sl-textarea data-prompt rows="2" resize="auto" label="Prompt" value="${esc(q.prompt)}" placeholder="Ask your question. Markdown, $math$ and \\ce{chemistry} supported."></sl-textarea>
            ${q.type === 'fill_blank' ? '<sl-button size="small" variant="text" data-insert-blank><sl-icon slot="prefix" name="input-cursor"></sl-icon> Insert blank</sl-button>' : ''}
            <div class="kb-prose text-sm text-slate-700 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 ${showPreview ? '' : 'hidden'}" data-prompt-preview>${showPreview ? Sanitizer.renderSTEMMarkdown(q.prompt) : ''}</div>
          </div>
          <div data-type-body>${typeBody(q)}</div>
          ${q.type !== 'long_text' ? `<sl-input size="small" data-explanation label="Explanation (shown after answering, optional)" value="${esc(q.explanation || '')}"></sl-input>` : ''}
          ${issues.length ? `<p class="text-xs text-amber-700 flex items-center gap-1.5" data-issues><sl-icon name="exclamation-triangle"></sl-icon>${esc(issues.join(' '))}</p>` : '<p class="hidden" data-issues></p>'}
        </div>
      </article>`;
  }

  function renderQuestions() {
    if (a.questions.length === 0) {
      listEl.innerHTML = `
        <div class="p-10 text-center bg-white rounded-2xl border border-dashed border-slate-300 space-y-3">
          <span class="w-12 h-12 mx-auto rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center text-2xl"><sl-icon name="ui-checks"></sl-icon></span>
          <h3 class="font-semibold text-slate-900">No questions yet</h3>
          <p class="text-sm text-slate-500 max-w-sm mx-auto">Add multiple choice, short answer, numeric, fill-in-the-blank, ordering, matching, or long-response questions.</p>
          <div class="pt-2">
            <sl-button size="small" variant="default" id="asg-empty-import-csv">
              <sl-icon slot="prefix" name="upload"></sl-icon> Import from CSV / Spreadsheet…
            </sl-button>
          </div>
        </div>`;
      listEl.querySelector('#asg-empty-import-csv')?.addEventListener('click', () => {
        openImportQuestionsDialog();
      });
      updateSummary();
      return;
    }
    listEl.innerHTML = a.questions.map(questionCard).join('');
    listEl.querySelectorAll('[data-q-index]').forEach(card => bindCard(card, Number(card.dataset.qIndex)));
    updateSummary();
  }

  function rerenderCard(idx) {
    const old = listEl.querySelector(`[data-q-index="${idx}"]`);
    if (!old) return renderQuestions();
    const tmp = document.createElement('div');
    tmp.innerHTML = questionCard(a.questions[idx], idx);
    const fresh = tmp.firstElementChild;
    old.replaceWith(fresh);
    bindCard(fresh, idx);
  }

  function refreshIssues(card, q) {
    const el = card.querySelector('[data-issues]');
    const issues = validateQuestion(q);
    if (!el) return;
    if (issues.length) {
      el.className = 'text-xs text-amber-700 flex items-center gap-1.5';
      el.innerHTML = `<sl-icon name="exclamation-triangle"></sl-icon>${esc(issues.join(' '))}`;
    } else {
      el.className = 'hidden';
      el.innerHTML = '';
    }
  }

  function syncBlanks(q) {
    const n = countBlanks(q.prompt);
    q.blanks = q.blanks || [];
    if (q.blanks.length === n) return false;
    while (q.blanks.length < n) q.blanks.push({ accepted: [] });
    q.blanks.length = n;
    return true;
  }

  function bindChips(card, q, idx) {
    card.querySelectorAll('[data-chips]').forEach(group => {
      const field = group.dataset.chips;
      const getList = () => {
        if (field.startsWith('blank-')) return q.blanks[Number(field.slice(6))].accepted;
        q[field] = q[field] || [];
        return q[field];
      };
      const input = group.querySelector('[data-chip-input]');
      const add = () => {
        const v = String(input.value || '').trim();
        if (!v) return;
        const list = getList();
        if (!list.some(x => x.toLowerCase() === v.toLowerCase())) list.push(v);
        save();
        rerenderCard(idx);
        listEl.querySelector(`[data-q-index="${idx}"] [data-chips="${field}"] [data-chip-input]`)?.focus();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          add();
        }
      });
      input.addEventListener('sl-blur', () => { if (String(input.value || '').trim()) add(); });
      group.querySelectorAll('[data-chip-remove]').forEach(btn => btn.addEventListener('click', () => {
        getList().splice(Number(btn.dataset.chipRemove), 1);
        save();
        rerenderCard(idx);
      }));
    });
  }

  function bindCard(card, idx) {
    const q = a.questions[idx];
    const touch = () => { save(); refreshIssues(card, q); };

    card.querySelector('[data-points]').addEventListener('sl-input', (e) => { q.points = Math.max(0, Number(e.target.value) || 0); save(); });

    const prompt = card.querySelector('[data-prompt]');
    prompt.addEventListener('sl-input', () => {
      q.prompt = prompt.value;
      const preview = card.querySelector('[data-prompt-preview]');
      const show = /\$|\\ce|\*\*/.test(q.prompt || '');
      preview.classList.toggle('hidden', !show);
      if (show) preview.innerHTML = Sanitizer.renderSTEMMarkdown(q.prompt);
      if (q.type === 'fill_blank' && syncBlanks(q)) {
        card.querySelector('[data-type-body]').innerHTML = typeBody(q);
        bindTypeBody(card, q, idx);
      }
      touch();
    });

    card.querySelector('[data-insert-blank]')?.addEventListener('click', () => {
      const start = typeof prompt.selectionStart === 'number' ? prompt.selectionStart : (q.prompt || '').length;
      const end = typeof prompt.selectionEnd === 'number' ? prompt.selectionEnd : start;
      const text = q.prompt || '';
      q.prompt = `${text.slice(0, start)}[[blank]]${text.slice(end)}`;
      syncBlanks(q);
      save();
      rerenderCard(idx);
    });

    card.querySelector('[data-explanation]')?.addEventListener('sl-input', (e) => { q.explanation = e.target.value; save(); });

    card.querySelectorAll('[data-q-move]').forEach(btn => btn.addEventListener('click', () => {
      const to = idx + Number(btn.dataset.qMove);
      if (to < 0 || to >= a.questions.length) return;
      [a.questions[idx], a.questions[to]] = [a.questions[to], a.questions[idx]];
      save();
      renderQuestions();
      listEl.querySelector(`[data-q-index="${to}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }));
    card.querySelector('[data-q-dup]').addEventListener('click', () => {
      a.questions.splice(idx + 1, 0, cloneQuestion(q));
      save();
      renderQuestions();
    });
    card.querySelector('[data-q-del]').addEventListener('click', async () => {
      const ok = await ConfirmDialog.show({ title: 'Delete question', message: `Delete question ${idx + 1}? This cannot be undone.`, confirmText: 'Delete', variant: 'danger' });
      if (!ok) return;
      a.questions.splice(idx, 1);
      save();
      renderQuestions();
    });

    bindTypeBody(card, q, idx);
  }

  function bindTypeBody(card, q, idx) {
    const touch = () => { save(); refreshIssues(card, q); };
    const body = card.querySelector('[data-type-body]');

    // Choice options
    body.querySelectorAll('[data-opt-text]').forEach(el => el.addEventListener('sl-input', () => { q.options[Number(el.dataset.optText)].text = el.value; touch(); }));
    body.querySelectorAll('[data-opt-correct]').forEach(btn => btn.addEventListener('click', () => {
      const i = Number(btn.dataset.optCorrect);
      if (q.type === 'single_choice') q.options.forEach((o, j) => { o.is_correct = j === i; });
      else q.options[i].is_correct = !q.options[i].is_correct;
      save();
      rerenderCard(idx);
    }));
    body.querySelectorAll('[data-opt-remove]').forEach(btn => btn.addEventListener('click', () => {
      q.options.splice(Number(btn.dataset.optRemove), 1);
      save();
      rerenderCard(idx);
    }));
    body.querySelector('[data-opt-add]')?.addEventListener('click', () => {
      q.options.push({ id: shortId(), text: '', is_correct: false });
      save();
      rerenderCard(idx);
      const inputs = listEl.querySelectorAll(`[data-q-index="${idx}"] [data-opt-text]`);
      inputs[inputs.length - 1]?.focus();
    });

    // True / false
    body.querySelectorAll('[data-tf]').forEach(btn => btn.addEventListener('click', () => {
      q.correct = btn.dataset.tf === 'true';
      save();
      rerenderCard(idx);
    }));

    // Generic fields
    body.querySelectorAll('[data-field]').forEach(el => el.addEventListener('sl-change', () => { q[el.dataset.field] = el.value; touch(); }));
    body.querySelectorAll('[data-bool]').forEach(el => el.addEventListener('sl-change', () => { q[el.dataset.bool] = el.checked; touch(); }));
    body.querySelectorAll('[data-num]').forEach(el => el.addEventListener('sl-input', () => {
      const n = Number(String(el.value).replace(',', '.'));
      q[el.dataset.num] = Number.isFinite(n) ? n : el.value;
      touch();
    }));
    body.querySelectorAll('[data-text]').forEach(el => el.addEventListener('sl-input', () => { q[el.dataset.text] = el.value; touch(); }));

    // Ordering
    body.querySelectorAll('[data-item-text]').forEach(el => el.addEventListener('sl-input', () => { q.items[Number(el.dataset.itemText)].text = el.value; touch(); }));
    body.querySelectorAll('[data-item-move]').forEach(btn => btn.addEventListener('click', () => {
      const [i, d] = btn.dataset.itemMove.split(':').map(Number);
      const j = i + d;
      if (j < 0 || j >= q.items.length) return;
      [q.items[i], q.items[j]] = [q.items[j], q.items[i]];
      save();
      rerenderCard(idx);
    }));
    body.querySelectorAll('[data-item-remove]').forEach(btn => btn.addEventListener('click', () => {
      q.items.splice(Number(btn.dataset.itemRemove), 1);
      save();
      rerenderCard(idx);
    }));
    body.querySelector('[data-item-add]')?.addEventListener('click', () => {
      q.items.push({ id: shortId(), text: '' });
      save();
      rerenderCard(idx);
    });

    // Matching
    body.querySelectorAll('[data-pair-left]').forEach(el => el.addEventListener('sl-input', () => { q.pairs[Number(el.dataset.pairLeft)].left = el.value; touch(); }));
    body.querySelectorAll('[data-pair-right]').forEach(el => el.addEventListener('sl-input', () => { q.pairs[Number(el.dataset.pairRight)].right = el.value; touch(); }));
    body.querySelectorAll('[data-pair-remove]').forEach(btn => btn.addEventListener('click', () => {
      q.pairs.splice(Number(btn.dataset.pairRemove), 1);
      save();
      rerenderCard(idx);
    }));
    body.querySelector('[data-pair-add]')?.addEventListener('click', () => {
      q.pairs.push({ id: shortId(), left: '', right: '' });
      save();
      rerenderCard(idx);
    });

    bindChips(card, q, idx);
  }

  // ---------------------------------------------------------------------------
  // Settings & header bindings
  // ---------------------------------------------------------------------------

  const on = (sel, evt, fn) => container.querySelector(sel)?.addEventListener(evt, fn);
  on('#asg-title', 'sl-input', (e) => { a.title = e.target.value.trim() || 'Untitled assignment'; save(); });
  on('#asg-instructions', 'sl-input', (e) => { a.instructions = e.target.value; save(); });
  on('#asg-course', 'sl-change', async (e) => {
    const cid = e.target.value || null;
    syncAssignmentCourseId(a, cid);
    await syncContentClassLink(a, 'assignments', cid);
    renderCategory();
    save();
  });
  on('#asg-republish-stale-btn', 'click', () => {
    container.querySelector('#asg-publish')?.click();
  });
  on('#asg-preset-formative', 'click', () => {
    a.settings.feedback_mode = 'immediate';
    a.settings.release_grade_immediately = true;
    a.settings.show_correct_answers = true;
    a.settings.require_access_code = false;
    const fb = container.querySelector('#asg-feedback'); if (fb) fb.value = 'immediate';
    const rel = container.querySelector('#asg-release-grade'); if (rel) rel.checked = true;
    const sha = container.querySelector('#asg-show-answers'); if (sha) sha.checked = true;
    const req = container.querySelector('#asg-require-code'); if (req) req.checked = false;
    save();
    toast.success('Applied Formative Practice preset: instant feedback & score release enabled.');
  });
  on('#asg-preset-summative', 'click', () => {
    a.settings.feedback_mode = 'none';
    a.settings.release_grade_immediately = false;
    a.settings.show_correct_answers = false;
    a.settings.require_access_code = true;
    const fb = container.querySelector('#asg-feedback'); if (fb) fb.value = 'none';
    const rel = container.querySelector('#asg-release-grade'); if (rel) rel.checked = false;
    const sha = container.querySelector('#asg-show-answers'); if (sha) sha.checked = false;
    const req = container.querySelector('#asg-require-code'); if (req) req.checked = true;
    save();
    toast.success('Applied Summative (Blind) preset: feedback, auto-release, and answers disabled.');
  });
  on('#asg-due', 'sl-change', (e) => {
    a.settings.due_date = e.target.value || '';
    setDue('assignment', a.id, { date: a.settings.due_date, time: a.settings.due_time }).catch(() => {});
    save();
  });
  on('#asg-due-time', 'sl-change', (e) => {
    a.settings.due_time = e.target.value || '';
    setDue('assignment', a.id, { date: a.settings.due_date, time: a.settings.due_time }).catch(() => {});
    save();
  });
  on('#asg-feedback', 'sl-change', (e) => { a.settings.feedback_mode = e.target.value; save(); });
  const sw = (sel, key) => on(sel, 'sl-change', (e) => { a.settings[key] = e.target.checked; save(); });
  sw('#asg-release-grade', 'release_grade_immediately');
  sw('#asg-show-answers', 'show_correct_answers');
  sw('#asg-shuffle-q', 'shuffle_questions');
  sw('#asg-shuffle-o', 'shuffle_options');
  sw('#asg-require-code', 'require_access_code');

  container.querySelectorAll('.asg-add-menu').forEach(menu => menu.addEventListener('sl-select', (e) => {
    const q = createQuestion(e.detail.item.value);
    a.questions.push(q);
    save();
    renderQuestions();
    const card = listEl.querySelector(`[data-q-index="${a.questions.length - 1}"]`);
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => card?.querySelector('[data-prompt]')?.focus(), 300);
  }));

  function openImportQuestionsDialog() {
    CSVImportDialog.open({
      title: 'Import Questions into Assignment',
      subtitle: 'Upload a .kbshare assignment, JSON or CSV file, or paste rows from Google Sheets/Excel to append questions.',
      templateFilename: 'assignment_template.csv',
      templateContent: ASSIGNMENT_CSV_TEMPLATE,
      schema: AssignmentQuestionRowSchema,
      acceptJson: true,
      acceptKbShare: true,
      onImport: async (resultData, rawText, { isKbShare, isJson } = {}) => {
        if (!resultData) return;
        let questionsToAdd = [];
        const data = (resultData && typeof resultData === 'object' && resultData.payload) ? resultData.payload : resultData;
        if (Array.isArray(data)) {
          questionsToAdd = data;
        } else if (Array.isArray(data?.questions)) {
          questionsToAdd = data.questions;
        } else if (Array.isArray(resultData?.questions)) {
          questionsToAdd = resultData.questions;
        }

        if (questionsToAdd.length === 0) {
          toast.warning('No valid questions found to import.');
          return;
        }
        ContentImporter.mergeQuestionsIntoAssignment(a, questionsToAdd);
        await save(true);
        renderQuestions();
        toast.success(`Imported ${questionsToAdd.length} question${questionsToAdd.length === 1 ? '' : 's'}!`);
      }
    });
  }

  const importExportMenu = container.querySelector('#asg-import-export-menu');
  importExportMenu?.addEventListener('sl-select', (e) => {
    const val = e.detail?.item?.value;
    if (val === 'import-csv') {
      openImportQuestionsDialog();
    } else if (val === 'download-template') {
      downloadCSVTemplate('assignment_template.csv', ASSIGNMENT_CSV_TEMPLATE);
    } else if (val === 'export-csv') {
      if (!a.questions || a.questions.length === 0) {
        toast.warning('This assignment has no questions to export.');
        return;
      }
      const csvStr = Exporter.assignmentToCSV(a.questions);
      const safeTitle = (a.title || 'assignment').trim().replace(/[^a-zA-Z0-9_\-]+/g, '_');
      downloadCSV(`${safeTitle}_questions.csv`, csvStr);
      toast.success('Questions exported to CSV!');
    }
  });

  on('#asg-quick-import-csv', 'click', () => {
    openImportQuestionsDialog();
  });

  on('#asg-back', 'click', async () => { await save(true); router.navigate('#/assessments'); });
  on('#asg-preview', 'click', async () => { await save(true); router.navigate(`#/assessments/take?preview=${a.id}`); });
  on('#asg-submissions', 'click', async () => { await save(true); router.navigate(`#/assessments/submissions?id=${a.id}`); });
  on('#asg-publish', 'click', async () => {
    await save(true);
    openPublishDialog(a);
  });

  renderCategory();
  renderQuestions();

  return () => {
    // Flush a pending save when navigating away
    if (saveTimer) {
      clearTimeout(saveTimer);
      a.updated_at = new Date().toISOString();
      storage.table('assignments').put(JSON.parse(JSON.stringify(a)));
    }
  };
}
