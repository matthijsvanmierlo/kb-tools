import { storage } from '../../core/storage.js';
import { store } from '../../state/store.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { VirtualGradebookGrid } from './virtual-grid.js';
import { GradebookMathEngine } from './engine-calc.js';
import { RubricScorer } from './rubric-builder.js';
import { GradebookReportGenerator } from './report-generator.js';
import { Exporter, parseCSVWithValidation, GradebookStudentSchema, showImportErrorsDialog } from '../../core/validator.js';

/**
 * Gradebook Module Controller & Virtual Grid Manager
 */
export async function renderGradebookView(params, router, container) {
  let activeCourse = store.getState('activeCourse');

  if (!activeCourse) {
    const courses = await storage.table('gradebook_courses').toArray();
    if (courses.length > 0) {
      activeCourse = courses[0];
    } else {
      // Seed default initial course: AP Chemistry
      activeCourse = {
        id: generateUUID(),
        name: 'AP Chemistry',
        academic_year: '2026-2027',
        grading_scale: 'traditional', // 'traditional' | 'sbg'
        terms: [
          { id: 'term-1', name: 'Fall Semester', start_date: '2026-09-01', end_date: '2026-12-20', weight_pct: 50 },
          { id: 'term-2', name: 'Spring Semester', start_date: '2027-01-10', end_date: '2027-05-30', weight_pct: 50 }
        ],
        categories: [
          { id: 'cat-tests', name: 'Unit Exams', weight_pct: 50, drop_lowest: 1, policy: { late_mode: 'fixed', late_deduct_pct: 10 } },
          { id: 'cat-labs', name: 'Lab Reports', weight_pct: 30, drop_lowest: 0, policy: { late_mode: 'daily', late_daily_pct: 5 } },
          { id: 'cat-hw', name: 'Homework & Quizzes', weight_pct: 20, drop_lowest: 2, policy: { missing_floor_pct: 50 } }
        ]
      };
      await storage.table('gradebook_courses').put(activeCourse);

      // Seed 5 sample students
      const sampleStudents = [
        { id: generateUUID(), course_id: activeCourse.id, student_id: 'S101', full_name: 'Emma Watson', email: 'ewatson@school.edu' },
        { id: generateUUID(), course_id: activeCourse.id, student_id: 'S102', full_name: 'Liam Chen', email: 'lchen@school.edu' },
        { id: generateUUID(), course_id: activeCourse.id, student_id: 'S103', full_name: 'Sophia Patel', email: 'spatel@school.edu' },
        { id: generateUUID(), course_id: activeCourse.id, student_id: 'S104', full_name: 'Noah Rodriguez', email: 'nrodriguez@school.edu' },
        { id: generateUUID(), course_id: activeCourse.id, student_id: 'S105', full_name: 'Ava Johnson', email: 'ajohnson@school.edu' }
      ];
      await storage.table('gradebook_students').bulkPut(sampleStudents);

      // Seed 4 sample assignments
      const sampleAssignments = [
        { id: generateUUID(), course_id: activeCourse.id, term_id: 'term-1', category_id: 'cat-tests', title: 'Atomic Structure Exam', max_score: 100, due_date: '2026-09-25' },
        { id: generateUUID(), course_id: activeCourse.id, term_id: 'term-1', category_id: 'cat-labs', title: 'Stoichiometry Lab', max_score: 50, due_date: '2026-10-05' },
        { id: generateUUID(), course_id: activeCourse.id, term_id: 'term-1', category_id: 'cat-hw', title: 'Mole Concept HW', max_score: 20, due_date: '2026-10-10' },
        { id: generateUUID(), course_id: activeCourse.id, term_id: 'term-1', category_id: 'cat-tests', title: 'Chemical Bonding Exam', max_score: 100, due_date: '2026-10-28' }
      ];
      await storage.table('gradebook_assignments').bulkPut(sampleAssignments);

      // Seed sample grades
      const sampleGrades = [
        { course_id: activeCourse.id, student_id: 'S101', assignment_id: sampleAssignments[0].id, raw_score: 95, status: 'submitted' },
        { course_id: activeCourse.id, student_id: 'S101', assignment_id: sampleAssignments[1].id, raw_score: 48, status: 'submitted' },
        { course_id: activeCourse.id, student_id: 'S102', assignment_id: sampleAssignments[0].id, raw_score: 82, status: 'submitted' },
        { course_id: activeCourse.id, student_id: 'S102', assignment_id: sampleAssignments[1].id, raw_score: 40, status: 'late', days_late: 2 },
        { course_id: activeCourse.id, student_id: 'S103', assignment_id: sampleAssignments[0].id, raw_score: 74, status: 'submitted' },
        { course_id: activeCourse.id, student_id: 'S103', assignment_id: sampleAssignments[2].id, raw_score: 0, status: 'missing' }
      ];
      await storage.table('gradebook_grades').bulkPut(sampleGrades);

      // Seed sample Rubric
      const sampleRubric = {
        id: generateUUID(),
        course_id: activeCourse.id,
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
    }
  }

  // Fetch course data
  const students = (await storage.table('gradebook_students').toArray())
    .filter(s => s.course_id === activeCourse.id);
  const assignments = (await storage.table('gradebook_assignments').toArray())
    .filter(a => a.course_id === activeCourse.id);
  const gradesList = (await storage.table('gradebook_grades').toArray())
    .filter(g => g.course_id === activeCourse.id);
  const rubrics = (await storage.table('gradebook_rubrics').toArray())
    .filter(r => r.course_id === activeCourse.id);

  const gradesMap = new Map();
  gradesList.forEach(g => {
    gradesMap.set(`${g.student_id}+${g.assignment_id}`, g);
  });

  // Calculate aggregates
  const computeAggregates = () => {
    const aggMap = new Map();
    students.forEach(student => {
      const studentRecords = new Map();
      assignments.forEach(a => {
        const key = `${student.student_id}+${a.id}`;
        const rec = gradesMap.get(key);
        if (rec) studentRecords.set(a.id, rec);
      });

      if (activeCourse.grading_scale === 'sbg') {
        const scores = Array.from(studentRecords.values())
          .filter(r => r.raw_score !== null)
          .map(r => r.raw_score);
        const mastery = GradebookMathEngine.computeMarzanoPowerLaw(scores) || GradebookMathEngine.computeDecayingAverage(scores) || 0;
        const grade = GradebookMathEngine.masteryToGrade(mastery);
        aggMap.set(student.student_id, { score: grade.percent, letter: grade.letter });
      } else {
        const pct = GradebookMathEngine.computeTraditionalWeighted(studentRecords, assignments, activeCourse.categories || []);
        const letter = GradebookMathEngine.percentageToLetter(pct);
        aggMap.set(student.student_id, { score: pct, letter });
      }
    });
    return aggMap;
  };

  const studentAggregates = computeAggregates();

  container.innerHTML = `
    <div class="space-y-4">
      <!-- Top Action Dock -->
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <div class="flex items-center gap-3">
          <sl-icon name="journal-bookmark" class="text-2xl text-blue-600"></sl-icon>
          <div>
            <h2 class="font-bold text-slate-900 text-lg">${activeCourse.name}</h2>
            <p class="text-xs text-slate-500">${activeCourse.academic_year || '2026-2027'} &bull; ${students.length} Students &bull; ${assignments.length} Assignments</p>
          </div>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <!-- Scale Switcher -->
          <div class="flex items-center bg-slate-100 p-0.5 rounded-lg text-xs">
            <button id="btn-scale-trad" class="px-2.5 py-1 rounded-md font-medium transition-colors ${activeCourse.grading_scale === 'traditional' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600'}">
              Traditional
            </button>
            <button id="btn-scale-sbg" class="px-2.5 py-1 rounded-md font-medium transition-colors ${activeCourse.grading_scale === 'sbg' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600'}">
              SBG (Marzano)
            </button>
          </div>

          <sl-button size="small" id="btn-add-student">
            <sl-icon slot="prefix" name="person-plus"></sl-icon> Student
          </sl-button>
          <sl-button size="small" id="btn-add-assignment" variant="primary">
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> Assignment
          </sl-button>

          <!-- Export & Batch Dropdown -->
          <sl-dropdown placement="bottom-end">
            <sl-button slot="trigger" size="small" caret>Reports</sl-button>
            <sl-menu>
              <sl-menu-item id="menu-batch-zip">
                <sl-icon slot="prefix" name="file-earmark-zip"></sl-icon> Export Roster Batch ZIP
              </sl-menu-item>
              <sl-menu-item id="menu-single-pdf">
                <sl-icon slot="prefix" name="file-earmark-pdf"></sl-icon> Print Student PDF Report...
              </sl-menu-item>
              <sl-menu-item id="menu-share-student-link">
                <sl-icon slot="prefix" name="shield-lock"></sl-icon> Encrypted Student Link...
              </sl-menu-item>
              <sl-divider></sl-divider>
              <sl-menu-item id="menu-gradebook-rubrics">
                <sl-icon slot="prefix" name="grid-3x3"></sl-icon> Rubrics Designer
              </sl-menu-item>
              <sl-menu-item id="menu-import-roster-csv">
                <sl-icon slot="prefix" name="upload"></sl-icon> Import Roster CSV...
              </sl-menu-item>
            </sl-menu>
          </sl-dropdown>
          <input type="file" id="input-roster-csv" accept=".csv" class="hidden" />
        </div>
      </div>

      <!-- 2D Virtualized Grid Viewport -->
      <div id="grid-mount-container"></div>
    </div>
  `;

  const gridMount = container.querySelector('#grid-mount-container');
  const virtualGrid = new VirtualGradebookGrid(gridMount, {
    students,
    assignments,
    gradesMap,
    studentAggregates,
    onGradeChange: async (record) => {
      await storage.table('gradebook_grades').put(record);
      // Recompute aggregates
      const updatedAggregates = computeAggregates();
      virtualGrid.studentAggregates = updatedAggregates;
      virtualGrid.renderWindow();
    }
  });

  // Scale switchers
  container.querySelector('#btn-scale-trad')?.addEventListener('click', async () => {
    activeCourse.grading_scale = 'traditional';
    await storage.table('gradebook_courses').put(activeCourse);
    renderGradebookView(params, router, container);
  });

  container.querySelector('#btn-scale-sbg')?.addEventListener('click', async () => {
    activeCourse.grading_scale = 'sbg';
    await storage.table('gradebook_courses').put(activeCourse);
    renderGradebookView(params, router, container);
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
    openAddAssignmentModal(activeCourse, rubrics, async (newAssignment) => {
      await storage.table('gradebook_assignments').put(newAssignment);
      toast.success(`Assignment "${newAssignment.title}" created!`);
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
      const linkData = await GradebookReportGenerator.createStudentShareLink(selectedStudent, activeCourse, assignments, gradesMap);

      const dialog = document.createElement('sl-dialog');
      dialog.label = `Zero-Server Student Link: ${selectedStudent.full_name}`;
      dialog.innerHTML = `
        <div class="space-y-3">
          <p class="text-xs text-slate-500">
            This private URL is encrypted using AES-256 with the student's ID (<strong>${selectedStudent.student_id}</strong>).
            Classmates cannot decrypt or view this report.
          </p>
          <sl-input id="input-student-url" value="${linkData.url}" readonly></sl-input>
        </div>
        <div slot="footer" class="flex justify-end gap-2">
          <sl-button variant="default" id="btn-close-link">Close</sl-button>
          <sl-button variant="primary" id="btn-copy-link">Copy Encrypted Link</sl-button>
        </div>
      `;
      document.body.appendChild(dialog);
      dialog.show();

      dialog.querySelector('#btn-copy-link')?.addEventListener('click', () => {
        navigator.clipboard.writeText(linkData.url);
        toast.success('Student link copied!');
      });
      dialog.querySelector('#btn-close-link')?.addEventListener('click', () => dialog.remove());
    });
  });

  // Rubrics Designer Modal
  container.querySelector('#menu-gradebook-rubrics')?.addEventListener('click', () => {
    if (rubrics.length > 0) {
      RubricScorer.openScoringDrawer(rubrics[0], null, (result) => {
        toast.success(`Scored: ${result.raw_score} / ${result.max_score} pts`);
      });
    } else {
      toast.info('No rubrics attached to this course.');
    }
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

  return () => {
    // cleanup
  };
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

function openAddAssignmentModal(course, rubrics, onSave) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Create New Assignment';
  dialog.innerHTML = `
    <div class="space-y-3">
      <sl-input id="input-as-title" label="Assignment Title" placeholder="e.g. Chapter 4 Quiz" required></sl-input>
      <div class="grid grid-cols-2 gap-3">
        <sl-select id="select-as-cat" label="Category" value="${course.categories?.[0]?.id || ''}">
          ${(course.categories || []).map(c => `<sl-option value="${c.id}">${c.name} (${c.weight_pct}%)</sl-option>`).join('')}
        </sl-select>
        <sl-input id="input-as-max" label="Max Points" type="number" value="100" min="1"></sl-input>
      </div>
      <sl-input id="input-as-due" label="Due Date" type="date" value="${new Date().toISOString().split('T')[0]}"></sl-input>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-cancel-as">Cancel</sl-button>
      <sl-button variant="primary" id="btn-save-as">Create Assignment</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-save-as')?.addEventListener('click', () => {
    const title = dialog.querySelector('#input-as-title').value.trim();
    const catId = dialog.querySelector('#select-as-cat').value;
    const maxScore = Number(dialog.querySelector('#input-as-max').value) || 100;
    const dueDate = dialog.querySelector('#input-as-due').value;

    if (!title) {
      toast.warning('Assignment title is required.');
      return;
    }

    dialog.remove();
    onSave({
      id: generateUUID(),
      course_id: course.id,
      term_id: course.terms?.[0]?.id || 'term-1',
      category_id: catId,
      title,
      max_score: maxScore,
      due_date: dueDate
    });
  });

  dialog.querySelector('#btn-cancel-as')?.addEventListener('click', () => dialog.remove());
}

function openSelectStudentModal(students, onSelected) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Select Student';
  dialog.innerHTML = `
    <div class="space-y-3">
      <sl-select id="select-modal-student" label="Student Roster">
        ${students.map(s => `<sl-option value="${s.student_id}">${s.full_name} (${s.student_id})</sl-option>`).join('')}
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

export default renderGradebookView;
