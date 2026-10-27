import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog, PromptDialog } from '../../utils/dialogs.js';
import { generateUUID } from '../../utils/uuid.js';
import { setDue, getDue } from '../../core/due-dates.js';
import { buildCourseFeed, deriveCourseFeedId } from '../../core/course-feed.js';
import { getTransport, PublicFeedTransport, isTeacherRelayConfigured } from '../../core/transport.js';
import { isFeedDirty, markFeedPublished, markCourseFeedDirty } from '../../core/course-revision.js';
import { QRCode } from '../../core/qrcode.js';
import { GradebookBridge } from '../gradebook/bridge.js';
import { router } from '../../router.js';

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

export const UNIT_PALETTE = [
  { name: 'Slate', hex: '#64748b' },
  { name: 'Blue', hex: '#2563eb' },
  { name: 'Indigo', hex: '#4f46e5' },
  { name: 'Violet', hex: '#7c3aed' },
  { name: 'Emerald', hex: '#059669' },
  { name: 'Teal', hex: '#0d9488' },
  { name: 'Amber', hex: '#d97706' },
  { name: 'Rose', hex: '#e11d48' }
];

// In-memory set of collapsed unit IDs
const collapsedUnits = new Set();

export async function renderCoursePage(courseId, container) {
  if (!courseId) {
    container.innerHTML = `
      <div class="p-8 text-center text-slate-500">
        <p>No course ID provided.</p>
        <sl-button size="small" class="mt-4" href="#/classes">Go to Classes</sl-button>
      </div>
    `;
    return;
  }

  const course = await storage.table('gradebook_courses').get(courseId);
  if (!course) {
    container.innerHTML = `
      <div class="p-8 text-center text-slate-500">
        <p>Course not found.</p>
        <sl-button size="small" class="mt-4" href="#/classes">Go to Classes</sl-button>
      </div>
    `;
    return;
  }

  const render = async () => {
    const [units, items] = await Promise.all([
      storage.table('course_units').where('course_id').equals(courseId).toArray().catch(() => []),
      storage.table('course_items').where('course_id').equals(courseId).toArray().catch(() => [])
    ]);

    units.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const dirty = await isFeedDirty(courseId).catch(() => false);
    const color = Sanitizer.safeColor(course.color, '#2563eb');
    const transport = await getTransport();
    const hasRelay = isTeacherRelayConfigured(transport);

    container.innerHTML = `
      <div class="min-h-[calc(100vh-4rem)] bg-slate-50 pb-16">
        <!-- Course Header Banner -->
        <header class="bg-white border-b border-slate-200">
          <div class="max-w-6xl mx-auto px-4 sm:px-6 py-6">
            <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div class="flex items-center gap-3.5 min-w-0">
                <div class="w-4 h-14 rounded-lg flex-shrink-0 shadow-xs" style="background-color: ${color};"></div>
                <div class="min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <h1 class="text-2xl font-bold text-slate-900 tracking-tight truncate">${esc(course.name)}</h1>
                    ${course.section ? `<span class="px-2.5 py-0.5 rounded-md text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">${esc(course.section)}</span>` : ''}
                    ${course.academic_year ? `<span class="text-xs text-slate-500 font-medium">(${esc(course.academic_year)})</span>` : ''}
                  </div>
                  <div class="flex items-center gap-3 text-xs text-slate-500 mt-1 flex-wrap">
                    <span>Access Code: <strong class="font-mono text-primary-700 bg-primary-50 px-1.5 py-0.5 rounded border border-primary-200">${esc(course.access_code || '------')}</strong></span>
                    <span>•</span>
                    <span>${units.length} Folder${units.length === 1 ? '' : 's'}</span>
                    <span>•</span>
                    <span>${items.length} Item${items.length === 1 ? '' : 's'}</span>
                    ${dirty ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800">Unpublished Changes</span>' : '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800">Feed In Sync</span>'}
                  </div>
                </div>
              </div>

              <!-- Action Buttons -->
              <div class="flex items-center gap-2 flex-wrap">
                <sl-button size="small" variant="default" id="btn-course-share-card">
                  <sl-icon slot="prefix" name="qr-code"></sl-icon> Student Card
                </sl-button>
                <sl-button size="small" variant="default" href="#/classes?courseId=${esc(course.id)}&tab=roster">
                  <sl-icon slot="prefix" name="people"></sl-icon> Roster
                </sl-button>
                <sl-button size="small" variant="default" href="#/gradebook?courseId=${esc(course.id)}">
                  <sl-icon slot="prefix" name="journal-bookmark"></sl-icon> Gradebook
                </sl-button>
                <sl-button size="small" variant="${dirty ? 'primary' : 'default'}" id="btn-publish-feed">
                  <sl-icon slot="prefix" name="${hasRelay ? 'cloud-upload' : 'box-arrow-up'}"></sl-icon> ${hasRelay ? 'Publish Feed to Server' : 'Package Course (.kbshare)'}
                </sl-button>
              </div>
            </div>
          </div>
        </header>

        <!-- Main Units Container -->
        <main class="max-w-6xl mx-auto px-4 sm:px-6 pt-6">
          <div class="flex items-center justify-between mb-4">
            <div>
              <h2 class="text-base font-bold text-slate-800">Course Outline &amp; Syllabus</h2>
              <p class="text-xs text-slate-500">Color code, reorder folders and lessons, or create new content directly for this class.</p>
            </div>
            <div class="flex items-center gap-2">
              <sl-button size="small" variant="primary" id="btn-add-unit">
                <sl-icon slot="prefix" name="folder-plus"></sl-icon> Add Folder / Unit
              </sl-button>
            </div>
          </div>

          <!-- Unit List -->
          <div class="space-y-6" id="units-mount">
            ${units.length === 0 ? `
              <div class="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center text-slate-400">
                <sl-icon name="folder2-open" class="text-5xl text-slate-300 mb-3"></sl-icon>
                <h3 class="text-base font-semibold text-slate-700">No folders or units yet</h3>
                <p class="text-xs text-slate-500 max-w-sm mx-auto mt-1">Organize your course into colored units, modules, or thematic chapters. Click "Add Folder / Unit" to get started.</p>
                <sl-button size="small" variant="primary" class="mt-4" id="btn-add-unit-empty">
                  <sl-icon slot="prefix" name="folder-plus"></sl-icon> Add First Unit
                </sl-button>
              </div>
            ` : units.map((u, uIdx) => {
              const unitItems = items.filter(it => it.unit_id === u.id);
              const isCollapsed = collapsedUnits.has(u.id);
              const uColor = u.color ? Sanitizer.safeColor(u.color) : UNIT_PALETTE[uIdx % UNIT_PALETTE.length].hex;

              return `
                <section class="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden transition-all unit-card border-l-4" style="border-left-color: ${uColor};" data-unit-id="${esc(u.id)}" data-unit-index="${uIdx}">
                  <!-- Unit Header -->
                  <div class="bg-slate-50/80 border-b border-slate-200 px-4 py-3 flex items-center justify-between gap-3 unit-header-zone">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <span class="cursor-grab text-slate-300 hover:text-slate-600 unit-drag-handle flex-shrink-0" title="Drag to reorder folder">
                        <sl-icon name="grip-vertical" class="text-base"></sl-icon>
                      </span>
                      <button type="button" class="w-6 h-6 rounded-full font-semibold text-xs flex items-center justify-center flex-shrink-0 cursor-pointer btn-toggle-collapse" data-unit-id="${esc(u.id)}" title="${isCollapsed ? 'Expand unit' : 'Collapse unit'}" style="background-color: ${uColor}20; color: ${uColor};">
                        <sl-icon name="${isCollapsed ? 'chevron-right' : 'chevron-down'}" class="text-[10px]"></sl-icon>
                      </button>
                      <div class="min-w-0 cursor-pointer btn-edit-unit" data-unit-id="${esc(u.id)}" title="Click to edit folder title and color">
                        <h3 class="text-sm font-bold text-slate-900 truncate hover:text-primary-600 transition-colors">${esc(u.title || 'Untitled Unit')}</h3>
                        ${u.description ? `<p class="text-xs text-slate-500 truncate">${esc(u.description)}</p>` : ''}
                      </div>
                    </div>

                    <div class="flex items-center gap-1.5 flex-shrink-0">
                      <span class="text-xs text-slate-400 font-medium hidden sm:inline mr-1">${unitItems.length} item${unitItems.length === 1 ? '' : 's'}</span>

                      <sl-button size="small" variant="default" class="btn-add-item-to-unit" data-unit-id="${esc(u.id)}">
                        <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add / Create Item
                      </sl-button>

                      <sl-dropdown placement="bottom-end">
                        <button slot="trigger" class="p-1.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer" aria-label="Unit options">
                          <sl-icon name="three-dots-vertical"></sl-icon>
                        </button>
                        <sl-menu>
                          <sl-menu-item class="menu-edit-unit" data-unit-id="${esc(u.id)}">
                            <sl-icon slot="prefix" name="pencil"></sl-icon> Edit Folder / Color...
                          </sl-menu-item>
                          ${uIdx > 0 ? `
                            <sl-menu-item class="menu-move-unit-up" data-unit-id="${esc(u.id)}">
                              <sl-icon slot="prefix" name="arrow-up"></sl-icon> Move Folder Up
                            </sl-menu-item>
                          ` : ''}
                          ${uIdx < units.length - 1 ? `
                            <sl-menu-item class="menu-move-unit-down" data-unit-id="${esc(u.id)}">
                              <sl-icon slot="prefix" name="arrow-down"></sl-icon> Move Folder Down
                            </sl-menu-item>
                          ` : ''}
                          <sl-divider></sl-divider>
                          <sl-menu-item class="menu-delete-unit text-rose-600" data-unit-id="${esc(u.id)}">
                            <sl-icon slot="prefix" name="trash"></sl-icon> Delete Folder
                          </sl-menu-item>
                        </sl-menu>
                      </sl-dropdown>
                    </div>
                  </div>

                  <!-- Unit Items List -->
                  <div class="unit-items-container divide-y divide-slate-100 p-2 ${isCollapsed ? 'hidden' : ''}" data-unit-dropzone="${esc(u.id)}">
                    ${unitItems.length === 0 ? `
                      <div class="py-8 text-center text-xs text-slate-400 border border-dashed border-slate-200 rounded-xl my-1 empty-dropzone" data-unit-empty="${esc(u.id)}">
                        <sl-icon name="arrow-down-circle" class="text-lg text-slate-300 mb-1"></sl-icon>
                        <p>No items in this folder yet.</p>
                        <p class="text-[11px] text-slate-400 mt-0.5">Drag items here or click "+ Add / Create Item".</p>
                      </div>
                    ` : unitItems.map((it, itIdx) => {
                      const kind = it.kind || it.type || 'assignment';
                      const sourceId = it.source_id || it.id;
                      const icons = {
                        task: 'journal-text text-indigo-600',
                        assignment: 'file-earmark-check text-blue-600',
                        flashcards: 'collection text-purple-600',
                        timeline: 'clock-history text-emerald-600',
                        video: 'play-circle text-rose-600',
                        link: 'link-45deg text-amber-600'
                      };
                      const iconClass = icons[kind] || 'file-earmark text-slate-500';

                      return `
                        <div class="flex items-center justify-between p-2.5 rounded-xl hover:bg-slate-50/80 transition-colors gap-3 item-row" draggable="true" data-item-id="${esc(it.id)}" data-unit-id="${esc(u.id)}" data-item-index="${itIdx}">
                          <div class="flex items-center gap-2.5 min-w-0 flex-1">
                            <span class="cursor-grab text-slate-300 hover:text-slate-600 item-drag-handle flex-shrink-0" title="Drag to reorder or move across folders">
                              <sl-icon name="grip-vertical" class="text-sm"></sl-icon>
                            </span>
                            <sl-icon name="${iconClass.split(' ')[0]}" class="text-base flex-shrink-0 ${iconClass.split(' ')[1] || ''}"></sl-icon>
                            <div class="min-w-0 flex-1">
                              <div class="flex items-center gap-2">
                                <span class="text-xs font-semibold text-slate-900 truncate">${esc(it.title)}</span>
                                <span class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.2 rounded bg-slate-100 text-slate-600">${esc(kind)}</span>
                              </div>
                              <div class="flex items-center gap-2 text-[11px] text-slate-500 mt-0.5">
                                ${it.due_date ? `
                                  <span class="text-amber-700 font-medium flex items-center gap-1">
                                    <sl-icon name="calendar-event"></sl-icon> Due: ${esc(it.due_date)}${it.due_time ? ' ' + esc(it.due_time) : ''}
                                  </span>
                                ` : '<span class="text-slate-400">No due date</span>'}
                                <span>•</span>
                                <span>${it.points ?? 100} pts</span>
                              </div>
                            </div>
                          </div>

                          <div class="flex items-center gap-1 flex-shrink-0">
                            <!-- Direct Edit / Open Button -->
                            <sl-tooltip content="Open / Edit Content">
                              <sl-button size="small" variant="text" class="btn-open-editor" data-kind="${esc(kind)}" data-source-id="${esc(sourceId)}">
                                <sl-icon name="pencil-square" class="text-indigo-600"></sl-icon>
                              </sl-button>
                            </sl-tooltip>

                            <!-- Submissions Button (for tasks and assessments) -->
                            ${kind === 'task' || kind === 'assignment' ? `
                              <sl-tooltip content="View Student Submissions">
                                <sl-button size="small" variant="text" class="btn-view-submissions" data-kind="${esc(kind)}" data-source-id="${esc(sourceId)}">
                                  <sl-icon name="inbox" class="text-amber-600"></sl-icon>
                                </sl-button>
                              </sl-tooltip>
                            ` : ''}

                            <!-- Move Up / Down Buttons -->
                            ${itIdx > 0 ? `
                              <sl-tooltip content="Move Up">
                                <sl-button size="small" variant="text" class="btn-move-item-up" data-item-id="${esc(it.id)}" data-unit-id="${esc(u.id)}">
                                  <sl-icon name="arrow-up" class="text-slate-400"></sl-icon>
                                </sl-button>
                              </sl-tooltip>
                            ` : ''}
                            ${itIdx < unitItems.length - 1 ? `
                              <sl-tooltip content="Move Down">
                                <sl-button size="small" variant="text" class="btn-move-item-down" data-item-id="${esc(it.id)}" data-unit-id="${esc(u.id)}">
                                  <sl-icon name="arrow-down" class="text-slate-400"></sl-icon>
                                </sl-button>
                              </sl-tooltip>
                            ` : ''}

                            <!-- Item Actions Dropdown -->
                            <sl-dropdown placement="bottom-end">
                              <button slot="trigger" class="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer" aria-label="Item menu">
                                <sl-icon name="three-dots-vertical"></sl-icon>
                              </button>
                              <sl-menu>
                                <sl-menu-item class="btn-change-item-due" data-id="${esc(it.id)}" data-kind="${esc(kind)}" data-source-id="${esc(sourceId)}">
                                  <sl-icon slot="prefix" name="calendar-date"></sl-icon> Change Due Date...
                                </sl-menu-item>
                                ${units.length > 1 ? `
                                  <sl-menu-item class="btn-move-item-dialog" data-item-id="${esc(it.id)}" data-unit-id="${esc(u.id)}">
                                    <sl-icon slot="prefix" name="folder-symlink"></sl-icon> Move to Folder...
                                  </sl-menu-item>
                                ` : ''}
                                <sl-divider></sl-divider>
                                <sl-menu-item class="btn-remove-item text-rose-600" data-id="${esc(it.id)}">
                                  <sl-icon slot="prefix" name="trash"></sl-icon> Remove from Folder
                                </sl-menu-item>
                              </sl-menu>
                            </sl-dropdown>
                          </div>
                        </div>
                      `;
                    }).join('')}
                  </div>
                </section>
              `;
            }).join('')}
          </div>
        </main>
      </div>
    `;

    // -------------------------------------------------------------------------
    // Bind Unit Handlers (Add, Edit, Move, Delete, Collapse)
    // -------------------------------------------------------------------------
    container.querySelector('#btn-add-unit')?.addEventListener('click', () => {
      openUnitModal({ courseId, totalUnits: units.length, onSaved: () => { markCourseFeedDirty(courseId); render(); } });
    });

    container.querySelector('#btn-add-unit-empty')?.addEventListener('click', () => {
      openUnitModal({ courseId, totalUnits: units.length, onSaved: () => { markCourseFeedDirty(courseId); render(); } });
    });

    container.querySelectorAll('.btn-edit-unit, .menu-edit-unit').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const uId = el.dataset.unitId;
        const targetUnit = units.find(u => u.id === uId);
        if (targetUnit) {
          openUnitModal({ courseId, unit: targetUnit, totalUnits: units.length, onSaved: () => { markCourseFeedDirty(courseId); render(); } });
        }
      });
    });

    container.querySelectorAll('.btn-toggle-collapse').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const uId = btn.dataset.unitId;
        if (collapsedUnits.has(uId)) {
          collapsedUnits.delete(uId);
        } else {
          collapsedUnits.add(uId);
        }
        render();
      });
    });

    container.querySelectorAll('.menu-move-unit-up').forEach(el => {
      el.addEventListener('click', async () => {
        const uId = el.dataset.unitId;
        const idx = units.findIndex(u => u.id === uId);
        if (idx > 0) {
          const temp = units[idx];
          units[idx] = units[idx - 1];
          units[idx - 1] = temp;
          for (let i = 0; i < units.length; i++) {
            units[i].order = i;
            units[i].updated_at = new Date().toISOString();
            await storage.table('course_units').put(units[i]);
          }
          await markCourseFeedDirty(courseId);
          render();
        }
      });
    });

    container.querySelectorAll('.menu-move-unit-down').forEach(el => {
      el.addEventListener('click', async () => {
        const uId = el.dataset.unitId;
        const idx = units.findIndex(u => u.id === uId);
        if (idx < units.length - 1) {
          const temp = units[idx];
          units[idx] = units[idx + 1];
          units[idx + 1] = temp;
          for (let i = 0; i < units.length; i++) {
            units[i].order = i;
            units[i].updated_at = new Date().toISOString();
            await storage.table('course_units').put(units[i]);
          }
          await markCourseFeedDirty(courseId);
          render();
        }
      });
    });

    container.querySelectorAll('.menu-delete-unit').forEach(el => {
      el.addEventListener('click', async () => {
        const uId = el.dataset.unitId;
        const confirmed = await ConfirmDialog.show({
          title: 'Delete Folder / Unit',
          message: 'Are you sure you want to delete this folder? Items in this folder will be unlinked from the course syllabus, but remain safely in your library.',
          confirmText: 'Delete Folder',
          confirmVariant: 'danger'
        });
        if (!confirmed) return;

        await storage.table('course_units').delete(uId);
        const unitItems = await storage.table('course_items').where('unit_id').equals(uId).toArray();
        for (const it of unitItems) {
          await storage.table('course_items').delete(it.id);
        }
        await markCourseFeedDirty(courseId);
        toast.info('Folder deleted.');
        render();
      });
    });

    // -------------------------------------------------------------------------
    // Bind Item Action Handlers
    // -------------------------------------------------------------------------
    container.querySelectorAll('.btn-add-item-to-unit').forEach(btn => {
      btn.addEventListener('click', () => {
        const uId = btn.dataset.unitId;
        openAddItemDialog(courseId, uId, () => { markCourseFeedDirty(courseId); render(); });
      });
    });

    container.querySelectorAll('.btn-open-editor').forEach(btn => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.kind;
        const sourceId = btn.dataset.sourceId;
        if (kind === 'task') {
          router.navigate(`#/assignments/edit?id=${encodeURIComponent(sourceId)}&returnCourseId=${encodeURIComponent(courseId)}`);
        } else if (kind === 'assignment') {
          router.navigate(`#/assessments/edit?id=${encodeURIComponent(sourceId)}&returnCourseId=${encodeURIComponent(courseId)}`);
        } else if (kind === 'flashcards') {
          router.navigate(`#/flashcards/edit?id=${encodeURIComponent(sourceId)}&returnCourseId=${encodeURIComponent(courseId)}`);
        } else if (kind === 'timeline') {
          router.navigate(`#/timeline?id=${encodeURIComponent(sourceId)}&returnCourseId=${encodeURIComponent(courseId)}`);
        } else if (kind === 'video') {
          router.navigate(`#/video/edit?id=${encodeURIComponent(sourceId)}&returnCourseId=${encodeURIComponent(courseId)}`);
        }
      });
    });

    container.querySelectorAll('.btn-view-submissions').forEach(btn => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.kind;
        const sourceId = btn.dataset.sourceId;
        if (kind === 'task') {
          router.navigate(`#/assignments/submissions?id=${encodeURIComponent(sourceId)}`);
        } else if (kind === 'assignment') {
          router.navigate(`#/assessments/submissions?assignmentId=${encodeURIComponent(sourceId)}`);
        }
      });
    });

    container.querySelectorAll('.btn-change-item-due').forEach(btn => {
      btn.addEventListener('click', async () => {
        const itemId = btn.dataset.id;
        const kind = btn.dataset.kind;
        const sourceId = btn.dataset.sourceId;
        await openChangeDueDialog(kind, sourceId, itemId, () => { markCourseFeedDirty(courseId); render(); });
      });
    });

    container.querySelectorAll('.btn-remove-item').forEach(btn => {
      btn.addEventListener('click', async () => {
        const itemId = btn.dataset.id;
        await storage.table('course_items').delete(itemId);
        await markCourseFeedDirty(courseId);
        toast.info('Item removed from course.');
        render();
      });
    });

    // Move item up / down buttons
    container.querySelectorAll('.btn-move-item-up').forEach(btn => {
      btn.addEventListener('click', async () => {
        const itemId = btn.dataset.itemId;
        const unitId = btn.dataset.unitId;
        const unitItems = items.filter(it => it.unit_id === unitId);
        const idx = unitItems.findIndex(it => it.id === itemId);
        if (idx > 0) {
          const temp = unitItems[idx];
          unitItems[idx] = unitItems[idx - 1];
          unitItems[idx - 1] = temp;
          for (let i = 0; i < unitItems.length; i++) {
            unitItems[i].order = i;
            unitItems[i].updated_at = new Date().toISOString();
            await storage.table('course_items').put(unitItems[i]);
          }
          await markCourseFeedDirty(courseId);
          render();
        }
      });
    });

    container.querySelectorAll('.btn-move-item-down').forEach(btn => {
      btn.addEventListener('click', async () => {
        const itemId = btn.dataset.itemId;
        const unitId = btn.dataset.unitId;
        const unitItems = items.filter(it => it.unit_id === unitId);
        const idx = unitItems.findIndex(it => it.id === itemId);
        if (idx < unitItems.length - 1) {
          const temp = unitItems[idx];
          unitItems[idx] = unitItems[idx + 1];
          unitItems[idx + 1] = temp;
          for (let i = 0; i < unitItems.length; i++) {
            unitItems[i].order = i;
            unitItems[i].updated_at = new Date().toISOString();
            await storage.table('course_items').put(unitItems[i]);
          }
          await markCourseFeedDirty(courseId);
          render();
        }
      });
    });

    // Move to another unit dialog
    container.querySelectorAll('.btn-move-item-dialog').forEach(btn => {
      btn.addEventListener('click', async () => {
        const itemId = btn.dataset.itemId;
        const currentUnitId = btn.dataset.unitId;
        openMoveItemModal({ itemId, currentUnitId, units, onMoved: () => { markCourseFeedDirty(courseId); render(); } });
      });
    });

    // -------------------------------------------------------------------------
    // HTML5 Drag-and-Drop Item & Unit Reordering
    // -------------------------------------------------------------------------
    initDragAndDrop(container, {
      courseId,
      units,
      items,
      onReordered: async () => {
        await markCourseFeedDirty(courseId);
        render();
      }
    });

    // -------------------------------------------------------------------------
    // Publish Feed Handler
    // -------------------------------------------------------------------------
    container.querySelector('#btn-publish-feed')?.addEventListener('click', async () => {
      const btn = container.querySelector('#btn-publish-feed');
      btn.loading = true;
      try {
        const transport = await getTransport();
        const hasRelay = isTeacherRelayConfigured(transport);
        const relayUrl = hasRelay ? transport.baseUrl : null;
        const feed = await buildCourseFeed(courseId, { relayUrl });

        if (hasRelay) {
          const feedId = await deriveCourseFeedId(course.access_code || courseId);
          const feedTransport = new PublicFeedTransport({ baseUrl: transport.baseUrl, token: transport.token });
          await feedTransport.publishCourseFeed(feedId, feed.ciphertext, feed.etag);
          await markFeedPublished(courseId, feed.etag);
          toast.success('Course feed published to server!');
        } else {
          await markFeedPublished(courseId, feed.etag);
          toast.success('Course feed packaged!');
        }
        await openShareCoursePackageDialog(course);
        render();
      } catch (err) {
        console.error('Failed to publish course feed:', err);
        toast.danger('Could not publish course feed: ' + err.message);
      } finally {
        btn.loading = false;
      }
    });

    // Student Card / QR
    container.querySelector('#btn-course-share-card')?.addEventListener('click', () => {
      openShareCoursePackageDialog(course);
    });
  };

  await render();
}

