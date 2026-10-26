import { storage } from '../core/storage.js';
import { store } from '../state/store.js';
import { Sanitizer } from '../core/sanitizer.js';
import { RoleMode } from '../state/role-mode.js';
import { ClassManager, CLASS_COLOR_PRESETS } from './class-manager.js';
import { ClassSetupWizard } from './class-setup-wizard.js';

const esc = (s) => Sanitizer.escapeHTML(String(s ?? ''));

/**
 * Universal Class Context Bar & Workspace Breadcrumbs (KB-CONTEXT-001)
 * Proposal #3: Pinned sub-header that keeps active class filter and breadcrumb context
 * synchronized across all modules (Gradebook, Assignments, Calendar, Inbox, Flashcards, Timelines).
 */
export class ContextBar {
  static _mounted = false;
  static _container = null;

  static init(containerId = 'kb-context-bar') {
    if (typeof window === 'undefined') return;

    this._container = document.getElementById(containerId);
    if (!this._container) return;

    // Listen for state and route transitions
    store.subscribe('activeCourseId', () => this.render());
    store.subscribe('activeCourse', () => this.render());
    window.addEventListener('hashchange', () => this.render());
    window.addEventListener('kb-class-filter-changed', () => this.render());
    window.addEventListener('kb-classes-updated', () => this.render());
    window.addEventListener('kb-role-changed', () => this.render());
    window.addEventListener('kb-role-mode-changed', () => this.render());

    this._mounted = true;
    this.render();
  }

  static async render() {
    if (!this._container) return;

    const hash = window.location.hash || '#/';
    const cleanRoute = hash.split('?')[0] || '#/';
    const role = RoleMode.get();

    // Hide context bar on welcome / setup wizard routes if needed
    if (cleanRoute === '#/welcome' || cleanRoute === '#/philosophy' || cleanRoute === '#/about') {
      this._container.innerHTML = '';
      this._container.classList.add('hidden');
      return;
    }
    this._container.classList.remove('hidden');

    let courses = [];
    if (role === 'teacher') {
      courses = await ClassManager.getClasses();
    } else {
      courses = await storage.table('student_courses').toArray().catch(() => []);
    }

    const activeCourseId = store.getState('activeCourseId') || ClassManager.getActiveFilter();
    let activeCourse = store.getState('activeCourse');

    if (activeCourseId && (!activeCourse || activeCourse.id !== activeCourseId)) {
      activeCourse = courses.find(c => c.id === activeCourseId || c.course_id === activeCourseId) || null;
      if (activeCourse) {
        store.setState({ activeCourse });
      }
    }

    const breadcrumbs = this._computeBreadcrumbs(cleanRoute, hash, activeCourse, role);
    const color = activeCourse?.color || '#2563eb';

    this._container.innerHTML = `
      <div class="max-w-7xl mx-auto px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-3 text-xs">
        <!-- Left: Class Context Dropdown & Breadcrumbs -->
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <!-- Class Selector Pill -->
          <sl-dropdown placement="bottom-start" distance="6" id="dropdown-class-context">
            <button slot="trigger" type="button" class="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors shadow-2xs font-medium text-slate-700" title="Switch active class">
              <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background-color: ${esc(color)};"></span>
              <span class="truncate max-w-[150px] sm:max-w-[200px]">
                ${activeCourse ? esc(activeCourse.name || activeCourse.course_name) : (role === 'student' ? 'All My Courses' : 'All Classes')}
              </span>
              ${activeCourse?.section ? `<span class="hidden md:inline text-slate-400 font-normal">(${esc(activeCourse.section)})</span>` : ''}
              <sl-icon name="chevron-down" class="text-[10px] text-slate-400 ml-0.5"></sl-icon>
            </button>

            <sl-menu id="menu-class-context" class="min-w-[240px]">
              <sl-menu-label>${role === 'student' ? 'Enrolled Courses' : 'Your Classes'}</sl-menu-label>
              
              <sl-menu-item value="__all__" ?checked="${!activeCourseId}">
                <sl-icon slot="prefix" name="grid"></sl-icon>
                ${role === 'student' ? 'All Courses' : 'All Classes (No Filter)'}
              </sl-menu-item>

              <sl-divider></sl-divider>

              ${courses.map(c => {
                const cid = c.id || c.course_id;
                const isSelected = activeCourseId === cid;
                const cColor = c.color || '#2563eb';
                return `
                  <sl-menu-item value="${esc(cid)}" ?checked="${isSelected}">
                    <span slot="prefix" class="w-2.5 h-2.5 rounded-full inline-block" style="background-color: ${esc(cColor)};"></span>
                    <span class="font-medium">${esc(c.name || c.course_name)}</span>
                    ${c.section ? `<span slot="suffix" class="text-xs text-slate-400">${esc(c.section)}</span>` : ''}
                  </sl-menu-item>
                `;
              }).join('')}

              ${role === 'teacher' ? `
                <sl-divider></sl-divider>
                <sl-menu-item value="__new_class__">
                  <sl-icon slot="prefix" name="plus-lg" class="text-blue-600"></sl-icon>
                  <span class="text-blue-600 font-medium">Create New Class&hellip;</span>
                </sl-menu-item>
              ` : ''}
            </sl-menu>
          </sl-dropdown>

          <!-- Divider -->
          <div class="h-4 w-px bg-slate-200 hidden sm:block flex-shrink-0"></div>

          <!-- Breadcrumbs Trail -->
          <nav aria-label="Breadcrumbs" class="hidden sm:flex items-center gap-1.5 min-w-0 text-slate-500 overflow-x-auto whitespace-nowrap">
            ${breadcrumbs.map((b, i) => {
              const isLast = i === breadcrumbs.length - 1;
              if (isLast) {
                return `<span class="font-semibold text-slate-800 truncate" aria-current="page">${esc(b.label)}</span>`;
              }
              return `
                <a href="${esc(b.route)}" class="hover:text-blue-600 transition-colors truncate">${esc(b.label)}</a>
                <sl-icon name="chevron-right" class="text-[9px] text-slate-300 flex-shrink-0"></sl-icon>
              `;
            }).join('')}
          </nav>
        </div>

        <!-- Right: Context Quick Links (scoped to active class) -->
        ${role === 'teacher' && activeCourse ? `
          <div class="flex items-center gap-1.5 flex-shrink-0">
            <a href="#/gradebook?courseId=${esc(activeCourse.id)}" class="kb-context-pill px-2 py-0.5 rounded-md hover:bg-slate-100 text-slate-600 font-medium transition-colors flex items-center gap-1" title="Open Gradebook for ${esc(activeCourse.name)}">
              <sl-icon name="journal-check" class="text-xs text-blue-600"></sl-icon>
              <span class="hidden md:inline">Gradebook</span>
            </a>
            <a href="#/course?id=${esc(activeCourse.id)}" class="kb-context-pill px-2 py-0.5 rounded-md hover:bg-slate-100 text-slate-600 font-medium transition-colors flex items-center gap-1" title="Course Units & Feed">
              <sl-icon name="journal-bookmark" class="text-xs text-indigo-600"></sl-icon>
              <span class="hidden md:inline">Course</span>
            </a>
            <a href="#/classes?courseId=${esc(activeCourse.id)}" class="kb-context-pill px-2 py-0.5 rounded-md hover:bg-slate-100 text-slate-600 font-medium transition-colors flex items-center gap-1" title="Roster & Student Codes">
              <sl-icon name="people" class="text-xs text-emerald-600"></sl-icon>
              <span class="hidden md:inline">Roster</span>
            </a>
          </div>
        ` : ''}
      </div>
    `;

    // Attach event listener to menu
    const menu = this._container.querySelector('#menu-class-context');
    if (menu) {
      menu.addEventListener('sl-select', (e) => {
        const val = e.detail.item.value;
        if (val === '__new_class__') {
          ClassSetupWizard.open({
            onDone: (newCourse) => {
              if (newCourse) {
                store.setActiveClass(newCourse);
              }
              this.render();
            }
          });
          return;
        }

        if (val === '__all__') {
          store.setActiveClass(null);
        } else {
          const selected = courses.find(c => (c.id || c.course_id) === val);
          store.setActiveClass(selected || val);
        }
        this.render();
      });
    }
  }

