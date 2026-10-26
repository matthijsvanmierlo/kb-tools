import { store } from '../../state/store.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { renderCodeWithComments } from '../../components/code-editor.js';
import { DrawBoardUI } from '../../components/draw-board-ui.js';
import { resolveMediaSrc } from '../../utils/student-media.js';
import { storage } from '../../core/storage.js';

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));
const num = (v, fallback = 0) => esc(Sanitizer.safeNumber(v, fallback));

/**
 * Student Task Feedback View (#/feedback)
 * Displays returned grades, rubric breakdown, line-anchored code comments,
 * and teacher drawing annotations.
 */
export async function renderTaskFeedbackView(params = {}, router = null, container = null) {
  if (!container) container = document.getElementById('main-content');
  if (!container) return;

  // Resolve payload from ephemeral store or from student_ledger by itemId
  let p = null;
  const eph = store.getState('ephemeralData');
  if (eph && eph.type === 'task_feedback' && eph.payload) {
    p = eph.payload;
  } else if (params.itemId || params.id) {
    const searchId = params.itemId || params.id;
    const ledgerEntries = await storage.table('student_ledger').toArray().catch(() => []);
    const match = ledgerEntries.find(it => it.assignment_id === searchId || it.id === searchId);
    if (match) {
      p = match;
    }
  }

  if (!p) {
    container.innerHTML = `
      <div class="max-w-lg mx-auto text-center space-y-4 bg-white rounded-2xl border border-slate-200 p-8 my-8">
        <span class="w-12 h-12 mx-auto rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center text-2xl">
          <sl-icon name="journal-check"></sl-icon>
        </span>
        <h1 class="text-xl font-bold text-slate-900">Open your feedback link</h1>
        <p class="text-sm text-slate-500">
          Assignment feedback is delivered as a private link. Open the link your teacher shared and enter your access code to view your grades and feedback.
        </p>
        <sl-button variant="primary" href="#/student/gradebook">View My Grades</sl-button>
      </div>
    `;
    return;
  }

  const isProficiency = p.grade?.scoring === 'proficiency' || p.task?.scoring === 'proficiency';
  const earned = p.grade?.points ?? p.score?.earned ?? null;
  const maxPts = p.grade?.max_points ?? p.task?.max_points ?? 100;
  const percent = (earned !== null && maxPts > 0) ? ((earned / maxPts) * 100).toFixed(1) : null;

  let submittedDateStr = '';
  if (p.submission?.submitted_at || p.submitted_at) {
    try {
      submittedDateStr = new Date(p.submission?.submitted_at || p.submitted_at).toLocaleString();
    } catch (_) {
      submittedDateStr = p.submission?.submitted_at || p.submitted_at;
    }
  }

  const daysLate = Number(p.submission?.days_late || p.days_late || 0);
  const isLate = daysLate > 0;
  const standards = p.grade?.standards || p.standards || [];
  const rubric = p.rubric || null;
  const codeFiles = p.code_files || [];
  const drawing = p.drawing || null;
  const attachments = p.attachments || [];
  const writtenText = p.text || '';

  container.innerHTML = `
    <div class="max-w-4xl mx-auto space-y-6 pb-20 pt-4 print:p-0 print:space-y-4">
      <!-- Header & Score Banner -->
      <section class="bg-white rounded-2xl border border-slate-200 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-5 shadow-xs print:shadow-none print:border-none print:p-0">
        <div class="min-w-0">
          <p class="text-xs font-semibold uppercase tracking-wider text-indigo-600">
            ${esc(p.course?.name || 'My Class')}${p.course?.section ? ` · ${esc(p.course.section)}` : ''}
          </p>
          <h1 class="text-2xl font-bold text-slate-900 mt-1">${esc(p.task?.title || p.title || 'Assignment Feedback')}</h1>
          <div class="flex flex-wrap items-center gap-2 mt-2 text-sm text-slate-600">
            <span class="font-medium text-slate-900">${esc(p.student?.full_name || p.student_name || 'Student')}</span>
            ${(p.student?.student_id || p.student_id) ? `<span class="text-xs text-slate-400 font-mono">(${esc(p.student?.student_id || p.student_id)})</span>` : ''}
            ${submittedDateStr ? `<span class="text-slate-300">·</span><span>Submitted ${esc(submittedDateStr)}</span>` : ''}
            ${isLate ? `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">Late (+${daysLate}d)</span>` : ''}
          </div>
        </div>

        <div class="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-2 flex-shrink-0">
          <div class="text-right">
            ${!isProficiency ? `
              <div class="text-3xl font-extrabold text-slate-900 tabular-nums">
                ${earned !== null ? earned : '—'} <span class="text-lg font-normal text-slate-400">/ ${maxPts}</span>
              </div>
              ${percent !== null ? `<div class="text-sm font-semibold text-slate-500">${percent}%</div>` : ''}
            ` : `
              <div class="text-sm font-bold text-indigo-600">Standards Assessed</div>
            `}
          </div>
          <sl-button size="small" id="btn-print-feedback" class="print:hidden">
            <sl-icon slot="prefix" name="printer"></sl-icon> Print
          </sl-button>
        </div>
      </section>

      <!-- Standards Evidence (if proficiency) -->
      ${standards.length ? `
        <section class="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 shadow-2xs">
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <sl-icon name="bullseye" class="text-indigo-600 text-sm"></sl-icon> Standards Mastery
          </h2>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${standards.map(std => `
              <div class="p-3 rounded-xl border border-slate-200 bg-slate-50 space-y-1.5">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-slate-800">${esc(std.code)}</span>
                  ${std.score !== null && std.score !== undefined ? `
                    <span class="px-2 py-0.5 rounded-full text-xs font-semibold text-white" style="background-color: ${Sanitizer.safeColor(std.level_color || '#4f46e5')}">
                      ${esc(std.level_label || `${std.score} pts`)}
                    </span>
                  ` : '<span class="text-xs text-slate-400">Not assessed</span>'}
                </div>
                <p class="text-xs text-slate-600 leading-snug">${esc(std.description)}</p>
                ${std.comment ? `<p class="text-xs text-slate-700 bg-white p-2 rounded border border-slate-200 font-sans italic mt-1">"${esc(std.comment)}"</p>` : ''}
              </div>
            `).join('')}
          </div>
        </section>
      ` : ''}

      <!-- Overall Teacher Feedback -->
      ${p.overall_feedback ? `
        <section class="bg-indigo-50/70 rounded-2xl border border-indigo-200 p-5 space-y-2 shadow-2xs">
          <h2 class="text-xs font-bold uppercase tracking-wider text-indigo-900 flex items-center gap-1.5">
            <sl-icon name="chat-square-quote"></sl-icon> Teacher Feedback
          </h2>
          <div class="text-sm text-indigo-950 font-sans leading-relaxed whitespace-pre-wrap">
            ${Sanitizer.renderSTEMMarkdown(p.overall_feedback)}
          </div>
        </section>
      ` : ''}

      <!-- Rubric Evaluation Breakdown -->
      ${rubric ? `
        <section class="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 shadow-2xs">
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <sl-icon name="grid-3x3" class="text-indigo-600 text-sm"></sl-icon> Rubric Breakdown · ${esc(rubric.title)}
          </h2>
          <div class="space-y-3">
            ${(rubric.criteria || []).map(c => {
              const selectedTierId = rubric.eval?.[c.id];
              const selectedTier = (rubric.tiers || []).find(t => t.id === selectedTierId);
              const cell = c.cells?.[selectedTierId];
              const pts = cell ? (cell.points ?? selectedTier?.default_points ?? 0) : (selectedTier?.default_points ?? 0);
              const comment = rubric.comments?.[c.id];

              return `
                <div class="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                  <div class="flex items-center justify-between">
                    <span class="text-sm font-semibold text-slate-900">${esc(c.name)}</span>
                    ${selectedTier ? `
                      <span class="px-2.5 py-1 rounded-lg bg-indigo-100 text-indigo-800 text-xs font-bold">
                        ${esc(selectedTier.label)} (${num(pts)} pts)
                      </span>
                    ` : '<span class="text-xs text-slate-400">Not graded</span>'}
                  </div>
                  ${cell?.descriptor ? `<p class="text-xs text-slate-600 leading-snug">${esc(cell.descriptor)}</p>` : ''}
                  ${comment ? `<p class="text-xs text-indigo-900 bg-white p-2 rounded-lg border border-indigo-100 italic">Teacher note: ${esc(comment)}</p>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </section>
      ` : ''}

      <!-- Echoed Written Response -->
      ${writtenText ? `
        <section class="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 shadow-2xs">
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <sl-icon name="card-text" class="text-indigo-600 text-sm"></sl-icon> Your Written Response
          </h2>
          <div class="kb-prose bg-slate-50 p-4 rounded-xl border border-slate-200 text-sm">
            ${Sanitizer.renderSTEMMarkdown(writtenText)}
          </div>
        </section>
      ` : ''}

      <!-- Echoed Code Files with Line Comments -->
      ${codeFiles.length ? `
        <section class="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 shadow-2xs">
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <sl-icon name="code-slash" class="text-indigo-600 text-sm"></sl-icon> Code &amp; Inline Feedback
          </h2>
          <div class="space-y-4">
            ${codeFiles.map(file => renderCodeWithComments(file, file.comments || [])).join('')}
          </div>
        </section>
      ` : ''}

      <!-- Echoed Drawing with Teacher Annotations -->
      ${drawing ? `
        <section class="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 shadow-2xs">
          <div class="flex items-center justify-between">
            <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
              <sl-icon name="brush" class="text-indigo-600 text-sm"></sl-icon> Drawing &amp; Teacher Annotations
            </h2>
            <span class="text-xs text-slate-400">Teacher notes rendered in red</span>
          </div>
          <div id="fb-draw-mount" class="rounded-xl border border-slate-200 overflow-hidden"></div>
        </section>
      ` : ''}

      <!-- Echoed Attachments -->
      ${attachments.length ? `
        <section class="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 shadow-2xs">
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <sl-icon name="paperclip" class="text-indigo-600 text-sm"></sl-icon> Attached Files (${attachments.length})
          </h2>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3" id="fb-attachment-list"></div>
        </section>
      ` : ''}
    </div>
  `;

  // Mount drawing if present
  if (drawing) {
    const drawMount = container.querySelector('#fb-draw-mount');
    if (drawMount) {
      DrawBoardUI.mount(drawMount, {
        baseDoc: drawing.student || null,
        doc: drawing.teacher_annotations || { version: 2, width: 1000, height: 600, elements: [] },
        readOnly: true
      });
    }
  }

  // Mount attachments previews / download links
  if (attachments.length) {
    const listMount = container.querySelector('#fb-attachment-list');
    if (listMount) {
      for (const att of attachments) {
        const item = document.createElement('div');
        item.className = 'p-3 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-2 text-xs';
        item.innerHTML = `
          <div class="flex items-center gap-2 truncate">
            <sl-icon name="file-earmark-lock2" class="text-indigo-600 text-base flex-shrink-0"></sl-icon>
            <strong class="text-slate-800 truncate">${esc(att.name)}</strong>
          </div>
          <a href="#" class="download-link font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 flex-shrink-0" target="_blank" rel="noopener">
            <sl-icon name="download"></sl-icon> Open
          </a>
        `;
        listMount.appendChild(item);

        resolveMediaSrc(att.ref).then(srcUrl => {
          const dl = item.querySelector('.download-link');
          dl.href = srcUrl;
          dl.download = att.name;
        }).catch(() => {});
      }
    }
  }

  // Print button
  container.querySelector('#btn-print-feedback')?.addEventListener('click', () => {
    window.print();
  });
}