/**
 * Initialize Drag and Drop for both Items (intra-unit and cross-unit) and Units.
 */
function initDragAndDrop(container, { courseId, units, items, onReordered }) {
  let draggedItemId = null;
  let draggedUnitId = null;

  // 1. Item rows
  container.querySelectorAll('.item-row').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      draggedItemId = row.dataset.itemId;
      draggedUnitId = null;
      e.dataTransfer.setData('text/plain', draggedItemId);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('opacity-50');
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('opacity-50');
      container.querySelectorAll('.item-row').forEach(r => r.classList.remove('border-t-2', 'border-b-2', 'border-primary-500'));
      container.querySelectorAll('.unit-items-container').forEach(c => c.classList.remove('ring-2', 'ring-primary-500'));
    });

    row.addEventListener('dragover', (e) => {
      if (!draggedItemId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      row.classList.remove('border-t-2', 'border-b-2', 'border-primary-500');
      if (e.clientY < mid) {
        row.classList.add('border-t-2', 'border-primary-500');
      } else {
        row.classList.add('border-b-2', 'border-primary-500');
      }
    });

    row.addEventListener('drop', async (e) => {
      if (!draggedItemId || draggedItemId === row.dataset.itemId) return;
      e.preventDefault();
      e.stopPropagation();

      const targetItemId = row.dataset.itemId;
      const targetUnitId = row.dataset.unitId;
      const rect = row.getBoundingClientRect();
      const insertBefore = e.clientY < (rect.top + rect.height / 2);

      const draggedItem = items.find(it => it.id === draggedItemId);
      if (!draggedItem) return;

      // Update unit_id
      draggedItem.unit_id = targetUnitId;

      // Re-order within target unit
      const targetUnitItems = items.filter(it => it.unit_id === targetUnitId && it.id !== draggedItemId);
      const targetIndex = targetUnitItems.findIndex(it => it.id === targetItemId);
      const insertIndex = insertBefore ? targetIndex : targetIndex + 1;
      targetUnitItems.splice(insertIndex, 0, draggedItem);

      for (let i = 0; i < targetUnitItems.length; i++) {
        targetUnitItems[i].order = i;
        targetUnitItems[i].updated_at = new Date().toISOString();
        await storage.table('course_items').put(targetUnitItems[i]);
      }

      onReordered();
    });
  });

  // 2. Unit empty dropzones
  container.querySelectorAll('[data-unit-dropzone]').forEach(zone => {
    zone.addEventListener('dragover', (e) => {
      if (!draggedItemId) return;
      e.preventDefault();
      zone.classList.add('ring-2', 'ring-primary-400');
    });

    zone.addEventListener('dragleave', () => {
      zone.classList.remove('ring-2', 'ring-primary-400');
    });

    zone.addEventListener('drop', async (e) => {
      if (!draggedItemId) return;
      e.preventDefault();
      const targetUnitId = zone.dataset.unitDropzone;
      const draggedItem = items.find(it => it.id === draggedItemId);
      if (draggedItem && draggedItem.unit_id !== targetUnitId) {
        draggedItem.unit_id = targetUnitId;
        const targetUnitItems = items.filter(it => it.unit_id === targetUnitId && it.id !== draggedItemId);
        draggedItem.order = targetUnitItems.length;
        draggedItem.updated_at = new Date().toISOString();
        await storage.table('course_items').put(draggedItem);
        onReordered();
      }
    });
  });
}

