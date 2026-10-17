import { storage } from '../../core/storage.js';
import { store } from '../../state/store.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { VirtualGradebookGrid } from './virtual-grid.js';
import { RubricDesigner } from './rubric-builder.js';
import { GradebookReportGenerator } from './report-generator.js';
import { parseCSVWithValidation, GradebookStudentSchema, showImportErrorsDialog } from '../../core/validator.js';
import { openReceipt, IDENTITY_LABELS } from '../video/secure.js';
import { GradebookBridge } from './bridge.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { ClassManager } from '../../components/class-manager.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { computeCourseAggregates } from './aggregates.js';
import { GradeDetailsDrawer } from './grade-drawer.js';
import { openCourseSettingsDialog } from './course-settings.js';
import { openAssignmentDialog } from './assignment-dialog.js';
import { renderStandardsView } from './standards-view.js';
import { AccessCodes } from '../../core/access-codes.js';

/**
 * Multi-Class Gradebook Module Controller & Virtual Grid Manager
 */
export async function renderGradebookView(params, router, container) {
  let courses = await storage.table('gradebook_courses').toArray();

  // If no courses exist, seed initial AP Chemistry course with sample data
  if (courses.length === 0) {
    const initialCourse = {
      id: generateUUID(),
      name: 'AP Chemistry',
      section: 'Period 2 • Lab Room 304',
      academic_year: '2026-2027',
      color: '#2563eb',
      grading_scale: 'traditional', // 'traditional' | 'sbg'
      terms: [
        { id: 'term-1', name: 'Fall Semester', start_date: '2026-09-01', end_date: '2026-12-20', weight_pct: 50 },
        { id: 'term-2', name: 'Spring Semester', start_date: '2027-01-10', end_date: '2027-05-30', weight_pct: 50 }
      ],
      categories: [
        { id: 'cat-tests', name: 'Unit Exams', weight_pct: 50, drop_lowest: 1, policy: { late_mode: 'fixed', late_deduct_pct: 10 } },
        { id: 'cat-labs', name: 'Lab Reports', weight_pct: 30, drop_lowest: 0, policy: { late_mode: 'daily', late_daily_pct: 5, max_late_cap_pct: 20 } },
        { id: 'cat-hw', name: 'Homework & Quizzes', weight_pct: 20, drop_lowest: 2, policy: { missing_floor_pct: 50 } }
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await storage.table('gradebook_courses').put(initialCourse);

    // Seed 5 sample students
    const sampleStudents = [
      { id: generateUUID(), course_id: initialCourse.id, student_id: 'S101', full_name: 'Emma Watson', email: 'ewatson@school.edu', notes: 'Excellent lab partner. Preparing for AP exam.' },
      { id: generateUUID(), course_id: initialCourse.id, student_id: 'S102', full_name: 'Liam Chen', email: 'lchen@school.edu', notes: 'Excels in thermodynamics calculations.' },
      { id: generateUUID(), course_id: initialCourse.id, student_id: 'S103', full_name: 'Sophia Patel', email: 'spatel@school.edu', notes: 'Needs extra review on balancing redox equations.' },
      { id: generateUUID(), course_id: initialCourse.id, student_id: 'S104', full_name: 'Noah Rodriguez', email: 'nrodriguez@school.edu', notes: 'Active classroom contributor.' },
      { id: generateUUID(), course_id: initialCourse.id, student_id: 'S105', full_name: 'Ava Johnson', email: 'ajohnson@school.edu', notes: 'Strong scientific writing skills.' }
    ];
    await storage.table('gradebook_students').bulkPut(sampleStudents);

    // Seed sample Rubric
    const sampleRubric = {
      id: generateUUID(),
      course_id: initialCourse.id,
      title: 'Formal Lab Report Rubric',
      tiers: [
        { id: 't1', label: 'Developing', default_points: 10 },
        { id: 't2', label: 'Proficient', default_points: 20 },
        { id: 't3', label: 'Mastery', default_points: 25 }
      ],
      criteria: [
        {
          id: 'c1',
          name: 'Hypothesis & Method',
          weight: 1.0,
          cells: {
            't1': { points: 10, descriptor: 'Vague hypothesis, incomplete procedure.' },
            't2': { points: 20, descriptor: 'Testable hypothesis, standard procedure.' },
            't3': { points: 25, descriptor: 'Precise hypothesis, rigorous control variables.' }
          }
        },
        {
          id: 'c2',
          name: 'Data & Analysis',
          weight: 1.0,
          cells: {
            't1': { points: 10, descriptor: 'Data recorded with arithmetic errors.' },
            't2': { points: 20, descriptor: 'Accurate tables with units and graphs.' },
            't3': { points: 25, descriptor: 'Thorough statistical error analysis and graphs.' }
          }
        }
      ]
    };
    await storage.table('gradebook_rubrics').put(sampleRubric);

    // Seed 4 sample assignments
    const sampleAssignments = [
      { id: generateUUID(), course_id: initialCourse.id, term_id: 'term-1', category_id: 'cat-tests', title: 'Atomic Structure Exam', max_score: 100, due_date: '2026-09-25' },
      { id: generateUUID(), course_id: initialCourse.id, term_id: 'term-1', category_id: 'cat-labs', rubric_id: sampleRubric.id, title: 'Stoichiometry Lab', max_score: 50, due_date: '2026-10-05' },
      { id: generateUUID(), course_id: initialCourse.id, term_id: 'term-1', category_id: 'cat-hw', title: 'Mole Concept HW', max_score: 20, due_date: '2026-10-10' },
      { id: generateUUID(), course_id: initialCourse.id, term_id: 'term-1', category_id: 'cat-tests', title: 'Chemical Bonding Exam', max_score: 100, due_date: '2026-10-28' }
    ];
    await storage.table('gradebook_assignments').bulkPut(sampleAssignments);

    // Seed sample grades
    const sampleGrades = [
      { course_id: initialCourse.id, student_id: 'S101', assignment_id: sampleAssignments[0].id, raw_score: 95, status: 'submitted' },
      { course_id: initialCourse.id, student_id: 'S101', assignment_id: sampleAssignments[1].id, raw_score: 48, status: 'submitted' },
      { course_id: initialCourse.id, student_id: 'S102', assignment_id: sampleAssignments[0].id, raw_score: 82, status: 'submitted' },
      { course_id: initialCourse.id, student_id: 'S102', assignment_id: sampleAssignments[1].id, raw_score: 40, status: 'late', days_late: 2 },
      { course_id: initialCourse.id, student_id: 'S103', assignment_id: sampleAssignments[0].id, raw_score: 74, status: 'submitted' },
      { course_id: initialCourse.id, student_id: 'S103', assignment_id: sampleAssignments[2].id, raw_score: 0, status: 'missing' }
    ];
    await storage.table('gradebook_grades').bulkPut(sampleGrades);

    courses = [initialCourse];
  }

  // Determine active course
  const activeClassFilter = ClassManager.getActiveFilter();
  let activeCourse = store.getState('activeCourse');

  if (activeClassFilter && activeClassFilter !== 'unassigned') {
    const matched = courses.find(c => c.id === activeClassFilter);
    if (matched) activeCourse = matched;
  }

  if (!activeCourse || !courses.some(c => c.id === activeCourse.id)) {
    activeCourse = courses[0];
  }
  store.setState('activeCourse', activeCourse);

  // Term filtering state
  let selectedTermId = 'all';
  // 'assignments' grid or 'standards' mastery table (standards-based classes)
  let viewMode = store.getState('gradebookViewMode') === 'standards' && activeCourse.grading_scale === 'sbg' ? 'standards' : 'assignments';

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
  const courseColor = activeCourse.color || '#2563eb';

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
                <sl-select id="select-active-course" size="small" value="${activeCourse.id}" class="font-semibold text-slate-900 min-w-0 flex-1 sm:flex-none sm:w-64" aria-label="Active class">
                  ${courses.map(c => `
                    <sl-option value="${c.id}">${Sanitizer.escapeHTML(c.name)}${c.section ? `<span slot="suffix" class="text-xs text-slate-400">${Sanitizer.escapeHTML(c.section)}</span>` : ''}</sl-option>
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
                <span>${safeSection ? `${safeSection} &bull; ` : ''}${activeCourse.academic_year || '2026-2027'} &bull; <span id="header-student-count">${students.length}</span> students &bull; <span id="header-assignment-count">${assignments.length}</span> assignments</span>
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
          <input type="file" id="input-roster-csv" accept=".csv" class="hidden" />
          <input type="file" id="input-kbr-batch" accept=".kbr" multiple class="hidden" />
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 px-4 py-2.5 border-t border-slate-100 bg-slate-50/60 rounded-b-xl">
          ${activeCourse.grading_scale === 'sbg' ? `
            <div class="flex items-center bg-slate-200/60 p-0.5 rounded-lg text-xs" role="group" aria-label="View">
              <button id="btn-view-assignments" class="px-2.5 py-1 rounded-md font-medium transition-colors flex items-center gap-1 ${viewMode === 'assignments' ? 'bg-white text-slate-900 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800'}"><sl-icon name="table"></sl-icon> Assignments</button>
              <button id="btn-view-standards" class="px-2.5 py-1 rounded-md font-medium transition-colors flex items-center gap-1 ${viewMode === 'standards' ? 'bg-white text-slate-900 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800'}"><sl-icon name="bullseye"></sl-icon> Standards</button>
            </div>
          ` : ''}
          ${(activeCourse.terms || []).length > 1 ? `
            <sl-select id="select-term-filter" size="small" value="${selectedTermId}" class="w-40" aria-label="Term">
              <sl-icon slot="prefix" name="calendar3"></sl-icon>
              <sl-option value="all">All terms</sl-option>
              ${activeCourse.terms.map(t => `<sl-option value="${t.id}">${Sanitizer.escapeHTML(t.name)}</sl-option>`).join('')}
            </sl-select>
          ` : ''}
          <div class="flex items-center gap-0.5 ml-auto">
            <button type="button" class="kb-icon-btn !w-8 !h-8" id="btn-grid-undo" title="Undo (Ctrl+Z)" aria-label="Undo"><sl-icon name="arrow-counterclockwise"></sl-icon></button>
            <button type="button" class="kb-icon-btn !w-8 !h-8" id="btn-grid-redo" title="Redo (Ctrl+Y)" aria-label="Redo"><sl-icon name="arrow-clockwise"></sl-icon></button>
          </div>
        </div>
      </div>

      <!-- Standards mastery table (standards-based classes) -->
      <div id="standards-view-mount" class="${viewMode === 'standards' ? '' : 'hidden'}"></div>

      <!-- 2D Virtualized Grid Viewport -->
      <div class="flex flex-col lg:flex-row gap-4 items-start ${viewMode === 'standards' ? 'hidden' : ''}" id="grid-section">
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
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500 no-print ${viewMode === 'standards' ? 'hidden' : ''}" id="grid-hint-bar">
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
          await storage.table('gradebook_grades').where('student_id').equals(student.student_id).delete();
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
          await storage.table('gradebook_grades').where('assignment_id').equals(deletedId).delete();
          toast.info('Assignment deleted.');
          renderGradebookView(params, router, container);
        }
      });
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
  renderStandards();

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
    ClassManager.openClassManagerModal();
  });

  // Import Roster CSV
  const fileInput = container.querySelector('#input-roster-csv');
  container.querySelector('#menu-import-roster-csv')?.addEventListener('click', () => {
    fileInput?.click();
  });

  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const res = parseCSVWithValidation(text, GradebookStudentSchema);
      if (!res.success) {
        showImportErrorsDialog(res.errors);
        return;
      }

      for (const st of res.data) {
        st.id = st.id || generateUUID();
        st.course_id = activeCourse.id;
        await storage.table('gradebook_students').put(st);
      }

      toast.success(`Imported ${res.data.length} students!`);
      renderGradebookView(params, router, container);
    } catch (err) {
      console.error('Import roster error:', err);
      toast.danger('Import failed.');
    } finally {
      fileInput.value = '';
    }
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

    // Open every receipt with this device's teacher key; v2 receipts are re-graded from the
    // local answer key, so the score written into the gradebook never comes from the student.
    const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
    const ctx = {
      teacherPrivateJwk: keys.privateJwk,
      getAssessment: (id) => storage.table('video_assessments').get(id),
      getStudents: (courseId) => storage.table('gradebook_students').where('course_id').equals(courseId).toArray()
    };
    const opened = [];
    for (const file of files) {
      try {
        opened.push({ file: file.name, result: await openReceipt(await file.text(), ctx) });
      } catch (err) {
        opened.push({ file: file.name, result: { ok: false, error: 'CORRUPTED_RECEIPT' } });
      }
    }

    const legacy = opened.filter(o => o.result.ok && o.result.format === 'legacy');
    let includeLegacy = false;
    if (legacy.length) {
      includeLegacy = await ConfirmDialog.show({
        title: 'Old-format receipts',
        message: `${legacy.length} receipt${legacy.length === 1 ? '' : 's'} use the old format, where the score inside the file can be edited by the student and can't be verified. Import ${legacy.length === 1 ? 'it' : 'them'} anyway?`,
        confirmText: 'Import anyway',
        cancelText: 'Skip old receipts'
      });
    }

    const problems = [];
    let successCount = 0;
    for (const { file, result: r } of opened) {
      if (!r.ok) { problems.push(`${file}: ${receiptErrorText(r.error)}`); continue; }
      if (r.format === 'legacy' && !includeLegacy) continue;
      if (autoColumns && r.format === 'legacy') { problems.push(`${file}: old-format receipts need a specific column — import again and choose one`); continue; }

      // Target column: the chosen one, or a column linked to this video (created on first import)
      let targetAssignment = chosenColumn;
      if (autoColumns) {
        targetAssignment = allAssignments.find(a => a.source?.type === 'video' && a.source.id === r.assessment.id);
        if (!targetAssignment) {
          targetAssignment = await GradebookBridge.upsertLinkedColumn({
            courseId: activeCourse.id,
            source: { type: 'video', id: r.assessment.id },
            title: r.assessment.title,
            maxScore: r.max
          });
          allAssignments.push(targetAssignment);
          createdColumns = true;
        }
      }
      if (r.format === 'v2' && targetAssignment.source?.type === 'video' && targetAssignment.source.id !== r.assessment?.id) {
        problems.push(`${file}: receipt is for "${r.assessment?.title}", not this column`);
        continue;
      }

      // Match by student ID first; fall back to name only for legacy receipts without IDs
      const matchedStudent = students.find(s => r.studentId && s.student_id.toLowerCase() === String(r.studentId).toLowerCase())
        || (r.format === 'legacy' ? students.find(s => s.full_name && s.full_name.toLowerCase() === (r.studentName || '').toLowerCase()) : null);
      if (!matchedStudent) { problems.push(`${file}: ${r.studentName || 'unknown student'} is not in this class`); continue; }
      if (r.identity === 'code_mismatch') { problems.push(`${file}: not signed with ${matchedStudent.full_name}'s access code — skipped`); continue; }

      // Scale the video score onto this column's points
      const max = Number(targetAssignment.max_score) || r.max || 1;
      const raw = r.max > 0 ? Math.round((r.earned / r.max) * max * 10) / 10 : 0;
      const key = `${matchedStudent.student_id}+${targetAssignment.id}`;
      const existing = gradesMap.get(key) || {};
      const identityNote = r.format === 'legacy' ? 'old-format receipt, unverified' : (IDENTITY_LABELS[r.identity]?.text || r.identity).toLowerCase();
      const gradeRec = {
        ...existing,
        course_id: activeCourse.id,
        student_id: matchedStudent.student_id,
        assignment_id: targetAssignment.id,
        raw_score: raw,
        status: existing.status === 'late' ? 'late' : 'submitted',
        feedback: existing.feedback || `Video assessment: ${r.earned} / ${r.max} (${r.percent}%) — ${identityNote}.`,
        receipt: { format: r.format, identity: r.identity, completed_at: r.completedAt, earned: r.earned, max: r.max }
      };
      gradesMap.set(key, gradeRec);
      await storage.table('gradebook_grades').put(gradeRec);
      successCount++;
      if (r.identity && !['verified', 'legacy'].includes(r.identity)) {
        problems.push(`${file}: imported, but identity is "${IDENTITY_LABELS[r.identity]?.text || r.identity}"`);
      }
    }

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
function openStudentDrawer({ student, course, assignments, gradesMap, rubrics = [], onOpenAccess, onUpdateStudent, onDeleteStudent }) {
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
        <sl-input id="input-drawer-name" label="Student Full Name" value="${safeName}"></sl-input>
        <sl-input id="input-drawer-id" label="Student ID / SIS ID" value="${safeId}" readonly></sl-input>
        <sl-input id="input-drawer-email" label="Email Address" type="email" value="${safeEmail}"></sl-input>
        <sl-textarea id="input-drawer-notes" label="Teacher Private Notes" rows="3" placeholder="Notes, IEP accommodations, or parent contact history..." value="${safeNotes}"></sl-textarea>
      </div>

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
    student.full_name = drawer.querySelector('#input-drawer-name').value.trim() || student.full_name;
    student.email = drawer.querySelector('#input-drawer-email').value.trim() || undefined;
    student.notes = drawer.querySelector('#input-drawer-notes').value.trim() || undefined;
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
      message: `Are you sure you want to remove ${student.full_name}? All associated grades for this student will be deleted.`,
      confirmText: 'Remove',
      variant: 'danger'
    });
    if (confirmed) {
      drawer.remove();
      onDeleteStudent(student.id);
    }
  });

  drawer.querySelector('#btn-close-drawer')?.addEventListener('click', () => drawer.remove());
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
        ${assignments.map(a => `<sl-option value="${a.id}">${Sanitizer.escapeHTML(a.title)} (max ${a.max_score})</sl-option>`).join('')}
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
    <div class="space-y-3">
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
    const fullName = dialog.querySelector('#input-st-name').value.trim();
    const studentId = dialog.querySelector('#input-st-id').value.trim();
    const email = dialog.querySelector('#input-st-email').value.trim();

    if (!fullName || !studentId) {
      toast.warning('Name and Student ID are required.');
      return;
    }

    dialog.remove();
    onSave({
      id: generateUUID(),
      course_id: course.id,
      student_id: studentId,
      full_name: fullName,
      email: email || undefined
    });
  });

  dialog.querySelector('#btn-cancel-st')?.addEventListener('click', () => dialog.remove());
}

