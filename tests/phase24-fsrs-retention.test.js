import { describe, it, expect } from 'vitest';
import { FSRSEngine, DEFAULT_RETENTION, MIN_RETENTION, MAX_RETENTION } from '../src/modules/flashcards/fsrs.js';
import { fitWithin } from '../src/utils/media.js';
import { buildGoogleClassroomRows, GOOGLE_CLASSROOM_HEADERS } from '../src/modules/gradebook/gradebook-csv.js';

const DAY = 86400000;
const NOW = new Date('2026-10-18T09:00:00').getTime();

function reviewCard(stability, lastReviewDaysAgo) {
  const last = NOW - lastReviewDaysAgo * DAY;
  return { fsrs: { state: 2, stability, difficulty: 5, reps: 3, lapses: 0, last_review: new Date(last).toISOString(), due_timestamp: last + stability * DAY } };
}

describe('Phase 24: FSRS target retention (rev-3 §6.3)', () => {
  it('defaults to 90 % and clamps to 80–95 %', () => {
    expect(new FSRSEngine().requestRetention).toBe(DEFAULT_RETENTION);
    const f = new FSRSEngine();
    expect(f.setRequestRetention(0.5)).toBe(MIN_RETENTION);
    expect(f.setRequestRetention(0.99)).toBe(MAX_RETENTION);
    expect(f.setRequestRetention('nope')).toBe(DEFAULT_RETENTION);
  });

  it('interval equals stability at 90 %, longer at lower retention, shorter at higher', () => {
    const f = new FSRSEngine();
    expect(f.nextInterval(20, 0.9)).toBe(20);
    expect(f.nextInterval(20, 0.8)).toBeGreaterThan(20);
    expect(f.nextInterval(20, 0.95)).toBeLessThan(20);
    // Retrievability at the scheduled interval is the requested retention
    for (const r of [0.8, 0.85, 0.9, 0.95]) {
      const t = (20 / (19 / 81)) * (Math.pow(r, -2) - 1);
      expect(f.calculateRetrievability(t, 20)).toBeCloseTo(r, 6);
    }
  });

  it('a review scheduled under a lower target lands later', () => {
    const card = { fsrs: { state: 2, stability: 10, difficulty: 5, reps: 2, lapses: 0, last_review: new Date(NOW - 10 * DAY).toISOString() } };
    const low = new FSRSEngine(null, 0.8).reviewCard(card, 3, NOW);
    const high = new FSRSEngine(null, 0.95).reviewCard(card, 3, NOW);
    expect(low.scheduled_days).toBeGreaterThan(high.scheduled_days);
  });

  it('reschedules review cards and leaves new and learning cards alone', () => {
    const f = new FSRSEngine(null, 0.8);
    const cards = [reviewCard(10, 2), { fsrs: { state: 0 } }, { fsrs: { state: 1, stability: 1, last_review: new Date(NOW).toISOString(), due_timestamp: NOW + 600000 } }];
    const changed = f.rescheduleCards(cards);
    expect(changed).toHaveLength(1);
    expect(cards[0].fsrs.due_timestamp).toBe(NOW - 2 * DAY + f.nextInterval(10) * DAY);
    expect(cards[2].fsrs.due_timestamp).toBe(NOW + 600000);
  });
});

describe('Phase 24: 7-day workload forecast', () => {
  it('buckets reviews per day, counts overdue into today, and reports new cards separately', () => {
    const f = new FSRSEngine();
    const cards = [
      reviewCard(1, 3),   // overdue by 2 days → today
      reviewCard(2, 1),   // due tomorrow
      reviewCard(4, 1),   // due in 3 days
      reviewCard(30, 1),  // beyond the window
      { front: { text: 'new' } }
    ];
    const { days, newCards, overdue } = f.forecastWorkload(cards, { nowMs: NOW });
    expect(days).toHaveLength(7);
    expect(days.map(d => d.count)).toEqual([1, 1, 0, 1, 0, 0, 0]);
    expect(newCards).toBe(1);
    expect(overdue).toBe(1);
  });

  it('shows a heavier week at higher retention', () => {
    const f = new FSRSEngine();
    const cards = Array.from({ length: 50 }, (_, i) => reviewCard(5 + (i % 10), 4));
    const total = (r) => f.forecastWorkload(cards, { nowMs: NOW, retention: r }).days.reduce((s, d) => s + d.count, 0);
    expect(total(0.95)).toBeGreaterThan(total(0.8));
  });
});

describe('Phase 24: Image downsampling geometry (rev-3 §6.1)', () => {
  it('fits inside 800 px without upscaling', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1080, 1920)).toEqual({ width: 450, height: 800 });
    expect(fitWithin(320, 200)).toEqual({ width: 320, height: 200 });
  });
});

describe('Phase 24: Google Classroom CSV preset (rev-3 §4.3)', () => {
  it('exports Email Address, Assignment Score, Feedback for one assignment', () => {
    const students = [
      { student_id: 'S1', full_name: 'Ada', email: 'ada@school.edu' },
      { student_id: 'S2', full_name: 'Bo', email: 'bo@school.edu' },
      { student_id: 'S3', full_name: 'No Email' }
    ];
    const gradesMap = new Map([
      ['S1+a1', { raw_score: 8, feedback: 'Great work' }],
      ['S2+a1', { raw_score: null }]
    ]);
    const { headers, rows, skipped } = buildGoogleClassroomRows({ assignment: { id: 'a1' }, students, gradesMap });
    expect(headers).toEqual(GOOGLE_CLASSROOM_HEADERS);
    expect(headers).toEqual(['Email Address', 'Assignment Score', 'Feedback']);
    expect(rows).toEqual([
      { 'Email Address': 'ada@school.edu', 'Assignment Score': 8, Feedback: 'Great work' },
      { 'Email Address': 'bo@school.edu', 'Assignment Score': '', Feedback: '' }
    ]);
    expect(skipped).toBe(1);
  });
});
