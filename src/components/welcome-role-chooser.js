/**
 * WelcomeRoleChooser - First-Run Onboarding Modal (KB-ONBOARD-001)
 *
 * Prompts first-time visitors to choose whether they are a Teacher or a Student,
 * tailoring their initial view while making it clear they can switch at any time.
 */

import { RoleMode } from '../state/role-mode.js';

export class WelcomeRoleChooser {
  static checkAndShow(router) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    // Skip if user has already chosen or is opening a direct student link
    if (RoleMode.hasChosen()) return;
    const hash = window.location.hash || '';
    if (hash.includes('take') || hash.includes('kiosk') || hash.includes('feedback') || hash.includes('report') || hash.includes('student')) {
      RoleMode.set('student');
      return;
    }

    const existing = document.getElementById('kb-welcome-role-dialog');
    if (existing) return;

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'kb-welcome-role-dialog';
    dialog.label = 'Welcome to KennisBoost Tools';
    dialog.style.setProperty('--width', '580px');

    dialog.innerHTML = `
      <div class="space-y-6 text-center">
        <div class="space-y-2">
          <span class="w-14 h-14 mx-auto rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center text-3xl">
            <sl-icon name="stars"></sl-icon>
          </span>
          <h2 class="text-2xl font-extrabold text-slate-900 tracking-tight">How will you use KennisBoost?</h2>
          <p class="text-sm text-slate-500 max-w-sm mx-auto">
            100% client-side, zero-trust educational suite. Your data stays in your browser.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-left">
          <!-- Teacher Card -->
          <button type="button" id="btn-choose-teacher" class="p-5 rounded-2xl border-2 border-slate-200 hover:border-blue-500 hover:bg-blue-50/30 transition-all text-left flex flex-col justify-between group cursor-pointer">
            <div>
              <div class="w-10 h-10 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center text-xl mb-3 group-hover:scale-105 transition-transform">
                <sl-icon name="briefcase"></sl-icon>
              </div>
              <div class="font-bold text-slate-900 text-base group-hover:text-blue-600">I'm a Teacher</div>
              <p class="text-xs text-slate-500 mt-1">Design lessons, grade student work, manage gradebooks, and export reports.</p>
            </div>
            <div class="mt-4 text-xs font-bold text-blue-600 flex items-center gap-1">
              Teacher View <sl-icon name="arrow-right"></sl-icon>
            </div>
          </button>

          <!-- Student Card -->
          <button type="button" id="btn-choose-student" class="p-5 rounded-2xl border-2 border-slate-200 hover:border-indigo-500 hover:bg-indigo-50/30 transition-all text-left flex flex-col justify-between group cursor-pointer">
            <div>
              <div class="w-10 h-10 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center text-xl mb-3 group-hover:scale-105 transition-transform">
                <sl-icon name="mortarboard"></sl-icon>
              </div>
              <div class="font-bold text-slate-900 text-base group-hover:text-indigo-600">I'm a Student</div>
              <p class="text-xs text-slate-500 mt-1">Take quizzes, practice flashcards, and track your grades and teacher feedback.</p>
            </div>
            <div class="mt-4 text-xs font-bold text-indigo-600 flex items-center gap-1">
              Student View <sl-icon name="arrow-right"></sl-icon>
            </div>
          </button>
        </div>

        <p class="text-xs text-slate-400">
          You can toggle between Teacher View and Student View at any time from the top navigation bar.
        </p>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    dialog.querySelector('#btn-choose-teacher')?.addEventListener('click', () => {
      RoleMode.set('teacher');
      dialog.hide();
      dialog.remove();
    });

    dialog.querySelector('#btn-choose-student')?.addEventListener('click', () => {
      RoleMode.set('student');
      dialog.hide();
      dialog.remove();
      if (router) router.navigate('#/student');
    });
  }
}
