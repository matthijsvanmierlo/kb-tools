import { store } from '../../state/store.js';
import { Sanitizer } from '../../core/sanitizer.js';

/**
 * Student Grade Report View (#/report) (KB-GRAD-011)
 *
 * Read-only page a student sees after unlocking their encrypted report link with their access
 * code. Renders only the data inside the link — nothing is read from or written to the local
 * gradebook, so opening a report on a teacher's machine never mixes data.
 */

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

const STATUS_LABEL = {
  submitted: null,
  late: { text: 'Late', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  missing: { text: 'Missing', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  exempt: { text: 'Excused', cls: 'bg-slate-100 text-slate-600 border-slate-200' }
};

function levelFor(levels, value) {
  if (value === null || value === undefined) return null;
  const sorted = [...(levels || [])].sort((a, b) => b.value - a.value);
  return sorted.find(l => Number(value) >= Number(l.value)) || sorted[sorted.length - 1] || null;
}

function levelChip(levels, value) {
  const lvl = levelFor(levels, value);
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold text-white tabular-nums" style="background:${lvl?.color || '#64748b'}">${Number(value)}${lvl ? ` <span class="font-medium text-white/90">${esc(lvl.label)}</span>` : ''}</span>`;
}

export async function renderStudentReportView(params, router, container) {
  const eph = store.getState('ephemeralData');
  if (!eph || eph.type !== 'student_grade_report' || !eph.payload) {
    container.innerHTML = `
      <div class="max-w-lg mx-auto text-center space-y-4 bg-white rounded-2xl border border-slate-200 p-8">
        <span class="w-12 h-12 mx-auto rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-2xl"><sl-icon name="shield-lock"></sl-icon></span>
        <h1 class="text-xl font-bold text-slate-900">Open your grade report link</h1>
        <p class="text-sm text-slate-500">Grade reports are delivered as private links. Open the link your teacher shared and enter your access code to see your grades.</p>
      </div>`;
    return;
  }

  const p = eph.payload;
  // Version 1 links (before access codes) only carried raw grades
  if (!p.version || p.version < 2) {
    renderLegacy(p, container);
    return;
  }

  const levels = p.course.levels || [];
  const isSbg = p.course.mode === 'sbg' && p.summary.mastery !== null && p.summary.mastery !== undefined;
  const missing = p.assignments.filter(a => a.grade?.status === 'missing');

  container.innerHTML = `
    <div class="max-w-4xl mx-auto space-y-6">
      <section class="bg-white rounded-2xl border border-slate-200 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-5">
        <div class="min-w-0">
          <p class="text-xs font-semibold uppercase tracking-wider text-slate-500">${esc(p.course.name)}${p.course.section ? ` · ${esc(p.course.section)}` : ''}</p>
          <h1 class="text-2xl font-bold text-slate-900 mt-1">${esc(p.student.full_name)}</h1>
          <p class="text-xs text-slate-400 mt-1">Report generated ${esc(new Date(p.generated_at).toLocaleDateString())} · private to you</p>
        </div>
        <div class="flex items-center gap-4 sm:text-right">
          <div>
            <div class="text-xs font-semibold uppercase tracking-wider text-slate-500">${isSbg ? 'Average mastery' : 'Current grade'}</div>
            <div class="text-3xl font-bold text-slate-900 tabular-nums">${isSbg ? Number(p.summary.mastery).toFixed(1) : (p.summary.score !== null && p.summary.score !== undefined ? `${p.summary.score}%` : '—')}</div>
          </div>
          <div class="w-16 h-16 rounded-2xl bg-blue-600 text-white flex items-center justify-center text-2xl font-bold">${esc(p.summary.letter || '—')}</div>
        </div>
      </section>

      ${missing.length ? `
        <section class="rounded-2xl border border-rose-200 bg-rose-50 p-4 flex gap-3">
          <sl-icon name="exclamation-octagon" class="text-rose-600 text-xl flex-shrink-0"></sl-icon>
          <div class="text-sm text-rose-800"><strong>${missing.length} missing assignment${missing.length === 1 ? '' : 's'}:</strong> ${missing.map(a => esc(a.title)).join(', ')}</div>
        </section>` : ''}

      ${p.standards && p.standards.length ? `
        <section class="space-y-3">
          <h2 class="text-lg font-bold text-slate-900">Standards</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            ${p.standards.map(s => `
              <div class="bg-white rounded-xl border border-slate-200 p-4 space-y-2">
                <div class="flex items-start justify-between gap-3">
                  <span class="text-sm font-bold text-blue-700 tabular-nums">${esc(s.code)}</span>
                  ${s.mastery !== null ? levelChip(levels, s.mastery) : '<span class="text-xs text-slate-400">No evidence yet</span>'}
                </div>
                <p class="text-xs text-slate-600 leading-relaxed">${esc(s.description)}</p>
                ${s.evidence.length ? `<p class="text-[11px] text-slate-400">Based on: ${s.evidence.map(e => `${esc(e.title)} (${e.level})`).join(' · ')}</p>` : ''}
              </div>`).join('')}
          </div>
        </section>` : ''}

      <section class="space-y-3">
        <h2 class="text-lg font-bold text-slate-900">Assignments</h2>
        <div class="space-y-3">
          ${p.assignments.map(a => {
            const g = a.grade;
            const status = g ? STATUS_LABEL[g.status] : null;
            const scoreText = !g || g.raw_score === null
              ? '<span class="text-slate-400">Not graded</span>'
              : a.scoring === 'proficiency'
                ? levelChip(levels, g.raw_score)
                : `<span class="font-semibold text-slate-900 tabular-nums">${g.raw_score} / ${a.max_score}</span>`;
            const stdScores = g ? Object.entries(g.standard_scores || {}) : [];
            const hasDetails = g && (g.feedback || a.rubric || stdScores.length);
            return `
              <article class="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <h3 class="font-semibold text-slate-900">${esc(a.title)}</h3>
                    <p class="text-xs text-slate-500">${[a.category, a.due_date ? `due ${a.due_date}` : '', a.standards.length ? a.standards.join(', ') : ''].filter(Boolean).map(esc).join(' · ')}</p>
                  </div>
                  <div class="flex items-center gap-2">
                    ${status ? `<span class="text-xs font-semibold px-2 py-0.5 rounded-md border ${status.cls}">${status.text}${g.status === 'late' && g.days_late ? ` · ${g.days_late}d` : ''}</span>` : ''}
                    ${scoreText}
                  </div>
                </div>
                ${hasDetails ? `
                  <div class="space-y-3 border-t border-slate-100 pt-3">
                    ${stdScores.length ? `
                      <div class="space-y-1.5">
                        ${stdScores.map(([code, v]) => `
                          <div class="flex flex-wrap items-center gap-2 text-xs">
                            <span class="font-semibold text-slate-700 tabular-nums">${esc(code)}</span>${levelChip(levels, v)}
                            ${g.standard_comments?.[code] ? `<span class="text-slate-600">${esc(g.standard_comments[code])}</span>` : ''}
                          </div>`).join('')}
                      </div>` : ''}
                    ${a.rubric ? `
                      <div class="rounded-lg bg-slate-50 p-3 space-y-2">
                        <p class="text-xs font-semibold text-slate-700">${esc(a.rubric.title)} · ${a.rubric.earned} / ${a.rubric.possible}</p>
                        ${a.rubric.criteria.map(c => `
                          <div class="text-xs">
                            <span class="font-medium text-slate-800">${esc(c.name)}:</span>
                            <span class="text-slate-600">${c.level ? `${esc(c.level)}${c.points !== null ? ` (${c.points})` : ''}` : 'not scored'}</span>
                            ${c.descriptor ? `<span class="text-slate-500"> — ${esc(c.descriptor)}</span>` : ''}
                            ${c.comment ? `<div class="mt-0.5 text-slate-700 italic">“${esc(c.comment)}”</div>` : ''}
                          </div>`).join('')}
                      </div>` : ''}
                    ${g.feedback ? `<div class="text-sm text-slate-700 whitespace-pre-line rounded-lg border-l-4 border-blue-300 bg-blue-50/60 px-3 py-2">${esc(g.feedback)}</div>` : ''}
                  </div>` : ''}
              </article>`;
          }).join('')}
        </div>
      </section>

      <p class="text-xs text-center text-slate-400">This report was decrypted on your device. Nothing was sent to a server.</p>
    </div>`;
}

function renderLegacy(p, container) {
  const grades = p.grades || {};
  container.innerHTML = `
    <div class="max-w-3xl mx-auto space-y-6">
      <section class="bg-white rounded-2xl border border-slate-200 p-6">
        <p class="text-xs font-semibold uppercase tracking-wider text-slate-500">${esc(p.course?.name || '')}</p>
        <h1 class="text-2xl font-bold text-slate-900 mt-1">${esc(p.student?.full_name || '')}</h1>
      </section>
      <section class="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100">
        ${(p.assignments || []).map(a => {
          const g = grades[a.id];
          return `<div class="flex items-center justify-between gap-3 px-5 py-3">
            <span class="text-sm font-medium text-slate-800">${esc(a.title)}</span>
            <span class="text-sm tabular-nums text-slate-700">${g && g.raw_score !== null && g.raw_score !== undefined ? `${g.raw_score} / ${a.max_score}` : (g?.status === 'missing' ? 'Missing' : '—')}</span>
          </div>`;
        }).join('')}
      </section>
    </div>`;
}

export default renderStudentReportView;
