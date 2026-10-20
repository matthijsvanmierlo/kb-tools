import { storage } from '../../core/storage.js';
import { store } from '../../state/store.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { downloadBlob } from '../../core/csv.js';
import { VirtualGradebookGrid } from './virtual-grid.js';
import { RubricDesigner } from './rubric-builder.js';
import { GradebookReportGenerator } from './report-generator.js';
import { parseCSVWithValidation, GradebookStudentSchema, RosterRowSchema, ROSTER_HEADER_ALIASES, showImportErrorsDialog } from '../../core/validator.js';
import { splitName, joinName } from '../../core/names.js';
import { openReceipt, IDENTITY_LABELS } from '../video/secure.js';
import { GradebookBridge } from './bridge.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { ClassManager } from '../../components/class-manager.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { computeCourseAggregates } from './aggregates.js';
import { GradeDetailsDrawer } from './grade-drawer.js';
import { openCourseSettingsDialog } from './course-settings.js';
import { openAssignmentDialog } from './assignment-dialog.js';
import { openPublishDialog } from '../assignments/publish.js';
import { openVideoShareDialog } from '../video/share-video.js';
import { renderStandardsView } from './standards-view.js';
import { renderRosterView } from './roster-view.js';
import { RosterImportDialog } from '../../components/roster-import-dialog.js';
import { ClassSetupWizard } from '../../components/class-setup-wizard.js';
import { AccessCodes } from '../../core/access-codes.js';
import { importVideoReceipts } from '../video/receipt-import.js';
import { ExportDialog } from '../../components/export-dialog.js';
import { GradesImportDialog } from '../../components/grades-import-dialog.js';
import {
  buildGradebookMailMergeRows,
  buildGradebookWideRows,
  buildCanvasExportRows,
  buildGoogleClassroomRows,
  buildOneRosterExportZip
} from './gradebook-csv.js';

/**
 * Multi-Class Gradebook Module Controller & Virtual Grid Manager
 */
