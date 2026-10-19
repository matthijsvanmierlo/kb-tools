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
import { CSVImportDialog } from '../../components/csv-import-dialog.js';
import { FLASHCARDS_CSV_TEMPLATE } from '../../core/csv-templates.js';
import { renderStudyPlanner, applySavedRetention } from './study-planner.js';
import { normalizeSharedEnvelope } from '../../core/shared-payload.js';
import { ContentImporter } from '../../core/content-importer.js';
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
  await applySavedRetention();

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

  container.innerHTML = '<div data-role="library"></div><div data-role="planner" class="max-w-7xl mx-auto mt-6 px-0"></div>';
  const libraryEl = container.querySelector('[data-role="library"]');
  const plannerEl = container.querySelector('[data-role="planner"]');

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
      CSVImportDialog.open({
        title: 'Import Flashcards',
        subtitle: 'Upload a .kbshare lesson file, CSV/JSON file, or copy and paste rows from Google Sheets or Excel.',
        templateFilename: 'flashcards_template.csv',
        templateContent: FLASHCARDS_CSV_TEMPLATE,
        schema: FlashcardItemSchema,
        acceptJson: true,
        acceptKbShare: true,
        onImport: async (resultData, rawText, { filename, isJson, isKbShare }) => {
          const activeClass = ClassManager.getActiveFilter() || null;
          if (isKbShare) {
            const res = await ContentImporter.importRecordToLibrary('flashcards', resultData, {
              classId: activeClass,
              filename
            });
            toast.success(`Imported deck "${res.title}" with ${res.count} cards from .kbshare!`);
          } else if (isJson) {
            const parsed = normalizeSharedEnvelope({ type: 'flashcards', payload: resultData }).payload;
            const newDeck = {
              version: 1,
              id: generateUUID(),
              title: parsed.title || (filename || 'Imported Deck').replace(/\.[^/.]+$/, ''),
              class_id: activeClass,
              cards: Array.isArray(parsed.cards) ? parsed.cards.map(c => ({
                id: generateUUID(),
                type: 'text',
                front: typeof c.front === 'string' ? { text: c.front, ttsLang: 'en-US' } : (c.front || { text: '', ttsLang: 'en-US' }),
                back: typeof c.back === 'string' ? { text: c.back, ttsLang: 'en-US' } : (c.back || { text: '', ttsLang: 'en-US' }),
                fsrs: { state: 0, stability: 0, difficulty: 0, due: new Date().toISOString() }
              })) : [],
              updated_at: new Date().toISOString()
            };
            await storage.table('flashcards').put(newDeck);
            toast.success('Deck imported from JSON!');
          } else {
            let title = (filename || 'Imported Flashcards').replace(/\.[^/.]+$/, '');
            if (title === 'pasted_data') title = 'Pasted Flashcards Deck';
            else if (title === 'flashcards_template' || title === 'template') title = 'Flashcard Deck';
            else {
              title = title.replace(/[_\-]+/g, ' ');
              title = title.charAt(0).toUpperCase() + title.slice(1);
            }
            const newDeck = {
              version: 1,
              id: generateUUID(),
              title,
              class_id: activeClass,
              cards: (resultData || []).map(c => ({
                id: generateUUID(),
                type: 'text',
                front: typeof c.front === 'string' ? { text: c.front, ttsLang: 'en-US' } : (c.front || { text: '', ttsLang: 'en-US' }),
                back: typeof c.back === 'string' ? { text: c.back, ttsLang: 'en-US' } : (c.back || { text: '', ttsLang: 'en-US' }),
                fsrs: { state: 0, stability: 0, difficulty: 0, due: new Date().toISOString() }
              })),
              updated_at: new Date().toISOString()
            };
            await storage.table('flashcards').put(newDeck);
            toast.success(`Imported deck "${title}" with ${newDeck.cards.length} cards!`);
          }
          library.searchQuery = '';
          library.selectedClassId = activeClass;
          library.sortBy = 'updated';
          await library.render(libraryEl);
          await renderStudyPlanner(plannerEl);
        }
      });
    }
  });

  await library.render(libraryEl);
  await renderStudyPlanner(plannerEl);
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
