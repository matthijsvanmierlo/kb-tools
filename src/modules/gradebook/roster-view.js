import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { splitName, sortKey } from '../../core/names.js';
import { AccessCodes } from '../../core/access-codes.js';
import { exportRosterCSV } from '../../core/roster-import.js';
import { downloadCSV } from '../../core/csv.js';
import { RosterImportDialog } from '../../components/roster-import-dialog.js';
import { GradebookReportGenerator } from './report-generator.js';
import { openMergeDuplicatesModal } from '../classes/student-actions.js';

/**
 * Render the dedicated Roster View inside Gradebook
 * @param {object} opts
 * @param {HTMLElement} opts.container
 * @param {object} opts.course
 * @param {Array<object>} opts.students
 * @param {Array<object>} opts.allAssignments
 * @param {Map<string, object>} opts.gradesMap
 * @param {object} opts.studentAggregates
 * @param {Function} opts.onRefresh
 * @param {Function} opts.onOpenStudentDrawer
 * @param {Function} [opts.onOpenAccess]
 * @param {Function} [opts.onAddStudent]
 */
export async function renderRosterView({
  container,
  course,
  students,
  allAssignments,
  gradesMap,
  studentAggregates,
  onRefresh,
  onOpenStudentDrawer,
  onOpenAccess,
  onAddStudent
}) {
  // Fetch assignment & task submissions to count hand-ins
  let allAssignmentSubs = [];
  let allTaskSubs = [];
  try {
    [allAssignmentSubs, allTaskSubs] = await Promise.all([
      storage.table('assignment_submissions').toArray().catch(() => []),
      storage.table('task_submissions').toArray().catch(() => [])
    ]);
  } catch (err) {
    allAssignmentSubs = [];
    allTaskSubs = [];
  }

  // Find assignment and task IDs linked to this course
  const courseAssignmentIds = new Set(
    allAssignments.map(a => a.id)
  );

  // Compute student stats
  const studentStats = new Map();
  for (const s of students) {
    const sId = String(s.student_id).toUpperCase();
    // Submissions for this student on assignments & tasks in this course
    const studentSubs = [
      ...allAssignmentSubs.filter(sub =>
        String(sub.student_id).toUpperCase() === sId &&
        courseAssignmentIds.has(sub.assignment_id) &&
        sub.is_latest !== false
      ),
      ...allTaskSubs.filter(sub =>
        String(sub.student_id).toUpperCase() === sId &&
        courseAssignmentIds.has(sub.task_id) &&
        sub.is_latest !== false
      )
    ];

    // Also count video receipts in gradebook_grades
    let receiptCount = 0;
    let latestTimestamp = null;

    for (const sub of studentSubs) {
      if (sub.submitted_at) {
        if (!latestTimestamp || sub.submitted_at > latestTimestamp) {
          latestTimestamp = sub.submitted_at;
        }
      }
    }

    allAssignments.forEach(a => {
      const g = gradesMap.get(`${s.student_id}+${a.id}`);
      if (g && g.receipt) {
        receiptCount++;
        const ts = g.updated_at || g.created_at;
        if (ts && (!latestTimestamp || ts > latestTimestamp)) {
          latestTimestamp = ts;
        }
      }
    });

    const handinCount = studentSubs.length + receiptCount;
    const agg = studentAggregates?.[s.student_id] || {};

    studentStats.set(s.student_id, {
      handinCount,
      latestTimestamp,
      gradePercent: agg.percent !== undefined ? agg.percent : null,
      gradeLetter: agg.letter || '—',
      missingCount: agg.missingCount || 0
    });
  }

  // Local state
  let searchQuery = '';
  let sortField = 'name'; // 'name', 'id', 'handins', 'grade'
  let sortDirection = 'asc';
  let revealedCodes = new Set();
  let selectedStudentIds = new Set();

  function sortStudents(list) {
    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'name') {
        cmp = sortKey(a.full_name).localeCompare(sortKey(b.full_name));
      } else if (sortField === 'id') {
        cmp = String(a.student_id).localeCompare(String(b.student_id), undefined, { numeric: true });
      } else if (sortField === 'handins') {
        const hA = studentStats.get(a.student_id)?.handinCount || 0;
        const hB = studentStats.get(b.student_id)?.handinCount || 0;
        cmp = hA - hB;
      } else if (sortField === 'grade') {
        const gA = studentStats.get(a.student_id)?.gradePercent ?? -1;
        const gB = studentStats.get(b.student_id)?.gradePercent ?? -1;
        cmp = gA - gB;
      }
      return sortDirection === 'desc' ? -cmp : cmp;
    });
  }

  function filterStudents(list) {
    if (!searchQuery.trim()) return list;
    const q = searchQuery.trim().toLowerCase();
    return list.filter(s =>
      (s.full_name && s.full_name.toLowerCase().includes(q)) ||
      (s.student_id && s.student_id.toLowerCase().includes(q)) ||
      (s.email && s.email.toLowerCase().includes(q))
    );
  }

  function renderTable() {
    const filtered = filterStudents(students);
    const sorted = sortStudents(filtered);
    const allSelected = sorted.length > 0 && sorted.every(s => selectedStudentIds.has(s.student_id));

    container.innerHTML = `
      <div class="space-y-3">
        <!-- Toolbar -->
        <div class="flex flex-wrap items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200 shadow-xs">
          <div class="flex items-center gap-2 flex-1 min-w-[240px] max-w-md">
            <sl-input id="roster-search" placeholder="Search students by name, ID, or email..." size="small" class="w-full" value="${Sanitizer.escapeHTML(searchQuery)}" clearable>
              <sl-icon slot="prefix" name="search"></sl-icon>
            </sl-input>
          </div>

          <div class="flex items-center gap-2 flex-wrap">
            <sl-button size="small" variant="primary" id="btn-roster-add-student">
              <sl-icon slot="prefix" name="person-plus"></sl-icon> Add Student
            </sl-button>
            <sl-button size="small" variant="default" id="btn-roster-merge-dups">
              <sl-icon slot="prefix" name="people"></sl-icon> Merge Duplicates
            </sl-button>
            <sl-button size="small" variant="default" id="btn-roster-import">
              <sl-icon slot="prefix" name="upload"></sl-icon> Import Roster...
            </sl-button>

            <sl-dropdown placement="bottom-end">
              <sl-button slot="trigger" size="small" caret>Export</sl-button>
              <sl-menu id="menu-roster-export">
                <sl-menu-item value="export-csv">
                  <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Export Roster CSV
                </sl-menu-item>
                <sl-menu-item value="export-csv-codes">
                  <sl-icon slot="prefix" name="key"></sl-icon> Export CSV with Access Codes...
                </sl-menu-item>
                <sl-menu-item value="print-slips">
                  <sl-icon slot="prefix" name="printer"></sl-icon> Print Access Code Slips
                </sl-menu-item>
              </sl-menu>
            </sl-dropdown>
          </div>
        </div>

        <!-- Bulk Action Bar -->
        ${selectedStudentIds.size > 0 ? `
          <div class="flex items-center justify-between p-2.5 px-4 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-900 animate-fade-in">
            <div class="font-medium">
              <span>${selectedStudentIds.size}</span> student${selectedStudentIds.size > 1 ? 's' : ''} selected
            </div>
            <div class="flex items-center gap-2">
              <sl-button size="small" variant="default" id="btn-bulk-codes">
                <sl-icon slot="prefix" name="key"></sl-icon> Generate Codes
              </sl-button>
              <sl-button size="small" variant="danger" outline id="btn-bulk-remove">
                <sl-icon slot="prefix" name="trash"></sl-icon> Remove
              </sl-button>
              <sl-button size="small" variant="text" id="btn-bulk-deselect">Deselect All</sl-button>
            </div>
          </div>
        ` : ''}

        <!-- Table View -->
        <div class="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-xs">
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs border-collapse">
              <thead class="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200 select-none">
                <tr>
                  <th class="p-3 w-10 text-center">
                    <input type="checkbox" id="roster-select-all" ${allSelected ? 'checked' : ''} class="rounded border-slate-300 cursor-pointer">
                  </th>
                  <th class="p-3 cursor-pointer hover:bg-slate-100 transition-colors" data-sort="name">
                    <span class="inline-flex items-center gap-1">
                      Student Name
                      ${sortField === 'name' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </span>
                  </th>
                  <th class="p-3 cursor-pointer hover:bg-slate-100 transition-colors" data-sort="id">
                    <span class="inline-flex items-center gap-1">
                      Student ID
                      ${sortField === 'id' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </span>
                  </th>
                  <th class="p-3">Email</th>
                  <th class="p-3">Access Code</th>
                  <th class="p-3 cursor-pointer hover:bg-slate-100 transition-colors text-center" data-sort="handins">
                    <span class="inline-flex items-center gap-1">
                      Hand-ins
                      ${sortField === 'handins' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </span>
                  </th>
                  <th class="p-3">Last Hand-in</th>
                  <th class="p-3 cursor-pointer hover:bg-slate-100 transition-colors text-right" data-sort="grade">
                    <span class="inline-flex items-center gap-1 justify-end">
                      Current Grade
                      ${sortField === 'grade' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </span>
                  </th>
                  <th class="p-3 w-12 text-center">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                ${sorted.length === 0 ? `
                  <tr>
                    <td colspan="9" class="p-8 text-center text-slate-400">
                      <sl-icon name="people" class="text-3xl mb-2 text-slate-300"></sl-icon>
                      <p>${searchQuery ? 'No students match your search.' : 'No students in this class yet. Click "Add Student" or "Import Roster" to get started!'}</p>
                    </td>
                  </tr>
                ` : sorted.map(s => {
                  const stats = studentStats.get(s.student_id) || {};
                  const isRevealed = revealedCodes.has(s.student_id);
                  const isChecked = selectedStudentIds.has(s.student_id);
                  const safeName = Sanitizer.escapeHTML(s.full_name || '');
                  const safeId = Sanitizer.escapeHTML(s.student_id || '');
                  const safeEmail = Sanitizer.escapeHTML(s.email || '—');
                  const lastDate = stats.latestTimestamp ? new Date(stats.latestTimestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
                  const gradeStr = stats.gradePercent !== null ? `${Sanitizer.escapeHTML(stats.gradePercent)}%` : '—';
                  const letterStr = stats.gradeLetter && stats.gradeLetter !== '—' ? `(${Sanitizer.escapeHTML(stats.gradeLetter)})` : '';

                  return `
                    <tr class="hover:bg-slate-50 transition-colors ${isChecked ? 'bg-blue-50/40' : ''}">
                      <td class="p-3 text-center">
                        <input type="checkbox" class="roster-chk-row rounded border-slate-300 cursor-pointer" data-id="${safeId}" ${isChecked ? 'checked' : ''}>
                      </td>
                      <td class="p-3">
                        <button type="button" class="btn-open-student text-left font-semibold text-blue-600 hover:text-blue-800 hover:underline cursor-pointer" data-id="${safeId}">
                          ${safeName}
                        </button>
                      </td>
                      <td class="p-3 font-mono text-slate-600">${safeId}</td>
                      <td class="p-3 text-slate-500 truncate max-w-[150px]" title="${safeEmail}">${safeEmail}</td>
                      <td class="p-3">
                        ${s.access_code ? `
                          <div class="inline-flex items-center gap-1 font-mono text-slate-700">
                            <span>${isRevealed ? Sanitizer.escapeHTML(s.access_code) : '••••-••••'}</span>
                            <button type="button" class="btn-toggle-code text-slate-400 hover:text-slate-600 p-0.5 rounded cursor-pointer" data-id="${safeId}" title="${isRevealed ? 'Hide code' : 'Show code'}">
                              <sl-icon name="${isRevealed ? 'eye-slash' : 'eye'}"></sl-icon>
                            </button>
                            <button type="button" class="btn-copy-code text-slate-400 hover:text-slate-600 p-0.5 rounded cursor-pointer" data-code="${Sanitizer.escapeHTML(s.access_code)}" title="Copy code">
                              <sl-icon name="clipboard"></sl-icon>
                            </button>
                          </div>
                        ` : `
                          <button type="button" class="btn-gen-code px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[11px] font-medium hover:bg-amber-200 cursor-pointer" data-id="${safeId}">
                            + Generate
                          </button>
                        `}
                      </td>
                      <td class="p-3 text-center">
                        <span class="inline-block px-2 py-0.5 rounded-full font-medium ${stats.handinCount > 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}">
                          ${Sanitizer.escapeHTML(stats.handinCount)}
                        </span>
                      </td>
                      <td class="p-3 text-slate-500">${lastDate}</td>
                      <td class="p-3 text-right">
                        <span class="font-semibold text-slate-800">${gradeStr}</span>
                        ${letterStr ? `<span class="text-slate-500 font-medium ml-1">${letterStr}</span>` : ''}
                      </td>
                      <td class="p-3 text-center">
                        <sl-dropdown placement="bottom-end">
                          <button slot="trigger" type="button" class="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer" aria-label="Student actions">
                            <sl-icon name="three-dots-vertical"></sl-icon>
                          </button>
                          <sl-menu class="roster-row-menu" data-id="${safeId}">
                            <sl-menu-item value="profile">
                              <sl-icon slot="prefix" name="person-badge"></sl-icon> Student Profile
                            </sl-menu-item>
                            <sl-menu-item value="report-link">
                              <sl-icon slot="prefix" name="shield-lock"></sl-icon> Encrypted Report Link
                            </sl-menu-item>
                            <sl-menu-item value="report-pdf">
                              <sl-icon slot="prefix" name="file-earmark-pdf"></sl-icon> Export PDF Report
                            </sl-menu-item>
                            <sl-divider></sl-divider>
                            <sl-menu-item value="remove" class="text-rose-600">
                              <sl-icon slot="prefix" name="trash"></sl-icon> Remove from Class
                            </sl-menu-item>
                          </sl-menu>
                        </sl-dropdown>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
          <div class="px-4 py-2 border-t border-slate-100 bg-slate-50 text-xs text-slate-500 flex justify-between items-center">
            <span>Showing ${filtered.length} of ${students.length} student${students.length === 1 ? '' : 's'}</span>
            <span class="text-slate-400">Sorted by ${Sanitizer.escapeHTML(sortField)} (${Sanitizer.escapeHTML(sortDirection)})</span>
          </div>
        </div>
      </div>
    `;

    bindEvents();
  }

  function bindEvents() {
    // Search input
    const searchInput = container.querySelector('#roster-search');
    searchInput?.addEventListener('sl-input', (e) => {
      searchQuery = e.target.value;
      renderTable();
    });
    searchInput?.addEventListener('sl-clear', () => {
      searchQuery = '';
      renderTable();
    });

    // Sort handlers
    container.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (sortField === field) {
          sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          sortField = field;
          sortDirection = 'asc';
        }
        renderTable();
      });
    });

    // Add student
    container.querySelector('#btn-roster-add-student')?.addEventListener('click', () => {
      if (onAddStudent) {
        onAddStudent();
      }
    });

    // Merge duplicates
    container.querySelector('#btn-roster-merge-dups')?.addEventListener('click', () => {
      openMergeDuplicatesModal(course, students, () => onRefresh());
    });

    // Import roster
    container.querySelector('#btn-roster-import')?.addEventListener('click', () => {
      RosterImportDialog.open({
        course,
        onDone: () => onRefresh()
      });
    });

    // Export menu
    container.querySelector('#menu-roster-export')?.addEventListener('sl-select', async (e) => {
      const val = e.detail.item.value;
      if (val === 'export-csv') {
        const csv = exportRosterCSV(students, course, { includeAccessCode: false });
        downloadCSV(`${course.name.replace(/[^a-z0-9]+/gi, '_')}_roster.csv`, csv);
        toast.success('Roster CSV downloaded.');
      } else if (val === 'export-csv-codes') {
        const ok = await ConfirmDialog.show({
          title: 'Export Access Codes?',
          message: 'Access codes are secrets that unlock private student reports and sign submissions. Only export them if you will store this file securely.',
          confirmText: 'Export with Codes',
          variant: 'primary'
        });
        if (ok) {
          const csv = exportRosterCSV(students, course, { includeAccessCode: true });
          downloadCSV(`${course.name.replace(/[^a-z0-9]+/gi, '_')}_roster_with_codes.csv`, csv);
          toast.success('Roster with access codes downloaded.');
        }
      } else if (val === 'print-slips') {
        AccessCodes.printSlips(students, course);
      }
    });

    // Select all checkbox
    container.querySelector('#roster-select-all')?.addEventListener('change', (e) => {
      const checked = e.target.checked;
      const filtered = filterStudents(students);
      if (checked) {
        filtered.forEach(s => selectedStudentIds.add(s.student_id));
      } else {
        selectedStudentIds.clear();
      }
      renderTable();
    });

    // Individual checkboxes
    container.querySelectorAll('.roster-chk-row').forEach(chk => {
      chk.addEventListener('change', (e) => {
        const id = chk.dataset.id;
        if (e.target.checked) {
          selectedStudentIds.add(id);
        } else {
          selectedStudentIds.delete(id);
        }
        renderTable();
      });
    });

    // Bulk buttons
    container.querySelector('#btn-bulk-deselect')?.addEventListener('click', () => {
      selectedStudentIds.clear();
      renderTable();
    });

    container.querySelector('#btn-bulk-codes')?.addEventListener('click', async () => {
      const targetStudents = students.filter(s => selectedStudentIds.has(s.student_id));
      let count = 0;
      for (const s of targetStudents) {
        if (!s.access_code) {
          await AccessCodes.regenerate(s);
          count++;
        }
      }
      toast.success(`Generated codes for ${count} students.`);
      selectedStudentIds.clear();
      onRefresh();
    });

    container.querySelector('#btn-bulk-remove')?.addEventListener('click', async () => {
      const count = selectedStudentIds.size;
      const ok = await ConfirmDialog.show({
        title: `Remove ${count} students?`,
        message: `Are you sure you want to remove ${count} selected student(s) from "${Sanitizer.escapeHTML(course.name)}"? Their course grades will also be removed.`,
        confirmText: 'Remove Students',
        variant: 'danger'
      });
      if (!ok) return;

      const studentsTable = storage.table('gradebook_students');
      const gradesTable = storage.table('gradebook_grades');

      for (const sId of selectedStudentIds) {
        const matchedStudents = await studentsTable.where('course_id').equals(course.id).and(s => s.student_id === sId).toArray();
        for (const s of matchedStudents) {
          await studentsTable.delete(s.id);
        }
        const gradeKeys = await gradesTable.where('course_id').equals(course.id).and(g => g.student_id === sId).primaryKeys();
        if (gradeKeys.length > 0) {
          await gradesTable.bulkDelete(gradeKeys);
        }
      }

      toast.success(`Removed ${count} students.`);
      selectedStudentIds.clear();
      onRefresh();
    });

    // Code show/hide toggles
    container.querySelectorAll('.btn-toggle-code').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (revealedCodes.has(id)) {
          revealedCodes.delete(id);
        } else {
          revealedCodes.add(id);
        }
        renderTable();
      });
    });

    // Copy code button
    container.querySelectorAll('.btn-copy-code').forEach(btn => {
      btn.addEventListener('click', async () => {
        const code = btn.dataset.code;
        try {
          await navigator.clipboard.writeText(code);
          toast.success('Access code copied.');
        } catch (_) {
          toast.warning('Copy failed.');
        }
      });
    });

    // Single generate code button
    container.querySelectorAll('.btn-gen-code').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const student = students.find(s => s.student_id === id);
        if (student) {
          await AccessCodes.regenerate(student);
          revealedCodes.add(student.student_id);
          toast.success(`Access code generated for ${student.full_name}.`);
          onRefresh();
        }
      });
    });

    // Open student profile button
    container.querySelectorAll('.btn-open-student').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const student = students.find(s => s.student_id === id);
        if (student && onOpenStudentDrawer) {
          onOpenStudentDrawer(student);
        }
      });
    });

    // Row action menus
    container.querySelectorAll('.roster-row-menu').forEach(menu => {
      menu.addEventListener('sl-select', async (e) => {
        const action = e.detail.item.value;
        const sId = menu.dataset.id;
        const student = students.find(s => s.student_id === sId);
        if (!student) return;

        if (action === 'profile') {
          if (onOpenStudentDrawer) onOpenStudentDrawer(student);
        } else if (action === 'report-link') {
          const rubrics = await storage.table('gradebook_rubrics').where('course_id').equals(course.id).toArray();
          const linkData = await GradebookReportGenerator.createStudentShareLink(student, course, allAssignments, gradesMap, rubrics);
          promptShareLink(student, linkData);
        } else if (action === 'report-pdf') {
          const doc = GradebookReportGenerator.generateStudentPDF(student, course, allAssignments, gradesMap);
          doc.save(`${student.student_id}_Report.pdf`);
          toast.success(`Exported PDF report for ${student.full_name}!`);
        } else if (action === 'remove') {
          const ok = await ConfirmDialog.show({
            title: `Remove ${Sanitizer.escapeHTML(student.full_name)}?`,
            message: `Are you sure you want to remove ${Sanitizer.escapeHTML(student.full_name)} from "${Sanitizer.escapeHTML(course.name)}"? Their course grades will also be removed.`,
            confirmText: 'Remove Student',
            variant: 'danger'
          });
          if (ok) {
            await removeStudent(student);
            onRefresh();
          }
        }
      });
    });
  }

  async function removeStudent(student) {
    const studentsTable = storage.table('gradebook_students');
    const gradesTable = storage.table('gradebook_grades');

    const matched = await studentsTable.where('course_id').equals(course.id).and(s => s.student_id === student.student_id).toArray();
    for (const m of matched) {
      await studentsTable.delete(m.id);
    }

    const gradeKeys = await gradesTable.where('course_id').equals(course.id).and(g => g.student_id === student.student_id).primaryKeys();
    if (gradeKeys.length > 0) {
      await gradesTable.bulkDelete(gradeKeys);
    }
    toast.success(`Student ${student.full_name} removed.`);
  }

  function promptShareLink(student, linkData) {
    const dialog = document.createElement('sl-dialog');
    dialog.label = `Encrypted Link — ${student.full_name}`;
    dialog.innerHTML = `
      <div class="space-y-3 py-1 text-sm">
        <p class="text-xs text-slate-500">
          This secure link gives ${Sanitizer.escapeHTML(student.full_name)} private access to their grades and feedback.
        </p>
        <sl-input id="share-link-input" value="${Sanitizer.escapeHTML(linkData.url)}" readonly>
          <sl-button slot="suffix" id="btn-copy-share-url" size="small" variant="primary">
            <sl-icon slot="prefix" name="clipboard"></sl-icon> Copy
          </sl-button>
        </sl-input>
      </div>
      <div slot="footer" class="flex justify-end">
        <sl-button variant="default" id="btn-close-link-modal">Close</sl-button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.show();

    dialog.querySelector('#btn-copy-share-url')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(linkData.url);
        toast.success('Link copied to clipboard.');
      } catch (_) {
        toast.warning('Copy failed.');
      }
    });
    dialog.querySelector('#btn-close-link-modal')?.addEventListener('click', () => dialog.hide());
    dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
  }

  renderTable();
}

export default renderRosterView;