/**
 * Modal to move an item to another unit via dropdown selection
 */
function openMoveItemModal({ itemId, currentUnitId, units, onMoved }) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Move Item to Folder';
  dialog.innerHTML = `
    <div class="space-y-4 py-1 text-sm">
      <p class="text-xs text-slate-600">Select which folder you would like to move this lesson into:</p>
      <sl-select id="select-dest-unit" label="Destination Folder" value="${units.find(u => u.id !== currentUnitId)?.id || ''}">
        ${units.filter(u => u.id !== currentUnitId).map(u => `
          <sl-option value="${esc(u.id)}">${esc(u.title || 'Untitled Unit')}</sl-option>
        `).join('')}
      </sl-select>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button id="btn-cancel-move">Cancel</sl-button>
      <sl-button variant="primary" id="btn-confirm-move">Move Item</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-cancel-move')?.addEventListener('click', () => dialog.hide());
  dialog.querySelector('#btn-confirm-move')?.addEventListener('click', async () => {
    const destUnitId = dialog.querySelector('#select-dest-unit')?.value;
    if (!destUnitId) return;

    const it = await storage.table('course_items').get(itemId);
    if (it) {
      it.unit_id = destUnitId;
      const count = await storage.table('course_items').where('unit_id').equals(destUnitId).count();
      it.order = count;
      it.updated_at = new Date().toISOString();
      await storage.table('course_items').put(it);
      toast.success('Moved item to folder!');
    }
    dialog.hide();
    if (onMoved) onMoved();
  });

  dialog.addEventListener('sl-after-hide', () => dialog.remove());
}

/**
 * Unit Creation & Editing Modal (Color coding, Title, Description)
 */
function openUnitModal({ courseId, unit = null, totalUnits = 0, onSaved }) {
  const isEdit = !!unit;
  const dialog = document.createElement('sl-dialog');
  dialog.label = isEdit ? 'Edit Folder / Unit' : 'New Folder / Unit';
  dialog.style.setProperty('--width', '520px');

  let activeColor = unit?.color || UNIT_PALETTE[totalUnits % UNIT_PALETTE.length].hex;

  dialog.innerHTML = `
    <div class="space-y-4 py-1 text-sm">
      <sl-input id="input-unit-title" label="Folder / Unit Title" placeholder="e.g. Unit 1: Introduction to Mechanics" value="${esc(unit?.title || '')}" required></sl-input>
      <sl-textarea id="input-unit-desc" label="Description / Overview (Optional)" placeholder="What students will learn in this unit..." value="${esc(unit?.description || '')}" rows="2"></sl-textarea>
      
      <div>
        <label class="text-xs font-semibold text-slate-700 block mb-2">Folder Accent Color</label>
        <div class="flex items-center gap-2.5 flex-wrap" id="unit-color-swatches">
          ${UNIT_PALETTE.map(c => `
            <button type="button" class="w-8 h-8 rounded-full cursor-pointer transition-transform hover:scale-110 flex items-center justify-center color-swatch-btn ${activeColor === c.hex ? 'ring-2 ring-offset-2 ring-slate-800 scale-105' : ''}" style="background-color: ${c.hex};" data-color="${c.hex}" title="${c.name}">
              ${activeColor === c.hex ? '<sl-icon name="check" class="text-white text-xs"></sl-icon>' : ''}
            </button>
          `).join('')}
        </div>
      </div>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button id="btn-cancel-unit">Cancel</sl-button>
      <sl-button variant="primary" id="btn-save-unit">${isEdit ? 'Save Changes' : 'Create Unit'}</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelectorAll('.color-swatch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeColor = btn.dataset.color;
      dialog.querySelectorAll('.color-swatch-btn').forEach(b => {
        b.className = 'w-8 h-8 rounded-full cursor-pointer transition-transform hover:scale-110 flex items-center justify-center color-swatch-btn';
        b.innerHTML = '';
      });
      btn.className = 'w-8 h-8 rounded-full cursor-pointer transition-transform hover:scale-110 flex items-center justify-center color-swatch-btn ring-2 ring-offset-2 ring-slate-800 scale-105';
      btn.innerHTML = '<sl-icon name="check" class="text-white text-xs"></sl-icon>';
    });
  });

  dialog.querySelector('#btn-cancel-unit')?.addEventListener('click', () => dialog.hide());
  dialog.querySelector('#btn-save-unit')?.addEventListener('click', async () => {
    const title = dialog.querySelector('#input-unit-title')?.value?.trim();
    const desc = dialog.querySelector('#input-unit-desc')?.value?.trim();
    if (!title) {
      toast.warning('Please enter a unit title.');
      return;
    }

    if (isEdit) {
      unit.title = title;
      unit.description = desc || '';
      unit.color = activeColor;
      unit.updated_at = new Date().toISOString();
      await storage.table('course_units').put(unit);
      toast.success('Unit updated!');
    } else {
      const newUnit = {
        id: generateUUID(),
        course_id: courseId,
        title,
        description: desc || '',
        color: activeColor,
        order: totalUnits,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      await storage.table('course_units').put(newUnit);
      toast.success('Unit created!');
    }

    dialog.hide();
    if (onSaved) onSaved();
  });

  dialog.addEventListener('sl-after-hide', () => dialog.remove());
}

