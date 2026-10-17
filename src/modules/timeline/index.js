import { storage } from '../../core/storage.js';
import { store } from '../../state/store.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { CryptoShareEngine } from '../../core/crypto-share.js';
import { Exporter, parseCSVWithValidation, TimelineEventSchema, showImportErrorsDialog } from '../../core/validator.js';
import { TimelineCanvasRenderer } from './canvas-renderer.js';
import { TimelineSVGExporter } from './svg-exporter.js';

/**
 * Interactive Timeline Module Controller & View
 */
export async function renderTimelineView(params, router, container) {
  let activeTimeline = store.getState('activeTimeline');

  if (!activeTimeline) {
    const timelines = await storage.table('timelines').toArray();
    if (timelines.length > 0) {
      activeTimeline = timelines[0];
    } else {
      // Seed initial sample timeline: World History Landmarks
      activeTimeline = {
        version: 1,
        id: generateUUID(),
        title: 'World History Landmarks',
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
            description: 'Long period of relative peacefulness and minimal expansion experienced by the Roman Empire.',
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
            title: 'Thirty Years War',
            start_date: '1618-05-23',
            end_date: '1648-10-24',
            category: 'Early Modern',
            description: 'Conflict primarily fought in Central Europe resulting in the Peace of Westphalia.',
            color: '#7c3aed'
          },
          {
            id: generateUUID(),
            title: 'Apollo 11 Moon Landing',
            start_date: '1969-07-20',
            end_date: null,
            category: 'Space Exploration',
            description: 'Neil Armstrong and Buzz Aldrin land the Apollo Lunar Module Eagle on the Moon.',
            color: '#059669'
          }
        ]
      };
      await storage.table('timelines').put(activeTimeline);
    }
  }

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

  container.innerHTML = `
    <div class="space-y-4">
      <!-- Screen Reader Announcement Region -->
      <div id="timeline-aria-live" class="sr-only" aria-live="polite"></div>

      <!-- Top Toolbar -->
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <div class="flex items-center gap-3 flex-wrap">
          <h2 class="font-bold text-slate-900 text-lg">${activeTimeline.title}</h2>
          <span class="text-xs text-slate-400">|</span>
          <div class="flex items-center gap-1">
            <sl-input id="input-search-events" placeholder="Search events..." size="small" clearable class="w-48">
              <sl-icon slot="prefix" name="search"></sl-icon>
            </sl-input>
          </div>
        </div>

        <div class="flex items-center gap-2 flex-wrap self-end md:self-auto">
          <sl-button size="small" id="btn-zoom-in" title="Zoom In"><sl-icon name="zoom-in"></sl-icon></sl-button>
          <sl-button size="small" id="btn-zoom-out" title="Zoom Out"><sl-icon name="zoom-out"></sl-icon></sl-button>
          <sl-button size="small" id="btn-zoom-reset" title="Fit to View">Fit View</sl-button>
          <sl-button size="small" id="btn-add-event" variant="primary">
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add Event
          </sl-button>

          <!-- Export & Share Dropdown -->
          <sl-dropdown placement="bottom-end">
            <sl-button slot="trigger" size="small" caret>Export</sl-button>
            <sl-menu>
              <sl-menu-item id="menu-export-svg">
                <sl-icon slot="prefix" name="filetype-svg"></sl-icon> Download Vector SVG
              </sl-menu-item>
              <sl-menu-item id="menu-export-csv">
                <sl-icon slot="prefix" name="filetype-csv"></sl-icon> Export CSV
              </sl-menu-item>
              <sl-menu-item id="menu-export-md">
                <sl-icon slot="prefix" name="markdown"></sl-icon> Export Markdown
              </sl-menu-item>
              <sl-menu-item id="menu-share-timeline">
                <sl-icon slot="prefix" name="share"></sl-icon> Share Lesson...
              </sl-menu-item>
              <sl-divider></sl-divider>
              <sl-menu-item id="menu-import-csv">
                <sl-icon slot="prefix" name="upload"></sl-icon> Import Events CSV...
              </sl-menu-item>
            </sl-menu>
          </sl-dropdown>
          <input type="file" id="input-timeline-csv" accept=".csv" class="hidden" />
        </div>
      </div>

      <!-- Category Filter Pills -->
      ${categories.length > 0 ? `
        <div class="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
          <span class="text-slate-400 font-medium">Filter:</span>
          <button data-cat="ALL" class="px-2.5 py-1 rounded-full font-medium transition-colors ${!activeCategoryFilter ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">
            All (${activeTimeline.events.length})
          </button>
          ${categories.map(cat => `
            <button data-cat="${cat}" class="px-2.5 py-1 rounded-full font-medium transition-colors ${activeCategoryFilter === cat ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">
              ${cat}
            </button>
          `).join('')}
        </div>
      ` : ''}

      <!-- Interactive Canvas Viewport -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-2 relative overflow-hidden" style="min-height: 520px;">
        <canvas id="timeline-canvas" tabindex="0" class="w-full h-full block focus:outline-none" style="height: 500px;" aria-label="Interactive timeline canvas. Use left and right arrow keys to navigate events and Enter to inspect."></canvas>
      </div>

      <!-- Event Details Drawer -->
      <sl-drawer id="event-detail-drawer" label="Event Details" placement="end" class="--size: 420px;">
        <div id="drawer-content" class="space-y-4"></div>
        <div slot="footer" class="flex justify-between items-center w-full">
          <sl-button variant="danger" size="small" id="btn-delete-event">Delete</sl-button>
          <sl-button variant="primary" size="small" id="btn-edit-event">Edit Details</sl-button>
        </div>
      </sl-drawer>
    </div>
  `;

  const canvas = container.querySelector('#timeline-canvas');
  let currentRendererDataset = { ...activeTimeline, events: filteredEvents };
  const renderer = new TimelineCanvasRenderer(canvas, currentRendererDataset, {
    onSelectEvent: (ev) => openEventDrawer(ev)
  });

  const refreshCanvas = () => {
    applyFilters();
    renderer.events = filteredEvents;
    renderer.render();
  };

  // Drawer Handler
  let currentlySelectedEvent = null;
  const drawer = container.querySelector('#event-detail-drawer');
  const drawerContent = container.querySelector('#drawer-content');

  function openEventDrawer(ev) {
    currentlySelectedEvent = ev;
    drawer.label = ev.title;

    const spanText = ev.end_date
      ? `<span class="bg-blue-100 text-blue-800 px-2 py-0.5 rounded text-xs font-mono">${ev.start_date} &rarr; ${ev.end_date}</span>`
      : `<span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded text-xs font-mono">Milestone: ${ev.start_date}</span>`;

    const descriptionHtml = ev.description ? Sanitizer.renderSTEMMarkdown(ev.description) : '<p class="text-xs text-slate-400 italic">No description provided.</p>';

    drawerContent.innerHTML = `
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase text-slate-500">${ev.category || 'General'}</span>
          ${spanText}
        </div>

        <div class="prose prose-sm text-slate-800">
          ${descriptionHtml}
        </div>

        ${ev.citations ? `
          <div class="pt-3 border-t text-xs text-slate-500">
            <span class="font-semibold block text-slate-700">Academic Citations:</span>
            <p class="font-mono mt-0.5">${Sanitizer.escapeHtml(ev.citations)}</p>
          </div>
        ` : ''}
      </div>
    `;

    drawer.show();
  }

  // Bind Buttons
  container.querySelector('#btn-zoom-in')?.addEventListener('click', () => {
    renderer.pixelsPerDay = Math.min(2400, renderer.pixelsPerDay * 1.35);
    renderer.render();
  });

  container.querySelector('#btn-zoom-out')?.addEventListener('click', () => {
    renderer.pixelsPerDay = Math.max(1e-4, renderer.pixelsPerDay * 0.7);
    renderer.render();
  });

  container.querySelector('#btn-zoom-reset')?.addEventListener('click', () => {
    if (activeTimeline.events.length > 0) {
      const days = activeTimeline.events.map(e => parseHistoricalDateToDays(e.start_date));
      const minDay = Math.min(...days);
      const maxDay = Math.max(...days);
      renderer.centerDay = (minDay + maxDay) / 2;
      renderer.pixelsPerDay = (canvas.clientWidth || 900) / (Math.max(30, maxDay - minDay) * 1.5);
      renderer.render();
    }
  });

  // Search Input
  container.querySelector('#input-search-events')?.addEventListener('sl-input', (e) => {
    searchQuery = e.target.value.trim();
    refreshCanvas();
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
      refreshCanvas();
    });
  });

  // Exports
  container.querySelector('#menu-export-svg')?.addEventListener('click', () => {
    TimelineSVGExporter.downloadSVG(activeTimeline, `${activeTimeline.title.replace(/\s+/g, '_')}.svg`);
  });

  container.querySelector('#menu-export-csv')?.addEventListener('click', () => {
    const csvStr = Exporter.toCSV(activeTimeline.events);
    downloadFile(csvStr, `${activeTimeline.title.replace(/\s+/g, '_')}.csv`, 'text/csv');
  });

  container.querySelector('#menu-export-md')?.addEventListener('click', () => {
    const mdStr = Exporter.toMarkdown(activeTimeline.events, 'timeline');
    downloadFile(mdStr, `${activeTimeline.title.replace(/\s+/g, '_')}.md`, 'text/markdown');
  });

  const fileInput = container.querySelector('#input-timeline-csv');
  container.querySelector('#menu-import-csv')?.addEventListener('click', () => {
    fileInput?.click();
  });

  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const res = parseCSVWithValidation(text, TimelineEventSchema);
      if (!res.success) {
        showImportErrorsDialog(res.errors);
        return;
      }

      // Add to events
      for (const ev of res.data) {
        ev.id = ev.id || generateUUID();
        activeTimeline.events.push(ev);
      }
      activeTimeline.updated_at = new Date().toISOString();
      await storage.table('timelines').put(activeTimeline);
      toast.success(`Imported ${res.data.length} events!`);
      renderTimelineView(params, router, container);
    } catch (err) {
      console.error('Import timeline error:', err);
      toast.danger('Import failed.');
    } finally {
      fileInput.value = '';
    }
  });

  // Add / Edit Event Dialog
  container.querySelector('#btn-add-event')?.addEventListener('click', () => {
    openEventEditorModal(null, activeTimeline, async () => {
      await storage.table('timelines').put(activeTimeline);
      refreshCanvas();
    });
  });

  container.querySelector('#btn-edit-event')?.addEventListener('click', () => {
    if (!currentlySelectedEvent) return;
    drawer.hide();
    openEventEditorModal(currentlySelectedEvent, activeTimeline, async () => {
      await storage.table('timelines').put(activeTimeline);
      refreshCanvas();
    });
  });

  container.querySelector('#btn-delete-event')?.addEventListener('click', async () => {
    if (!currentlySelectedEvent) return;
    if (confirm(`Delete event "${currentlySelectedEvent.title}"?`)) {
      activeTimeline.events = activeTimeline.events.filter(e => e.id !== currentlySelectedEvent.id);
      await storage.table('timelines').put(activeTimeline);
      drawer.hide();
      toast.info('Event removed.');
      refreshCanvas();
    }
  });

  return () => {
    // cleanup
  };
}

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

  const dialog = document.createElement('sl-dialog');
  dialog.label = isNew ? 'Create Timeline Event' : 'Edit Timeline Event';
  dialog.style.setProperty('--width', '560px');

  dialog.innerHTML = `
    <div class="space-y-3">
      <sl-input id="input-ev-title" label="Event Title" value="${Sanitizer.escapeHtml(ev.title)}" required></sl-input>

      <div class="grid grid-cols-2 gap-3">
        <sl-input id="input-ev-start" label="Start Date / Year" value="${Sanitizer.escapeHtml(ev.start_date)}" help-text="e.g. -0044-03-15 or 1517-10-31 or 1969"></sl-input>
        <sl-input id="input-ev-end" label="End Date (Optional)" value="${Sanitizer.escapeHtml(ev.end_date || '')}" help-text="Leave blank for Milestone"></sl-input>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <sl-input id="input-ev-category" label="Category" value="${Sanitizer.escapeHtml(ev.category || 'General')}"></sl-input>
        <div>
          <label class="text-xs text-slate-500 font-medium block mb-1">Color Marker</label>
          <sl-color-picker id="picker-ev-color" value="${ev.color || '#3b82f6'}" size="small" no-format-toggle></sl-color-picker>
        </div>
      </div>

      <sl-textarea id="input-ev-desc" label="Description (Markdown & KaTeX supported)" rows="3" value="${Sanitizer.escapeHtml(ev.description || '')}"></sl-textarea>
      <sl-input id="input-ev-citations" label="Academic Citations (Optional)" value="${Sanitizer.escapeHtml(ev.citations || '')}"></sl-input>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-cancel-ev">Cancel</sl-button>
      <sl-button variant="primary" id="btn-save-ev">Save Event</sl-button>
    </div>
  `;

  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-save-ev')?.addEventListener('click', async () => {
    const title = dialog.querySelector('#input-ev-title').value.trim();
    const start = dialog.querySelector('#input-ev-start').value.trim();
    const end = dialog.querySelector('#input-ev-end').value.trim() || null;
    const cat = dialog.querySelector('#input-ev-category').value.trim() || 'General';
    const color = dialog.querySelector('#picker-ev-color').value || '#3b82f6';
    const desc = dialog.querySelector('#input-ev-desc').value;
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

    dialog.remove();
    toast.success('Event saved!');
    if (onSaveCallback) onSaveCallback();
  });

  dialog.querySelector('#btn-cancel-ev')?.addEventListener('click', () => dialog.remove());
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 100);
}

export default renderTimelineView;
