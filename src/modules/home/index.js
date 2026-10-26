import { storage } from '../../core/storage.js';
import { sync } from '../../core/sync.js';
import { cloudConfig, supportsFolderAccess } from '../../core/storage-adapters/index.js';
import { KeyVault } from '../../core/keyvault.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { router } from '../../router.js';
import { toast } from '../../utils/toast.js';
import { ClassManager } from '../../components/class-manager.js';
import { ShareModal } from '../../components/share-dialog.js';
import { SetupChecklist } from '../../components/setup-checklist.js';
import { computeHomeStats } from './home-stats.js';
import { openCourseSettingsDialog } from '../gradebook/course-settings.js';

/**
 * Platform Home Page & Working Dashboard Controller
 * Sectioned layout: Context bar, Setup checklist, Needs attention, Quick actions, Recent projects, Your classes.
 */
export async function renderHomeView(params, r, container) {
  if (!container) return;

  // 1. Gather live storage data
  const [courses, students, decks, timelines, videos, assignments, submissions] = await Promise.all([
    storage.table('gradebook_courses').toArray().catch(() => []),
    storage.table('gradebook_students').toArray().catch(() => []),
    storage.table('flashcards').toArray().catch(() => []),
    storage.table('timelines').toArray().catch(() => []),
    storage.table('video_assessments').toArray().catch(() => []),
    storage.table('assignments').toArray().catch(() => []),
    storage.table('assignment_submissions').toArray().catch(() => [])
  ]);

  const quota = await storage.checkStorageQuota();
  const metadata = {
    last_manual_export_timestamp: await storage.getMetadata('last_manual_export_timestamp'),
    setup_checklist_dismissed_at: await storage.getMetadata('setup_checklist_dismissed_at'),
    autosync_configured: sync.hasAutomaticBackup(),
    autosync_supported: supportsFolderAccess() || Boolean(cloudConfig().google || cloudConfig().microsoft),
    recovery_kit_saved: (await KeyVault.status(storage)).recoveryKitSaved
  };

  const stats = computeHomeStats({
    courses,
    students,
    assignments,
    submissions,
    videos,
    metadata,
    quota,
    now: new Date()
  });

  const activeClassId = ClassManager.getActiveFilter();
  const activeClass = courses.find(c => c.id === activeClassId);

  // Recent projects (up to 8)
  const recentProjects = [
    ...decks.map(d => ({ ...d, _type: 'flashcards', _label: 'Deck', _icon: 'stack', _color: 'blue', _openUrl: `#/flashcards/study?id=${d.id}`, _editUrl: `#/flashcards/edit?id=${d.id}` })),
    ...timelines.map(t => ({ ...t, _type: 'timeline', _label: 'Timeline', _icon: 'bar-chart-steps', _color: 'violet', _openUrl: `#/timeline/view?id=${t.id}`, _editUrl: `#/timeline/view?id=${t.id}` })),
    ...videos.map(v => ({ ...v, _type: 'video', _label: 'Video', _icon: 'play-circle', _color: 'rose', _openUrl: `#/video/kiosk?id=${v.id}`, _editUrl: `#/video/edit?id=${v.id}` })),
    ...assignments.map(a => ({ ...a, _type: 'assignments', _label: 'Assessment', _icon: 'ui-checks', _color: 'amber', _openUrl: `#/assessments/edit?id=${a.id}`, _editUrl: `#/assessments/edit?id=${a.id}` }))
  ]
    .filter(p => !activeClassId || p.class_id === activeClassId)
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
    .slice(0, 8);

  // Format today's date
  const todayFormatted = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  }).format(new Date());

  // Render HTML structure
  container.innerHTML = `
    <div class="max-w-6xl mx-auto px-4 py-6 space-y-8">
      <!-- 1. Context Bar -->
      ${renderContextBar(todayFormatted, activeClass)}

      <!-- 2. Setup Checklist Container -->
      <div id="home-checklist-mount"></div>

      <!-- 3. Needs Attention Section -->
      ${renderAttentionSection(stats.attentionItems)}

      <!-- 4. Quick Actions -->
      ${renderQuickActions()}

      <!-- 5. Recent Projects -->
      ${renderRecentProjects(recentProjects)}

      <!-- 6. Your Classes Cards -->
      ${renderClassesSection(courses, students, assignments, submissions)}

      <!-- 7. Footer line -->
      <div class="text-center pt-4 pb-2 border-t border-slate-200 text-xs text-slate-500">
        New here? <a href="#/about" class="text-blue-600 font-medium hover:underline">Read how KennisBoost works →</a>
      </div>

      <!-- Hidden file input for open shared file -->
      <input type="file" id="home-input-shared-file" class="hidden" accept=".kbshare,.kbr,.kbsub,.json,.txt,.html,.htm,.kbfeedback,.kbsession">
    </div>
  `;

  // Render Setup Checklist if active
  if (stats.showChecklist) {
    const checklistMount = container.querySelector('#home-checklist-mount');
    SetupChecklist.render(checklistMount, {
      checklistItems: stats.checklistItems,
      onAction: (id, route) => {
        if (route === '#backup') {
          if (metadata.autosync_supported === false) sync.exportManualBackup();
          else window.dispatchEvent(new CustomEvent('kb-open-backup-location'));
        } else if (route === '#recovery-kit') {
          import('../../components/recovery-kit.js').then(({ RecoveryKit }) => RecoveryKit.open());
        } else if (route) {
          router.navigate(route);
        }
      },
      onDismiss: () => {
        // Dismissed
      }
    });
  }

  // Bind Events
  bindHomeEvents(container, courses, router);
}

