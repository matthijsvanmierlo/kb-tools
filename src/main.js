import { storage } from './core/storage.js';
import { sync } from './core/sync.js';
import { router } from './router.js';
import { store } from './state/store.js';
import { toast } from './utils/toast.js';
import { Sanitizer } from './core/sanitizer.js';
import { registerServiceWorker, initLaunchHandlers, canInstallPwa, promptPwaInstall, openIncomingFiles } from './core/pwa.js';
import { getTransport, setTransportConfig, RelayTransport } from './core/transport.js';
import { RoleMode } from './state/role-mode.js';
import { WelcomeRoleChooser } from './components/welcome-role-chooser.js';

// Lazy-loaded or modular controller bindings
async function loadHomeModule(...args) {
  const mod = await import('./modules/home/index.js');
  return mod.renderHomeView(...args);
}

async function loadStudentHubModule(...args) {
  const mod = await import('./modules/student/index.js');
  return mod.renderStudentHubView(...args);
}

async function loadStudentGradebookModule(...args) {
  const mod = await import('./modules/student/gradebook.js');
  return mod.renderStudentGradebookView(...args);
}

async function loadFlashcardsModule(...args) {
  const mod = await import('./modules/flashcards/index.js');
  return mod.renderFlashcardsView(...args);
}

async function loadTimelineModule(...args) {
  const mod = await import('./modules/timeline/index.js');
  return mod.renderTimelineView(...args);
}

async function loadVideoModule(...args) {
  const mod = await import('./modules/video/index.js');
  return mod.renderVideoView(...args);
}

async function loadAssignmentsModule(...args) {
  const mod = await import('./modules/assignments/index.js');
  return mod.renderAssignmentsView(...args);
}

async function loadTasksModule(...args) {
  const mod = await import('./modules/tasks/index.js');
  return mod.default(...args);
}

async function loadStudentReportModule(...args) {
  const mod = await import('./modules/gradebook/student-report.js');
  return mod.renderStudentReportView(...args);
}

async function loadAboutModule(...args) {
  const mod = await import('./modules/about/index.js');
  return mod.renderAboutView(...args);
}

async function loadInboxModule(...args) {
  const mod = await import('./modules/inbox/index.js');
  return mod.renderInboxView(...args);
}

async function loadGuideModule(...args) {
  const mod = await import('./modules/guide/index.js');
  return mod.renderGuideView(...args);
}

async function loadGradebookModule(...args) {
  const mod = await import('./modules/gradebook/index.js');
  return mod.renderGradebookView(...args);
}

async function loadClassesModule(...args) {
  const mod = await import('./modules/classes/index.js');
  return mod.renderClassesView(...args);
}

async function loadCourseModule(...args) {
  const mod = await import('./modules/course/index.js');
  return mod.renderCourseView(...args);
}

async function loadStudentCoursesModule(...args) {
  const mod = await import('./modules/student/courses.js');
  return mod.renderStudentCoursesView(...args);
}

async function loadStudentCourseDetailModule(...args) {
  const mod = await import('./modules/student/course-detail.js');
  return mod.renderStudentCourseDetailView(...args);
}

async function loadCalendarModule(...args) {
  const mod = await import('./modules/calendar/index.js');
  return mod.renderCalendarView(...args);
}

async function loadFeedbackModule(...args) {
  const eph = store.getState('ephemeralData');
  if (eph?.type === 'task_feedback' || eph?.payload?.kind === 'task_feedback') {
    const mod = await import('./modules/tasks/feedback-view.js');
    return mod.renderTaskFeedbackView(...args);
  }
  const mod = await import('./modules/assignments/feedback-view.js');
  return mod.renderFeedbackView(...args);
}

/**
 * Initialize application services and DOM event bindings
 */
