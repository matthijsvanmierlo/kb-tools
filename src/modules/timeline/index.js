import { storage } from '../../core/storage.js';
import { store } from '../../state/store.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { Exporter, parseCSVWithValidation, TimelineEventSchema, showImportErrorsDialog } from '../../core/validator.js';
import { TimelineCanvasRenderer, parseHistoricalDateToDays } from './canvas-renderer.js';
import { TimelineSVGExporter } from './svg-exporter.js';
import { ProjectLibraryView } from '../../components/project-library.js';
import { ShareModal } from '../../components/share-dialog.js';
import { ClassManager } from '../../components/class-manager.js';
import { RichTextEditor } from '../../components/rich-text-editor.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { CSVImportDialog } from '../../components/csv-import-dialog.js';
import { TIMELINE_CSV_TEMPLATE, downloadCSVTemplate } from '../../core/csv-templates.js';
import { downloadCSV, downloadBlob } from '../../core/csv.js';

/**
 * Interactive Timeline Module Controller & View
 * Supports Timeline Project Library (#/timeline) and Timeline Workspace (#/timeline/view?id=...)
 */
export async function renderTimelineView(params, router, container) {
  if (!container) return;

  const currentRoute = router.currentPath;
  const isViewRoute = currentRoute === '#/timeline/view' || (params && params.id);

  // 1. If at library route, render ProjectLibraryView
  if (!isViewRoute) {
    const library = new ProjectLibraryView({
      moduleType: 'timeline',
      supportsClassGrading: false,
      title: 'Interactive Timelines',
      itemTypeName: 'Timeline',
      tableName: 'timelines',
      createRoute: '#/timeline/view?new=1',
      accentColor: '#7c3aed',
      iconName: 'bar-chart-steps',
      getOpenUrl: (item) => `#/timeline/view?id=${item.id}`,
      getEditUrl: (item) => `#/timeline/view?id=${item.id}`,
      getMetadataSummary: (item) => `${(item.events || []).length} Events`,
      onImport: () => {
        CSVImportDialog.open({
          title: 'Import Timeline',
          subtitle: 'Upload a CSV/JSON file or copy and paste rows directly from Google Sheets or Excel.',
          templateFilename: 'timeline_events_template.csv',
          templateContent: TIMELINE_CSV_TEMPLATE,
          schema: TimelineEventSchema,
          acceptJson: true,
          onImport: async (resultData, rawText, { filename, isJson }) => {
            if (isJson) {
              const parsed = resultData;
              const newTimeline = {
                version: 1,
                id: generateUUID(),
                title: parsed.title || (filename || 'Imported Timeline').replace(/\.[^/.]+$/, ''),
                class_id: null,
                events: Array.isArray(parsed.events) ? parsed.events : [],
                updated_at: new Date().toISOString()
              };
              await storage.table('timelines').put(newTimeline);
              toast.success('Imported timeline JSON!');
            } else {
              let title = (filename || 'Imported Timeline').replace(/\.[^/.]+$/, '');
              if (title === 'pasted_data') title = 'Pasted Timeline';
              else if (title === 'timeline_events_template' || title === 'template') title = 'Timeline';
              else {
                title = title.replace(/[_\-]+/g, ' ');
                title = title.charAt(0).toUpperCase() + title.slice(1);
              }
              const newTimeline = {
                version: 1,
                id: generateUUID(),
                title,
                class_id: activeClass,
                events: (resultData || []).map(ev => ({ ...ev, id: ev.id || generateUUID() })),
                updated_at: new Date().toISOString()
              };
              await storage.table('timelines').put(newTimeline);
              toast.success(`Imported timeline "${title}" with ${newTimeline.events.length} events!`);
            }
            library.searchQuery = '';
            library.selectedClassId = activeClass;
            library.sortBy = 'updated';
            await library.render(container);
          }
        });
      }
    });

    await library.render(container);
    return;
  }

  // 2. Load Timeline Dataset for Workspace
  let activeTimeline = null;
  const targetId = params?.id;

  if (targetId) {
    activeTimeline = await storage.table('timelines').get(targetId);
  }

  if (!activeTimeline && params?.new === '1') {
    activeTimeline = {
      version: 1,
      id: generateUUID(),
      title: 'New Historical Timeline',
      description: '',
      class_id: null,
      updated_at: new Date().toISOString(),
      events: []
    };
    await storage.table('timelines').put(activeTimeline);
  }

  if (!activeTimeline) {
    const timelines = await storage.table('timelines').toArray();
    if (timelines.length > 0) {
      activeTimeline = timelines[0];
    } else {
      activeTimeline = {
        version: 1,
        id: generateUUID(),
        title: 'World History Landmarks',
        description: 'Key milestones from classical antiquity to modern space exploration.',
        updated_at: new Date().toISOString(),
        events: [
          {
            id: generateUUID(),
            title: 'Assassination of Julius Caesar',
            start_date: '-0044-03-15',
            end_date: null,
            category: 'Ancient Rome',
            description: 'Julius Caesar assassinated in the Senate on the Ides of March.',
            color: '#dc2626'
          },
          {
            id: generateUUID(),
            title: 'Pax Romana',
            start_date: '-0027-01-16',
            end_date: '0180-03-17',
            category: 'Ancient Rome',
            description: 'Long period of relative peace and stability in the Roman Empire.',
            color: '#2563eb'
          },
          {
            id: generateUUID(),
            title: 'Luther Posts 95 Theses',
            start_date: '1517-10-31',
            end_date: null,
            category: 'Reformation',
            description: 'Martin Luther nails his Ninety-five Theses to All Saints Church in Wittenberg.',
            color: '#d97706'
          },
          {
            id: generateUUID(),
            title: 'Apollo 11 Moon Landing',
            start_date: '1969-07-20',
            end_date: null,
            category: 'Space Exploration',
            description: 'Neil Armstrong and Buzz Aldrin land on the Moon.',
            color: '#059669'
          }
        ]
      };
      await storage.table('timelines').put(activeTimeline);
    }
  }

  store.setState('activeTimeline', activeTimeline);

  let viewMode = 'canvas'; // 'canvas' | 'split' | 'table'
  let filteredEvents = [...activeTimeline.events];
  let activeCategoryFilter = null;
  let searchQuery = '';

  const applyFilters = () => {
    filteredEvents = activeTimeline.events.filter(ev => {
      const matchCat = !activeCategoryFilter || ev.category === activeCategoryFilter;
      const matchQuery = !searchQuery ||
        ev.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (ev.description && ev.description.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchCat && matchQuery;
    });
  };

  const categories = Array.from(new Set(activeTimeline.events.map(e => e.category || 'General')));
  const safeTimelineTitle = Sanitizer.escapeHTML(activeTimeline.title);

  container.innerHTML = `
    <div id="timeline-aria-live" class="sr-only" aria-live="polite"></div>
    <div class="space-y-4 max-w-7xl mx-auto">

      <!-- Top Toolbar -->
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
        <div class="flex items-center gap-3 flex-wrap">
          <sl-button size="small" variant="default" id="btn-back-to-library">
            <sl-icon slot="prefix" name="arrow-left"></sl-icon> Library
          </sl-button>

          <div>
            <h2 class="font-bold text-slate-900 text-lg leading-none" id="label-timeline-title">
              ${safeTimelineTitle}
            </h2>
            <div class="flex items-center gap-2 mt-1">
              <span class="text-xs text-slate-400" id="badge-events-count">${activeTimeline.events.length} events</span>
              <span class="text-xs text-slate-300">•</span>
              <span class="text-xs text-blue-600 font-medium" id="label-zoom-scale">Scale: Years</span>
            </div>
          </div>
        </div>

        <!-- Controls Dock -->
        <div class="flex items-center gap-2 flex-wrap self-end md:self-auto">
          <!-- View Mode Toggle -->
          <div class="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs">
            <button type="button" class="px-2.5 py-1 rounded-md font-medium ${viewMode === 'canvas' ? 'bg-white shadow-xs text-blue-600 font-bold' : 'text-slate-600 hover:text-slate-900'}" id="btn-view-canvas">Canvas</button>
            <button type="button" class="px-2.5 py-1 rounded-md font-medium ${viewMode === 'split' ? 'bg-white shadow-xs text-blue-600 font-bold' : 'text-slate-600 hover:text-slate-900'}" id="btn-view-split">Split</button>
            <button type="button" class="px-2.5 py-1 rounded-md font-medium ${viewMode === 'table' ? 'bg-white shadow-xs text-blue-600 font-bold' : 'text-slate-600 hover:text-slate-900'}" id="btn-view-table">Table</button>
          </div>

          <!-- Zoom Tools -->
          <div class="flex items-center gap-1 border-l border-slate-200 pl-2">
            <sl-button size="small" id="btn-zoom-in" title="Zoom In"><sl-icon name="zoom-in"></sl-icon></sl-button>
            <sl-button size="small" id="btn-zoom-out" title="Zoom Out"><sl-icon name="zoom-out"></sl-icon></sl-button>
            <sl-button size="small" id="btn-zoom-reset" title="Fit to View">Fit View</sl-button>
          </div>

          <sl-button size="small" id="btn-add-event" variant="primary">
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add Event
          </sl-button>

          <!-- Export & Share Dropdown -->
          <sl-dropdown placement="bottom-end">
            <sl-button slot="trigger" size="small" caret>Export</sl-button>
            <sl-menu>
              <sl-menu-item id="menu-share-timeline">
                <sl-icon slot="prefix" name="share"></sl-icon> Share Lesson Link / .kbshare
              </sl-menu-item>
              <sl-menu-item id="menu-create-flashcards-deck">
                <sl-icon slot="prefix" name="stack" class="text-blue-600"></sl-icon> Create Flashcard Deck from Timeline
              </sl-menu-item>
              <sl-divider></sl-divider>
              <sl-menu-item id="menu-export-svg">
                <sl-icon slot="prefix" name="filetype-svg"></sl-icon> Download Vector SVG
              </sl-menu-item>
              <sl-menu-item id="menu-export-csv">
                <sl-icon slot="prefix" name="filetype-csv"></sl-icon> Export CSV
              </sl-menu-item>
              <sl-menu-item id="menu-template-csv">
                <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Download CSV Template
              </sl-menu-item>
              <sl-menu-item id="menu-export-md">
                <sl-icon slot="prefix" name="markdown"></sl-icon> Export Markdown
              </sl-menu-item>
              <sl-divider></sl-divider>
              <sl-menu-item id="menu-import-csv">
                <sl-icon slot="prefix" name="upload"></sl-icon> Import Events from CSV / Spreadsheet…
              </sl-menu-item>
            </sl-menu>
          </sl-dropdown>
          <input type="file" id="input-timeline-csv" accept=".csv" class="hidden" />
        </div>
      </div>

      <!-- Search & Category Filters Bar -->
      <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200">
        <sl-input id="input-search-events" placeholder="Search events..." size="small" clearable class="w-full sm:w-64">
          <sl-icon slot="prefix" name="search"></sl-icon>
        </sl-input>

        ${categories.length > 0 ? `
          <div class="flex items-center gap-1.5 overflow-x-auto text-xs">
            <button data-cat="ALL" class="px-2.5 py-1 rounded-full font-medium transition-colors ${!activeCategoryFilter ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">
              All (${activeTimeline.events.length})
            </button>
            ${categories.map(cat => `
              <button data-cat="${Sanitizer.escapeHTML(cat)}" class="px-2.5 py-1 rounded-full font-medium transition-colors ${activeCategoryFilter === cat ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">
                ${Sanitizer.escapeHTML(cat)}
              </button>
            `).join('')}
          </div>
        ` : ''}
      </div>

      <!-- Main Workspace View (Canvas / Split / Table) -->
      <div id="timeline-workspace-view">
        <!-- Rendered dynamically -->
      </div>

      <!-- Event Details Drawer -->
      <sl-drawer id="event-detail-drawer" label="Event Details" placement="end" style="--size: 420px;">
        <div id="drawer-content" class="space-y-4"></div>
        <div slot="footer" class="flex justify-between items-center w-full">
          <sl-button variant="danger" size="small" id="btn-delete-event">Delete</sl-button>
          <div class="flex items-center gap-2">
            <sl-button variant="default" size="small" id="btn-duplicate-event">Duplicate</sl-button>
            <sl-button variant="primary" size="small" id="btn-edit-event">Edit Details</sl-button>
          </div>
        </div>
      </sl-drawer>
    </div>
  `;

  const workspaceView = container.querySelector('#timeline-workspace-view');
  const scaleLabel = container.querySelector('#label-zoom-scale');
  let renderer = null;

  const renderActiveViewMode = () => {
    applyFilters();

    if (viewMode === 'canvas') {
      workspaceView.innerHTML = `
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-2 relative overflow-hidden" style="min-height: 520px;">
          <canvas id="timeline-canvas" tabindex="0" class="w-full h-full block focus:outline-none" style="height: 520px;" aria-label="Interactive timeline canvas"></canvas>
        </div>
        ${renderAccessibleEventListHTML()}
      `;
      setupCanvas();
      bindAccessibleListActions();
    } else if (viewMode === 'split') {
      workspaceView.innerHTML = `
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div class="lg:col-span-7 bg-white rounded-2xl border border-slate-200 shadow-sm p-2 overflow-hidden" style="min-height: 520px;">
            <canvas id="timeline-canvas" tabindex="0" class="w-full h-full block focus:outline-none" style="height: 520px;"></canvas>
          </div>
          <div class="lg:col-span-5 bg-white rounded-2xl border border-slate-200 shadow-sm p-4 overflow-y-auto" style="max-height: 536px;">
            ${renderTableHTML()}
          </div>
        </div>
      `;
      setupCanvas();
      bindTableActions();
    } else if (viewMode === 'table') {
      workspaceView.innerHTML = `
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 overflow-x-auto">
          ${renderTableHTML()}
        </div>
      `;
      bindTableActions();
    }
  };

  const setupCanvas = () => {
    const canvas = container.querySelector('#timeline-canvas');
    if (!canvas) return;

    renderer = new TimelineCanvasRenderer(canvas, { ...activeTimeline, events: filteredEvents }, {
      onSelectEvent: (ev) => openEventDrawer(ev),
      onScaleChange: (scale) => {
        if (scaleLabel) scaleLabel.textContent = `Scale: ${scale}`;
      }
    });
    if (scaleLabel) scaleLabel.textContent = `Scale: ${renderer.getScaleLabel()}`;
  };

  const renderAccessibleEventListHTML = () => {
    if (filteredEvents.length === 0) {
      return '<div class="mt-4 p-4 bg-white rounded-2xl border border-slate-200 text-xs text-slate-400">No events match current filter.</div>';
    }
    const sorted = [...filteredEvents].sort((a, b) => parseHistoricalDateToDays(a.start_date) - parseHistoricalDateToDays(b.start_date));
    return `
      <div class="mt-4 bg-white rounded-2xl border border-slate-200 shadow-xs p-4">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500">Accessible Chronological Event List</h3>
          <span class="text-[11px] text-slate-400">Screen-reader &amp; keyboard accessible</span>
        </div>
        <ul role="list" class="divide-y divide-slate-100 max-h-64 overflow-y-auto space-y-0.5" aria-label="Chronological events in timeline">
          ${sorted.map(ev => `
            <li role="listitem" class="p-2.5 rounded-xl hover:bg-slate-50 flex items-center justify-between gap-3 cursor-pointer accessible-event-item transition-colors" data-id="${Sanitizer.escapeHTML(ev.id)}" tabindex="0">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background-color: ${Sanitizer.safeColor(ev.color, '#2563eb')};"></div>
                <div class="min-w-0">
                  <div class="text-xs font-bold text-slate-900 truncate">${Sanitizer.escapeHTML(ev.title)}</div>
                  ${ev.description ? `<p class="text-[11px] text-slate-500 truncate max-w-lg mt-0.5">${Sanitizer.escapeHTML(ev.description)}</p>` : ''}
                </div>
              </div>
              <div class="text-right flex-shrink-0">
                <span class="font-mono text-xs text-slate-600 font-medium">${Sanitizer.escapeHTML(ev.start_date || '')}</span>
              </div>
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  };

  const bindAccessibleListActions = () => {
    container.querySelectorAll('.accessible-event-item').forEach(item => {
      const open = () => {
        const evId = item.dataset.id;
        const ev = activeTimeline.events.find(e => e.id === evId);
        if (ev) openEventDrawer(ev);
      };
      item.addEventListener('click', open);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
  };

  const renderTableHTML = () => {
    const sorted = [...filteredEvents].sort((a, b) => parseHistoricalDateToDays(a.start_date) - parseHistoricalDateToDays(b.start_date));
    if (sorted.length === 0) {
      return `
        <div class="py-12 text-center text-slate-400 text-xs">
          <p>No events found for this filter.</p>
        </div>
      `;
    }

    return `
      <table class="w-full text-xs text-left">
        <thead class="text-slate-400 font-semibold uppercase tracking-wider border-b border-slate-200">
          <tr>
            <th class="py-2 px-3">Date</th>
            <th class="py-2 px-3">Title</th>
            <th class="py-2 px-3">Category</th>
            <th class="py-2 px-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          ${sorted.map(ev => {
            const safeTitle = Sanitizer.escapeHTML(ev.title);
            const safeCat = Sanitizer.escapeHTML(ev.category || 'General');
            const dateStr = ev.end_date ? `${Sanitizer.escapeHTML(ev.start_date)} &rarr; ${Sanitizer.escapeHTML(ev.end_date)}` : Sanitizer.escapeHTML(ev.start_date);
            const color = Sanitizer.safeColor(ev.color, '#3b82f6');
            const bgColor = color.length === 7 ? `${color}20` : color;
            return `
              <tr class="hover:bg-slate-50 transition-colors">
                <td class="py-2.5 px-3 font-mono font-medium text-slate-600">${dateStr}</td>
                <td class="py-2.5 px-3 font-bold text-slate-900">${safeTitle}</td>
                <td class="py-2.5 px-3">
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold" style="background-color: ${bgColor}; color: ${color};">
                    ${safeCat}
                  </span>
                </td>
                <td class="py-2.5 px-3 text-right space-x-1 whitespace-nowrap">
                  <button type="button" class="kb-icon-btn" data-table-action="inspect" data-id="${Sanitizer.escapeHTML(ev.id)}" title="Inspect Details">
                    <sl-icon name="eye"></sl-icon>
                  </button>
                  <button type="button" class="kb-icon-btn" data-table-action="edit" data-id="${Sanitizer.escapeHTML(ev.id)}" title="Edit">
                    <sl-icon name="pencil"></sl-icon>
                  </button>
                  <button type="button" class="kb-icon-btn text-red-500 hover:text-red-700" data-table-action="delete" data-id="${Sanitizer.escapeHTML(ev.id)}" title="Delete">
                    <sl-icon name="trash"></sl-icon>
                  </button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  };

  const bindTableActions = () => {
    container.querySelectorAll('[data-table-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.tableAction;
        const id = btn.dataset.id;
        const ev = activeTimeline.events.find(e => e.id === id);
        if (!ev) return;

        if (action === 'inspect') {
          openEventDrawer(ev);
        } else if (action === 'edit') {
          openEventEditorModal(ev, activeTimeline, async () => {
            await storage.table('timelines').put(activeTimeline);
            renderActiveViewMode();
          });
        } else if (action === 'delete') {
          const confirmed = await ConfirmDialog.show({
            title: 'Delete Event',
            message: `Permanently delete "${Sanitizer.escapeHTML(ev.title)}"?`,
            confirmText: 'Delete',
            variant: 'danger'
          });
          if (confirmed) {
            activeTimeline.events = activeTimeline.events.filter(e => e.id !== id);
            await storage.table('timelines').put(activeTimeline);
            toast.info('Event removed.');
            renderActiveViewMode();
          }
        }
      });
    });
  };

  const refreshWorkspace = () => {
    applyFilters();
    if (renderer) {
      renderer.events = filteredEvents;
      renderer.render();
    }
  };

  // Drawer Handler
  let currentlySelectedEvent = null;
  const drawer = container.querySelector('#event-detail-drawer');
  const drawerContent = container.querySelector('#drawer-content');

  function openEventDrawer(ev) {
    currentlySelectedEvent = ev;
    drawer.label = ev.title;

    const spanText = ev.end_date
      ? `<span class="bg-blue-100 text-blue-800 px-2 py-0.5 rounded text-xs font-mono">${Sanitizer.escapeHTML(ev.start_date)} &rarr; ${Sanitizer.escapeHTML(ev.end_date)}</span>`
      : `<span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded text-xs font-mono">Milestone: ${Sanitizer.escapeHTML(ev.start_date)}</span>`;

    const descriptionHtml = ev.description ? Sanitizer.renderSTEMMarkdown(ev.description) : '<p class="text-xs text-slate-400 italic">No description provided.</p>';

    drawerContent.innerHTML = `
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase text-slate-500">${Sanitizer.escapeHTML(ev.category || 'General')}</span>
          ${spanText}
        </div>

        <div class="prose prose-sm text-slate-800 kb-prose">
          ${descriptionHtml}
        </div>

        ${ev.citations ? `
          <div class="pt-3 border-t text-xs text-slate-500">
            <span class="font-semibold block text-slate-700">Academic Citations:</span>
            <p class="font-mono mt-0.5">${Sanitizer.escapeHTML(ev.citations)}</p>
          </div>
        ` : ''}
      </div>
    `;

    drawer.show();
  }

  // Navigation & View Mode Toggles
  container.querySelector('#btn-back-to-library')?.addEventListener('click', () => {
    router.navigate('#/timeline');
  });

  const updateViewModeButtons = () => {
    ['canvas', 'split', 'table'].forEach(m => {
      const b = container.querySelector(`#btn-view-${m}`);
      if (b) {
        b.className = `px-2.5 py-1 rounded-md font-medium ${viewMode === m ? 'bg-white shadow-xs text-blue-600 font-bold' : 'text-slate-600 hover:text-slate-900'}`;
      }
    });
  };

  container.querySelector('#btn-view-canvas')?.addEventListener('click', () => {
    viewMode = 'canvas';
    updateViewModeButtons();
    renderActiveViewMode();
  });
  container.querySelector('#btn-view-split')?.addEventListener('click', () => {
    viewMode = 'split';
    updateViewModeButtons();
    renderActiveViewMode();
  });
  container.querySelector('#btn-view-table')?.addEventListener('click', () => {
    viewMode = 'table';
    updateViewModeButtons();
    renderActiveViewMode();
  });

  // Zoom Buttons
  container.querySelector('#btn-zoom-in')?.addEventListener('click', () => {
    if (renderer) {
      renderer.pixelsPerDay = Math.min(2400, renderer.pixelsPerDay * 1.35);
      renderer.render();
      if (scaleLabel) scaleLabel.textContent = `Scale: ${renderer.getScaleLabel()}`;
    }
  });

  container.querySelector('#btn-zoom-out')?.addEventListener('click', () => {
    if (renderer) {
      renderer.pixelsPerDay = Math.max(1e-5, renderer.pixelsPerDay * 0.7);
      renderer.render();
      if (scaleLabel) scaleLabel.textContent = `Scale: ${renderer.getScaleLabel()}`;
    }
  });

  container.querySelector('#btn-zoom-reset')?.addEventListener('click', () => {
    if (activeTimeline.events.length > 0 && renderer) {
      const days = activeTimeline.events.map(e => parseHistoricalDateToDays(e.start_date));
      const minDay = Math.min(...days);
      const maxDay = Math.max(...days);
      renderer.centerDay = (minDay + maxDay) / 2;
      const canvasEl = container.querySelector('#timeline-canvas');
      renderer.pixelsPerDay = (canvasEl?.clientWidth || 900) / (Math.max(30, maxDay - minDay) * 1.6);
      renderer.render();
      if (scaleLabel) scaleLabel.textContent = `Scale: ${renderer.getScaleLabel()}`;
    }
  });

  // Search Input
  container.querySelector('#input-search-events')?.addEventListener('sl-input', (e) => {
    searchQuery = e.target.value.trim();
    if (viewMode === 'canvas') {
      refreshWorkspace();
    } else {
      renderActiveViewMode();
    }
  });

  // Category Pills
  container.querySelectorAll('[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.getAttribute('data-cat');
      activeCategoryFilter = cat === 'ALL' ? null : cat;
      container.querySelectorAll('[data-cat]').forEach(b => {
        const isCurrent = b === btn;
        b.className = `px-2.5 py-1 rounded-full font-medium transition-colors ${isCurrent ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`;
      });
      if (viewMode === 'canvas') {
        refreshWorkspace();
      } else {
        renderActiveViewMode();
      }
    });
  });

  // Share Dialog Binding
  container.querySelector('#menu-share-timeline')?.addEventListener('click', () => {
    ShareModal.open(activeTimeline, 'timeline');
  });

  // Create Flashcard Deck from Timeline
  container.querySelector('#menu-create-flashcards-deck')?.addEventListener('click', async () => {
    try {
      const newDeck = {
        version: 1,
        id: generateUUID(),
        title: `${activeTimeline.title} (Flashcards)`,
        description: `Generated from Timeline: ${activeTimeline.title}`,
        class_id: activeTimeline.class_id || null,
        updated_at: new Date().toISOString(),
        cards: activeTimeline.events.map(ev => ({
          id: generateUUID(),
          type: 'text',
          front: {
            text: `### ${ev.title}\n\n*Category: ${ev.category || 'General'}*`,
            ttsLang: 'en-US'
          },
          back: {
            text: `**Date:** ${ev.end_date ? `${ev.start_date} to ${ev.end_date}` : ev.start_date}\n\n${ev.description || ''}${ev.citations ? `\n\n*Citations:* ${ev.citations}` : ''}`,
            ttsLang: 'en-US'
          },
          fsrs: { state: 0, due: new Date().toISOString(), stability: 0, difficulty: 0, reps: 0, lapses: 0 }
        }))
      };

      await storage.table('flashcards').put(newDeck);
      toast.success(`Created flashcard deck with ${newDeck.cards.length} cards!`);
      const confirmed = await ConfirmDialog.show({
        title: 'Flashcards Created',
        message: `Successfully created "${Sanitizer.escapeHTML(newDeck.title)}" with ${newDeck.cards.length} cards. Would you like to study it now?`,
        confirmText: 'Study Deck Now',
        cancelText: 'Stay on Timeline'
      });
      if (confirmed) {
        router.navigate(`#/flashcards/study?id=${newDeck.id}`);
      }
    } catch (err) {
      toast.danger('Could not generate flashcard deck: ' + err.message);
    }
  });

  // Exports
  container.querySelector('#menu-export-svg')?.addEventListener('click', () => {
    TimelineSVGExporter.downloadSVG(activeTimeline, `${activeTimeline.title.replace(/\s+/g, '_')}.svg`);
  });

  container.querySelector('#menu-export-csv')?.addEventListener('click', () => {
    const csvStr = Exporter.toCSV(activeTimeline.events);
    const filename = `${activeTimeline.title.replace(/\s+/g, '_')}.csv`;
    downloadCSV(filename, csvStr);
    toast.success(`Exported ${activeTimeline.events.length} timeline events to CSV`);
  });

  container.querySelector('#menu-template-csv')?.addEventListener('click', () => {
    downloadCSVTemplate('timeline_events_template.csv', TIMELINE_CSV_TEMPLATE);
    toast.success('Downloaded timeline events CSV template');
  });

  container.querySelector('#menu-export-md')?.addEventListener('click', () => {
    const mdStr = Exporter.toMarkdown(activeTimeline.events, 'timeline');
    downloadFile(mdStr, `${activeTimeline.title.replace(/\s+/g, '_')}.md`, 'text/markdown');
  });

  container.querySelector('#menu-import-csv')?.addEventListener('click', () => {
    CSVImportDialog.open({
      title: `Import Events into "${activeTimeline.title || 'Timeline'}"`,
      subtitle: 'Upload a CSV file or paste cells directly from Google Sheets / Excel to add events to this timeline.',
      templateFilename: 'timeline_events_template.csv',
      templateContent: TIMELINE_CSV_TEMPLATE,
      schema: TimelineEventSchema,
      acceptJson: false,
      onImport: async (resultData) => {
        if (!Array.isArray(resultData) || resultData.length === 0) return;
        for (const ev of resultData) {
          ev.id = ev.id || generateUUID();
          activeTimeline.events.push(ev);
        }
        activeTimeline.updated_at = new Date().toISOString();
        await storage.table('timelines').put(activeTimeline);
        toast.success(`Imported ${resultData.length} events!`);
        renderActiveViewMode();
      }
    });
  });

  // Add / Edit / Duplicate Event Actions
  container.querySelector('#btn-add-event')?.addEventListener('click', () => {
    openEventEditorModal(null, activeTimeline, async () => {
      activeTimeline.updated_at = new Date().toISOString();
      await storage.table('timelines').put(activeTimeline);
      renderActiveViewMode();
    });
  });

  container.querySelector('#btn-edit-event')?.addEventListener('click', () => {
    if (!currentlySelectedEvent) return;
    drawer.hide();
    openEventEditorModal(currentlySelectedEvent, activeTimeline, async () => {
      activeTimeline.updated_at = new Date().toISOString();
      await storage.table('timelines').put(activeTimeline);
      renderActiveViewMode();
    });
  });

  container.querySelector('#btn-duplicate-event')?.addEventListener('click', async () => {
    if (!currentlySelectedEvent) return;
    drawer.hide();
    const dup = {
      ...currentlySelectedEvent,
      id: generateUUID(),
      title: `${currentlySelectedEvent.title} (Copy)`
    };
    activeTimeline.events.push(dup);
    activeTimeline.updated_at = new Date().toISOString();
    await storage.table('timelines').put(activeTimeline);
    toast.success('Event duplicated!');
    renderActiveViewMode();
  });

  container.querySelector('#btn-delete-event')?.addEventListener('click', async () => {
    if (!currentlySelectedEvent) return;
    const confirmed = await ConfirmDialog.show({
      title: 'Delete Event',
      message: `Are you sure you want to delete "${Sanitizer.escapeHTML(currentlySelectedEvent.title)}"?`,
      confirmText: 'Delete Event',
      variant: 'danger'
    });
    if (confirmed) {
      activeTimeline.events = activeTimeline.events.filter(e => e.id !== currentlySelectedEvent.id);
      activeTimeline.updated_at = new Date().toISOString();
      await storage.table('timelines').put(activeTimeline);
      drawer.hide();
      toast.info('Event removed.');
      renderActiveViewMode();
    }
  });

  // Initial workspace render
  renderActiveViewMode();
}

