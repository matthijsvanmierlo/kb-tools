import { storage } from '../../core/storage.js';
import { store } from '../../state/store.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { CryptoShareEngine } from '../../core/crypto-share.js';
import { Exporter, parseCSVWithValidation, FlashcardItemSchema, showImportErrorsDialog } from '../../core/validator.js';
import { FlashcardEditor } from './editor.js';
import { StudyPlayer } from './study-player.js';
import { TowerDefenseEngine } from './tower-defense.js';

/**
 * Flashcards Module Controller & Deck Library View
 */
export async function renderFlashcardsView(params, router, container) {
  const hash = window.location.hash || '#/flashcards';

  // Sub-route: Study
  if (hash.startsWith('#/flashcards/study')) {
    const deckId = params.id;
    let deck = store.getState('activeDeck');
    if (!deck && deckId) {
      deck = await storage.table('flashcards').get(deckId);
    }
    if (!deck) {
      toast.warning('Deck not found.');
      router.navigate('#/flashcards');
      return;
    }
    const player = new StudyPlayer(deck, {
      onExit: () => router.navigate('#/flashcards')
    });
    return player.mount(container);
  }

  // Sub-route: Tower Defense Game
  if (hash.startsWith('#/flashcards/game')) {
    const deckId = params.id;
    let deck = store.getState('activeDeck');
    if (!deck && deckId) {
      deck = await storage.table('flashcards').get(deckId);
    }
    if (!deck || !deck.cards || deck.cards.length === 0) {
      toast.warning('Deck must contain at least 1 card to play.');
      router.navigate('#/flashcards');
      return;
    }

    container.innerHTML = `
      <div class="space-y-4 max-w-5xl mx-auto">
        <div class="flex items-center justify-between bg-white p-3 rounded-xl border shadow-sm">
          <div class="flex items-center gap-2">
            <button id="btn-td-back" class="text-slate-500 hover:text-slate-800 p-1">
              <sl-icon name="arrow-left" class="text-lg"></sl-icon>
            </button>
            <h2 class="font-bold text-slate-800">${deck.title} — Tower Defense Study</h2>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs text-slate-500">Click pads to build:</span>
            <sl-select id="select-tower-type" size="small" value="archer" class="w-32">
              <sl-option value="archer">Archer (50⚡)</sl-option>
              <sl-option value="freeze">Freeze (75⚡)</sl-option>
              <sl-option value="cannon">Cannon (100⚡)</sl-option>
            </sl-select>
          </div>
        </div>

        <div class="bg-slate-900 rounded-xl overflow-hidden shadow-lg border border-slate-700 flex justify-center">
          <canvas id="td-canvas" style="width: 100%; max-width: 960px; height: auto;" class="block"></canvas>
        </div>

        <div id="td-question-dock"></div>
      </div>
    `;

    const canvas = container.querySelector('#td-canvas');
    const tdEngine = new TowerDefenseEngine(canvas, deck, {
      onEndGame: (results) => {
        toast.info(results.isVictory ? 'Victory! All waves completed!' : 'Base fell! Keep practicing.');
      }
    });

    container.querySelector('#btn-td-back')?.addEventListener('click', () => {
      tdEngine.stop();
      router.navigate('#/flashcards');
    });

    container.querySelector('#select-tower-type')?.addEventListener('sl-change', (e) => {
      tdEngine.selectedTowerType = e.target.value;
    });

    tdEngine.init();

    return () => tdEngine.stop();
  }

  // Sub-route: Edit
  if (hash.startsWith('#/flashcards/edit')) {
    const deckId = params.id;
    let deck = null;
    if (deckId) {
      deck = await storage.table('flashcards').get(deckId);
    }
    if (!deck) {
      deck = {
        version: 1,
        id: generateUUID(),
        title: 'Untitled Flashcard Deck',
        cards: []
      };
    }
    const editor = new FlashcardEditor(deck, {
      onSave: () => router.navigate('#/flashcards'),
      onClose: () => router.navigate('#/flashcards')
    });
    return editor.mount(container);
  }

  // Default Route: Deck Library UI
  await renderLibrary(container, router);
}