async function bootstrapApp() {
  try {
    // 0. School IT settings, storage, and Shoelace readiness in parallel
    const [{ loadManagedConfig }, { shoelaceReady }] = await Promise.all([
      import('./core/managed-config.js'),
      import('./boot/shoelace-setup.js')
    ]);
    await Promise.all([
      loadManagedConfig(),
      storage.init(),
      shoelaceReady
    ]);

    // 2. Initialize sync engine & check 72h backup
    await sync.init();

    // Multi-device / co-teacher sync (a no-op that just prunes the outbox until set up)
    const { replication } = await import('./core/replication/manager.js');
    replication.start();
    const { initDataSafety } = await import('./components/data-safety.js');
    initDataSafety();
    window.addEventListener('kb-remote-changes', () => {
      // Show changes from other devices, unless the teacher is typing
      const el = document.activeElement;
      const typing = el && (el.isContentEditable || /^(INPUT|TEXTAREA|SL-INPUT|SL-TEXTAREA|SELECT)$/.test(el.tagName));
      if (!typing && !document.querySelector('sl-dialog[open]')) router.handleRoute();
    });

    // 3. Register module routes
    router.register('#/', loadHomeModule);
    router.register('#/home', loadHomeModule);
    router.register('#/about', loadAboutModule);
    router.register('#/philosophy', loadAboutModule);
    router.register('#/flashcards', loadFlashcardsModule);
    router.register('#/flashcards/edit', loadFlashcardsModule);
    router.register('#/flashcards/study', loadFlashcardsModule);
    router.register('#/flashcards/game', loadFlashcardsModule);
    router.register('#/timeline', loadTimelineModule);
    router.register('#/timeline/view', loadTimelineModule);
    router.register('#/video', loadVideoModule);
    router.register('#/video/edit', loadVideoModule);
    router.register('#/video/kiosk', loadVideoModule);
    router.register('#/gradebook', loadGradebookModule);
    router.register('#/classes', loadClassesModule);
    router.register('#/course', loadCourseModule);
    router.register('#/calendar', loadCalendarModule);
    router.register('#/assessments', loadAssignmentsModule);
    router.register('#/assessments/edit', loadAssignmentsModule);
    router.register('#/assessments/take', loadAssignmentsModule);
    router.register('#/assessments/submissions', loadAssignmentsModule);
    router.register('#/assignments', loadTasksModule);
    router.register('#/assignments/create', loadTasksModule);
    router.register('#/assignments/edit', loadTasksModule);
    router.register('#/assignments/work', loadTasksModule);
    router.register('#/assignments/take', loadTasksModule);
    router.register('#/assignments/review', loadTasksModule);
    router.register('#/assignments/submissions', loadTasksModule);
    router.register('#/inbox', loadInboxModule);
    router.register('#/report', loadStudentReportModule);
    router.register('#/feedback', loadFeedbackModule);
    router.register('#/guide', loadGuideModule);
    router.register('#/student', loadStudentHubModule);
    router.register('#/student/courses', loadStudentCoursesModule);
    router.register('#/student/course', loadStudentCourseDetailModule);
    router.register('#/student/gradebook', loadStudentGradebookModule);

    // Global drag-and-drop listener for home, assessments, assignments, and student hub (§6.4)
    if (typeof window !== 'undefined') {
      window.addEventListener('dragover', (e) => {
        const hash = window.location.hash || '#/';
        if (hash === '#/' || hash === '#/home' || hash.startsWith('#/assessments') || hash.startsWith('#/assignments') || hash.startsWith('#/student')) {
          if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
          }
        }
      });
      window.addEventListener('drop', (e) => {
        const hash = window.location.hash || '#/';
        if (hash === '#/' || hash === '#/home' || hash === '#/assessments' || hash === '#/assignments') {
          const files = Array.from(e.dataTransfer?.files || []);
          if (files.length > 0) {
            e.preventDefault();
            store.setState('inboxDrop', files);
            router.navigate('#/inbox');
          }
        } else if (hash.startsWith('#/student')) {
          const files = Array.from(e.dataTransfer?.files || []);
          if (files.length > 0) {
            e.preventDefault();
            openIncomingFiles(files, router);
          }
        }
      });
    }

    // 4. Bind Storage / Backup Toolbar Actions & Global Customizations
    bindStorageControls();
    window.addEventListener('kb-request-backup', () => sync.exportManualBackup());
    window.addEventListener('kb-open-backup-location', () => openBackupLocation('setup'));
    window.addEventListener('kb-restore-backup-text', (e) => restoreBackupText(e.detail.text, e.detail.sourceName));
    bindHelpControls();
    initThemeSwitcher();
    updateRelayStatusIndicator();
    window.addEventListener('kb-transport-changed', () => {
      updateRelayStatusIndicator();
    });

    // 5. Initialize Class Selector in Navigation
    const { ClassManager } = await import('./components/class-manager.js');
    const classContainer = document.getElementById('kb-nav-class-selector');
    if (classContainer) {
      ClassManager.renderGlobalNavSelector(classContainer).catch(() => {});
      window.addEventListener('kb-class-filter-changed', () => {
        router.handleRoute();
      });
    }

    // Role Mode Initializer & Switcher
    RoleMode.init();
    const roleToggleBtn = document.getElementById('btn-toggle-role-mode');
    const roleToggleLabel = document.getElementById('label-active-role');
    const syncRoleUI = () => {
      const mode = RoleMode.get();
      if (roleToggleLabel) roleToggleLabel.textContent = mode === 'student' ? 'Student' : 'Teacher';
      if (roleToggleBtn) roleToggleBtn.title = `Currently in ${mode === 'student' ? 'Student' : 'Teacher'} View. Click to switch.`;
    };
    syncRoleUI();

    // Render dynamic data-driven navigation
    const { renderAppNav } = await import('./components/app-nav.js');
    const navContainer = document.getElementById('kb-app-nav');
    renderAppNav(navContainer, RoleMode.get());

    // Skip link keyboard/click accessibility
    document.querySelector('a[href="#app-view-container"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      const main = document.getElementById('app-view-container');
      if (main) {
        main.focus();
        main.scrollIntoView();
      }
    });

    // Header More options proxy clicks (<1024px)
    document.getElementById('kb-header-more-menu')?.addEventListener('sl-select', async (e) => {
      const val = e.detail.item.value;
      if (val === 'guide') {
        router.navigate('#/guide');
      } else if (val === 'safety') {
        const { default: openDataSafetyDialog } = await import('./components/data-safety.js');
        openDataSafetyDialog();
      } else if (val === 'devices') {
        const { default: openDevicesDialog } = await import('./components/devices-dialog.js');
        openDevicesDialog();
      } else if (val === 'relay') {
        openRelayConfigDialog();
      } else if (val === 'backup-export') {
        document.getElementById('menu-btn-export-backup')?.click();
      } else if (val === 'backup-restore') {
        document.getElementById('input-backup-file')?.click();
      }
    });

    window.addEventListener('kb-role-mode-changed', () => {
      syncRoleUI();
      renderAppNav(navContainer, RoleMode.get());
      router.handleRoute();
    });
    roleToggleBtn?.addEventListener('click', () => {
      const next = RoleMode.toggle();
      toast.info(`Switched to ${next === 'student' ? 'Student View' : 'Teacher View'}`);
      if (next === 'student') router.navigate('#/student');
      else router.navigate('#/');
    });
    // 6. Initialize Command Palette (Ctrl+K & ?) and Universal Context Bar
    const { CommandPalette } = await import('./components/command-palette.js');
    CommandPalette.init();
    const { ContextBar } = await import('./components/context-bar.js');
    ContextBar.init();

    // Universal Import Content header buttons & notification handler
    const openUniversalImport = async () => {
      const { UniversalImportDialog } = await import('./components/universal-import-dialog.js');
      UniversalImportDialog.open();
    };
    document.getElementById('btn-header-import-content')?.addEventListener('click', openUniversalImport);
    document.getElementById('btn-header-import-content-mobile')?.addEventListener('click', openUniversalImport);
    window.addEventListener('kb-content-imported', () => {
      router.handleRoute();
    });

    // 7. Register PWA Service Worker and OS file-launch / share-target handlers
    registerServiceWorker();
    await initLaunchHandlers(router);

    // 8. Execute initial route
    await router.handleRoute();

    // 9. Startup coordinator: First-run role chooser & route preloading
    await WelcomeRoleChooser.checkAndShow(router);
    router.preloadPrimaryRoutes(RoleMode.get());

    // 9. Sync unreviewed submissions badge in navigation
    const syncInboxBadge = async () => {
      try {
        if (RoleMode.get() !== 'teacher') {
          const { updateInboxBadge } = await import('./components/app-nav.js');
          updateInboxBadge(0);
          return;
        }
        const [subRows, taskRows] = await Promise.all([
          storage.table('assignment_submissions').getAll().catch(() => []),
          storage.table('task_submissions').getAll().catch(() => [])
        ]);
        const pendingSubs = subRows.filter(s => s.needs_review || (s.auto && !s.manual && s.has_manual_questions)).length;
        const pendingTasks = taskRows.filter(t => !t.review || t.review.status === 'submitted' || t.review.status === 'revised').length;
        const { updateInboxBadge } = await import('./components/app-nav.js');
        updateInboxBadge(pendingSubs + pendingTasks);
      } catch (_) {}
    };
    syncInboxBadge();
    window.addEventListener('hashchange', () => setTimeout(syncInboxBadge, 300));
    window.addEventListener('kb-role-mode-changed', syncInboxBadge);
    window.addEventListener('kb-content-imported', syncInboxBadge);

  } catch (err) {
    console.error('Fatal initialization error:', err);
    if (typeof document !== 'undefined') {
      toast.danger(`Application boot failed: ${err.message}`);
      const container = document.getElementById('app-view-container');
      if (container) {
        container.innerHTML = `
          <div class="p-8 max-w-xl mx-auto text-center space-y-4 bg-white rounded-2xl border border-red-200 shadow-sm mt-8">
            <sl-icon name="exclamation-octagon" class="text-4xl text-red-500"></sl-icon>
            <h2 class="text-xl font-bold text-slate-800">Application Boot Failed</h2>
            <p class="text-sm text-slate-600">${Sanitizer.escapeHTML(err.message)}</p>
            <sl-button variant="primary" id="btn-boot-reload">Reload Application</sl-button>
          </div>
        `;
        container.querySelector('#btn-boot-reload')?.addEventListener('click', () => window.location.reload());
      }
    }
  }
}