/**
 * Dual-Mode Dialog: "Create New Content" Directly or "Select from Library"
 */
async function openAddItemDialog(courseId, unitId, onAdded) {
  const [tasks, assignments, decks, timelines, videos] = await Promise.all([
    storage.table('tasks').toArray().catch(() => []),
    storage.table('assignments').toArray().catch(() => []),
    storage.table('flashcards').toArray().catch(() => []),
    storage.table('timelines').toArray().catch(() => []),
    storage.table('video_assessments').toArray().catch(() => [])
  ]);

  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Add or Create Item for Unit';
  dialog.style.setProperty('--width', '640px');

  dialog.innerHTML = `
    <sl-tab-group>
      <sl-tab slot="nav" panel="create">Create New Content</sl-tab>
      <sl-tab slot="nav" panel="library">From Existing Library</sl-tab>

      <!-- Panel 1: Create New Directly -->
      <sl-tab-panel name="create" class="space-y-4 pt-3">
        <p class="text-xs text-slate-500">
          Create new content pre-linked to this class and unit. You can jump directly into the editor or keep building your syllabus.
        </p>

        <sl-select label="Content Type" id="new-item-type" value="task">
          <sl-option value="task">Assignment / Task (prompt, rubric, student file/code submission)</sl-option>
          <sl-option value="assignment">Assessment / Quiz (auto-graded multiple choice &amp; questions)</sl-option>
          <sl-option value="flashcards">Flashcard Deck (FSRS spaced repetition deck)</sl-option>
          <sl-option value="timeline">Timeline (chronological event sequence)</sl-option>
          <sl-option value="video">Interactive Video (video lesson with checkpoints)</sl-option>
          <sl-option value="link">Resource Link / External URL</sl-option>
        </sl-select>

        <sl-input id="new-item-title" label="Title" placeholder="e.g. Lab Report 1 or Unit Quiz" required></sl-input>

        <div class="grid grid-cols-2 gap-3" id="create-scoring-row">
          <sl-input type="date" id="new-item-due" label="Due Date (optional)"></sl-input>
          <sl-input type="number" id="new-item-points" label="Points" value="100"></sl-input>
        </div>

        <div id="create-url-row" class="hidden">
          <sl-input id="new-item-url" label="Resource URL / Link" placeholder="https://..."></sl-input>
        </div>

        <div class="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <sl-button variant="default" id="btn-create-and-stay">Create &amp; Stay</sl-button>
          <sl-button variant="primary" id="btn-create-and-edit">Create &amp; Open Editor</sl-button>
        </div>
      </sl-tab-panel>

      <!-- Panel 2: Pick Existing from Library -->
      <sl-tab-panel name="library" class="space-y-4 pt-3">
        <sl-select label="Select Content Source" id="sel-item-source" value="${tasks.length ? 'task' : 'assignment'}">
          <sl-option value="task">Assignments (${tasks.length} available)</sl-option>
          <sl-option value="assignment">Assessments (${assignments.length} available)</sl-option>
          <sl-option value="flashcards">Flashcard Decks (${decks.length} available)</sl-option>
          <sl-option value="timeline">Timelines (${timelines.length} available)</sl-option>
          <sl-option value="video">Video Assessments (${videos.length} available)</sl-option>
        </sl-select>

        <div id="content-selector-mount"></div>

        <div class="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <sl-button variant="default" id="btn-cancel-library">Cancel</sl-button>
          <sl-button variant="primary" id="btn-confirm-add-library">Add Selected to Unit</sl-button>
        </div>
      </sl-tab-panel>
    </sl-tab-group>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  // Handle Type Change in Panel 1
  const typeSelect = dialog.querySelector('#new-item-type');
  const scoringRow = dialog.querySelector('#create-scoring-row');
  const urlRow = dialog.querySelector('#create-url-row');
  typeSelect?.addEventListener('sl-change', () => {
    const val = typeSelect.value;
    if (val === 'link') {
      scoringRow?.classList.add('hidden');
      urlRow?.classList.remove('hidden');
    } else {
      scoringRow?.classList.remove('hidden');
      urlRow?.classList.add('hidden');
    }
  });

  // Handle Panel 1 Creation
  const handleDirectCreate = async (openEditor = false) => {
    const type = typeSelect.value;
    const title = dialog.querySelector('#new-item-title')?.value?.trim();
    const dueDate = dialog.querySelector('#new-item-due')?.value || null;
    const points = parseInt(dialog.querySelector('#new-item-points')?.value || '100', 10);
    const linkUrl = dialog.querySelector('#new-item-url')?.value?.trim() || '';

    if (!title) {
      toast.warning('Please enter a title for the new item.');
      return;
    }

    const newSourceId = generateUUID();
    const now = new Date().toISOString();

    if (type === 'task') {
      const newTask = {
        id: newSourceId,
        title,
        description: '',
        class_id: courseId,
        gradebook: { course_id: courseId },
        submission_types: { text: { enabled: true }, code: { enabled: false }, drawing: { enabled: false }, files: { enabled: true } },
        grading: { scoring: 'points', max_points: points || 100 },
        settings: { due_date: dueDate, allow_resubmit: true },
        created_at: now,
        updated_at: now
      };
      await storage.table('tasks').put(newTask);
      try {
        await GradebookBridge.upsertLinkedColumn({
          courseId,
          source: { type: 'task', id: newSourceId },
          title,
          maxScore: points || 100,
          dueDate
        });
      } catch (_) {}
    } else if (type === 'assignment') {
      const newAsg = {
        id: newSourceId,
        title,
        class_id: courseId,
        gradebook: { course_id: courseId },
        questions: [],
        settings: { due_date: dueDate },
        total_points: points || 100,
        created_at: now,
        updated_at: now
      };
      await storage.table('assignments').put(newAsg);
      try {
        await GradebookBridge.upsertLinkedColumn({
          courseId,
          source: { type: 'assignment', id: newSourceId },
          title,
          maxScore: points || 100,
          dueDate
        });
      } catch (_) {}
    } else if (type === 'flashcards') {
      await storage.table('flashcards').put({
        id: newSourceId,
        title,
        class_id: courseId,
        cards: [],
        created_at: now,
        updated_at: now
      });
    } else if (type === 'timeline') {
      await storage.table('timelines').put({
        id: newSourceId,
        title,
        class_id: courseId,
        events: [],
        created_at: now,
        updated_at: now
      });
    } else if (type === 'video') {
      await storage.table('video_assessments').put({
        id: newSourceId,
        title,
        class_id: courseId,
        video_url: '',
        questions: [],
        created_at: now,
        updated_at: now
      });
    }

    // Insert into course_items
    const existingCount = await storage.table('course_items').where('unit_id').equals(unitId).count();
    const newItem = {
      id: generateUUID(),
      course_id: courseId,
      unit_id: unitId,
      title,
      kind: type,
      source_id: newSourceId,
      order: existingCount,
      points: points || 100,
      due_date: dueDate,
      settings: type === 'link' ? { url: linkUrl } : {},
      created_at: now
    };
    await storage.table('course_items').put(newItem);

    dialog.hide();
    toast.success(`Created "${title}" and added to unit!`);
    if (onAdded) onAdded();

    if (openEditor) {
      if (type === 'task') {
        router.navigate(`#/assignments/edit?id=${encodeURIComponent(newSourceId)}&returnCourseId=${encodeURIComponent(courseId)}`);
      } else if (type === 'assignment') {
        router.navigate(`#/assessments/edit?id=${encodeURIComponent(newSourceId)}&returnCourseId=${encodeURIComponent(courseId)}`);
      } else if (type === 'flashcards') {
        router.navigate(`#/flashcards/edit?id=${encodeURIComponent(newSourceId)}&returnCourseId=${encodeURIComponent(courseId)}`);
      } else if (type === 'timeline') {
        router.navigate(`#/timeline?id=${encodeURIComponent(newSourceId)}&returnCourseId=${encodeURIComponent(courseId)}`);
      } else if (type === 'video') {
        router.navigate(`#/video/edit?id=${encodeURIComponent(newSourceId)}&returnCourseId=${encodeURIComponent(courseId)}`);
      }
    }
  };

  dialog.querySelector('#btn-create-and-stay')?.addEventListener('click', () => handleDirectCreate(false));
  dialog.querySelector('#btn-create-and-edit')?.addEventListener('click', () => handleDirectCreate(true));

  // Panel 2 Existing Library Handler
  const sourceSelect = dialog.querySelector('#sel-item-source');
  const mount = dialog.querySelector('#content-selector-mount');

  const updateSelect = () => {
    const val = sourceSelect.value;
    let items = [];
    if (val === 'task') items = tasks;
    else if (val === 'assignment') items = assignments;
    else if (val === 'flashcards') items = decks;
    else if (val === 'timeline') items = timelines;
    else if (val === 'video') items = videos;

    if (items.length === 0) {
      mount.innerHTML = `<p class="text-xs text-slate-400 py-2">No items found in your library for this category.</p>`;
      return;
    }

    mount.innerHTML = `
      <sl-select label="Choose Item" id="sel-target-item" value="${esc(items[0]?.id)}">
        ${items.map(it => `<sl-option value="${esc(it.id)}">${esc(it.title || it.name || 'Untitled')}</sl-option>`).join('')}
      </sl-select>
    `;
  };

  updateSelect();
  sourceSelect.addEventListener('sl-change', updateSelect);

  dialog.querySelector('#btn-cancel-library')?.addEventListener('click', () => dialog.hide());
  dialog.querySelector('#btn-confirm-add-library')?.addEventListener('click', async () => {
    const targetSelect = dialog.querySelector('#sel-target-item');
    const selectedId = targetSelect?.value;
    const kind = sourceSelect.value;

    if (!selectedId) {
      toast.warning('Please select an item.');
      return;
    }

    let sourceItem = null;
    if (kind === 'task') sourceItem = tasks.find(t => t.id === selectedId);
    else if (kind === 'assignment') sourceItem = assignments.find(a => a.id === selectedId);
    else if (kind === 'flashcards') sourceItem = decks.find(d => d.id === selectedId);
    else if (kind === 'timeline') sourceItem = timelines.find(t => t.id === selectedId);
    else if (kind === 'video') sourceItem = videos.find(v => v.id === selectedId);

    // Link class_id if not linked
    if (sourceItem && !sourceItem.class_id) {
      sourceItem.class_id = courseId;
      sourceItem.updated_at = new Date().toISOString();
      if (kind === 'task') await storage.table('tasks').put(sourceItem);
      else if (kind === 'assignment') await storage.table('assignments').put(sourceItem);
      else if (kind === 'flashcards') await storage.table('flashcards').put(sourceItem);
      else if (kind === 'timeline') await storage.table('timelines').put(sourceItem);
      else if (kind === 'video') await storage.table('video_assessments').put(sourceItem);
    }

    const title = sourceItem?.title || sourceItem?.name || 'Untitled Item';
    const existingCount = await storage.table('course_items').where('unit_id').equals(unitId).count();
    const newItem = {
      id: generateUUID(),
      course_id: courseId,
      unit_id: unitId,
      title,
      kind,
      source_id: selectedId,
      order: existingCount,
      points: sourceItem?.total_points || 100,
      due_date: sourceItem?.due_date || null,
      due_time: sourceItem?.due_time || null,
      created_at: new Date().toISOString()
    };

    await storage.table('course_items').put(newItem);
    dialog.hide();
    toast.success(`Added "${title}" to unit!`);
    if (onAdded) onAdded();
  });

  dialog.addEventListener('sl-after-hide', () => dialog.remove());
}

