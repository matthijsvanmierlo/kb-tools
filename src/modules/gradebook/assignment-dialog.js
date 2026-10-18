import { Sanitizer } from '../../core/sanitizer.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { getStandards, getMaxLevel } from './grading-scales.js';

/**
 * Gradebook Assignment Dialog (create + edit) (KB-GRAD-009)
 * Scoring type (points or proficiency), category, term, due date, rubric, standards alignment,
 * and — when editing — bulk column actions.
 */

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

export function openAssignmentDialog({ assignment = null, course, rubrics = [], students = [], gradesMap = new Map(), onSave, onBulkFill, onDelete, onOpenSettings }) {
  const isEdit = !!assignment;
  const standards = getStandards(course);
  const maxLevel = getMaxLevel(course);
  const current = isEdit
    ? JSON.parse(JSON.stringify(assignment))
    : {
        id: generateUUID(),
        course_id: course.id,
        term_id: course.terms?.[0]?.id || null,
        category_id: course.categories?.[0]?.id || null,
        title: '',
        max_score: 100,
        due_date: new Date().toISOString().split('T')[0],
        scoring: course.grading_scale === 'sbg' ? 'proficiency' : 'points',
        standard_ids: []
      };
  current.scoring = current.scoring || 'points';
  current.standard_ids = current.standard_ids || [];

  const dialog = document.createElement('sl-dialog');
  dialog.label = isEdit ? 'Edit assignment' : 'New assignment';
  dialog.style.setProperty('--width', 'min(620px, 96vw)');

  const render = () => {
    const isProf = current.scoring === 'proficiency';
    dialog.innerHTML = `
      <div class="space-y-5">
        <sl-input id="as-title" label="Title" placeholder="e.g. Unit 3 Quiz: Stoichiometry" value="${esc(current.title)}" required autofocus></sl-input>

        <div class="space-y-2">
          <span class="text-[0.8125rem] font-semibold text-slate-900">Scoring</span>
          <sl-radio-group id="as-scoring" value="${esc(current.scoring)}">
            <sl-radio-button value="points"><sl-icon slot="prefix" name="123"></sl-icon> Points</sl-radio-button>
            <sl-radio-button value="proficiency"><sl-icon slot="prefix" name="bullseye"></sl-icon> Proficiency (0–${esc(maxLevel)})</sl-radio-button>
          </sl-radio-group>
          <p class="text-xs text-slate-500">${isProf ? 'Score each student on the proficiency scale for every aligned standard.' : 'Enter points earned; percentages and letters follow the class grading scale.'}</p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <sl-select id="as-cat" label="Category" value="${esc(current.category_id)}">
            ${(course.categories || []).map(c => `<sl-option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.weight_pct)}%</sl-option>`).join('')}
          </sl-select>
          ${isProf ? `
            <sl-input label="Scale" value="0 – ${esc(maxLevel)}" disabled></sl-input>
          ` : `
            <sl-input id="as-max" label="Max points" type="number" min="1" value="${esc(current.max_score || 100)}"></sl-input>
          `}
          <sl-input id="as-due" label="Due date" type="date" value="${esc(current.due_date || '')}"></sl-input>
          ${(course.terms || []).length > 1 ? `
            <sl-select id="as-term" label="Term" value="${esc(current.term_id)}">
              ${course.terms.map(t => `<sl-option value="${esc(t.id)}">${esc(t.name)}</sl-option>`).join('')}
            </sl-select>` : '<div class="hidden sm:block"></div>'}
          <sl-select id="as-rubric" label="Rubric" value="${esc(current.rubric_id)}" class="sm:col-span-2">
            <sl-option value="">No rubric</sl-option>
            ${rubrics.map(r => `<sl-option value="${esc(r.id)}">${esc(r.title)}</sl-option>`).join('')}
          </sl-select>
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-[0.8125rem] font-semibold text-slate-900">Aligned standards</span>
            ${onOpenSettings ? '<button type="button" id="as-manage-standards" class="text-xs font-medium text-blue-600 hover:underline">Manage standards</button>' : ''}
          </div>
          ${standards.length ? `
            <sl-select id="as-standards" multiple clearable max-options-visible="4" placeholder="Choose standards this assignment assesses" value="${esc(current.standard_ids.join(' '))}">
              ${standards.map(s => `<sl-option value="${esc(s.id)}">${esc(s.code)}<span slot="suffix" class="text-[11px] text-slate-400 max-w-[260px] truncate">${esc(s.description)}</span></sl-option>`).join('')}
            </sl-select>
          ` : `
            <p class="text-xs text-slate-500 rounded-lg border border-dashed border-slate-300 p-3">This class has no standards yet. Add or import them in class settings → Standards.</p>
          `}
        </div>

        ${isEdit ? `
          <div class="rounded-xl border border-slate-200 p-4 space-y-3">
            <span class="text-[0.8125rem] font-semibold text-slate-900">Whole-column actions</span>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              ${isProf ? '' : `<sl-button size="small" id="as-bulk-max"><sl-icon slot="prefix" name="check-all"></sl-icon> Fill empty with ${esc(current.max_score)}</sl-button>`}
              <sl-button size="small" id="as-bulk-missing"><sl-icon slot="prefix" name="exclamation-octagon"></sl-icon> Mark empty as missing</sl-button>
              <sl-button size="small" id="as-bulk-late"><sl-icon slot="prefix" name="clock-history"></sl-icon> Mark empty as late</sl-button>
              <sl-button size="small" id="as-bulk-clear"><sl-icon slot="prefix" name="eraser"></sl-icon> Clear all scores</sl-button>
            </div>
          </div>
        ` : ''}
      </div>

      <div slot="footer" class="flex items-center justify-between gap-2 w-full">
        ${isEdit ? '<sl-button variant="danger" outline id="as-delete"><sl-icon slot="prefix" name="trash"></sl-icon> Delete</sl-button>' : '<span></span>'}
        <div class="flex gap-2">
          <sl-button id="as-cancel">Cancel</sl-button>
          <sl-button variant="primary" id="as-save">${isEdit ? 'Save changes' : 'Create assignment'}</sl-button>
        </div>
      </div>`;
    bind();
  };

  const readForm = () => {
    current.title = dialog.querySelector('#as-title')?.value.trim() || '';
    current.category_id = dialog.querySelector('#as-cat')?.value || current.category_id;
    current.due_date = dialog.querySelector('#as-due')?.value || '';
    current.term_id = dialog.querySelector('#as-term')?.value || current.term_id;
    current.rubric_id = dialog.querySelector('#as-rubric')?.value || undefined;
    const stdSel = dialog.querySelector('#as-standards');
    if (stdSel) current.standard_ids = Array.isArray(stdSel.value) ? stdSel.value : [];
    if (current.scoring === 'proficiency') current.max_score = maxLevel;
    else current.max_score = Number(dialog.querySelector('#as-max')?.value) || current.max_score || 100;
  };

  const emptyCells = () => students.filter(st => {
    const rec = gradesMap.get(`${st.student_id}+${current.id}`);
    return !rec || (rec.raw_score === null && rec.status !== 'exempt' && rec.status !== 'missing');
  });

  const bulk = (mapper) => {
    const updates = emptyCells().map(st => ({
      ...(gradesMap.get(`${st.student_id}+${current.id}`) || {}),
      course_id: course.id,
      student_id: st.student_id,
      assignment_id: current.id,
      ...mapper(st)
    }));
    if (!updates.length) { toast.info('Every student already has an entry.'); return; }
    dialog.hide();
    onBulkFill(updates);
  };

  function bind() {
    dialog.querySelector('#as-scoring')?.addEventListener('sl-change', (e) => {
      readForm();
      current.scoring = e.target.value;
      render();
    });
    dialog.querySelector('#as-manage-standards')?.addEventListener('click', () => {
      dialog.hide();
      onOpenSettings?.('standards');
    });
    dialog.querySelector('#as-cancel')?.addEventListener('click', () => dialog.hide());
    dialog.querySelector('#as-save')?.addEventListener('click', () => {
      readForm();
      if (!current.title) { toast.warning('Give the assignment a title.'); return; }
      dialog.hide();
      onSave(current);
    });
    dialog.querySelector('#as-bulk-max')?.addEventListener('click', () => bulk(() => ({ raw_score: current.max_score, status: 'submitted' })));
    dialog.querySelector('#as-bulk-missing')?.addEventListener('click', () => bulk(() => ({ raw_score: null, status: 'missing' })));
    dialog.querySelector('#as-bulk-late')?.addEventListener('click', () => bulk(() => ({ raw_score: null, status: 'late', days_late: 1 })));
    dialog.querySelector('#as-bulk-clear')?.addEventListener('click', async () => {
      const ok = await ConfirmDialog.show({ title: 'Clear all scores', message: 'Clear every grade in this column? You can undo with Ctrl+Z.', confirmText: 'Clear', variant: 'danger' });
      if (!ok) return;
      dialog.hide();
      onBulkFill(students.map(st => ({ course_id: course.id, student_id: st.student_id, assignment_id: current.id, raw_score: null, status: 'submitted' })));
    });
    dialog.querySelector('#as-delete')?.addEventListener('click', async () => {
      const ok = await ConfirmDialog.show({ title: 'Delete assignment', message: `Delete "${esc(current.title)}" and all of its grades?`, confirmText: 'Delete', variant: 'danger' });
      if (!ok) return;
      dialog.hide();
      onDelete(current.id);
    });
  }

  dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
  document.body.appendChild(dialog);
  render();
  dialog.show();
  return dialog;
}

export default openAssignmentDialog;
