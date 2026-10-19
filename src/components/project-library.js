import { storage } from '../core/storage.js';
import { Sanitizer } from '../core/sanitizer.js';
import { generateUUID } from '../utils/uuid.js';
import { toast } from '../utils/toast.js';
import { ConfirmDialog, PromptDialog } from '../utils/dialogs.js';
import { ClassManager } from './class-manager.js';
import { ShareModal } from './share-dialog.js';
import { syncContentClassLink } from '../modules/gradebook/bridge.js';

/**
 * Standardized Project Library View Component
 * Reusable across Flashcards, Timeline, Video Assessments, and Gradebook Courses.
 */
export class ProjectLibraryView {
  /**
   * @param {object} options
   * @param {string} options.moduleType - 'flashcards' | 'timeline' | 'video' | 'gradebook'
   * @param {string} options.title - e.g. 'Flashcard Decks'
   * @param {string} options.itemTypeName - e.g. 'Deck', 'Timeline', 'Assessment'
   * @param {string} options.tableName - Dexie table name e.g. 'flashcards', 'timelines', 'video_assessments'
   * @param {string} options.createRoute - Route for new item e.g. '#/flashcards/edit'
   * @param {(item: any) => string} options.getOpenUrl - Function returning URL for primary open action
   * @param {(item: any) => string} options.getEditUrl - Function returning URL for edit action
   * @param {(item: any) => string} options.getMetadataSummary - Function returning summary badge text
   * @param {(item: any) => Promise<any>} [options.onDuplicate] - Optional custom duplicator
   * @param {() => void} [options.onImport] - Optional import handler
   * @param {(item: any) => void} [options.onShare] - Optional custom share flow (e.g. strip answer keys)
   * @param {string} [options.accentColor='#2563eb'] - Brand accent color
   * @param {string} [options.iconName='collection'] - Shoelace icon name
   */
  constructor(options) {
    this.options = options;
    this.supportsClassGrading = options.supportsClassGrading !== undefined
      ? Boolean(options.supportsClassGrading)
      : (options.moduleType === 'assignments' || options.moduleType === 'video');
    this.searchQuery = '';
    this.selectedClassId = this.supportsClassGrading ? ClassManager.getActiveFilter() : null;
    this.sortBy = 'updated'; // 'updated' | 'alpha' | 'class'
  }

  async render(container) {
    if (!container) return;
    this.container = container;

    const [items, classes] = await Promise.all([
      storage.table(this.options.tableName).toArray().catch(() => []),
      this.supportsClassGrading ? ClassManager.getClasses() : Promise.resolve([])
    ]);

    this.classes = classes || [];
    this.items = items;

    this._renderUI();
  }

