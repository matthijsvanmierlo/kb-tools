import { fsrs } from './fsrs.js';
import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { SketchCanvas } from './sketch-canvas.js';
import { RichTextEditor } from '../../components/rich-text-editor.js';

/**
 * Flashcard Study Player (KB-CARD-002)
 * Keyboard shortcuts: Space (Flip), 1 (Again), 2 (Hard), 3 (Good), 4 (Easy)
 * Web Speech TTS, 3D card flip, vector sketch rendering, real-time FSRS intervals,
 * study mode selector, and mid-study card quick-edit.
 */
export class StudyPlayer {
  constructor(deck, options = {}) {
    this.deck = deck;
    this.cards = deck.cards || [];
    this.onExit = options.onExit || null;

    this.studyMode = options.studyMode || 'due'; // 'due' | 'all' | 'difficult'
    this.queue = [];
    this.currentIndex = 0;
    this.isFlipped = false;
    this.reviewedCount = 0;
    this.keyListener = null;

    this._prepareQueue();
  }

  _prepareQueue() {
    if (this.studyMode === 'due') {
      const sortedDue = fsrs.getDueCardsSorted(this.cards);
      if (sortedDue.length > 0) {
        this.queue = sortedDue;
      } else {
        this.queue = [...this.cards];
      }
    } else if (this.studyMode === 'all') {
      // Shuffled
      this.queue = [...this.cards].sort(() => Math.random() - 0.5);
    } else if (this.studyMode === 'difficult') {
      // Sorted by highest difficulty or lowest stability
      this.queue = [...this.cards].sort((a, b) => (b.fsrs?.difficulty || 0) - (a.fsrs?.difficulty || 0));
    }
  }

  mount(containerEl) {
    this.container = containerEl;
    this._bindKeyboard();
    this._renderCurrentCard();

    return () => this.unmount();
  }

  unmount() {
    if (this.keyListener) {
      window.removeEventListener('keydown', this.keyListener);
      this.keyListener = null;
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }

  _bindKeyboard() {
    this.keyListener = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        this.flipCard();
      } else if (this.isFlipped) {
        if (e.key === '1') this.commitGrade(1);
        else if (e.key === '2') this.commitGrade(2);
        else if (e.key === '3') this.commitGrade(3);
        else if (e.key === '4') this.commitGrade(4);
      }
    };