async function renderLibrary(container, router) {
  const decks = await storage.table('flashcards').toArray();

  container.innerHTML = `
    <div class="space-y-6">
      <!-- Library Top Dock -->
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
        <div>
          <h1 class="text-2xl font-bold text-slate-900 tracking-tight">Flashcard Library</h1>
          <p class="text-xs text-slate-500 mt-1">Master knowledge via FSRS v4 spaced repetition or play Tower Defense.</p>
        </div>
        <div class="flex items-center gap-2">
          <sl-button variant="default" id="btn-import-csv">
            <sl-icon slot="prefix" name="file-earmark-arrow-up"></sl-icon> Import CSV
          </sl-button>
          <sl-button variant="primary" id="btn-create-deck">
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> New Deck
          </sl-button>
          <input type="file" id="input-flashcard-csv" accept=".csv" class="hidden" />
        </div>
      </div>

      <!-- Decks Grid -->
      ${decks.length === 0 ? `
        <div class="p-12 bg-white border border-dashed border-slate-300 rounded-2xl text-center space-y-4">
          <div class="w-16 h-16 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center mx-auto text-3xl">
            <sl-icon name="collection"></sl-icon>
          </div>
          <h3 class="font-bold text-slate-800 text-lg">Your Library is Empty</h3>
          <p class="text-sm text-slate-500 max-w-sm mx-auto">Create a new deck with KaTeX/Mhchem notation, or import an existing CSV flashcard set.</p>
          <div class="flex justify-center gap-3 pt-2">
            <sl-button variant="primary" id="btn-empty-create">Create First Deck</sl-button>
          </div>
        </div>
      ` : `
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" id="decks-grid">
          ${decks.map(deck => {
            const cardCount = deck.cards ? deck.cards.length : 0;
            const stats = deck.gamification_stats || { high_score: 0, longest_streak: 0 };
            return `
              <div class="bg-white border border-slate-200 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between space-y-4">
                <div>
                  <div class="flex items-start justify-between gap-2">
                    <h3 class="font-bold text-slate-900 text-base leading-snug line-clamp-1">${Sanitizer.escapeHtml(deck.title)}</h3>
                    <sl-dropdown placement="bottom-end">
                      <button slot="trigger" class="text-slate-400 hover:text-slate-600 p-1" title="Options">
                        <sl-icon name="three-dots-vertical"></sl-icon>
                      </button>
                      <sl-menu>
                        <sl-menu-item data-action="edit" data-deck-id="${deck.id}">
                          <sl-icon slot="prefix" name="pencil"></sl-icon> Edit Deck
                        </sl-menu-item>
                        <sl-menu-item data-action="share" data-deck-id="${deck.id}">
                          <sl-icon slot="prefix" name="share"></sl-icon> Share Lesson...
                        </sl-menu-item>
                        <sl-menu-item data-action="export-csv" data-deck-id="${deck.id}">
                          <sl-icon slot="prefix" name="filetype-csv"></sl-icon> Export CSV
                        </sl-menu-item>
                        <sl-menu-item data-action="export-md" data-deck-id="${deck.id}">
                          <sl-icon slot="prefix" name="markdown"></sl-icon> Export Markdown
                        </sl-menu-item>
                        <sl-divider></sl-divider>
                        <sl-menu-item data-action="delete" data-deck-id="${deck.id}" class="text-red-600">
                          <sl-icon slot="prefix" name="trash"></sl-icon> Delete Deck
                        </sl-menu-item>
                      </sl-menu>
                    </sl-dropdown>
                  </div>
                  <p class="text-xs text-slate-500 mt-1">${cardCount} card(s) ${stats.high_score > 0 ? `• High Score: ${stats.high_score}` : ''}</p>
                </div>

                <div class="flex items-center gap-2 pt-2 border-t">
                  <sl-button variant="primary" size="small" class="flex-1" data-action="study" data-deck-id="${deck.id}">
                    <sl-icon slot="prefix" name="book"></sl-icon> Study FSRS
                  </sl-button>
                  <sl-button variant="default" size="small" data-action="game" data-deck-id="${deck.id}" title="Play Tower Defense">
                    <sl-icon name="controller"></sl-icon>
                  </sl-button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `;

  // Bind Buttons
  container.querySelector('#btn-create-deck')?.addEventListener('click', () => {
    router.navigate('#/flashcards/edit');
  });

  container.querySelector('#btn-empty-create')?.addEventListener('click', () => {
    router.navigate('#/flashcards/edit');
  });

  const fileInput = container.querySelector('#input-flashcard-csv');
  container.querySelector('#btn-import-csv')?.addEventListener('click', () => {
    fileInput?.click();
  });

  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const res = parseCSVWithValidation(text, FlashcardItemSchema);
      if (!res.success) {
        showImportErrorsDialog(res.errors);
        return;
      }

      const newDeck = {
        version: 1,
        id: generateUUID(),
        title: file.name.replace(/\.csv$/i, ''),
        updated_at: new Date().toISOString(),
        cards: res.data
      };

      await storage.table('flashcards').put(newDeck);
      toast.success(`Imported "${newDeck.title}" with ${res.data.length} cards!`);
      await renderLibrary(container, router);
    } catch (err) {
      console.error('CSV import error:', err);
      toast.danger('Import failed.');
    } finally {
      fileInput.value = '';
    }
  });

  // Action Menu Bindings
  container.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', async (e) => {
      const action = el.getAttribute('data-action');
      const deckId = el.getAttribute('data-deck-id');
      const deck = decks.find(d => d.id === deckId);
      if (!deck) return;

      if (action === 'study') {
        store.setState('activeDeck', deck);
        router.navigate(`#/flashcards/study?id=${deckId}`);
      } else if (action === 'game') {
        store.setState('activeDeck', deck);
        router.navigate(`#/flashcards/game?id=${deckId}`);
      } else if (action === 'edit') {
        router.navigate(`#/flashcards/edit?id=${deckId}`);
      } else if (action === 'delete') {
        if (confirm(`Are you sure you want to delete "${deck.title}"?`)) {
          await storage.table('flashcards').delete(deckId);
          toast.info('Deck deleted.');
          await renderLibrary(container, router);
        }
      } else if (action === 'export-csv') {
        const csvStr = Exporter.toCSV(deck.cards);
        downloadFile(csvStr, `${deck.title.replace(/\s+/g, '_')}.csv`, 'text/csv');
      } else if (action === 'export-md') {
        const mdStr = Exporter.toMarkdown(deck.cards, 'flashcards');
        downloadFile(mdStr, `${deck.title.replace(/\s+/g, '_')}.md`, 'text/markdown');
      } else if (action === 'share') {
        openShareDialog(deck, 'flashcards');
      }
    });
  });
}