export async function renderGradebookView(params, router, container) {
  let courses = await storage.table('gradebook_courses').toArray();

  // If no courses exist, show friendly empty state
  if (courses.length === 0) {
    container.innerHTML = `
      <div class="max-w-4xl mx-auto px-4 py-16 text-center">
        <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-50 text-blue-600 mb-4">
          <sl-icon name="journal-bookmark" style="font-size: 2rem;"></sl-icon>
        </div>
        <h2 class="text-2xl font-bold text-slate-900 mb-2">No Classes Yet</h2>
        <p class="text-slate-600 max-w-md mx-auto mb-6 text-sm">
          Set up your first class or load a sample workspace to explore the gradebook.
        </p>
        <div class="flex items-center justify-center gap-3">
          <sl-button variant="primary" id="btn-empty-new-class">
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> Create Class
          </sl-button>
          <sl-button variant="default" id="btn-empty-load-sample">
            <sl-icon slot="prefix" name="box-arrow-in-down"></sl-icon> Load Sample Workspace
          </sl-button>
        </div>
      </div>
    `;
    container.querySelector('#btn-empty-new-class')?.addEventListener('click', () => {
      ClassSetupWizard.open({
        onDone: (newCourse) => {
          if (newCourse) {
            store.setState('activeCourse', newCourse);
            ClassManager.setActiveFilter(newCourse.id);
          }
          renderGradebookView(params, router, container);
        }
      });
    });
    container.querySelector('#btn-empty-load-sample')?.addEventListener('click', async () => {
      const { loadDemoWorkspace } = await import('../../core/demo.js');
      await loadDemoWorkspace();
      toast.success('Sample workspace loaded!');
      renderGradebookView(params, router, container);
    });
    return;
  }

  // Determine active course
  const activeClassFilter = ClassManager.getActiveFilter();
  let activeCourse = store.getState('activeCourse');

  if (params?.courseId) {
    const matched = courses.find(c => c.id === params.courseId);
    if (matched) activeCourse = matched;
  } else if (activeClassFilter && activeClassFilter !== 'unassigned') {
    const matched = courses.find(c => c.id === activeClassFilter);
    if (matched) activeCourse = matched;
  }

  if (!activeCourse || !courses.some(c => c.id === activeCourse.id)) {
    activeCourse = courses[0];
  }
  store.setState('activeCourse', activeCourse);

  // Term filtering state
  let selectedTermId = 'all';
  // Determine view mode: 'assignments', 'standards', or 'roster'
  let viewMode = 'assignments';
  if (params?.view === 'roster' || store.getState('gradebookViewMode') === 'roster') {
    viewMode = 'roster';
  } else if ((params?.view === 'standards' || store.getState('gradebookViewMode') === 'standards') && activeCourse.grading_scale === 'sbg') {
    viewMode = 'standards';
  }

  // Fetch course data
  let [students, allAssignments, gradesList, rubrics] = await Promise.all([
    storage.table('gradebook_students').where('course_id').equals(activeCourse.id).toArray(),
    storage.table('gradebook_assignments').where('course_id').equals(activeCourse.id).toArray(),
    storage.table('gradebook_grades').where('course_id').equals(activeCourse.id).toArray(),
    storage.table('gradebook_rubrics').where('course_id').equals(activeCourse.id).toArray()
  ]);

  // Stable roster order: by last name, then first name
  const lastName = (n) => String(n || '').trim().split(/\s+/).slice(-1)[0] || '';
  students.sort((a, b) => lastName(a.full_name).localeCompare(lastName(b.full_name)) || (a.full_name || '').localeCompare(b.full_name || ''));

  // Sort assignments by due date / order
  allAssignments.sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));

  let assignments = selectedTermId === 'all'
    ? allAssignments
    : allAssignments.filter(a => a.term_id === selectedTermId);

  const gradesMap = new Map();
  gradesList.forEach(g => {
    gradesMap.set(`${g.student_id}+${g.assignment_id}`, g);
  });

  // Calculate aggregates (respects the class's letter scale and standards-based settings)
  const computeAggregates = () => computeCourseAggregates(students, activeCourse, allAssignments, gradesMap);

  const studentAggregates = computeAggregates();

  const safeCourseName = Sanitizer.escapeHTML(activeCourse.name || 'Course');
  const safeSection = Sanitizer.escapeHTML(activeCourse.section || '');
  const courseColor = Sanitizer.safeColor(activeCourse.color, '#2563eb');

  container.innerHTML = `
    <div class="space-y-4 max-w-7xl mx-auto">
      <!-- Class header: identity + primary actions, then a toolbar row -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-xs">
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 p-4">
          <div class="flex items-center gap-3 w-full md:w-auto min-w-0">
            <span class="w-10 h-10 flex-shrink-0 rounded-xl flex items-center justify-center text-white text-xl shadow-xs" style="background-color: ${courseColor};">
              <sl-icon name="journal-bookmark"></sl-icon>
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <sl-select id="select-active-course" size="small" value="${Sanitizer.escapeHTML(activeCourse.id)}" class="font-semibold text-slate-900 min-w-0 flex-1 sm:flex-none sm:w-64" aria-label="Active class">
                  ${courses.map(c => `
                    <sl-option value="${Sanitizer.escapeHTML(c.id)}">${Sanitizer.escapeHTML(c.name)}${c.section ? `<span slot="suffix" class="text-xs text-slate-400">${Sanitizer.escapeHTML(c.section)}</span>` : ''}</sl-option>
                  `).join('')}
                </sl-select>
                <sl-tooltip content="Class settings: policies, grading scale, standards, access codes">
                  <button type="button" class="kb-icon-btn is-outlined !w-8 !h-8" id="btn-edit-course-settings" aria-label="Class settings">
                    <sl-icon name="gear"></sl-icon>
                  </button>
                </sl-tooltip>
              </div>
              <p class="text-xs text-slate-500 mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <button type="button" id="btn-grading-mode" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold ${activeCourse.grading_scale === 'sbg' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'} hover:ring-1 hover:ring-slate-300" title="Change grading mode in class settings">${activeCourse.grading_scale === 'sbg' ? '<sl-icon name="bullseye"></sl-icon> Standards-based' : '<sl-icon name="123"></sl-icon> Points'}</button>
                <span>${safeSection ? `${safeSection} &bull; ` : ''}${Sanitizer.escapeHTML(activeCourse.academic_year || '2026-2027')} &bull; <span id="header-student-count">${students.length}</span> students &bull; <span id="header-assignment-count">${assignments.length}</span> assignments</span>
              </p>
            </div>
          </div>

          <div class="flex items-center gap-2 flex-wrap">
            <sl-button size="small" id="btn-add-student">
              <sl-icon slot="prefix" name="person-plus"></sl-icon> Student
            </sl-button>
            <sl-button size="small" id="btn-add-assignment" variant="primary">
              <sl-icon slot="prefix" name="plus-lg"></sl-icon> Assignment
            </sl-button>

          <!-- Reports & Actions Dropdown -->
          <sl-dropdown placement="bottom-end">
            <sl-button slot="trigger" size="small" caret>Actions</sl-button>
            <sl-menu>
              <sl-menu-item id="menu-import-kbr-receipts">
                <sl-icon slot="prefix" name="shield-check"></sl-icon> Import .kbr Video Receipts...
              </sl-menu-item>
              <sl-menu-item id="menu-gradebook-rubrics">
                <sl-icon slot="prefix" name="grid-3x3"></sl-icon> Rubrics Designer...
              </sl-menu-item>
              <sl-divider></sl-divider>
              <sl-menu-item id="menu-export-gradebook">
                <sl-icon slot="prefix" name="download"></sl-icon> Export Gradebook...
              </sl-menu-item>
              <sl-menu-item id="menu-import-scores-csv">
                <sl-icon slot="prefix" name="upload"></sl-icon> Import Scores from CSV...
              </sl-menu-item>
              <sl-divider></sl-divider>
              <sl-menu-item id="menu-batch-zip">
                <sl-icon slot="prefix" name="file-earmark-zip"></sl-icon> Export Roster Batch ZIP
              </sl-menu-item>
              <sl-menu-item id="menu-single-pdf">
                <sl-icon slot="prefix" name="file-earmark-pdf"></sl-icon> Print Student Report...
              </sl-menu-item>
              <sl-menu-item id="menu-share-student-link">
                <sl-icon slot="prefix" name="shield-lock"></sl-icon> Encrypted Student Link...
              </sl-menu-item>
              <sl-menu-item id="menu-access-codes">
                <sl-icon slot="prefix" name="key"></sl-icon> Student Access Codes...
              </sl-menu-item>
              <sl-menu-item id="menu-grading-scale">
                <sl-icon slot="prefix" name="bar-chart-steps"></sl-icon> Grading Scale &amp; Standards...
              </sl-menu-item>
              <sl-divider></sl-divider>
              <sl-menu-item id="menu-import-roster-csv">
                <sl-icon slot="prefix" name="upload"></sl-icon> Import Roster CSV...
              </sl-menu-item>
              <sl-menu-item id="menu-clone-course">
                <sl-icon slot="prefix" name="copy"></sl-icon> Clone Class Structure...
              </sl-menu-item>
              <sl-menu-item id="menu-new-course">
                <sl-icon slot="prefix" name="plus-circle"></sl-icon> New Class...
              </sl-menu-item>
            </sl-menu>
          </sl-dropdown>
          <input type="file" id="input-kbr-batch" accept=".kbr" multiple class="hidden" />
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 px-4 py-2.5 border-t border-slate-100 bg-slate-50/60 rounded-b-xl">
          <div class="flex items-center bg-slate-200/60 p-0.5 rounded-lg text-xs" role="group" aria-label="View">
            <button id="btn-view-assignments" class="px-2.5 py-1 rounded-md font-medium transition-colors flex items-center gap-1 ${viewMode === 'assignments' ? 'bg-white text-slate-900 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800'}"><sl-icon name="table"></sl-icon> Assignments</button>
            ${activeCourse.grading_scale === 'sbg' ? `
              <button id="btn-view-standards" class="px-2.5 py-1 rounded-md font-medium transition-colors flex items-center gap-1 ${viewMode === 'standards' ? 'bg-white text-slate-900 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800'}"><sl-icon name="bullseye"></sl-icon> Standards</button>
            ` : ''}
            <button id="btn-view-roster" class="px-2.5 py-1 rounded-md font-medium transition-colors flex items-center gap-1 ${viewMode === 'roster' ? 'bg-white text-slate-900 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800'}"><sl-icon name="people"></sl-icon> Roster</button>
          </div>
          ${(activeCourse.terms || []).length > 1 ? `
            <sl-select id="select-term-filter" size="small" value="${Sanitizer.escapeHTML(selectedTermId)}" class="w-40" aria-label="Term">
              <sl-icon slot="prefix" name="calendar3"></sl-icon>
              <sl-option value="all">All terms</sl-option>
              ${activeCourse.terms.map(t => `<sl-option value="${Sanitizer.escapeHTML(t.id)}">${Sanitizer.escapeHTML(t.name)}</sl-option>`).join('')}
            </sl-select>
          ` : ''}
          <div class="flex items-center gap-0.5 ml-auto">
            <button type="button" class="kb-icon-btn !w-8 !h-8" id="btn-grid-undo" title="Undo (Ctrl+Z)" aria-label="Undo"><sl-icon name="arrow-counterclockwise"></sl-icon></button>
            <button type="button" class="kb-icon-btn !w-8 !h-8" id="btn-grid-redo" title="Redo (Ctrl+Y)" aria-label="Redo"><sl-icon name="arrow-clockwise"></sl-icon></button>
          </div>
        </div>
      </div>

      <!-- Roster View -->
      <div id="roster-view-mount" class="${viewMode === 'roster' ? '' : 'hidden'}"></div>

      <!-- Standards mastery table (standards-based classes) -->
      <div id="standards-view-mount" class="${viewMode === 'standards' ? '' : 'hidden'}"></div>

      <!-- 2D Virtualized Grid Viewport -->
      <div class="flex flex-col lg:flex-row gap-4 items-start ${viewMode === 'assignments' ? '' : 'hidden'}" id="grid-section">
        <div id="grid-mount-container" class="min-w-0 ${assignments.length === 0 ? '' : 'w-full'}"></div>
        ${assignments.length === 0 ? `
          <div class="flex-1 self-stretch min-h-[180px] flex flex-col items-center justify-center text-center gap-3 p-8 bg-white rounded-xl border border-dashed border-slate-300">
            <span class="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-xl">
              <sl-icon name="clipboard-plus"></sl-icon>
            </span>
            <div class="space-y-1">
              <h3 class="font-semibold text-slate-900">No assignments yet</h3>
              <p class="text-sm text-slate-500 max-w-sm">Add your first assignment to start entering grades. Columns appear here as you create them.</p>
            </div>
            <sl-button variant="primary" size="small" id="btn-empty-add-assignment">
              <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add assignment
            </sl-button>
          </div>
        ` : ''}
      </div>

      ${assignments.length && students.length ? `
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500 no-print ${viewMode === 'assignments' ? '' : 'hidden'}" id="grid-hint-bar">
          <span class="font-medium text-slate-600 flex items-center gap-1.5"><sl-icon name="keyboard"></sl-icon> In a cell:</span>
          <span>type a score</span>
          <span><kbd class="kb-kbd">M</kbd> missing</span>
          <span><kbd class="kb-kbd">L</kbd> or <kbd class="kb-kbd">85L2</kbd> late (days)</span>
          <span><kbd class="kb-kbd">E</kbd> excused</span>
          <span class="flex items-center gap-1.5"><kbd class="kb-kbd">Ctrl ↵</kbd>, double-click or right-click for status, rubric &amp; feedback</span>
          <span class="flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span> has feedback</span>
        </div>
      ` : ''}
    </div>
  `;

  const openSettings = (tab = 'general') => {
    openCourseSettingsDialog({
      course: activeCourse,
      otherCourses: courses.filter(c => c.id !== activeCourse.id),
      initialTab: tab,
      onSave: async (updated) => {
        await storage.table('gradebook_courses').put(updated);
        store.setState('activeCourse', updated);
        toast.success('Class settings saved.');
        renderGradebookView(params, router, container);
      },
      onAccessChanged: () => renderGradebookView(params, router, container)
    });
  };

  const renderStandards = () => {
    const mount = container.querySelector('#standards-view-mount');
    if (mount && viewMode === 'standards') {
      renderStandardsView(mount, { course: activeCourse, students, aggregates: computeAggregates(), onOpenSettings: openSettings });
    }
  };

  const renderRoster = () => {
    const mount = container.querySelector('#roster-view-mount');
    if (mount && viewMode === 'roster') {
      renderRosterView({
        container: mount,
        course: activeCourse,
        students,
        allAssignments,
        gradesMap,
        studentAggregates: computeAggregates(),
        onRefresh: () => renderGradebookView(params, router, container),
        onOpenStudentDrawer: (s) => openStudentDrawer({
          student: s,
          course: activeCourse,
          assignments: allAssignments,
          gradesMap,
          rubrics,
          onOpenAccess: () => openSettings('access'),
          onUpdateStudent: async (updated) => {
            await storage.table('gradebook_students').put(updated);
            renderGradebookView(params, router, container);
          },
          onDeleteStudent: async () => {
            renderGradebookView(params, router, container);
          }
        }),
        onOpenAccess: () => openSettings('access'),
        onAddStudent: () => {
          openAddStudentModal(activeCourse, async (newStudent) => {
            await storage.table('gradebook_students').put(newStudent);
            toast.success(`Student ${newStudent.full_name} added!`);
            renderGradebookView(params, router, container);
          });
        }
      });
    }
  };

  const gridMount = container.querySelector('#grid-mount-container');
  container.querySelector('#btn-empty-add-assignment')?.addEventListener('click', () => {
    container.querySelector('#btn-add-assignment')?.click();
  });

  // Initialize Virtual Grid
  const virtualGrid = new VirtualGradebookGrid(gridMount, {
    courseId: activeCourse.id,
    course: activeCourse,
    students,
    assignments,
    rubrics,
    gradesMap,
    studentAggregates,
    onGradeChange: async (record) => {
      await storage.table('gradebook_grades').put(record);
      // Recompute aggregates
      const updatedAggregates = computeAggregates();
      virtualGrid.studentAggregates = updatedAggregates;
      virtualGrid.renderWindow();
    },
    onStudentClick: (student) => {
      openStudentDrawer({
        student,
        course: activeCourse,
        assignments: allAssignments,
        gradesMap,
        rubrics,
        onOpenAccess: () => openSettings('access'),
        onUpdateStudent: async (updated) => {
          await storage.table('gradebook_students').put(updated);
          const idx = students.findIndex(s => s.id === updated.id);
          if (idx !== -1) students[idx] = updated;
          virtualGrid.renderWindow();
        },
        onDeleteStudent: async (deletedId) => {
          await storage.table('gradebook_students').delete(deletedId);
          const gradeKeys = await storage.table('gradebook_grades')
            .where('course_id').equals(activeCourse.id)
            .and(g => g.student_id === student.student_id)
            .primaryKeys();
          if (gradeKeys.length > 0) {
            await storage.table('gradebook_grades').bulkDelete(gradeKeys);
          }

          // Delete submissions for assignments linked to this course
          const courseAssignments = await storage.table('assignments').toArray();
          const linkedAssignmentIds = new Set(
            courseAssignments
              .filter(a => a.gradebook?.course_id === activeCourse.id || a.class_id === activeCourse.id)
              .map(a => a.id)
          );
          if (linkedAssignmentIds.size > 0) {
            const subs = await storage.table('assignment_submissions').toArray();
            const toDeleteSubs = subs
              .filter(s => s.student_id === student.student_id && linkedAssignmentIds.has(s.assignment_id))
              .map(s => s.id);
            if (toDeleteSubs.length > 0) {
              await storage.table('assignment_submissions').bulkDelete(toDeleteSubs);
            }
          }

          toast.info('Student removed.');
          renderGradebookView(params, router, container);
        }
      });
    },
    onAssignmentClick: (assignment) => {
      openAssignmentDialog({
        assignment,
        course: activeCourse,
        rubrics,
        students,
        gradesMap,
        onOpenSettings: openSettings,
        onSave: async (updated) => {
          await storage.table('gradebook_assignments').put(updated);
          toast.success(`Assignment "${updated.title}" updated.`);
          renderGradebookView(params, router, container);
        },
        onBulkFill: async (updatedGrades) => {
          for (const g of updatedGrades) {
            virtualGrid.pushUndo({
              key: `${g.student_id}+${g.assignment_id}`,
              prevRecord: gradesMap.get(`${g.student_id}+${g.assignment_id}`) || { raw_score: null, status: 'submitted' },
              newRecord: g,
              studentId: g.student_id,
              assignmentId: g.assignment_id
            });
            gradesMap.set(`${g.student_id}+${g.assignment_id}`, g);
            await storage.table('gradebook_grades').put(g);
          }
          virtualGrid.studentAggregates = computeAggregates();
          virtualGrid.renderWindow();
          virtualGrid.renderFooterAverages();
          toast.success(`Updated ${updatedGrades.length} cell(s).`);
        },
        onDelete: async (deletedId) => {
          await storage.table('gradebook_assignments').delete(deletedId);
          // bulkDelete (not Collection.delete) so the deletions reach the sync outbox
          const gradeKeys = await storage.table('gradebook_grades').where('assignment_id').equals(deletedId).primaryKeys();
          await storage.table('gradebook_grades').bulkDelete(gradeKeys);
          toast.info('Assignment deleted.');
          renderGradebookView(params, router, container);
        }
      });
    },
    onShareColumn: async (assignment) => {
      if (assignment.source?.type === 'assignment') {
        const item = await storage.table('assignments').get(assignment.source.id);
        if (item) {
          openPublishDialog(item);
        } else {
          toast.warning('Linked assignment not found.');
        }
      } else if (assignment.source?.type === 'video') {
        const item = await storage.table('video_assessments').get(assignment.source.id);
        if (item) {
          openVideoShareDialog(item);
        } else {
          toast.warning('Linked video assessment not found.');
        }
      }
    },
    onOpenDetails: (student, assignment, gradeRecord, pos) => openGradeDrawer(pos.row, pos.col)
  });

  // Grade details drawer: status, rubric, standards and feedback for one cell
  function openGradeDrawer(row, col) {
    const student = virtualGrid.students[row];
    const assignment = virtualGrid.assignments[col];
    if (!student || !assignment) return;
    const key = `${student.student_id}+${assignment.id}`;
    const gradeRecord = gradesMap.get(key) || { raw_score: null, status: 'submitted' };
    GradeDetailsDrawer.open({
      course: activeCourse,
      student,
      assignment,
      record: gradeRecord,
      rubric: assignment.rubric_id ? rubrics.find(r => r.id === assignment.rubric_id) || null : null,
      positionLabel: `${row + 1} of ${virtualGrid.students.length}`,
      onSave: async (updatedRecord) => {
        virtualGrid.pushUndo({
          key,
          prevRecord: JSON.parse(JSON.stringify(gradeRecord)),
          newRecord: JSON.parse(JSON.stringify(updatedRecord)),
          studentId: student.student_id,
          assignmentId: assignment.id
        });
        gradesMap.set(key, updatedRecord);
        await storage.table('gradebook_grades').put(updatedRecord);
        virtualGrid.studentAggregates = computeAggregates();
        virtualGrid.renderWindow();
        virtualGrid.renderFooterAverages();
      },
      onNavigate: (dir) => {
        const next = row + dir;
        if (next >= 0 && next < virtualGrid.students.length) openGradeDrawer(next, col);
      }
    });
  }

  // Undo / Redo toolbar buttons
  container.querySelector('#btn-grid-undo')?.addEventListener('click', () => virtualGrid.undo());
  container.querySelector('#btn-grid-redo')?.addEventListener('click', () => virtualGrid.redo());

  // Class Switcher
  container.querySelector('#select-active-course')?.addEventListener('sl-change', (e) => {
    const selectedCourseId = e.target.value;
    const target = courses.find(c => c.id === selectedCourseId);
    if (target) {
      store.setState('activeCourse', target);
      ClassManager.setActiveFilter(target.id);
      renderGradebookView(params, router, container);
    }
  });

  // Class settings (tabbed: general, policies, grading scale, standards, student access)
  container.querySelector('#btn-edit-course-settings')?.addEventListener('click', () => openSettings('general'));
  container.querySelector('#menu-access-codes')?.addEventListener('click', () => openSettings('access'));
  container.querySelector('#btn-grading-mode')?.addEventListener('click', () => openSettings('general'));
  container.querySelector('#menu-grading-scale')?.addEventListener('click', () => openSettings(activeCourse.grading_scale === 'sbg' ? 'standards' : 'scale'));

  // Assignments ↔ Standards view toggle
  const setViewMode = (mode) => {
    viewMode = mode;
    store.setState('gradebookViewMode', mode);
    renderGradebookView(params, router, container);
  };
  container.querySelector('#btn-view-assignments')?.addEventListener('click', () => setViewMode('assignments'));
  container.querySelector('#btn-view-standards')?.addEventListener('click', () => setViewMode('standards'));
  container.querySelector('#btn-view-roster')?.addEventListener('click', () => setViewMode('roster'));
  renderStandards();
  renderRoster();

  // Term Filter
  container.querySelector('#select-term-filter')?.addEventListener('sl-change', (e) => {
    selectedTermId = e.target.value;
    assignments = selectedTermId === 'all'
      ? allAssignments
      : allAssignments.filter(a => a.term_id === selectedTermId);
    virtualGrid.setData(students, assignments, gradesMap, computeAggregates(), rubrics, activeCourse);
  });

  // Add Student
  container.querySelector('#btn-add-student')?.addEventListener('click', () => {
    openAddStudentModal(activeCourse, async (newStudent) => {
      await storage.table('gradebook_students').put(newStudent);
      toast.success(`Student ${newStudent.full_name} added!`);
      renderGradebookView(params, router, container);
    });
  });

  // Add Assignment
  container.querySelector('#btn-add-assignment')?.addEventListener('click', () => {
    openAssignmentDialog({
      course: activeCourse,
      rubrics,
      onOpenSettings: openSettings,
      onSave: async (newAssignment) => {
        await storage.table('gradebook_assignments').put(newAssignment);
        toast.success(`Assignment "${newAssignment.title}" created!`);
        renderGradebookView(params, router, container);
      }
    });
  });

  // Rubrics Designer Manager
  container.querySelector('#menu-gradebook-rubrics')?.addEventListener('click', () => {
    RubricDesigner.openManagerModal(activeCourse, () => {
      renderGradebookView(params, router, container);
    });
  });

  // Export Gradebook Dialog
  container.querySelector('#menu-export-gradebook')?.addEventListener('click', async () => {
    const cleanCourseName = (activeCourse.name || 'class').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 30);
    const presets = [
      {
        id: 'mail_merge',
        label: 'Mail-merge CSV (with report links)',
        description: 'One row per student: overall grade, letter, missing counts, and private encrypted report links.',
        supportsAccessCodes: true,
        build: async (opts) => {
          const { headers, rows } = await buildGradebookMailMergeRows({
            course: activeCourse,
            students,
            assignments: allAssignments,
            gradesMap,
            rubrics,
            includeAccessCodes: opts.includeAccessCodes
          });
          return { headers, rows, filename: `${cleanCourseName}_mail_merge.csv` };
        }
      },
      {
        id: 'wide_grades',
        label: 'Grades (Wide, round-trippable CSV)',
        description: 'One row per student with columns for every assignment. Fully editable in spreadsheets and re-importable.',
        build: async () => {
          const { headers, rows } = buildGradebookWideRows({
            course: activeCourse,
            students,
            assignments: allAssignments,
            gradesMap
          });
          return { headers, rows, filename: `${cleanCourseName}_grades_wide.csv` };
        }
      },
      {
        id: 'canvas',
        label: 'Canvas Gradebook format',
        description: 'Standard Canvas LMS CSV export format with Points Possible second header row.',
        build: async () => {
          const { headers, rows } = buildCanvasExportRows({
            course: activeCourse,
            students,
            assignments: allAssignments,
            gradesMap
          });
          return { headers, rows, filename: `${cleanCourseName}_canvas_grades.csv` };
        }
      },
      {
        id: 'google_classroom',
        label: 'Google Classroom / SIS (one assignment)',
        description: 'Email Address, Assignment Score, Feedback. Open in Google Sheets, then use Classroom → Grades → Import grades.',
        choice: {
          label: 'Assignment',
          options: allAssignments.map(a => ({ value: a.id, label: `${a.title} (${a.max_score} pts)` }))
        },
        build: async (opts) => {
          const assignment = allAssignments.find(a => a.id === opts.choice) || allAssignments[0];
          if (!assignment) return { headers: [], rows: [], filename: `${cleanCourseName}_classroom.csv` };
          const { headers, rows } = buildGoogleClassroomRows({ assignment, students, gradesMap });
          const cleanTitle = (assignment.title || 'assignment').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 30);
          return { headers, rows, filename: `${cleanCourseName}_${cleanTitle}_classroom.csv` };
        }
      },
      {
        id: 'oneroster',
        label: 'OneRoster 1.1 Results (ZIP)',
        description: 'Generates lineItems.csv and results.csv according to OneRoster 1.1 specification.',
        customAction: {
          label: 'Download ZIP',
          icon: 'file-earmark-zip',
          run: async () => {
            toast.info('Generating OneRoster bundle...');
            const { blob, filename } = await buildOneRosterExportZip({
              course: activeCourse,
              students,
              assignments: allAssignments,
              gradesMap
            });
            downloadBlob(blob, filename);
            toast.success('Downloaded OneRoster bundle.');
          }
        },
        build: async () => {
          const rows = students.map(s => ({
            StudentID: s.student_id,
            FullName: s.full_name,
            AssignmentsCount: allAssignments.length
          }));
          return { headers: ['StudentID', 'FullName', 'AssignmentsCount'], rows, filename: 'oneroster_summary.csv' };
        }
      },
      {
        id: 'roster',
        label: 'Roster CSV',
        description: 'Class roster list with student IDs, names, emails, and notes.',
        supportsAccessCodes: true,
        build: async (opts) => {
          const rows = students.map(s => {
            const parsedName = splitName(s.full_name);
            const row = {
              StudentID: s.student_id,
              FullName: s.full_name,
              FirstName: s.given_name || parsedName.given,
              LastName: s.family_name || parsedName.family,
              Email: s.email || '',
              Class: activeCourse.name,
              Section: activeCourse.section || '',
              AcademicYear: activeCourse.academic_year || '',
              HasAccessCode: s.access_code ? 'Yes' : 'No',
              Notes: s.notes || ''
            };
            if (opts.includeAccessCodes) row.AccessCode = s.access_code || '';
            return row;
          });
          const headers = ['StudentID', 'FullName', 'FirstName', 'LastName', 'Email', 'Class', 'Section', 'AcademicYear', 'HasAccessCode'];
          if (opts.includeAccessCodes) headers.push('AccessCode');
          headers.push('Notes');
          return { headers, rows, filename: `${cleanCourseName}_roster.csv` };
        }
      }
    ];

    await ExportDialog.open({
      title: `Export Gradebook · ${activeCourse.name}`,
      presets
    });
  });

  // Import scores from CSV
  container.querySelector('#menu-import-scores-csv')?.addEventListener('click', async () => {
    await GradesImportDialog.open({
      course: activeCourse,
      students,
      assignments: allAssignments,
      gradesMap,
      onApply: async (changes) => {
        const now = new Date().toISOString();
        for (const change of changes) {
          const currentRec = gradesMap.get(`${change.student_id}+${change.assignment_id}`) || null;
          const updatedRec = {
            ...(currentRec || {}),
            id: currentRec?.id || generateUUID(),
            course_id: activeCourse.id,
            student_id: change.student_id,
            assignment_id: change.assignment_id,
            raw_score: change.after.raw_score,
            status: change.after.status,
            days_late: change.after.extra?.days_late ?? currentRec?.days_late ?? null,
            updated_at: now
          };

          if (virtualGrid) {
            virtualGrid.undoStack.push({
              studentId: change.student_id,
              assignmentId: change.assignment_id,
              previous: currentRec ? JSON.parse(JSON.stringify(currentRec)) : null,
              next: JSON.parse(JSON.stringify(updatedRec))
            });
          }

          await storage.table('gradebook_grades').put(updatedRec);
          gradesMap.set(`${change.student_id}+${change.assignment_id}`, updatedRec);
        }
        renderGradebookView(params, router, container);
      }
    });
  });

  // Batch Roster ZIP Export
  container.querySelector('#menu-batch-zip')?.addEventListener('click', async () => {
    await GradebookReportGenerator.downloadBatchZip(students, activeCourse, assignments, gradesMap);
  });

  // Single PDF Report
  container.querySelector('#menu-single-pdf')?.addEventListener('click', () => {
    openSelectStudentModal(students, (selectedStudent) => {
      const doc = GradebookReportGenerator.generateStudentPDF(selectedStudent, activeCourse, assignments, gradesMap);
      doc.save(`${selectedStudent.student_id}_Report.pdf`);
      toast.success(`Exported PDF report for ${selectedStudent.full_name}!`);
    });
  });

  // Encrypted Student Link
  container.querySelector('#menu-share-student-link')?.addEventListener('click', () => {
    openSelectStudentModal(students, async (selectedStudent) => {
      const linkData = await GradebookReportGenerator.createStudentShareLink(selectedStudent, activeCourse, allAssignments, gradesMap, rubrics);
      showEncryptedLinkDialog(selectedStudent, linkData, () => openSettings('access'));
    });
  });

  // Clone Course Structure
  container.querySelector('#menu-clone-course')?.addEventListener('click', async () => {
    const cloned = {
      ...JSON.parse(JSON.stringify(activeCourse)),
      id: generateUUID(),
      name: `${activeCourse.name} (Section 2)`,
      section: 'New Section',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await storage.table('gradebook_courses').put(cloned);

    // Clone assignment templates
    for (const a of allAssignments) {
      const clonedAssignment = {
        ...JSON.parse(JSON.stringify(a)),
        id: generateUUID(),
        course_id: cloned.id
      };
      await storage.table('gradebook_assignments').put(clonedAssignment);
    }

    toast.success(`Cloned class structure to "${cloned.name}"!`);
    store.setState('activeCourse', cloned);
    ClassManager.setActiveFilter(cloned.id);
    renderGradebookView(params, router, container);
  });

  // New Course Action
  container.querySelector('#menu-new-course')?.addEventListener('click', () => {
    ClassSetupWizard.open({
      onDone: (newCourse) => {
        if (newCourse) {
          store.setState('activeCourse', newCourse);
          ClassManager.setActiveFilter(newCourse.id);
        }
        renderGradebookView(params, router, container);
      }
    });
  });

  // Import Roster Dialog
  container.querySelector('#menu-import-roster-csv')?.addEventListener('click', () => {
    RosterImportDialog.open({
      course: activeCourse,
      onDone: () => renderGradebookView(params, router, container)
    });
  });

  // Batch .kbr Receipt Importer
  const kbrBatchInput = container.querySelector('#input-kbr-batch');
  container.querySelector('#menu-import-kbr-receipts')?.addEventListener('click', () => {
    openSelectAssignmentForKBRModal(assignments, (targetAssignment) => {
      kbrBatchInput.setAttribute('data-target-assignment-id', targetAssignment.id);
      kbrBatchInput.click();
    });
  });

  kbrBatchInput?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const assignmentId = kbrBatchInput.getAttribute('data-target-assignment-id');
    const autoColumns = assignmentId === '__auto';
    const chosenColumn = assignments.find(a => a.id === assignmentId);
    if (!autoColumns && !chosenColumn) return;
    let createdColumns = false;

    const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
    const opened = [];
    for (const file of files) {
      try {
        opened.push({ file: file.name, text: await file.text() });
      } catch (err) {
        opened.push({ file: file.name, text: '' });
      }
    }

    const hasLegacy = opened.some(o => {
      try {
        const p = JSON.parse(o.text);
        return p && p.receipt && !p.kbsub;
      } catch (_) { return false; }
    });

    let includeLegacy = false;
    if (hasLegacy) {
      includeLegacy = await ConfirmDialog.show({
        title: 'Old-format receipts',
        message: 'Some receipts use the old format, where the score inside the file can be edited by the student and can\'t be verified. Import them anyway?',
        confirmText: 'Import anyway',
        cancelText: 'Skip old receipts'
      });
    }

    const { imported: successCount, createdColumns: newCols, problems } = await importVideoReceipts({
      texts: opened,
      course: activeCourse,
      students,
      assignments: allAssignments,
      gradesMap,
      mode: assignmentId,
      allowLegacy: includeLegacy,
      keys
    });
    if (newCols) createdColumns = true;

    virtualGrid.studentAggregates = computeAggregates();
    virtualGrid.renderWindow();
    virtualGrid.renderFooterAverages();

    if (successCount > 0) {
      toast.success(`Imported ${successCount} receipt${successCount === 1 ? '' : 's'}${chosenColumn ? ` into "${chosenColumn.title}"` : ''}.`);
    }
    if (problems.length) {
      const d = document.createElement('sl-dialog');
      d.label = 'Some receipts need attention';
      d.innerHTML = `<ul class="space-y-2 text-sm text-slate-700 list-disc pl-5">${problems.map(p => `<li>${Sanitizer.escapeHTML(p)}</li>`).join('')}</ul>
        <sl-button slot="footer" variant="primary" class="kb-problems-close">OK</sl-button>`;
      document.body.appendChild(d);
      d.show();
      d.querySelector('.kb-problems-close').addEventListener('click', () => d.hide());
      d.addEventListener('sl-after-hide', (ev) => { if (ev.target === d) d.remove(); });
    }
    kbrBatchInput.value = '';
    if (createdColumns) {
      renderGradebookView(params, router, container);
      return;
    }

    kbrBatchInput.value = '';
  });

  return () => {
    // cleanup
  };
}