function bindStorageControls() {
  const btnConfigureSync = document.getElementById('menu-btn-configure-sync');
  const btnExportBackup = document.getElementById('menu-btn-export-backup');
  const btnImportBackup = document.getElementById('menu-btn-import-backup');
  const btnStorageInfo = document.getElementById('menu-btn-storage-info');
  const fileInput = document.getElementById('input-backup-file');

  btnConfigureSync?.addEventListener('click', () => openBackupLocation('setup'));
  document.getElementById('menu-btn-restore-location')?.addEventListener('click', () => openBackupLocation('restore'));
  document.getElementById('menu-btn-open-data-safety')?.addEventListener('click', async () => {
    const { openDataSafetyDialog } = await import('./components/data-safety.js');
    openDataSafetyDialog();
  });
  document.getElementById('menu-btn-import-content')?.addEventListener('click', async () => {
    const { UniversalImportDialog } = await import('./components/universal-import-dialog.js');
    UniversalImportDialog.open();
  });

  btnExportBackup?.addEventListener('click', async () => {
    await sync.exportManualBackup();
  });

  btnImportBackup?.addEventListener('click', () => {
    fileInput?.click();
  });

  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      await restoreBackupText(await file.text(), file.name);
    } catch (err) {
      console.error('Failed to read backup file:', err);
      toast.danger('Could not read that file.');
    } finally {
      fileInput.value = '';
    }
  });

  document.getElementById('menu-btn-recovery-kit')?.addEventListener('click', async () => {
    const { RecoveryKit } = await import('./components/recovery-kit.js');
    RecoveryKit.open();
  });

  document.getElementById('menu-btn-devices')?.addEventListener('click', async () => {
    const { openDevicesDialog } = await import('./components/devices-dialog.js');
    openDevicesDialog();
  });

  const btnRelayConnect = document.getElementById('menu-btn-relay-connect');
  btnRelayConnect?.addEventListener('click', () => {
    openRelayConfigDialog();
  });

  btnStorageInfo?.addEventListener('click', async () => {
    const quota = await storage.checkStorageQuota();
    const isEphemeral = storage.ephemeralMode;
    const isPersistent = await storage.getMetadata('is_persistent');

    const tables = [
      'gradebook_courses', 'gradebook_students', 'gradebook_assignments',
      'gradebook_grades', 'gradebook_rubrics', 'assignments',
      'assignment_submissions', 'tasks', 'task_submissions', 'flashcards', 'timelines', 'video_assessments',
      'course_units', 'course_items', 'student_courses', 'student_ledger', 'calendar_events', 'lesson_plans'
    ];
    const tableCounts = {};
    for (const t of tables) {
      try {
        tableCounts[t] = await storage.table(t).count();
      } catch (e) {
        tableCounts[t] = 0;
      }
    }

    const msg = `
      <div class="space-y-3 text-sm">
        <div>
          <p><strong>Storage Mode:</strong> ${isEphemeral ? '<span class="text-amber-600 font-semibold">Ephemeral (Private Browsing)</span>' : '<span class="text-emerald-600 font-semibold">Persistent IndexedDB</span>'}</p>
          <p><strong>Durable Storage Granted:</strong> ${isPersistent ? 'Yes' : 'Browser Default'}</p>
          ${quota ? `<p><strong>Storage Usage:</strong> ${quota.usageMB} MB / ${quota.quotaMB} MB (${Math.round(quota.ratio * 100)}%)</p>` : ''}
        </div>
        <div class="pt-2 border-t border-slate-200">
          <p class="font-semibold text-xs text-slate-700 uppercase tracking-wider mb-2">Stored Record Counts</p>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
            ${tables.map(t => `<div class="flex justify-between py-0.5 border-b border-slate-100"><span class="font-mono">${t}</span><span class="font-bold text-slate-800">${tableCounts[t] ?? 0}</span></div>`).join('')}
          </div>
        </div>
      </div>
    `;

    const dialog = document.createElement('sl-dialog');
    dialog.label = 'Local Storage Status & Record Counts';
    dialog.innerHTML = `
      ${msg}
      <sl-button slot="footer" variant="primary" id="btn-close-storage-info">Close</sl-button>
    `;
    document.body.appendChild(dialog);
    dialog.show();

    dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
    dialog.querySelector('#btn-close-storage-info')?.addEventListener('click', () => dialog.hide());
  });
}

