import { storage } from '../../core/storage.js';
import { store } from '../../state/store.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { Exporter, parseCSVWithValidation, FlashcardItemSchema, showImportErrorsDialog } from '../../core/validator.js';
import { FlashcardEditor } from './editor.js';
import { StudyPlayer } from './study-player.js';
import { TowerDefenseEngine } from './tower-defense.js';
import { ProjectLibraryView } from '../../components/project-library.js';
import { ClassManager } from '../../components/class-manager.js';
import * as jspdfLib from 'jspdf';
import * as autotableLib from 'jspdf-autotable';

const jsPDFClass = jspdfLib.jsPDF || jspdfLib.default;
const autoTable = autotableLib.autoTable || autotableLib.default;

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

    const safeTitle = Sanitizer.escapeHTML(deck.title);

    container.innerHTML = `
      <div class="space-y-4 max-w-5xl mx-auto">
        <div class="flex items-center justify-between bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
          <div class="flex items-center gap-2">
            <button id="btn-td-back" class="text-slate-500 hover:text-slate-800 p-1">
              <sl-icon name="arrow-left" class="text-lg"></sl-icon>
            </button>
            <h2 class="font-bold text-slate-800">${safeTitle} — Tower Defense Study</h2>
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

        <div class="bg-slate-900 rounded-2xl overflow-hidden shadow-lg border border-slate-700 flex justify-center">
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
        class_id: ClassManager.getActiveFilter(),
        cards: []
      };
    }
    const editor = new FlashcardEditor(deck, {
      onSave: () => router.navigate('#/flashcards'),
      onClose: () => router.navigate('#/flashcards')
    });
    return editor.mount(container);
  }

  // Default Route: Deck Library UI using ProjectLibraryView
  await renderLibrary(container, router);
}

async function renderLibrary(container, router) {
  // Ensure sample deck exists if empty
  const count = await storage.table('flashcards').count();
  if (count === 0) {
    await seedSampleDeck();
  }

  const library = new ProjectLibraryView({
    moduleType: 'flashcards',
    title: 'Flashcard Decks',
    itemTypeName: 'Deck',
    tableName: 'flashcards',
    createRoute: '#/flashcards/edit',
    accentColor: '#2563eb',
    iconName: 'stack',
    getOpenUrl: (item) => `#/flashcards/study?id=${item.id}`,
    getEditUrl: (item) => `#/flashcards/edit?id=${item.id}`,
    getMetadataSummary: (item) => {
      const cards = item.cards || [];
      const now = new Date();
      const due = cards.filter(c => c.fsrs?.due && new Date(c.fsrs.due) <= now).length;
      return `${cards.length} Cards • ${due} Due`;
    },
    onImport: () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,.json';
      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
          const text = await file.text();
          if (file.name.endsWith('.json')) {
            const parsed = JSON.parse(text);
            const newDeck = {
              version: 1,
              id: generateUUID(),
              title: parsed.title || file.name.replace(/\.[^/.]+$/, ''),
              cards: Array.isArray(parsed.cards) ? parsed.cards.map(c => ({
                id: generateUUID(),
                type: 'text',
                front: typeof c.front === 'string' ? { text: c.front, ttsLang: 'en-US' } : c.front,
                back: typeof c.back === 'string' ? { text: c.back, ttsLang: 'en-US' } : c.back,
                fsrs: { state: 0, stability: 0, difficulty: 0, due: new Date().toISOString() }
              })) : [],
              updated_at: new Date().toISOString()
            };
            await storage.table('flashcards').put(newDeck);
            toast.success('Deck imported from JSON!');
          } else {
            const res = parseCSVWithValidation(text, FlashcardItemSchema);
            if (!res.success) {
              showImportErrorsDialog(res.errors);
              return;
            }
            const newDeck = {
              version: 1,
              id: generateUUID(),
              title: file.name.replace(/\.[^/.]+$/, ''),
              cards: res.data.map(c => ({
                id: generateUUID(),
                type: 'text',
                front: typeof c.front === 'string' ? { text: c.front, ttsLang: 'en-US' } : c.front,
                back: typeof c.back === 'string' ? { text: c.back, ttsLang: 'en-US' } : c.back,
                fsrs: { state: 0, stability: 0, difficulty: 0, due: new Date().toISOString() }
              })),
              updated_at: new Date().toISOString()
            };
            await storage.table('flashcards').put(newDeck);
            toast.success(`Imported deck with ${res.data.length} cards!`);
          }
          library.render(container);
        } catch (err) {
          toast.danger('Import failed: ' + err.message);
        }
      };
      input.click();
    }
  });

  await library.render(container);
}

