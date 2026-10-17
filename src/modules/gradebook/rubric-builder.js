import { generateUUID } from '../../utils/uuid.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { GradebookMathEngine } from './engine-calc.js';
import { toast } from '../../utils/toast.js';

/**
 * Multi-Criteria Rubric Designer & Real-Time Scoring Matrix (KB-GRAD-003)
 */
export class RubricScorer {
  /**
   * Calculate real-time weighted score from rubric evaluation
   * @param {object} rubric - { criteria: [], tiers: [] }
   * @param {Record<string, string>} selectedEval - criterion_id -> tier_id
   * @returns {{ totalEarned: number, totalPossible: number, percent: number, letter: string }}
   */
  static calculateScore(rubric, selectedEval = {}) {
    if (!rubric || !rubric.criteria) {
      return { totalEarned: 0, totalPossible: 0, percent: 0, letter: 'F' };
    }

    let totalEarned = 0;
    let totalPossible = 0;

    for (const crit of rubric.criteria) {
      const weight = crit.weight !== undefined ? crit.weight : 1.0;
      const tierId = selectedEval[crit.id];

      // Max possible for this criterion
      let maxPts = 0;
      for (const tier of (rubric.tiers || [])) {
        const cell = crit.cells ? crit.cells[tier.id] : null;
        const pts = cell ? (cell.points ?? tier.default_points ?? 0) : (tier.default_points ?? 0);
        if (pts > maxPts) maxPts = pts;
      }
      totalPossible += maxPts * weight;

      // Selected points
      if (tierId) {
        const cell = crit.cells ? crit.cells[tierId] : null;
        const pts = cell ? (cell.points ?? 0) : 0;
        totalEarned += pts * weight;
      }
    }

    const percent = totalPossible > 0 ? Number(((totalEarned / totalPossible) * 100).toFixed(1)) : 0;
    const letter = GradebookMathEngine.percentageToLetter(percent);

    return { totalEarned, totalPossible, percent, letter };
  }