// Relay requests blocked by the Content Security Policy surface as a generic network TypeError.
let lastCspViolation = null;
if (typeof document !== 'undefined') {
  document.addEventListener('securitypolicyviolation', (e) => {
    if (e.effectiveDirective === 'connect-src') lastCspViolation = { uri: e.blockedURI, at: Date.now() };
  });
}

function describeRelayError(err, baseUrl) {
  let origin = '';
  try { origin = new URL(baseUrl).origin; } catch (_) {}
  const blocked = lastCspViolation && Date.now() - lastCspViolation.at < 5000 && origin && String(lastCspViolation.uri).startsWith(origin);
  if (blocked) {
    return `${origin} is not on this installation's allow-list (Content Security Policy connect-src). Ask whoever hosts KennisBoost to add it (KB_RELAY_ORIGIN for the bundled server, or the CSP meta tag / _headers on static hosting).`;
  }
  return err?.message || 'Unknown error';
}

const RESTORE_LABELS = {
  flashcards: 'Flashcard decks', timelines: 'Timelines', video_assessments: 'Video lessons',
  gradebook_courses: 'Classes', gradebook_students: 'Students', gradebook_assignments: 'Gradebook assignments',
  gradebook_grades: 'Grades', gradebook_rubrics: 'Rubrics', assignments: 'Assessments',
  assignment_submissions: 'Assessment submissions', tasks: 'Assignments / Tasks', task_submissions: 'Task submissions',
  course_units: 'Course units', course_items: 'Course items', student_courses: 'Enrolled student courses',
  student_ledger: 'Student grades ledger', calendar_events: 'Calendar events', lesson_plans: 'Lesson plans',
  media: 'Images & audio clips'
};

