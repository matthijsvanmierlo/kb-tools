import { storage } from '../core/storage.js';
import { Sanitizer } from '../core/sanitizer.js';
import { generateUUID } from '../utils/uuid.js';
import { toast } from '../utils/toast.js';
import { ConfirmDialog } from '../utils/dialogs.js';

export const CLASS_COLOR_PRESETS = [
  { name: 'Blue', color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe', text: '#1d4ed8' },
  { name: 'Emerald', color: '#059669', bg: '#ecfdf5', border: '#a7f3d0', text: '#047857' },
  { name: 'Violet', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe', text: '#6d28d9' },
  { name: 'Amber', color: '#d97706', bg: '#fffbeb', border: '#fde68a', text: '#b45309' },
  { name: 'Rose', color: '#e11d48', bg: '#fff1f2', border: '#fecdd3', text: '#be123c' },
  { name: 'Cyan', color: '#0891b2', bg: '#ecfeff', border: '#a5f3fc', text: '#0e7490' },
  { name: 'Indigo', color: '#4f46e5', bg: '#eef2ff', border: '#c7d2fe', text: '#4338ca' },
  { name: 'Teal', color: '#0d9488', bg: '#f0fdfa', border: '#99f6e4', text: '#0f766e' }
];

let activeClassFilterId = null;

export class ClassManager {
  static getActiveFilter() {
    if (activeClassFilterId === null && typeof localStorage !== 'undefined') {
      activeClassFilterId = localStorage.getItem('kb_active_class_filter') || null;
    }
    return activeClassFilterId;
  }

  static setActiveFilter(classId) {
    activeClassFilterId = classId || null;
    if (typeof localStorage !== 'undefined') {
      if (activeClassFilterId) {
        localStorage.setItem('kb_active_class_filter', activeClassFilterId);
      } else {
        localStorage.removeItem('kb_active_class_filter');
      }
    }
    window.dispatchEvent(new CustomEvent('kb-class-filter-changed', { detail: { classId: activeClassFilterId } }));
  }

  static async getClasses() {
    try {
      const table = storage.table('gradebook_courses');
      return await table.toArray();
    } catch (e) {
      console.warn('Could not load classes:', e);
      return [];
    }
  }

  static async getClass(id) {
    if (!id) return null;
    try {
      const table = storage.table('gradebook_courses');
      return await table.get(id);
    } catch (e) {
      return null;
    }
  }

  static async saveClass(courseData) {
    const table = storage.table('gradebook_courses');
    const existing = courseData.id ? await table.get(courseData.id) : null;

    const record = {
      id: courseData.id || generateUUID(),
      name: courseData.name || 'New Class',
      section: courseData.section || 'Section 1',
      academic_year: courseData.academic_year || '2026-2027',
      color: courseData.color || '#2563eb',
      grading_scale: existing?.grading_scale || 'traditional',
      terms: existing?.terms || [
        { id: generateUUID(), name: 'Full Year', start_date: '2026-09-01', end_date: '2027-06-15', weight_pct: 100 }
      ],
      categories: existing?.categories || [
        { id: generateUUID(), name: 'Assessments', weight_pct: 60, drop_lowest: 0, policy: { missing_floor_pct: 50, late_mode: 'none' } },
        { id: generateUUID(), name: 'Classwork & Homework', weight_pct: 40, drop_lowest: 1, policy: { missing_floor_pct: 50, late_mode: 'none' } }
      ],
      updated_at: new Date().toISOString()
    };

    await table.put(record);
    window.dispatchEvent(new CustomEvent('kb-classes-updated'));
    return record;
  }

  static async deleteClass(id) {
    const table = storage.table('gradebook_courses');
    await table.delete(id);
    if (activeClassFilterId === id) {
      this.setActiveFilter(null);
    }
    window.dispatchEvent(new CustomEvent('kb-classes-updated'));
  }

  static renderClassBadge(classObj) {
    if (!classObj) return '';
    const preset = CLASS_COLOR_PRESETS.find(p => p.color.toLowerCase() === (classObj.color || '').toLowerCase()) || CLASS_COLOR_PRESETS[0];
    const safeName = Sanitizer.escapeHTML(classObj.name);
    const safeSection = classObj.section ? Sanitizer.escapeHTML(classObj.section) : '';

    return `
      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium" style="background-color: color-mix(in srgb, ${preset.color} 12%, var(--kb-surface)); color: color-mix(in srgb, ${preset.color} 72%, var(--kb-text)); border: 1px solid color-mix(in srgb, ${preset.color} 32%, var(--kb-surface));" title="${safeName} (${safeSection})">
        <span class="w-1.5 h-1.5 rounded-full" style="background-color: ${preset.color};"></span>
        <span class="truncate max-w-[120px]">${safeName}</span>
      </span>
    `;
  }

  /**
   * Render the header dropdown selector
   */
  static async renderGlobalNavSelector(container) {
    if (!container) return;

    const classes = await this.getClasses();
    const activeId = this.getActiveFilter();
    const activeClass = classes.find(c => c.id === activeId);

    const safeLabel = activeClass ? Sanitizer.escapeHTML(activeClass.name) : 'All Classes';
    const activeColor = activeClass?.color || '#64748b';

    container.innerHTML = `
      <sl-dropdown id="kb-global-class-dropdown" placement="bottom-start">
        <button slot="trigger" type="button" class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border border-slate-200 hover:bg-slate-50 transition-colors" title="Filter by Class">
          <span class="w-2 h-2 rounded-full" style="background-color: ${activeColor};"></span>
          <span class="font-semibold text-slate-700 truncate max-w-[130px]">${safeLabel}</span>
          <sl-icon name="chevron-down" class="text-[10px] text-slate-400"></sl-icon>
        </button>
        <sl-menu class="min-w-[180px]">
          <sl-menu-item value="all" class="${!activeId ? 'font-bold text-blue-600' : ''}">
            <sl-icon slot="prefix" name="grid"></sl-icon> All Classes
          </sl-menu-item>
          <sl-divider></sl-divider>
          ${classes.map(c => `
            <sl-menu-item value="${c.id}" class="${c.id === activeId ? 'font-bold text-blue-600' : ''}">
              <span slot="prefix" class="w-2 h-2 rounded-full" style="background-color: ${c.color || '#2563eb'};"></span>
              ${Sanitizer.escapeHTML(c.name)} ${c.section ? `<span class="text-[10px] text-slate-400 ml-1">(${Sanitizer.escapeHTML(c.section)})</span>` : ''}
            </sl-menu-item>
          `).join('')}
          <sl-divider></sl-divider>
          <sl-menu-item id="kb-nav-manage-classes">
            <sl-icon slot="prefix" name="gear"></sl-icon> Manage Classes...
          </sl-menu-item>
        </sl-menu>
      </sl-dropdown>
    `;

    const dropdown = container.querySelector('#kb-global-class-dropdown');
    dropdown?.addEventListener('sl-select', (e) => {
      const val = e.detail.item.value;
      if (val === 'all') {
        this.setActiveFilter(null);
        this.renderGlobalNavSelector(container);
      } else if (val) {
        this.setActiveFilter(val);
        this.renderGlobalNavSelector(container);
      }
    });

    container.querySelector('#kb-nav-manage-classes')?.addEventListener('click', () => {
      this.openClassManagerModal(() => this.renderGlobalNavSelector(container));
    });
  }

  /**
   * Modal dialog to manage, add, edit, and delete classes
   */
  static async openClassManagerModal(onUpdated) {
    const dialog = document.createElement('sl-dialog');
    dialog.label = 'Class & Roster Hub';
    dialog.className = 'kb-class-modal';
    dialog.style.setProperty('--width', '640px');

    const renderModalContent = async () => {
      const classes = await this.getClasses();
      const studentsTable = storage.table('gradebook_students');
      const allStudents = await studentsTable.toArray();

      dialog.innerHTML = `
        <div class="space-y-4 py-1">
          <div class="flex items-center justify-between pb-2 border-b border-slate-200">
            <div>
              <h3 class="text-sm font-semibold text-slate-800">Your Classes &amp; Sections</h3>
              <p class="text-xs text-slate-500">Classes organize Flashcards, Timelines, Video Assessments, and Gradebooks.</p>
            </div>
            <sl-button variant="primary" size="small" id="btn-modal-add-class">
              <sl-icon slot="prefix" name="plus-lg"></sl-icon> New Class
            </sl-button>
          </div>

          <!-- Class List -->
          <div class="space-y-2 max-h-96 overflow-y-auto pr-1">
            ${classes.length === 0 ? `
              <div class="text-center py-8 text-slate-400 text-xs">
                <sl-icon name="mortarboard" class="text-3xl mb-2 text-slate-300"></sl-icon>
                <p>No classes created yet. Click "+ New Class" to create your first course!</p>
              </div>
            ` : classes.map(c => {
              const studentCount = allStudents.filter(s => s.course_id === c.id).length;
              const safeName = Sanitizer.escapeHTML(c.name);
              const safeSection = Sanitizer.escapeHTML(c.section || '');
              const safeYear = Sanitizer.escapeHTML(c.academic_year || '');
              return `
                <div class="flex items-center justify-between p-3 rounded-xl border border-slate-200 bg-white hover:border-slate-300 shadow-xs transition-all">
                  <div class="flex items-center gap-3">
                    <div class="w-4 h-10 rounded-full" style="background-color: ${c.color || '#2563eb'};"></div>
                    <div>
                      <div class="text-sm font-semibold text-slate-900">${safeName}</div>
                      <div class="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                        <span>${safeSection}</span>
                        <span>•</span>
                        <span>${safeYear}</span>
                        <span>•</span>
                        <span class="font-medium text-slate-700">${studentCount} students</span>
                      </div>
                    </div>
                  </div>
                  <div class="flex items-center gap-1">
                    <sl-button size="small" variant="default" data-action="edit" data-id="${c.id}" title="Edit Class">
                      <sl-icon name="pencil"></sl-icon>
                    </sl-button>
                    <sl-button size="small" variant="danger" outline data-action="delete" data-id="${c.id}" title="Delete Class">
                      <sl-icon name="trash"></sl-icon>
                    </sl-button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        <div slot="footer">
          <sl-button variant="default" id="btn-close-class-modal">Close</sl-button>
        </div>
      `;

      dialog.querySelector('#btn-close-class-modal')?.addEventListener('click', () => dialog.hide());

      dialog.querySelector('#btn-modal-add-class')?.addEventListener('click', () => {
        this.openClassEditorModal(null, async () => {
          await renderModalContent();
          if (onUpdated) onUpdated();
        });
      });

      dialog.querySelectorAll('[data-action="edit"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const course = await this.getClass(id);
          if (course) {
            this.openClassEditorModal(course, async () => {
              await renderModalContent();
              if (onUpdated) onUpdated();
            });
          }
        });
      });

      dialog.querySelectorAll('[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const course = await this.getClass(id);
          const confirmed = await ConfirmDialog.show({
            title: 'Delete Class',
            message: `Are you sure you want to delete "${Sanitizer.escapeHTML(course?.name || 'this class')}"? Enrolled students and grades will also be removed.`,
            confirmText: 'Delete Class',
            variant: 'danger'
          });
          if (confirmed) {
            await this.deleteClass(id);
            toast.success('Class deleted.');
            await renderModalContent();
            if (onUpdated) onUpdated();
          }
        });
      });
    };

    document.body.appendChild(dialog);
    await renderModalContent();
    dialog.show();

    dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
  }

  /**
   * Edit / Create single class modal
   */
  static openClassEditorModal(course = null, onSaved) {
    const dialog = document.createElement('sl-dialog');
    dialog.label = course ? 'Edit Class' : 'Create New Class';
    dialog.className = 'kb-class-editor-modal';

    const safeName = course ? Sanitizer.escapeHTML(course.name) : '';
    const safeSection = course ? Sanitizer.escapeHTML(course.section || '') : 'Period 1';
    const safeYear = course ? Sanitizer.escapeHTML(course.academic_year || '') : '2026-2027';
    const selectedColor = course?.color || '#2563eb';

    dialog.innerHTML = `
      <div class="space-y-3 py-1 text-sm">
        <sl-input id="input-class-name" label="Class / Course Name" placeholder="e.g. AP Chemistry" value="${safeName}" required autofocus></sl-input>
        <div class="grid grid-cols-2 gap-3">
          <sl-input id="input-class-section" label="Section / Period" placeholder="e.g. Period 2 • Room 304" value="${safeSection}"></sl-input>
          <sl-input id="input-class-year" label="Academic Year" placeholder="e.g. 2026-2027" value="${safeYear}"></sl-input>
        </div>

        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-2">Class Theme Color</label>
          <div class="grid grid-cols-4 gap-2" id="class-color-picker">
            ${CLASS_COLOR_PRESETS.map(p => `
              <button type="button" class="kb-color-swatch flex items-center gap-1.5 p-2 rounded-lg border text-xs font-medium transition-all ${p.color.toLowerCase() === selectedColor.toLowerCase() ? 'ring-2 ring-blue-500 border-blue-500 font-bold' : 'border-slate-200 hover:border-slate-300'}" data-color="${p.color}" style="background-color: ${p.bg}; color: ${p.text};">
                <span class="w-3 h-3 rounded-full" style="background-color: ${p.color};"></span>
                <span>${p.name}</span>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button variant="default" id="btn-cancel-class-edit">Cancel</sl-button>
        <sl-button variant="primary" id="btn-save-class-edit">Save Class</sl-button>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    let activeColor = selectedColor;

    dialog.querySelectorAll('.kb-color-swatch').forEach(btn => {
      btn.addEventListener('click', () => {
        activeColor = btn.dataset.color;
        dialog.querySelectorAll('.kb-color-swatch').forEach(b => {
          if (b.dataset.color === activeColor) {
            b.classList.add('ring-2', 'ring-blue-500', 'border-blue-500', 'font-bold');
          } else {
            b.classList.remove('ring-2', 'ring-blue-500', 'border-blue-500', 'font-bold');
          }
        });
      });
    });

    dialog.querySelector('#btn-cancel-class-edit')?.addEventListener('click', () => dialog.hide());

    dialog.querySelector('#btn-save-class-edit')?.addEventListener('click', async () => {
      const nameInput = dialog.querySelector('#input-class-name');
      const sectionInput = dialog.querySelector('#input-class-section');
      const yearInput = dialog.querySelector('#input-class-year');

      const name = nameInput?.value?.trim();
      if (!name) {
        toast.danger('Please provide a class name.');
        nameInput?.focus();
        return;
      }

      await this.saveClass({
        id: course?.id,
        name,
        section: sectionInput?.value?.trim() || 'Period 1',
        academic_year: yearInput?.value?.trim() || '2026-2027',
        color: activeColor
      });

      toast.success(`Class "${Sanitizer.escapeHTML(name)}" saved!`);
      dialog.hide();
      if (onSaved) onSaved();
    });

    dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
  }
}