function openShareDialog(dataObject, moduleType) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = `Share ${dataObject.title || 'Lesson'}`;
  dialog.innerHTML = `
    <div class="space-y-4">
      <p class="text-xs text-slate-500">
        Generate a zero-server encrypted URL that unpacks directly in any browser.
      </p>
      <sl-input id="input-share-password" type="password" password-toggle placeholder="Optional Passphrase to encrypt"></sl-input>
      <sl-button variant="primary" id="btn-gen-share" class="w-full">
        <sl-icon slot="prefix" name="link-45deg"></sl-icon> Generate Share Link
      </sl-button>
      <div id="share-result-box" class="hidden space-y-2 pt-2">
        <sl-input id="input-share-url" readonly></sl-input>
        <div class="flex justify-end gap-2">
          <sl-button size="small" id="btn-copy-url">Copy Link</sl-button>
          <sl-button size="small" id="btn-dl-kbshare" variant="neutral">Download .kbshare</sl-button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  const pwInput = dialog.querySelector('#input-share-password');
  const genBtn = dialog.querySelector('#btn-gen-share');
  const resBox = dialog.querySelector('#share-result-box');
  const urlInput = dialog.querySelector('#input-share-url');
  const copyBtn = dialog.querySelector('#btn-copy-url');
  const dlBtn = dialog.querySelector('#btn-dl-kbshare');

  let lastPayload = null;

  genBtn?.addEventListener('click', async () => {
    genBtn.setAttribute('loading', '');
    try {
      const pass = pwInput.value;
      lastPayload = await CryptoShareEngine.createSharePayload(moduleType, dataObject, pass);
      urlInput.value = lastPayload.url;
      resBox.classList.remove('hidden');

      if (lastPayload.exceedsUrlLimit) {
        toast.warning('Payload exceeds 2,048 chars! .kbshare file download is recommended for LMS embeds.');
      }
    } catch (err) {
      console.error('Share generation error:', err);
      toast.danger('Could not generate share link.');
    } finally {
      genBtn.removeAttribute('loading');
    }
  });

  copyBtn?.addEventListener('click', () => {
    navigator.clipboard.writeText(urlInput.value).then(() => {
      toast.success('Share link copied to clipboard!');
    });
  });

  dlBtn?.addEventListener('click', () => {
    if (lastPayload) {
      CryptoShareEngine.downloadKbShareFile(lastPayload.rawFileContent, `${(dataObject.title || 'lesson').replace(/\s+/g, '_')}.kbshare`);
    }
  });

  dialog.addEventListener('sl-after-hide', () => dialog.remove());
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 100);
}

export default renderFlashcardsView;