/**
 * Restoring replaces everything on this device, so show what the file contains first.
 * @returns {Promise<false | { safetyCopy: boolean }>}
 */
async function openBackupLocation(mode) {
  const { openBackupLocationDialog } = await import('./components/backup-location-dialog.js');
  await openBackupLocationDialog({ mode, restoreFromText: restoreBackupText });
}

/**
 * Decrypt (asking for the recovery code if needed), confirm and restore a backup.
 * Resolves true when this browser's data was replaced.
 */
async function restoreBackupText(text, sourceName) {
  try {
    const opened = await openBackupWithRecoveryCode(text);
    if (!opened) return false;
    const plaintext = !opened.encrypted && opened.hasPlaintextSecrets;
    const confirmed = await confirmRestore(sourceName, opened.counts, opened.exportedAt, { plaintext });
    if (!confirmed) return false;
    if (confirmed.safetyCopy) await sync.exportManualBackup();
    await sync.restoreOpenedBackup(opened);
    toast.success('Backup restored successfully! Refreshing view...');
    if (plaintext) {
      toast.warning('That backup file was not encrypted. Delete it once you have made a new, encrypted backup.', 12000);
    }
    await router.handleRoute();
    return true;
  } catch (err) {
    console.error('Failed to restore backup:', err);
    toast.danger(err?.name === 'BackupError' || err?.name === 'VaultError'
      ? `Restore aborted: ${err.message}`
      : 'Invalid backup file. Restore aborted.');
    return false;
  }
}

/**
 * Decrypt/validate a backup, asking for the recovery code when this device can't open it.
 * Resolves null if the teacher cancels.
 */
async function openBackupWithRecoveryCode(text) {
  try {
    return await sync.openBackupFile(text);
  } catch (err) {
    if (err?.code !== 'NEEDS_RECOVERY_CODE') throw err;
  }
  let escrowAvailable = false;
  try {
    escrowAvailable = Boolean(JSON.parse(text).escrow?.envelope);
  } catch (_) {}
  let error = '';
  for (;;) {
    const code = await promptRecoveryCode(error, { escrowAvailable });
    if (!code) return null;
    if (code.useEscrow) return openWithEscrow(text);
    try {
      return await sync.openBackupFile(text, { recoveryCode: code });
    } catch (err) {
      if (err?.code !== 'WRONG_CODE' && err?.code !== 'BAD_CODE') throw err;
      error = err.message;
    }
  }
}

/** School-assisted recovery: an unlock code from IT plus the teacher's own passphrase */
async function openWithEscrow(text) {
  let error = '';
  for (;;) {
    const input = await promptEscrow(error);
    if (!input) return null;
    try {
      return await sync.openBackupFile(text, { escrow: input });
    } catch (err) {
      if (!['WRONG_PASSPHRASE', 'BAD_UNLOCK_CODE', 'WRONG_CODE'].includes(err?.code)) throw err;
      error = err.message;
    }
  }
}

function promptEscrow(error = '') {
  return new Promise((resolve) => {
    const dialog = document.createElement('sl-dialog');
    dialog.label = 'School-assisted recovery';
    dialog.innerHTML = `
      <div class="space-y-3 text-sm">
        <p class="text-slate-700">Send this backup file to your IT department and ask for an <strong>unlock code</strong>. Then enter it here with the passphrase you chose for school-assisted recovery.</p>
        <sl-textarea id="esc-code" rows="3" label="Unlock code from IT" placeholder="KBESC1.…" class="font-mono"></sl-textarea>
        <sl-input id="esc-pass" type="password" password-toggle label="Your passphrase" autocomplete="current-password"></sl-input>
        ${error ? `<p class="text-xs text-rose-700">${Sanitizer.escapeHTML(error)}</p>` : ''}
      </div>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button id="esc-cancel">Cancel</sl-button>
        <sl-button variant="primary" id="esc-open">Open backup</sl-button>
      </div>`;
    let result = null;
    dialog.querySelector('#esc-open').addEventListener('click', () => {
      result = { unlockCode: dialog.querySelector('#esc-code').value.trim(), passphrase: dialog.querySelector('#esc-pass').value };
      dialog.hide();
    });
    dialog.querySelector('#esc-cancel').addEventListener('click', () => dialog.hide());
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target !== dialog) return;
      dialog.remove();
      resolve(result);
    });
    document.body.appendChild(dialog);
    dialog.show();
  });
}

