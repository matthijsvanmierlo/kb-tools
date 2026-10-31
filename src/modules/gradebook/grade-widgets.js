import { Sanitizer } from '../../core/sanitizer.js';
import { normalizeScore } from './engine-calc.js';
import { RubricScorer } from './rubric-builder.js';
import { letterForPercent } from './grading-scales.js';

const esc = (v) => Sanitizer.escapeHTML(v ?? '');
const num = (v, fallback = 0) => esc(Sanitizer.safeNumber(v, fallback));

export const STATUSES = [
  { value: 'submitted', label: 'On time', icon: 'check2-circle', active: 'bg-emerald-50 border-emerald-300 text-emerald-700 ring-1 ring-emerald-300' },
  { value: 'late', label: 'Late', icon: 'clock-history', active: 'bg-amber-50 border-amber-300 text-amber-700 ring-1 ring-amber-300' },
  { value: 'missing', label: 'Missing', icon: 'exclamation-octagon', active: 'bg-rose-50 border-rose-300 text-rose-700 ring-1 ring-rose-300' },
  { value: 'exempt', label: 'Excused', icon: 'slash-circle', active: 'bg-slate-100 border-slate-300 text-slate-700 ring-1 ring-slate-300' }
];

export const FEEDBACK_SNIPPETS = [
  'Great work — clear and well organized.',
  'Show your reasoning step by step.',
  'Check your units and significant figures.',
  'Please revise and resubmit.',
  'Let\'s talk about this during office hours.'
];

export function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Renders status radio buttons.
 */
export function renderStatusButtons(currentStatus = 'submitted', statuses = STATUSES) {
  return `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2" role="radiogroup" aria-label="Submission status">
      ${statuses.map(st => {
        const active = currentStatus === st.value;
        return `
          <button type="button" class="kb-status-btn flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${active ? st.active : 'border-slate-200 text-slate-600 hover:bg-slate-50'}"
            data-status="${st.value}" role="radio" aria-checked="${active}">
            <sl-icon name="${st.icon}"></sl-icon> ${st.label}
          </button>`;
      }).join('')}
    </div>`;
}

/**
 * Renders proficiency level button group.
 */
export function renderLevelButtons(levels = [], current = null, attrs = 'data-level') {
  return `
    <div class="flex flex-wrap gap-1.5" role="radiogroup">
      ${levels.map(l => {
        const active = current !== null && current !== undefined && current !== '' && Number(current) === Number(l.value);
        return `
          <button type="button" ${attrs} data-level="${esc(l.value)}" role="radio" aria-checked="${active}"
            title="${esc(l.description || '')}"
            class="kb-level-btn inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${active ? 'text-white border-transparent' : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300'}"
            style="${active ? `background-color:${Sanitizer.safeColor(l.color)}` : ''}">
            <span class="tabular-nums">${esc(l.value)}</span><span class="font-medium ${active ? 'text-white/90' : 'text-slate-500'}">${esc(l.label)}</span>
          </button>`;
      }).join('')}
    </div>`;
}

/**
 * Renders late penalty preview text.
 */
export function renderPenaltyPreview({ rawScore, maxScore = 100, status = 'submitted', daysLate = 1, policy = {}, assignment = {}, course = null }) {
  if (assignment.scoring === 'proficiency') return '';
  if (rawScore === null || rawScore === '' || maxScore <= 0) return '';
  const norm = normalizeScore({ raw_score: Number(rawScore), status, days_late: daysLate }, assignment, policy);
  if (!norm) return '';
  const rawPct = round1((Number(rawScore) / maxScore) * 100);
  const effPct = round1(norm.effectivePct);
  if (status === 'late' && effPct !== rawPct) {
    return `<p class="text-xs text-amber-700 mt-2 flex items-center gap-1.5"><sl-icon name="info-circle"></sl-icon> Late policy applies: ${num(rawPct)}% → <strong>${num(effPct)}%</strong> (${esc(letterForPercent(effPct, course))})</p>`;
  }
  if (status === 'late') {
    return `<p class="text-xs text-slate-500 mt-2">This category has no late penalty configured. Set one in class settings → Categories &amp; policies.</p>`;
  }
  return `<p class="text-xs text-slate-500 mt-2 tabular-nums">${rawPct}% · ${esc(letterForPercent(rawPct, course))}</p>`;
}

