import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { SketchCanvas } from './sketch-canvas.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';

/**
 * Deck & Card Editor (KB-CARD-001)
 * 100ms debounced KaTeX/Mhchem live preview, TTS language config,
 * vector sketch pad modal, and card list management.
 */
export class FlashcardEditor {
  constructor(deck, options = {}) {
    this.deck = deck;
    this.deck.cards = this.deck.cards || [];
    this.onSave = options.onSave || null;
    this.onClose = options.onClose || null;

    this.selectedCardIndex = 0;
    this.debounceTimer = null;
    this.sketchInstance = null;
  }

  mount(containerEl) {
    this.container = containerEl;
    if (this.deck.cards.length === 0) {
      this.addCard();
    }
    this._render();
    return () => this.unmount();
  }

  unmount() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  addCard() {
    const newCard = {
      id: generateUUID(),
      type: 'text',
      front: { text: '', ttsLang: 'en-US' },
      back: { text: '', ttsLang: 'en-US' },
      fsrs: {
        state: 0,
        stability: 0,
        difficulty: 0,
        elapsed_days: 0,
        scheduled_days: 0,
        reps: 0,
        lapses: 0,
        due: new Date().toISOString()
      }
    };
    this.deck.cards.push(newCard);
    this.selectedCardIndex = this.deck.cards.length - 1;
    this._render();
  }

  deleteCard(index) {
    if (this.deck.cards.length <= 1) {
      toast.warning('A deck must have at least one card.');
      return;
    }
    this.deck.cards.splice(index, 1);
    this.selectedCardIndex = Math.max(0, index - 1);
    this._render();
  }

  duplicateCard(index) {
    const card = this.deck.cards[index];
    const copy = JSON.parse(JSON.stringify(card));
    copy.id = generateUUID();
    copy.fsrs = {
      state: 0,
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      due: new Date().toISOString()
    };
    this.deck.cards.splice(index + 1, 0, copy);
    this.selectedCardIndex = index + 1;
    this._render();
  }

  async saveDeck() {
    const titleInput = this.container.querySelector('#input-deck-title');
    if (titleInput && titleInput.value.trim()) {
      this.deck.title = titleInput.value.trim();
    }
    this.deck.updated_at = new Date().toISOString();

    try {
      await storage.table('flashcards').put(this.deck);
      toast.success('Deck saved successfully!');
      if (typeof this.onSave === 'function') this.onSave(this.deck);
    } catch (err) {
      console.error('Save deck error:', err);
      toast.danger('Failed to save deck.');
    }
  }