/**
 * Student Detail & Edit Drawer (Individual Performance & Actions)
 */
async function openStudentDrawer({ student, course, assignments, gradesMap, rubrics = [], onOpenAccess, onUpdateStudent, onDeleteStudent }) {
  const existing = document.getElementById('sl-student-detail-drawer');
  if (existing) existing.remove();

  const drawer = document.createElement('sl-drawer');
  drawer.id = 'sl-student-detail-drawer';
  drawer.label = `Student Profile: ${student.full_name}`;
  drawer.style.setProperty('--size', '560px');

  // Compute student stats
  let totalMissing = 0;
  let totalLate = 0;
  let submittedCount = 0;

  assignments.forEach(a => {
    const key = `${student.student_id}+${a.id}`;
    const rec = gradesMap.get(key);
    if (rec) {
      if (rec.status === 'missing') totalMissing++;
      if (rec.status === 'late') totalLate++;
      if (rec.raw_score !== null) submittedCount++;
    }
  });

  // Query other classes and submissions
  let otherCourses = [];
  let studentSubs = [];
  try {
    const [allStudents, allCourses, allSubs] = await Promise.all([
      storage.table('gradebook_students').where('student_id').equals(student.student_id).toArray(),
      storage.table('gradebook_courses').toArray(),
      storage.table('assignment_submissions').where('student_id').equals(student.student_id).toArray()
    ]);
    otherCourses = allCourses.filter(c => c.id !== course.id && allStudents.some(s => s.course_id === c.id));
    const courseAssignmentIds = new Set(assignments.map(a => a.id));
    studentSubs = allSubs.filter(sub => courseAssignmentIds.has(sub.assignment_id));
  } catch (_) {}

  const split = splitName(student.full_name || '');
  const givenName = student.given_name || split.given_name || '';
  const familyName = student.family_name || split.family_name || '';
  const safeName = Sanitizer.escapeHTML(student.full_name || '');
  const safeId = Sanitizer.escapeHTML(student.student_id || '');
  const safeEmail = Sanitizer.escapeHTML(student.email || '');
  const safeNotes = Sanitizer.escapeHTML(student.notes || '');

  drawer.innerHTML = `
    <div class="space-y-5">
      <!-- Performance Summary Header -->
      <div class="bg-blue-50 border border-blue-200 p-4 rounded-xl flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-xl bg-blue-600 text-white flex items-center justify-center text-xl font-bold font-mono">
            ${safeName.slice(0, 1)}
          </div>
          <div>
            <h3 class="font-bold text-slate-900">${safeName}</h3>
            <span class="text-xs font-mono text-slate-500">${safeId}</span>
          </div>
        </div>
        <div class="text-right">
          <span class="text-xs text-slate-400 block uppercase font-semibold">Submissions</span>
          <span class="text-sm font-bold text-slate-800 font-mono">${submittedCount} / ${assignments.length}</span>
        </div>
      </div>

      ${otherCourses.length > 0 ? `
        <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600">
          <span class="font-semibold text-slate-800 flex items-center gap-1.5 mb-1.5">
            <sl-icon name="info-circle" class="text-blue-500"></sl-icon> Appears in ${otherCourses.length + 1} classes:
          </span>
          <div class="flex flex-wrap gap-1.5">
            <span class="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-semibold">${Sanitizer.escapeHTML(course.name)} (Current)</span>
            ${otherCourses.map(c => `
              <span class="px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">${Sanitizer.escapeHTML(c.name)}${c.section ? ` (${Sanitizer.escapeHTML(c.section)})` : ''}</span>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Quick Badges -->
      <div class="grid grid-cols-2 gap-3 text-center">
        <div class="p-3 border rounded-xl bg-slate-50">
          <span class="text-xs text-slate-400 block font-semibold uppercase">Missing Work</span>
          <span class="text-lg font-bold ${totalMissing > 0 ? 'text-rose-600' : 'text-slate-700'} font-mono">${totalMissing}</span>
        </div>
        <div class="p-3 border rounded-xl bg-slate-50">
          <span class="text-xs text-slate-400 block font-semibold uppercase">Late Submissions</span>
          <span class="text-lg font-bold ${totalLate > 0 ? 'text-amber-600' : 'text-slate-700'} font-mono">${totalLate}</span>
        </div>
      </div>

      <!-- Editable Student Information -->
      <div class="space-y-3 pt-2">
        <div class="grid grid-cols-2 gap-3">
          <sl-input id="input-drawer-given" label="First / Given Name" value="${Sanitizer.escapeHTML(givenName)}"></sl-input>
          <sl-input id="input-drawer-family" label="Last / Family Name" value="${Sanitizer.escapeHTML(familyName)}"></sl-input>
        </div>
        <sl-input id="input-drawer-name" label="Full Name" value="${safeName}"></sl-input>
        <sl-input id="input-drawer-id" label="Student ID / SIS ID" value="${safeId}" readonly></sl-input>
        <sl-input id="input-drawer-email" label="Email Address" type="email" value="${safeEmail}"></sl-input>
        <sl-textarea id="input-drawer-notes" label="Teacher Private Notes" rows="3" placeholder="Notes, IEP accommodations, or parent contact history..." value="${safeNotes}"></sl-textarea>
      </div>

      <!-- Collected Submissions for this course -->
      ${studentSubs.length > 0 ? `
        <div class="space-y-1.5 pt-2 border-t">
          <h4 class="text-xs font-semibold uppercase text-slate-500">Collected Submissions (${studentSubs.length})</h4>
          <div class="max-h-36 overflow-y-auto divide-y divide-slate-100 border rounded-xl bg-white text-xs">
            ${studentSubs.map(sub => {
              const a = assignments.find(x => x.id === sub.assignment_id);
              const title = a ? Sanitizer.escapeHTML(a.title) : 'Assignment';
              const subDate = sub.submitted_at ? new Date(sub.submitted_at).toLocaleDateString() : '';
              return `
                <div class="p-2.5 flex items-center justify-between">
                  <div>
                    <span class="font-medium text-slate-800">${title}</span>
                    <span class="text-[11px] text-slate-400 ml-1.5">${subDate}</span>
                  </div>
                  <span class="font-mono text-slate-600">${Sanitizer.escapeHTML(sub.status || 'submitted')}</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Student access code -->
      <div class="rounded-xl border ${student.access_code ? 'border-slate-200' : 'border-amber-200 bg-amber-50'} p-4 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-semibold text-slate-900 flex items-center gap-2"><sl-icon name="key" class="text-blue-600"></sl-icon> Access code</span>
          <span id="drawer-access-code" class="font-mono tracking-wider text-sm text-slate-800">${student.access_code ? '••••-••••' : '<span class="font-sans text-xs text-amber-700">Not set</span>'}</span>
        </div>
        <p class="text-xs text-slate-500">${student.access_code ? 'The student needs this code to open their grade report and to hand in assignments.' : 'Without a code, the grade report link is locked with the student ID, which classmates may know.'}</p>
        <div class="flex flex-wrap gap-2">
          ${student.access_code ? `
            <sl-button size="small" id="btn-drawer-code-show"><sl-icon slot="prefix" name="eye"></sl-icon> Show</sl-button>
            <sl-button size="small" id="btn-drawer-code-copy"><sl-icon slot="prefix" name="clipboard"></sl-icon> Copy</sl-button>
          ` : ''}
          <sl-button size="small" id="btn-drawer-code-new" ${student.access_code ? '' : 'variant="primary"'}><sl-icon slot="prefix" name="arrow-repeat"></sl-icon> ${student.access_code ? 'New code' : 'Generate code'}</sl-button>
          ${onOpenAccess ? '<sl-button size="small" variant="text" id="btn-drawer-code-all">Manage all codes</sl-button>' : ''}
        </div>
      </div>

      <!-- Quick Action Buttons -->
      <div class="space-y-2 pt-2 border-t">
        <sl-button variant="default" class="w-full" id="btn-drawer-print-pdf">
          <sl-icon slot="prefix" name="file-earmark-pdf"></sl-icon> Export Single Student PDF Report
        </sl-button>
        <sl-button variant="default" class="w-full" id="btn-drawer-copy-link">
          <sl-icon slot="prefix" name="shield-lock"></sl-icon> Create Encrypted Grade Report Link
        </sl-button>
        <sl-button variant="danger" outline class="w-full" id="btn-drawer-del-student">
          <sl-icon slot="prefix" name="trash"></sl-icon> Remove Student from Course
        </sl-button>
      </div>
    </div>

    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-close-drawer">Close</sl-button>
      <sl-button variant="primary" id="btn-save-drawer">Save Changes</sl-button>
    </div>
  `;

  document.body.appendChild(drawer);
  drawer.show();

  drawer.querySelector('#btn-save-drawer')?.addEventListener('click', () => {
    const givenVal = drawer.querySelector('#input-drawer-given')?.value?.trim() || '';
    const familyVal = drawer.querySelector('#input-drawer-family')?.value?.trim() || '';
    let nameVal = drawer.querySelector('#input-drawer-name')?.value?.trim() || '';
    if (!nameVal && (givenVal || familyVal)) {
      nameVal = joinName(givenVal, familyVal);
    }
    const emailVal = drawer.querySelector('#input-drawer-email')?.value?.trim() || '';
    if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
      toast.danger('Please provide a valid email address.');
      return;
    }

    student.full_name = nameVal || student.full_name;
    student.given_name = givenVal || undefined;
    student.family_name = familyVal || undefined;
    student.email = emailVal || undefined;
    student.notes = drawer.querySelector('#input-drawer-notes')?.value?.trim() || undefined;
    drawer.remove();
    onUpdateStudent(student);
    toast.success('Student information updated.');
  });

  drawer.querySelector('#btn-drawer-print-pdf')?.addEventListener('click', () => {
    const doc = GradebookReportGenerator.generateStudentPDF(student, course, assignments, gradesMap);
    doc.save(`${student.student_id}_Report.pdf`);
    toast.success(`Exported PDF report for ${student.full_name}!`);
  });

  drawer.querySelector('#btn-drawer-copy-link')?.addEventListener('click', async () => {
    const linkData = await GradebookReportGenerator.createStudentShareLink(student, course, assignments, gradesMap, rubrics);
    showEncryptedLinkDialog(student, linkData, onOpenAccess);
  });

  drawer.querySelector('#btn-drawer-code-show')?.addEventListener('click', () => {
    const el = drawer.querySelector('#drawer-access-code');
    if (el) el.textContent = student.access_code;
  });
  drawer.querySelector('#btn-drawer-code-copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(student.access_code); toast.success('Access code copied.'); } catch (_) { toast.warning('Copy failed.'); }
  });
  drawer.querySelector('#btn-drawer-code-new')?.addEventListener('click', async () => {
    if (student.access_code) {
      const ok = await ConfirmDialog.show({
        title: 'Replace access code?',
        message: `${Sanitizer.escapeHTML(student.full_name)}'s current code stops working for new links and submissions.`,
        confirmText: 'Generate new code'
      });
      if (!ok) return;
    }
    await AccessCodes.regenerate(student);
    drawer.remove();
    openStudentDrawer({ student, course, assignments, gradesMap, rubrics, onOpenAccess, onUpdateStudent, onDeleteStudent });
    toast.success('New access code generated.');
  });
  drawer.querySelector('#btn-drawer-code-all')?.addEventListener('click', () => {
    drawer.remove();
    onOpenAccess?.();
  });

  drawer.querySelector('#btn-drawer-del-student')?.addEventListener('click', async () => {
    const confirmed = await ConfirmDialog.show({
      title: 'Remove Student',
      message: `Are you sure you want to remove ${Sanitizer.escapeHTML(student.full_name)}? All associated grades for this student will be deleted.`,
      confirmText: 'Remove',
      variant: 'danger'
    });
    if (confirmed) {
      drawer.remove();
      onDeleteStudent(student.id);
    }
  });

  drawer.querySelector('#btn-close-drawer')?.addEventListener('click', () => drawer.hide());
  drawer.addEventListener('sl-after-hide', (e) => { if (e.target === drawer) drawer.remove(); });
}

/**
 * Modal to pick target assignment for batch .kbr import
 */
function openSelectAssignmentForKBRModal(assignments, onSelected) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Select Assignment for .kbr Import';
  dialog.innerHTML = `
    <div class="space-y-3">
      <p class="text-xs text-slate-500">Receipts are decrypted and re-graded on this device, then written to the column you choose.</p>
      <sl-select id="select-kbr-target-as" label="Gradebook column" value="__auto">
        <sl-option value="__auto"><sl-icon slot="prefix" name="magic"></sl-icon> One column per video (recommended)</sl-option>
        <sl-divider></sl-divider>
        ${assignments.map(a => `<sl-option value="${Sanitizer.escapeHTML(a.id)}">${Sanitizer.escapeHTML(a.title)} (max ${Sanitizer.escapeHTML(a.max_score)})</sl-option>`).join('')}
      </sl-select>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-cancel-kbr-sel">Cancel</sl-button>
      <sl-button variant="primary" id="btn-confirm-kbr-sel">Proceed to Select Files</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-confirm-kbr-sel')?.addEventListener('click', () => {
    const asId = dialog.querySelector('#select-kbr-target-as').value;
    const target = asId === '__auto' ? { id: '__auto' } : assignments.find(a => a.id === asId);
    dialog.remove();
    if (target) onSelected(target);
  });

  dialog.querySelector('#btn-cancel-kbr-sel')?.addEventListener('click', () => dialog.remove());
}

function openAddStudentModal(course, onSave) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Add Student to Roster';
  dialog.innerHTML = `
    <div class="space-y-3 py-1 text-sm">
      <div class="grid grid-cols-2 gap-2">
        <sl-input id="input-st-given" label="First Name" placeholder="Jane"></sl-input>
        <sl-input id="input-st-family" label="Last Name" placeholder="Doe"></sl-input>
      </div>
      <sl-input id="input-st-name" label="Student Full Name" placeholder="e.g. Jane Doe" required></sl-input>
      <sl-input id="input-st-id" label="Student ID / SIS ID" placeholder="e.g. S106" required></sl-input>
      <sl-input id="input-st-email" label="Student Email (Optional)" type="email" placeholder="jane.doe@school.edu"></sl-input>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-cancel-st">Cancel</sl-button>
      <sl-button variant="primary" id="btn-save-st">Add Student</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-save-st')?.addEventListener('click', () => {
    const given = dialog.querySelector('#input-st-given')?.value?.trim();
    const family = dialog.querySelector('#input-st-family')?.value?.trim();
    let fullName = dialog.querySelector('#input-st-name')?.value?.trim();
    if (!fullName && (given || family)) {
      fullName = joinName(given, family);
    }
    const studentId = dialog.querySelector('#input-st-id')?.value?.trim();
    const email = dialog.querySelector('#input-st-email')?.value?.trim();

    if (!fullName || !studentId) {
      toast.warning('Name and Student ID are required.');
      return;
    }

    dialog.hide();
    const now = new Date().toISOString();
    onSave({
      id: generateUUID(),
      course_id: course.id,
      student_id: studentId,
      full_name: fullName,
      given_name: given || undefined,
      family_name: family || undefined,
      email: email || undefined,
      created_at: now,
      updated_at: now
    });
  });

  dialog.querySelector('#btn-cancel-st')?.addEventListener('click', () => dialog.hide());
  dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
}

