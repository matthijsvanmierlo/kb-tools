/**
 * Student Hub (KB-STUDENT-005)
 *
 * Primary landing page for Student View (#/student).
 * Provides quick access to personal gradebook, active assignments, study tools, and class keychains.
 */

import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { StudentProfile } from '../../core/student-profile.js';
import { StudentLedger } from './ledger.js';
import { RoleMode } from '../../state/role-mode.js';

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

export async function renderStudentHubView(params, router, container) {
  const profile = StudentProfile.get();
  const courses = await StudentLedger.getStudentCourses();
  const entries = await StudentLedger.getAllLedgerEntries();

  const studentName = profile.defaultIdentity.full_name || 'Student';
  const studentId = profile.defaultIdentity.student_id || '';

  container.innerHTML = `
    <div class="space-y-8 max-w-5xl mx-auto pb-12">
      <!-- Welcome Hero -->
      <div class="bg-gradient-to-br from-blue-600 to-indigo-700 text-white rounded-3xl p-8 sm:p-10 shadow-md relative overflow-hidden">
        <div class="relative z-10 space-y-4 max-w-2xl">
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/20 backdrop-blur-xs text-xs font-semibold tracking-wide">
            <sl-icon name="mortarboard"></sl-icon> Student Workspace
          </div>
          <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight">
            Welcome back, ${esc(studentName)}
          </h1>
          <p class="text-blue-100 text-sm sm:text-base leading-relaxed">
            Your personal, zero-trust educational hub. Grades, feedback, and study materials stay private in your browser.
          </p>
          <div class="pt-2 flex flex-wrap items-center gap-3">
            <sl-button variant="default" href="#/student/gradebook" size="medium">
              <sl-icon slot="prefix" name="journal-check"></sl-icon> My Gradebook &amp; Feedback
            </sl-button>
            <sl-button variant="text" class="text-white hover:text-blue-200" id="btn-edit-student-profile">
              <sl-icon slot="prefix" name="person-gear"></sl-icon> Edit Identity
            </sl-button>
          </div>
        </div>
      </div>

      <!-- Quick Action Cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <!-- Gradebook Card -->
        <a href="#/student/gradebook" class="group block p-6 bg-white rounded-2xl border border-slate-200 shadow-xs hover:shadow-md hover:border-blue-300 transition-all">
          <div class="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-2xl group-hover:scale-105 transition-transform mb-4">
            <sl-icon name="journal-check"></sl-icon>
          </div>
          <h3 class="font-bold text-slate-900 group-hover:text-blue-600 transition-colors">My Gradebook</h3>
          <p class="text-xs text-slate-500 mt-1">${entries.length} recorded grade${entries.length === 1 ? '' : 's'} across ${courses.length} class${courses.length === 1 ? '' : 'es'}</p>
        </a>

        <!-- Study Flashcards -->
        <a href="#/flashcards" class="group block p-6 bg-white rounded-2xl border border-slate-200 shadow-xs hover:shadow-md hover:border-emerald-300 transition-all">
          <div class="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-2xl group-hover:scale-105 transition-transform mb-4">
            <sl-icon name="stack"></sl-icon>
          </div>
          <h3 class="font-bold text-slate-900 group-hover:text-emerald-600 transition-colors">Flashcards</h3>
          <p class="text-xs text-slate-500 mt-1">Spaced repetition memory practice and study games</p>
        </a>

        <!-- Interactive Video -->
        <a href="#/video" class="group block p-6 bg-white rounded-2xl border border-slate-200 shadow-xs hover:shadow-md hover:border-purple-300 transition-all">
          <div class="w-12 h-12 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center text-2xl group-hover:scale-105 transition-transform mb-4">
            <sl-icon name="play-circle"></sl-icon>
          </div>
          <h3 class="font-bold text-slate-900 group-hover:text-purple-600 transition-colors">Video Lessons</h3>
          <p class="text-xs text-slate-500 mt-1">Interactive quizzes embedded at video checkpoints</p>
        </a>

        <!-- Timelines -->
        <a href="#/timeline" class="group block p-6 bg-white rounded-2xl border border-slate-200 shadow-xs hover:shadow-md hover:border-amber-300 transition-all">
          <div class="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center text-2xl group-hover:scale-105 transition-transform mb-4">
            <sl-icon name="bar-chart-steps"></sl-icon>
          </div>
          <h3 class="font-bold text-slate-900 group-hover:text-amber-600 transition-colors">Timelines</h3>
          <p class="text-xs text-slate-500 mt-1">Chronological concept maps and historical timelines</p>
        </a>
      </div>

      <!-- Quick Assignment / Share Launch Bar -->
      <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-4">
        <div class="flex items-center gap-2">
          <sl-icon name="link-45deg" class="text-blue-600 text-lg"></sl-icon>
          <h2 class="font-bold text-slate-900 text-base">Open Shared Assignment or Lesson</h2>
        </div>
        <form id="form-quick-launch" class="flex flex-col sm:flex-row gap-3">
          <sl-input id="input-quick-link" placeholder="Paste link (https://...#/share?...) or .kbshare file" class="flex-1" clearable></sl-input>
          <sl-button type="submit" variant="primary">Open Lesson</sl-button>
        </form>
      </div>

      <!-- My Enrolled Classes & Access Keychain -->
      <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <sl-icon name="key" class="text-slate-600 text-lg"></sl-icon>
            <h2 class="font-bold text-slate-900 text-base">My Class Keychain</h2>
          </div>
          <sl-button size="small" id="btn-add-class-code">
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add Access Code
          </sl-button>
        </div>

        ${Object.keys(profile.classes).length === 0 ? `
          <p class="text-xs text-slate-500 italic">No access codes saved yet. When you enter a class access code on an assignment, it is remembered here automatically.</p>
        ` : `
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${Object.entries(profile.classes).map(([key, cls]) => `
              <div class="p-4 rounded-xl border border-slate-200 bg-slate-50/50 flex items-center justify-between gap-3">
                <div>
                  <div class="font-bold text-slate-900 text-sm">${esc(cls.course_name)}</div>
                  <div class="text-xs text-slate-500 mt-0.5">
                    Student ID: <span class="font-mono">${esc(cls.student_id || studentId || '—')}</span>
                    ${cls.section ? ` · ${esc(cls.section)}` : ''}
                  </div>
                </div>
                <div class="text-right">
                  <span class="font-mono text-xs font-semibold px-2 py-1 rounded bg-slate-200 text-slate-800 tracking-wider">
                    ${esc(cls.access_code ? cls.access_code.slice(0, 4) + '••••' : 'No code')}
                  </span>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>

      <!-- Footer Role Switcher Notice -->
      <div class="p-4 rounded-2xl bg-slate-100/80 border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
        <span>You are currently in <strong>Student View</strong>. Are you a teacher?</span>
        <sl-button size="small" id="btn-switch-to-teacher">
          <sl-icon slot="prefix" name="arrow-repeat"></sl-icon> Switch to Teacher View
        </sl-button>
      </div>
    </div>
  `;

  // Bind Quick Launch Form
  const form = container.querySelector('#form-quick-launch');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = container.querySelector('#input-quick-link').value.trim();
    if (!val) { toast.warning('Please enter a share link.'); return; }
    if (val.includes('#/')) {
      router.navigate(val.slice(val.indexOf('#/')));
    } else {
      toast.warning('Invalid share link format.');
    }
  });

  // Switch to teacher
  container.querySelector('#btn-switch-to-teacher')?.addEventListener('click', () => {
    RoleMode.set('teacher');
    router.navigate('#/');
  });

  // Edit profile dialog
  container.querySelector('#btn-edit-student-profile')?.addEventListener('click', () => {
    openIdentityDialog(profile, () => renderStudentHubView(params, router, container));
  });

  // Add class code dialog
  container.querySelector('#btn-add-class-code')?.addEventListener('click', () => {
    openAddCodeDialog(() => renderStudentHubView(params, router, container));
  });
}