  _render() {
    const currentCard = this.deck.cards[this.selectedCardIndex] || this.deck.cards[0];

    this.container.innerHTML = `
      <div class="space-y-4">
        <!-- Editor Header -->
        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div class="flex items-center gap-3 w-full sm:w-auto">
            <button id="btn-editor-back" class="text-slate-500 hover:text-slate-800 p-1" title="Back to Decks">
              <sl-icon name="arrow-left" class="text-lg"></sl-icon>
            </button>
            <sl-input id="input-deck-title" value="${Sanitizer.escapeHtml(this.deck.title)}" placeholder="Deck Title" size="medium" class="font-bold flex-1 sm:w-80"></sl-input>
          </div>
          <div class="flex items-center gap-2 self-end sm:self-auto">
            <sl-button variant="default" id="btn-add-card">
              <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add Card
            </sl-button>
            <sl-button variant="primary" id="btn-save-deck">
              <sl-icon slot="prefix" name="check-lg"></sl-icon> Save Deck
            </sl-button>
          </div>
        </div>

        <!-- Main Editor Grid: Card Sidebar + Card Workspace -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <!-- Left: Card List Sidebar -->
          <div class="lg:col-span-4 bg-white p-3 rounded-xl border border-slate-200 shadow-sm max-h-[700px] flex flex-col">
            <div class="flex items-center justify-between pb-2 border-b text-xs font-semibold uppercase text-slate-500">
              <span>Cards (${this.deck.cards.length})</span>
            </div>
            <div class="overflow-y-auto space-y-2 py-2 flex-1" id="cards-nav-list">
              ${this.deck.cards.map((c, i) => `
                <div data-card-idx="${i}" class="p-2.5 rounded-lg border text-xs cursor-pointer transition-colors ${i === this.selectedCardIndex ? 'bg-blue-50 border-blue-500 text-blue-900 font-medium' : 'bg-slate-50 border-slate-200 hover:bg-slate-100 text-slate-700'} flex items-center justify-between">
                  <div class="truncate flex-1 pr-2">
                    <span class="font-bold text-slate-400 mr-1">#${i + 1}</span>
                    <span>${Sanitizer.escapeHtml(c.front?.text || '(Empty Card)')}</span>
                  </div>
                  <div class="flex items-center gap-1">
                    <button data-dup-idx="${i}" class="text-slate-400 hover:text-blue-600 p-1" title="Duplicate Card">
                      <sl-icon name="files"></sl-icon>
                    </button>
                    <button data-del-idx="${i}" class="text-slate-400 hover:text-red-600 p-1" title="Delete Card">
                      <sl-icon name="trash"></sl-icon>
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Right: Active Card Editor & Live KaTeX Preview -->
          <div class="lg:col-span-8 space-y-4">
            <!-- Front of Card -->
            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
              <div class="flex items-center justify-between border-b pb-2">
                <span class="font-bold text-sm text-slate-800 flex items-center gap-2">
                  <span class="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs">F</span>
                  Front (Question / Prompt)
                </span>
                <div class="flex items-center gap-2">
                  <sl-select id="select-front-lang" size="small" value="${currentCard.front?.ttsLang || 'en-US'}" class="w-28">
                    <sl-option value="en-US">English (US)</sl-option>
                    <sl-option value="en-GB">English (UK)</sl-option>
                    <sl-option value="nl-NL">Dutch (NL)</sl-option>
                    <sl-option value="es-ES">Spanish</sl-option>
                    <sl-option value="fr-FR">French</sl-option>
                    <sl-option value="de-DE">German</sl-option>
                  </sl-select>
                  <sl-button size="small" id="btn-draw-front">
                    <sl-icon slot="prefix" name="pen"></sl-icon> Sketch
                  </sl-button>
                </div>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label class="text-xs text-slate-500 font-medium mb-1 block">Markdown &amp; LaTeX ($$ ... $$)</label>
                  <sl-textarea id="textarea-front" rows="4" value="${Sanitizer.escapeHtml(currentCard.front?.text || '')}" placeholder="Type question, e.g. What is $$H_2O$$?"></sl-textarea>
                </div>
                <div>
                  <label class="text-xs text-slate-500 font-medium mb-1 block">Live Render Preview</label>
                  <div id="preview-front" class="p-3 bg-slate-50 border rounded-lg min-h-[96px] text-sm overflow-y-auto max-h-36">
                    ${Sanitizer.renderSTEMMarkdown(currentCard.front?.text || '')}
                  </div>
                </div>
              </div>
            </div>

            <!-- Back of Card -->
            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
              <div class="flex items-center justify-between border-b pb-2">
                <span class="font-bold text-sm text-slate-800 flex items-center gap-2">
                  <span class="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs">B</span>
                  Back (Answer / Explanation)
                </span>
                <div class="flex items-center gap-2">
                  <sl-select id="select-back-lang" size="small" value="${currentCard.back?.ttsLang || 'en-US'}" class="w-28">
                    <sl-option value="en-US">English (US)</sl-option>
                    <sl-option value="en-GB">English (UK)</sl-option>
                    <sl-option value="nl-NL">Dutch (NL)</sl-option>
                    <sl-option value="es-ES">Spanish</sl-option>
                    <sl-option value="fr-FR">French</sl-option>
                    <sl-option value="de-DE">German</sl-option>
                  </sl-select>
                  <sl-button size="small" id="btn-draw-back">
                    <sl-icon slot="prefix" name="pen"></sl-icon> Sketch
                  </sl-button>
                </div>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label class="text-xs text-slate-500 font-medium mb-1 block">Markdown &amp; LaTeX</label>
                  <sl-textarea id="textarea-back" rows="4" value="${Sanitizer.escapeHtml(currentCard.back?.text || '')}" placeholder="Type answer, e.g. Water is a polar molecule..."></sl-textarea>
                </div>
                <div>
                  <label class="text-xs text-slate-500 font-medium mb-1 block">Live Render Preview</label>
                  <div id="preview-back" class="p-3 bg-slate-50 border rounded-lg min-h-[96px] text-sm overflow-y-auto max-h-36">
                    ${Sanitizer.renderSTEMMarkdown(currentCard.back?.text || '')}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this._bindEditorEvents(currentCard);
  }

