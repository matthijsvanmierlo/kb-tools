import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { FSRSEngine } from '../src/modules/flashcards/fsrs.js';
import { SketchCanvas } from '../src/modules/flashcards/sketch-canvas.js';
import { TowerDefenseEngine } from '../src/modules/flashcards/tower-defense.js';
import { Sanitizer } from '../src/core/sanitizer.js';
import { generateUUID } from '../src/utils/uuid.js';

describe('Phase 2: FSRS v4 Mathematical Spaced Repetition Engine', () => {
  let fsrs;

  beforeEach(() => {
    fsrs = new FSRSEngine();
  });

  it('calculates retrievability correctly using R(t, S) formula', () => {
    // R(0, S) = (1 + 0)^-0.5 = 1.0
    expect(fsrs.calculateRetrievability(0, 5)).toBe(1.0);
    // S <= 0 returns 0
    expect(fsrs.calculateRetrievability(10, 0)).toBe(0);

    // After elapsed days, R decays smoothly between 0 and 1
    const r1 = fsrs.calculateRetrievability(1, 5);
    const r5 = fsrs.calculateRetrievability(5, 5);
    expect(r1).toBeGreaterThan(r5);
    expect(r5).toBeGreaterThan(0);
    expect(r1).toBeLessThan(1.0);
  });

  it('calculates initial stability and difficulty for a new card reviewed as Good (grade 3)', () => {
    const card = { id: generateUUID() };
    const now = Date.now();

    const review = fsrs.reviewCard(card, 3, now);
    expect(review.state).toBe(2); // Review state
    expect(review.reps).toBe(1);
    expect(review.lapses).toBe(0);
    expect(review.stability).toBe(fsrs.w[2]); // w2 = 2.4
    expect(review.difficulty).toBe(fsrs.w[4]); // w4 = 4.93
    expect(review.scheduled_days).toBeGreaterThan(0);
    expect(review.due_timestamp).toBeGreaterThan(now);
  });

  it('handles lapse (grade 1 = Again): sets relearning state, increments lapses, schedules 10m ahead', () => {
    const card = {
      id: generateUUID(),
      fsrs: {
        state: 2,
        stability: 10.0,
        difficulty: 4.5,
        reps: 3,
        lapses: 0,
        last_review: new Date(Date.now() - 5 * 86400000).toISOString() // 5 days ago
      }
    };
    const now = Date.now();
    const review = fsrs.reviewCard(card, 1, now);

    expect(review.state).toBe(3); // Relearning
    expect(review.reps).toBe(0);
    expect(review.lapses).toBe(1);
    expect(review.scheduled_days).toBe(0);
    // Again schedules 10 minutes (600,000 ms) ahead
    expect(review.due_timestamp).toBe(now + 600000);
  });

  it('sorts due cards in ascending retrievability (highest retrieval risk first)', () => {
    const now = Date.now();
    const cards = [
      {
        id: 'card-high-retrievability',
        fsrs: {
          state: 2,
          stability: 50,
          due_timestamp: now - 1000,
          last_review: new Date(now - 1 * 86400000).toISOString() // 1 day elapsed on 50 stability => high R
        }
      },
      {
        id: 'card-low-retrievability',
        fsrs: {
          state: 2,
          stability: 2,
          due_timestamp: now - 1000,
          last_review: new Date(now - 5 * 86400000).toISOString() // 5 days elapsed on 2 stability => low R
        }
      }
    ];

    const sorted = fsrs.getDueCardsSorted(cards, now);
    expect(sorted[0].id).toBe('card-low-retrievability');
    expect(sorted[1].id).toBe('card-high-retrievability');
  });
});