async function openChangeDueDialog(kind, sourceId, itemId, onSaved) {
  const due = await getDue(kind, sourceId).catch(() => ({ date: null, time: null }));

  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Update Due Date';
  dialog.innerHTML = `
    <div class="space-y-3 py-1 text-sm">
      <sl-input type="date" id="input-due-date" label="Due Date" value="${esc(due?.date || '')}"></sl-input>
      <sl-input type="time" id="input-due-time" label="Due Time" value="${esc(due?.time || '')}"></sl-input>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-cancel-due">Cancel</sl-button>
      <sl-button variant="primary" id="btn-save-due">Save Due Date</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-cancel-due')?.addEventListener('click', () => dialog.hide());
  dialog.querySelector('#btn-save-due')?.addEventListener('click', async () => {
    const date = dialog.querySelector('#input-due-date')?.value || null;
    const time = dialog.querySelector('#input-due-time')?.value || null;

    await setDue(kind, sourceId, { date, time });

    if (itemId) {
      const it = await storage.table('course_items').get(itemId);
      if (it) {
        it.due_date = date;
        it.due_time = time;
        it.updated_at = new Date().toISOString();
        await storage.table('course_items').put(it);
      }
    }

    dialog.hide();
    toast.success('Due date updated across all course views!');
    if (onSaved) onSaved();
  });

  dialog.addEventListener('sl-after-hide', () => dialog.remove());
}

async function openShareCoursePackageDialog(course) {
  const { CryptoShareEngine } = await import('../../core/crypto-share.js');
  const { downloadClickableHtmlFile } = await import('../../core/html-launcher.js');
  const { showQrSequence } = await import('../../components/qr-handoff.js');
  const { buildCourseFeed } = await import('../../core/course-feed.js');

  // Ensure course has a valid access_code
  if (!course.access_code) {
    const { AccessCodes } = await import('../../core/access-codes.js');
    course.access_code = AccessCodes.generateCode(6);
    await storage.table('gradebook_courses').put(course);
  }

  toast.info('Preparing course package...', 1500);
  let sharePayload = null;
  const transport = await getTransport();
  const hasRelay = isTeacherRelayConfigured(transport);
  const relayUrl = hasRelay ? transport.baseUrl : null;
  try {
    const feed = await buildCourseFeed(course.id, { relayUrl });
    sharePayload = await CryptoShareEngine.createSharePayload('course_feed', feed.raw_payload, course.access_code);
  } catch (err) {
    console.error('Failed to create course package:', err);
    toast.danger('Could not build course package: ' + err.message);
    return;
  }

  const base = window.location.origin + window.location.pathname;
  let joinUrl = `${base}#/student?code=${encodeURIComponent(course.access_code || '')}`;
  if (hasRelay && relayUrl) {
    joinUrl += `&relay=${encodeURIComponent(relayUrl)}`;
  }
  const shareUrl = sharePayload.url;

  let qrSvg = '';
  try {
    qrSvg = QRCode.generateSVG(joinUrl, { size: 160, margin: 1 });
  } catch {
    qrSvg = '<span>QR Code</span>';
  }

  const dialog = document.createElement('sl-dialog');
  dialog.label = `Share Course · ${course.name}`;
  dialog.style.setProperty('--width', 'min(580px, 96vw)');
  dialog.innerHTML = `
    <div class="space-y-4">
      <div class="rounded-xl border border-primary-200 bg-primary-50/60 p-4 flex items-center justify-between gap-4">
        <div>
          <h3 class="font-bold text-slate-900">${esc(course.name)}</h3>
          <p class="text-xs text-slate-600 mt-0.5">${esc(course.section || '')} ${course.academic_year ? '• ' + esc(course.academic_year) : ''}</p>
        </div>
        <div class="text-right">
          <span class="text-[10px] uppercase font-bold text-slate-500 block">Access Code</span>
          <span class="font-mono font-bold text-primary-700 text-lg">${esc(course.access_code || '------')}</span>
        </div>
      </div>

      <div class="flex justify-center p-2 bg-slate-50 rounded-xl border border-slate-100">
        ${qrSvg}
      </div>

      <div class="space-y-3">
        <div>
          <label class="text-xs font-semibold text-slate-700 block mb-1">Student Join Link (Instant Enrollment)</label>
          <div class="flex gap-2">
            <sl-input id="input-join-url" value="${esc(joinUrl)}" readonly size="small" class="flex-1 font-mono text-xs"></sl-input>
            <sl-button size="small" variant="default" id="btn-copy-join">
              <sl-icon slot="prefix" name="clipboard"></sl-icon> Copy
            </sl-button>
          </div>
        </div>

        <div>
          <label class="text-xs font-semibold text-slate-700 block mb-1">Encrypted Offline Course Package Link</label>
          <div class="flex gap-2">
            <sl-input id="input-feed-url" value="${esc(shareUrl)}" readonly size="small" class="flex-1 font-mono text-xs"></sl-input>
            <sl-button size="small" variant="default" id="btn-copy-feed">
              <sl-icon slot="prefix" name="clipboard"></sl-icon> Copy
            </sl-button>
          </div>
        </div>
      </div>

      <div class="pt-2 border-t border-slate-100 flex flex-wrap gap-2">
        <sl-button size="small" variant="primary" id="btn-show-course-qr">
          <sl-icon slot="prefix" name="qr-code-scan"></sl-icon> Project Join QR
        </sl-button>
        <sl-button size="small" variant="default" id="btn-download-course-html">
          <sl-icon slot="prefix" name="file-earmark-code"></sl-icon> Clickable Course (.html)
        </sl-button>
        <sl-button size="small" variant="default" id="btn-download-course-file">
          <sl-icon slot="prefix" name="file-earmark-arrow-down"></sl-icon> Download .kbshare
        </sl-button>
      </div>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="primary" id="btn-close-share">Done</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-close-share')?.addEventListener('click', () => dialog.hide());
  dialog.querySelector('#btn-copy-join')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      toast.success('Join link copied!');
    } catch (_) {
      toast.warning('Copy failed.');
    }
  });

  dialog.querySelector('#btn-copy-feed')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success('Course package link copied!');
    } catch (_) {
      toast.warning('Copy failed.');
    }
  });

  dialog.querySelector('#btn-show-course-qr')?.addEventListener('click', () => {
    showQrSequence(joinUrl, {
      title: `Enroll in ${course.name}`,
      intro: `Scan with camera to enroll in ${course.name} (Code: ${course.access_code}).`,
      preferDirectUrl: true
    });
  });

  dialog.querySelector('#btn-download-course-html')?.addEventListener('click', () => {
    const cleanName = (course.name || 'course').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    downloadClickableHtmlFile({
      title: `${course.name} · Course Package`,
      payloadType: 'course_feed',
      payload: sharePayload.rawFileContent,
      shareUrl
    }, `${cleanName}_course.kbshare.html`);
    toast.success('Downloaded clickable course package (.kbshare.html)!');
  });

  dialog.querySelector('#btn-download-course-file')?.addEventListener('click', () => {
    const cleanName = (course.name || 'course').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    CryptoShareEngine.downloadKbShareFile(
      sharePayload.rawFileContent,
      `${cleanName}_course.kbshare`
    );
    toast.success('Downloaded course package (.kbshare)!');
  });

  dialog.addEventListener('sl-after-hide', () => dialog.remove());
}
