import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { ClassManager } from '../../components/class-manager.js';
import { ClassSetupWizard } from '../../components/class-setup-wizard.js';
import { AccessCodes, generateAccessCode } from '../../core/access-codes.js';
import { loadRosterContext } from './roster-data.js';
import { openAddStudentModal, openStudentDrawer } from './student-actions.js';
import { renderRosterView } from '../gradebook/roster-view.js';
import { openCourseSettingsDialog } from '../gradebook/course-settings.js';
import { QRCode } from '../../core/qrcode.js';
import { AppUrl } from '../../core/app-url.js';
import { ReplicationEngine } from '../../core/replication/engine.js';

/**
 * Classes & Rosters Module (KB-CLASS-001)
 * Dedicated Master/Detail management view for classes, rosters, and course settings.
 */

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

export async function renderClassesView(params, router, container) {
  let showArchived = false;
  let searchQuery = '';
  let activeTab = params?.tab || 'roster';
  let activeCourseId = params?.courseId || ClassManager.getActiveFilter();

  const render = async () => {
    // Fetch all courses
    const allCourses = await ClassManager.getClasses({ includeArchived: true });
    const studentsTable = storage.table('gradebook_students');
    const assignmentsTable = storage.table('gradebook_assignments');
    const [allStudents, allAssignments] = await Promise.all([
      studentsTable.toArray().catch(() => []),
      assignmentsTable.toArray().catch(() => [])
    ]);

    const filteredCourses = allCourses.filter(c => {
      if (!showArchived && c.archived_at) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesName = (c.name || '').toLowerCase().includes(q);
        const matchesSection = (c.section || '').toLowerCase().includes(q);
        const matchesYear = (c.academic_year || '').toLowerCase().includes(q);
        return matchesName || matchesSection || matchesYear;
      }
      return true;
    });

    // Determine active course
    let activeCourse = null;
    if (activeCourseId) {
      activeCourse = allCourses.find(c => c.id === activeCourseId) || null;
    }
    if (!activeCourse && filteredCourses.length > 0) {
      activeCourse = filteredCourses[0];
      activeCourseId = activeCourse.id;
    }

    container.innerHTML = `
      <div class="h-full flex flex-col md:flex-row bg-slate-50 min-h-[calc(100vh-4rem)]">
        <!-- Master Pane: Class List -->
        <aside class="w-full md:w-80 lg:w-96 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col h-auto md:h-full">
          <!-- Master Header -->
          <div class="p-4 border-b border-slate-200 space-y-3">
            <div class="flex items-center justify-between">
              <div>
                <h1 class="text-base font-bold text-slate-900 flex items-center gap-2">
                  <sl-icon name="collection" class="text-primary-600"></sl-icon> Classes &amp; Rosters
                </h1>
                <p class="text-xs text-slate-500">Manage courses, student enrollments, and settings</p>
              </div>
              <sl-button variant="primary" size="small" id="btn-create-class">
                <sl-icon slot="prefix" name="plus-lg"></sl-icon> New Class
              </sl-button>
            </div>
            <div class="flex items-center gap-2">
              <sl-input size="small" id="input-search-classes" placeholder="Search classes..." value="${esc(searchQuery)}" clearable class="flex-1">
                <sl-icon slot="prefix" name="search"></sl-icon>
              </sl-input>
              <sl-tooltip content="Toggle archived classes">
                <sl-button size="small" variant="${showArchived ? 'primary' : 'default'}" id="btn-toggle-archived" outline>
                  <sl-icon name="archive"></sl-icon>
                </sl-button>
              </sl-tooltip>
            </div>
          </div>

          <!-- Master Class List -->
          <div class="flex-1 overflow-y-auto p-2 space-y-1.5" id="classes-list-mount">
            ${filteredCourses.length === 0 ? `
              <div class="text-center py-12 px-4 text-slate-400">
                <sl-icon name="mortarboard" class="text-4xl text-slate-300 mb-2"></sl-icon>
                <p class="text-sm font-medium text-slate-600">No classes found</p>
                <p class="text-xs text-slate-400 mt-1">${searchQuery ? 'Try a different search query' : 'Create your first class to get started'}</p>
                ${!searchQuery ? `
                  <sl-button variant="primary" size="small" class="mt-4" id="btn-create-first-class">
                    <sl-icon slot="prefix" name="plus-lg"></sl-icon> Create Class
                  </sl-button>
                ` : ''}
              </div>
            ` : filteredCourses.map(c => {
              const isSelected = activeCourse && c.id === activeCourse.id;
              const studentCount = allStudents.filter(s => s.course_id === c.id).length;
              const assignmentCount = allAssignments.filter(a => a.course_id === c.id).length;
              const isArchived = Boolean(c.archived_at);
              const color = Sanitizer.safeColor(c.color, '#2563eb');

              return `
                <div class="p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-2 class-item ${
                  isSelected ? 'border-primary-500 bg-primary-50/50 shadow-xs ring-1 ring-primary-500/30' : 'border-slate-200/80 bg-white hover:border-slate-300 hover:bg-slate-50'
                } ${isArchived ? 'opacity-70 bg-slate-50/80' : ''}" data-id="${esc(c.id)}">
                  <div class="flex items-center gap-3 min-w-0 flex-1">
                    <div class="w-2.5 h-9 rounded-full flex-shrink-0" style="background-color: ${color};"></div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-1.5">
                        <span class="text-sm font-semibold text-slate-900 truncate">${esc(c.name)}</span>
                        ${isArchived ? '<span class="px-1.5 py-0.2 text-[9px] uppercase font-bold rounded bg-slate-200 text-slate-600">Archived</span>' : ''}
                      </div>
                      <div class="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5 truncate">
                        ${c.section ? `<span>${esc(c.section)}</span><span>•</span>` : ''}
                        <span>${esc(c.academic_year || '')}</span>
                        <span>•</span>
                        <span class="font-medium text-slate-600">${studentCount} student${studentCount === 1 ? '' : 's'}</span>
                      </div>
                    </div>
                  </div>
                  <div class="flex items-center gap-1">
                    <sl-tooltip content="Open in Gradebook">
                      <sl-button size="small" variant="text" class="btn-goto-gradebook text-slate-400 hover:text-primary-600" data-id="${esc(c.id)}">
                        <sl-icon name="journal-bookmark"></sl-icon>
                      </sl-button>
                    </sl-tooltip>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </aside>

        <!-- Detail Pane: Selected Class -->
        <main class="flex-1 flex flex-col min-w-0 bg-slate-50 overflow-hidden" id="classes-detail-mount">
          ${!activeCourse ? `
            <div class="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-400">
              <sl-icon name="collection" class="text-5xl text-slate-300 mb-3"></sl-icon>
              <h2 class="text-lg font-semibold text-slate-700">Select or create a class</h2>
              <p class="text-sm text-slate-400 max-w-sm mt-1">Choose a class from the left list to view and manage its roster, student access codes, and settings.</p>
            </div>
          ` : `
            <!-- Detail Header -->
            <div class="bg-white border-b border-slate-200 px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 flex-shrink-0">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-4 h-11 rounded-lg flex-shrink-0 shadow-xs" style="background-color: ${Sanitizer.safeColor(activeCourse.color, '#2563eb')};"></div>
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <h2 class="text-xl font-bold text-slate-900 truncate">${esc(activeCourse.name)}</h2>
                    ${activeCourse.section ? `<span class="px-2 py-0.5 rounded-md text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">${esc(activeCourse.section)}</span>` : ''}
                    ${activeCourse.academic_year ? `<span class="text-xs text-slate-500 font-medium">(${esc(activeCourse.academic_year)})</span>` : ''}
                  </div>
                  <p class="text-xs text-slate-500 mt-0.5">
                    Course ID: <code class="bg-slate-100 px-1 py-0.5 rounded text-[11px] text-slate-600 font-mono">${esc(activeCourse.id)}</code>
                  </p>
                </div>
              </div>

              <!-- Quick action buttons -->
              <div class="flex items-center gap-2 flex-wrap">
                <sl-button size="small" variant="default" id="btn-detail-course-page">
                  <sl-icon slot="prefix" name="card-heading"></sl-icon> Course Page
                </sl-button>
                <sl-button size="small" variant="primary" id="btn-detail-gradebook">
                  <sl-icon slot="prefix" name="journal-bookmark"></sl-icon> Open Gradebook
                </sl-button>
              </div>
            </div>

            <!-- Detail Tabs Bar -->
            <div class="bg-white border-b border-slate-200 px-6 flex items-center gap-4 flex-shrink-0">
              <sl-tab-group id="classes-tab-group" class="w-full">
                <sl-tab slot="nav" panel="roster" ${activeTab === 'roster' ? 'active' : ''}>
                  <sl-icon slot="prefix" name="people" class="mr-1"></sl-icon> Roster
                </sl-tab>
                <sl-tab slot="nav" panel="settings" ${activeTab === 'settings' ? 'active' : ''}>
                  <sl-icon slot="prefix" name="gear" class="mr-1"></sl-icon> Settings
                </sl-tab>
                <sl-tab slot="nav" panel="sharing" ${activeTab === 'sharing' ? 'active' : ''}>
                  <sl-icon slot="prefix" name="share" class="mr-1"></sl-icon> Sharing &amp; Access
                </sl-tab>
                <sl-tab slot="nav" panel="coteachers" ${activeTab === 'coteachers' ? 'active' : ''}>
                  <sl-icon slot="prefix" name="hdd-network" class="mr-1"></sl-icon> Devices &amp; Sync
                </sl-tab>
                <sl-tab slot="nav" panel="danger" ${activeTab === 'danger' ? 'active' : ''}>
                  <sl-icon slot="prefix" name="sliders" class="mr-1"></sl-icon> Manage &amp; Archive
                </sl-tab>

                <!-- TAB PANELS -->
                <sl-tab-panel name="roster" class="p-0 pt-4">
                  <div id="roster-mount" class="w-full"></div>
                </sl-tab-panel>

                <sl-tab-panel name="settings" class="py-4">
                  <div class="max-w-2xl bg-white rounded-xl border border-slate-200 p-6 space-y-5 shadow-xs">
                    <div>
                      <h3 class="text-sm font-semibold text-slate-900">Class Details</h3>
                      <p class="text-xs text-slate-500">Update general information and section metadata.</p>
                    </div>

                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <sl-input id="set-name" label="Class Name" value="${esc(activeCourse.name)}" required></sl-input>
                      <sl-input id="set-section" label="Section / Period" value="${esc(activeCourse.section)}"></sl-input>
                      <sl-input id="set-year" label="Academic Year" value="${esc(activeCourse.academic_year || '2026-2027')}"></sl-input>
                      <sl-color-picker id="set-color" label="Accent Color" value="${Sanitizer.safeColor(activeCourse.color, '#2563eb')}"></sl-color-picker>
                    </div>

                    <div class="border-t border-slate-100 pt-4 flex items-center justify-between">
                      <sl-button variant="default" size="small" id="btn-open-advanced-settings">
                        <sl-icon slot="prefix" name="sliders"></sl-icon> Full Grading &amp; Standards Settings...
                      </sl-button>
                      <sl-button variant="primary" size="small" id="btn-save-class-settings">
                        <sl-icon slot="prefix" name="check2"></sl-icon> Save Changes
                      </sl-button>
                    </div>
                  </div>
                </sl-tab-panel>

                <sl-tab-panel name="sharing" class="py-4">
                  <div class="max-w-2xl bg-white rounded-xl border border-slate-200 p-6 space-y-6 shadow-xs">
                    <div>
                      <h3 class="text-sm font-semibold text-slate-900">Student Enrollment &amp; Class Access</h3>
                      <p class="text-xs text-slate-500">Students use this code or link to enroll in this class on their devices.</p>
                    </div>

                    <div class="flex flex-col sm:flex-row items-start sm:items-center gap-6 p-4 rounded-xl bg-slate-50 border border-slate-200">
                      <div id="enrollment-qr-mount" class="w-36 h-36 bg-white p-2 rounded-lg border border-slate-200 flex items-center justify-center shadow-xs">
                        <!-- QR Code mounts here -->
                      </div>
                      <div class="space-y-3 flex-1 min-w-0">
                        <div>
                          <label class="text-xs font-semibold uppercase tracking-wider text-slate-500">Class Access Code</label>
                          <div class="flex items-center gap-2 mt-1">
                            <span class="text-2xl font-mono font-bold tracking-widest text-primary-700 bg-white px-3 py-1 rounded-md border border-slate-300" id="text-access-code">
                              ${esc(activeCourse.access_code || '------')}
                            </span>
                            <sl-tooltip content="Regenerate access code">
                              <sl-button size="small" variant="default" id="btn-regen-code" outline>
                                <sl-icon name="arrow-clockwise"></sl-icon>
                              </sl-button>
                            </sl-tooltip>
                          </div>
                        </div>

                        <div>
                          <label class="text-xs font-semibold uppercase tracking-wider text-slate-500">Student Join Link</label>
                          <div class="flex items-center gap-2 mt-1">
                            <sl-input id="input-join-link" readonly size="small" class="flex-1 font-mono text-xs" value=""></sl-input>
                            <sl-tooltip content="Copy join link">
                              <sl-button size="small" variant="default" id="btn-copy-join-link">
                                <sl-icon name="clipboard"></sl-icon>
                              </sl-button>
                            </sl-tooltip>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div class="text-xs text-slate-500 space-y-1">
                      <p class="font-medium text-slate-700">How students join:</p>
                      <ul class="list-disc list-inside space-y-0.5 text-slate-600">
                        <li>Direct link opens Student Mode with the class code automatically filled.</li>
                        <li>Or students navigate to <strong>#/student</strong> and enter the 6-character code.</li>
                        <li>All student enrollments and cryptographic keychains are stored client-side in their browser.</li>
                      </ul>
                    </div>
                  </div>
                </sl-tab-panel>

                <sl-tab-panel name="coteachers" class="py-4">
                  <div class="max-w-2xl bg-white rounded-xl border border-slate-200 p-6 space-y-5 shadow-xs">
                    <div>
                      <h3 class="text-sm font-semibold text-slate-900">Co-teachers &amp; Multi-Device Replication</h3>
                      <p class="text-xs text-slate-500">KennisBoost uses zero-server peer replication. All course changes sync deterministically.</p>
                    </div>

                    <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                      <div class="flex items-center justify-between text-xs">
                        <span class="font-medium text-slate-700">Local Storage Mode</span>
                        <span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium">Encrypted IndexedDB &amp; OPFS</span>
                      </div>
                      <div class="flex items-center justify-between text-xs">
                        <span class="font-medium text-slate-700">Replication Engine</span>
                        <span class="text-slate-600 font-mono">Deterministic LWW + Outbox</span>
                      </div>
                    </div>

                    <div class="flex items-center gap-3 pt-2">
                      <sl-button variant="default" size="small" id="btn-export-class-backup">
                        <sl-icon slot="prefix" name="download"></sl-icon> Export Class JSON
                      </sl-button>
                      <sl-button variant="default" size="small" id="btn-open-sync-settings">
                        <sl-icon slot="prefix" name="hdd-network"></sl-icon> Sync Settings...
                      </sl-button>
                    </div>
                  </div>
                </sl-tab-panel>

                <sl-tab-panel name="danger" class="py-4">
                  <div class="max-w-2xl bg-white rounded-xl border border-slate-200 p-6 space-y-6 shadow-xs">
                    <div>
                      <h3 class="text-sm font-semibold text-slate-900">Class Management Actions</h3>
                      <p class="text-xs text-slate-500">Cloning, archiving, or removing this class.</p>
                    </div>

                    <div class="space-y-3">
                      <div class="flex items-center justify-between p-3 rounded-xl border border-slate-200 bg-slate-50">
                        <div>
                          <div class="text-sm font-semibold text-slate-800">Clone for Next Academic Year</div>
                          <div class="text-xs text-slate-500">Duplicates assignments, categories, and rubrics without student data.</div>
                        </div>
                        <sl-button size="small" variant="default" id="btn-clone-next-year">Clone</sl-button>
                      </div>

                      <div class="flex items-center justify-between p-3 rounded-xl border border-slate-200 bg-slate-50">
                        <div>
                          <div class="text-sm font-semibold text-slate-800">Clone Section</div>
                          <div class="text-xs text-slate-500">Creates another section of this class for the same academic year.</div>
                        </div>
                        <sl-button size="small" variant="default" id="btn-clone-section">Clone Section</sl-button>
                      </div>

                      <div class="flex items-center justify-between p-3 rounded-xl border border-slate-200 bg-slate-50">
                        <div>
                          <div class="text-sm font-semibold text-slate-800">${activeCourse.archived_at ? 'Unarchive Class' : 'Archive Class'}</div>
                          <div class="text-xs text-slate-500">Archived classes are hidden from default navigation and selectors.</div>
                        </div>
                        <sl-button size="small" variant="${activeCourse.archived_at ? 'primary' : 'default'}" id="btn-toggle-archive-course">
                          ${activeCourse.archived_at ? 'Unarchive' : 'Archive'}
                        </sl-button>
                      </div>

                      <div class="flex items-center justify-between p-3 rounded-xl border border-rose-200 bg-rose-50/50">
                        <div>
                          <div class="text-sm font-semibold text-rose-900">Delete Class Permanently</div>
                          <div class="text-xs text-rose-700">Deletes this class, roster, and grade records permanently from your vault.</div>
                        </div>
                        <sl-button size="small" variant="danger" id="btn-delete-course">
                          <sl-icon slot="prefix" name="trash"></sl-icon> Delete Class
                        </sl-button>
                      </div>
                    </div>
                  </div>
                </sl-tab-panel>
              </sl-tab-group>
            </div>
          `}
        </main>
      </div>
    `;

    // Bind Master Pane Events
    container.querySelector('#btn-create-class')?.addEventListener('click', () => {
      ClassSetupWizard.open({
        onDone: async (newId) => {
          const resolvedId = typeof newId === 'object' ? newId?.id : newId;
          if (resolvedId) {
            activeCourseId = resolvedId;
            ClassManager.setActiveFilter(resolvedId);
          }
          await render();
        }
      });
    });

    container.querySelector('#btn-create-first-class')?.addEventListener('click', () => {
      ClassSetupWizard.open({
        onDone: async (newId) => {
          const resolvedId = typeof newId === 'object' ? newId?.id : newId;
          if (resolvedId) {
            activeCourseId = resolvedId;
            ClassManager.setActiveFilter(resolvedId);
          }
          await render();
        }
      });
    });

    const searchInput = container.querySelector('#input-search-classes');
    searchInput?.addEventListener('sl-input', (e) => {
      searchQuery = e.target.value;
      render();
    });

    const toggleArchivedBtn = container.querySelector('#btn-toggle-archived');
    toggleArchivedBtn?.addEventListener('click', () => {
      showArchived = !showArchived;
      render();
    });

    container.querySelectorAll('.class-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.btn-goto-gradebook')) return;
        const id = item.dataset.id;
        activeCourseId = id;
        ClassManager.setActiveFilter(id);
        window.location.hash = `#/classes?courseId=${id}&tab=${activeTab}`;
        render();
      });
    });

    container.querySelectorAll('.btn-goto-gradebook').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        ClassManager.setActiveFilter(id);
        window.location.hash = `#/gradebook?courseId=${id}`;
      });
    });

    if (!activeCourse) return;

    // Bind Detail Header Events
    container.querySelector('#btn-detail-gradebook')?.addEventListener('click', () => {
      ClassManager.setActiveFilter(activeCourse.id);
      window.location.hash = `#/gradebook?courseId=${activeCourse.id}`;
    });

    container.querySelector('#btn-detail-course-page')?.addEventListener('click', () => {
      window.location.hash = `#/course?id=${activeCourse.id}`;
    });

    // Tab Change
    const tabGroup = container.querySelector('#classes-tab-group');
    tabGroup?.addEventListener('sl-tab-show', (e) => {
      activeTab = e.detail.name;
      const newHash = `#/classes?courseId=${activeCourse.id}&tab=${activeTab}`;
      if (window.location.hash !== newHash) {
        history.replaceState(null, '', newHash);
      }
      if (activeTab === 'roster') {
        mountRoster();
      } else if (activeTab === 'sharing') {
        mountSharing();
      }
    });

    // Mount Active Tab Content
    const mountRoster = async () => {
      const mount = container.querySelector('#roster-mount');
      if (!mount) return;
      mount.innerHTML = '<div class="p-6 text-center text-slate-400 text-sm">Loading roster...</div>';

      const ctx = await loadRosterContext(activeCourse.id);
      if (!ctx) {
        mount.innerHTML = '<div class="p-6 text-center text-slate-400 text-sm">Course not found.</div>';
        return;
      }

      await renderRosterView({
        container: mount,
        course: ctx.course,
        students: ctx.students,
        allAssignments: ctx.allAssignments,
        gradesMap: ctx.gradesMap,
        studentAggregates: ctx.studentAggregates,
        onRefresh: () => render(),
        onOpenStudentDrawer: (s) => openStudentDrawer({
          student: s,
          course: ctx.course,
          assignments: ctx.allAssignments,
          gradesMap: ctx.gradesMap,
          rubrics: ctx.rubrics,
          onOpenAccess: () => {
            tabGroup.show('sharing');
          },
          onUpdateStudent: async (updated) => {
            await storage.table('gradebook_students').put(updated);
            render();
          },
          onDeleteStudent: async () => {
            render();
          }
        }),
        onOpenAccess: () => {
          tabGroup.show('sharing');
        },
        onAddStudent: () => {
          openAddStudentModal(ctx.course, async (newStudent) => {
            await storage.table('gradebook_students').put(newStudent);
            toast.success(`Student ${newStudent.full_name} added!`);
            render();
          });
        }
      });
    };

    const mountSharing = async () => {
      const qrMount = container.querySelector('#enrollment-qr-mount');
      const joinInput = container.querySelector('#input-join-link');
      if (!qrMount) return;

      if (!activeCourse.access_code) {
        const { AccessCodes } = await import('../../core/access-codes.js');
        activeCourse.access_code = AccessCodes.generateCode();
        await storage.table('gradebook_courses').put(activeCourse);
      }

      const code = activeCourse.access_code || '';
      const base = window.location.origin + window.location.pathname;

      let relay = '';
      try {
        const { getTransport } = await import('../../core/transport.js');
        const transport = await getTransport();
        relay = transport?.baseUrl || activeCourse.relay_url || '';
      } catch (_) {}

      const params = new URLSearchParams();
      params.set('code', code);
      params.set('cid', activeCourse.id);
      if (activeCourse.name) params.set('cname', activeCourse.name);
      if (activeCourse.section) params.set('csec', activeCourse.section);
      if (activeCourse.color) params.set('ccolor', activeCourse.color);
      if (relay) params.set('relay', relay);

      const joinUrl = `${base}#/student/courses?${params.toString()}`;

      if (joinInput) {
        joinInput.value = joinUrl;
      }

      qrMount.innerHTML = '';
      if (code) {
        try {
          const qrSvg = QRCode.generateSVG(joinUrl, { size: 128, margin: 1 });
          qrMount.innerHTML = qrSvg;
        } catch (err) {
          qrMount.innerHTML = '<span class="text-xs text-slate-400">QR unavailable</span>';
        }
      } else {
        qrMount.innerHTML = '<span class="text-xs text-slate-400">No code</span>';
      }
    };

    if (activeTab === 'roster') {
      mountRoster();
    } else if (activeTab === 'sharing') {
      mountSharing();
    }

    // Settings Tab Handlers
    container.querySelector('#btn-save-class-settings')?.addEventListener('click', async () => {
      const name = container.querySelector('#set-name')?.value?.trim();
      const section = container.querySelector('#set-section')?.value?.trim() || '';
      const year = container.querySelector('#set-year')?.value?.trim() || '';
      const color = container.querySelector('#set-color')?.value || '#2563eb';

      if (!name) {
        toast.warning('Class name is required.');
        return;
      }

      activeCourse.name = name;
      activeCourse.section = section;
      activeCourse.academic_year = year;
      activeCourse.color = color;
      activeCourse.updated_at = new Date().toISOString();

      await storage.table('gradebook_courses').put(activeCourse);
      toast.success('Class details updated!');
      render();
    });

    container.querySelector('#btn-open-advanced-settings')?.addEventListener('click', () => {
      openCourseSettingsDialog({
        course: activeCourse,
        onSave: async (updated) => {
          await ClassManager.saveClass(updated);
          toast.success('Course settings saved!');
          render();
        }
      });
    });

    // Sharing Tab Handlers
    container.querySelector('#btn-regen-code')?.addEventListener('click', async () => {
      const confirmed = await ConfirmDialog.show({
        title: 'Regenerate Access Code',
        message: 'Regenerating the access code will require new students to use the new code. Existing enrolled students remain intact. Continue?',
        confirmText: 'Regenerate',
        confirmVariant: 'primary'
      });
      if (!confirmed) return;

      activeCourse.access_code = generateAccessCode();
      activeCourse.updated_at = new Date().toISOString();
      await storage.table('gradebook_courses').put(activeCourse);
      toast.success(`New access code: ${activeCourse.access_code}`);
      render();
    });

    container.querySelector('#btn-copy-join-link')?.addEventListener('click', async () => {
      const joinInput = container.querySelector('#input-join-link');
      if (joinInput?.value) {
        try {
          await navigator.clipboard.writeText(joinInput.value);
          toast.success('Join link copied to clipboard!');
        } catch {
          toast.warning('Could not copy automatically. Please copy the link manually.');
        }
      }
    });

    // Sync / Backup Handlers
    container.querySelector('#btn-export-class-backup')?.addEventListener('click', async () => {
      const ctx = await loadRosterContext(activeCourse.id);
      if (!ctx) return;
      const exportData = {
        kennisboost_course: true,
        version: 1,
        exported_at: new Date().toISOString(),
        course: ctx.course,
        students: ctx.students,
        assignments: ctx.allAssignments,
        rubrics: ctx.rubrics
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeCourse.name.replace(/[^a-z0-9_-]/gi, '_')}-backup.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Class export downloaded.');
    });

    container.querySelector('#btn-open-sync-settings')?.addEventListener('click', () => {
      window.location.hash = '#/sync';
    });

    // Danger Tab Handlers
    container.querySelector('#btn-clone-next-year')?.addEventListener('click', async () => {
      const cloned = await ClassManager.cloneClassForNextYear(activeCourse.id);
      toast.success(`Cloned "${cloned.name}" for ${cloned.academic_year}!`);
      activeCourseId = cloned.id;
      ClassManager.setActiveFilter(cloned.id);
      render();
    });

    container.querySelector('#btn-clone-section')?.addEventListener('click', async () => {
      const cloned = await ClassManager.cloneClassSection(activeCourse.id);
      toast.success(`Cloned section to "${cloned.section}"!`);
      activeCourseId = cloned.id;
      ClassManager.setActiveFilter(cloned.id);
      render();
    });

    container.querySelector('#btn-toggle-archive-course')?.addEventListener('click', async () => {
      if (activeCourse.archived_at) {
        await ClassManager.unarchiveClass(activeCourse.id);
        toast.success(`Unarchived "${activeCourse.name}"!`);
      } else {
        await ClassManager.archiveClass(activeCourse.id);
        toast.info(`Archived "${activeCourse.name}".`);
      }
      render();
    });

    container.querySelector('#btn-delete-course')?.addEventListener('click', async () => {
      const confirmed = await ConfirmDialog.show({
        title: 'Delete Class Permanently',
        message: `Are you sure you want to permanently delete "${activeCourse.name}"? All students, assignments, and grades belonging to this class will be deleted. This cannot be undone.`,
        confirmText: 'Delete Permanently',
        confirmVariant: 'danger'
      });
      if (!confirmed) return;

      await ClassManager.deleteClass(activeCourse.id);
      toast.success(`Class "${activeCourse.name}" deleted.`);
      activeCourseId = null;
      render();
    });
  };

  await render();
}