function openSelectStudentModal(students, onSelected) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Select Student';
  dialog.innerHTML = `
    <div class="space-y-3">
      <sl-select id="select-modal-student" label="Student Roster">
        ${students.map(s => `<sl-option value="${Sanitizer.escapeHTML(s.student_id)}">${Sanitizer.escapeHTML(s.full_name)} (${Sanitizer.escapeHTML(s.student_id)})</sl-option>`).join('')}
      </sl-select>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-cancel-sel">Cancel</sl-button>
      <sl-button variant="primary" id="btn-confirm-sel">Select</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-confirm-sel')?.addEventListener('click', () => {
    const sId = dialog.querySelector('#select-modal-student').value;
    const student = students.find(s => s.student_id === sId);
    dialog.remove();
    if (student) onSelected(student);
  });

  dialog.querySelector('#btn-cancel-sel')?.addEventListener('click', () => dialog.remove());
}

function showEncryptedLinkDialog(student, linkData, onOpenAccess) {
  const url = linkData.url;
  const newCode = linkData.generatedAccessCode;
  const dialog = document.createElement('sl-dialog');
  dialog.label = `Grade report link · ${student.full_name}`;
  dialog.style.setProperty('--width', 'min(560px, 96vw)');
  dialog.innerHTML = `
    <div class="space-y-4">
      <div class="rounded-xl border ${newCode ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'} p-3 flex gap-3">
        <sl-icon name="shield-check" class="${newCode ? 'text-amber-600' : 'text-emerald-600'} text-xl flex-shrink-0"></sl-icon>
        <p class="text-xs leading-relaxed text-slate-700">
          Encrypted with AES-256 using ${Sanitizer.escapeHTML(student.full_name)}'s <strong>access code</strong>. Only someone with that code can open it.
          ${newCode ? `<br><strong>${Sanitizer.escapeHTML(student.full_name)} had no access code, so one was just created: <span class="font-mono">${Sanitizer.escapeHTML(newCode)}</span>.</strong> Give it to them privately (or print code slips).` : ''}
        </p>
      </div>
      <sl-input id="input-student-url" value="${Sanitizer.escapeHTML(url)}" readonly label="Private link"></sl-input>
      <p class="text-xs text-slate-500">The link contains only this student's grades and feedback, as of now. Send a new link after updating grades.</p>
    </div>
    <div slot="footer" class="flex flex-wrap justify-end gap-2">
      ${newCode && onOpenAccess ? '<sl-button id="btn-link-codes" variant="text">Manage access codes</sl-button>' : ''}
      <sl-button variant="default" id="btn-show-link-qr"><sl-icon slot="prefix" name="qr-code-scan"></sl-icon> Show QR</sl-button>
      <sl-button id="btn-close-link">Close</sl-button>
      <sl-button variant="primary" id="btn-copy-link"><sl-icon slot="prefix" name="clipboard"></sl-icon> Copy link</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-show-link-qr')?.addEventListener('click', async () => {
    const { showQrSequence } = await import('../../components/qr-handoff.js');
    showQrSequence(url, {
      title: `Grade Report · ${student.full_name}`,
      intro: `Encrypted report for ${student.full_name}. Student can scan this from their device camera or Student Hub.`,
      preferDirectUrl: true
    });
  });

  dialog.querySelector('#btn-copy-link')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Student link copied!');
    } catch (_) {
      toast.warning('Copy failed — select the link and copy it manually.');
    }
  });
  dialog.querySelector('#btn-close-link')?.addEventListener('click', () => dialog.hide());
  dialog.querySelector('#btn-link-codes')?.addEventListener('click', () => { dialog.hide(); onOpenAccess(); });
  dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
}

const RECEIPT_ERROR_TEXT = {
  NOT_FOR_THIS_TEACHER: 'encrypted for a different teacher key (another device or browser profile)',
  CORRUPTED_RECEIPT: 'damaged or incomplete file',
  NOT_A_VIDEO_RECEIPT: 'not a video assessment receipt',
  ASSESSMENT_NOT_FOUND: 'its video assessment is not in your library',
  CRYPTOGRAPHIC_SIGNATURE_MISMATCH: 'contents were changed after it was created',
  CORRUPTED_OR_INVALID_FILE: 'not a readable receipt'
};

function receiptErrorText(code) {
  return RECEIPT_ERROR_TEXT[code] || 'could not be read';
}

export default renderGradebookView;
