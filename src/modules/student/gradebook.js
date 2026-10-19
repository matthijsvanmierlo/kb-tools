/**
 * Student Gradebook (KB-STUDENT-004)
 *
 * Personal, client-side, zero-trust Gradebook for students.
 * Displays all enrolled courses, cumulative scores, and question-by-question teacher feedback.
 */

import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { StudentProfile } from '../../core/student-profile.js';
import { StudentLedger } from './ledger.js';
import { toCSV, downloadCSV } from '../../core/csv.js';

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

export async function renderStudentGradebookView(params, router, container) {
  const profile = StudentProfile.get();
  let courses = await StudentLedger.getStudentCourses();
  let allEntries = await StudentLedger.getAllLedgerEntries();

  let selectedCourseId = params.course || 'all';

  const render = () => {
    const filteredEntries = selectedCourseId === 'all'
      ? allEntries
      : allEntries.filter(e => e.course_id === selectedCourseId);

    const graded = filteredEntries.filter(e => e.score && e.score.possible > 0);
    const totalEarned = graded.reduce((acc, it) => acc + (it.score.earned || 0), 0);
    const totalPossible = graded.reduce((acc, it) => acc + (it.score.possible || 0), 0);
    const overallPercent = totalPossible > 0 ? Math.round((totalEarned / totalPossible) * 100) : null;

    container.innerHTML = `
      <div class="space-y-6 max-w-6xl mx-auto pb-12">
        <!-- Header -->
        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-6 rounded-2xl border border-slate-200 shadow-xs">
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <span class="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-xl">
                <sl-icon name="journal-check"></sl-icon>
              </span>
              <div>
                <h1 class="text-2xl font-bold text-slate-900">My Gradebook &amp; Feedback</h1>
                <p class="text-xs text-slate-500">
                  ${profile.defaultIdentity.full_name ? esc(profile.defaultIdentity.full_name) : 'Student Workspace'}
                  ${profile.defaultIdentity.student_id ? ` · ID: <span class="font-mono">${esc(profile.defaultIdentity.student_id)}</span>` : ''}
                </p>
              </div>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <sl-button size="small" id="btn-import-feedback">
              <sl-icon slot="prefix" name="cloud-download"></sl-icon> Add Feedback Link/File
            </sl-button>
            <sl-button size="small" id="btn-export-grades" ${filteredEntries.length ? '' : 'disabled'}>
              <sl-icon slot="prefix" name="download"></sl-icon> Export Grades
            </sl-button>
          </div>
        </div>

        <!-- Metric Badges -->
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-1">
            <div class="text-xs font-semibold uppercase tracking-wider text-slate-400">Enrolled Classes</div>
            <div class="text-2xl font-bold text-slate-900">${courses.length}</div>
            <div class="text-xs text-slate-500">${courses.length ? courses.map(c => esc(c.course_name)).join(', ') : 'No classes joined yet'}</div>
          </div>
          <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-1">
            <div class="text-xs font-semibold uppercase tracking-wider text-slate-400">Assignments &amp; Quizzes</div>
            <div class="text-2xl font-bold text-slate-900">${filteredEntries.length}</div>
            <div class="text-xs text-slate-500">${graded.length} graded</div>
          </div>
          <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-1">
            <div class="text-xs font-semibold uppercase tracking-wider text-slate-400">Overall Average</div>
            <div class="text-2xl font-bold ${overallPercent !== null ? (overallPercent >= 70 ? 'text-emerald-600' : 'text-amber-600') : 'text-slate-400'}">
              ${overallPercent !== null ? `${overallPercent}%` : '—'}
            </div>
            <div class="text-xs text-slate-500">${totalEarned} / ${totalPossible} total points</div>
          </div>
        </div>

        <!-- Filter bar -->
        ${courses.length > 1 ? `
          <div class="flex items-center gap-2 overflow-x-auto pb-1">
            <button type="button" class="px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all ${selectedCourseId === 'all' ? 'bg-blue-600 text-white shadow-xs' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}" data-filter-course="all">
              All Classes (${allEntries.length})
            </button>
            ${courses.map(c => `
              <button type="button" class="px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all ${selectedCourseId === c.id ? 'bg-blue-600 text-white shadow-xs' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}" data-filter-course="${esc(c.id)}">
                ${esc(c.course_name)} (${allEntries.filter(e => e.course_id === c.id).length})
              </button>
            `).join('')}
          </div>
        ` : ''}

        <!-- Ledger Table -->
        <div class="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          ${filteredEntries.length === 0 ? `
            <div class="p-12 text-center space-y-3">
              <span class="w-12 h-12 mx-auto rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center text-2xl"><sl-icon name="journal"></sl-icon></span>
              <h3 class="text-base font-bold text-slate-800">No grades or feedback yet</h3>
              <p class="text-sm text-slate-500 max-w-md mx-auto">When your teacher shares feedback links or returns graded assignments, they will automatically appear here.</p>
              <sl-button variant="primary" size="small" id="btn-empty-import">
                <sl-icon slot="prefix" name="cloud-download"></sl-icon> Open Feedback Link or File
              </sl-button>
            </div>
          ` : `
            <div class="overflow-x-auto">
              <table class="w-full text-left text-sm">
                <thead class="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  <tr>
                    <th class="px-5 py-3.5">Assignment</th>
                    <th class="px-5 py-3.5 hidden sm:table-cell">Class</th>
                    <th class="px-5 py-3.5 text-right">Score</th>
                    <th class="px-5 py-3.5 text-center">Status</th>
                    <th class="px-5 py-3.5 text-right hidden md:table-cell">Date</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  ${filteredEntries.map(it => {
                    const course = courses.find(c => c.id === it.course_id);
                    const pct = it.score && it.score.possible > 0 ? Math.round((it.score.earned / it.score.possible) * 100) : null;
                    const dateStr = it.received_at ? new Date(it.received_at).toLocaleDateString() : (it.submitted_at ? new Date(it.submitted_at).toLocaleDateString() : '—');
                    const hasDetail = (it.questions && it.questions.length > 0) || it.overall_feedback;

                    return `
                      <tr class="hover:bg-slate-50/80 cursor-pointer transition-colors" data-open-detail="${esc(it.id)}" tabindex="0">
                        <td class="px-5 py-4">
                          <div class="font-semibold text-slate-900">${esc(it.title)}</div>
                          ${it.overall_feedback ? `<div class="text-xs text-slate-500 line-clamp-1 mt-0.5"><sl-icon name="chat-square-text"></sl-icon> “${esc(it.overall_feedback)}”</div>` : ''}
                        </td>
                        <td class="px-5 py-4 hidden sm:table-cell">
                          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                            ${esc(course?.course_name || 'Class')}
                          </span>
                        </td>
                        <td class="px-5 py-4 text-right tabular-nums">
                          ${it.score && it.score.possible > 0 ? `
                            <span class="font-bold text-slate-900 text-base">${it.score.earned}</span>
                            <span class="text-slate-400 text-xs">/ ${it.score.possible}</span>
                            ${pct !== null ? `<div class="text-xs font-semibold ${pct >= 70 ? 'text-emerald-600' : 'text-amber-600'}">${pct}%</div>` : ''}
                          ` : '<span class="text-slate-400">Awaiting grade</span>'}
                        </td>
                        <td class="px-5 py-4 text-center">
                          ${it.item_type === 'assignment_feedback' ? `
                            <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                              <sl-icon name="check2-circle"></sl-icon> Feedback Returned
                            </span>
                          ` : `
                            <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                              <sl-icon name="clock"></sl-icon> Submitted
                            </span>
                          `}
                        </td>
                        <td class="px-5 py-4 text-right text-xs text-slate-400 tabular-nums hidden md:table-cell">
                          ${esc(dateStr)}
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      </div>
    `;

    bindEvents(filteredEntries);
  };

  function bindEvents(filteredEntries) {
    container.querySelectorAll('[data-filter-course]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedCourseId = btn.dataset.filterCourse;
        render();
      });
    });

    container.querySelectorAll('[data-open-detail]').forEach(tr => {
      const open = () => {
        const item = allEntries.find(e => e.id === tr.dataset.openDetail);
        if (item) openDetailDrawer(item);
      };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });

    const openImport = () => openFeedbackImportDialog();
    container.querySelector('#btn-import-feedback')?.addEventListener('click', openImport);
    container.querySelector('#btn-empty-import')?.addEventListener('click', openImport);

    container.querySelector('#btn-export-grades')?.addEventListener('click', () => {
      const rows = filteredEntries.map(e => {
        const course = courses.find(c => c.id === e.course_id);
        return {
          Class: course?.course_name || 'Class',
          Assignment: e.title,
          Earned: e.score?.earned ?? '',
          Possible: e.score?.possible ?? '',
          Feedback: e.overall_feedback || '',
          Date: e.received_at || e.submitted_at || ''
        };
      });
      const csv = toCSV(rows, ['Class', 'Assignment', 'Earned', 'Possible', 'Feedback', 'Date']);
      downloadCSV('my_kennisboost_grades.csv', csv);
      toast.success('Downloaded grades spreadsheet.');
    });
  }

  function openDetailDrawer(item) {
    const existing = document.getElementById('kb-student-feedback-drawer');
    if (existing) existing.remove();

    const course = courses.find(c => c.id === item.course_id);
    const pct = item.score && item.score.possible > 0 ? Math.round((item.score.earned / item.score.possible) * 100) : null;

    const drawer = document.createElement('sl-drawer');
    drawer.id = 'kb-student-feedback-drawer';
    drawer.label = item.title;
    drawer.style.setProperty('--size', 'min(700px, 100vw)');

    drawer.innerHTML = `
      <div class="space-y-6">
        <!-- Summary Banner -->
        <div class="p-5 rounded-2xl bg-slate-50 border border-slate-200 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-200 text-slate-700">
                ${esc(course?.course_name || 'Class')}
              </span>
              <div class="text-xs text-slate-500 mt-1">Returned: ${esc(item.received_at ? new Date(item.received_at).toLocaleDateString() : '—')}</div>
            </div>
            <div class="text-right">
              <span class="text-2xl font-bold text-slate-900">${item.score?.earned}</span>
              <span class="text-slate-400">/ ${item.score?.possible} pts</span>
              ${pct !== null ? `<div class="text-sm font-semibold ${pct >= 70 ? 'text-emerald-600' : 'text-amber-600'}">${pct}%</div>` : ''}
            </div>
          </div>
          ${item.overall_feedback ? `
            <div class="p-3 bg-white border border-slate-200 rounded-xl text-sm">
              <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1"><sl-icon name="chat-quote"></sl-icon> Teacher Comments</div>
              <div class="text-slate-800 whitespace-pre-wrap">${esc(item.overall_feedback)}</div>
            </div>
          ` : ''}
        </div>

        <!-- Question Breakdown -->
        ${item.questions && item.questions.length ? `
          <div class="space-y-3">
            <h3 class="font-bold text-slate-900 text-sm">Question Breakdown</h3>
            <ol class="space-y-3">
              ${item.questions.map((q, idx) => {
                const isCorrect = q.correct || (q.earned >= q.possible && q.possible > 0);
                const tone = isCorrect ? 'border-emerald-200 bg-emerald-50/20' : q.earned > 0 ? 'border-blue-200 bg-blue-50/20' : 'border-rose-200 bg-rose-50/20';

                return `
                  <li class="p-4 rounded-xl border ${tone} space-y-2">
                    <div class="flex items-start justify-between gap-3">
                      <div class="text-sm font-medium text-slate-900">
                        <span class="text-slate-400 mr-1">${q.n || idx + 1}.</span>
                        ${Sanitizer.renderSTEMMarkdown(q.prompt || '')}
                      </div>
                      <span class="text-xs font-bold whitespace-nowrap ${isCorrect ? 'text-emerald-700' : 'text-slate-600'}">
                        ${q.earned} / ${q.possible} pts
                      </span>
                    </div>

                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pt-1">
                      <div class="p-2.5 rounded-lg bg-white border border-slate-200">
                        <div class="text-slate-400 font-semibold mb-0.5">Your Answer</div>
                        <div class="text-slate-800 font-medium">${esc(q.student_answer || 'No answer')}</div>
                      </div>
                      ${q.correct_answer ? `
                        <div class="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200">
                          <div class="text-emerald-700 font-semibold mb-0.5">Correct Answer</div>
                          <div class="text-emerald-900 font-medium">${esc(q.correct_answer)}</div>
                        </div>
                      ` : ''}
                    </div>

                    ${q.feedback ? `
                      <div class="text-xs text-slate-600 bg-white p-2.5 rounded-lg border border-slate-200">
                        <strong class="text-slate-700">Teacher comment:</strong> ${esc(q.feedback)}
                      </div>
                    ` : ''}
                  </li>
                `;
              }).join('')}
            </ol>
          </div>
        ` : `
          <div class="text-xs text-slate-400 italic">No question-level breakdown available for this score.</div>
        `}
      </div>
      <div slot="footer" class="flex justify-between items-center w-full">
        <sl-button size="small" variant="danger" outline id="btn-delete-ledger-item">
          <sl-icon slot="prefix" name="trash"></sl-icon> Delete from Gradebook
        </sl-button>
        <sl-button size="small" id="btn-close-drawer">Close</sl-button>
      </div>
    `;

    document.body.appendChild(drawer);
    drawer.addEventListener('sl-after-hide', (e) => { if (e.target === drawer) drawer.remove(); });
    drawer.show();

    drawer.querySelector('#btn-close-drawer')?.addEventListener('click', () => drawer.hide());
    drawer.querySelector('#btn-delete-ledger-item')?.addEventListener('click', async () => {
      await StudentLedger.deleteLedgerItem(item.id);
      drawer.hide();
      toast.success('Removed item from gradebook.');
      courses = await StudentLedger.getStudentCourses();
      allEntries = await StudentLedger.getAllLedgerEntries();
      render();
    });
  }

  function openFeedbackImportDialog() {
    const existing = document.getElementById('kb-student-import-dialog');
    if (existing) existing.remove();

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'kb-student-import-dialog';
    dialog.label = 'Add Feedback or Grade Link';
    dialog.innerHTML = `
      <div class="space-y-4">
        <p class="text-sm text-slate-600">Paste the feedback link or contents from your teacher to add it to your personal gradebook:</p>
        <sl-textarea id="student-import-input" rows="5" placeholder="Paste link (https://...#/share?...) or feedback JSON..."></sl-textarea>
        <div class="flex items-center gap-2">
          <input type="file" id="student-import-file" class="hidden" accept=".html,.htm,.kbfeedback,.json">
          <sl-button size="small" id="btn-choose-file">
            <sl-icon slot="prefix" name="file-earmark-arrow-up"></sl-icon> Or choose a feedback file
          </sl-button>
        </div>
      </div>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button id="student-import-cancel">Cancel</sl-button>
        <sl-button variant="primary" id="student-import-submit">Add to Gradebook</sl-button>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
    dialog.show();

    dialog.querySelector('#student-import-cancel').addEventListener('click', () => dialog.hide());
    const fileInput = dialog.querySelector('#student-import-file');
    dialog.querySelector('#btn-choose-file').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const text = await file.text();
      dialog.querySelector('#student-import-input').value = text;
    });

    dialog.querySelector('#student-import-submit').addEventListener('click', async () => {
      const val = dialog.querySelector('#student-import-input').value.trim();
      if (!val) { toast.warning('Please enter a link or paste feedback.'); return; }

      try {
        if (val.includes('#/share')) {
          dialog.hide();
          router.navigate(val.slice(val.indexOf('#/share')));
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(val);
        } catch (_) {}

        if (parsed && (parsed.kind === 'assignment_feedback' || parsed.type === 'assignment_feedback')) {
          await StudentLedger.ingestAssignmentFeedback(parsed.payload || parsed);
          dialog.hide();
          toast.success('Feedback added to your gradebook!');
          courses = await StudentLedger.getStudentCourses();
          allEntries = await StudentLedger.getAllLedgerEntries();
          render();
          return;
        }

        toast.warning('Could not recognize feedback format. Please use the link your teacher shared.');
      } catch (err) {
        toast.danger('Import failed: ' + err.message);
      }
    });
  }

  render();
}
