import { storage } from '../core/storage.js';
import { Sanitizer } from '../core/sanitizer.js';
import { generateUUID } from '../utils/uuid.js';
import { toast } from '../utils/toast.js';
import { ConfirmDialog } from '../utils/dialogs.js';
import { defaultAcademicYear } from '../core/academic-year.js';

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

  static async getClasses({ includeArchived = false } = {}) {
    try {
      const table = storage.table('gradebook_courses');
      const classes = await table.toArray();
      return includeArchived ? classes : classes.filter(c => !c.archived_at);
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

  static async saveClass(courseData, template = null) {
    const table = storage.table('gradebook_courses');
    const existing = courseData.id ? await table.get(courseData.id) : null;

    const record = {
      id: courseData.id || generateUUID(),
      name: courseData.name || 'New Class',
      section: courseData.section || 'Section 1',
      academic_year: courseData.academic_year || defaultAcademicYear(),
      color: courseData.color || '#2563eb',
      grading_scale: courseData.grading_scale || template?.grading_scale || existing?.grading_scale || 'traditional',
      archived_at: courseData.archived_at !== undefined ? courseData.archived_at : (existing?.archived_at || null),
      is_demo: courseData.is_demo !== undefined ? courseData.is_demo : (existing?.is_demo || false),
      terms: courseData.terms || template?.terms || existing?.terms || [
        { id: generateUUID(), name: 'Full Year', start_date: '2026-09-01', end_date: '2027-06-15', weight_pct: 100 }
      ],
      categories: courseData.categories || template?.categories || existing?.categories || [
        { id: generateUUID(), name: 'Assessments', weight_pct: 60, drop_lowest: 0, policy: { missing_floor_pct: 50, late_mode: 'none' } },
        { id: generateUUID(), name: 'Classwork & Homework', weight_pct: 40, drop_lowest: 1, policy: { missing_floor_pct: 50, late_mode: 'none' } }
      ],
      letter_scale: courseData.letter_scale || template?.letter_scale || existing?.letter_scale,
      sbg_config: courseData.sbg_config || template?.sbg_config || existing?.sbg_config,
      updated_at: new Date().toISOString()
    };

    await table.put(record);
    window.dispatchEvent(new CustomEvent('kb-classes-updated'));
    return record;
  }

  static async cloneClassSection(id, { newSectionName } = {}) {
    const course = await this.getClass(id);
    if (!course) return null;
    const cloned = {
      ...JSON.parse(JSON.stringify(course)),
      id: generateUUID(),
      name: course.name,
      section: newSectionName || (course.section ? `${course.section} (Copy)` : 'Section 2'),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null
    };
    await storage.table('gradebook_courses').put(cloned);

    // Duplicate rubrics
    const rubrics = await storage.table('gradebook_rubrics').where('course_id').equals(id).toArray();
    for (const r of rubrics) {
      await storage.table('gradebook_rubrics').put({ ...r, id: generateUUID(), course_id: cloned.id });
    }

    window.dispatchEvent(new CustomEvent('kb-classes-updated'));
    return cloned;
  }

  static async cloneClassForNextYear(id) {
    const course = await this.getClass(id);
    if (!course) return null;

    let nextYear = '';
    const match = String(course.academic_year || '').match(/^(\d{4})-(\d{4})$/);
    if (match) {
      const y1 = parseInt(match[1], 10) + 1;
      const y2 = parseInt(match[2], 10) + 1;
      nextYear = `${y1}-${y2}`;
    } else {
      const singleMatch = String(course.academic_year || '').match(/^(\d{4})$/);
      if (singleMatch) {
        nextYear = String(parseInt(singleMatch[1], 10) + 1);
      } else {
        nextYear = defaultAcademicYear();
      }
    }

    const cloned = {
      ...JSON.parse(JSON.stringify(course)),
      id: generateUUID(),
      name: course.name,
      section: course.section || 'Period 1',
      academic_year: nextYear,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null
    };
    await storage.table('gradebook_courses').put(cloned);

    // Duplicate rubrics
    const rubrics = await storage.table('gradebook_rubrics').where('course_id').equals(id).toArray();
    for (const r of rubrics) {
      await storage.table('gradebook_rubrics').put({ ...r, id: generateUUID(), course_id: cloned.id });
    }

    window.dispatchEvent(new CustomEvent('kb-classes-updated'));
    return cloned;
  }

  static async archiveClass(id) {
    const course = await this.getClass(id);
    if (course) {
      course.archived_at = new Date().toISOString();
      await storage.table('gradebook_courses').put(course);
      if (activeClassFilterId === id) {
        this.setActiveFilter(null);
      }
      window.dispatchEvent(new CustomEvent('kb-classes-updated'));
    }
  }

  static async unarchiveClass(id) {
    const course = await this.getClass(id);
    if (course) {
      course.archived_at = null;
      await storage.table('gradebook_courses').put(course);
      window.dispatchEvent(new CustomEvent('kb-classes-updated'));
    }
  }

  static async deleteClass(id, { deleteSubmissions = false } = {}) {
    // 1. Delete students in course
    const studentKeys = await storage.table('gradebook_students').where('course_id').equals(id).primaryKeys();
    if (studentKeys.length > 0) {
      await storage.table('gradebook_students').bulkDelete(studentKeys);
    }

    // 2. Delete gradebook assignments
    const gbAssignmentKeys = await storage.table('gradebook_assignments').where('course_id').equals(id).primaryKeys();
    if (gbAssignmentKeys.length > 0) {
      await storage.table('gradebook_assignments').bulkDelete(gbAssignmentKeys);
    }

    // 3. Delete grades
    const gradeKeys = await storage.table('gradebook_grades').where('course_id').equals(id).primaryKeys();
    if (gradeKeys.length > 0) {
      await storage.table('gradebook_grades').bulkDelete(gradeKeys);
    }

    // 4. Delete rubrics
    const rubricKeys = await storage.table('gradebook_rubrics').where('course_id').equals(id).primaryKeys();
    if (rubricKeys.length > 0) {
      await storage.table('gradebook_rubrics').bulkDelete(rubricKeys);
    }

    // 5. Unlink flashcards, timelines, video assessments
    for (const tbl of ['flashcards', 'timelines', 'video_assessments']) {
      const items = await storage.table(tbl).where('class_id').equals(id).toArray();
      for (const it of items) {
        it.class_id = null;
        await storage.table(tbl).put(it);
      }
    }

    // 6. Handle assignments table and submissions
    const allAssignments = await storage.table('assignments').toArray();
    const linkedIds = [];
    for (const a of allAssignments) {
      let changed = false;
      if (a.class_id === id) {
        a.class_id = null;
        changed = true;
      }
      if (a.gradebook?.course_id === id) {
        a.gradebook.course_id = null;
        changed = true;
        linkedIds.push(a.id);
      }
      if (changed) {
        await storage.table('assignments').put(a);
      }
    }

    if (deleteSubmissions && linkedIds.length > 0) {
      const allSubs = await storage.table('assignment_submissions').toArray();
      const toDeleteSubs = allSubs.filter(s => linkedIds.includes(s.assignment_id)).map(s => s.id);
      if (toDeleteSubs.length > 0) {
        await storage.table('assignment_submissions').bulkDelete(toDeleteSubs);
      }
    }

    // 7. Delete course row
    await storage.table('gradebook_courses').delete(id);
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
    const demoBadge = classObj.is_demo ? '<span class="ml-1 px-1 py-0.2 text-[9px] uppercase font-bold rounded bg-amber-100 text-amber-800">Sample</span>' : '';

    return `
      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium" style="background-color: color-mix(in srgb, ${preset.color} 12%, var(--kb-surface)); color: color-mix(in srgb, ${preset.color} 72%, var(--kb-text)); border: 1px solid color-mix(in srgb, ${preset.color} 32%, var(--kb-surface));" title="${safeName} (${safeSection})">
        <span class="w-1.5 h-1.5 rounded-full" style="background-color: ${preset.color};"></span>
        <span class="truncate max-w-[120px]">${safeName}</span>
        ${demoBadge}
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
    dialog.style.setProperty('--width', '680px');

    let showArchived = false;

    const renderModalContent = async () => {
      const classes = await this.getClasses({ includeArchived: showArchived });
      const studentsTable = storage.table('gradebook_students');
      const assignmentsTable = storage.table('gradebook_assignments');
      const [allStudents, allAssignments] = await Promise.all([
        studentsTable.toArray(),
        assignmentsTable.toArray()
      ]);

      dialog.innerHTML = `
        <div class="space-y-4 py-1">
          <div class="flex items-center justify-between pb-2 border-b border-slate-200">
            <div>
              <h3 class="text-sm font-semibold text-slate-800">Your Classes &amp; Sections</h3>
              <p class="text-xs text-slate-500">Classes organize Flashcards, Timelines, Video Assessments, and Gradebooks.</p>
            </div>
            <div class="flex items-center gap-2">
              <sl-button variant="primary" size="small" id="btn-modal-add-class">
                <sl-icon slot="prefix" name="plus-lg"></sl-icon> New Class
              </sl-button>
            </div>
          </div>

          <div class="flex items-center justify-between text-xs text-slate-500 px-1">
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" id="chk-show-archived" ${showArchived ? 'checked' : ''} class="rounded border-slate-300">
              <span>Show archived classes</span>
            </label>
          </div>

          <!-- Class List -->
          <div class="space-y-2 max-h-96 overflow-y-auto pr-1">
            ${classes.length === 0 ? `
              <div class="text-center py-8 text-slate-400 text-xs">
                <sl-icon name="mortarboard" class="text-3xl mb-2 text-slate-300"></sl-icon>
                <p>No classes ${showArchived ? '' : 'active'}. Click "+ New Class" to create your first course!</p>
              </div>
            ` : classes.map(c => {
              const studentCount = allStudents.filter(s => s.course_id === c.id).length;
              const assignmentCount = allAssignments.filter(a => a.course_id === c.id).length;
              const safeName = Sanitizer.escapeHTML(c.name);
              const safeSection = Sanitizer.escapeHTML(c.section || '');
              const safeYear = Sanitizer.escapeHTML(c.academic_year || '');
              const isArchived = Boolean(c.archived_at);
              return `
                <div class="flex items-center justify-between p-3 rounded-xl border border-slate-200 ${isArchived ? 'bg-slate-50 opacity-75' : 'bg-white'} hover:border-slate-300 shadow-xs transition-all">
                  <div class="flex items-center gap-3 min-w-0 flex-1">
                    <div class="w-3.5 h-10 rounded-full flex-shrink-0" style="background-color: ${c.color || '#2563eb'};"></div>
                    <div class="min-w-0">
                      <div class="text-sm font-semibold text-slate-900 flex items-center gap-2">
                        <span class="truncate">${safeName}</span>
                        ${isArchived ? '<span class="px-1.5 py-0.5 text-[10px] uppercase font-semibold rounded bg-slate-200 text-slate-600">Archived</span>' : ''}
                      </div>
                      <div class="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5 flex-wrap">
                        ${safeSection ? `<span>${safeSection}</span><span>•</span>` : ''}
                        <span>${safeYear}</span>
                        <span>•</span>
                        <span class="font-medium text-slate-700">${studentCount} student${studentCount === 1 ? '' : 's'}</span>
                        <span>•</span>
                        <span class="text-slate-600">${assignmentCount} assignment${assignmentCount === 1 ? '' : 's'}</span>
                      </div>
                    </div>
                  </div>
                  <div class="flex items-center gap-1 flex-shrink-0 ml-2">
                    <sl-button size="small" variant="default" data-action="gradebook" data-id="${c.id}" title="Open Gradebook">
                      <sl-icon name="journal-bookmark"></sl-icon>
                    </sl-button>
                    <sl-button size="small" variant="default" data-action="roster" data-id="${c.id}" title="Manage Roster">
                      <sl-icon name="people"></sl-icon>
                    </sl-button>
                    <sl-button size="small" variant="default" data-action="settings" data-id="${c.id}" title="Class Settings">
                      <sl-icon name="gear"></sl-icon>
                    </sl-button>

                    <sl-dropdown placement="bottom-end">
                      <button slot="trigger" type="button" class="p-1.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer" aria-label="More class actions">
                        <sl-icon name="three-dots-vertical"></sl-icon>
                      </button>
                      <sl-menu class="class-more-menu" data-id="${c.id}">
                        <sl-menu-item value="edit">
                          <sl-icon slot="prefix" name="pencil"></sl-icon> Edit Details...
                        </sl-menu-item>
                        <sl-menu-item value="clone-next-year">
                          <sl-icon slot="prefix" name="calendar-plus"></sl-icon> Clone for Next Year
                        </sl-menu-item>
                        <sl-menu-item value="clone-section">
                          <sl-icon slot="prefix" name="copy"></sl-icon> Clone Section
                        </sl-menu-item>
                        <sl-divider></sl-divider>
                        ${isArchived ? `
                          <sl-menu-item value="unarchive">
                            <sl-icon slot="prefix" name="arrow-up-right-square"></sl-icon> Unarchive Class
                          </sl-menu-item>
                        ` : `
                          <sl-menu-item value="archive">
                            <sl-icon slot="prefix" name="archive"></sl-icon> Archive Class
                          </sl-menu-item>
                        `}
                        <sl-menu-item value="delete" class="text-rose-600">
                          <sl-icon slot="prefix" name="trash"></sl-icon> Delete Class Permanently...
                        </sl-menu-item>
                      </sl-menu>
                    </sl-dropdown>
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

      dialog.querySelector('#chk-show-archived')?.addEventListener('change', async (e) => {
        showArchived = e.target.checked;
        await renderModalContent();
      });

      dialog.querySelector('#btn-modal-add-class')?.addEventListener('click', async () => {
        const { ClassSetupWizard } = await import('./class-setup-wizard.js');
        ClassSetupWizard.open({
          onDone: async () => {
            await renderModalContent();
            if (onUpdated) onUpdated();
          }
        });
      });

      dialog.querySelectorAll('[data-action="gradebook"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          this.setActiveFilter(id);
          window.location.hash = `#/gradebook?courseId=${id}`;
          dialog.hide();
        });
      });

      dialog.querySelectorAll('[data-action="roster"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          this.setActiveFilter(id);
          window.location.hash = `#/gradebook?view=roster&courseId=${id}`;
          dialog.hide();
        });
      });

      dialog.querySelectorAll('[data-action="settings"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const course = await this.getClass(id);
          if (course) {
            const { openCourseSettingsDialog } = await import('../modules/gradebook/course-settings.js');
            openCourseSettingsDialog({
              course,
              onSave: async (updated) => {
                await this.saveClass(updated);
                await renderModalContent();
                if (onUpdated) onUpdated();
              }
            });
          }
        });
      });

      dialog.querySelectorAll('.class-more-menu').forEach(menu => {
        menu.addEventListener('sl-select', async (e) => {
          const val = e.detail.item.value;
          const id = menu.dataset.id;
          const course = await this.getClass(id);
          if (!course) return;

          if (val === 'edit') {
            this.openClassEditorModal(course, async () => {
              await renderModalContent();
              if (onUpdated) onUpdated();
            });
          } else if (val === 'clone-next-year') {
            const cloned = await this.cloneClassForNextYear(id);
            toast.success(`Cloned "${Sanitizer.escapeHTML(cloned.name)}" for ${cloned.academic_year}!`);
            await renderModalContent();
            if (onUpdated) onUpdated();
          } else if (val === 'clone-section') {
            const cloned = await this.cloneClassSection(id);
            toast.success(`Cloned section to "${Sanitizer.escapeHTML(cloned.section)}"!`);
            await renderModalContent();
            if (onUpdated) onUpdated();
          } else if (val === 'archive') {
            await this.archiveClass(id);
            toast.info('Class archived.');
            await renderModalContent();
            if (onUpdated) onUpdated();
          } else if (val === 'unarchive') {
            await this.unarchiveClass(id);
            toast.success('Class restored.');
            await renderModalContent();
            if (onUpdated) onUpdated();
          } else if (val === 'delete') {
            const confirmed = await ConfirmDialog.show({
              title: 'Delete Class Permanently',
              message: `Are you sure you want to permanently delete "${Sanitizer.escapeHTML(course?.name || 'this class')}"? Enrolled students, assignments, and grades will also be permanently deleted. (To hide without deleting, choose Archive instead.)`,
              confirmText: 'Delete Permanently',
              variant: 'danger'
            });
            if (confirmed) {
              await this.deleteClass(id);
              toast.success('Class and related records deleted.');
              await renderModalContent();
              if (onUpdated) onUpdated();
            }
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
    const defYear = defaultAcademicYear();
    const safeYear = course ? Sanitizer.escapeHTML(course.academic_year || '') : defYear;
    const selectedColor = course?.color || '#2563eb';

    dialog.innerHTML = `
      <div class="space-y-3 py-1 text-sm">
        <sl-input id="input-class-name" label="Class / Course Name" placeholder="e.g. AP Chemistry" value="${safeName}" required autofocus></sl-input>
        <div class="grid grid-cols-2 gap-3">
          <sl-input id="input-class-section" label="Section / Period" placeholder="e.g. Period 2 • Room 304" value="${safeSection}"></sl-input>
          <sl-input id="input-class-year" label="Academic Year" placeholder="e.g. ${defYear}" value="${safeYear}"></sl-input>
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
        academic_year: yearInput?.value?.trim() || defaultAcademicYear(),
        color: activeColor
      });

      toast.success(`Class "${Sanitizer.escapeHTML(name)}" saved!`);
      dialog.hide();
      if (onSaved) onSaved();
    });

    dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
  }
}