  /**
   * Open interactive click-scorer drawer for an assignment and student
   */
  static openScoringDrawer(rubric, existingGradeRecord, onCommit) {
    if (typeof document === 'undefined') return;

    const existing = document.getElementById('sl-rubric-scorer-drawer');
    if (existing) existing.remove();

    const drawer = document.createElement('sl-drawer');
    drawer.id = 'sl-rubric-scorer-drawer';
    drawer.label = `Rubric Grading: ${rubric.title}`;
    drawer.style.setProperty('--size', '720px');

    const selectedEval = { ...(existingGradeRecord?.rubric_eval || {}) };
    let currentFeedback = existingGradeRecord?.feedback || '';

    const updateUI = () => {
      const score = this.calculateScore(rubric, selectedEval);
      const scoreBadge = drawer.querySelector('#rubric-score-badge');
      if (scoreBadge) {
        scoreBadge.innerHTML = `
          <span class="font-bold text-slate-800 text-lg">${score.totalEarned} / ${score.totalPossible} pts</span>
          <span class="text-sm font-bold text-blue-600 ml-2">(${score.percent}% — ${score.letter})</span>
        `;
      }

      // Update active highlight classes on grid cells
      drawer.querySelectorAll('.rubric-cell-btn').forEach(btn => {
        const cId = btn.getAttribute('data-crit-id');
        const tId = btn.getAttribute('data-tier-id');
        const isSelected = selectedEval[cId] === tId;
        btn.classList.toggle('kb-rubric-active', isSelected);
        btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      });

      const feedbackArea = drawer.querySelector('#rubric-feedback-textarea');
      if (feedbackArea) {
        feedbackArea.value = currentFeedback;
      }
    };

    drawer.innerHTML = `
      <div class="space-y-4">
        <!-- Live Score Summary Banner -->
        <div class="bg-blue-50 border border-blue-200 p-3 rounded-xl flex items-center justify-between">
          <span class="text-xs font-semibold uppercase text-blue-800 tracking-wider">Evaluation Score</span>
          <div id="rubric-score-badge"></div>
        </div>

        <!-- Rubric Interactive Grid Table -->
        <div class="overflow-x-auto border rounded-xl">
          <table class="w-full text-left text-xs border-collapse">
            <thead class="bg-slate-100 font-semibold text-slate-700">
              <tr>
                <th class="p-2.5 border-b border-r w-36">Criteria</th>
                ${(rubric.tiers || []).map(t => `
                  <th class="p-2.5 border-b border-r text-center">
                    <div>${Sanitizer.escapeHtml(t.label)}</div>
                    <span class="text-[10px] text-slate-400 font-mono">(${t.default_points} pts)</span>
                  </th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              ${(rubric.criteria || []).map(c => `
                <tr class="border-b">
                  <td class="p-2.5 border-r font-medium text-slate-900 bg-slate-50">
                    <div>${Sanitizer.escapeHtml(c.name)}</div>
                    <span class="text-[10px] text-slate-400">Weight: ${c.weight || 1.0}x</span>
                  </td>
                  ${(rubric.tiers || []).map(t => {
                    const cell = c.cells ? c.cells[t.id] : null;
                    const pts = cell ? (cell.points ?? t.default_points ?? 0) : (t.default_points ?? 0);
                    const desc = cell ? (cell.descriptor || '') : '';
                    return `
                      <td class="p-1 border-r text-center align-top">
                        <button type="button" data-crit-id="${c.id}" data-tier-id="${t.id}" data-desc="${Sanitizer.escapeHtml(desc)}" data-crit-name="${Sanitizer.escapeHtml(c.name)}" data-tier-label="${Sanitizer.escapeHtml(t.label)}"
                                class="rubric-cell-btn w-full h-full p-2 rounded border border-slate-200 text-left hover:bg-slate-50 transition-colors flex flex-col justify-between min-h-[70px]">
                          <span class="text-[11px] text-slate-700 leading-tight">${Sanitizer.escapeHtml(desc || 'No descriptor')}</span>
                          <span class="text-[10px] font-bold text-blue-600 font-mono self-end mt-1">${pts} pts</span>
                        </button>
                      </td>
                    `;
                  }).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <!-- Student Feedback Auto-Append Box -->
        <div>
          <label class="text-xs font-semibold text-slate-700 block mb-1">Qualitative Feedback to Student</label>
          <sl-textarea id="rubric-feedback-textarea" rows="4" placeholder="Feedback notes auto-generate from clicked rubric criteria..."></sl-textarea>
        </div>
      </div>

      <div slot="footer" class="flex justify-end gap-2">
        <sl-button variant="default" id="btn-cancel-rubric">Cancel</sl-button>
        <sl-button variant="primary" id="btn-apply-rubric">Apply Grade &amp; Feedback</sl-button>
      </div>
    `;

    document.body.appendChild(drawer);
    drawer.show();

    // Event binding
    drawer.querySelectorAll('.rubric-cell-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const cId = btn.getAttribute('data-crit-id');
        const tId = btn.getAttribute('data-tier-id');
        const desc = btn.getAttribute('data-desc');
        const cName = btn.getAttribute('data-crit-name');
        const tLabel = btn.getAttribute('data-tier-label');

        selectedEval[cId] = tId;

        // Auto-append feedback descriptor: "[Criteria - Tier]: Descriptor text"
        const descriptorSnippet = `[${cName} - ${tLabel}]: ${desc}`;
        // Remove prior descriptor for this criterion if present
        const regex = new RegExp(`\\[${cName} - [^\\]]+\\]: [^\\n]+`, 'g');
        if (currentFeedback.match(regex)) {
          currentFeedback = currentFeedback.replace(regex, descriptorSnippet);
        } else {
          currentFeedback = currentFeedback ? `${currentFeedback}\n${descriptorSnippet}` : descriptorSnippet;
        }

        updateUI();
      });
    });

    const feedbackEl = drawer.querySelector('#rubric-feedback-textarea');
    feedbackEl?.addEventListener('sl-input', (e) => {
      currentFeedback = e.target.value;
    });

    drawer.querySelector('#btn-apply-rubric')?.addEventListener('click', () => {
      const score = this.calculateScore(rubric, selectedEval);
      drawer.remove();
      if (typeof onCommit === 'function') {
        onCommit({
          raw_score: score.totalEarned,
          max_score: score.totalPossible,
          rubric_eval: selectedEval,
          feedback: currentFeedback
        });
      }
    });

    drawer.querySelector('#btn-cancel-rubric')?.addEventListener('click', () => drawer.remove());
    updateUI();
  }
}

export default RubricScorer;
