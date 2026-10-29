import { storage } from '../core/storage.js';
import { sync } from '../core/sync.js';
import { KeyVault, MIN_ESCROW_PASSPHRASE } from '../core/keyvault.js';
import { getManagedConfig, getPolicy } from '../core/managed-config.js';
import { Sanitizer } from '../core/sanitizer.js';
import { toast } from '../utils/toast.js';
import { modal } from './code-exchange.js';

const esc = (v) => Sanitizer.escapeHTML(v);
const HOUR = 3600 * 1000;

/**
 * One status for everything that keeps a teacher's data safe. Pure, so it can be tested.
 * @returns {{ level: 'ok'|'attention'|'risk', items: Array<{ id, ok, severity, title, detail, action? }> }}
 */
export function computeDataSafety(s, now = Date.now()) {
  const policy = s.policy;
  const items = [];
  const add = (id, ok, severity, title, detail, action = null) => items.push({ id, ok, severity: ok ? 'ok' : severity, title, detail, action });

  if (s.ephemeral) {
    add('storage-mode', false, 'risk', 'Private or guest window', 'Everything is deleted when this window closes. Open KennisBoost in a normal browser profile.');
  }

  const age = s.lastBackupAt ? now - s.lastBackupAt : null;
  const stale = age !== null && age > policy.backupReminderHours * HOUR;
  if (!s.lastBackupAt) {
    // Nothing to lose yet on a fresh install: a nudge, not an alarm
    add('backup', false, s.hasData === false ? 'attention' : 'risk', 'No backup yet', 'If this device is lost or reset, your classes and grades are gone.', s.canAutoBackup ? { id: 'location', label: 'Choose backup location' } : { id: 'export', label: 'Export backup' });
  } else if (!s.hasAutomaticBackup) {
    add('backup', false, policy.requireAutomaticBackup ? 'risk' : 'attention',
      policy.requireAutomaticBackup ? 'Automatic backup required by your school' : 'Backups are manual',
      `Last backup ${new Date(s.lastBackupAt).toLocaleString()}.`,
      s.canAutoBackup ? { id: 'location', label: 'Turn on automatic backup' } : { id: 'export', label: 'Export backup' });
  } else if (stale) {
    add('backup', false, 'attention', 'Backups have stopped', `Last backup to ${s.backupLabel} was ${new Date(s.lastBackupAt).toLocaleString()}.`, { id: 'location', label: 'Check backup location' });
  } else {
    add('backup', true, 'ok', 'Automatic encrypted backup', `To ${s.backupLabel}, last ${new Date(s.lastBackupAt).toLocaleString()}.`);
  }

  add('kit', s.recoveryKitSaved, 'attention', s.recoveryKitSaved ? 'Recovery kit saved' : 'Recovery kit not saved',
    s.recoveryKitSaved ? 'You can restore backups on any device.' : 'Without it, backups only open on this device.',
    s.recoveryKitSaved ? null : { id: 'kit', label: 'Save recovery kit' });

  if (!s.ephemeral) {
    add('persist', s.persistent, 'attention', s.persistent ? 'Protected from automatic clean-up' : 'Browser may clear data when space runs low',
      s.persistent ? 'The browser will not delete KennisBoost data on its own.' : 'Ask the browser to keep KennisBoost data (or ask IT to allow it for this site).',
      s.persistent ? null : { id: 'persist', label: 'Keep my data' });
  }

  if (s.quotaRatio !== null && s.quotaRatio > 0.8) {
    add('space', false, s.quotaRatio > 0.9 ? 'risk' : 'attention', 'Storage almost full', `${Math.round(s.quotaRatio * 100)}% of this browser's storage is used.`, { id: 'export', label: 'Export backup' });
  }

  if (s.sync.configured) {
    add('sync', s.sync.state !== 'error', 'attention', s.sync.state === 'error' ? 'Sync between devices has a problem' : 'Devices in sync',
      s.sync.state === 'error' ? s.sync.error : (s.sync.lastSyncAt ? `Last sync ${new Date(s.sync.lastSyncAt).toLocaleString()}.` : 'Waiting for the first sync.'),
      { id: 'devices', label: 'Devices & sharing' });
  }

  if (s.escrow.available) {
    const ok = s.escrow.current;
    add('escrow', ok, 'attention',
      ok ? 'School-assisted recovery set up' : s.escrow.registered ? 'School-assisted recovery needs your passphrase again' : 'School-assisted recovery not set up',
      ok ? `If you lose your recovery kit, ${s.escrow.label} can help you restore with your passphrase.` : `Lets ${s.escrow.label} help you restore if you lose your recovery kit. They can never open your data alone.`,
      ok ? null : { id: 'escrow', label: 'Set up' });
  }

  if (s.configError) {
    add('config', false, 'attention', 'School settings were not applied', `Tell your IT department: ${s.configError}`);
  }

  const level = items.some(i => i.severity === 'risk') ? 'risk' : items.some(i => i.severity === 'attention') ? 'attention' : 'ok';
  return { level, items };
}

