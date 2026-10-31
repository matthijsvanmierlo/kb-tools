import { generateUUID } from '../../utils/uuid.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { GradebookMathEngine } from './engine-calc.js';
import { storage } from '../../core/storage.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog } from '../../utils/dialogs.js';

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
        const tier = (rubric.tiers || []).find(t => t.id === tierId);
        const cell = crit.cells ? crit.cells[tierId] : null;
        const pts = cell ? (cell.points ?? tier?.default_points ?? 0) : (tier?.default_points ?? 0);
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
          <span class="font-bold text-slate-800 text-lg">${Sanitizer.escapeHTML(Sanitizer.safeNumber(score.totalEarned))} / ${Sanitizer.escapeHTML(Sanitizer.safeNumber(score.totalPossible))} pts</span>
          <span class="text-sm font-bold text-blue-600 ml-2">(${Sanitizer.escapeHTML(Sanitizer.safeNumber(score.percent))}% — ${Sanitizer.escapeHTML(score.letter)})</span>
        `;
      }

      // Update active highlight classes on grid cells
      drawer.querySelectorAll('.rubric-cell-btn').forEach(btn => {
        const cId = btn.getAttribute('data-crit-id');
        const tId = btn.getAttribute('data-tier-id');
        const isSelected = selectedEval[cId] === tId;
        btn.classList.toggle('kb-rubric-active', isSelected);
        btn.classList.toggle('ring-2', isSelected);
        btn.classList.toggle('ring-blue-600', isSelected);
        btn.classList.toggle('bg-blue-50', isSelected);
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
                    <div>${Sanitizer.escapeHTML(t.label)}</div>
                    <span class="text-[10px] text-slate-400 font-mono">(${Sanitizer.escapeHTML(Sanitizer.safeNumber(t.default_points))} pts)</span>
                  </th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              ${(rubric.criteria || []).map(c => `
                <tr class="border-b">
                  <td class="p-2.5 border-r font-medium text-slate-900 bg-slate-50">
                    <div>${Sanitizer.escapeHTML(c.name)}</div>
                    <span class="text-[10px] text-slate-400">Weight: ${Sanitizer.escapeHTML(Sanitizer.safeNumber(c.weight || 1.0))}x</span>
                  </td>
                  ${(rubric.tiers || []).map(t => {
                    const cell = c.cells ? c.cells[t.id] : null;
                    const pts = cell ? (cell.points ?? t.default_points ?? 0) : (t.default_points ?? 0);
                    const desc = cell ? (cell.descriptor || '') : '';
                    return `
                      <td class="p-1 border-r text-center align-top">
                        <button type="button" data-crit-id="${Sanitizer.escapeHTML(c.id)}" data-tier-id="${Sanitizer.escapeHTML(t.id)}" data-desc="${Sanitizer.escapeHTML(desc)}" data-crit-name="${Sanitizer.escapeHTML(c.name)}" data-tier-label="${Sanitizer.escapeHTML(t.label)}"
                                class="rubric-cell-btn w-full h-full p-2 rounded border border-slate-200 text-left hover:bg-slate-50 transition-colors flex flex-col justify-between min-h-[70px]">
                          <span class="text-[11px] text-slate-700 leading-tight">${Sanitizer.escapeHTML(desc || 'No descriptor')}</span>
                          <span class="text-[10px] font-bold text-blue-600 font-mono self-end mt-1">${Sanitizer.escapeHTML(Sanitizer.safeNumber(pts))} pts</span>
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
        const safeName = String(cName ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\[${safeName} - [^\\]]+\\]: [^\\n]+`, 'g');
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
      drawer.hide();
      if (typeof onCommit === 'function') {
        onCommit({
          raw_score: score.totalEarned,
          max_score: score.totalPossible,
          rubric_eval: selectedEval,
          feedback: currentFeedback
        });
      }
    });

    drawer.querySelector('#btn-cancel-rubric')?.addEventListener('click', () => drawer.hide());
    drawer.addEventListener('sl-after-hide', (e) => {
      if (e.target === drawer) drawer.remove();
    });
    updateUI();
  }
}

/**
 * Multi-Criteria Rubric Designer Modal & Manager (KB-GRAD-004)
 */