function renderContextBar(todayStr, activeClass) {
  const classBadge = activeClass ? ClassManager.renderClassBadge(activeClass) : '';

  return `
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
      <div>
        <div class="flex items-center gap-3">
          <h1 class="text-2xl font-black text-slate-900 tracking-tight">Home</h1>
          ${classBadge}
        </div>
        <p class="text-xs font-medium text-slate-500 mt-0.5">${todayStr}</p>
      </div>

      <div class="flex items-center gap-2 flex-wrap">
        <sl-dropdown placement="bottom-end">
          <sl-button slot="trigger" variant="primary" caret>
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> New
          </sl-button>
          <sl-menu>
            <sl-menu-item value="new-assignment">
              <sl-icon slot="prefix" name="ui-checks"></sl-icon> Assessment
            </sl-menu-item>
            <sl-menu-item value="new-video">
              <sl-icon slot="prefix" name="play-circle"></sl-icon> Video assessment
            </sl-menu-item>
            <sl-menu-item value="new-flashcard">
              <sl-icon slot="prefix" name="stack"></sl-icon> Flashcard deck
            </sl-menu-item>
            <sl-menu-item value="new-timeline">
              <sl-icon slot="prefix" name="bar-chart-steps"></sl-icon> Timeline
            </sl-menu-item>
            <sl-divider></sl-divider>
            <sl-menu-item value="new-class">
              <sl-icon slot="prefix" name="mortarboard"></sl-icon> Class / Section
            </sl-menu-item>
          </sl-menu>
        </sl-dropdown>

        <sl-button variant="default" id="btn-home-inbox">
          <sl-icon slot="prefix" name="inbox"></sl-icon> Import student work
        </sl-button>

        <sl-button variant="default" id="btn-home-backup" title="Export manual JSON backup">
          <sl-icon slot="prefix" name="download"></sl-icon> Backup
        </sl-button>
      </div>
    </div>
  `;
}