  _renderUI() {
    const { title, itemTypeName, createRoute, accentColor, iconName } = this.options;

    // Filter items
    let filtered = this.items.filter(item => {
      const q = this.searchQuery.toLowerCase();
      const matchSearch = !q ||
        (item.title && item.title.toLowerCase().includes(q)) ||
        (item.name && item.name.toLowerCase().includes(q)) ||
        (item.description && item.description.toLowerCase().includes(q));

      const matchClass = !this.supportsClassGrading || !this.selectedClassId ||
        (this.selectedClassId === 'unassigned' ? !item.class_id : item.class_id === this.selectedClassId);

      return matchSearch && matchClass;
    });

    // Sort items
    if (this.sortBy === 'alpha') {
      filtered.sort((a, b) => (a.title || a.name || '').localeCompare(b.title || b.name || ''));
    } else if (this.sortBy === 'class' && this.supportsClassGrading) {
      filtered.sort((a, b) => {
        const cA = this.classes.find(c => c.id === a.class_id)?.name || 'zzz';
        const cB = this.classes.find(c => c.id === b.class_id)?.name || 'zzz';
        return cA.localeCompare(cB);
      });
    } else {
      // 'updated'
      filtered.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
    }

    const formatRelativeTime = (iso) => {
      if (!iso) return 'Recently';
      const diffMs = Date.now() - new Date(iso).getTime();
      const diffHours = Math.floor(diffMs / 3600000);
      if (diffHours < 1) return 'Just now';
      if (diffHours < 24) return `${diffHours}h ago`;
      const diffDays = Math.floor(diffHours / 24);
      return `${diffDays}d ago`;
    };

    const safeTitle = Sanitizer.escapeHTML(title);

    this.container.innerHTML = `
      <div class="space-y-6 max-w-7xl mx-auto">
        <!-- Header Bar -->
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-5 sm:p-6 rounded-2xl border border-slate-200 shadow-xs">
          <div>
            <h1 class="text-2xl font-bold text-slate-900 flex items-center gap-3">
              <span class="w-10 h-10 flex-shrink-0 rounded-xl flex items-center justify-center text-white text-xl shadow-sm" style="background-color: ${accentColor};">
                <sl-icon name="${iconName}"></sl-icon>
              </span>
              ${safeTitle}
            </h1>
            <p class="text-sm text-slate-500 mt-1.5">Manage, edit, duplicate, and share all your ${itemTypeName.toLowerCase()} materials.</p>
          </div>

          <div class="flex items-center gap-2 flex-wrap">
            ${this.options.onImport ? `
              <sl-button size="small" id="btn-library-import" variant="default">
                <sl-icon slot="prefix" name="upload"></sl-icon> Import
              </sl-button>
            ` : ''}
            <sl-button size="small" id="btn-library-create" variant="primary">
              <sl-icon slot="prefix" name="plus-lg"></sl-icon> New ${Sanitizer.escapeHTML(itemTypeName)}
            </sl-button>
          </div>
        </div>

        <!-- Filter & Search Toolbar -->
        <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200">
          <div class="flex flex-col sm:flex-row sm:items-center gap-2 flex-1">
            <sl-input id="input-library-search" placeholder="Search by title or description…" size="small" clearable class="flex-1 sm:max-w-xs" value="${Sanitizer.escapeHTML(this.searchQuery)}" aria-label="Search ${Sanitizer.escapeHTML(itemTypeName.toLowerCase())}s">
              <sl-icon slot="prefix" name="search"></sl-icon>
            </sl-input>

            <!-- Class Filter -->
            ${this.supportsClassGrading ? `
              <sl-select id="select-class-filter" size="small" placeholder="All Classes" class="sm:w-48" aria-label="Filter by class" value="${Sanitizer.escapeHTML(this.selectedClassId || 'all')}">
                <sl-option value="all">All Classes</sl-option>
                <sl-option value="unassigned">Formative Practice (Unassigned)</sl-option>
                <sl-divider></sl-divider>
                ${this.classes.map(c => `
                  <sl-option value="${Sanitizer.escapeHTML(c.id)}">${Sanitizer.escapeHTML(c.name)}</sl-option>
                `).join('')}
              </sl-select>
            ` : ''}
          </div>

          <!-- Sort Select -->
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-slate-500">Sort</span>
            <sl-select id="select-sort-by" size="small" class="flex-1 sm:flex-none sm:w-40" value="${this.sortBy}" aria-label="Sort order">
              <sl-option value="updated">Last Updated</sl-option>
              <sl-option value="alpha">Alphabetical</sl-option>
              ${this.supportsClassGrading ? '<sl-option value="class">By Class</sl-option>' : ''}
            </sl-select>
          </div>
        </div>

        <!-- Projects Grid -->
        ${filtered.length === 0 ? `
          <div class="p-12 text-center bg-white rounded-2xl border border-dashed border-slate-300 space-y-3">
            <sl-icon name="${iconName}" class="text-4xl text-slate-300"></sl-icon>
            <h3 class="text-base font-bold text-slate-700">No ${Sanitizer.escapeHTML(itemTypeName.toLowerCase())}s found</h3>
            <p class="text-xs text-slate-500 max-w-sm mx-auto">Get started by creating your first ${Sanitizer.escapeHTML(itemTypeName.toLowerCase())} or adjusting your filter.</p>
            <sl-button variant="primary" size="small" id="btn-library-empty-create">
              Create New ${Sanitizer.escapeHTML(itemTypeName)}
            </sl-button>
          </div>
        ` : `
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            ${filtered.map(item => {
              const assignedClass = this.classes.find(c => c.id === item.class_id);
              const cardAccentColor = Sanitizer.safeColor(assignedClass?.color, accentColor);
              const displayTitle = item.title || item.name || 'Untitled';
              const safeDisplayTitle = Sanitizer.escapeHTML(displayTitle);
              const metadataSummary = this.options.getMetadataSummary ? this.options.getMetadataSummary(item) : '';
              const safeSummary = Sanitizer.escapeHTML(metadataSummary);
              const openUrl = this.options.getOpenUrl ? this.options.getOpenUrl(item) : '#/';
              const editUrl = this.options.getEditUrl ? this.options.getEditUrl(item) : '#/';

              return `
                <div class="kb-card-hover bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs flex flex-col justify-between">
                  <!-- Color Accent Top Bar -->
                  <div class="h-1.5 w-full" style="background-color: ${cardAccentColor};"></div>

                  <div class="p-5 space-y-3 flex-1 flex flex-col justify-between">
                    <div>
                      <div class="flex items-start justify-between gap-2">
                        <div class="flex-1">
                          <h3 class="font-bold text-slate-900 text-base line-clamp-1" title="${safeDisplayTitle}">
                            ${safeDisplayTitle}
                          </h3>
                          <div class="mt-1 flex items-center gap-1.5 flex-wrap">
                            ${!this.supportsClassGrading ? `
                              <span class="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-200">Formative Study</span>
                            ` : (assignedClass ? `
                              <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">Graded · ${Sanitizer.escapeHTML(assignedClass.name)}</span>
                            ` : `
                              <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Formative Practice (Ungraded)</span>
                            `)}
                          </div>
                        </div>

                        <!-- Options Dropdown -->
                        <sl-dropdown placement="bottom-end" hoist>
                          <button slot="trigger" type="button" class="kb-icon-btn -mr-2 -mt-1" title="More actions" aria-label="More actions for ${safeDisplayTitle}">
                            <sl-icon name="three-dots-vertical"></sl-icon>
                          </button>
                          <sl-menu>
                            <sl-menu-item data-action="open" data-id="${Sanitizer.escapeHTML(item.id)}">
                              <sl-icon slot="prefix" name="box-arrow-up-right"></sl-icon> Open
                            </sl-menu-item>
                            <sl-menu-item data-action="edit" data-id="${Sanitizer.escapeHTML(item.id)}">
                              <sl-icon slot="prefix" name="pencil"></sl-icon> Edit Details
                            </sl-menu-item>
                            <sl-menu-item data-action="rename" data-id="${Sanitizer.escapeHTML(item.id)}">
                              <sl-icon slot="prefix" name="cursor-text"></sl-icon> Rename...
                            </sl-menu-item>
                            ${this.supportsClassGrading ? `
                              <sl-menu-item data-action="assign-class" data-id="${Sanitizer.escapeHTML(item.id)}">
                                <sl-icon slot="prefix" name="mortarboard"></sl-icon> Grading &amp; Class Assignment...
                              </sl-menu-item>
                            ` : ''}
                            <sl-menu-item data-action="duplicate" data-id="${Sanitizer.escapeHTML(item.id)}">
                              <sl-icon slot="prefix" name="copy"></sl-icon> Duplicate
                            </sl-menu-item>
                            <sl-menu-item data-action="share" data-id="${Sanitizer.escapeHTML(item.id)}">
                              <sl-icon slot="prefix" name="share"></sl-icon> Share Lesson...
                            </sl-menu-item>
                            <sl-divider></sl-divider>
                            <sl-menu-item data-action="delete" data-id="${Sanitizer.escapeHTML(item.id)}" class="text-red-600">
                              <sl-icon slot="prefix" name="trash" class="text-red-600"></sl-icon> Delete
                            </sl-menu-item>
                          </sl-menu>
                        </sl-dropdown>
                      </div>

                      ${item.description ? `
                        <p class="text-xs text-slate-500 line-clamp-2 mt-2 leading-relaxed">
                          ${Sanitizer.escapeHTML(item.description)}
                        </p>
                      ` : ''}
                    </div>

                    <div class="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                      <span class="font-medium text-slate-600">${safeSummary}</span>
                      <span class="text-[11px] text-slate-400 flex items-center gap-1"><sl-icon name="clock" aria-hidden="true"></sl-icon>${formatRelativeTime(item.updated_at)}</span>
                    </div>
                  </div>

                  <!-- Card Footer Actions -->
                  <div class="bg-slate-50/70 border-t border-slate-100 px-5 py-3 flex items-center gap-2">
                    <sl-button size="small" variant="primary" class="flex-1" href="${Sanitizer.escapeHTML(openUrl)}">
                      Launch
                    </sl-button>
                    <sl-button size="small" variant="default" href="${Sanitizer.escapeHTML(editUrl)}" title="Edit">
                      <sl-icon name="pencil"></sl-icon>
                    </sl-button>
                    <sl-button size="small" variant="default" data-action="share" data-id="${Sanitizer.escapeHTML(item.id)}" title="Share Link">
                      <sl-icon name="share"></sl-icon>
                    </sl-button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    `;

    this._bindEvents();
  }

  _bindEvents() {
    const { createRoute, onImport } = this.options;

    this.container.querySelector('#btn-library-create')?.addEventListener('click', () => {
      window.location.hash = createRoute;
    });

    this.container.querySelector('#btn-library-empty-create')?.addEventListener('click', () => {
      window.location.hash = createRoute;
    });

    if (onImport) {
      this.container.querySelector('#btn-library-import')?.addEventListener('click', onImport);
    }

    const searchInput = this.container.querySelector('#input-library-search');
    searchInput?.addEventListener('sl-input', (e) => {
      this.searchQuery = e.target.value.trim();
      this._renderUI();
    });

    const classSelect = this.container.querySelector('#select-class-filter');
    classSelect?.addEventListener('sl-change', (e) => {
      const val = e.target.value;
      this.selectedClassId = val === 'all' ? null : val;
      this._renderUI();
    });

    const sortSelect = this.container.querySelector('#select-sort-by');
    sortSelect?.addEventListener('sl-change', (e) => {
      this.sortBy = e.target.value;
      this._renderUI();
    });

    // Item Action Dropdown handlers
    this.container.querySelectorAll('[data-action]').forEach(el => {
      el.addEventListener('click', async () => {
        const action = el.dataset.action;
        const id = el.dataset.id;
        const item = this.items.find(i => i.id === id);
        if (!item) return;

        if (action === 'open') {
          window.location.hash = this.options.getOpenUrl(item);
        } else if (action === 'edit') {
          window.location.hash = this.options.getEditUrl(item);
        } else if (action === 'share') {
          if (this.options.onShare) this.options.onShare(item);
          else ShareModal.open(item, this.options.moduleType);
        } else if (action === 'rename') {
          const currentTitle = item.title || item.name || '';
          const newTitle = await PromptDialog.show({
            title: `Rename ${this.options.itemTypeName}`,
            label: 'New Title',
            defaultValue: currentTitle
          });
          if (newTitle && newTitle.trim()) {
            item.title = newTitle.trim();
            if (item.name) item.name = newTitle.trim();
            item.updated_at = new Date().toISOString();
            await storage.table(this.options.tableName).put(item);
            toast.success('Renamed successfully.');
            this.render(this.container);
          }
        } else if (action === 'assign-class') {
          this._openAssignClassDialog(item);
        } else if (action === 'duplicate') {
          if (this.options.onDuplicate) {
            await this.options.onDuplicate(item);
          } else {
            const duplicated = {
              ...item,
              id: generateUUID(),
              title: `${item.title || item.name} (Copy)`,
              updated_at: new Date().toISOString()
            };
            if (duplicated.name) duplicated.name = duplicated.title;
            await storage.table(this.options.tableName).put(duplicated);
            toast.success(`Duplicated ${this.options.itemTypeName.toLowerCase()}!`);
            this.render(this.container);
          }
        } else if (action === 'delete') {
          const title = item.title || item.name || 'this item';
          const confirmed = await ConfirmDialog.show({
            title: `Delete ${this.options.itemTypeName}`,
            message: `Are you sure you want to permanently delete "${Sanitizer.escapeHTML(title)}"? This cannot be undone.`,
            confirmText: 'Delete',
            variant: 'danger'
          });
          if (confirmed) {
            await storage.table(this.options.tableName).delete(item.id);
            toast.success('Item deleted.');
            this.render(this.container);
          }
        }
      });
    });
  }

  _openAssignClassDialog(item) {
    const dialog = document.createElement('sl-dialog');
    dialog.label = `Grading & Class Assignment: ${item.title || item.name || 'Untitled'}`;
    const isGraded = Boolean(item.class_id);
    const currentClassId = item.class_id || (this.classes[0]?.id || '');

    dialog.innerHTML = `
      <div class="space-y-4 py-2 text-sm">
        <p class="text-xs text-slate-500">Choose how this ${this.options.itemTypeName.toLowerCase()} is delivered to students:</p>
        
        <sl-radio-group id="radio-grading-mode" value="${isGraded ? 'graded' : 'practice'}" class="space-y-3">
          <div class="p-3 rounded-xl border border-slate-200 bg-slate-50/50 space-y-1">
            <sl-radio value="practice" class="font-medium text-slate-900">
              Formative Practice (Ungraded)
            </sl-radio>
            <p class="text-xs text-slate-500 pl-6">
              Instant 1-click share link, zero student sign-in or Student ID gate, instant feedback, and unlimited retries. No Gradebook column or hand-in file needed.
            </p>
          </div>

          <div class="p-3 rounded-xl border border-slate-200 bg-slate-50/50 space-y-2">
            <sl-radio value="graded" class="font-medium text-slate-900">
              Graded in Class (Links to Gradebook &amp; collects student submissions)
            </sl-radio>
            <p class="text-xs text-slate-500 pl-6">
              Requires student sign-in, automatically creates a Gradebook column, and collects student submissions.
            </p>
            <div id="class-select-container" class="pl-6 pt-1 ${isGraded ? '' : 'opacity-50 pointer-events-none'}">
              <sl-select id="input-assign-class" value="${Sanitizer.escapeHTML(currentClassId)}" label="Class Section">
                ${this.classes.map(c => `
                  <sl-option value="${Sanitizer.escapeHTML(c.id)}">${Sanitizer.escapeHTML(c.name)} (${Sanitizer.escapeHTML(c.section || 'General')})</sl-option>
                `).join('')}
              </sl-select>
            </div>
          </div>
        </sl-radio-group>
      </div>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button variant="default" id="btn-cancel-assign">Cancel</sl-button>
        <sl-button variant="primary" id="btn-save-assign">Save Assignment</sl-button>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    const radioGroup = dialog.querySelector('#radio-grading-mode');
    const classContainer = dialog.querySelector('#class-select-container');
    radioGroup?.addEventListener('sl-change', () => {
      const mode = radioGroup.value;
      if (mode === 'graded') {
        classContainer?.classList.remove('opacity-50', 'pointer-events-none');
      } else {
        classContainer?.classList.add('opacity-50', 'pointer-events-none');
      }
    });

    dialog.querySelector('#btn-cancel-assign')?.addEventListener('click', () => dialog.hide());
    dialog.querySelector('#btn-save-assign')?.addEventListener('click', async () => {
      const mode = radioGroup?.value || 'practice';
      const classSelect = dialog.querySelector('#input-assign-class');
      const targetClassId = mode === 'graded' ? (classSelect?.value || null) : null;
      await syncContentClassLink(item, this.options.moduleType, targetClassId);
      toast.success(targetClassId ? 'Assigned to class and linked to Gradebook!' : 'Set to Formative Practice!');
      dialog.hide();
      this.render(this.container);
    });

    dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
  }
}