  _bindEditorEvents(currentCard) {
    // Toolbar buttons
    this.container.querySelector('#btn-editor-back')?.addEventListener('click', () => {
      if (this.onClose) this.onClose();
    });

    this.container.querySelector('#btn-add-card')?.addEventListener('click', () => {
      this.addCard();
    });

    this.container.querySelector('#btn-save-deck')?.addEventListener('click', () => {
      this.saveDeck();
    });

    // Card Selection
    this.container.querySelectorAll('[data-card-idx]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-dup-idx]') || e.target.closest('[data-del-idx]')) return;
        this.selectedCardIndex = Number(el.getAttribute('data-card-idx'));
        this._render();
      });
    });

    // Duplicate Card
    this.container.querySelectorAll('[data-dup-idx]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-dup-idx'));
        this.duplicateCard(idx);
      });
    });

    // Delete Card
    this.container.querySelectorAll('[data-del-idx]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-del-idx'));
        this.deleteCard(idx);
      });
    });

    // 100ms Debounced Front Input
    const frontTextarea = this.container.querySelector('#textarea-front');
    const frontPreview = this.container.querySelector('#preview-front');
    frontTextarea?.addEventListener('sl-input', (e) => {
      const val = e.target.value;
      currentCard.front.text = val;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        frontPreview.innerHTML = Sanitizer.renderSTEMMarkdown(val);
      }, 100);
    });

    // 100ms Debounced Back Input
    const backTextarea = this.container.querySelector('#textarea-back');
    const backPreview = this.container.querySelector('#preview-back');
    backTextarea?.addEventListener('sl-input', (e) => {
      const val = e.target.value;
      currentCard.back.text = val;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        backPreview.innerHTML = Sanitizer.renderSTEMMarkdown(val);
      }, 100);
    });

    // TTS Language Selectors
    this.container.querySelector('#select-front-lang')?.addEventListener('sl-change', (e) => {
      currentCard.front.ttsLang = e.target.value;
    });

    this.container.querySelector('#select-back-lang')?.addEventListener('sl-change', (e) => {
      currentCard.back.ttsLang = e.target.value;
    });

    // Sketch Canvas Modals
    this.container.querySelector('#btn-draw-front')?.addEventListener('click', () => {
      this._openSketchDialog(currentCard, 'front');
    });

    this.container.querySelector('#btn-draw-back')?.addEventListener('click', () => {
      this._openSketchDialog(currentCard, 'back');
    });
  }

  _openSketchDialog(card, side = 'front') {
    const dialog = document.createElement('sl-dialog');
    dialog.label = `Draw on ${side === 'front' ? 'Front' : 'Back'} of Card`;
    dialog.style.setProperty('--width', '640px');

    dialog.innerHTML = `
      <div class="space-y-3">
        <div class="flex items-center justify-between border-b pb-2">
          <div class="flex items-center gap-2">
            <sl-button size="small" id="btn-sketch-pen" variant="primary">Pen</sl-button>
            <sl-button size="small" id="btn-sketch-eraser" variant="default">Eraser</sl-button>
            <sl-color-picker size="small" id="sketch-color-picker" value="#2563eb" no-format-toggle></sl-color-picker>
          </div>
          <div class="flex items-center gap-1">
            <sl-button size="small" id="btn-sketch-undo" title="Undo"><sl-icon name="arrow-counterclockwise"></sl-icon></sl-button>
            <sl-button size="small" id="btn-sketch-redo" title="Redo"><sl-icon name="arrow-clockwise"></sl-icon></sl-button>
            <sl-button size="small" id="btn-sketch-clear" variant="danger" title="Clear Canvas"><sl-icon name="trash"></sl-icon></sl-button>
          </div>
        </div>

        <div class="border rounded-xl bg-white shadow-inner flex items-center justify-center p-1">
          <canvas id="sketch-canvas-el" style="width: 100%; height: 320px;" class="kb-sketch-pad"></canvas>
        </div>
      </div>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button variant="default" id="btn-sketch-cancel">Cancel</sl-button>
        <sl-button variant="primary" id="btn-sketch-save">Save Drawing</sl-button>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    const canvasEl = dialog.querySelector('#sketch-canvas-el');
    const sketch = new SketchCanvas(canvasEl);
    if (card[side]?.sketchData) {
      sketch.loadStrokes(card[side].sketchData);
    }

    dialog.querySelector('#btn-sketch-pen')?.addEventListener('click', () => {
      sketch.setMode('pen');
      dialog.querySelector('#btn-sketch-pen').variant = 'primary';
      dialog.querySelector('#btn-sketch-eraser').variant = 'default';
    });

    dialog.querySelector('#btn-sketch-eraser')?.addEventListener('click', () => {
      sketch.setMode('eraser');
      dialog.querySelector('#btn-sketch-eraser').variant = 'primary';
      dialog.querySelector('#btn-sketch-pen').variant = 'default';
    });

    dialog.querySelector('#sketch-color-picker')?.addEventListener('sl-change', (e) => {
      sketch.setColor(e.target.value);
    });

    dialog.querySelector('#btn-sketch-undo')?.addEventListener('click', () => sketch.undo());
    dialog.querySelector('#btn-sketch-redo')?.addEventListener('click', () => sketch.redo());
    dialog.querySelector('#btn-sketch-clear')?.addEventListener('click', () => sketch.clear());

    dialog.querySelector('#btn-sketch-save')?.addEventListener('click', () => {
      card[side].sketchData = sketch.getStrokes();
      toast.success('Sketch saved to card!');
      dialog.remove();
    });

    dialog.querySelector('#btn-sketch-cancel')?.addEventListener('click', () => dialog.remove());
  }
}

export default FlashcardEditor;