function openIdentityDialog(profile, onSaved) {
  const existing = document.getElementById('kb-student-identity-dialog');
  if (existing) existing.remove();

  const dialog = document.createElement('sl-dialog');
  dialog.id = 'kb-student-identity-dialog';
  dialog.label = 'My Student Identity';
  dialog.innerHTML = `
    <form id="student-identity-form" class="space-y-4">
      <sl-input id="input-student-name" label="Full name" value="${esc(profile.defaultIdentity.full_name)}" required></sl-input>
      <sl-input id="input-student-id" label="Student ID" value="${esc(profile.defaultIdentity.student_id)}" required></sl-input>
      <sl-input id="input-student-email" label="School email (optional)" type="email" value="${esc(profile.defaultIdentity.email)}"></sl-input>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button id="btn-identity-cancel">Cancel</sl-button>
        <sl-button variant="primary" type="submit">Save Identity</sl-button>
      </div>
    </form>
  `;

  document.body.appendChild(dialog);
  dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
  dialog.show();

  dialog.querySelector('#btn-identity-cancel').addEventListener('click', () => dialog.hide());
  dialog.querySelector('#student-identity-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = dialog.querySelector('#input-student-name').value.trim();
    const sid = dialog.querySelector('#input-student-id').value.trim();
    const em = dialog.querySelector('#input-student-email').value.trim();

    await StudentProfile.saveIdentity({
      studentId: sid,
      fullName: name,
      email: em
    });

    dialog.hide();
    toast.success('Identity saved.');
    if (onSaved) onSaved();
  });
}

function openAddCodeDialog(onSaved) {
  const existing = document.getElementById('kb-add-code-dialog');
  if (existing) existing.remove();

  const dialog = document.createElement('sl-dialog');
  dialog.id = 'kb-add-code-dialog';
  dialog.label = 'Add Class Access Code';
  dialog.innerHTML = `
    <form id="add-code-form" class="space-y-4">
      <sl-input id="input-course-name" label="Class or Course Name" placeholder="e.g. Period 2 Chemistry" required></sl-input>
      <sl-input id="input-access-code" label="Access Code" placeholder="e.g. K7M2-QX9P" required></sl-input>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button id="btn-add-code-cancel">Cancel</sl-button>
        <sl-button variant="primary" type="submit">Save Code</sl-button>
      </div>
    </form>
  `;

  document.body.appendChild(dialog);
  dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
  dialog.show();

  dialog.querySelector('#btn-add-code-cancel').addEventListener('click', () => dialog.hide());
  dialog.querySelector('#add-code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cName = dialog.querySelector('#input-course-name').value.trim();
    const code = dialog.querySelector('#input-access-code').value.trim();

    await StudentProfile.saveIdentity({
      courseName: cName,
      accessCode: code
    });

    dialog.hide();
    toast.success('Access code added to keychain.');
    if (onSaved) onSaved();
  });
}