/**
 * Renders rubric scoring grid.
 */
export function renderRubricSection({ rubric, rubricEval = {}, rubricComments = {}, maxScore = 100, isProficiency = false }) {
  if (!rubric) return '';
  const score = RubricScorer.calculateScore(rubric, rubricEval);
  const scaled = score.totalPossible > 0 ? round1((score.totalEarned / score.totalPossible) * maxScore) : 0;
  return `
    <section class="space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-semibold text-slate-900 flex items-center gap-2"><sl-icon name="grid-3x3" class="text-violet-600"></sl-icon> ${esc(rubric.title)}</h3>
        <span class="text-xs tabular-nums text-slate-500">${num(score.totalEarned)} / ${num(score.totalPossible)} rubric pts${isProficiency ? '' : ` → <strong class="text-slate-900">${num(scaled)} / ${num(maxScore)}</strong>`}</span>
      </div>
      <div class="space-y-3">
        ${(rubric.criteria || []).map(c => `
          <div class="rounded-xl border border-slate-200 p-3 space-y-2">
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-sm font-medium text-slate-800">${esc(c.name)}</span>
              ${c.weight && c.weight !== 1 ? `<span class="text-[11px] text-slate-400">×${num(c.weight, 1)}</span>` : ''}
            </div>
            <div class="grid gap-1.5" style="grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));">
              ${(rubric.tiers || []).map(t => {
                const cell = c.cells?.[t.id];
                const pts = cell ? (cell.points ?? t.default_points ?? 0) : (t.default_points ?? 0);
                const active = rubricEval[c.id] === t.id;
                return `
                  <button type="button" class="kb-rubric-pick text-left rounded-lg border p-2 transition-colors ${active ? 'kb-rubric-active' : 'border-slate-200 hover:bg-slate-50'}"
                    data-crit="${esc(c.id)}" data-tier="${esc(t.id)}" aria-pressed="${active}">
                    <span class="flex items-center justify-between gap-1 text-[11px] font-semibold text-slate-700"><span class="truncate">${esc(t.label)}</span><span class="tabular-nums text-blue-600">${num(pts)}</span></span>
                    ${cell?.descriptor ? `<span class="block text-[11px] leading-snug text-slate-500 mt-1">${esc(cell.descriptor)}</span>` : ''}
                  </button>`;
              }).join('')}
            </div>
            <sl-input size="small" class="kb-rubric-comment" data-crit="${esc(c.id)}" placeholder="Comment on ${esc(c.name.toLowerCase())} (optional)" value="${esc(rubricComments[c.id] || '')}"></sl-input>
          </div>
        `).join('')}
      </div>
    </section>`;
}

/**
 * Renders standards evidence section.
 */
export function renderStandardsSection({ standards = [], levels = [], standardScores = {}, standardComments = {} }) {
  if (!standards.length) return '';
  return `
    <section class="space-y-3">
      <h3 class="text-sm font-semibold text-slate-900 flex items-center gap-2"><sl-icon name="bullseye" class="text-blue-600"></sl-icon> Standards evidence</h3>
      ${standards.map(s => `
        <div class="rounded-xl border border-slate-200 p-3 space-y-2">
          <div>
            <span class="text-xs font-bold text-blue-700 tabular-nums">${esc(s.code)}</span>
            <p class="text-xs text-slate-600 leading-snug mt-0.5">${esc(s.description)}</p>
          </div>
          ${renderLevelButtons(levels, standardScores[s.id], `data-std="${esc(s.id)}"`)}
          <sl-input size="small" class="kb-std-comment" data-std="${esc(s.id)}" placeholder="Feedback on this standard (optional)" value="${esc(standardComments[s.id] || '')}"></sl-input>
        </div>
      `).join('')}
    </section>`;
}
