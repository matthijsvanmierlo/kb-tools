import { fsrs } from './fsrs.js';
import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';

/**
 * Flashcard Study Player (KB-CARD-002)
 * Keyboard shortcuts: Space (Flip), 1 (Again), 2 (Hard), 3 (Good), 4 (Easy)
 * Web Speech TTS, 3D card flip, and FSRS v4 review progression.
 */
export class StudyPlayer {
  constructor(deck, options = {}) {
    this.deck = deck;
    this.cards = deck.cards || [];
    this.onExit = options.onExit || null;

    this.queue = [];
    this.currentIndex = 0;
    this.isFlipped = false;
    this.reviewedCount = 0;
    this.keyListener = null;

    this._prepareQueue();
  }

  _prepareQueue() {
    // Get due cards sorted by risk (lowest retrievability first)
    const sortedDue = fsrs.getDueCardsSorted(this.cards);
    if (sortedDue.length > 0) {
      this.queue = sortedDue;
    } else {
      // If none due, study all cards in normal order
      this.queue = [...this.cards];
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
      // Avoid intercepting if an input element is focused
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
    const cardEl = this.container.querySelector('#study-card-inner');
    if (cardEl) {
      cardEl.classList.toggle('rotate-y-180', this.isFlipped);
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

    // Strip LaTeX and math markers before speech synthesis
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

    // Update in parent deck
    const deckCard = this.cards.find(c => c.id === card.id);
    if (deckCard) {
      deckCard.fsrs = updatedFsrs;
    }

    // Persist to storage
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

  _renderCurrentCard() {
    if (this.queue.length === 0) {
      this.container.innerHTML = `
        <div class="max-w-xl mx-auto p-8 bg-white border rounded-xl text-center space-y-4 shadow-sm">
          <sl-icon name="check2-all" class="text-5xl text-emerald-500"></sl-icon>
          <h2 class="text-xl font-bold text-slate-800">No Cards to Study</h2>
          <p class="text-sm text-slate-500">This deck is empty. Add cards using the deck editor.</p>
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

    const frontHtml = Sanitizer.renderSTEMMarkdown(card.front?.text || '');
    const backHtml = Sanitizer.renderSTEMMarkdown(card.back?.text || '');

    this.container.innerHTML = `
      <div class="max-w-2xl mx-auto space-y-4 select-none">
        <!-- Top Toolbar & Progress -->
        <div class="flex items-center justify-between text-xs text-slate-500">
          <button id="btn-study-back" class="flex items-center gap-1 hover:text-blue-600 font-medium">
            <sl-icon name="arrow-left"></sl-icon> Exit Session
          </button>
          <div class="flex items-center gap-3">
            <span>Card ${this.currentIndex + 1} of ${total}</span>
            <span class="font-mono text-slate-400">(${progress}%)</span>
          </div>
        </div>

        <sl-progress-bar value="${progress}" class="h-1.5"></sl-progress-bar>

        <!-- Flashcard Viewport -->
        <div id="study-card-box" class="cursor-pointer perspective-1000 min-h-96">
          <div id="study-card-inner" class="relative w-full min-h-96 transition-transform duration-300 transform-style-3d bg-white border border-slate-200 rounded-2xl shadow-md p-6 flex flex-col justify-between">
            
            <!-- Side Indicator & Audio -->
            <div class="flex justify-between items-center text-xs text-slate-400 border-b pb-2">
              <span class="font-semibold uppercase tracking-wider">${this.isFlipped ? 'Back (Answer)' : 'Front (Question)'}</span>
              <button id="btn-tts-speak" class="p-1 hover:text-blue-600 rounded" title="Read text aloud">
                <sl-icon name="volume-up" class="text-lg"></sl-icon>
              </button>
            </div>

            <!-- Card Content -->
            <div class="py-8 text-center text-slate-800 text-lg sm:text-xl font-medium overflow-y-auto max-h-72">
              ${this.isFlipped ? backHtml : frontHtml}
            </div>

            <!-- Bottom Flip Prompt -->
            <div class="text-center text-xs text-slate-400 border-t pt-2">
              <span>Press <kbd class="px-1.5 py-0.5 bg-slate-100 border rounded font-mono text-slate-600">Space</kbd> or click to flip</span>
            </div>
          </div>
        </div>

        <!-- FSRS Grade Controls (Visible when flipped) -->
        <div id="study-grade-dock" class="${this.isFlipped ? '' : 'hidden'} grid grid-cols-4 gap-2 pt-2">
          <button data-grade="1" class="flex flex-col items-center py-2 px-1 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 transition-colors">
            <span class="font-bold text-sm">Again</span>
            <span class="text-xs text-red-500 font-mono"><kbd class="bg-white px-1 border rounded">1</kbd> (&lt;10m)</span>
          </button>
          <button data-grade="2" class="flex flex-col items-center py-2 px-1 rounded-lg border border-amber-200 bg-amber-50 hover:bg-amber-100 text-amber-700 transition-colors">
            <span class="font-bold text-sm">Hard</span>
            <span class="text-xs text-amber-500 font-mono"><kbd class="bg-white px-1 border rounded">2</kbd> (1d)</span>
          </button>
          <button data-grade="3" class="flex flex-col items-center py-2 px-1 rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-700 transition-colors">
            <span class="font-bold text-sm">Good</span>
            <span class="text-xs text-blue-500 font-mono"><kbd class="bg-white px-1 border rounded">3</kbd> (3d)</span>
          </button>
          <button data-grade="4" class="flex flex-col items-center py-2 px-1 rounded-lg border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition-colors">
            <span class="font-bold text-sm">Easy</span>
            <span class="text-xs text-emerald-500 font-mono"><kbd class="bg-white px-1 border rounded">4</kbd> (7d)</span>
          </button>
        </div>
      </div>
    `;

    // Event listeners
    this.container.querySelector('#study-card-box')?.addEventListener('click', (e) => {
      if (e.target.closest('#btn-tts-speak')) return;
      this.flipCard();
    });

    this.container.querySelector('#btn-study-back')?.addEventListener('click', () => {
      if (this.onExit) this.onExit();
    });

    this.container.querySelector('#btn-tts-speak')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.isFlipped ? card.back?.text : card.front?.text;
      const lang = this.isFlipped ? card.back?.ttsLang : card.front?.ttsLang;
      this.speak(text || '', lang || 'en-US');
    });

    this.container.querySelectorAll('#study-grade-dock button[data-grade]').forEach(btn => {
      btn.addEventListener('click', () => {
        const grade = Number(btn.getAttribute('data-grade'));
        this.commitGrade(grade);
      });
    });
  }

  _renderCompletionView() {
    this.container.innerHTML = `
      <div class="max-w-xl mx-auto p-8 bg-white border border-slate-200 rounded-2xl text-center space-y-6 shadow-sm">
        <div class="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto text-3xl">
          <sl-icon name="trophy"></sl-icon>
        </div>
        <div>
          <h2 class="text-2xl font-bold text-slate-800">Review Complete!</h2>
          <p class="text-sm text-slate-500 mt-1">You reviewed <strong>${this.reviewedCount}</strong> card(s) using FSRS spaced repetition.</p>
        </div>

        <div class="grid grid-cols-2 gap-4 max-w-sm mx-auto text-left">
          <div class="bg-slate-50 p-3 rounded-lg border">
            <span class="text-xs text-slate-400 uppercase font-semibold">Cards Reviewed</span>
            <p class="text-xl font-bold text-slate-800">${this.reviewedCount}</p>
          </div>
          <div class="bg-slate-50 p-3 rounded-lg border">
            <span class="text-xs text-slate-400 uppercase font-semibold">Retention Target</span>
            <p class="text-xl font-bold text-blue-600">90%</p>
          </div>
        </div>

        <div class="flex justify-center gap-3 pt-2">
          <sl-button variant="default" id="btn-complete-exit">Back to Decks</sl-button>
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