/**
 * Event Editor Modal with BCE/CE Date Helper and RichTextEditor
 */
function openEventEditorModal(eventObj, timeline, onSaveCallback) {
  const isNew = !eventObj;
  const ev = eventObj || {
    id: generateUUID(),
    title: '',
    start_date: new Date().toISOString().split('T')[0],
    end_date: null,
    category: 'General',
    description: '',
    color: '#3b82f6',
    citations: ''
  };

  const isBceStart = String(ev.start_date).startsWith('-');
  const rawStartYear = Math.abs(parseInt(ev.start_date, 10) || 2026);

  const dialog = document.createElement('sl-dialog');
  dialog.label = isNew ? 'Create Timeline Event' : 'Edit Timeline Event';
  dialog.style.setProperty('--width', '620px');

  dialog.innerHTML = `
    <div class="space-y-4 py-1 text-sm">
      <sl-input id="input-ev-title" label="Event Title" value="${Sanitizer.escapeHTML(ev.title)}" required autofocus></sl-input>

      <!-- Date with BCE / CE Era Helper -->
      <div class="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-3">
        <div class="flex items-center justify-between text-xs font-semibold text-slate-700">
          <span>Temporal Range &amp; Era</span>
          <span class="text-[10px] text-slate-400 font-normal">Astronomical Year scale</span>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div class="flex items-center gap-1.5 mb-1">
              <label class="text-xs font-medium text-slate-700">Start Date / Year</label>
              <button type="button" id="btn-toggle-bce" class="text-[10px] px-1.5 py-0.5 rounded font-bold border transition-colors ${isBceStart ? 'bg-amber-100 text-amber-800 border-amber-300' : 'bg-blue-100 text-blue-800 border-blue-300'}">
                ${isBceStart ? 'Era: BCE' : 'Era: CE'}
              </button>
            </div>
            <sl-input id="input-ev-start" value="${Sanitizer.escapeHTML(ev.start_date)}" placeholder="e.g. -0044-03-15 or 1517-10-31"></sl-input>
          </div>

          <div>
            <label class="block text-xs font-medium text-slate-700 mb-1">End Date (Optional Span)</label>
            <sl-input id="input-ev-end" value="${Sanitizer.escapeHTML(ev.end_date || '')}" placeholder="Leave blank for Milestone"></sl-input>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <sl-input id="input-ev-category" label="Category" value="${Sanitizer.escapeHTML(ev.category || 'General')}"></sl-input>
        <div>
          <label class="text-xs text-slate-500 font-medium block mb-1">Color Marker</label>
          <sl-color-picker id="picker-ev-color" value="${Sanitizer.safeColor(ev.color, '#3b82f6')}" size="small" no-format-toggle></sl-color-picker>
        </div>
      </div>

      <!-- Description via RichTextEditor -->
      <div>
        <label class="block text-xs font-medium text-slate-700 mb-1.5">Description (Markdown &amp; STEM KaTeX)</label>
        <div id="ev-editor-mount"></div>
      </div>

      <sl-input id="input-ev-citations" label="Academic Citations (Optional)" value="${Sanitizer.escapeHTML(ev.citations || '')}" placeholder="e.g. Livy, Ab Urbe Condita; NASA Mission Archives"></sl-input>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-cancel-ev">Cancel</sl-button>
      <sl-button variant="primary" id="btn-save-ev">Save Event</sl-button>
    </div>
  `;

  document.body.appendChild(dialog);
  dialog.show();

  // Mount RichTextEditor in tabbed mode
  const editorMount = dialog.querySelector('#ev-editor-mount');
  const richEditor = new RichTextEditor({
    initialValue: ev.description || '',
    mode: 'tabbed',
    minHeight: '120px'
  });
  editorMount.appendChild(richEditor.element);

  // BCE / CE Toggle
  let bceActive = isBceStart;
  const bceBtn = dialog.querySelector('#btn-toggle-bce');
  const startInput = dialog.querySelector('#input-ev-start');

  bceBtn?.addEventListener('click', () => {
    bceActive = !bceActive;
    bceBtn.textContent = bceActive ? 'Era: BCE' : 'Era: CE';
    bceBtn.className = `text-[10px] px-1.5 py-0.5 rounded font-bold border transition-colors ${bceActive ? 'bg-amber-100 text-amber-800 border-amber-300' : 'bg-blue-100 text-blue-800 border-blue-300'}`;

    let val = startInput.value.trim();
    if (bceActive) {
      if (!val.startsWith('-')) startInput.value = `-${val.padStart(4, '0')}`;
    } else {
      if (val.startsWith('-')) startInput.value = val.substring(1).replace(/^0+/, '');
    }
  });

  dialog.querySelector('#btn-save-ev')?.addEventListener('click', async () => {
    const title = dialog.querySelector('#input-ev-title').value.trim();
    const start = startInput.value.trim();
    const end = dialog.querySelector('#input-ev-end').value.trim() || null;
    const cat = dialog.querySelector('#input-ev-category').value.trim() || 'General';
    const color = dialog.querySelector('#picker-ev-color').value || '#3b82f6';
    const desc = richEditor.getValue();
    const citations = dialog.querySelector('#input-ev-citations').value.trim();

    if (!title) {
      toast.warning('Event title is required.');
      return;
    }

    ev.title = title;
    ev.start_date = start;
    ev.end_date = end;
    ev.category = cat;
    ev.color = color;
    ev.description = desc;
    ev.citations = citations;

    if (isNew) {
      timeline.events.push(ev);
    }

    dialog.hide();
    toast.success('Event saved!');
    if (onSaveCallback) onSaveCallback();
  });

  dialog.querySelector('#btn-cancel-ev')?.addEventListener('click', () => dialog.hide());
  dialog.addEventListener('sl-after-hide', (e) => {
    // Nested selects/dropdowns emit bubbling sl-after-hide events too
    if (e.target !== dialog) return;
    richEditor.destroy();
    dialog.remove();
  });
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  downloadBlob(blob, filename);
}

export default renderTimelineView;