    window.addEventListener('keydown', this.keyListener);
  }

  flipCard() {
    this.isFlipped = !this.isFlipped;
    const cardInner = this.container.querySelector('#study-card-inner');
    if (cardInner) {
      cardInner.classList.toggle('is-flipped', this.isFlipped);
    }
    const gradeBar = this.container.querySelector('#study-grade-dock');
    if (gradeBar) {
      gradeBar.classList.toggle('hidden', !this.isFlipped);
    }
  }

  speak(text, lang = 'en-US') {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      toast.warning('Web Speech API is not supported in this browser.');
      return;
    }

    window.speechSynthesis.cancel();

    const cleanText = text
      .replace(/\\ce\{([^}]+)\}/g, '$1')
      .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '$1 over $2')
      .replace(/[\$\\]/g, ' ')
      .replace(/<[^>]*>/g, '');

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = lang;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    window.speechSynthesis.speak(utterance);
  }

  async commitGrade(grade) {
    if (this.currentIndex >= this.queue.length) return;

    const card = this.queue[this.currentIndex];
    const updatedFsrs = fsrs.reviewCard(card, grade);
    card.fsrs = updatedFsrs;

    const deckCard = this.cards.find(c => c.id === card.id);
    if (deckCard) {
      deckCard.fsrs = updatedFsrs;
    }

    this.deck.updated_at = new Date().toISOString();
    await storage.table('flashcards').put(this.deck);

    this.reviewedCount += 1;
    this.isFlipped = false;
    this.currentIndex += 1;

    if (this.currentIndex < this.queue.length) {
      this._renderCurrentCard();
    } else {
      this._renderCompletionView();
    }
  }

  _formatInterval(days) {
    if (!days || days <= 0) return '<10m';
    if (days === 1) return '1d';
    if (days < 30) return `${Math.round(days)}d`;
    if (days < 365) return `${Math.round(days / 30)}mo`;
    return `${(days / 365).toFixed(1)}y`;
  }

  _renderCurrentCard() {
    if (this.queue.length === 0) {
      this.container.innerHTML = `
        <div class="max-w-xl mx-auto p-8 bg-white border border-slate-200 rounded-2xl text-center space-y-4 shadow-sm">
          <sl-icon name="check2-all" class="text-5xl text-emerald-500"></sl-icon>
          <h2 class="text-xl font-bold text-slate-800">No Cards to Study</h2>
          <p class="text-sm text-slate-500">This deck has no cards in the selected study mode.</p>
          <sl-button variant="primary" id="btn-empty-return">Back to Decks</sl-button>
        </div>
      `;
      this.container.querySelector('#btn-empty-return')?.addEventListener('click', () => {
        if (this.onExit) this.onExit();
      });
      return;
    }

    const card = this.queue[this.currentIndex];
    const total = this.queue.length;
    const progress = Math.round(((this.currentIndex) / total) * 100);

    const frontText = typeof card.front === 'string' ? card.front : (card.front?.text || '');
    const backText = typeof card.back === 'string' ? card.back : (card.back?.text || '');
    const frontHtml = Sanitizer.renderSTEMMarkdown(frontText);
    const backHtml = Sanitizer.renderSTEMMarkdown(backText);

    const frontSketch = card.front?.sketchData;
    const backSketch = card.back?.sketchData;

    // Real-time FSRS predicted next intervals for current card
    const nextAgain = this._formatInterval(fsrs.reviewCard(card, 1).scheduled_days);
    const nextHard = this._formatInterval(fsrs.reviewCard(card, 2).scheduled_days);
    const nextGood = this._formatInterval(fsrs.reviewCard(card, 3).scheduled_days);
    const nextEasy = this._formatInterval(fsrs.reviewCard(card, 4).scheduled_days);

    this.container.innerHTML = `
      <div class="max-w-2xl mx-auto space-y-4 select-none">
        <!-- Top Toolbar & Study Mode -->
        <div class="flex items-center justify-between text-xs text-slate-500">
          <div class="flex items-center gap-3">
            <button id="btn-study-back" class="flex items-center gap-1 hover:text-blue-600 font-medium">
              <sl-icon name="arrow-left"></sl-icon> Exit
            </button>
            <sl-select id="select-study-mode" size="small" value="${this.studyMode}" class="w-48" aria-label="Study mode">
              <sl-option value="due">FSRS Due Cards</sl-option>
              <sl-option value="all">Cram All Cards</sl-option>
              <sl-option value="difficult">Difficult First</sl-option>
            </sl-select>
          </div>

          <div class="flex items-center gap-3">
            <button id="btn-quick-edit-card" class="text-slate-400 hover:text-blue-600 p-1" title="Edit Card Typo">
              <sl-icon name="pencil"></sl-icon>
            </button>
            <span>Card ${this.currentIndex + 1} of ${total}</span>
            <span class="font-mono text-slate-400">(${progress}%)</span>
          </div>
        </div>

        <sl-progress-bar value="${progress}" class="h-1.5"></sl-progress-bar>

        <!-- 3D Flashcard Viewport -->
        <div id="study-card-box" class="cursor-pointer kb-flashcard-container min-h-96">
          <div id="study-card-inner" class="kb-flashcard-inner ${this.isFlipped ? 'is-flipped' : ''} bg-white border border-slate-200 rounded-3xl shadow-lg min-h-96">
            
            <!-- FRONT FACE -->
            <div class="kb-flashcard-face kb-flashcard-front bg-white rounded-3xl p-6 sm:p-8 flex flex-col">
              <div class="flex-shrink-0 flex justify-between items-center text-xs text-slate-400 border-b border-slate-100 pb-2">
                <span class="font-bold uppercase tracking-wider text-blue-600">Front (Prompt)</span>
                <button id="btn-tts-front" class="p-1 hover:text-blue-600 rounded" title="Read text aloud">
                  <sl-icon name="volume-up" class="text-lg"></sl-icon>
                </button>
              </div>

              <!-- Content Area -->
              <div class="kb-flashcard-content flex-1 min-h-0 overflow-y-auto py-4 text-center text-slate-800 text-lg sm:text-xl font-medium kb-prose flex flex-col">
                <div class="my-auto space-y-3">
                <div>${frontHtml}</div>
                ${frontSketch && frontSketch.length > 0 ? `
                  <canvas id="front-sketch-canvas" width="400" height="200" class="max-w-full rounded-lg border border-slate-200 bg-white mx-auto"></canvas>
                ` : ''}
                </div>
              </div>

              <div class="flex-shrink-0 text-center text-xs text-slate-400 border-t border-slate-100 pt-3">
                <span>Press <kbd class="px-1.5 py-0.5 bg-slate-100 border rounded font-mono text-slate-600">Space</kbd> or click to flip</span>
              </div>
            </div>

            <!-- BACK FACE -->
            <div class="kb-flashcard-face kb-flashcard-back bg-white rounded-3xl p-6 sm:p-8 flex flex-col">
              <div class="flex-shrink-0 flex justify-between items-center text-xs text-slate-400 border-b border-slate-100 pb-2">
                <span class="font-bold uppercase tracking-wider text-emerald-600">Back (Answer)</span>
                <button id="btn-tts-back" class="p-1 hover:text-emerald-600 rounded" title="Read text aloud">
                  <sl-icon name="volume-up" class="text-lg"></sl-icon>
                </button>
              </div>

              <!-- Content Area -->
              <div class="kb-flashcard-content flex-1 min-h-0 overflow-y-auto py-4 text-center text-slate-800 text-lg sm:text-xl font-medium kb-prose flex flex-col">
                <div class="my-auto space-y-3">
                <div>${backHtml}</div>
                ${backSketch && backSketch.length > 0 ? `
                  <canvas id="back-sketch-canvas" width="400" height="200" class="max-w-full rounded-lg border border-slate-200 bg-white mx-auto"></canvas>
                ` : ''}
                </div>
              </div>

              <div class="flex-shrink-0 text-center text-xs text-slate-400 border-t border-slate-100 pt-3">
                <span>Rate your recall below (<kbd class="px-1.5 py-0.5 bg-slate-100 border rounded font-mono text-slate-600">1–4</kbd>)</span>
              </div>
            </div>

          </div>
        </div>

        <!-- FSRS Grade Controls (Visible when flipped) -->
        <div id="study-grade-dock" class="${this.isFlipped ? '' : 'hidden'} grid grid-cols-4 gap-2 pt-2">
          <button data-grade="1" class="flex flex-col items-center py-2.5 px-1 rounded-xl border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 transition-all active:scale-95 shadow-xs">
            <span class="font-bold text-sm">Again</span>
            <span class="text-xs text-red-500 font-mono mt-0.5"><kbd class="bg-white px-1 border rounded">1</kbd> (${nextAgain})</span>
          </button>
          <button data-grade="2" class="flex flex-col items-center py-2.5 px-1 rounded-xl border border-amber-200 bg-amber-50 hover:bg-amber-100 text-amber-700 transition-all active:scale-95 shadow-xs">
            <span class="font-bold text-sm">Hard</span>
            <span class="text-xs text-amber-500 font-mono mt-0.5"><kbd class="bg-white px-1 border rounded">2</kbd> (${nextHard})</span>
          </button>
          <button data-grade="3" class="flex flex-col items-center py-2.5 px-1 rounded-xl border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-700 transition-all active:scale-95 shadow-xs">
            <span class="font-bold text-sm">Good</span>
            <span class="text-xs text-blue-500 font-mono mt-0.5"><kbd class="bg-white px-1 border rounded">3</kbd> (${nextGood})</span>
          </button>
          <button data-grade="4" class="flex flex-col items-center py-2.5 px-1 rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition-all active:scale-95 shadow-xs">
            <span class="font-bold text-sm">Easy</span>
            <span class="text-xs text-emerald-500 font-mono mt-0.5"><kbd class="bg-white px-1 border rounded">4</kbd> (${nextEasy})</span>
          </button>
        </div>
      </div>
    `;

    // Render sketches if present
    if (frontSketch && frontSketch.length > 0) {
      const c = this.container.querySelector('#front-sketch-canvas');
      SketchCanvas.renderStrokesToCanvas(c, frontSketch);
    }
    if (backSketch && backSketch.length > 0) {
      const c = this.container.querySelector('#back-sketch-canvas');
      SketchCanvas.renderStrokesToCanvas(c, backSketch);
    }

    // Card Click Flip
    this.container.querySelector('#study-card-box')?.addEventListener('click', (e) => {
      if (e.target.closest('#btn-tts-front') || e.target.closest('#btn-tts-back')) return;
      this.flipCard();
    });

    this.container.querySelector('#btn-study-back')?.addEventListener('click', () => {
      if (this.onExit) this.onExit();
    });

    this.container.querySelector('#btn-tts-front')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.speak(frontText, card.front?.ttsLang || 'en-US');
    });

    this.container.querySelector('#btn-tts-back')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.speak(backText, card.back?.ttsLang || 'en-US');
    });

    // Study Mode switch
    this.container.querySelector('#select-study-mode')?.addEventListener('sl-change', (e) => {
      this.studyMode = e.target.value;
      this.currentIndex = 0;
      this.isFlipped = false;
      this._prepareQueue();
      this._renderCurrentCard();
    });

    // Quick edit modal
    this.container.querySelector('#btn-quick-edit-card')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._openQuickEditModal(card);
    });

    // Grade Buttons
    this.container.querySelectorAll('#study-grade-dock button[data-grade]').forEach(btn => {
      btn.addEventListener('click', () => {
        const grade = Number(btn.getAttribute('data-grade'));
        this.commitGrade(grade);
      });
    });
  }

  _openQuickEditModal(card) {
    const dialog = document.createElement('sl-dialog');
    dialog.label = 'Quick Edit Card';
    dialog.style.setProperty('--width', '600px');

    const frontText = typeof card.front === 'string' ? card.front : (card.front?.text || '');
    const backText = typeof card.back === 'string' ? card.back : (card.back?.text || '');

    dialog.innerHTML = `
      <div class="space-y-4 py-1 text-sm">
        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">Card Front (Prompt)</label>
          <div id="quick-edit-front-mount"></div>
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">Card Back (Answer)</label>
          <div id="quick-edit-back-mount"></div>
        </div>
      </div>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button variant="default" id="btn-cancel-quick-edit">Cancel</sl-button>
        <sl-button variant="primary" id="btn-save-quick-edit">Save Changes</sl-button>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    const frontEditor = new RichTextEditor({ initialValue: frontText, mode: 'tabbed', minHeight: '100px' });
    const backEditor = new RichTextEditor({ initialValue: backText, mode: 'tabbed', minHeight: '100px' });

    dialog.querySelector('#quick-edit-front-mount')?.appendChild(frontEditor.element);
    dialog.querySelector('#quick-edit-back-mount')?.appendChild(backEditor.element);

    dialog.querySelector('#btn-cancel-quick-edit')?.addEventListener('click', () => dialog.hide());
    dialog.querySelector('#btn-save-quick-edit')?.addEventListener('click', async () => {
      if (typeof card.front === 'string') card.front = { text: frontEditor.getValue(), ttsLang: 'en-US' };
      else card.front.text = frontEditor.getValue();

      if (typeof card.back === 'string') card.back = { text: backEditor.getValue(), ttsLang: 'en-US' };
      else card.back.text = backEditor.getValue();

      this.deck.updated_at = new Date().toISOString();
      await storage.table('flashcards').put(this.deck);
      toast.success('Card updated!');
      dialog.hide();
      this._renderCurrentCard();
    });

    dialog.addEventListener('sl-after-hide', (e) => {
      // Nested selects/dropdowns emit bubbling sl-after-hide events too
      if (e.target !== dialog) return;
      frontEditor.destroy();
      backEditor.destroy();
      dialog.remove();
    });
  }

  _renderCompletionView() {
    this.container.innerHTML = `
      <div class="max-w-xl mx-auto p-8 bg-white border border-slate-200 rounded-3xl text-center space-y-6 shadow-sm">
        <div class="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto text-3xl">
          <sl-icon name="trophy"></sl-icon>
        </div>
        <div>
          <h2 class="text-2xl font-bold text-slate-800">Review Session Complete!</h2>
          <p class="text-sm text-slate-500 mt-1">You reviewed <strong>${this.reviewedCount}</strong> card(s) using the FSRS cognitive scheduler.</p>
        </div>

        <div class="grid grid-cols-2 gap-4 max-w-sm mx-auto text-left">
          <div class="bg-slate-50 p-4 rounded-xl border border-slate-200">
            <span class="text-xs text-slate-400 uppercase font-semibold">Cards Practiced</span>
            <p class="text-2xl font-bold text-slate-800 mt-0.5">${this.reviewedCount}</p>
          </div>
          <div class="bg-slate-50 p-4 rounded-xl border border-slate-200">
            <span class="text-xs text-slate-400 uppercase font-semibold">Retention Goal</span>
            <p class="text-2xl font-bold text-blue-600 mt-0.5">90%</p>
          </div>
        </div>

        <div class="flex justify-center gap-3 pt-2">
          <sl-button variant="default" id="btn-complete-exit">Back to Library</sl-button>
          <sl-button variant="primary" id="btn-complete-restart">Review Again</sl-button>
        </div>
      </div>
    `;

    this.container.querySelector('#btn-complete-exit')?.addEventListener('click', () => {
      if (this.onExit) this.onExit();
    });

    this.container.querySelector('#btn-complete-restart')?.addEventListener('click', () => {
      this.currentIndex = 0;
      this.reviewedCount = 0;
      this.isFlipped = false;
      this._prepareQueue();
      this._renderCurrentCard();
    });
  }
}

export default StudyPlayer;