async function hasOwnData() {
  for (const t of ['gradebook_courses', 'assignments', 'flashcards', 'timelines', 'video_assessments']) {
    if ((await storage.table(t).toArray()).some(r => !r.is_demo)) return true;
  }
  return false;
}

/** Collect the inputs for computeDataSafety from the running app */
export async function gatherDataSafety() {
  const { replication } = await import('../core/replication/manager.js');
  const cfg = getManagedConfig();
  const adapter = sync.activeAdapter();
  let quotaRatio = null;
  let persistent = Boolean(await storage.getMetadata('is_persistent'));
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) quotaRatio = est.usage / est.quota;
    if (navigator.storage?.persisted) persistent = await navigator.storage.persisted();
  } catch (_) {}
  const adminKey = cfg.config.escrow?.adminPublicKey || null;
  const escrow = adminKey ? await KeyVault.escrowStatus(storage, adminKey) : { registered: false, current: false };
  const ws = await replication.workspace().catch(() => null);
  return {
    policy: getPolicy(),
    ephemeral: Boolean(storage.ephemeralMode),
    lastBackupAt: Number(await storage.getMetadata('last_manual_export_timestamp')) || null,
    hasAutomaticBackup: sync.hasAutomaticBackup(),
    backupLabel: adapter?.label || 'your backup file',
    canAutoBackup: typeof window !== 'undefined' && ('showDirectoryPicker' in window || Boolean(cfg.config.cloud?.google || cfg.config.cloud?.microsoft)),
    recoveryKitSaved: (await KeyVault.status(storage)).recoveryKitSaved,
    hasData: await hasOwnData(),
    persistent,
    quotaRatio,
    sync: { configured: Boolean(ws && ws.channel?.type !== 'none') || replication.status.channels?.length > 0, ...replication.status },
    escrow: { available: Boolean(adminKey), label: cfg.config.escrow?.label || 'your IT department', ...escrow },
    configError: cfg.error
  };
}

