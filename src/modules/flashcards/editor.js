import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { SketchCanvas } from './sketch-canvas.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { RichTextEditor } from '../../components/rich-text-editor.js';
import { ClassManager } from '../../components/class-manager.js';
import { Exporter, FlashcardItemSchema } from '../../core/validator.js';
import { CSVImportDialog } from '../../components/csv-import-dialog.js';
import { FLASHCARDS_CSV_TEMPLATE, downloadCSVTemplate } from '../../core/csv-templates.js';
import { downloadCSV } from '../../core/csv.js';

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
                  <sl-option value="${Sanitizer.escapeHTML(c.id)}">${Sanitizer.escapeHTML(c.name)}</sl-option>
                `).join('')}
              </sl-select>
            </div>

            <div class="flex items-center gap-2 self-end sm:self-auto">
              <span id="label-auto-save-status" class="text-xs text-slate-400 font-medium">Saved</span>
              <sl-button variant="default" size="small" id="btn-add-card">
                <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add Card
              </sl-button>
              <sl-dropdown placement="bottom-end">
                <sl-button slot="trigger" variant="default" size="small" caret>
                  <sl-icon slot="prefix" name="filetype-csv"></sl-icon> CSV
                </sl-button>
                <sl-menu id="menu-editor-deck-actions">
                  <sl-menu-item value="import-cards">
                    <sl-icon slot="prefix" name="upload"></sl-icon> Import from CSV / Spreadsheet…
                  </sl-menu-item>
                  <sl-menu-item value="export-csv">
                    <sl-icon slot="prefix" name="download"></sl-icon> Export Cards to CSV
                  </sl-menu-item>
                  <sl-divider></sl-divider>
                  <sl-menu-item value="template-csv">
                    <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Download CSV Template
                  </sl-menu-item>
                </sl-menu>
              </sl-dropdown>
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
                  <sl-select id="select-front-lang" size="small" value="${Sanitizer.escapeHTML(currentCard.front?.ttsLang || 'en-US')}" class="w-40" aria-label="Front text-to-speech language">
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
              <div class="kb-card-media" data-media-side="front"></div>
            </div>

            <!-- Back of Card Section -->
            <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-3">
              <div class="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <span class="font-bold text-sm text-slate-800 flex items-center gap-2">
                  <span class="w-6 h-6 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs font-bold">B</span>
                  Back (Answer / Explanation)
                </span>
                <div class="flex items-center gap-2">
                  <sl-select id="select-back-lang" size="small" value="${Sanitizer.escapeHTML(currentCard.back?.ttsLang || 'en-US')}" class="w-40" aria-label="Back text-to-speech language">
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
              <div class="kb-card-media" data-media-side="back"></div>
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

    // CSV Menu Actions
    this.container.querySelector('#menu-editor-deck-actions')?.addEventListener('sl-select', async (e) => {
      const val = e.detail?.item?.value;
      if (val === 'import-cards') {
        CSVImportDialog.open({
          title: `Import Cards into "${this.deck.title || 'Deck'}"`,
          subtitle: 'Upload a CSV file or paste cells directly from Google Sheets / Excel to add cards to this deck.',
          templateFilename: 'flashcards_template.csv',
          templateContent: FLASHCARDS_CSV_TEMPLATE,
          schema: FlashcardItemSchema,
          acceptJson: false,
          onImport: async (resultData) => {
            if (!Array.isArray(resultData) || resultData.length === 0) return;
            const newCards = resultData.map(c => ({
              id: generateUUID(),
              type: 'text',
              front: typeof c.front === 'string' ? { text: c.front, ttsLang: 'en-US' } : c.front,
              back: typeof c.back === 'string' ? { text: c.back, ttsLang: 'en-US' } : c.back,
              fsrs: { state: 0, stability: 0, difficulty: 0, due: new Date().toISOString() }
            }));
            this.deck.cards.push(...newCards);
            this.selectedCardIndex = this.deck.cards.length - 1;
            this._render();
            this._scheduleAutoSave();
            toast.success(`Added ${newCards.length} cards from CSV!`);
          }
        });
      } else if (val === 'export-csv') {
        const csvStr = Exporter.toCSV(this.deck.cards);
        const filename = `${(this.deck.title || 'flashcard_deck').replace(/[^a-z0-9_-]+/gi, '_')}.csv`;
        downloadCSV(filename, csvStr);
        toast.success(`Exported ${this.deck.cards.length} cards to ${filename}`);
      } else if (val === 'template-csv') {
        downloadCSVTemplate('flashcards_template.csv', FLASHCARDS_CSV_TEMPLATE);
        toast.success('Downloaded flashcards CSV template');
      }
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

    this.container.querySelectorAll('[data-media-side]').forEach(el => {
      this._mountMediaControls(el, currentCard, el.dataset.mediaSide);
    });
  }

  /**
   * Image + audio clip controls for one side of a card. Images are downscaled to WebP and
   * recordings capped at 10 s before they are stored (src/utils/media.js).
   */
  async _mountMediaControls(el, card, side) {
    const media = await import('../../utils/media.js');
    if (typeof card[side] === 'string') card[side] = { text: card[side], ttsLang: 'en-US' };
    const data = card[side] || (card[side] = { text: '', ttsLang: 'en-US' });
    const label = side === 'front' ? 'front' : 'back';
    const [imgSrc, audioSrc] = await Promise.all([
      media.resolveMediaSrc(data.imageRef, 'image'),
      media.resolveMediaSrc(data.audioRef, 'audio')
    ]);

    el.innerHTML = `
      <div class="flex flex-wrap items-center gap-2 pt-1">
        <input type="file" accept="image/*" class="hidden" data-role="image-input" aria-hidden="true">
        <sl-button size="small" data-role="add-image"><sl-icon slot="prefix" name="image"></sl-icon> ${imgSrc ? 'Replace image' : 'Add image'}</sl-button>
        <sl-button size="small" data-role="record"><sl-icon slot="prefix" name="mic"></sl-icon> ${audioSrc ? 'Re-record audio' : 'Record audio'}</sl-button>
        <span class="text-xs text-slate-500" data-role="status" aria-live="polite"></span>
      </div>
      ${imgSrc ? `
        <div class="kb-card-media-item">
          <img src="${Sanitizer.escapeHTML(imgSrc)}" alt="Image on the ${label} of the card" class="max-h-40 rounded-lg border border-slate-200">
          <button type="button" class="text-xs text-red-500 hover:text-red-700 underline" data-role="remove-image">Remove image</button>
        </div>` : ''}
      ${audioSrc ? `
        <div class="kb-card-media-item">
          <audio controls preload="none" src="${Sanitizer.escapeHTML(audioSrc)}" aria-label="Audio clip on the ${label} of the card"></audio>
          <button type="button" class="text-xs text-red-500 hover:text-red-700 underline" data-role="remove-audio">Remove audio</button>
        </div>` : ''}`;

    const status = el.querySelector('[data-role="status"]');
    const refresh = () => { this._scheduleAutoSave(); this._mountMediaControls(el, card, side); };
    const fileInput = el.querySelector('[data-role="image-input"]');

    el.querySelector('[data-role="add-image"]').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      status.textContent = 'Optimising image…';
      try {
        const blob = await media.downscaleImage(file);
        data.imageRef = await media.storeMediaBlob(blob);
        toast.success(`Image added (${Math.max(1, Math.round(blob.size / 1024))} KB).`);
        refresh();
      } catch (err) {
        status.textContent = '';
        toast.danger(err.message === 'IMAGE_TOO_LARGE' ? 'That image is larger than 25 MB.' : 'Could not read that image.');
      }
    });

    const recordBtn = el.querySelector('[data-role="record"]');
    let session = null;
    recordBtn.addEventListener('click', async () => {
      if (session) {
        session.stop();
        return;
      }
      try {
        session = await media.startAudioClip();
      } catch (err) {
        toast.danger(err?.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it for this site to record audio.'
          : 'Audio recording is not available in this browser.');
        return;
      }
      recordBtn.innerHTML = '<sl-icon slot="prefix" name="stop-circle"></sl-icon> Stop recording';
      recordBtn.variant = 'danger';
      const started = Date.now();
      const tick = setInterval(() => {
        status.textContent = `Recording… ${Math.ceil((media.AUDIO_MAX_MS - (Date.now() - started)) / 1000)} s left`;
      }, 250);
      try {
        const blob = await session.result;
        data.audioRef = await media.storeMediaBlob(blob);
        toast.success('Audio clip saved.');
      } catch (_) {
        toast.warning('Nothing was recorded.');
      } finally {
        clearInterval(tick);
        session = null;
        refresh();
      }
    });

    el.querySelector('[data-role="remove-image"]')?.addEventListener('click', () => {
      data.imageRef = null;
      refresh();
    });
    el.querySelector('[data-role="remove-audio"]')?.addEventListener('click', () => {
      data.audioRef = null;
      refresh();
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
