import { storage } from '../core/storage.js';
import { router } from '../router.js';
import { Sanitizer } from '../core/sanitizer.js';
import { ClassManager } from './class-manager.js';
import { store } from '../state/store.js';
import { sync } from '../core/sync.js';
import { RoleMode } from '../state/role-mode.js';
import { SearchEngine } from '../core/search-engine.js';

/**
 * Universal Command Palette (Ctrl/Cmd + K) and Keyboard Shortcuts Help Modal (?)
 */
export class CommandPalette {
  static init() {
    if (typeof window === 'undefined') return;

    window.addEventListener('keydown', (e) => {
      // Ctrl+K or Cmd+K
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.open();
      }

      // '?' key (when not focused in any text input, textarea, select, or editable element)
      const target = e.target;
      const tag = target?.tagName;
      const isInput = ['INPUT', 'TEXTAREA', 'SL-INPUT', 'SL-TEXTAREA', 'SL-SELECT'].includes(tag) ||
        target?.isContentEditable || document.activeElement?.isContentEditable;

      if (e.key === '?' && !isInput) {
        e.preventDefault();
        this.openShortcutsModal();
      }
    });

    ['btn-open-cmd-palette', 'btn-open-cmd-palette-mobile'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', () => this.open());
    });

    document.getElementById('menu-btn-keyboard-shortcuts')?.addEventListener('click', () => {
      this.openShortcutsModal();
    });
  }

  static async open() {
    const existing = document.getElementById('kb-command-palette-dialog');
    if (existing) existing.remove();

    const [courses, decks, timelines, videos, assignmentSets, taskList] = await Promise.all([
      storage.table('gradebook_courses').toArray().catch(() => []),
      storage.table('flashcards').toArray().catch(() => []),
      storage.table('timelines').toArray().catch(() => []),
      storage.table('video_assessments').toArray().catch(() => []),
      storage.table('assignments').toArray().catch(() => []),
      storage.table('tasks').toArray().catch(() => [])
    ]);

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'kb-command-palette-dialog';
    dialog.label = 'Command & Quick Navigation';
    dialog.className = 'kb-cmd-palette-dialog';
    dialog.setAttribute('no-header', '');

    dialog.innerHTML = `
      <div class="space-y-3 p-1">
        <div class="relative">
          <sl-input id="input-cmd-search" placeholder="Type a command, or /class, /goto, or search decks, rubrics..." autofocus>
            <sl-icon name="search" slot="prefix" class="text-blue-600"></sl-icon>
          </sl-input>
        </div>

        <div id="kb-cmd-results" class="max-h-80 overflow-y-auto space-y-1 text-xs pr-1">
          <!-- Populated dynamically -->
        </div>

        <div class="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
          <div class="flex items-center gap-3">
            <span><kbd class="px-1.5 py-0.5 bg-slate-100 rounded border border-slate-200">↑↓</kbd> Navigate</span>
            <span><kbd class="px-1.5 py-0.5 bg-slate-100 rounded border border-slate-200">↵</kbd> Select</span>
            <span><kbd class="px-1.5 py-0.5 bg-slate-100 rounded border border-slate-200">ESC</kbd> Close</span>
          </div>
          <span>KennisBoost Command Hub</span>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    const searchInput = dialog.querySelector('#input-cmd-search');
    const resultsContainer = dialog.querySelector('#kb-cmd-results');

    const role = RoleMode.get();

    // Build searchable catalog filtered by active role
    const staticActions = role === 'student' ? [
      { category: 'Navigation', title: 'Go to Student Hub', icon: 'house-door', run: () => router.navigate('#/student') },
      { category: 'Navigation', title: 'My Courses', icon: 'journal-bookmark', run: () => router.navigate('#/student/courses') },
      { category: 'Navigation', title: 'Calendar', icon: 'calendar3', run: () => router.navigate('#/calendar') },
      { category: 'Navigation', title: 'My Grades & Feedback', icon: 'journal-check', run: () => router.navigate('#/student/gradebook') },
      { category: 'Actions', title: 'Scan QR Code (Join Class / Open Activity)', icon: 'qr-code-scan', run: async () => { const { UniversalImportDialog } = await import('./universal-import-dialog.js'); UniversalImportDialog.open({ initialTab: 'qr' }); } },
      { category: 'Study', title: 'Study Flashcards', icon: 'stack', run: () => router.navigate('#/flashcards') },
      { category: 'Study', title: 'Timeline Maker', icon: 'bar-chart-steps', run: () => router.navigate('#/timeline') },
      { category: 'Study', title: 'Interactive Video', icon: 'play-circle', run: () => router.navigate('#/video') },
      { category: 'Info', title: 'About KennisBoost Tools', icon: 'info-circle', run: () => router.navigate('#/about') },
      { category: 'Info', title: 'Local-First Philosophy', icon: 'shield-check', run: () => router.navigate('#/philosophy') },
      { category: 'Help', title: 'Keyboard Shortcuts Cheat Sheet', icon: 'question-circle', run: () => this.openShortcutsModal() }
    ] : [
      { category: 'Navigation', title: 'Go to Home Hub', icon: 'house-door', run: () => router.navigate('#/') },
      { category: 'Navigation', title: 'Courses', icon: 'journal-bookmark', run: () => router.navigate('#/course') },
      { category: 'Navigation', title: 'Interactive Calendar', icon: 'calendar3', run: () => router.navigate('#/calendar') },
      { category: 'Navigation', title: 'Classes & Rosters', icon: 'people', run: () => router.navigate('#/classes') },
      { category: 'Navigation', title: 'Open Gradebook Spreadsheet', icon: 'journal-check', run: () => router.navigate('#/gradebook') },
      { category: 'Navigation', title: 'Open Inbox (Collect Student Work)', icon: 'inbox', run: () => router.navigate('#/inbox') },
      { category: 'Navigation', title: 'Open Flashcards Library', icon: 'stack', run: () => router.navigate('#/flashcards') },
      { category: 'Navigation', title: 'Open Timeline Maker', icon: 'bar-chart-steps', run: () => router.navigate('#/timeline') },
      { category: 'Navigation', title: 'Open Video Assessments', icon: 'play-circle', run: () => router.navigate('#/video') },
      { category: 'Navigation', title: 'Open Assessments', icon: 'ui-checks', run: () => router.navigate('#/assessments') },
      { category: 'Navigation', title: 'New Interactive Assessment', icon: 'plus-lg', run: () => router.navigate('#/assessments/edit') },
      { category: 'Navigation', title: 'Open Assignments', icon: 'journal-text', run: () => router.navigate('#/assignments') },
      { category: 'Navigation', title: 'New Assignment (Text, Code, Drawing, Files)', icon: 'plus-lg', run: () => router.navigate('#/assignments/create') },
      { category: 'Navigation', title: 'Teacher Guide: Recommended Workflows', icon: 'signpost-split', run: () => router.navigate('#/guide') },
      { category: 'Navigation', title: 'About KennisBoost Tools', icon: 'info-circle', run: () => router.navigate('#/about') },
      { category: 'Navigation', title: 'Local-First Philosophy & Privacy Architecture', icon: 'shield-check', run: () => router.navigate('#/philosophy') },
      { category: 'Actions', title: 'Scan QR Code (Import Content / Stream)', icon: 'qr-code-scan', run: async () => { const { UniversalImportDialog } = await import('./universal-import-dialog.js'); UniversalImportDialog.open({ initialTab: 'qr' }); } },
      { category: 'Actions', title: 'Import Content (.kbshare, CSV, JSON)', icon: 'cloud-download', run: async () => { const { UniversalImportDialog } = await import('./universal-import-dialog.js'); UniversalImportDialog.open(); } },
      { category: 'Actions', title: 'Create New Flashcard Deck', icon: 'plus-circle', run: () => router.navigate('#/flashcards/edit') },
      { category: 'Actions', title: 'Load sample workspace', icon: 'box-arrow-in-down', run: async () => { const { loadDemoWorkspace } = await import('../core/demo.js'); await loadDemoWorkspace(); router.handleRoute(); } },
      { category: 'Actions', title: 'Remove sample data', icon: 'trash', run: async () => { const { removeDemoData } = await import('../core/demo.js'); await removeDemoData(); router.handleRoute(); } },
      { category: 'Actions', title: 'Export Encrypted Backup File', icon: 'download', run: () => sync.exportManualBackup() },
      { category: 'Actions', title: 'Connect to School Relay Server (Settings & Setup Guide)', icon: 'hdd-network', run: async () => { const { openRelayConfigDialog } = await import('../main.js'); openRelayConfigDialog(); } },
      { category: 'Actions', title: 'Devices & Multi-Device Sync', icon: 'laptop', run: async () => { const { default: openDevicesDialog } = await import('./devices-dialog.js'); openDevicesDialog(); } },
      { category: 'Actions', title: 'Data Safety Checkup', icon: 'shield-check', run: async () => { const { default: openDataSafetyDialog } = await import('./data-safety.js'); openDataSafetyDialog(); } },
      { category: 'Actions', title: 'Keyboard Shortcuts Cheat Sheet', icon: 'question-circle', run: () => this.openShortcutsModal() }
    ];

    const projectItems = role === 'student' ? [
      ...decks.map(d => ({ category: 'Flashcards', title: d.title, subtitle: `${d.cards?.length || 0} cards`, icon: 'stack', run: () => router.navigate(`#/flashcards/study?id=${d.id}`) })),
      ...timelines.map(t => ({ category: 'Timelines', title: t.title, subtitle: `${t.events?.length || 0} events`, icon: 'bar-chart-steps', run: () => router.navigate(`#/timeline/view?id=${t.id}`) })),
      ...videos.map(v => ({ category: 'Videos', title: v.title, subtitle: `${v.checkpoints?.length || 0} checkpoints`, icon: 'play-circle', run: () => router.navigate(`#/video/kiosk?id=${v.id}`) }))
    ] : [
      ...courses.map(c => ({ category: 'Classes', title: c.name, subtitle: c.section || 'Class Roster', icon: 'mortarboard', color: c.color || '#2563eb', run: () => router.navigate(`#/classes?courseId=${c.id}`) })),
      ...decks.map(d => ({ category: 'Flashcards', title: d.title, subtitle: `${d.cards?.length || 0} cards`, icon: 'stack', run: () => router.navigate(`#/flashcards/study?id=${d.id}`) })),
      ...timelines.map(t => ({ category: 'Timelines', title: t.title, subtitle: `${t.events?.length || 0} events`, icon: 'bar-chart-steps', run: () => router.navigate(`#/timeline/view?id=${t.id}`) })),
      ...videos.map(v => ({ category: 'Videos', title: v.title, subtitle: `${v.checkpoints?.length || 0} checkpoints`, icon: 'play-circle', run: () => router.navigate(`#/video/kiosk?id=${v.id}`) })),
      ...assignmentSets.map(a => ({ category: 'Assessments', title: a.title, subtitle: `${a.questions?.length || 0} questions`, icon: 'ui-checks', run: () => router.navigate(`#/assessments/edit?id=${a.id}`) })),
      ...taskList.map(t => ({ category: 'Assignments', title: t.title, subtitle: t.grading?.scoring === 'proficiency' ? 'Proficiency' : `${t.grading?.max_points ?? 100} pts`, icon: 'journal-text', run: () => router.navigate(`#/assignments/create?id=${t.id}`) }))
    ];

    const allCommands = [...staticActions, ...projectItems];

    resultsContainer.setAttribute('role', 'listbox');
    resultsContainer.setAttribute('id', 'kb-cmd-results');
    searchInput.setAttribute('role', 'combobox');
    searchInput.setAttribute('aria-expanded', 'true');
    searchInput.setAttribute('aria-controls', 'kb-cmd-results');

    const renderList = async (filterText = '') => {
      const q = filterText.toLowerCase().trim();
      let matched = [];

      if (q.startsWith('/class')) {
        const arg = q.slice(6).trim();
        const classActions = [
          {
            category: 'Class Switch',
            title: 'All Classes (No Filter)',
            subtitle: 'Clear active class context filter',
            icon: 'grid',
            run: () => {
              store.setActiveClass(null);
            }
          },
          ...courses.map(c => ({
            category: 'Class Switch',
            title: c.name,
            subtitle: c.section || 'Class Roster',
            icon: 'mortarboard',
            color: c.color || '#2563eb',
            run: () => {
              store.setActiveClass(c);
            }
          }))
        ];
        matched = classActions.filter(c =>
          !arg || c.title.toLowerCase().includes(arg) || (c.subtitle && c.subtitle.toLowerCase().includes(arg))
        );
      } else if (q.startsWith('/goto')) {
        const arg = q.slice(5).trim();
        const activeCourse = store.getState('activeCourse');
        const activeCourseId = store.getState('activeCourseId');
        const destinations = [
          { category: 'Go To', title: 'Gradebook', subtitle: activeCourse ? `Filtered to ${activeCourse.name}` : 'Multi-Class Grid', icon: 'journal-check', run: () => router.navigate(activeCourseId ? `#/gradebook?courseId=${activeCourseId}` : '#/gradebook') },
          { category: 'Go To', title: 'Inbox', subtitle: 'Collect & Stage Student Submissions', icon: 'inbox', run: () => router.navigate('#/inbox') },
          { category: 'Go To', title: 'Calendar', subtitle: 'Interactive Due Dates & Schedule', icon: 'calendar3', run: () => router.navigate('#/calendar') },
          { category: 'Go To', title: 'Classes & Rosters', subtitle: 'Manage Students, Codes & Sections', icon: 'people', run: () => router.navigate('#/classes') },
          { category: 'Go To', title: 'Course Units', subtitle: 'Curriculum Outline & Feed', icon: 'journal-bookmark', run: () => router.navigate(activeCourseId ? `#/course?id=${activeCourseId}` : '#/course') },
          { category: 'Go To', title: 'Assessments', subtitle: 'Interactive Quizzes & Tests', icon: 'ui-checks', run: () => router.navigate('#/assessments') },
          { category: 'Go To', title: 'Assignments', subtitle: 'Multimodal Tasks (Code, Vector, Essay)', icon: 'journal-text', run: () => router.navigate('#/assignments') },
          { category: 'Go To', title: 'Flashcards', subtitle: 'Spaced Repetition & Study Player', icon: 'stack', run: () => router.navigate('#/flashcards') },
          { category: 'Go To', title: 'Timeline', subtitle: 'Interactive Historical Timelines', icon: 'bar-chart-steps', run: () => router.navigate('#/timeline') },
          { category: 'Go To', title: 'Video Lessons', subtitle: 'Interactive Video Checkpoints', icon: 'play-circle', run: () => router.navigate('#/video') },
          { category: 'Go To', title: 'Student Hub', subtitle: 'Student Workspace & Course List', icon: 'house-door', run: () => router.navigate('#/student') }
        ];
        matched = destinations.filter(d =>
          !arg || d.title.toLowerCase().includes(arg) || (d.subtitle && d.subtitle.toLowerCase().includes(arg))
        );
      } else {
        matched = allCommands.filter(c =>
          !q || c.title.toLowerCase().includes(q) || (c.subtitle && c.subtitle.toLowerCase().includes(q)) || c.category.toLowerCase().includes(q)
        );

        if (q.length >= 2) {
          try {
            const deepHits = await SearchEngine.search(q, { limit: 8 });
            for (const hit of deepHits) {
              if (!matched.some(m => m.title === hit.title)) {
                matched.push({
                  category: hit.category,
                  title: hit.title,
                  subtitle: hit.snippet || '',
                  icon: hit.category === 'Flashcards' ? 'stack' : hit.category === 'Timelines' ? 'bar-chart-steps' : hit.category === 'Video Lessons' ? 'play-circle' : hit.category === 'Classes' ? 'mortarboard' : hit.category === 'Assessments' ? 'ui-checks' : hit.category === 'Assignments' ? 'journal-text' : 'search',
                  run: () => router.navigate(hit.route)
                });
              }
            }
          } catch (_) {}
        }
      }

      if (matched.length === 0) {
        resultsContainer.innerHTML = `
          <div class="py-6 text-center text-slate-400">
            <p>No matching commands or projects found.</p>
          </div>
        `;
        searchInput.removeAttribute('aria-activedescendant');
        return;
      }

      resultsContainer.innerHTML = matched.map((item, idx) => {
        const safeTitle = Sanitizer.escapeHTML(item.title);
        const safeSubtitle = item.subtitle ? Sanitizer.escapeHTML(item.subtitle) : '';
        const safeCategory = Sanitizer.escapeHTML(item.category);
        return `
          <div class="kb-cmd-item flex items-center justify-between p-2 rounded-lg hover:bg-blue-50 cursor-pointer transition-colors ${idx === 0 ? 'bg-blue-50/70' : ''}" data-index="${idx}" id="kb-cmd-item-${idx}" role="option" aria-selected="${idx === 0}">
            <div class="flex items-center gap-2.5">
              <span class="w-6 h-6 rounded flex items-center justify-center bg-slate-100 text-slate-600 text-xs">
                <sl-icon name="${item.icon}"></sl-icon>
              </span>
              <div>
                <span class="font-medium text-slate-900">${safeTitle}</span>
                ${safeSubtitle ? `<span class="text-slate-400 ml-1.5 text-[11px]">${safeSubtitle}</span>` : ''}
              </div>
            </div>
            <span class="text-[10px] uppercase font-semibold text-slate-400 tracking-wider">${safeCategory}</span>
          </div>
        `;
      }).join('');

      searchInput.setAttribute('aria-activedescendant', 'kb-cmd-item-0');

      const items = resultsContainer.querySelectorAll('.kb-cmd-item');
      items.forEach((elem, i) => {
        elem.addEventListener('click', () => {
          dialog.hide();
          matched[i].run();
        });
      });
    };

    renderList();

    searchInput?.addEventListener('input', () => {
      renderList(searchInput.value);
    });

    searchInput?.addEventListener('keydown', (e) => {
      const items = Array.from(resultsContainer.querySelectorAll('.kb-cmd-item'));
      if (items.length === 0) return;

      let currentActiveIdx = items.findIndex(el => el.classList.contains('bg-blue-50/70') || el.classList.contains('bg-blue-100'));

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[currentActiveIdx]?.classList.remove('bg-blue-50/70', 'bg-blue-100');
        items[currentActiveIdx]?.setAttribute('aria-selected', 'false');
        currentActiveIdx = (currentActiveIdx + 1) % items.length;
        items[currentActiveIdx]?.classList.add('bg-blue-100');
        items[currentActiveIdx]?.setAttribute('aria-selected', 'true');
        items[currentActiveIdx]?.scrollIntoView({ block: 'nearest' });
        searchInput.setAttribute('aria-activedescendant', `kb-cmd-item-${currentActiveIdx}`);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[currentActiveIdx]?.classList.remove('bg-blue-50/70', 'bg-blue-100');
        items[currentActiveIdx]?.setAttribute('aria-selected', 'false');
        currentActiveIdx = (currentActiveIdx - 1 + items.length) % items.length;
        items[currentActiveIdx]?.classList.add('bg-blue-100');
        items[currentActiveIdx]?.setAttribute('aria-selected', 'true');
        items[currentActiveIdx]?.scrollIntoView({ block: 'nearest' });
        searchInput.setAttribute('aria-activedescendant', `kb-cmd-item-${currentActiveIdx}`);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        items[currentActiveIdx]?.click();
      }
    });

    dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
  }

  static openShortcutsModal() {
    const existing = document.getElementById('kb-shortcuts-modal');
    if (existing) existing.remove();

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'kb-shortcuts-modal';
    dialog.label = 'Keyboard Shortcuts Cheat Sheet';
    dialog.style.setProperty('--width', '600px');

    dialog.innerHTML = `
      <div class="space-y-4 py-1 text-xs text-slate-700">
        <!-- Global -->
        <div>
          <h4 class="font-bold text-slate-900 text-sm mb-2 pb-1 border-b">Global Platform</h4>
          <div class="grid grid-cols-2 gap-2">
            <div class="flex justify-between items-center py-1">
              <span>Command Palette</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">Ctrl/Cmd + K</kbd>
            </div>
            <div class="flex justify-between items-center py-1">
              <span>Shortcuts Help</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">?</kbd>
            </div>
          </div>
        </div>

        <!-- Flashcards Study -->
        <div>
          <h4 class="font-bold text-slate-900 text-sm mb-2 pb-1 border-b">Flashcards Study Mode</h4>
          <div class="grid grid-cols-2 gap-2">
            <div class="flex justify-between items-center py-1">
              <span>Flip Card Front / Back</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">Space</kbd>
            </div>
            <div class="flex justify-between items-center py-1">
              <span>Grade Again</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">1</kbd>
            </div>
            <div class="flex justify-between items-center py-1">
              <span>Grade Hard</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">2</kbd>
            </div>
            <div class="flex justify-between items-center py-1">
              <span>Grade Good</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">3</kbd>
            </div>
            <div class="flex justify-between items-center py-1">
              <span>Grade Easy</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">4</kbd>
            </div>
          </div>
        </div>

        <!-- Gradebook Spreadsheet -->
        <div>
          <h4 class="font-bold text-slate-900 text-sm mb-2 pb-1 border-b">Gradebook Virtual Grid</h4>
          <div class="grid grid-cols-2 gap-2">
            <div class="flex justify-between items-center py-1">
              <span>Commit &amp; Move Down</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">Enter / ↓</kbd>
            </div>
            <div class="flex justify-between items-center py-1">
              <span>Commit &amp; Move Right</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">Tab / →</kbd>
            </div>
            <div class="flex justify-between items-center py-1">
              <span>Mark Missing</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">M</kbd>
            </div>
            <div class="flex justify-between items-center py-1">
              <span>Mark Exempt</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">E</kbd>
            </div>
            <div class="flex justify-between items-center py-1">
              <span>Toggle Late</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">L</kbd>
            </div>
            <div class="flex justify-between items-center py-1">
              <span>Undo Score Edit</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">Ctrl/Cmd + Z</kbd>
            </div>
          </div>
        </div>

        <!-- Timeline -->
        <div>
          <h4 class="font-bold text-slate-900 text-sm mb-2 pb-1 border-b">Timeline Navigation</h4>
          <div class="grid grid-cols-2 gap-2">
            <div class="flex justify-between items-center py-1">
              <span>Pan Left / Right</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">← / → or Drag</kbd>
            </div>
            <div class="flex justify-between items-center py-1">
              <span>Zoom In / Out</span>
              <kbd class="px-2 py-0.5 bg-slate-100 rounded border font-mono">Wheel / + / -</kbd>
            </div>
          </div>
        </div>
      </div>
      <div slot="footer">
        <sl-button variant="primary" id="btn-close-shortcuts-modal">Close</sl-button>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    dialog.querySelector('#btn-close-shortcuts-modal')?.addEventListener('click', () => dialog.hide());
    dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
  }
}