function renderAttentionSection(items) {
  if (!items || items.length === 0) return '';

  return `
    <div class="space-y-3">
      <div class="flex items-center gap-2">
        <sl-icon name="bell" class="text-amber-600"></sl-icon>
        <h2 class="text-sm font-bold uppercase tracking-wider text-slate-700">Needs Attention</h2>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        ${items.map(it => `
          <div class="flex items-center justify-between p-3.5 rounded-xl border border-amber-200 bg-amber-50/60 text-slate-800 text-xs">
            <div class="flex items-center gap-2.5 min-w-0 pr-2">
              <span class="px-2 py-0.5 rounded-md font-semibold text-[10px] uppercase bg-amber-200 text-amber-900 shrink-0">
                ${it.badge}
              </span>
              <span class="truncate font-medium">${Sanitizer.escapeHTML(it.text)}</span>
            </div>
            ${it.link ? `
              <a href="${Sanitizer.escapeHTML(Sanitizer.safeUrl(it.link))}" class="font-semibold text-blue-600 hover:text-blue-800 shrink-0 hover:underline">
                View →
              </a>
            ` : it.action === 'backup' ? `
              <button type="button" class="font-semibold text-blue-600 hover:text-blue-800 shrink-0 hover:underline" data-action="backup">
                Save →
              </button>
            ` : it.action === 'storage_info' ? `
              <button type="button" class="font-semibold text-blue-600 hover:text-blue-800 shrink-0 hover:underline" data-action="storage_info">
                Manage →
              </button>
            ` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderQuickActions() {
  const actions = [
    { title: 'New Assessment', desc: 'Auto-graded practice', icon: 'ui-checks', color: 'amber', url: '#/assessments/edit' },
    { title: 'New Video', desc: 'Checkpoint interactive video', icon: 'play-circle', color: 'rose', url: '#/video/edit' },
    { title: 'New Deck', desc: 'Spaced repetition flashcards', icon: 'stack', color: 'blue', url: '#/flashcards/edit' },
    { title: 'New Timeline', desc: 'Multi-scale historical events', icon: 'bar-chart-steps', color: 'violet', url: '#/timeline/view?new=1' },
    { title: 'Open Shared File', desc: '.kbshare, .kbr, or .kbsub', icon: 'folder2-open', color: 'emerald', action: 'open_file' },
    { title: 'Teacher Guide', desc: 'Workflows and tutorials', icon: 'book', color: 'slate', url: '#/guide' }
  ];

  return `
    <div class="space-y-3">
      <h2 class="text-sm font-bold uppercase tracking-wider text-slate-700">Quick Actions</h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        ${actions.map(a => `
          ${a.url ? `
            <a href="${a.url}" class="p-3.5 rounded-xl border border-slate-200 bg-white hover:border-blue-400 hover:shadow-xs transition-all flex flex-col items-start gap-2 text-left group">
              <span class="w-8 h-8 rounded-lg bg-${a.color}-50 text-${a.color}-600 flex items-center justify-center text-lg">
                <sl-icon name="${a.icon}"></sl-icon>
              </span>
              <div>
                <div class="font-bold text-xs text-slate-900 group-hover:text-blue-600">${a.title}</div>
                <div class="text-[11px] text-slate-500 mt-0.5 truncate">${a.desc}</div>
              </div>
            </a>
          ` : `
            <button type="button" data-action="${a.action}" class="p-3.5 rounded-xl border border-slate-200 bg-white hover:border-blue-400 hover:shadow-xs transition-all flex flex-col items-start gap-2 text-left group w-full">
              <span class="w-8 h-8 rounded-lg bg-${a.color}-50 text-${a.color}-600 flex items-center justify-center text-lg">
                <sl-icon name="${a.icon}"></sl-icon>
              </span>
              <div>
                <div class="font-bold text-xs text-slate-900 group-hover:text-blue-600">${a.title}</div>
                <div class="text-[11px] text-slate-500 mt-0.5 truncate">${a.desc}</div>
              </div>
            </button>
          `}
        `).join('')}
      </div>
    </div>
  `;
}

function renderRecentProjects(projects) {
  if (projects.length === 0) return '';

  return `
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-bold uppercase tracking-wider text-slate-700">Recent Projects</h2>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        ${projects.map(p => `
          <div class="p-3.5 rounded-xl border border-slate-200 bg-white hover:border-slate-300 shadow-xs transition-all flex flex-col justify-between gap-3">
            <div class="space-y-1">
              <div class="flex items-center justify-between gap-1 text-[11px]">
                <span class="font-semibold text-${p._color}-600 flex items-center gap-1">
                  <sl-icon name="${p._icon}"></sl-icon> ${p._label}
                </span>
                ${p.is_demo ? '<span class="px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 text-[9px] uppercase font-bold">Sample</span>' : ''}
              </div>
              <h3 class="font-bold text-sm text-slate-900 truncate" title="${Sanitizer.escapeHTML(p.title)}">
                ${Sanitizer.escapeHTML(p.title)}
              </h3>
            </div>
            <div class="flex items-center gap-2 pt-2 border-t border-slate-100">
              <a href="${Sanitizer.escapeHTML(p._openUrl)}" class="flex-1 text-center py-1 rounded-lg text-xs font-medium bg-slate-50 hover:bg-slate-100 text-slate-700">Open</a>
              <a href="${Sanitizer.escapeHTML(p._editUrl)}" class="px-2 py-1 rounded-lg text-xs font-medium bg-slate-50 hover:bg-slate-100 text-slate-700" title="Edit">
                <sl-icon name="pencil"></sl-icon>
              </a>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderClassesSection(courses, students, assignments, submissions) {
  const activeCourses = courses.filter(c => !c.archived_at);

  if (activeCourses.length === 0) {
    return `
      <div class="space-y-3">
        <h2 class="text-sm font-bold uppercase tracking-wider text-slate-700">Your Classes</h2>
        <div class="p-8 rounded-2xl border border-dashed border-slate-300 bg-slate-50 text-center space-y-3">
          <sl-icon name="mortarboard" class="text-3xl text-slate-400"></sl-icon>
          <div class="text-sm font-semibold text-slate-700">No classes yet</div>
          <p class="text-xs text-slate-500 max-w-sm mx-auto">Set up your class roster and start assigning work to your students.</p>
          <sl-button variant="primary" size="small" id="btn-home-create-first-class">
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> Set up a class
          </sl-button>
        </div>
      </div>
    `;
  }

  return `
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-bold uppercase tracking-wider text-slate-700">Your Classes</h2>
        <a href="#/gradebook" class="text-xs font-semibold text-blue-600 hover:underline">Manage in Gradebook →</a>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${activeCourses.map(c => {
          const studentCount = students.filter(s => s.course_id === c.id).length;
          const classAssignments = assignments.filter(a => a.class_id === c.id || a.gradebook?.course_id === c.id);
          const asgnIds = new Set(classAssignments.map(a => a.id));
          const pendingCount = submissions.filter(s => asgnIds.has(s.assignment_id) && s.is_latest !== false && !s.synced_at).length;

          return `
            <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-xs space-y-3">
              <div class="flex items-center gap-3">
                <div class="w-3.5 h-10 rounded-full shrink-0" style="background-color: ${Sanitizer.safeColor(c.color, '#2563eb')};"></div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <h3 class="font-bold text-sm text-slate-900 truncate">${Sanitizer.escapeHTML(c.name)}</h3>
                    ${c.is_demo ? '<span class="px-1 py-0.2 rounded bg-amber-100 text-amber-800 text-[9px] uppercase font-bold shrink-0">Sample</span>' : ''}
                  </div>
                  <p class="text-xs text-slate-500 truncate">${Sanitizer.escapeHTML(c.section || '')} • ${Sanitizer.escapeHTML(c.academic_year || '')}</p>
                </div>
              </div>

              <div class="grid grid-cols-3 gap-2 py-2 border-y border-slate-100 text-center text-xs">
                <div>
                  <div class="font-bold text-slate-900">${studentCount}</div>
                  <div class="text-[10px] text-slate-400 uppercase">Students</div>
                </div>
                <div>
                  <div class="font-bold text-slate-900">${classAssignments.length}</div>
                  <div class="text-[10px] text-slate-400 uppercase">Tasks</div>
                </div>
                <div>
                  <div class="font-bold ${pendingCount > 0 ? 'text-amber-600' : 'text-slate-900'}">${pendingCount}</div>
                  <div class="text-[10px] text-slate-400 uppercase">Pending</div>
                </div>
              </div>

              <div class="flex items-center gap-2">
                <sl-button size="small" variant="default" class="flex-1" href="#/gradebook">Gradebook</sl-button>
                <sl-button size="small" variant="default" href="#/gradebook?view=roster">Roster</sl-button>
                <sl-button size="small" variant="default" data-action="course-settings" data-course-id="${Sanitizer.escapeHTML(c.id)}" title="Class Settings">
                  <sl-icon name="gear"></sl-icon>
                </sl-button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function bindHomeEvents(container, courses, router) {
  // New dropdown
  container.querySelector('sl-dropdown')?.addEventListener('sl-select', (e) => {
    const val = e.detail.item.value;
    if (val === 'new-assignment') router.navigate('#/assessments/edit');
    if (val === 'new-video') router.navigate('#/video/edit');
    if (val === 'new-flashcard') router.navigate('#/flashcards/edit');
    if (val === 'new-timeline') router.navigate('#/timeline/view?new=1');
    if (val === 'new-class') {
      ClassManager.openClassEditorModal(null, () => renderHomeView(null, router, container));
    }
  });

  // Action buttons
  container.querySelector('#btn-home-inbox')?.addEventListener('click', () => {
    router.navigate('#/inbox');
  });

  container.querySelector('#btn-home-backup')?.addEventListener('click', () => {
    sync.exportManualBackup();
  });

  container.querySelector('[data-action="backup"]')?.addEventListener('click', () => {
    sync.exportManualBackup();
  });

  container.querySelector('[data-action="storage_info"]')?.addEventListener('click', () => {
    document.getElementById('menu-btn-storage-info')?.click();
  });

  container.querySelector('#btn-home-create-first-class')?.addEventListener('click', () => {
    ClassManager.openClassEditorModal(null, () => renderHomeView(null, router, container));
  });

  // Open shared file action (Universal Importer)
  const fileInput = container.querySelector('#home-input-shared-file');
  container.querySelector('[data-action="open_file"]')?.addEventListener('click', async () => {
    const { UniversalImportDialog } = await import('../../components/universal-import-dialog.js');
    UniversalImportDialog.open();
  });

  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      // Hand-in files go to the Inbox (with the file), lessons to the import dialog
      const { openIncomingFiles } = await import('../../core/pwa.js');
      await openIncomingFiles([file], router);
    } catch (err) {
      toast.danger('Could not open file: ' + err.message);
    } finally {
      fileInput.value = '';
    }
  });

  // Course settings buttons
  container.querySelectorAll('[data-action="course-settings"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const courseId = btn.dataset.courseId;
      const course = courses.find(c => c.id === courseId);
      if (course) {
        openCourseSettingsDialog({
          course,
          otherCourses: courses.filter(c => c.id !== courseId),
          initialTab: 'general',
          onSave: async (updated) => {
            await storage.table('gradebook_courses').put(updated);
            toast.success('Class settings saved.');
            renderHomeView(null, router, container);
          }
        });
      }
    });
  });
}

export default renderHomeView;
