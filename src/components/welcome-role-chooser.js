/**
 * WelcomeRoleChooser - First-Run Onboarding Modal (KB-ONBOARD-001)
 *
 * Prompts first-time visitors to choose whether they are a Teacher or a Student,
 * tailoring their initial view while making it clear they can switch at any time.
 */

import { RoleMode } from '../state/role-mode.js';
import { StudentProfile } from '../core/student-profile.js';
import { toast } from '../utils/toast.js';
import { joinCourseByCode } from '../modules/student/course-store.js';
import { ensureDialogReady } from '../boot/shoelace-setup.js';
import { ClassSetupWizard } from './class-setup-wizard.js';
import { storage } from '../core/storage.js';

export class WelcomeRoleChooser {
  static async checkAndShow(router) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    // Skip if user has already chosen or is opening a direct student/share link
    if (RoleMode.hasChosen()) return;
    const hash = window.location.hash || '';
    if (
      hash.includes('take') ||
      hash.includes('kiosk') ||
      hash.includes('feedback') ||
      hash.includes('report') ||
      hash.includes('student') ||
      hash.includes('share') ||
      hash.includes('connect') ||
      hash.includes('work') ||
      hash.includes('join') ||
      hash.includes('code=') ||
      hash.includes('pass=')
    ) {
      RoleMode.set('student');
      return;
    }

    const existing = document.getElementById('kb-welcome-role-dialog');
    if (existing) return;

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'kb-welcome-role-dialog';
    dialog.dataset.persistRoute = 'true';
    dialog.label = 'Welcome to KennisBoost Tools';
    dialog.style.setProperty('--width', '580px');

    dialog.innerHTML = `
      <div class="space-y-6 text-center" id="welcome-step-1">
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
    await ensureDialogReady(dialog);
    dialog.show();

    dialog.querySelector('#btn-choose-teacher')?.addEventListener('click', async () => {
      RoleMode.set('teacher');
      dialog.hide();
      dialog.remove();
      try {
        const count = await storage.table('gradebook_courses').count();
        if (count === 0) {
          toast.info('Welcome, Teacher! Set up your first class to get started.');
        }
      } catch (_) {}
      if (router) router.navigate('#/');
    });

    dialog.querySelector('#btn-choose-student')?.addEventListener('click', () => {
      RoleMode.set('student');
      this._renderStudentOnboardingStep(dialog, router);
    });
  }

  static _renderStudentOnboardingStep(dialog, router) {
    dialog.label = 'Welcome, Student!';
    dialog.innerHTML = `
      <div class="space-y-4">
        <div class="text-center space-y-1">
          <span class="w-12 h-12 mx-auto rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center text-2xl">
            <sl-icon name="person-badge"></sl-icon>
          </span>
          <h3 class="text-xl font-bold text-slate-900">Set Up Your Student Pass</h3>
          <p class="text-xs text-slate-500 max-w-sm mx-auto">
            Your name and student ID stay safely in your browser. Classmates cannot see your private info.
          </p>
        </div>

        <div class="space-y-3 pt-2 text-left">
          <sl-input id="onboard-student-name" label="Your Full Name" placeholder="e.g. Maya Lin" required></sl-input>
          <sl-input id="onboard-student-id" label="Student ID (Recommended)" placeholder="e.g. ML-402"></sl-input>
          <sl-input id="onboard-student-code" label="Class Join Code (Optional)" placeholder="e.g. 6-character code from teacher"></sl-input>
        </div>

        <div class="pt-3 flex justify-between items-center gap-2 border-t border-slate-100">
          <sl-button variant="text" id="btn-onboard-skip">Skip for now</sl-button>
          <sl-button variant="primary" id="btn-onboard-save">
            <sl-icon slot="prefix" name="check2"></sl-icon> Go to Student Hub
          </sl-button>
        </div>
      </div>
    `;

    dialog.querySelector('#btn-onboard-skip')?.addEventListener('click', () => {
      dialog.hide();
      dialog.remove();
      if (router) router.navigate('#/student');
    });

    dialog.querySelector('#btn-onboard-save')?.addEventListener('click', async () => {
      const name = dialog.querySelector('#onboard-student-name')?.value?.trim();
      const id = dialog.querySelector('#onboard-student-id')?.value?.trim();
      const code = dialog.querySelector('#onboard-student-code')?.value?.trim();

      if (!name && !id && !code) {
        dialog.hide();
        dialog.remove();
        if (router) router.navigate('#/student');
        return;
      }

      try {
        await StudentProfile.saveIdentity({
          studentId: id || (name ? name.toLowerCase().replace(/\s+/g, '_') : 'student'),
          fullName: name || id || 'Student',
          accessCode: code || null
        });

        if (code) {
          try {
            await joinCourseByCode(code);
          } catch (_) {}
        }
        toast.success(`Welcome${name ? ', ' + name : ''}! Your student pass is ready.`);
      } catch (e) {
        console.warn('Could not save identity during onboarding:', e);
      }

      dialog.hide();
      dialog.remove();
      if (router) router.navigate('#/student');
    });
  }
}