function promptRecoveryCode(error = '', { escrowAvailable = false } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('sl-dialog');
    dialog.label = 'Enter your recovery code';
    dialog.innerHTML = `
      <form class="space-y-3 text-sm" id="rc-form">
        <p class="text-slate-700">This backup was made on another device (or before your recovery code changed). Type the code from your recovery kit to open it.</p>
        <sl-input id="rc-input" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX" class="font-mono"></sl-input>
        ${error ? `<p class="text-xs text-rose-700">${Sanitizer.escapeHTML(error)}</p>` : ''}
      </form>
      <div slot="footer" class="flex flex-wrap justify-end gap-2">
        ${escrowAvailable ? '<sl-button variant="text" id="rc-escrow">Lost your recovery code?</sl-button>' : ''}
        <sl-button id="rc-cancel">Cancel</sl-button>
        <sl-button variant="primary" id="rc-open">Open backup</sl-button>
      </div>`;
    let result = null;
    dialog.querySelector('#rc-escrow')?.addEventListener('click', () => {
      result = { useEscrow: true };
      dialog.hide();
    });
    const submit = () => {
      result = dialog.querySelector('#rc-input').value.trim() || null;
      dialog.hide();
    };
    dialog.querySelector('#rc-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    dialog.querySelector('#rc-open').addEventListener('click', submit);
    dialog.querySelector('#rc-cancel').addEventListener('click', () => dialog.hide());
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target !== dialog) return;
      dialog.remove();
      resolve(result);
    });
    document.body.appendChild(dialog);
    dialog.show();
  });
}

function confirmRestore(fileName, counts, exportedAt, { plaintext = false } = {}) {
  return new Promise((resolve) => {
    const esc = (v) => Sanitizer.escapeHTML(v);
    const when = exportedAt && !Number.isNaN(Date.parse(exportedAt)) ? new Date(exportedAt).toLocaleString() : 'unknown date';
    const rows = Object.entries(counts).filter(([, n]) => n > 0)
      .map(([t, n]) => `<li class="flex justify-between py-0.5 border-b border-slate-100"><span>${esc(RESTORE_LABELS[t] || t)}</span><strong>${esc(n)}</strong></li>`).join('');
    const dialog = document.createElement('sl-dialog');
    dialog.label = 'Restore backup?';
    dialog.innerHTML = `
      <div class="space-y-3 text-sm">
        <p><strong>${esc(fileName)}</strong> &mdash; exported ${esc(when)}</p>
        <ul class="text-xs text-slate-600">${rows || '<li>No records</li>'}</ul>
        <p class="text-rose-700 font-medium">Everything currently stored in this browser will be replaced.</p>
        ${plaintext ? '<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">This is an older, unencrypted backup: it contains your submission key and student access codes in plain text. After restoring, make a new backup and delete this file.</p>' : ''}
        <sl-checkbox id="restore-safety-copy" checked>Download a backup of my current data first</sl-checkbox>
      </div>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button id="restore-cancel">Cancel</sl-button>
        <sl-button variant="danger" id="restore-confirm">Replace my data</sl-button>
      </div>`;
    let result = false;
    dialog.querySelector('#restore-cancel').addEventListener('click', () => dialog.hide());
    dialog.querySelector('#restore-confirm').addEventListener('click', () => {
      result = { safetyCopy: !!dialog.querySelector('#restore-safety-copy')?.checked };
      dialog.hide();
    });
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target !== dialog) return;
      dialog.remove();
      resolve(result);
    });
    document.body.appendChild(dialog);
    dialog.show();
  });
}

