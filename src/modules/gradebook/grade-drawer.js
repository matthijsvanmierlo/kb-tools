import { Sanitizer } from '../../core/sanitizer.js';
import { normalizeScore } from './engine-calc.js';
import { RubricScorer } from './rubric-builder.js';
import { getSbgConfig, getStandards, letterForPercent } from './grading-scales.js';
import {
  STATUSES,
  FEEDBACK_SNIPPETS,
  round1,
  renderStatusButtons,
  renderLevelButtons,
  renderPenaltyPreview,
  renderRubricSection,
  renderStandardsSection
} from './grade-widgets.js';

/**
 * Grade Details Drawer (KB-GRAD-007)
 *
 * One place to grade a single student on a single assignment:
 * score, submission status (on time / late / missing / excused), rubric scoring with
 * per-criterion comments, standards-based proficiency levels, and written feedback.
 * Opened from the grid by double-click, right-click, or Ctrl/⌘+Enter on a cell.
 */

const esc = (v) => Sanitizer.escapeHTML(v ?? '');
const num = (v, fallback = 0) => esc(Sanitizer.safeNumber(v, fallback));
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

export class GradeDetailsDrawer {
  /**
   * @param {object} opts
   * @param {object} opts.course
   * @param {object} opts.student
   * @param {object} opts.assignment
   * @param {object} opts.record - existing grade record (may be a blank placeholder)
   * @param {object|null} opts.rubric
   * @param {(record: object) => Promise<void>|void} opts.onSave
   * @param {(direction: 1|-1) => void} [opts.onNavigate] - open the previous/next student after saving
   * @param {string} [opts.positionLabel] - e.g. "3 of 28"
   */
  static open({ course, student, assignment, record, rubric, onSave, onNavigate, positionLabel }) {
    document.getElementById('kb-grade-drawer')?.remove();

    const state = {
      raw_score: record?.raw_score ?? null,
      status: record?.status || 'submitted',
      days_late: record?.days_late || 1,
      feedback: record?.feedback || '',
      rubric_eval: { ...(record?.rubric_eval || {}) },
      rubric_comments: { ...(record?.rubric_comments || {}) },
      standard_scores: { ...(record?.standard_scores || {}) },
      standard_comments: { ...(record?.standard_comments || {}) }
    };

    const isProficiency = assignment.scoring === 'proficiency';
    const sbg = getSbgConfig(course);
    const levels = [...sbg.levels].sort((a, b) => b.value - a.value);
    const allStandards = getStandards(course);
    const alignedStandards = (assignment.standard_ids || [])
      .map(id => allStandards.find(s => s.id === id))
      .filter(Boolean);
    // A proficiency assignment aligned to exactly one standard is scored by a single level
    const singleLevelMode = isProficiency && alignedStandards.length <= 1;
    const category = (course.categories || []).find(c => c.id === assignment.category_id);
    const policy = category?.policy || {};
    const maxScore = Number(assignment.max_score) || 0;

    const drawer = document.createElement('sl-drawer');
    drawer.id = 'kb-grade-drawer';
    drawer.label = 'Grade details';
    drawer.style.setProperty('--size', 'min(640px, 100vw)');

    const levelButtons = (current, attrs) => renderLevelButtons(levels, current, attrs);
    const penaltyPreview = () => renderPenaltyPreview({ rawScore: state.raw_score, maxScore, status: state.status, daysLate: state.days_late, policy, assignment, course });
    const rubricSection = () => renderRubricSection({ rubric, rubricEval: state.rubric_eval, rubricComments: state.rubric_comments, maxScore, isProficiency });
    const standardsSection = () => (alignedStandards.length === 0 || singleLevelMode) ? '' : renderStandardsSection({ standards: alignedStandards, levels, standardScores: state.standard_scores, standardComments: state.standard_comments });

    const render = () => {
      const scoreDisabled = state.status === 'missing' || state.status === 'exempt';
      drawer.innerHTML = `
        <div class="space-y-6">
          <!-- Context -->
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs font-medium text-slate-500 truncate">${esc(assignment.title)}${category ? ` · ${esc(category.name)}` : ''}${assignment.due_date ? ` · due ${esc(assignment.due_date)}` : ''}</p>
              <h2 class="text-lg font-bold text-slate-900 truncate">${esc(student.full_name)}</h2>
              <p class="text-xs text-slate-400 tabular-nums">${esc(student.student_id)}</p>
            </div>
            ${onNavigate ? `
              <div class="flex items-center gap-1 flex-shrink-0">
                <button type="button" class="kb-icon-btn is-outlined" id="btn-grade-prev" aria-label="Save and go to previous student"><sl-icon name="chevron-up"></sl-icon></button>
                ${positionLabel ? `<span class="text-xs text-slate-500 tabular-nums px-1">${esc(positionLabel)}</span>` : ''}
                <button type="button" class="kb-icon-btn is-outlined" id="btn-grade-next" aria-label="Save and go to next student"><sl-icon name="chevron-down"></sl-icon></button>
              </div>` : ''}
          </div>

          <!-- Status -->
          <section class="space-y-2">
            <h3 class="text-sm font-semibold text-slate-900">Submission status</h3>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2" role="radiogroup" aria-label="Submission status">
              ${STATUSES.map(st => {
                const active = state.status === st.value;
                return `
                  <button type="button" class="kb-status-btn flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${active ? st.active : 'border-slate-200 text-slate-600 hover:bg-slate-50'}"
                    data-status="${st.value}" role="radio" aria-checked="${active}">
                    <sl-icon name="${st.icon}"></sl-icon> ${st.label}
                  </button>`;
              }).join('')}
            </div>
            ${state.status === 'late' ? `
              <div class="flex items-center gap-3 pt-1">
                <sl-input id="input-grade-days-late" type="number" min="1" size="small" value="${num(state.days_late, 1)}" class="w-28" label="Days late"></sl-input>
                <p class="text-xs text-slate-500 pt-5">${policy.late_mode === 'daily' ? `−${num(policy.late_daily_pct)}% per day, capped at ${num(policy.max_late_cap_pct || 50)}%` : policy.late_mode === 'fixed' ? `Flat −${num(policy.late_deduct_pct)}% penalty` : 'No automatic penalty for this category'}</p>
              </div>` : ''}
            ${state.status === 'missing' ? `<p class="text-xs text-slate-500">Counts as ${num(policy.missing_floor_pct)}% until work is turned in.</p>` : ''}
            ${state.status === 'exempt' ? `<p class="text-xs text-slate-500">Excused work is left out of all averages.</p>` : ''}
          </section>

          <!-- Score -->
          <section class="space-y-2 ${scoreDisabled ? 'opacity-50 pointer-events-none' : ''}">
            <h3 class="text-sm font-semibold text-slate-900">${singleLevelMode ? (alignedStandards[0] ? `Proficiency · ${esc(alignedStandards[0].code)}` : 'Proficiency level') : 'Score'}</h3>
            ${singleLevelMode ? `
              ${alignedStandards[0] ? `<p class="text-xs text-slate-500 -mt-1">${esc(alignedStandards[0].description)}</p>` : ''}
              ${levelButtons(state.raw_score, 'data-single-level')}
            ` : `
              <div class="flex items-center gap-2">
                <sl-input id="input-grade-score" type="number" min="0" step="0.5" value="${esc(state.raw_score)}" class="w-32" aria-label="Points earned"></sl-input>
                <span class="text-sm text-slate-500 tabular-nums">/ ${num(maxScore)} pts</span>
                ${rubric ? '<span class="text-xs text-slate-400">· filled in by the rubric below, editable</span>' : ''}
              </div>
              <div id="grade-penalty-preview">${penaltyPreview()}</div>
            `}
          </section>

          ${rubricSection()}
          ${standardsSection()}

          <!-- Feedback -->
          <section class="space-y-2">
            <h3 class="text-sm font-semibold text-slate-900">Feedback to student</h3>
            <textarea id="input-grade-feedback" rows="4" class="kb-textarea" placeholder="What went well, and what to work on next…" aria-label="Feedback to student">${esc(state.feedback)}</textarea>
            <div class="flex flex-wrap gap-1.5">
              ${FEEDBACK_SNIPPETS.map((t, i) => `<button type="button" class="kb-snippet text-[11px] px-2 py-1 rounded-full border border-slate-200 text-slate-600 hover:bg-slate-50" data-snippet="${i}">+ ${esc(t)}</button>`).join('')}
            </div>
            <p class="text-[11px] text-slate-400">Feedback, rubric comments and standard comments are included in the student's encrypted report.</p>
          </section>
        </div>

        <div slot="footer" class="flex items-center justify-between gap-2 w-full">
          <button type="button" id="btn-grade-clear" class="text-sm font-medium text-red-600 hover:text-red-700 px-2 py-1 rounded-md hover:bg-red-50">Clear grade</button>
          <div class="flex items-center gap-2">
            <sl-button id="btn-grade-cancel">Cancel</sl-button>
            <sl-button variant="primary" id="btn-grade-save">Save <span class="kb-kbd ml-1.5 !bg-transparent !border-white/40 !text-white/80">Ctrl ↵</span></sl-button>
          </div>
        </div>
      `;
      bind();
    };

    const applyRubricToScore = () => {
      if (!rubric || isProficiency) return;
      const score = RubricScorer.calculateScore(rubric, state.rubric_eval);
      if (score.totalPossible > 0 && Object.keys(state.rubric_eval).length > 0) {
        state.raw_score = round1((score.totalEarned / score.totalPossible) * maxScore);
      }
    };

    const buildRecord = () => {
      const out = {
        ...clone(record || {}),
        course_id: course.id,
        student_id: student.student_id,
        assignment_id: assignment.id,
        status: state.status,
        raw_score: state.status === 'missing' || state.status === 'exempt'
          ? null
          : (state.raw_score === '' || state.raw_score === null || state.raw_score === undefined ? null : Number(state.raw_score)),
        feedback: state.feedback.trim() || undefined,
        graded_at: new Date().toISOString()
      };
      if (state.status === 'late') out.days_late = Math.max(1, Number(state.days_late) || 1);
      else delete out.days_late;
      if (rubric) {
        out.rubric_eval = state.rubric_eval;
        out.rubric_comments = Object.fromEntries(Object.entries(state.rubric_comments).filter(([, v]) => v && v.trim()));
      }
      if (alignedStandards.length > 0) {
        const scores = singleLevelMode && alignedStandards[0] && out.raw_score !== null
          ? { [alignedStandards[0].id]: out.raw_score }
          : Object.fromEntries(Object.entries(state.standard_scores).filter(([, v]) => v !== null && v !== undefined && v !== ''));
        out.standard_scores = scores;
        out.standard_comments = Object.fromEntries(Object.entries(state.standard_comments).filter(([, v]) => v && v.trim()));
        // Multi-standard proficiency work: the cell shows the mean level
        if (isProficiency && !singleLevelMode && out.raw_score === null && Object.keys(scores).length > 0 && state.status !== 'missing' && state.status !== 'exempt') {
          const vals = Object.values(scores).map(Number);
          out.raw_score = round1(vals.reduce((a, b) => a + b, 0) / vals.length);
        }
      }
      return out;
    };

    let saved = false;
    const save = async (navigateDir = 0) => {
      if (saved) return;
      saved = true;
      const rec = buildRecord();
      drawer.hide();
      await onSave(rec);
      if (navigateDir && onNavigate) onNavigate(navigateDir);
    };

    function bind() {
      drawer.querySelectorAll('.kb-status-btn').forEach(btn => btn.addEventListener('click', () => {
        state.status = btn.dataset.status;
        render();
      }));
      drawer.querySelector('#input-grade-days-late')?.addEventListener('sl-input', (e) => {
        state.days_late = Math.max(1, Number(e.target.value) || 1);
        const prev = drawer.querySelector('#grade-penalty-preview');
        if (prev) prev.innerHTML = penaltyPreview();
      });
      drawer.querySelector('#input-grade-score')?.addEventListener('sl-input', (e) => {
        state.raw_score = e.target.value === '' ? null : Number(e.target.value);
        const prev = drawer.querySelector('#grade-penalty-preview');
        if (prev) prev.innerHTML = penaltyPreview();
      });
      drawer.querySelectorAll('[data-single-level]').forEach(btn => btn.addEventListener('click', () => {
        const v = Number(btn.dataset.level);
        state.raw_score = Number(state.raw_score) === v && state.raw_score !== null ? null : v;
        render();
      }));
      drawer.querySelectorAll('.kb-level-btn[data-std]').forEach(btn => btn.addEventListener('click', () => {
        const id = btn.dataset.std;
        const v = Number(btn.dataset.level);
        state.standard_scores[id] = Number(state.standard_scores[id]) === v && state.standard_scores[id] !== undefined ? undefined : v;
        render();
      }));
      drawer.querySelectorAll('.kb-std-comment').forEach(inp => inp.addEventListener('sl-input', () => {
        state.standard_comments[inp.dataset.std] = inp.value;
      }));
      drawer.querySelectorAll('.kb-rubric-pick').forEach(btn => btn.addEventListener('click', () => {
        const { crit, tier } = btn.dataset;
        if (state.rubric_eval[crit] === tier) delete state.rubric_eval[crit];
        else state.rubric_eval[crit] = tier;
        applyRubricToScore();
        render();
      }));
      drawer.querySelectorAll('.kb-rubric-comment').forEach(inp => inp.addEventListener('sl-input', () => {
        state.rubric_comments[inp.dataset.crit] = inp.value;
      }));
      const fb = drawer.querySelector('#input-grade-feedback');
      fb?.addEventListener('input', () => { state.feedback = fb.value; });
      drawer.querySelectorAll('.kb-snippet').forEach(btn => btn.addEventListener('click', () => {
        const text = FEEDBACK_SNIPPETS[Number(btn.dataset.snippet)];
        state.feedback = state.feedback.trim() ? `${state.feedback.trim()}\n${text}` : text;
        if (fb) fb.value = state.feedback;
      }));
      drawer.querySelector('#btn-grade-save')?.addEventListener('click', () => save(0));
      drawer.querySelector('#btn-grade-next')?.addEventListener('click', () => save(1));
      drawer.querySelector('#btn-grade-prev')?.addEventListener('click', () => save(-1));
      drawer.querySelector('#btn-grade-cancel')?.addEventListener('click', () => drawer.hide());
      drawer.querySelector('#btn-grade-clear')?.addEventListener('click', () => {
        state.raw_score = null;
        state.status = 'submitted';
        state.rubric_eval = {};
        state.rubric_comments = {};
        state.standard_scores = {};
        state.standard_comments = {};
        state.feedback = '';
        render();
      });
    }

    drawer.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        save(0);
      }
    });
    drawer.addEventListener('sl-after-hide', (e) => {
      if (e.target === drawer) drawer.remove();
    });

    document.body.appendChild(drawer);
    render();
    drawer.show();
    return drawer;
  }
}

export default GradeDetailsDrawer;
