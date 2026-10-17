import { Sanitizer } from '../../core/sanitizer.js';

/**
 * 250ms Playhead Gatekeeper & Anti-Scrub Enforcement (KB-VID-001)
 */
export class VideoGatekeeper {
  /**
   * @param {import('./drivers.js').VideoProviderDriver} driver
   * @param {any[]} checkpoints
   * @param {(checkpoint: any) => void} onTriggerCheckpoint
   */
  constructor(driver, checkpoints, onTriggerCheckpoint) {
    this.driver = driver;
    this.checkpoints = [...checkpoints].sort((a, b) => a.timestamp_sec - b.timestamp_sec);
    this.completedIds = new Set();
    this.maxReachedTime = 0;
    this.isLocked = false;
    this.lastPollMs = 0;
    this.rafId = null;
    this.onTriggerCheckpoint = onTriggerCheckpoint;
    this.responseLogs = []; // Stores student interaction logs
  }

  startLoop() {
    const tick = async (now) => {
      if (now - this.lastPollMs >= 250 && !this.isLocked) {
        this.lastPollMs = now;
        const currentTime = await this.driver.getCurrentTime();

        // 1. Find earliest incomplete checkpoint
        const nextIncomplete = this.checkpoints.find(cp => !this.completedIds.has(cp.id));

        // 2. Anti-Scrub Guard: Block seeking past unanswered checkpoints or unviewed video
        const allowedCeiling = nextIncomplete
          ? Math.min(this.maxReachedTime + 1.0, nextIncomplete.timestamp_sec + 0.35)
          : Math.max(this.maxReachedTime, currentTime);

        if (currentTime > allowedCeiling + 0.5) {
          const snapTarget = nextIncomplete && allowedCeiling >= nextIncomplete.timestamp_sec
            ? nextIncomplete.timestamp_sec
            : this.maxReachedTime;
          await this.driver.seekTo(snapTarget);
          this.rafId = requestAnimationFrame(tick);
          return;
        }

        if (currentTime > this.maxReachedTime) {
          this.maxReachedTime = currentTime;
        }

        // 3. Checkpoint Trigger Evaluation (t +/- 0.35s window)
        if (nextIncomplete && Math.abs(currentTime - nextIncomplete.timestamp_sec) <= 0.35) {
          this.isLocked = true;
          await this.driver.pause();
          if (typeof document !== 'undefined' && document.fullscreenElement) {
            await document.exitFullscreen().catch(() => {});
          }
          if (typeof this.onTriggerCheckpoint === 'function') {
            this.onTriggerCheckpoint(nextIncomplete);
          }
        }
      }
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  async resolveCheckpoint(checkpointId) {
    this.completedIds.add(checkpointId);
    this.isLocked = false;
    await this.driver.play();
  }

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Render non-closable Checkpoint Question Modal
   * @param {object} checkpoint
   * @param {(result: { checkpointId: string, earnedPoints: number, maxPoints: number, studentAnswer: any, isCorrect: boolean }) => void} onAnswered
   */
  renderCheckpointModal(checkpoint, onAnswered) {
    if (typeof document === 'undefined') return;

    const existing = document.getElementById('sl-checkpoint-dialog');
    if (existing) existing.remove();

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'sl-checkpoint-dialog';
    dialog.setAttribute('no-header', '');
    dialog.style.setProperty('--width', '580px');

    const promptHtml = Sanitizer.renderSTEMMarkdown(checkpoint.prompt_markdown || '');
    const startTime = performance.now();

    // Render by type
    if (checkpoint.type === 'note') {
      dialog.innerHTML = `
        <div class="space-y-4 p-4">
          <div class="flex items-center gap-2 text-blue-600 font-bold text-sm">
            <sl-icon name="pin-angle"></sl-icon> Video Note
          </div>
          <div class="text-sm text-slate-800">${promptHtml}</div>
          <div class="flex justify-end pt-2">
            <sl-button variant="primary" id="btn-continue-video">Continue Video</sl-button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
      dialog.show();

      dialog.querySelector('#btn-continue-video')?.addEventListener('click', () => {
        dialog.remove();
        this.resolveCheckpoint(checkpoint.id);
        if (onAnswered) {
          onAnswered({
            checkpointId: checkpoint.id,
            earnedPoints: 1,
            maxPoints: 1,
            studentAnswer: 'Viewed Note',
            isCorrect: true,
            latencyMs: Math.round(performance.now() - startTime)
          });
        }
      });
      return;
    }

    if (checkpoint.type === 'single_choice' || checkpoint.type === 'multi_choice') {
      const isMulti = checkpoint.type === 'multi_choice';
      const options = checkpoint.options || [];

      dialog.innerHTML = `
        <div class="space-y-4 p-4">
          <div class="flex items-center justify-between text-xs font-semibold text-slate-500 uppercase">
            <span>${isMulti ? 'Select All That Apply' : 'Multiple Choice Question'}</span>
            <span>${checkpoint.points || 1} pt(s)</span>
          </div>

          <div class="text-sm font-medium text-slate-900">${promptHtml}</div>

          <div class="space-y-2" id="checkpoint-options-list">
            ${options.map(opt => `
              <label class="flex items-start gap-3 p-3 border rounded-lg cursor-pointer hover:bg-slate-50 transition-colors text-xs text-slate-800">
                <input type="${isMulti ? 'checkbox' : 'radio'}" name="cp-option" value="${opt.id}" class="mt-0.5" />
                <span class="flex-1">${Sanitizer.escapeHtml(opt.text)}</span>
              </label>
            `).join('')}
          </div>

          <div id="checkpoint-feedback" class="hidden p-3 rounded-lg text-xs"></div>

          <div class="flex justify-end gap-2 pt-2">
            <sl-button variant="primary" id="btn-submit-answer">Submit Answer</sl-button>
            <sl-button variant="success" id="btn-continue-after-feedback" class="hidden">Continue Video</sl-button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);
      dialog.show();

      // Prevent closing via overlay click or escape
      dialog.addEventListener('sl-request-close', (e) => {
        e.preventDefault();
      });

      const submitBtn = dialog.querySelector('#btn-submit-answer');
      const continueBtn = dialog.querySelector('#btn-continue-after-feedback');
      const feedbackBox = dialog.querySelector('#checkpoint-feedback');

      submitBtn?.addEventListener('click', () => {
        const checkedInputs = Array.from(dialog.querySelectorAll('input[name="cp-option"]:checked'));
        if (checkedInputs.length === 0) {
          return;
        }

        const selectedIds = checkedInputs.map(i => i.value);
        let isCorrect = false;

        if (isMulti) {
          const correctIds = options.filter(o => o.is_correct).map(o => o.id);
          isCorrect = correctIds.length === selectedIds.length && correctIds.every(id => selectedIds.includes(id));
        } else {
          const selectedOpt = options.find(o => o.id === selectedIds[0]);
          isCorrect = selectedOpt ? !!selectedOpt.is_correct : false;
        }

        // Show feedback & rationales
        submitBtn.classList.add('hidden');
        continueBtn.classList.remove('hidden');

        feedbackBox.classList.remove('hidden');
        if (isCorrect) {
          feedbackBox.className = 'p-3 rounded-lg text-xs bg-emerald-50 border border-emerald-200 text-emerald-800';
          feedbackBox.innerHTML = `<strong>Correct!</strong> Good job.`;
        } else {
          feedbackBox.className = 'p-3 rounded-lg text-xs bg-red-50 border border-red-200 text-red-800';
          const rationales = options.filter(o => o.rationale).map(o => `<li>${Sanitizer.escapeHtml(o.rationale)}</li>`).join('');
          feedbackBox.innerHTML = `<strong>Incorrect.</strong> ${rationales ? `<ul class="list-disc ml-4 mt-1">${rationales}</ul>` : ''}`;
        }

        // Disable options
        dialog.querySelectorAll('input[name="cp-option"]').forEach(inp => inp.disabled = true);

        continueBtn?.addEventListener('click', () => {
          dialog.remove();
          this.resolveCheckpoint(checkpoint.id);
          if (onAnswered) {
            onAnswered({
              checkpointId: checkpoint.id,
              earnedPoints: isCorrect ? (checkpoint.points || 1) : 0,
              maxPoints: checkpoint.points || 1,
              studentAnswer: selectedIds,
              isCorrect,
              latencyMs: Math.round(performance.now() - startTime)
            });
          }
        });
      });
      return;
    }

    if (checkpoint.type === 'open_response') {
      dialog.innerHTML = `
        <div class="space-y-4 p-4">
          <div class="flex items-center justify-between text-xs font-semibold text-slate-500 uppercase">
            <span>Open Response Question</span>
            <span>${checkpoint.points || 1} pt(s)</span>
          </div>
          <div class="text-sm font-medium text-slate-900">${promptHtml}</div>
          <sl-textarea id="textarea-open-answer" rows="4" placeholder="Type your response here..."></sl-textarea>
          <div class="flex justify-end pt-2">
            <sl-button variant="primary" id="btn-submit-open-response">Submit Response</sl-button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
      dialog.show();

      dialog.addEventListener('sl-request-close', (e) => e.preventDefault());

      dialog.querySelector('#btn-submit-open-response')?.addEventListener('click', () => {
        const text = dialog.querySelector('#textarea-open-answer').value.trim();
        if (!text) return;

        // Keyword auto-score check
        let isCorrect = true;
        let earned = checkpoint.points || 1;
        if (checkpoint.keywords && checkpoint.keywords.length > 0) {
          const lower = text.toLowerCase();
          const matchCount = checkpoint.keywords.filter(kw => lower.includes(kw.toLowerCase())).length;
          isCorrect = matchCount > 0;
          earned = isCorrect ? (checkpoint.points || 1) : 0;
        }

        dialog.remove();
        this.resolveCheckpoint(checkpoint.id);
        if (onAnswered) {
          onAnswered({
            checkpointId: checkpoint.id,
            earnedPoints: earned,
            maxPoints: checkpoint.points || 1,
            studentAnswer: text,
            isCorrect,
            latencyMs: Math.round(performance.now() - startTime)
          });
        }
      });
    }
  }
}

export default VideoGatekeeper;