const LEVELS = {
  ok: { label: 'Data safe', icon: 'shield-check', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  attention: { label: 'Check data safety', icon: 'shield-exclamation', cls: 'text-amber-800 bg-amber-50 border-amber-300' },
  risk: { label: 'Data at risk', icon: 'shield-x', cls: 'text-red-800 bg-red-50 border-red-300' }
};

/** Refresh the header chip */
export async function updateDataSafetyChip() {
  const chip = document.getElementById('kb-data-safety-chip');
  if (!chip) return null;
  const state = computeDataSafety(await gatherDataSafety());
  const l = LEVELS[state.level];
  chip.dataset.safetyLevel = state.level;
  const parentPill = chip.closest('.kb-data-sync-pill');
  if (parentPill) {
    parentPill.dataset.safetyLevel = state.level;
    chip.className = 'inline-flex items-center gap-1.5 text-xs font-medium';
  } else {
    chip.className = `kb-safety-chip inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 ${l.cls}`;
  }
  const iconColor = state.level === 'ok' ? 'text-emerald-600' : state.level === 'attention' ? 'text-amber-500' : 'text-rose-600';
  chip.innerHTML = `<sl-icon name="${l.icon}" class="${iconColor}"></sl-icon><span class="hidden md:inline">${esc(l.label)}</span>`;
  chip.title = l.label;
  chip.setAttribute('aria-label', `${l.label}. Open data safety details.`);
  return state;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function setUpEscrow() {
  const cfg = getManagedConfig().config.escrow;
  const r = await modal('School-assisted recovery', `
    <div class="space-y-3 text-sm">
      <p class="text-slate-700">If you ever lose your recovery kit, ${esc(cfg.label || 'your IT department')} can give you an unlock code for a backup. Together with this passphrase, it opens the backup.</p>
      <p class="text-xs text-slate-500">Your school can't open your backups with its key alone: it also needs this passphrase, which only you know. Choose something long that you will remember (at least ${MIN_ESCROW_PASSPHRASE} characters), for example a short sentence.</p>
      <sl-input id="es-pass" type="password" password-toggle label="Passphrase" autocomplete="new-password"></sl-input>
      <sl-input id="es-pass2" type="password" password-toggle label="Repeat passphrase" autocomplete="new-password"></sl-input>
    </div>`, [{ value: 'cancel', label: 'Cancel' }, { value: 'save', label: 'Save', variant: 'primary' }]);
  if (r?.value !== 'save') return;
  const a = r.dialog.querySelector('#es-pass').value;
  const b = r.dialog.querySelector('#es-pass2').value;
  if (a !== b) {
    toast.warning('The passphrases do not match.');
    return;
  }
  try {
    await KeyVault.setUpEscrow(storage, cfg.adminPublicKey, a);
    toast.success('School-assisted recovery is set up. New backups include it.');
    sync.triggerDebouncedSync();
  } catch (err) {
    toast.warning(err.message);
  }
}

async function loadTables() {
  const names = ['gradebook_courses', 'gradebook_students', 'gradebook_assignments', 'gradebook_grades', 'assignments', 'assignment_submissions'];
  const data = {};
  for (const n of names) data[n] = await storage.table(n).toArray();
  return data;
}

export async function openRecordsRequest() {
  const data = await loadTables();
  const courses = data.gradebook_courses.filter(c => !c.is_demo);
  const r = await modal('Student records request', `
    <div class="space-y-3 text-sm">
      <p class="text-slate-700">Export everything KennisBoost holds about a student (FERPA inspection, GDPR access or portability request): grades, feedback, handed-in work and class enrolments, as JSON, CSV and PDF.</p>
      <sl-select id="rr-course" label="Class" value="__all">
        <sl-option value="__all">All classes</sl-option>
        ${courses.map(c => `<sl-option value="${esc(c.id)}">${esc(c.name)}${c.section ? ` · ${esc(c.section)}` : ''}</sl-option>`).join('')}
      </sl-select>
      <sl-input id="rr-student" label="Student ID" placeholder="Leave empty for every student in the class"></sl-input>
      <sl-checkbox id="rr-pdf" checked>Include PDF grade reports</sl-checkbox>
      <p class="text-xs text-slate-500">The export contains personal data. Send it only to the requester, through your school's approved channel.</p>
    </div>`, [{ value: 'cancel', label: 'Cancel' }, { value: 'export', label: 'Export', variant: 'primary' }]);
  if (r?.value !== 'export') return;
  const courseId = r.dialog.querySelector('#rr-course').value;
  const courseIds = courseId === '__all' ? null : [courseId];
  const wanted = r.dialog.querySelector('#rr-student').value.trim();
  const { buildStudentRecord, studentIdsIn, buildRecordsZip } = await import('../core/records-export.js');
  const ids = wanted ? [wanted] : studentIdsIn(data, courseIds);
  const records = ids.map(id => buildStudentRecord(data, id, { courseIds })).filter(rec => rec.student.classes.length);
  if (!records.length) {
    toast.warning(wanted ? `No student with ID ${wanted} in that selection.` : 'No students in that selection.');
    return;
  }
  const JSZip = (await import('jszip')).default;
  let pdfFor = null;
  if (r.dialog.querySelector('#rr-pdf').checked) {
    const { GradebookReportGenerator } = await import('../modules/gradebook/report-generator.js');
    const gradesMap = new Map(data.gradebook_grades.map(g => [`${g.student_id}+${g.assignment_id}`, g]));
    pdfFor = async (rec) => rec.student.classes.map(c => {
      const course = data.gradebook_courses.find(x => x.id === c.course_id);
      const student = data.gradebook_students.find(s => s.course_id === c.course_id && String(s.student_id).toUpperCase() === String(rec.student.student_id).toUpperCase());
      if (!course || !student) return null;
      const doc = GradebookReportGenerator.generateStudentPDF(student, course, data.gradebook_assignments.filter(a => a.course_id === course.id), gradesMap);
      return { name: `report-${String(course.name || course.id).replace(/[^A-Za-z0-9_.-]+/g, '_')}.pdf`, blob: doc.output('arraybuffer') };
    }).filter(Boolean);
  }
  const blob = await buildRecordsZip(records, { JSZip, pdfFor, school: getManagedConfig().config.school?.name || '' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `student-records-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
  toast.success(`Exported records for ${records.length} student${records.length === 1 ? '' : 's'}.`);
}

export async function openTermArchive() {
  const cfg = getManagedConfig().config;
  const schoolKey = cfg.escrow?.archivesReadableBySchool ? cfg.escrow.adminPublicKey : null;
  const r = await modal('Archive this term', `
    <div class="space-y-3 text-sm">
      <p class="text-slate-700">Files an encrypted copy of all your classes, grades and hand-ins, for your school's records. Save it where your school asks (for example a records folder on the school drive).</p>
      <sl-input id="ta-label" label="Name" value="${esc(`${new Date().getFullYear()} term`)}"></sl-input>
      ${schoolKey
        ? `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">Your school has asked that term archives can be opened by ${esc(cfg.escrow.label || 'IT')}. This archive will be readable by them, so they can keep records after you leave. Your everyday backups are not affected.</p>`
        : '<p class="text-xs text-slate-500">Only you (with your recovery code) can open this archive.</p>'}
    </div>`, [{ value: 'cancel', label: 'Cancel' }, { value: 'save', label: 'Create archive', variant: 'primary' }]);
  if (r?.value !== 'save') return;
  const { createTermArchive } = await import('../core/records-archive.js');
  const archive = await createTermArchive(storage, { label: r.dialog.querySelector('#ta-label').value.trim() || 'term', schoolPublicJwk: schoolKey });
  try {
    if ('showSaveFilePicker' in window) {
      const handle = await window.showSaveFilePicker({ suggestedName: archive.filename, types: [{ description: 'KennisBoost archive', accept: { 'application/json': ['.json'] } }] });
      const w = await handle.createWritable();
      await w.write(archive.text);
      await w.close();
    } else {
      const { downloadText } = await import('./send-sheet.js');
      downloadText(archive.text, archive.filename);
    }
    toast.success('Term archive saved.');
  } catch (err) {
    if (err?.name !== 'AbortError') toast.danger('Could not save the archive.');
  }
}

async function runAction(id) {
  switch (id) {
    case 'location': window.dispatchEvent(new CustomEvent('kb-open-backup-location')); break;
    case 'export': window.dispatchEvent(new CustomEvent('kb-request-backup')); break;
    case 'kit': (await import('./recovery-kit.js')).RecoveryKit.open(); break;
    case 'devices': (await import('./devices-dialog.js')).openDevicesDialog(); break;
    case 'escrow': await setUpEscrow(); break;
    case 'records': await openRecordsRequest(); break;
    case 'archive': await openTermArchive(); break;
    case 'persist': {
      const granted = await navigator.storage?.persist?.().catch(() => false);
      await storage.setMetadata('is_persistent', Boolean(granted));
      if (granted) toast.success('The browser will keep your data.');
      else toast.warning('The browser declined. Installing KennisBoost as an app usually helps; IT can also allow it for this site.');
      break;
    }
    default: break;
  }
  updateDataSafetyChip();
}

export async function openDataSafetyDialog() {
  const state = computeDataSafety(await gatherDataSafety());
  const icon = { ok: 'check-circle-fill text-emerald-600', attention: 'exclamation-circle-fill text-amber-500', risk: 'x-circle-fill text-red-600' };
  const r = await modal('Data safety', `
    <div class="space-y-2 text-sm">
      ${state.items.map(i => `
        <div class="flex items-start gap-3 border border-slate-200 rounded-xl p-3">
          <sl-icon name="${icon[i.severity].split(' ')[0]}" class="${icon[i.severity].split(' ')[1]} text-lg flex-shrink-0 mt-0.5"></sl-icon>
          <div class="flex-1 min-w-0"><div class="font-medium text-slate-900">${esc(i.title)}</div><div class="text-xs text-slate-600">${esc(i.detail)}</div></div>
          ${i.action ? `<sl-button size="small" data-value="${esc(i.action.id)}">${esc(i.action.label)}</sl-button>` : ''}
        </div>`).join('')}
      <div class="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
        <sl-button size="small" variant="text" data-value="records"><sl-icon slot="prefix" name="person-vcard"></sl-icon>Student records request…</sl-button>
        <sl-button size="small" variant="text" data-value="archive"><sl-icon slot="prefix" name="archive"></sl-icon>Archive this term…</sl-button>
      </div>
    </div>`, [{ value: 'close', label: 'Close' }], { width: '600px' });
  if (r && r.value !== 'close') await runAction(r.value);
}

/** Header chip, refreshed when anything it reports on changes */
export function initDataSafety() {
  const chip = document.getElementById('kb-data-safety-chip');
  if (!chip) return;
  if (!chip.dataset.bound) {
    chip.dataset.bound = '1';
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.querySelector('sl-dropdown.kb-storage-menu')?.hide?.();
      openDataSafetyDialog();
    });
  }
  const refresh = () => updateDataSafetyChip().catch(() => {});
  for (const ev of ['kb-backup-written', 'kb-recovery-kit-saved', 'kb-replication-status', 'kb-transport-changed']) window.addEventListener(ev, refresh);
  setInterval(refresh, 5 * 60 * 1000);
  refresh().then(async () => {
    // A school that requires automatic backups gets one clear prompt per session
    const s = await gatherDataSafety();
    if (s.policy.requireAutomaticBackup && !s.hasAutomaticBackup && s.canAutoBackup) {
      toast.warning('Your school asks you to turn on automatic backups. Open "Data safety" in the header to set it up.', 12000);
    }
  });
}
