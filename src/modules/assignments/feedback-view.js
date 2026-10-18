/**
 * Student Assignment Feedback View (#/feedback) (KB-ASSIGN-009)
 * Read-only student view for decrypted assignment feedback.
 */

import { store } from '../../state/store.js';
import { Sanitizer } from '../../core/sanitizer.js';

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

export async function renderFeedbackView(params, router, container) {
  const eph = store.getState('ephemeralData');
  if (!eph || eph.type !== 'assignment_feedback' || !eph.payload) {
    container.innerHTML = `
      <div class="max-w-lg mx-auto text-center space-y-4 bg-white rounded-2xl border border-slate-200 p-8 my-8">
        <span class="w-12 h-12 mx-auto rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-2xl">
          <sl-icon name="shield-lock"></sl-icon>
        </span>
        <h1 class="text-xl font-bold text-slate-900">Open your feedback link</h1>
        <p class="text-sm text-slate-500">
          Assignment feedback is delivered as a private link. Open the link your teacher shared and enter your access code to view your answers and comments.
        </p>
      </div>`;
    return;
  }

  const p = eph.payload;
  const earned = Sanitizer.safeNumber(p.score?.earned);
  const possible = Sanitizer.safeNumber(p.score?.possible);
  const percent = possible > 0 ? ((earned / possible) * 100).toFixed(1) : '100.0';
  const pending = Sanitizer.safeNumber(p.score?.pending);

  let submittedDateStr = '';
  if (p.submission?.submitted_at) {
    try {
      submittedDateStr = new Date(p.submission.submitted_at).toLocaleString();
    } catch (_) {
      submittedDateStr = p.submission.submitted_at;
    }
  }

  const daysLate = Sanitizer.safeNumber(p.submission?.days_late);
  const isLate = daysLate > 0;
  const isVerified = p.submission?.identity === 'verified';

  container.innerHTML = `
    <div class="max-w-4xl mx-auto space-y-6 pb-16 print:p-0 print:space-y-4">
      <!-- Top header -->
      <section class="bg-white rounded-2xl border border-slate-200 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-5 shadow-sm print:shadow-none print:border-none print:p-0">
        <div class="min-w-0">
          <p class="text-xs font-semibold uppercase tracking-wider text-slate-500">
            ${esc(p.course?.name || 'Class')}${p.course?.section ? ` · ${esc(p.course.section)}` : ''}
          </p>
          <h1 class="text-2xl font-bold text-slate-900 mt-1">${esc(p.assignment?.title || 'Assignment Feedback')}</h1>
          <div class="flex flex-wrap items-center gap-2 mt-2 text-sm text-slate-600">
            <span class="font-medium text-slate-900">${esc(p.student?.full_name || 'Student')}</span>
            ${p.student?.student_id ? `<span class="text-xs text-slate-400 font-mono">(${esc(p.student.student_id)})</span>` : ''}
            ${submittedDateStr ? `<span class="text-slate-300">·</span><span>Submitted ${esc(submittedDateStr)}</span>` : ''}
            ${isLate ? `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">Late (+${daysLate}d)</span>` : ''}
            ${isVerified ? `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1"><sl-icon name="patch-check"></sl-icon> Verified</span>` : ''}
          </div>
        </div>
        <div class="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-2">
          <div class="text-right">
            <div class="text-3xl font-extrabold text-slate-900 tabular-nums">
              ${earned} <span class="text-lg font-normal text-slate-400">/ ${possible}</span>
            </div>
            <div class="text-sm font-semibold text-slate-500">${percent}%</div>
            ${pending > 0 ? `<div class="text-xs text-amber-600 font-medium">${pending} awaiting review</div>` : ''}
          </div>
          <sl-button size="small" id="btn-print-feedback" class="print:hidden">
            <sl-icon slot="prefix" name="printer"></sl-icon> Print
          </sl-button>
        </div>
      </section>

      <!-- Overall feedback -->
      ${p.overall_feedback ? `
        <section class="bg-blue-50/70 rounded-2xl border border-blue-200 p-5 space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wider text-blue-900 flex items-center gap-1.5">
            <sl-icon name="chat-square-text"></sl-icon> Teacher comments
          </h3>
          <div class="text-sm text-blue-950 whitespace-pre-wrap leading-relaxed">${esc(p.overall_feedback)}</div>
        </section>
      ` : ''}

      <!-- Questions List -->
      <section class="space-y-4">
        <h2 class="text-sm font-bold uppercase tracking-wider text-slate-500 px-1">Questions & Answers</h2>
        ${(p.questions || []).map(q => {
          const isFull = q.earned >= q.possible && q.possible > 0;
          const isZero = q.earned === 0 && q.possible > 0;
          const badgeCls = isFull
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : (isZero ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-amber-50 text-amber-700 border-amber-200');

          return `
            <div class="bg-white rounded-xl border border-slate-200 p-5 space-y-4 shadow-sm print:shadow-none">
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs font-bold uppercase tracking-wider text-slate-500">Question ${Sanitizer.safeNumber(q.n)}</span>
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${badgeCls}">
                  ${Sanitizer.safeNumber(q.earned)} / ${Sanitizer.safeNumber(q.possible)} pts
                </span>
              </div>

              <!-- Prompt -->
              <div class="prose prose-sm max-w-none text-slate-900 font-medium">
                ${Sanitizer.renderSTEMMarkdown(q.prompt)}
              </div>

              <!-- Student answer -->
              <div class="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
                <div class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Your answer</div>
                <div class="text-sm text-slate-900 whitespace-pre-wrap">${esc(q.student_answer || 'No answer')}</div>
              </div>

              <!-- Correct answer if permitted -->
              ${q.correct_answer ? `
                <div class="p-3 rounded-lg bg-emerald-50/60 border border-emerald-200 space-y-1">
                  <div class="text-[11px] font-semibold uppercase tracking-wider text-emerald-800">Correct answer</div>
                  <div class="text-sm text-emerald-950 font-medium">${esc(q.correct_answer)}</div>
                </div>
              ` : ''}

              <!-- Explanation if permitted -->
              ${q.explanation ? `
                <div class="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
                  <div class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Explanation</div>
                  <div class="text-sm text-slate-700 prose prose-sm max-w-none">${Sanitizer.renderSTEMMarkdown(q.explanation)}</div>
                </div>
              ` : ''}

              <!-- Teacher question feedback -->
              ${q.feedback ? `
                <div class="p-3 rounded-lg bg-amber-50 border border-amber-200 space-y-1">
                  <div class="text-[11px] font-semibold uppercase tracking-wider text-amber-800 flex items-center gap-1">
                    <sl-icon name="chat-left-dots"></sl-icon> Teacher comment
                  </div>
                  <div class="text-sm text-amber-950 whitespace-pre-wrap">${esc(q.feedback)}</div>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </section>
    </div>
  `;

  container.querySelector('#btn-print-feedback')?.addEventListener('click', () => {
    window.print();
  });
}
