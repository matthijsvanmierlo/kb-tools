import { Sanitizer } from '../../core/sanitizer.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { getStandards, getMaxLevel } from './grading-scales.js';
import { storage } from '../../core/storage.js';
import { openPublishDialog } from '../assignments/publish.js';
import { openVideoShareDialog } from '../video/share-video.js';
import { syncContentClassLink } from './bridge.js';

/**
 * Gradebook Assignment Dialog (create + edit) (KB-GRAD-009)
 * Scoring type (points or proficiency), category, term, due date, rubric, standards alignment,
 * interactive content linkage & share link generation, and whole-column actions.
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
        standard_ids: [],
        source: null
      };
  current.scoring = current.scoring || 'points';
  current.standard_ids = current.standard_ids || [];

  let interactiveAssignments = [];
  let interactiveVideos = [];
  let interactiveTasks = [];

  const dialog = document.createElement('sl-dialog');
  dialog.label = isEdit ? 'Edit assignment' : 'New assignment';
  dialog.style.setProperty('--width', 'min(640px, 96vw)');

  const render = () => {
    const isProf = current.scoring === 'proficiency';
    const sourceType = current.source?.type || 'none';

    dialog.innerHTML = `
      <div class="space-y-5">
        <sl-input id="as-title" label="Title" placeholder="e.g. Unit 3 Quiz: Stoichiometry" value="${esc(current.title)}" required autofocus></sl-input>

        <!-- Interactive Content & Student Share Link Section -->
        <div class="rounded-xl border border-slate-200 p-4 space-y-3 bg-slate-50/70">
          <div class="flex items-center justify-between">
            <span class="text-[0.8125rem] font-semibold text-slate-900 flex items-center gap-1.5">
              <sl-icon name="link-45deg" class="text-blue-600"></sl-icon> Interactive Content &amp; Student Share Link
            </span>
            <span class="text-[11px] text-slate-400">Syncs submissions to this column</span>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <sl-select id="as-source-type" label="Linked tool" value="${esc(sourceType)}">
              <sl-option value="none">None (Manual Gradebook Column)</sl-option>
              <sl-option value="task"><sl-icon slot="prefix" name="journal-text"></sl-icon> Assignment</sl-option>
              <sl-option value="assignment"><sl-icon slot="prefix" name="ui-checks"></sl-icon> Interactive Assessment</sl-option>
              <sl-option value="video"><sl-icon slot="prefix" name="play-circle"></sl-icon> Video Assessment</sl-option>
            </sl-select>

            <div id="as-source-picker-container" class="${sourceType !== 'none' ? '' : 'hidden'}">
              <!-- Dynamically rendered -->
            </div>
          </div>

          <div id="as-source-actions-container" class="flex flex-wrap items-center gap-2 pt-1 ${current.source?.id ? '' : 'hidden'}">
            <sl-button size="small" variant="primary" id="as-btn-share-link">
              <sl-icon slot="prefix" name="share"></sl-icon> Get Student Share Link
            </sl-button>
            <sl-button size="small" id="as-btn-open-editor">
              <sl-icon slot="prefix" name="box-arrow-up-right"></sl-icon> Open in Editor
            </sl-button>
          </div>
        </div>

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
    updateSourcePicker();
  };

  const updateSourcePicker = () => {
    const container = dialog.querySelector('#as-source-picker-container');
    const actions = dialog.querySelector('#as-source-actions-container');
    if (!container) return;

    const type = current.source?.type;
    if (!type || type === 'none') {
      container.classList.add('hidden');
      if (actions) actions.classList.add('hidden');
      return;
    }

    container.classList.remove('hidden');
    if (actions) {
      if (current.source?.id) actions.classList.remove('hidden');
      else actions.classList.add('hidden');
    }

    if (type === 'task') {
      container.innerHTML = `
        <div class="flex items-end gap-2">
          <sl-select id="as-source-item-select" label="Linked Assignment" value="${esc(current.source?.id || '')}" class="flex-1">
            <sl-option value="">-- Choose assignment --</sl-option>
            ${interactiveTasks.map(t => `<sl-option value="${esc(t.id)}">${esc(t.title || 'Untitled')}${t.class_id === course.id ? ' (This class)' : ''}</sl-option>`).join('')}
          </sl-select>
          <sl-button size="medium" id="as-source-item-create" title="Create new assignment linked to this class">
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> New
          </sl-button>
        </div>
      `;
    } else if (type === 'assignment') {
      container.innerHTML = `
        <div class="flex items-end gap-2">
          <sl-select id="as-source-item-select" label="Linked Assessment" value="${esc(current.source?.id || '')}" class="flex-1">
            <sl-option value="">-- Choose assessment --</sl-option>
            ${interactiveAssignments.map(a => `<sl-option value="${esc(a.id)}">${esc(a.title || 'Untitled')}${a.class_id === course.id ? ' (This class)' : ''}</sl-option>`).join('')}
          </sl-select>
          <sl-button size="medium" id="as-source-item-create" title="Create new assessment linked to this class">
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> New
          </sl-button>
        </div>
      `;
    } else if (type === 'video') {
      container.innerHTML = `
        <div class="flex items-end gap-2">
          <sl-select id="as-source-item-select" label="Linked Video Assessment" value="${esc(current.source?.id || '')}" class="flex-1">
            <sl-option value="">-- Choose video --</sl-option>
            ${interactiveVideos.map(v => `<sl-option value="${esc(v.id)}">${esc(v.title || 'Untitled')}${v.class_id === course.id ? ' (This class)' : ''}</sl-option>`).join('')}
          </sl-select>
          <sl-button size="medium" id="as-source-item-create" title="Create new video assessment linked to this class">
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> New
          </sl-button>
        </div>
      `;
    }

    const itemSelect = container.querySelector('#as-source-item-select');
    const createBtn = container.querySelector('#as-source-item-create');

    itemSelect?.addEventListener('sl-change', () => {
      const selectedId = itemSelect.value || null;
      if (selectedId) {
        current.source = { type, id: selectedId };
        const found = type === 'task'
          ? interactiveTasks.find(t => t.id === selectedId)
          : (type === 'assignment'
            ? interactiveAssignments.find(a => a.id === selectedId)
            : interactiveVideos.find(v => v.id === selectedId));
        if (found && !current.title) {
          current.title = found.title;
          const titleInput = dialog.querySelector('#as-title');
          if (titleInput) titleInput.value = current.title;
        }
      } else {
        current.source = { type, id: null };
      }
      if (actions) {
        if (current.source?.id) actions.classList.remove('hidden');
        else actions.classList.add('hidden');
      }
    });

    createBtn?.addEventListener('click', async () => {
      readForm();
      const title = current.title || (type === 'task' ? 'New Assignment' : (type === 'assignment' ? 'New Assessment' : 'New Video Assessment'));
      if (type === 'task') {
        const { createBlankTask } = await import('../tasks/index.js');
        const newTask = createBlankTask();
        newTask.title = title;
        newTask.class_id = course.id;
        newTask.gradebook = {
          course_id: course.id,
          column_id: current.id,
          category_id: current.category_id || null
        };
        newTask.grading = {
          scoring: current.scoring || 'points',
          max_points: current.max_score || 100,
          standard_ids: current.standard_ids || []
        };
        await storage.table('tasks').put(newTask);
        interactiveTasks.unshift(newTask);
        current.source = { type: 'task', id: newTask.id };
        if (!current.title) current.title = title;
        toast.success('New assignment created & linked!');
      } else if (type === 'assignment') {
        const newAsg = {
          version: 1,
          id: generateUUID(),
          title,
          instructions: '',
          class_id: course.id,
          gradebook: {
            course_id: course.id,
            column_id: current.id,
            category_id: current.category_id || null,
            points_possible: current.max_score || 100
          },
          settings: {
            release_grade_immediately: true,
            require_access_code: false,
            shuffle_questions: false,
            feedback_mode: 'immediate'
          },
          questions: [
            {
              id: generateUUID(),
              type: 'single_choice',
              prompt: 'Sample Question',
              points: 1,
              options: [
                { id: generateUUID(), text: 'Option A', is_correct: true },
                { id: generateUUID(), text: 'Option B', is_correct: false }
              ]
            }
          ],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await storage.table('assignments').put(newAsg);
        interactiveAssignments.unshift(newAsg);
        current.source = { type: 'assignment', id: newAsg.id };
        if (!current.title) current.title = title;
        toast.success('New interactive assignment created & linked!');
      } else {
        const newVid = {
          version: 1,
          id: generateUUID(),
          title,
          description: '',
          class_id: course.id,
          settings: {
            release_grade_immediately: true,
            feedback_mode: 'instant',
            show_correct_answers: true
          },
          provider: 'html5',
          video_source: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          checkpoints: []
        };
        await storage.table('video_assessments').put(newVid);
        interactiveVideos.unshift(newVid);
        current.source = { type: 'video', id: newVid.id };
        if (!current.title) current.title = title;
        toast.success('New video assessment created & linked!');
      }
      render();
    });
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
    dialog.querySelector('#as-source-type')?.addEventListener('sl-change', (e) => {
      readForm();
      const val = e.target.value;
      if (val === 'none') {
        current.source = null;
      } else {
        current.source = { type: val, id: current.source?.type === val ? current.source?.id : null };
      }
      updateSourcePicker();
    });

    dialog.querySelector('#as-btn-share-link')?.addEventListener('click', async () => {
      if (!current.source?.id) {
        toast.warning('Please select or create an interactive item first.');
        return;
      }
      if (current.source.type === 'task') {
        const item = await storage.table('tasks').get(current.source.id);
        if (item) {
          const { openTaskPublishDialog } = await import('../tasks/publish.js');
          openTaskPublishDialog(item);
        } else toast.danger('Linked assignment not found.');
      } else if (current.source.type === 'assignment') {
        const item = await storage.table('assignments').get(current.source.id);
        if (item) openPublishDialog(item);
        else toast.danger('Linked assessment not found.');
      } else if (current.source.type === 'video') {
        const item = await storage.table('video_assessments').get(current.source.id);
        if (item) openVideoShareDialog(item);
        else toast.danger('Linked video assessment not found.');
      }
    });

    dialog.querySelector('#as-btn-open-editor')?.addEventListener('click', () => {
      if (!current.source?.id) return;
      dialog.hide();
      if (current.source.type === 'task') {
        window.location.hash = `#/assignments/create?id=${current.source.id}`;
      } else if (current.source.type === 'assignment') {
        window.location.hash = `#/assessments/edit?id=${current.source.id}`;
      } else {
        window.location.hash = `#/video/edit?id=${current.source.id}`;
      }
    });

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
    dialog.querySelector('#as-save')?.addEventListener('click', async () => {
      readForm();
      if (!current.title) { toast.warning('Give the assignment a title.'); return; }

      // Synchronize class link on the linked interactive content if present
      if (current.source?.type && current.source?.type !== 'none' && current.source?.id) {
        const table = current.source.type === 'task' ? 'tasks' : (current.source.type === 'assignment' ? 'assignments' : 'video_assessments');
        const item = await storage.table(table).get(current.source.id);
        if (item) {
          await syncContentClassLink(item, current.source.type, course.id);
        }
      }

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

  // Load interactive items
  storage.table('tasks').toArray().then(items => {
    interactiveTasks = items;
    updateSourcePicker();
  }).catch(() => {});

  storage.table('assignments').toArray().then(items => {
    interactiveAssignments = items;
    updateSourcePicker();
  }).catch(() => {});

  storage.table('video_assessments').toArray().then(items => {
    interactiveVideos = items;
    updateSourcePicker();
  }).catch(() => {});

  dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
  document.body.appendChild(dialog);
  render();
  dialog.show();
  return dialog;
}

export default openAssignmentDialog;