export class RubricDesigner {
  /**
   * Open Rubric Management / Catalog Modal
   */
  static async openManagerModal(course, onUpdate) {
    const existing = document.getElementById('sl-rubrics-manager-dialog');
    if (existing) existing.remove();

    const courseId = course?.id || null;
    const courseName = course?.name || 'Class / Global';
    const rubrics = (await storage.table('gradebook_rubrics').toArray())
      .filter(r => !courseId || r.course_id === courseId || !r.course_id);

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'sl-rubrics-manager-dialog';
    dialog.label = `Rubrics Manager — ${courseName}`;
    dialog.style.setProperty('--width', '640px');

    dialog.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <p class="text-xs text-slate-500">Attach rubrics to assignments for 1-click criteria grading and instant feedback.</p>
          <sl-button size="small" variant="primary" id="btn-new-rubric">
            <sl-icon slot="prefix" name="plus"></sl-icon> New Rubric
          </sl-button>
        </div>

        <div class="space-y-2 max-h-80 overflow-y-auto" id="rubrics-list-mount">
          ${rubrics.length === 0 ? `
            <div class="text-center py-8 text-slate-400 text-xs">
              <sl-icon name="grid-3x3" class="text-2xl mb-1"></sl-icon>
              <p>No custom rubrics created for this course yet.</p>
            </div>
          ` : rubrics.map(r => `
            <div class="p-3 border rounded-xl bg-slate-50 flex items-center justify-between gap-3 text-xs">
              <div>
                <span class="font-bold text-slate-800 text-sm">${Sanitizer.escapeHTML(r.title)}</span>
                <p class="text-slate-500 text-[11px] mt-0.5 font-mono">
                  ${(r.criteria || []).length} criteria &bull; ${(r.tiers || []).length} performance tiers
                </p>
              </div>
              <div class="flex items-center gap-1.5">
                <sl-button size="small" variant="default" class="btn-edit-rubric" data-id="${Sanitizer.escapeHTML(r.id)}">
                  <sl-icon slot="prefix" name="pencil"></sl-icon> Edit
                </sl-button>
                <sl-button size="small" variant="text" class="btn-delete-rubric text-red-600" data-id="${Sanitizer.escapeHTML(r.id)}">
                  <sl-icon name="trash"></sl-icon>
                </sl-button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      <div slot="footer" class="flex justify-end">
        <sl-button variant="default" id="btn-close-rubrics-mgr">Close</sl-button>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target === dialog) dialog.remove();
    });

    dialog.querySelector('#btn-new-rubric')?.addEventListener('click', () => {
      dialog.hide();
      this.openDesignerModal({ courseId: course?.id || null, onSave: (saved) => onUpdate && onUpdate(saved) });
    });

    dialog.querySelectorAll('.btn-edit-rubric').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const rubric = rubrics.find(r => r.id === id);
        if (rubric) {
          dialog.hide();
          this.openDesignerModal({ courseId: course?.id || null, rubric, onSave: (saved) => onUpdate && onUpdate(saved) });
        }
      });
    });

    dialog.querySelectorAll('.btn-delete-rubric').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const confirmed = await ConfirmDialog.show({
          title: 'Delete Rubric',
          message: 'Are you sure you want to delete this rubric? Existing grades will retain their recorded scores.',
          confirmText: 'Delete',
          variant: 'danger'
        });
        if (confirmed) {
          await storage.table('gradebook_rubrics').delete(id);
          toast.info('Rubric deleted.');
          dialog.remove();
          onUpdate();
        }
      });
    });

    dialog.querySelector('#btn-close-rubrics-mgr')?.addEventListener('click', () => dialog.remove());
  }

  /**
   * Open Rubric Designer (Add/Edit Criteria & Tiers)
   */
  static openDesignerModal({ courseId, rubric, onSave }) {
    const isEditing = !!rubric;
    const currentRubric = isEditing ? JSON.parse(JSON.stringify(rubric)) : {
      id: generateUUID(),
      course_id: courseId,
      title: 'New Rubric',
      tiers: [
        { id: generateUUID(), label: 'Developing', default_points: 10 },
        { id: generateUUID(), label: 'Proficient', default_points: 20 },
        { id: generateUUID(), label: 'Mastery', default_points: 25 }
      ],
      criteria: [
        {
          id: generateUUID(),
          name: 'Content & Accuracy',
          weight: 1.0,
          cells: {}
        }
      ]
    };

    const dialog = document.createElement('sl-dialog');
    dialog.label = isEditing ? `Edit Rubric: ${currentRubric.title}` : 'Design New Rubric';
    dialog.style.setProperty('--width', '840px');

    const render = () => {
      dialog.innerHTML = `
        <div class="space-y-4">
          <!-- Title & Tiers Bar -->
          <div class="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
            <div class="md:col-span-8">
              <sl-input id="input-rubric-title" label="Rubric Title" value="${Sanitizer.escapeHTML(currentRubric.title || '')}" required></sl-input>
            </div>
            <div class="md:col-span-4 flex justify-end">
              <sl-button size="small" variant="default" id="btn-add-tier">
                <sl-icon slot="prefix" name="plus"></sl-icon> Add Performance Tier
              </sl-button>
            </div>
          </div>

          <!-- Tiers Configuration List -->
          <div class="bg-slate-50 p-3 rounded-xl border space-y-2">
            <span class="text-xs font-semibold text-slate-700 block">Performance Tiers (Columns)</span>
            <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2" id="tiers-list-mount">
              ${currentRubric.tiers.map((t, idx) => `
                <div class="p-2 border rounded-lg bg-white space-y-1">
                  <div class="flex items-center justify-between">
                    <span class="text-[10px] font-bold text-slate-400 font-mono">Tier ${idx + 1}</span>
                    ${currentRubric.tiers.length > 1 ? `
                      <button type="button" class="btn-del-tier text-slate-400 hover:text-red-600 p-0.5" data-tier-id="${Sanitizer.escapeHTML(t.id)}" title="Remove tier">
                        <sl-icon name="x-lg" class="text-xs"></sl-icon>
                      </button>
                    ` : ''}
                  </div>
                  <sl-input size="small" class="tier-label-inp" data-tier-id="${Sanitizer.escapeHTML(t.id)}" value="${Sanitizer.escapeHTML(t.label)}" placeholder="Tier Name"></sl-input>
                  <sl-input size="small" type="number" class="tier-pts-inp" data-tier-id="${Sanitizer.escapeHTML(t.id)}" value="${Sanitizer.escapeHTML(t.default_points)}" placeholder="Pts"></sl-input>
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Criteria Matrix Table -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold text-slate-700">Criteria &amp; Cell Descriptors (Rows)</span>
              <sl-button size="small" variant="default" id="btn-add-crit">
                <sl-icon slot="prefix" name="plus"></sl-icon> Add Criterion
              </sl-button>
            </div>

            <div class="space-y-3 max-h-[380px] overflow-y-auto pr-1" id="criteria-list-mount">
              ${currentRubric.criteria.map((c, cIdx) => `
                <div class="p-3 border rounded-xl bg-slate-50 space-y-2" data-crit-id="${Sanitizer.escapeHTML(c.id)}">
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2 flex-1">
                      <span class="font-bold text-slate-600 text-xs font-mono">#${cIdx + 1}</span>
                      <sl-input size="small" class="crit-name-inp flex-1" data-crit-id="${Sanitizer.escapeHTML(c.id)}" value="${Sanitizer.escapeHTML(c.name)}" placeholder="Criterion Name"></sl-input>
                      <sl-input size="small" type="number" step="0.1" class="crit-weight-inp w-24" data-crit-id="${Sanitizer.escapeHTML(c.id)}" value="${Sanitizer.escapeHTML(c.weight || 1.0)}" label="Weight"></sl-input>
                    </div>
                    ${currentRubric.criteria.length > 1 ? `
                      <button type="button" class="btn-del-crit text-slate-400 hover:text-red-600 p-1" data-crit-id="${Sanitizer.escapeHTML(c.id)}" title="Delete Criterion">
                        <sl-icon name="trash"></sl-icon>
                      </button>
                    ` : ''}
                  </div>

                  <!-- Per-Tier Descriptors -->
                  <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                    ${currentRubric.tiers.map(t => {
                      const cell = c.cells ? c.cells[t.id] : null;
                      const desc = cell ? cell.descriptor || '' : '';
                      const pts = cell && cell.points != null ? cell.points : t.default_points;
                      return `
                        <div class="p-2 border rounded-lg bg-white space-y-1">
                          <div class="flex items-center justify-between text-[10px] text-slate-500 font-medium">
                            <span>${Sanitizer.escapeHTML(t.label)}</span>
                            <span class="font-mono text-blue-600">${Sanitizer.escapeHTML(Sanitizer.safeNumber(pts))} pts</span>
                          </div>
                          <sl-textarea size="small" class="cell-desc-inp" data-crit-id="${Sanitizer.escapeHTML(c.id)}" data-tier-id="${Sanitizer.escapeHTML(t.id)}" rows="2" placeholder="Quality descriptor..." value="${Sanitizer.escapeHTML(desc)}"></sl-textarea>
                        </div>
                      `;
                    }).join('')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

        <div slot="footer" class="flex justify-end gap-2">
          <sl-button variant="default" id="btn-cancel-designer">Cancel</sl-button>
          <sl-button variant="primary" id="btn-save-rubric">Save Rubric</sl-button>
        </div>
      `;

      bindEvents();
    };

    const bindEvents = () => {
      // Title
      dialog.querySelector('#input-rubric-title')?.addEventListener('sl-input', (e) => {
        currentRubric.title = e.target.value;
      });

      // Tier inputs
      dialog.querySelectorAll('.tier-label-inp').forEach(inp => {
        inp.addEventListener('sl-input', () => {
          const tId = inp.getAttribute('data-tier-id');
          const tier = currentRubric.tiers.find(t => t.id === tId);
          if (tier) tier.label = inp.value;
        });
      });

      dialog.querySelectorAll('.tier-pts-inp').forEach(inp => {
        inp.addEventListener('sl-input', () => {
          const tId = inp.getAttribute('data-tier-id');
          const tier = currentRubric.tiers.find(t => t.id === tId);
          if (tier) tier.default_points = Number(inp.value) || 0;
        });
      });

      dialog.querySelectorAll('.btn-del-tier').forEach(btn => {
        btn.addEventListener('click', () => {
          const tId = btn.getAttribute('data-tier-id');
          currentRubric.tiers = currentRubric.tiers.filter(t => t.id !== tId);
          render();
        });
      });

      dialog.querySelector('#btn-add-tier')?.addEventListener('click', () => {
        currentRubric.tiers.push({
          id: generateUUID(),
          label: `Tier ${currentRubric.tiers.length + 1}`,
          default_points: (currentRubric.tiers.length + 1) * 10
        });
        render();
      });

      // Criteria inputs
      dialog.querySelectorAll('.crit-name-inp').forEach(inp => {
        inp.addEventListener('sl-input', () => {
          const cId = inp.getAttribute('data-crit-id');
          const crit = currentRubric.criteria.find(c => c.id === cId);
          if (crit) crit.name = inp.value;
        });
      });

      dialog.querySelectorAll('.crit-weight-inp').forEach(inp => {
        inp.addEventListener('sl-input', () => {
          const cId = inp.getAttribute('data-crit-id');
          const crit = currentRubric.criteria.find(c => c.id === cId);
          if (crit) crit.weight = parseFloat(inp.value) || 1.0;
        });
      });

      dialog.querySelectorAll('.btn-del-crit').forEach(btn => {
        btn.addEventListener('click', () => {
          const cId = btn.getAttribute('data-crit-id');
          currentRubric.criteria = currentRubric.criteria.filter(c => c.id !== cId);
          render();
        });
      });

      dialog.querySelector('#btn-add-crit')?.addEventListener('click', () => {
        currentRubric.criteria.push({
          id: generateUUID(),
          name: `Criterion ${currentRubric.criteria.length + 1}`,
          weight: 1.0,
          cells: {}
        });
        render();
      });

      // Cell descriptors
      dialog.querySelectorAll('.cell-desc-inp').forEach(area => {
        area.addEventListener('sl-input', () => {
          const cId = area.getAttribute('data-crit-id');
          const tId = area.getAttribute('data-tier-id');
          const crit = currentRubric.criteria.find(c => c.id === cId);
          if (crit) {
            if (!crit.cells) crit.cells = {};
            if (!crit.cells[tId]) {
              const tier = currentRubric.tiers.find(t => t.id === tId);
              crit.cells[tId] = { points: tier ? tier.default_points : 0, descriptor: '' };
            }
            crit.cells[tId].descriptor = area.value;
          }
        });
      });

      // Save
      dialog.querySelector('#btn-save-rubric')?.addEventListener('click', async () => {
        if (!currentRubric.title || !currentRubric.title.trim()) {
          toast.warning('Please enter a rubric title.');
          return;
        }
        if (currentRubric.tiers.length === 0) {
          toast.warning('At least one performance tier is required.');
          return;
        }
        if (currentRubric.criteria.length === 0) {
          toast.warning('At least one criterion is required.');
          return;
        }

        // Clean cells structure
        currentRubric.criteria.forEach(c => {
          if (!c.cells) c.cells = {};
          currentRubric.tiers.forEach(t => {
            if (!c.cells[t.id]) {
              c.cells[t.id] = { points: t.default_points, descriptor: '' };
            }
          });
        });

        await storage.table('gradebook_rubrics').put(currentRubric);
        toast.success(`Rubric "${currentRubric.title}" saved!`);
        dialog.hide();
        if (onSave) onSave(currentRubric);
      });

      dialog.querySelector('#btn-cancel-designer')?.addEventListener('click', () => dialog.hide());
      dialog.addEventListener('sl-after-hide', (e) => {
        if (e.target === dialog) dialog.remove();
      });
    };

    document.body.appendChild(dialog);
    dialog.show();
    render();
  }
}

export default RubricScorer;
