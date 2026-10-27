import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { splitName, joinName } from '../../core/names.js';
import { AccessCodes } from '../../core/access-codes.js';
import { generateUUID } from '../../utils/uuid.js';
import { GradebookReportGenerator } from '../gradebook/report-generator.js';
import { stringSimilarity, StudentMatcher } from '../../core/student-matcher.js';

/**
 * Student Actions (KB-CLASS-003)
 * Student profile drawer & Add Student modal for Roster and Classes views.
 */

export async function openAddStudentModal(course, onSave) {
  const [allStudents, allCourses] = await Promise.all([
    storage.table('gradebook_students').toArray().catch(() => []),
    storage.table('gradebook_courses').toArray().catch(() => [])
  ]);

  const courseMap = new Map(allCourses.map(c => [c.id, c.name]));
  const currentClassStudents = allStudents.filter(s => s.course_id === course.id);
  const otherClassStudents = allStudents.filter(s => s.course_id !== course.id);

  // Group unique students from other classes by normalized student_id
  const otherUniqueStudents = [];
  const seenIds = new Set();
  for (const s of otherClassStudents) {
    const key = String(s.student_id || '').trim().toUpperCase();
    if (!key || seenIds.has(key)) continue;
    if (currentClassStudents.some(cs => String(cs.student_id || '').trim().toUpperCase() === key)) continue;
    seenIds.add(key);
    otherUniqueStudents.push(s);
  }

  const dialog = document.createElement('sl-dialog');
  dialog.label = `Add Student to ${course.name || 'Roster'}`;
  dialog.style.setProperty('--width', '540px');

  dialog.innerHTML = `
    <div class="space-y-4 py-1 text-sm">
      ${otherUniqueStudents.length > 0 ? `
        <div class="p-3 bg-blue-50 border border-blue-200 rounded-xl space-y-2">
          <label class="text-xs font-bold text-blue-900 flex items-center gap-1.5">
            <sl-icon name="people"></sl-icon> Enroll Existing Student from Another Class:
          </label>
          <sl-select id="select-existing-st" placeholder="Choose an existing student..." size="small" clearable>
            ${otherUniqueStudents.map(s => `
              <sl-option value="${Sanitizer.escapeHTML(s.student_id)}">
                ${Sanitizer.escapeHTML(s.full_name)} (${Sanitizer.escapeHTML(s.student_id)})${s.course_id ? ` · ${Sanitizer.escapeHTML(courseMap.get(s.course_id) || 'Other Class')}` : ''}
              </sl-option>
            `).join('')}
          </sl-select>
          <p class="text-[11px] text-blue-700">Reuses their student ID, email, and personal access code across your classes.</p>
        </div>
      ` : ''}

      <div class="grid grid-cols-2 gap-2">
        <sl-input id="input-st-given" label="First Name" placeholder="Jane"></sl-input>
        <sl-input id="input-st-family" label="Last Name" placeholder="Doe"></sl-input>
      </div>
      <sl-input id="input-st-name" label="Student Full Name" placeholder="e.g. Jane Doe" required></sl-input>
      <sl-input id="input-st-id" label="Student ID / SIS ID" placeholder="e.g. S106" required></sl-input>
      <sl-input id="input-st-email" label="Student Email (Optional)" type="email" placeholder="jane.doe@school.edu"></sl-input>
      <div id="st-match-feedback" class="text-xs font-medium hidden"></div>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-cancel-st">Cancel</sl-button>
      <sl-button variant="primary" id="btn-save-st">Add Student</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  const selExisting = dialog.querySelector('#select-existing-st');
  const inputGiven = dialog.querySelector('#input-st-given');
  const inputFamily = dialog.querySelector('#input-st-family');
  const inputName = dialog.querySelector('#input-st-name');
  const inputId = dialog.querySelector('#input-st-id');
  const inputEmail = dialog.querySelector('#input-st-email');
  const feedbackEl = dialog.querySelector('#st-match-feedback');

  selExisting?.addEventListener('sl-change', () => {
    const val = selExisting.value;
    if (!val) return;
    const match = otherUniqueStudents.find(s => s.student_id === val);
    if (match) {
      if (inputName) inputName.value = match.full_name || '';
      if (inputGiven) inputGiven.value = match.given_name || '';
      if (inputFamily) inputFamily.value = match.family_name || '';
      if (inputId) inputId.value = match.student_id || '';
      if (inputEmail) inputEmail.value = match.email || '';
      checkDuplicates();
    }
  });

  const checkDuplicates = async () => {
    const sId = inputId?.value?.trim() || '';
    const sName = inputName?.value?.trim() || '';
    const sEmail = inputEmail?.value?.trim() || '';

    if (!feedbackEl) return;
    feedbackEl.className = 'text-xs font-medium hidden';
    feedbackEl.innerHTML = '';

    if (!sId && !sName) return;

    const res = await StudentMatcher.findExistingStudentAcrossClasses({
      studentId: sId,
      fullName: sName,
      email: sEmail,
      currentCourseId: course.id
    });

    if (res.sameClassMatch) {
      feedbackEl.className = 'p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold block';
      feedbackEl.innerHTML = `<sl-icon name="exclamation-octagon" class="mr-1"></sl-icon> Student with ID "${Sanitizer.escapeHTML(res.sameClassMatch.student_id)}" already exists in this class roster.`;
    } else if (res.canonicalCandidate) {
      feedbackEl.className = 'p-2 rounded-lg bg-blue-50 border border-blue-200 text-blue-700 text-xs font-medium block';
      feedbackEl.innerHTML = `<sl-icon name="info-circle" class="mr-1"></sl-icon> Matches ${Sanitizer.escapeHTML(res.canonicalCandidate.full_name)} (${Sanitizer.escapeHTML(res.canonicalCandidate.student_id)}) from another class. Will use their profile and access code.`;
    }
  };

  inputId?.addEventListener('sl-input', checkDuplicates);
  inputName?.addEventListener('sl-input', checkDuplicates);
  inputEmail?.addEventListener('sl-input', checkDuplicates);

  inputName?.addEventListener('sl-change', () => {
    const nameVal = inputName.value.trim();
    if (nameVal && !inputGiven?.value && !inputFamily?.value) {
      const split = splitName(nameVal);
      if (inputGiven && split.given) inputGiven.value = split.given;
      if (inputFamily && split.family) inputFamily.value = split.family;
    }
  });

  dialog.querySelector('#btn-save-st')?.addEventListener('click', async () => {
    const given = inputGiven?.value?.trim();
    const family = inputFamily?.value?.trim();
    let fullName = inputName?.value?.trim();
    if (!fullName && (given || family)) {
      fullName = joinName(given, family);
    }
    const studentId = inputId?.value?.trim();
    const email = inputEmail?.value?.trim();

    if (!fullName || !studentId) {
      toast.warning('Name and Student ID are required.');
      return;
    }

    // Check duplicate in same class
    const res = await StudentMatcher.findExistingStudentAcrossClasses({
      studentId,
      fullName,
      email,
      currentCourseId: course.id
    });

    if (res.sameClassMatch) {
      toast.danger(`A student with ID "${studentId}" is already enrolled in this class.`);
      return;
    }

    dialog.hide();
    const now = new Date().toISOString();
    const accessCode = res.canonicalCandidate?.access_code || AccessCodes.generateCode();

    onSave({
      id: generateUUID(),
      course_id: course.id,
      student_id: studentId,
      full_name: fullName,
      given_name: given || undefined,
      family_name: family || undefined,
      email: email || undefined,
      access_code: accessCode,
      created_at: now,
      updated_at: now
    });
    toast.success(`Enrolled ${fullName} in ${course.name}.`);
  });

  dialog.querySelector('#btn-cancel-st')?.addEventListener('click', () => dialog.hide());
  dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
}

export async function openStudentDrawer({ student, course, assignments = [], gradesMap = new Map(), rubrics = [], onOpenAccess, onUpdateStudent = () => {}, onDeleteStudent = () => {} }) {
  const existing = document.getElementById('sl-student-detail-drawer');
  if (existing) existing.remove();

  const drawer = document.createElement('sl-drawer');
  drawer.id = 'sl-student-detail-drawer';
  drawer.label = `Student Profile: ${student.full_name}`;
  drawer.style.setProperty('--size', '560px');

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

  let otherCourses = [];
  let studentSubs = [];
  try {
    const [allStudents, allCourses, allAssignmentSubs, allTaskSubs] = await Promise.all([
      storage.table('gradebook_students').toArray().catch(() => []),
      storage.table('gradebook_courses').toArray().catch(() => []),
      storage.table('assignment_submissions').toArray().catch(() => []),
      storage.table('task_submissions').toArray().catch(() => [])
    ]);
    const normId = String(student.student_id || '').trim().toLowerCase();
    const matchingStudentRows = allStudents.filter(s => String(s.student_id || '').trim().toLowerCase() === normId);
    otherCourses = allCourses.filter(c => c.id !== course.id && matchingStudentRows.some(s => s.course_id === c.id));
    const courseAssignmentIds = new Set(assignments.map(a => a.id));
    studentSubs = [
      ...allAssignmentSubs.filter(sub => String(sub.student_id || '').trim().toLowerCase() === normId && courseAssignmentIds.has(sub.assignment_id)),
      ...allTaskSubs.filter(sub => String(sub.student_id || '').trim().toLowerCase() === normId && courseAssignmentIds.has(sub.task_id))
    ];
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

      <div class="space-y-2 pt-2 border-t">
        <sl-button variant="default" class="w-full" id="btn-drawer-print-pdf">
          <sl-icon slot="prefix" name="file-earmark-pdf"></sl-icon> Export Single Student PDF Report
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
    student.updated_at = new Date().toISOString();

    // Propagate shared student profile updates across other classes
    storage.table('gradebook_students').toArray().then(async (allRows) => {
      const targetNormId = String(student.student_id || '').trim().toLowerCase();
      for (const row of allRows) {
        if (row.id !== student.id && String(row.student_id || '').trim().toLowerCase() === targetNormId) {
          row.full_name = student.full_name;
          row.given_name = student.given_name;
          row.family_name = student.family_name;
          row.email = student.email;
          if (student.access_code && !row.access_code) row.access_code = student.access_code;
          row.updated_at = new Date().toISOString();
          await storage.table('gradebook_students').put(row);
        }
      }
    }).catch(() => {});

    drawer.remove();
    onUpdateStudent(student);
    toast.success('Student information updated across enrolled classes.');
  });

  drawer.querySelector('#btn-drawer-print-pdf')?.addEventListener('click', () => {
    const doc = GradebookReportGenerator.generateStudentPDF(student, course, assignments, gradesMap);
    doc.save(`${student.student_id}_Report.pdf`);
    toast.success(`Exported PDF report for ${student.full_name}!`);
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

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

/**
 * Merge a duplicate student into a primary student in a course:
 * - Consolidates aliases, previous access codes, and contact info
 * - Re-parents gradebook_grades, assignment_submissions, and task_submissions
 * - Removes the duplicate record
 */
export async function mergeStudents({ courseId, primaryStudent, duplicateStudent }) {
  if (!primaryStudent || !duplicateStudent || primaryStudent.id === duplicateStudent.id) {
    throw new Error('Invalid students for merge.');
  }

  const primId = primaryStudent.student_id;
  const dupId = duplicateStudent.student_id;

  // 1. Merge Aliases
  const aliases = new Set([
    ...(Array.isArray(primaryStudent.aliases) ? primaryStudent.aliases : []),
    ...(Array.isArray(duplicateStudent.aliases) ? duplicateStudent.aliases : []),
    dupId
  ]);
  if (duplicateStudent.full_name && duplicateStudent.full_name !== primaryStudent.full_name) {
    aliases.add(duplicateStudent.full_name);
  }
  aliases.delete(primId);
  primaryStudent.aliases = Array.from(aliases);

  // 2. Merge previous access code hashes
  const prevHashes = new Set([
    ...(Array.isArray(primaryStudent.previous_access_codes) ? primaryStudent.previous_access_codes : []),
    ...(Array.isArray(duplicateStudent.previous_access_codes) ? duplicateStudent.previous_access_codes : [])
  ]);
  if (duplicateStudent.access_code_hash) prevHashes.add(duplicateStudent.access_code_hash);
  primaryStudent.previous_access_codes = Array.from(prevHashes);

  // 3. Merge fields
  if (!primaryStudent.email && duplicateStudent.email) primaryStudent.email = duplicateStudent.email;
  if (!primaryStudent.given_name && duplicateStudent.given_name) primaryStudent.given_name = duplicateStudent.given_name;
  if (!primaryStudent.family_name && duplicateStudent.family_name) primaryStudent.family_name = duplicateStudent.family_name;
  if (!primaryStudent.notes && duplicateStudent.notes) primaryStudent.notes = duplicateStudent.notes;
  primaryStudent.updated_at = new Date().toISOString();

  // 4. Re-parent gradebook_grades
  const dupGrades = await storage.table('gradebook_grades')
    .where('course_id').equals(courseId)
    .toArray()
    .then(grades => grades.filter(g => String(g.student_id).toUpperCase() === String(dupId).toUpperCase()));

  for (const dg of dupGrades) {
    const existingPrimGrade = await storage.table('gradebook_grades').get([primId, dg.assignment_id]);

    if (!existingPrimGrade) {
      await storage.table('gradebook_grades').delete([dg.student_id, dg.assignment_id]).catch(() => {});
      if (dg.id) await storage.table('gradebook_grades').delete(dg.id).catch(() => {});
      dg.student_id = primId;
      dg.updated_at = new Date().toISOString();
      await storage.table('gradebook_grades').put(dg);
    } else {
      // Keep higher score or newer
      if (dg.raw_score !== null && (existingPrimGrade.raw_score === null || dg.raw_score > existingPrimGrade.raw_score)) {
        existingPrimGrade.raw_score = dg.raw_score;
        existingPrimGrade.status = dg.status;
        existingPrimGrade.feedback = dg.feedback || existingPrimGrade.feedback;
        existingPrimGrade.updated_at = new Date().toISOString();
        await storage.table('gradebook_grades').put(existingPrimGrade);
      }
      await storage.table('gradebook_grades').delete([dg.student_id, dg.assignment_id]).catch(() => {});
      if (dg.id) await storage.table('gradebook_grades').delete(dg.id).catch(() => {});
    }
  }

  // 5. Re-parent assignment_submissions
  const dupAsgSubs = await storage.table('assignment_submissions')
    .where('student_id').equals(dupId)
    .toArray();
  for (const s of dupAsgSubs) {
    s.student_id = primId;
    s.student_name = primaryStudent.full_name || primaryStudent.name;
    s.match_type = 'merged';
    s.updated_at = new Date().toISOString();
    await storage.table('assignment_submissions').put(s);
  }

  // 6. Re-parent task_submissions
  const dupTaskSubs = await storage.table('task_submissions')
    .where('student_id').equals(dupId)
    .toArray();
  for (const s of dupTaskSubs) {
    s.student_id = primId;
    s.student_name = primaryStudent.full_name || primaryStudent.name;
    s.match_type = 'merged';
    s.updated_at = new Date().toISOString();
    await storage.table('task_submissions').put(s);
  }

  // 7. Update primary student & delete duplicate
  await storage.table('gradebook_students').put(primaryStudent);
  await storage.table('gradebook_students').delete(duplicateStudent.id);

  return { primaryStudent, duplicateStudent };
}

/**
 * Modal dialog for identifying and merging duplicate students in a course roster.
 */
export function openMergeDuplicatesModal(course, students = [], onMerged) {
  // Find potential duplicate pairs
  const candidatePairs = [];
  for (let i = 0; i < students.length; i++) {
    for (let j = i + 1; j < students.length; j++) {
      const s1 = students[i];
      const s2 = students[j];
      const sim = stringSimilarity(s1.full_name, s2.full_name);
      const emailMatch = s1.email && s2.email && s1.email.toLowerCase() === s2.email.toLowerCase();
      if (sim >= 0.75 || emailMatch) {
        candidatePairs.push({ s1, s2, sim, emailMatch });
      }
    }
  }

  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Merge Duplicate Students';
  dialog.style.setProperty('--width', '640px');

  let bodyHtml = `
    <div class="space-y-4 text-sm">
      <p class="text-xs text-slate-600 leading-relaxed">
        Merging consolidates grades, assessment submissions, task submissions, access codes, and aliases into a single primary student record, then removes the duplicate record.
      </p>
  `;

  if (candidatePairs.length) {
    bodyHtml += `
      <div class="space-y-2">
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">Detected Potential Duplicates (${candidatePairs.length})</h4>
        <div class="space-y-2 max-h-64 overflow-y-auto pr-1">
          ${candidatePairs.map((p, idx) => `
            <div class="p-3 rounded-xl border border-amber-200 bg-amber-50/50 flex items-center justify-between gap-3 text-xs">
              <div class="min-w-0">
                <div class="font-bold text-slate-900">${esc(p.s1.full_name)} <span class="font-mono text-slate-500">(${esc(p.s1.student_id)})</span></div>
                <div class="font-bold text-slate-900 mt-1">${esc(p.s2.full_name)} <span class="font-mono text-slate-500">(${esc(p.s2.student_id)})</span></div>
                <div class="text-[11px] text-amber-800 mt-1">${p.emailMatch ? 'Matching email address' : `${Math.round(p.sim * 100)}% name similarity`}</div>
              </div>
              <sl-button size="small" variant="primary" class="btn-merge-candidate" data-pair-idx="${idx}">
                <sl-icon slot="prefix" name="link-45deg"></sl-icon> Merge
              </sl-button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } else {
    bodyHtml += `
      <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600">
        No obvious duplicates detected by name similarity. You can select any two students manually below.
      </div>
    `;
  }

  bodyHtml += `
      <div class="pt-2 border-t border-slate-200 space-y-3">
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">Manual Student Merge</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <sl-select id="select-primary-student" label="Keep (Primary Record)" placeholder="Choose primary student...">
            ${students.map(s => `<sl-option value="${esc(s.id)}">${esc(s.full_name)} (${esc(s.student_id)})</sl-option>`).join('')}
          </sl-select>
          <sl-select id="select-duplicate-student" label="Merge &amp; Remove (Duplicate)" placeholder="Choose duplicate student...">
            ${students.map(s => `<sl-option value="${esc(s.id)}">${esc(s.full_name)} (${esc(s.student_id)})</sl-option>`).join('')}
          </sl-select>
        </div>
      </div>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button id="btn-merge-cancel">Cancel</sl-button>
      <sl-button variant="primary" id="btn-merge-manual">Merge Selected</sl-button>
    </div>
  `;

  dialog.innerHTML = bodyHtml;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-merge-cancel')?.addEventListener('click', () => dialog.hide());
  dialog.addEventListener('sl-after-hide', (e) => {
    if (e.target !== dialog) return;
    dialog.remove();
  });

  const executeMerge = async (primaryStudent, duplicateStudent) => {
    if (primaryStudent.id === duplicateStudent.id) {
      toast.warning('Please select two different students.');
      return;
    }
    const confirmed = await ConfirmDialog.show({
      title: 'Confirm Student Merge',
      message: `Merge "${Sanitizer.escapeHTML(duplicateStudent.full_name)}" into "${Sanitizer.escapeHTML(primaryStudent.full_name)}"? All grades, submissions, and codes will be moved to ${Sanitizer.escapeHTML(primaryStudent.full_name)} and the duplicate record will be removed.`,
      confirmText: 'Merge Students'
    });
    if (!confirmed) return;

    try {
      await mergeStudents({ courseId: course.id, primaryStudent, duplicateStudent });
      toast.success(`Successfully merged ${duplicateStudent.full_name} into ${primaryStudent.full_name}!`);
      dialog.hide();
      if (typeof onMerged === 'function') onMerged();
    } catch (err) {
      console.error(err);
      toast.danger('Merge failed: ' + err.message);
    }
  };

  dialog.querySelectorAll('.btn-merge-candidate').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.pairIdx, 10);
      const pair = candidatePairs[idx];
      if (pair) executeMerge(pair.s1, pair.s2);
    });
  });

  dialog.querySelector('#btn-merge-manual')?.addEventListener('click', () => {
    const pId = dialog.querySelector('#select-primary-student')?.value;
    const dId = dialog.querySelector('#select-duplicate-student')?.value;
    const pStudent = students.find(s => s.id === pId);
    const dStudent = students.find(s => s.id === dId);
    if (!pStudent || !dStudent) {
      toast.warning('Please choose both a primary and a duplicate student.');
      return;
    }
    executeMerge(pStudent, dStudent);
  });
}