export async function openRelayConfigDialog(defaultTab = 'connect') {
  const currentConfig = (await storage.getMetadata('sync_config')) || (typeof window !== 'undefined' ? window.KB_CONFIG : null) || {};
  const { renderRelaySetupGuideHTML } = await import('./components/relay-setup-guide.js');
  const dialog = document.createElement('sl-dialog');
  dialog.label = 'School Sync & Relay Server';
  dialog.style.setProperty('--width', '680px');
  dialog.innerHTML = `
    <sl-tab-group id="relay-tabs">
      <sl-tab slot="nav" panel="tab-connect" ${defaultTab === 'connect' ? 'active' : ''}>Connect to Server</sl-tab>
      <sl-tab slot="nav" panel="tab-guide" ${defaultTab === 'guide' ? 'active' : ''}>Setup & Deployment Guide</sl-tab>

      <sl-tab-panel name="tab-connect" class="pt-3">
        <div class="space-y-4 text-sm">
          <p class="text-xs text-slate-500 leading-relaxed">
            Connecting to a school-hosted KennisBoost relay server unlocks short links, cross-device multi-teacher sync, and server-assisted student hand-in. All lesson payloads and student submissions remain end-to-end encrypted.
          </p>
          <sl-input id="input-relay-paste-link" label="Paste 1-Click Onboarding Link (optional)" placeholder="Paste #/connect?relay=...&token=... link to auto-fill"></sl-input>
          <sl-input id="input-relay-url" label="Server Base URL" placeholder="https://relay.myschool.edu or http://localhost:8000" value="${Sanitizer.escapeHTML(currentConfig.baseUrl)}"></sl-input>
          <sl-input id="input-relay-token" type="password" password-toggle label="Teacher Bearer Token" placeholder="Paste 64-character token" value="${Sanitizer.escapeHTML(currentConfig.token)}"></sl-input>
          <sl-input id="input-relay-teacher-id" label="Teacher ID (optional)" placeholder="e.g. T-101" value="${Sanitizer.escapeHTML(currentConfig.teacherId)}"></sl-input>

          <div id="relay-test-result" class="hidden p-3 rounded-xl text-xs space-y-1"></div>
        </div>
      </sl-tab-panel>

      <sl-tab-panel name="tab-guide" class="pt-3">
        ${renderRelaySetupGuideHTML()}
      </sl-tab-panel>
    </sl-tab-group>

    <div slot="footer" class="flex flex-wrap justify-between items-center gap-2">
      ${currentConfig.baseUrl ? `<sl-button variant="danger" size="small" id="btn-relay-disconnect">Disconnect</sl-button>` : `<span></span>`}
      <div class="flex gap-2">
        <sl-button size="small" id="btn-relay-test">Test connection</sl-button>
        <sl-button variant="primary" size="small" id="btn-relay-save">Save</sl-button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.addEventListener('sl-after-hide', (e) => {
    if (e.target === dialog) dialog.remove();
  });

  const pasteLinkInput = dialog.querySelector('#input-relay-paste-link');
  const urlInput = dialog.querySelector('#input-relay-url');
  const tokenInput = dialog.querySelector('#input-relay-token');
  const idInput = dialog.querySelector('#input-relay-teacher-id');
  const testResult = dialog.querySelector('#relay-test-result');

  pasteLinkInput?.addEventListener('sl-input', () => {
    const val = (pasteLinkInput.value || '').trim();
    if (val.includes('relay=') && val.includes('token=')) {
      try {
        const queryPart = val.includes('?') ? val.split('?')[1] : val;
        const search = new URLSearchParams(queryPart);
        if (search.get('relay')) urlInput.value = search.get('relay');
        if (search.get('token')) tokenInput.value = search.get('token');
        if (search.get('id') || search.get('teacherId')) idInput.value = search.get('id') || search.get('teacherId');
        toast.info('Auto-filled server credentials from onboarding link!');
      } catch (_) {}
    }
  });

  dialog.querySelector('#btn-relay-test')?.addEventListener('click', async () => {
    const btn = dialog.querySelector('#btn-relay-test');
    btn.loading = true;
    testResult.classList.add('hidden');
    try {
      const baseUrl = urlInput.value.trim();
      const token = tokenInput.value.trim();
      if (!baseUrl) throw new Error('Please enter a server base URL');
      const tempRelay = new RelayTransport({ baseUrl, token });
      const health = await tempRelay.health();
      if (!health.ok) throw new Error(health.error || 'Server health check failed');
      testResult.className = 'p-3 rounded-xl text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 space-y-1';
      testResult.innerHTML = `
        <div class="font-semibold flex items-center gap-1.5"><sl-icon name="check-circle-fill" class="text-emerald-600"></sl-icon> Server online! (v${Sanitizer.escapeHTML(health.serverVersion || '1.0.0')})</div>
        <div class="text-[11px] text-emerald-700">Supported features: ${Sanitizer.escapeHTML((Array.isArray(health.features) ? health.features : ['payloads', 'drops']).join(', '))}</div>
      `;
      testResult.classList.remove('hidden');
    } catch (err) {
      testResult.className = 'p-3 rounded-xl text-xs bg-rose-50 border border-rose-200 text-rose-800';
      testResult.innerHTML = `<div class="font-semibold flex items-center gap-1.5"><sl-icon name="exclamation-octagon-fill" class="text-rose-600"></sl-icon> Connection error</div><div class="text-[11px] text-rose-700">${Sanitizer.escapeHTML(describeRelayError(err, urlInput.value.trim()))}</div>`;
      testResult.classList.remove('hidden');
    } finally {
      btn.loading = false;
    }
  });

  dialog.querySelector('#btn-relay-save')?.addEventListener('click', async () => {
    const baseUrl = urlInput.value.trim();
    const token = tokenInput.value.trim();
    const teacherId = idInput.value.trim();
    if (!baseUrl) {
      toast.danger('Base URL is required.');
      return;
    }
    if (!token) {
      toast.danger('Teacher Bearer Token is required.');
      return;
    }
    await setTransportConfig({ baseUrl, token, teacherId });
    toast.success('School server connected successfully!');
    dialog.hide();
    updateRelayStatusIndicator();
  });

  dialog.querySelector('#btn-relay-disconnect')?.addEventListener('click', async () => {
    await setTransportConfig(null);
    toast.info('Disconnected from school server.');
    dialog.hide();
    updateRelayStatusIndicator();
  });

  dialog.addEventListener('sl-after-hide', (e) => {
    if (e.target !== dialog) return;
    dialog.remove();
  });
}

export async function updateRelayStatusIndicator() {
  if (typeof document === 'undefined') return;
  const indicator = document.getElementById('sync-status-indicator');
  if (!indicator) return;
  try {
    const transport = await getTransport();
    if (transport && transport.capabilities.hostPayload) {
      indicator.innerHTML = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-medium border border-emerald-200" title="Connected to school relay server"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>Server: connected</span>`;
      return;
    }
  } catch {}
  if (indicator.textContent.includes('Server:')) {
    indicator.innerHTML = '';
  }
}