describe('Phase 2: SketchCanvas Vector Drawing & Undo Stack', () => {
  let canvas;
  let sketch;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 300;
    sketch = new SketchCanvas(canvas);
  });

  it('records normalized stroke coordinates and allows undo/redo up to 20 states', () => {
    // Simulate stroke 1
    sketch.strokes.push({
      color: '#2563eb',
      size: 4,
      mode: 'pen',
      points: [[100, 100, 0.5], [105, 105, 0.6]]
    });
    expect(sketch.getStrokes().length).toBe(1);

    // Simulate stroke 2
    sketch.strokes.push({
      color: '#2563eb',
      size: 4,
      mode: 'pen',
      points: [[200, 200, 0.5]]
    });
    expect(sketch.getStrokes().length).toBe(2);

    // Undo stroke 2
    sketch.undo();
    expect(sketch.getStrokes().length).toBe(1);
    expect(sketch.redoStack.length).toBe(1);

    // Redo stroke 2
    sketch.redo();
    expect(sketch.getStrokes().length).toBe(2);
    expect(sketch.redoStack.length).toBe(0);
  });

  it('serializes strokes to JSON and restores them accurately', () => {
    const rawStrokes = [
      { color: '#dc2626', size: 6, mode: 'pen', points: [[50, 50, 0.8], [60, 60, 0.9]] }
    ];
    sketch.loadStrokes(rawStrokes);
    const loaded = sketch.getStrokes();
    expect(loaded).toEqual(rawStrokes);
  });
});

describe('Phase 2: Tower Defense Game Mechanics & Quiz Economics', () => {
  let canvas;
  let deck;
  let engine;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 420;

    deck = {
      id: generateUUID(),
      title: 'Biology Deck',
      cards: [
        { id: generateUUID(), front: { text: 'Question 1' }, back: { text: 'Answer 1' } },
        { id: generateUUID(), front: { text: 'Question 2' }, back: { text: 'Answer 2' } },
        { id: generateUUID(), front: { text: 'Question 3' }, back: { text: 'Answer 3' } },
        { id: generateUUID(), front: { text: 'Question 4' }, back: { text: 'Answer 4' } }
      ]
    };

    engine = new TowerDefenseEngine(canvas, deck);
  });

  it('answers question correctly: awards +35 energy, increases streak, advances question', () => {
    engine.energy = 50;
    engine.streak = 2;
    engine.currentQuestion = {
      prompt: 'What is cell powerhouse?',
      correct: 'Mitochondria',
      options: ['Mitochondria', 'Nucleus', 'Ribosome', 'Vacuole']
    };

    engine.answerQuestion('Mitochondria');
    expect(engine.energy).toBe(85); // 50 + 35
    expect(engine.streak).toBe(3);
    expect(engine.correctAnswers).toBe(1);
  });

  it('answers question incorrectly: resets streak and sets 2s turret jam cooldown', () => {
    engine.streak = 4;
    engine.currentQuestion = {
      prompt: 'What is cell powerhouse?',
      correct: 'Mitochondria',
      options: ['Mitochondria', 'Nucleus', 'Ribosome', 'Vacuole']
    };

    engine.answerQuestion('Nucleus');
    expect(engine.streak).toBe(0);
    expect(engine.globalTurretJamUntil).toBeGreaterThan(performance.now());
  });

  it('builds an Archer Tower when energy is sufficient', () => {
    engine.energy = 100;
    const pad = engine.buildPads[0];
    const success = engine.buildTower(pad, 'archer');

    expect(success).toBe(true);
    expect(pad.tower).toBeDefined();
    expect(pad.tower.type).toBe('archer');
    expect(engine.energy).toBe(50); // 100 - 50
  });
});

describe('Phase 2: Chemical & STEM Equation Rendering', () => {
  it('renders chemical formula with Mhchem notation \\ce{H2 + O2 -> H2O}', () => {
    const raw = 'Reaction: $$\\ce{H2 + O2 -> H2O}$$';
    const output = Sanitizer.renderSTEMMarkdown(raw);
    expect(output).toContain('H2 + O2 -> H2O');
    expect(output).not.toContain('<script>');
  });
});