  static _computeBreadcrumbs(cleanRoute, fullHash, activeCourse, role) {
    const list = [{ label: role === 'student' ? 'Student' : 'Home', route: '#/' }];

    if (activeCourse) {
      list.push({
        label: activeCourse.name || activeCourse.course_name || 'Class',
        route: role === 'student' ? `#/student?courseId=${activeCourse.id || activeCourse.course_id}` : `#/course?id=${activeCourse.id}`
      });
    }

    if (cleanRoute.startsWith('#/gradebook')) {
      list.push({ label: 'Gradebook', route: '#/gradebook' });
    } else if (cleanRoute.startsWith('#/course')) {
      list.push({ label: 'Course Units', route: '#/course' });
    } else if (cleanRoute.startsWith('#/assignments')) {
      list.push({ label: 'Assignments', route: '#/assignments' });
      if (cleanRoute.includes('/create')) {
        list.push({ label: 'Editor', route: fullHash });
      } else if (cleanRoute.includes('/review')) {
        list.push({ label: 'Review & Grade', route: fullHash });
      }
    } else if (cleanRoute.startsWith('#/assessments')) {
      list.push({ label: 'Assessments', route: '#/assessments' });
      if (cleanRoute.includes('/edit')) {
        list.push({ label: 'Questions', route: fullHash });
      }
    } else if (cleanRoute.startsWith('#/classes')) {
      list.push({ label: 'Classes & Rosters', route: '#/classes' });
    } else if (cleanRoute.startsWith('#/inbox')) {
      list.push({ label: 'Inbox', route: '#/inbox' });
    } else if (cleanRoute.startsWith('#/calendar')) {
      list.push({ label: 'Calendar', route: '#/calendar' });
    } else if (cleanRoute.startsWith('#/flashcards')) {
      list.push({ label: 'Flashcards', route: '#/flashcards' });
    } else if (cleanRoute.startsWith('#/timeline')) {
      list.push({ label: 'Timeline', route: '#/timeline' });
    } else if (cleanRoute.startsWith('#/video')) {
      list.push({ label: 'Video Assessments', route: '#/video' });
    } else if (cleanRoute.startsWith('#/student')) {
      if (cleanRoute.includes('/courses')) {
        list.push({ label: 'My Courses', route: '#/student/courses' });
      } else if (cleanRoute.includes('/gradebook')) {
        list.push({ label: 'My Grades', route: '#/student/gradebook' });
      } else {
        list.push({ label: 'Student Hub', route: '#/student' });
      }
    }

    return list;
  }
}