function bindHelpControls() {
  const helpMenu = document.getElementById('kb-help-menu');
  const installPwaItem = document.getElementById('kb-menu-install-pwa');

  const updatePwaInstallVisibility = (canInstall) => {
    if (installPwaItem) {
      if (canInstall) installPwaItem.classList.remove('hidden');
      else installPwaItem.classList.add('hidden');
    }
  };

  updatePwaInstallVisibility(canInstallPwa());
  window.addEventListener('kb-pwa-installable', (e) => {
    updatePwaInstallVisibility(Boolean(e.detail));
  });

  const handleHelpSelection = async (val) => {
    if (val === 'guide') {
      router.navigate('#/guide');
    } else if (val === 'about') {
      router.navigate('#/about');
    } else if (val === 'philosophy') {
      router.navigate('#/philosophy');
    } else if (val === 'install-pwa') {
      await promptPwaInstall();
    } else if (val === 'shortcuts') {
      document.getElementById('menu-btn-keyboard-shortcuts')?.click();
    } else if (val === 'load-sample') {
      const { loadDemoWorkspace } = await import('./core/demo.js');
      await loadDemoWorkspace();
      toast.success('Sample workspace loaded!');
      router.handleRoute();
    } else if (val === 'remove-sample') {
      const { removeDemoData } = await import('./core/demo.js');
      await removeDemoData();
      toast.info('Sample data removed.');
      router.handleRoute();
    }
  };

  helpMenu?.addEventListener('sl-select', (e) => handleHelpSelection(e.detail.item.value));
}

const THEME_ICONS = { light: 'sun', dark: 'moon-stars', system: 'circle-half', projector: 'projector' };
const THEME_LABELS = { light: 'Light', dark: 'Dark', system: 'System', projector: 'Projector' };

function initThemeSwitcher() {
  const themeMenu = document.getElementById('kb-theme-menu');
  const themeIcon = document.getElementById('icon-active-theme');
  const html = document.documentElement;
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)');
  let current = 'system';

  const applyTheme = (theme) => {
    current = THEME_ICONS[theme] ? theme : 'system';
    const isDark = current === 'dark' || (current === 'system' && !!systemDark?.matches);
    html.classList.remove('sl-theme-light', 'sl-theme-dark', 'kb-theme-projector');
    html.classList.add(isDark ? 'sl-theme-dark' : 'sl-theme-light');
    if (current === 'projector') html.classList.add('kb-theme-projector');

    if (themeIcon) themeIcon.name = THEME_ICONS[current];
    themeMenu?.querySelectorAll('sl-menu-item').forEach(item => {
      item.checked = item.value === current;
    });
    window.dispatchEvent(new CustomEvent('kb-theme-changed', { detail: { theme: current, isDark } }));

    try {
      localStorage.setItem('kb_theme_mode', current);
    } catch (e) {}
  };

  let savedTheme = 'system';
  try {
    savedTheme = localStorage.getItem('kb_theme_mode') || 'system';
  } catch (e) {}
  applyTheme(savedTheme);

  systemDark?.addEventListener?.('change', () => {
    if (current === 'system') applyTheme('system');
  });

  const onThemeSelect = (selected) => {
    const themeKey = selected.replace(/^theme-/, '');
    if (THEME_ICONS[themeKey]) {
      applyTheme(themeKey);
      toast.info(`Theme: ${THEME_LABELS[themeKey]}`);
    }
  };

  themeMenu?.addEventListener('sl-select', (e) => onThemeSelect(e.detail.item.value));
}

// Bootstrap when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}
