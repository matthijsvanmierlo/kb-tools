import { Sanitizer } from '../../core/sanitizer.js';
import { checkChoiceAnswer, checkKeywords } from './secure.js';

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
    this.renderTranscript();
    if (this.driver && typeof this.driver.play === 'function') {
      await this.driver.play().catch(() => {});
    }
  }

  triggerNextCheckpoint() {
    const nextIncomplete = this.checkpoints.find(cp => !this.completedIds.has(cp.id));
    if (nextIncomplete && typeof this.onTriggerCheckpoint === 'function') {
      this.isLocked = true;
      this.onTriggerCheckpoint(nextIncomplete);
    }
  }

  setTranscript(containerEl, rawTranscript) {
    this.transcriptContainer = containerEl;
    this.transcriptSegments = parseTranscriptSegments(rawTranscript);
    this.renderTranscript();
  }

  renderTranscript() {
    if (!this.transcriptContainer || !this.transcriptSegments || !this.transcriptSegments.length) return;
    const unlocked = getUnlockedTranscriptSegments(this.transcriptSegments, this.checkpoints, this.completedIds);

    this.transcriptContainer.innerHTML = `
      <div class="space-y-2 p-3 text-xs" role="region" aria-label="Interactive video transcript">
        <div class="flex items-center justify-between pb-1.5 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider text-[10px]">
          <span>Synchronized Transcript</span>
          <span>Checkpoint-Gated</span>
        </div>
        <div class="space-y-1.5 max-h-64 overflow-y-auto pr-1" id="transcript-scroll-area">
          ${unlocked.map(s => `
            <div class="p-2 rounded-lg transition-colors ${s.isLocked ? 'bg-slate-100 text-slate-400 border border-dashed border-slate-200' : 'hover:bg-slate-50 text-slate-700 bg-white border border-slate-100 shadow-2xs'} flex items-start gap-2">
              <span class="font-mono text-[10px] text-slate-400 flex-shrink-0 mt-0.5">
                ${Math.floor(s.start_sec / 60)}:${String(s.start_sec % 60).padStart(2, '0')}
              </span>
              <div class="flex-1 min-w-0">${s.displayHtml}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
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
            ...(this.secure ? { earnedPoints: 0, maxPoints: 0 } : {}),
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
            <span>${Sanitizer.safeNumber(checkpoint.points || 1, 1)} pt(s)</span>
          </div>

          <div class="text-sm font-medium text-slate-900">${promptHtml}</div>

          <div class="space-y-2" id="checkpoint-options-list">
            ${options.map(opt => `
              <label class="flex items-start gap-3 p-3 border rounded-lg cursor-pointer hover:bg-slate-50 transition-colors text-xs text-slate-800">
                <input type="${isMulti ? 'checkbox' : 'radio'}" name="cp-option" value="${Sanitizer.escapeHtml(opt.id)}" class="mt-0.5" />
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

      submitBtn?.addEventListener('click', async () => {
        const checkedInputs = Array.from(dialog.querySelectorAll('input[name="cp-option"]:checked'));
        if (checkedInputs.length === 0) {
          return;
        }

        const selectedIds = checkedInputs.map(i => i.value);
        let isCorrect = false;

        if (this.secure) {
          // Student-safe payload: compare salted hashes (null when instant feedback is off)
          submitBtn.loading = true;
          isCorrect = await checkChoiceAnswer(checkpoint, selectedIds, this.secure.salt);
          submitBtn.loading = false;
        } else if (isMulti) {
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
        if (isCorrect === null) {
          feedbackBox.className = 'p-3 rounded-lg text-xs bg-slate-50 border border-slate-200 text-slate-700';
          feedbackBox.innerHTML = '<strong>Answer saved.</strong> Your teacher will check it.';
        } else if (isCorrect) {
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
            <span>${Sanitizer.safeNumber(checkpoint.points || 1, 1)} pt(s)</span>
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

      dialog.querySelector('#btn-submit-open-response')?.addEventListener('click', async () => {
        const text = dialog.querySelector('#textarea-open-answer').value.trim();
        if (!text) return;

        // Keyword auto-score check
        let isCorrect = true;
        let earned = checkpoint.points || 1;
        if (this.secure) {
          const check = await checkKeywords(checkpoint, text, this.secure.salt);
          // No keywords at all = completion credit; feedback off = unknown until the teacher grades
          isCorrect = check !== null ? check : (checkpoint.auto_graded === false ? true : null);
          earned = isCorrect ? (checkpoint.points || 1) : 0;
        } else if (checkpoint.keywords && checkpoint.keywords.length > 0) {
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

/**
 * Parse raw transcript (string, SRT, VTT, [mm:ss] format, or object array) into structured segments.
 * @param {string|Array<{start_sec: number, end_sec?: number, text: string}>} raw
 * @returns {Array<{start_sec: number, end_sec: number, text: string}>}
 */
export function parseTranscriptSegments(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map(item => ({
      start_sec: typeof item.start_sec === 'number' ? item.start_sec : (item.start || 0),
      end_sec: typeof item.end_sec === 'number' ? item.end_sec : (item.end || item.start_sec || 0),
      text: item.text || item.content || ''
    })).sort((a, b) => a.start_sec - b.start_sec);
  }

  if (typeof raw !== 'string') return [];

  const text = raw.trim();
  if (!text) return [];

  const segments = [];
  const timecodeRegex = /(?:(\d{1,2}):)?(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/;
  const lines = text.split(/\r?\n/);
  let currentStart = null;
  let currentEnd = null;
  let currentTextLines = [];

  const parseTime = (h, m, s, ms) => {
    const hours = h ? parseInt(h, 10) : 0;
    const minutes = parseInt(m, 10);
    const seconds = parseInt(s, 10);
    const millis = ms ? parseInt(ms.padEnd(3, '0'), 10) : 0;
    return hours * 3600 + minutes * 60 + seconds + millis / 1000;
  };

  let hasTimecodes = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(timecodeRegex);
    if (match) {
      hasTimecodes = true;
      if (currentStart !== null && currentTextLines.length) {
        segments.push({
          start_sec: Math.round(currentStart),
          end_sec: Math.round(currentEnd || currentStart),
          text: currentTextLines.join(' ')
        });
        currentTextLines = [];
      }
      currentStart = parseTime(match[1], match[2], match[3], match[4]);
      currentEnd = parseTime(match[5], match[6], match[7], match[8]);
    } else if (line.match(/^\[?(\d{1,2}):(\d{2})\]?\s*(.*)$/)) {
      hasTimecodes = true;
      if (currentStart !== null && currentTextLines.length) {
        segments.push({
          start_sec: Math.round(currentStart),
          end_sec: Math.round(currentEnd || currentStart),
          text: currentTextLines.join(' ')
        });
        currentTextLines = [];
      }
      const m = line.match(/^\[?(\d{1,2}):(\d{2})\]?\s*(.*)$/);
      currentStart = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      currentEnd = currentStart;
      if (m[3]) currentTextLines.push(m[3]);
    } else if (currentStart !== null && line && !line.match(/^\d+$/) && line !== 'WEBVTT') {
      currentTextLines.push(line);
    }
  }

  if (currentStart !== null && currentTextLines.length) {
    segments.push({
      start_sec: Math.round(currentStart),
      end_sec: Math.round(currentEnd || currentStart),
      text: currentTextLines.join(' ')
    });
  }

  if (hasTimecodes && segments.length) {
    return segments.sort((a, b) => a.start_sec - b.start_sec);
  }

  // Fallback: split into paragraphs
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return paragraphs.map((para, idx) => ({
    start_sec: idx * 30,
    end_sec: (idx + 1) * 30,
    text: para
  }));
}

/**
 * Returns segments with anti-lookahead lock status applied.
 * Segments past the earliest incomplete checkpoint are locked and text is redacted.
 * @param {Array<{start_sec: number, end_sec: number, text: string}>} segments
 * @param {any[]} checkpoints
 * @param {Set<string>} completedIds
 */
export function getUnlockedTranscriptSegments(segments, checkpoints, completedIds) {
  if (!segments || !segments.length) return [];
  const sortedCps = [...(checkpoints || [])].sort((a, b) => a.timestamp_sec - b.timestamp_sec);
  const nextIncomplete = sortedCps.find(cp => !completedIds.has(cp.id));

  return segments.map(seg => {
    const isLocked = nextIncomplete ? (seg.start_sec > nextIncomplete.timestamp_sec) : false;
    let displayHtml = '';
    if (isLocked) {
      const lockMin = Math.floor(nextIncomplete.timestamp_sec / 60);
      const lockSec = String(nextIncomplete.timestamp_sec % 60).padStart(2, '0');
      displayHtml = `<span class="italic text-slate-400 select-none">🔒 [Transcript slice locked until checkpoint at ${lockMin}:${lockSec} is answered]</span>`;
    } else {
      displayHtml = Sanitizer.escapeHtml(seg.text);
    }

    return {
      ...seg,
      isLocked,
      displayHtml
    };
  });
}

export default VideoGatekeeper;
