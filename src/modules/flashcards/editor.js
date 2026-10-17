import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { SketchCanvas } from './sketch-canvas.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { RichTextEditor } from '../../components/rich-text-editor.js';
import { ClassManager } from '../../components/class-manager.js';

/**
 * Deck & Card Editor (KB-CARD-001)
 * Integrated RichTextEditor with KaTeX/Mhchem, Card Up/Down reordering,
 * sidebar search, sketch preview badges, auto-save debounce, and class tagging.
 */
export class FlashcardEditor {
  constructor(deck, options = {}) {
    this.deck = deck;
    this.deck.cards = this.deck.cards || [];
    this.onSave = options.onSave || null;
    this.onClose = options.onClose || null;

    this.selectedCardIndex = 0;
    this.sidebarSearch = '';
    this.autoSaveTimer = null;
    this.frontEditor = null;
    this.backEditor = null;
    this.classes = [];
  }

  async mount(containerEl) {
    this.container = containerEl;
    this.classes = await ClassManager.getClasses();

    if (this.deck.cards.length === 0) {
      this.addCard();
    }
    this._render();
    this._bindGlobalKeys();
    return () => this.unmount();
  }

  unmount() {
    clearTimeout(this.autoSaveTimer);
    if (this.frontEditor) this.frontEditor.destroy();
    if (this.backEditor) this.backEditor.destroy();
    if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler);
  }

  _bindGlobalKeys() {
    this._keyHandler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.addCard();
      } else if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.selectedCardIndex > 0) {
          this.selectedCardIndex--;
          this._render();
        }
      } else if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.selectedCardIndex < this.deck.cards.length - 1) {
          this.selectedCardIndex++;
          this._render();
        }
      }
    };
    window.addEventListener('keydown', this._keyHandler);
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
    this._scheduleAutoSave();
  }

  deleteCard(index) {
    if (this.deck.cards.length <= 1) {
      toast.warning('A deck must have at least one card.');
      return;
    }
    this.deck.cards.splice(index, 1);
    this.selectedCardIndex = Math.max(0, index - 1);
    this._render();
    this._scheduleAutoSave();
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
    this._scheduleAutoSave();
  }

  moveCard(fromIndex, toIndex) {
    if (toIndex < 0 || toIndex >= this.deck.cards.length) return;
    const item = this.deck.cards.splice(fromIndex, 1)[0];
    this.deck.cards.splice(toIndex, 0, item);
    this.selectedCardIndex = toIndex;
    this._render();
    this._scheduleAutoSave();
  }

  _scheduleAutoSave() {
    const statusEl = this.container?.querySelector('#label-auto-save-status');
    if (statusEl) statusEl.textContent = 'Unsaved changes...';

    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(async () => {
      await this.saveDeck(false);
      if (statusEl) statusEl.textContent = 'Saved to browser';
    }, 600);
  }

  async saveDeck(notify = true) {
    const titleInput = this.container?.querySelector('#input-deck-title');
    if (titleInput && titleInput.value.trim()) {
      this.deck.title = titleInput.value.trim();
    }
    const descInput = this.container?.querySelector('#input-deck-desc');
    if (descInput) {
      this.deck.description = descInput.value.trim();
    }
    const classSelect = this.container?.querySelector('#select-deck-class');
    if (classSelect) {
      this.deck.class_id = classSelect.value || null;
    }

    this.deck.updated_at = new Date().toISOString();

    try {
      await storage.table('flashcards').put(this.deck);
      if (notify) {
        toast.success('Deck saved successfully!');
        if (typeof this.onSave === 'function') this.onSave(this.deck);
      }
    } catch (err) {
      console.error('Save deck error:', err);
      if (notify) toast.danger('Failed to save deck.');
    }
  }

  _render() {
    const currentCard = this.deck.cards[this.selectedCardIndex] || this.deck.cards[0];

    // Filter sidebar cards
    const filteredCardIndices = this.deck.cards.map((c, i) => ({ card: c, originalIndex: i }))
      .filter(({ card }) => {
        if (!this.sidebarSearch) return true;
        const q = this.sidebarSearch.toLowerCase();
        const fText = typeof card.front === 'string' ? card.front : (card.front?.text || '');
        const bText = typeof card.back === 'string' ? card.back : (card.back?.text || '');
        return fText.toLowerCase().includes(q) || bText.toLowerCase().includes(q);
      });

    const safeTitle = Sanitizer.escapeHTML(this.deck.title || 'Untitled Flashcard Deck');
    const safeDesc = Sanitizer.escapeHTML(this.deck.description || '');

    this.container.innerHTML = `
      <div class="space-y-4 max-w-7xl mx-auto">
        <!-- Editor Header & Metadata Bar -->
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs space-y-3">
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div class="flex items-center gap-3 w-full sm:w-auto flex-1">
              <button id="btn-editor-back" class="text-slate-500 hover:text-slate-800 p-1" title="Back to Decks">
                <sl-icon name="arrow-left" class="text-lg"></sl-icon>
              </button>
              <sl-input id="input-deck-title" value="${safeTitle}" placeholder="Deck Title (e.g. AP Chemistry Unit 1)" size="medium" class="font-bold flex-1 max-w-md"></sl-input>
              <sl-select id="select-deck-class" size="small" placeholder="Assign Class..." class="w-48" value="${Sanitizer.escapeHTML(this.deck.class_id || '')}">
                <sl-option value="">No Class (General)</sl-option>
                ${this.classes.map(c => `
                  <sl-option value="${c.id}">${Sanitizer.escapeHTML(c.name)}</sl-option>
                `).join('')}
              </sl-select>
            </div>

            <div class="flex items-center gap-2 self-end sm:self-auto">
              <span id="label-auto-save-status" class="text-xs text-slate-400 font-medium">Saved</span>
              <sl-button variant="default" size="small" id="btn-add-card">
                <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add Card
              </sl-button>
              <sl-button variant="primary" size="small" id="btn-save-deck">
                <sl-icon slot="prefix" name="check-lg"></sl-icon> Save &amp; Return
              </sl-button>
            </div>
          </div>

          <sl-input id="input-deck-desc" value="${safeDesc}" placeholder="Optional deck description or learning objectives..." size="small"></sl-input>
        </div>

        <!-- Main Workspace: Card Sidebar + Rich Text Editors -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <!-- Left: Card List Sidebar -->
          <div class="lg:col-span-4 bg-white p-3 rounded-2xl border border-slate-200 shadow-xs max-h-[720px] flex flex-col">
            <div class="flex items-center justify-between pb-2 border-b border-slate-100 text-xs font-semibold text-slate-600">
              <span>Cards (${this.deck.cards.length})</span>
              <span class="text-[10px] text-slate-400">Ctrl+Enter to add</span>
            </div>

            <div class="py-2">
              <sl-input id="input-sidebar-search" placeholder="Filter cards..." size="small" clearable value="${Sanitizer.escapeHTML(this.sidebarSearch)}">
                <sl-icon slot="prefix" name="search"></sl-icon>
              </sl-input>
            </div>

            <div class="overflow-y-auto space-y-1.5 py-1 flex-1 pr-1" id="cards-nav-list">
              ${filteredCardIndices.map(({ card: c, originalIndex: i }) => {
                const isSelected = i === this.selectedCardIndex;
                const frontStr = typeof c.front === 'string' ? c.front : (c.front?.text || '');
                const safePreview = Sanitizer.escapeHTML(frontStr.trim() || '(Empty Card)');
                const hasSketch = (c.front?.sketchData?.length > 0) || (c.back?.sketchData?.length > 0);

                return `
                  <div data-card-idx="${i}" class="p-2.5 rounded-xl border text-xs cursor-pointer transition-all ${isSelected ? 'bg-blue-50 border-blue-500 text-blue-900 font-semibold shadow-xs' : 'bg-slate-50/70 border-slate-200 hover:bg-slate-100 text-slate-700'} flex items-center justify-between">
                    <div class="truncate flex-1 pr-2 flex items-center gap-1.5">
                      <span class="text-slate-400 font-mono text-[11px]">#${i + 1}</span>
                      <span class="truncate">${safePreview}</span>
                      ${hasSketch ? `<span class="text-[10px] text-indigo-500" title="Contains Vector Drawing">✏</span>` : ''}
                    </div>

                    <div class="flex items-center gap-0.5">
                      <button type="button" class="kb-icon-btn text-[11px]" data-move-up="${i}" title="Move Up" ${i === 0 ? 'disabled style="opacity:0.3;"' : ''}>↑</button>
                      <button type="button" class="kb-icon-btn text-[11px]" data-move-down="${i}" title="Move Down" ${i === this.deck.cards.length - 1 ? 'disabled style="opacity:0.3;"' : ''}>↓</button>
                      <button type="button" class="kb-icon-btn" data-dup-idx="${i}" title="Duplicate Card">
                        <sl-icon name="files"></sl-icon>
                      </button>
                      <button type="button" class="kb-icon-btn text-red-500 hover:text-red-700" data-del-idx="${i}" title="Delete Card">
                        <sl-icon name="trash"></sl-icon>
                      </button>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>

          <!-- Right: Card Authoring Workspace -->
          <div class="lg:col-span-8 space-y-4">
            <!-- Front of Card Section -->
            <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
              <div class="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <span class="font-bold text-sm text-slate-800 flex items-center gap-2">
                  <span class="w-6 h-6 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold">F</span>
                  Front (Prompt / Question)
                </span>
                <div class="flex items-center gap-2">
                  <sl-select id="select-front-lang" size="small" value="${currentCard.front?.ttsLang || 'en-US'}" class="w-40" aria-label="Front text-to-speech language">
                    <sl-option value="en-US">English (US)</sl-option>
                    <sl-option value="en-GB">English (UK)</sl-option>
                    <sl-option value="nl-NL">Dutch (NL)</sl-option>
                    <sl-option value="es-ES">Spanish</sl-option>
                    <sl-option value="fr-FR">French</sl-option>
                    <sl-option value="de-DE">German</sl-option>
                  </sl-select>
                  <sl-button size="small" id="btn-draw-front">
                    <sl-icon slot="prefix" name="pen"></sl-icon>
                    ${currentCard.front?.sketchData?.length > 0 ? 'Edit Sketch' : 'Add Sketch'}
                  </sl-button>
                  ${currentCard.front?.sketchData?.length > 0 ? `
                    <button type="button" id="btn-remove-front-sketch" class="text-xs text-red-500 hover:text-red-700 underline">Remove Sketch</button>
                  ` : ''}
                </div>
              </div>

              <!-- Mount RichTextEditor for Front -->
              <div id="front-editor-mount"></div>
            </div>

            <!-- Back of Card Section -->
            <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
              <div class="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <span class="font-bold text-sm text-slate-800 flex items-center gap-2">
                  <span class="w-6 h-6 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs font-bold">B</span>
                  Back (Answer / Explanation)
                </span>
                <div class="flex items-center gap-2">
                  <sl-select id="select-back-lang" size="small" value="${currentCard.back?.ttsLang || 'en-US'}" class="w-40" aria-label="Back text-to-speech language">
                    <sl-option value="en-US">English (US)</sl-option>
                    <sl-option value="en-GB">English (UK)</sl-option>
                    <sl-option value="nl-NL">Dutch (NL)</sl-option>
                    <sl-option value="es-ES">Spanish</sl-option>
                    <sl-option value="fr-FR">French</sl-option>
                    <sl-option value="de-DE">German</sl-option>
                  </sl-select>
                  <sl-button size="small" id="btn-draw-back">
                    <sl-icon slot="prefix" name="pen"></sl-icon>
                    ${currentCard.back?.sketchData?.length > 0 ? 'Edit Sketch' : 'Add Sketch'}
                  </sl-button>
                  ${currentCard.back?.sketchData?.length > 0 ? `
                    <button type="button" id="btn-remove-back-sketch" class="text-xs text-red-500 hover:text-red-700 underline">Remove Sketch</button>
                  ` : ''}
                </div>
              </div>

              <!-- Mount RichTextEditor for Back -->
              <div id="back-editor-mount"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Initialize RichTextEditors
    const frontText = typeof currentCard.front === 'string' ? currentCard.front : (currentCard.front?.text || '');
    const backText = typeof currentCard.back === 'string' ? currentCard.back : (currentCard.back?.text || '');

    if (this.frontEditor) this.frontEditor.destroy();
    if (this.backEditor) this.backEditor.destroy();

    this.frontEditor = new RichTextEditor({
      initialValue: frontText,
      placeholder: 'Type front question/prompt in Markdown or KaTeX ($$...$$)...',
      mode: 'split',
      minHeight: '130px',
      onChange: (val) => {
        if (typeof currentCard.front === 'string') currentCard.front = { text: val, ttsLang: 'en-US' };
        else currentCard.front.text = val;
        this._scheduleAutoSave();
      }
    });

    this.backEditor = new RichTextEditor({
      initialValue: backText,
      placeholder: 'Type back answer/explanation in Markdown or KaTeX ($$\\ce{...}$$)...',
      mode: 'split',
      minHeight: '130px',
      onChange: (val) => {
        if (typeof currentCard.back === 'string') currentCard.back = { text: val, ttsLang: 'en-US' };
        else currentCard.back.text = val;
        this._scheduleAutoSave();
      }
    });

    this.container.querySelector('#front-editor-mount')?.appendChild(this.frontEditor.element);
    this.container.querySelector('#back-editor-mount')?.appendChild(this.backEditor.element);

    this._bindEditorEvents(currentCard);
  }

  _bindEditorEvents(currentCard) {
    this.container.querySelector('#btn-editor-back')?.addEventListener('click', () => {
      if (this.onClose) this.onClose();
    });

    this.container.querySelector('#btn-add-card')?.addEventListener('click', () => {
      this.addCard();
    });

    this.container.querySelector('#btn-save-deck')?.addEventListener('click', () => {
      this.saveDeck(true);
    });

    // Metadata inputs
    this.container.querySelector('#input-deck-title')?.addEventListener('sl-input', () => this._scheduleAutoSave());
    this.container.querySelector('#input-deck-desc')?.addEventListener('sl-input', () => this._scheduleAutoSave());
    this.container.querySelector('#select-deck-class')?.addEventListener('sl-change', () => this._scheduleAutoSave());

    // Sidebar Search
    this.container.querySelector('#input-sidebar-search')?.addEventListener('sl-input', (e) => {
      this.sidebarSearch = e.target.value.trim();
      this._render();
    });

    // Card Selection
    this.container.querySelectorAll('[data-card-idx]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        this.selectedCardIndex = Number(el.getAttribute('data-card-idx'));
        this._render();
      });
    });

    // Move Up / Move Down
    this.container.querySelectorAll('[data-move-up]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-move-up'));
        this.moveCard(idx, idx - 1);
      });
    });

    this.container.querySelectorAll('[data-move-down]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-move-down'));
        this.moveCard(idx, idx + 1);
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

    // TTS Language Selectors
    this.container.querySelector('#select-front-lang')?.addEventListener('sl-change', (e) => {
      if (typeof currentCard.front === 'string') currentCard.front = { text: currentCard.front, ttsLang: e.target.value };
      else currentCard.front.ttsLang = e.target.value;
      this._scheduleAutoSave();
    });

    this.container.querySelector('#select-back-lang')?.addEventListener('sl-change', (e) => {
      if (typeof currentCard.back === 'string') currentCard.back = { text: currentCard.back, ttsLang: e.target.value };
      else currentCard.back.ttsLang = e.target.value;
      this._scheduleAutoSave();
    });

    // Sketch Canvas Dialogs
    this.container.querySelector('#btn-draw-front')?.addEventListener('click', () => {
      this._openSketchDialog(currentCard, 'front');
    });

    this.container.querySelector('#btn-draw-back')?.addEventListener('click', () => {
      this._openSketchDialog(currentCard, 'back');
    });

    this.container.querySelector('#btn-remove-front-sketch')?.addEventListener('click', () => {
      if (currentCard.front) currentCard.front.sketchData = null;
      toast.info('Front sketch removed.');
      this._render();
      this._scheduleAutoSave();
    });

    this.container.querySelector('#btn-remove-back-sketch')?.addEventListener('click', () => {
      if (currentCard.back) currentCard.back.sketchData = null;
      toast.info('Back sketch removed.');
      this._render();
      this._scheduleAutoSave();
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
      if (typeof card[side] === 'string') {
        card[side] = { text: card[side], ttsLang: 'en-US' };
      }
      card[side].sketchData = sketch.getStrokes();
      toast.success('Sketch saved to card!');
      dialog.remove();
      this._render();
      this._scheduleAutoSave();
    });

    dialog.querySelector('#btn-sketch-cancel')?.addEventListener('click', () => dialog.remove());
  }
}

export default FlashcardEditor;
