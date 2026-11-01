import { generateUUID } from '../../utils/uuid.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { GradebookMathEngine } from './engine-calc.js';
import { storage } from '../../core/storage.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog, kbModal } from '../../utils/dialogs.js';

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
        // Fix: use cell.points ?? tier.default_points so 0 pts is preserved
        const pts = (cell && cell.points !== undefined && cell.points !== null)
          ? Number(cell.points)
          : (tier && tier.default_points !== undefined && tier.default_points !== null ? Number(tier.default_points) : 0);
        if (pts > maxPts) maxPts = pts;
      }
      totalPossible += maxPts * weight;

      // Selected points
      if (tierId) {
        const tier = (rubric.tiers || []).find(t => t.id === tierId);
        const cell = crit.cells ? crit.cells[tierId] : null;
        const pts = (cell && cell.points !== undefined && cell.points !== null)
          ? Number(cell.points)
          : (tier && tier.default_points !== undefined && tier.default_points !== null ? Number(tier.default_points) : 0);
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
        <!-- Live Score Summary Header -->
        <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
          <div>
            <span class="text-xs font-semibold text-slate-500 uppercase tracking-wider block">Calculated Rubric Score</span>
            <div id="rubric-score-badge" class="mt-0.5"></div>
          </div>
          <sl-button size="small" variant="default" id="btn-clear-rubric-eval">
            <sl-icon slot="prefix" name="arrow-counterclockwise"></sl-icon> Reset
          </sl-button>
        </div>

        <!-- Rubric Grid Matrix -->
        <div class="space-y-4 max-h-[500px] overflow-y-auto pr-1">
          ${(rubric.criteria || []).map(crit => `
            <div class="border border-slate-200 rounded-xl p-3 bg-white space-y-2">
              <div class="flex items-center justify-between">
                <div>
                  <span class="font-bold text-slate-900 text-sm">${Sanitizer.escapeHTML(crit.name)}</span>
                  ${crit.weight && crit.weight !== 1.0 ? `
                    <span class="text-xs text-slate-400 font-mono ml-2">(Weight: ${Sanitizer.escapeHTML(crit.weight)}x)</span>
                  ` : ''}
                </div>
              </div>

              <!-- Tiers row for this criterion -->
              <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                ${(rubric.tiers || []).map(tier => {
                  const cell = crit.cells ? crit.cells[tier.id] : null;
                  const pts = (cell && cell.points !== undefined && cell.points !== null)
                    ? Number(cell.points)
                    : (tier.default_points !== undefined && tier.default_points !== null ? Number(tier.default_points) : 0);
                  const desc = cell ? cell.descriptor || '' : '';
                  return `
                    <button type="button"
                      class="rubric-cell-btn text-left p-2.5 rounded-lg border border-slate-200 hover:border-blue-400 hover:bg-slate-50 transition-all cursor-pointer flex flex-col justify-between"
                      data-crit-id="${Sanitizer.escapeHTML(crit.id)}"
                      data-tier-id="${Sanitizer.escapeHTML(tier.id)}"
                      data-desc="${Sanitizer.escapeHTML(desc)}"
                      data-crit-name="${Sanitizer.escapeHTML(crit.name)}"
                      data-tier-label="${Sanitizer.escapeHTML(tier.label)}"
                    >
                      <div>
                        <div class="flex items-center justify-between text-xs font-semibold text-slate-800">
                          <span>${Sanitizer.escapeHTML(tier.label)}</span>
                          <span class="text-blue-600 font-mono">${Sanitizer.escapeHTML(Sanitizer.safeNumber(pts))} pts</span>
                        </div>
                        <p class="text-xs text-slate-500 mt-1 line-clamp-3 leading-relaxed">
                          ${desc ? Sanitizer.escapeHTML(desc) : '<span class="italic text-slate-300">No descriptor</span>'}
                        </p>
                      </div>
                    </button>
                  `;
                }).join('')}
              </div>
            </div>
          `).join('')}
        </div>

        <!-- Qualitative Feedback Box -->
        <div class="pt-2 border-t border-slate-100">
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

        const descriptorSnippet = `[${cName} - ${tLabel}]: ${desc}`;
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

    drawer.querySelector('#btn-clear-rubric-eval')?.addEventListener('click', () => {
      for (const k of Object.keys(selectedEval)) delete selectedEval[k];
      updateUI();
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
   * Create a new rubric via modal dialog. Returns Promise<rubric | null>.
   * @param {object} options
   * @param {string|null} [options.courseId=null]
   * @param {string} [options.initialTitle='New Rubric']
   * @returns {Promise<object|null>}
   */
  static async create({ courseId = null, initialTitle = 'New Rubric' } = {}) {
    const newRubric = {
      id: generateUUID(),
      course_id: courseId,
      title: initialTitle,
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
    return this._showDesignerModal(newRubric, false);
  }

  /**
   * Edit an existing rubric via modal dialog. Returns Promise<rubric | null>.
   * @param {object} rubric
   * @returns {Promise<object|null>}
   */
  static async edit(rubric) {
    if (!rubric) return null;
    const clone = JSON.parse(JSON.stringify(rubric));
    return this._showDesignerModal(clone, true);
  }

  /**
   * Backwards compatible helper for existing callers.
   */
  static async openDesignerModal({ courseId, rubric, onSave }) {
    const result = rubric ? await this.edit(rubric) : await this.create({ courseId });
    if (result && typeof onSave === 'function') {
      onSave(result);
    }
    return result;
  }

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

    dialog.querySelector('#btn-new-rubric')?.addEventListener('click', async () => {
      dialog.hide();
      const saved = await this.create({ courseId: course?.id || null });
      if (saved && onUpdate) onUpdate(saved);
    });

    dialog.querySelectorAll('.btn-edit-rubric').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const rubric = rubrics.find(r => r.id === id);
        if (rubric) {
          dialog.hide();
          const saved = await this.edit(rubric);
          if (saved && onUpdate) onUpdate(saved);
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
          if (onUpdate) onUpdate();
        }
      });
    });

    dialog.querySelector('#btn-close-rubrics-mgr')?.addEventListener('click', () => dialog.remove());
  }

  /**
   * Internal helper using kbModal returning Promise<rubric | null>
   * @private
   */
  static async _showDesignerModal(initialRubric, isEditing) {
    const currentRubric = JSON.parse(JSON.stringify(initialRubric));
    let savedRecord = null;
    let focusTargetId = null;

    const res = await kbModal({
      title: isEditing ? `Edit Rubric: ${currentRubric.title}` : 'Design New Rubric',
      width: '880px',
      body: '<div id="rubric-designer-mount" class="space-y-4"></div>',
      actions: [
        { value: 'cancel', label: 'Cancel', dismiss: true },
        {
          value: 'save',
          label: 'Save Rubric',
          variant: 'primary',
          validate: async () => {
            // Validate title
            if (!currentRubric.title || !currentRubric.title.trim()) {
              toast.warning('Please enter a rubric title.');
              return false;
            }
            // Validate tiers: at least two
            if (!currentRubric.tiers || currentRubric.tiers.length < 2) {
              toast.warning('At least two performance rating levels are required.');
              return false;
            }
            // Validate criteria: at least one
            if (!currentRubric.criteria || currentRubric.criteria.length < 1) {
              toast.warning('At least one criterion is required.');
              return false;
            }
            // Validate criterion names
            for (let i = 0; i < currentRubric.criteria.length; i++) {
              const c = currentRubric.criteria[i];
              if (!c.name || !c.name.trim()) {
                toast.warning(`Criterion #${i + 1} requires a name.`);
                return false;
              }
            }
            // Validate non-negative points
            for (const tier of currentRubric.tiers) {
              if (tier.default_points < 0) {
                toast.warning(`Points for "${tier.label}" must be non-negative.`);
                return false;
              }
            }
            for (const crit of currentRubric.criteria) {
              if (crit.cells) {
                for (const tId of Object.keys(crit.cells)) {
                  const cell = crit.cells[tId];
                  if (cell && cell.points !== undefined && cell.points < 0) {
                    toast.warning('Criterion cell points cannot be negative.');
                    return false;
                  }
                }
              }
            }

            // Sync cells structure
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
            savedRecord = currentRubric;
            return true;
          }
        }
      ],
      onReady: (dialog) => {
        const mount = dialog.querySelector('#rubric-designer-mount');

        const render = () => {
          if (!mount) return;
          mount.innerHTML = `
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
            <div class="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-2">
              <span class="text-xs font-semibold text-slate-700 block">Performance Tiers (Columns)</span>
              <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2" id="tiers-list-mount">
                ${currentRubric.tiers.map((t, idx) => `
                  <div class="p-2 border rounded-lg bg-white space-y-1">
                    <div class="flex items-center justify-between">
                      <span class="text-[10px] font-bold text-slate-400 font-mono">Tier ${idx + 1}</span>
                      ${currentRubric.tiers.length > 2 ? `
                        <button type="button" class="btn-del-tier text-slate-400 hover:text-red-600 p-0.5" data-tier-id="${Sanitizer.escapeHTML(t.id)}" title="Remove tier">
                          <sl-icon name="x-lg" class="text-xs"></sl-icon>
                        </button>
                      ` : ''}
                    </div>
                    <sl-input size="small" class="tier-label-inp" data-tier-id="${Sanitizer.escapeHTML(t.id)}" value="${Sanitizer.escapeHTML(t.label)}" placeholder="Tier Name"></sl-input>
                    <sl-input size="small" type="number" min="0" class="tier-pts-inp" data-tier-id="${Sanitizer.escapeHTML(t.id)}" value="${Sanitizer.escapeHTML(t.default_points)}" placeholder="Pts"></sl-input>
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

              <div class="space-y-3 max-h-[360px] overflow-y-auto pr-1" id="criteria-list-mount">
                ${currentRubric.criteria.map((c, cIdx) => `
                  <div class="p-3 border border-slate-200 rounded-xl bg-slate-50 space-y-2 crit-row" data-crit-id="${Sanitizer.escapeHTML(c.id)}">
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex items-center gap-2 flex-1">
                        <span class="font-bold text-slate-600 text-xs font-mono">#${cIdx + 1}</span>
                        <sl-input size="small" class="crit-name-inp flex-1" data-crit-id="${Sanitizer.escapeHTML(c.id)}" value="${Sanitizer.escapeHTML(c.name)}" placeholder="Criterion Name (press Enter to add row)"></sl-input>
                        <sl-input size="small" type="number" step="0.1" min="0" class="crit-weight-inp w-24" data-crit-id="${Sanitizer.escapeHTML(c.id)}" value="${Sanitizer.escapeHTML(c.weight ?? 1.0)}" label="Weight"></sl-input>
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
                        const pts = (cell && cell.points !== undefined && cell.points !== null)
                          ? Number(cell.points)
                          : (t.default_points !== undefined && t.default_points !== null ? Number(t.default_points) : 0);
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
          `;

          bindEvents();

          if (focusTargetId) {
            setTimeout(() => {
              const el = mount.querySelector(`.crit-name-inp[data-crit-id="${focusTargetId}"]`);
              el?.focus();
              focusTargetId = null;
            }, 50);
          }
        };

        const bindEvents = () => {
          mount.querySelector('#input-rubric-title')?.addEventListener('sl-input', (e) => {
            currentRubric.title = e.target.value;
          });

          mount.querySelectorAll('.tier-label-inp').forEach(inp => {
            inp.addEventListener('sl-input', () => {
              const tId = inp.getAttribute('data-tier-id');
              const tier = currentRubric.tiers.find(t => t.id === tId);
              if (tier) tier.label = inp.value;
            });
          });

          mount.querySelectorAll('.tier-pts-inp').forEach(inp => {
            inp.addEventListener('sl-input', () => {
              const tId = inp.getAttribute('data-tier-id');
              const tier = currentRubric.tiers.find(t => t.id === tId);
              if (tier) tier.default_points = Math.max(0, Number(inp.value) || 0);
            });
          });

          mount.querySelectorAll('.btn-del-tier').forEach(btn => {
            btn.addEventListener('click', () => {
              const tId = btn.getAttribute('data-tier-id');
              currentRubric.tiers = currentRubric.tiers.filter(t => t.id !== tId);
              render();
            });
          });

          mount.querySelector('#btn-add-tier')?.addEventListener('click', () => {
            currentRubric.tiers.push({
              id: generateUUID(),
              label: `Tier ${currentRubric.tiers.length + 1}`,
              default_points: (currentRubric.tiers.length + 1) * 10
            });
            render();
          });

          // Criteria inputs with Enter / Backspace keyboard navigation
          mount.querySelectorAll('.crit-name-inp').forEach((inp, idx) => {
            const cId = inp.getAttribute('data-crit-id');

            inp.addEventListener('sl-input', () => {
              const crit = currentRubric.criteria.find(c => c.id === cId);
              if (crit) crit.name = inp.value;
            });

            inp.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const newCritId = generateUUID();
                focusTargetId = newCritId;
                currentRubric.criteria.splice(idx + 1, 0, {
                  id: newCritId,
                  name: `Criterion ${currentRubric.criteria.length + 1}`,
                  weight: 1.0,
                  cells: {}
                });
                render();
              } else if (e.key === 'Backspace' && (!inp.value || inp.value.trim() === '') && currentRubric.criteria.length > 1) {
                e.preventDefault();
                const prevCrit = currentRubric.criteria[idx - 1] || currentRubric.criteria[idx + 1];
                focusTargetId = prevCrit ? prevCrit.id : null;
                currentRubric.criteria = currentRubric.criteria.filter(c => c.id !== cId);
                render();
              }
            });
          });

          mount.querySelectorAll('.crit-weight-inp').forEach(inp => {
            inp.addEventListener('sl-input', () => {
              const cId = inp.getAttribute('data-crit-id');
              const crit = currentRubric.criteria.find(c => c.id === cId);
              if (crit) crit.weight = Math.max(0, parseFloat(inp.value) || 1.0);
            });
          });

          mount.querySelectorAll('.btn-del-crit').forEach(btn => {
            btn.addEventListener('click', () => {
              const cId = btn.getAttribute('data-crit-id');
              currentRubric.criteria = currentRubric.criteria.filter(c => c.id !== cId);
              render();
            });
          });

          mount.querySelector('#btn-add-crit')?.addEventListener('click', () => {
            const newCritId = generateUUID();
            focusTargetId = newCritId;
            currentRubric.criteria.push({
              id: newCritId,
              name: `Criterion ${currentRubric.criteria.length + 1}`,
              weight: 1.0,
              cells: {}
            });
            render();
          });

          mount.querySelectorAll('.cell-desc-inp').forEach(area => {
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
        };

        render();
      }
    });

    if (res?.value === 'save') {
      return savedRecord;
    }
    return null;
  }
}

export default RubricScorer;