function openSelectStudentModal(students, onSelected) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Select Student';
  dialog.innerHTML = `
    <div class="space-y-3">
      <sl-select id="select-modal-student" label="Student Roster">
        ${students.map(s => `<sl-option value="${s.student_id}">${Sanitizer.escapeHTML(s.full_name)} (${Sanitizer.escapeHTML(s.student_id)})</sl-option>`).join('')}
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
  const strong = !!linkData.usesAccessCode;
  const dialog = document.createElement('sl-dialog');
  dialog.label = `Grade report link · ${student.full_name}`;
  dialog.style.setProperty('--width', 'min(560px, 96vw)');
  dialog.innerHTML = `
    <div class="space-y-4">
      <div class="rounded-xl border ${strong ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'} p-3 flex gap-3">
        <sl-icon name="${strong ? 'shield-check' : 'shield-exclamation'}" class="${strong ? 'text-emerald-600' : 'text-amber-600'} text-xl flex-shrink-0"></sl-icon>
        <p class="text-xs leading-relaxed text-slate-700">
          ${strong
            ? `Encrypted with AES-256 using ${Sanitizer.escapeHTML(student.full_name)}'s <strong>access code</strong>. Only someone with that code can open it.`
            : `Encrypted with the <strong>student ID</strong> (${Sanitizer.escapeHTML(student.student_id)}) because no access code is set. Classmates who know the ID could open it — generate an access code for stronger protection.`}
        </p>
      </div>
      <sl-input id="input-student-url" value="${Sanitizer.escapeHTML(url)}" readonly label="Private link"></sl-input>
      <p class="text-xs text-slate-500">The link contains only this student's grades and feedback, as of now. Send a new link after updating grades.</p>
    </div>
    <div slot="footer" class="flex flex-wrap justify-end gap-2">
      ${!strong && onOpenAccess ? '<sl-button id="btn-link-codes" variant="text">Set up access codes</sl-button>' : ''}
      <sl-button id="btn-close-link">Close</sl-button>
      <sl-button variant="primary" id="btn-copy-link"><sl-icon slot="prefix" name="clipboard"></sl-icon> Copy link</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

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