export function exportPrintableStudyGuidePDF(deck) {
  if (typeof jsPDFClass === 'undefined') {
    toast.danger('PDF generator is not available.');
    return;
  }

  const doc = new jsPDFClass({ orientation: 'portrait', unit: 'pt', format: 'letter' });

  // Header Banner
  doc.setFillColor(37, 99, 235); // Blue 600
  doc.rect(0, 0, 612, 65, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.text(deck.title || 'Flashcards Study Guide', 40, 38);

  doc.setFontSize(10);
  doc.text(`Printable Study Sheet & Folding Cards • ${deck.cards?.length || 0} Terms`, 40, 52);

  const tableData = (deck.cards || []).map((c, i) => {
    const fText = typeof c.front === 'string' ? c.front : (c.front?.text || '');
    const bText = typeof c.back === 'string' ? c.back : (c.back?.text || '');
    return [`#${i + 1}`, fText, bText];
  });

  autoTable(doc, {
    startY: 85,
    margin: { left: 40, right: 40 },
    head: [['#', 'Front (Question / Prompt)', 'Back (Answer / Explanation)']],
    body: tableData,
    headStyles: {
      fillColor: [241, 245, 249],
      textColor: [30, 41, 59],
      fontStyle: 'bold'
    },
    styles: {
      fontSize: 9,
      cellPadding: 8,
      overflow: 'linebreak'
    },
    columnStyles: {
      0: { cellWidth: 30, halign: 'center' },
      1: { cellWidth: 240 },
      2: { cellWidth: 260 }
    }
  });

  const filename = `${(deck.title || 'study_guide').replace(/[^a-zA-Z0-9_-]/g, '_')}_study_sheet.pdf`;
  doc.save(filename);
  toast.success('Study Guide PDF downloaded!');
}

async function seedSampleDeck() {
  const sampleDeck = {
    version: 1,
    id: generateUUID(),
    title: 'STEM Fundamentals: Chemistry & Physics',
    description: 'Core equations and laws across physical chemistry and classical mechanics.',
    updated_at: new Date().toISOString(),
    gamification_stats: { high_score: 0, longest_streak: 0 },
    cards: [
      {
        id: generateUUID(),
        type: 'text',
        front: { text: 'What is the Henderson-Hasselbalch equation for buffer pH?', ttsLang: 'en-US' },
        back: { text: '$$pH = pK_a + \\log\\left(\\frac{[A^-]}{[HA]}\\right)$$\nRelates the pH of a chemical solution to the acid dissociation constant ($K_a$).', ttsLang: 'en-US' },
        fsrs: { state: 0, difficulty: 0, stability: 0, due: new Date().toISOString(), reps: 0, lapses: 0 }
      },
      {
        id: generateUUID(),
        type: 'text',
        front: 'What is the balanced equation for cellular respiration?',
        back: '$$\\ce{C6H12O6 + 6O2 -> 6CO2 + 6H2O + 36ATP}$$\nGlucose oxidized in the presence of oxygen yielding carbon dioxide, water, and ATP energy.',
        fsrs: { state: 0, difficulty: 0, stability: 0, due: new Date().toISOString(), reps: 0, lapses: 0 }
      },
      {
        id: generateUUID(),
        type: 'text',
        front: "What is Newton's Second Law of Motion?",
        back: '$$\\vec{F} = m\\vec{a}$$\nThe net force acting on an object is equal to the product of its inertial mass and acceleration vector.',
        fsrs: { state: 0, difficulty: 0, stability: 0, due: new Date().toISOString(), reps: 0, lapses: 0 }
      }
    ]
  };

  // Check if legacy plain string cards need normalization
  sampleDeck.cards = sampleDeck.cards.map(c => ({
    ...c,
    front: typeof c.front === 'string' ? { text: c.front, ttsLang: 'en-US' } : c.front,
    back: typeof c.back === 'string' ? { text: c.back, ttsLang: 'en-US' } : c.back
  }));

  await storage.table('flashcards').put(sampleDeck);
}

export default renderFlashcardsView;
