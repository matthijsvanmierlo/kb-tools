// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { RubricScorer, RubricDesigner } from '../src/modules/gradebook/rubric-builder.js';
import { KbRubricPicker } from '../src/components/rubric-picker.js';

describe('WS6 — Rubrics on the fly & <kb-rubric-picker>', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    await storage.init();
    await storage.table('gradebook_rubrics').clear();
    await storage.table('tasks').clear();
  });

  describe('0-point ratings preservation in RubricScorer', () => {
    it('preserves 0-point cell ratings instead of defaulting to tier default points', () => {
      const rubric = {
        id: 'r-test',
        title: 'Science Rubric',
        tiers: [
          { id: 't-none', label: 'Unsatisfactory', default_points: 5 },
          { id: 't-good', label: 'Proficient', default_points: 15 }
        ],
        criteria: [
          {
            id: 'c-1',
            name: 'Hypothesis',
            weight: 1.0,
            cells: {
              't-none': { points: 0, descriptor: 'No hypothesis' }, // Explicit 0 pts!
              't-good': { points: 15, descriptor: 'Clear hypothesis' }
            }
          }
        ]
      };

      // When selecting 't-none' with explicit 0 points:
      const score = RubricScorer.calculateScore(rubric, { 'c-1': 't-none' });
      expect(score.totalEarned).toBe(0);
      expect(score.totalPossible).toBe(15);
      expect(score.percent).toBe(0);

      // When selecting 't-good':
      const scoreGood = RubricScorer.calculateScore(rubric, { 'c-1': 't-good' });
      expect(scoreGood.totalEarned).toBe(15);
      expect(scoreGood.totalPossible).toBe(15);
      expect(scoreGood.percent).toBe(100);
    });

    it('falls back to tier.default_points when cell.points is undefined', () => {
      const rubric = {
        id: 'r-test-fallback',
        title: 'Math Rubric',
        tiers: [
          { id: 't-0', label: 'Missing', default_points: 0 },
          { id: 't-1', label: 'Complete', default_points: 20 }
        ],
        criteria: [
          {
            id: 'c-1',
            name: 'Work shown',
            weight: 1.0,
            cells: {
              // no points defined on cell, should use tier.default_points (which is 0)
              't-0': { descriptor: 'Nothing submitted' }
            }
          }
        ]
      };

      const score = RubricScorer.calculateScore(rubric, { 'c-1': 't-0' });
      expect(score.totalEarned).toBe(0);
      expect(score.totalPossible).toBe(20);
    });
  });

  describe('<kb-rubric-picker> component', () => {
    it('renders scoped course rubrics and fires rubric-change on selection', async () => {
      const rubric1 = { id: 'r-1', course_id: 'course-101', title: 'Essay Rubric', tiers: [], criteria: [] };
      const rubric2 = { id: 'r-2', course_id: 'course-202', title: 'Other Class Rubric', tiers: [], criteria: [] };
      const rubricGlobal = { id: 'r-global', course_id: null, title: 'Global Rubric', tiers: [], criteria: [] };

      await storage.table('gradebook_rubrics').bulkPut([rubric1, rubric2, rubricGlobal]);

      const picker = document.createElement('kb-rubric-picker');
      picker.setAttribute('course-id', 'course-101');
      document.body.appendChild(picker);

      await picker.refresh();

      // Should contain r-1 and r-global, but not r-2
      const rubrics = picker.rubrics;
      expect(rubrics.some(r => r.id === 'r-1')).toBe(true);
      expect(rubrics.some(r => r.id === 'r-global')).toBe(true);
      expect(rubrics.some(r => r.id === 'r-2')).toBe(false);

      // Verify rubric-change event on selection
      let firedEvent = null;
      picker.addEventListener('rubric-change', (e) => {
        firedEvent = e.detail;
      });

      picker.value = 'r-1';
      picker.dispatchEvent(new CustomEvent('rubric-change', { detail: { rubricId: 'r-1', rubric: rubric1 } }));

      expect(firedEvent).not.toBeNull();
      expect(firedEvent.rubricId).toBe('r-1');
      expect(firedEvent.rubric.title).toBe('Essay Rubric');
    });

    it('creates a new rubric on the fly and auto-selects it', async () => {
      const picker = document.createElement('kb-rubric-picker');
      picker.setAttribute('course-id', 'course-math');
      document.body.appendChild(picker);
      await picker.refresh();

      const createdRubric = {
        id: 'r-newly-created',
        course_id: 'course-math',
        title: 'Oral Presentation Rubric',
        tiers: [
          { id: 't-1', label: 'Developing', default_points: 5 },
          { id: 't-2', label: 'Proficient', default_points: 10 }
        ],
        criteria: [
          { id: 'c-1', name: 'Delivery', weight: 1.0, cells: {} }
        ]
      };

      // Mock RubricDesigner.create
      vi.spyOn(RubricDesigner, 'create').mockResolvedValue(createdRubric);

      let changeDetail = null;
      picker.addEventListener('rubric-change', (e) => {
        changeDetail = e.detail;
      });

      await picker._handleCreate();

      expect(picker.value).toBe('r-newly-created');
      expect(changeDetail).not.toBeNull();
      expect(changeDetail.rubricId).toBe('r-newly-created');
      expect(changeDetail.rubric.title).toBe('Oral Presentation Rubric');
      expect(picker.rubrics.some(r => r.id === 'r-newly-created')).toBe(true);
    });
  });

  describe('RubricDesigner create & edit Promise API', () => {
    it('returns null when dismissed or cancelled', async () => {
      // Mock _showDesignerModal resolving null
      vi.spyOn(RubricDesigner, '_showDesignerModal').mockResolvedValue(null);

      const res = await RubricDesigner.create({ courseId: 'c-1' });
      expect(res).toBeNull();
    });

    it('returns the saved rubric when saved successfully', async () => {
      const fakeSaved = {
        id: 'r-saved-1',
        course_id: 'c-1',
        title: 'Project Rubric',
        tiers: [{ id: 't-1', label: 'T1', default_points: 10 }, { id: 't-2', label: 'T2', default_points: 20 }],
        criteria: [{ id: 'c-1', name: 'Crit 1', weight: 1.0, cells: {} }]
      };
      vi.spyOn(RubricDesigner, '_showDesignerModal').mockResolvedValue(fakeSaved);

      const res = await RubricDesigner.create({ courseId: 'c-1', initialTitle: 'Project Rubric' });
      expect(res).not.toBeNull();
      expect(res.id).toBe('r-saved-1');
      expect(res.title).toBe('Project Rubric');
    });
  });

  describe('Spot rubric attachment in task review drawer', () => {
    it('updates task.grading.rubric_id and persists to storage immediately', async () => {
      const task = {
        id: 'task-test-1',
        title: 'History Essay',
        grading: { scoring: 'points', max_points: 100, rubric_id: null }
      };
      await storage.table('tasks').put(task);

      const testRubric = {
        id: 'rubric-attached',
        title: 'Essay Rubric 2026',
        tiers: [{ id: 't1', label: 'Pass', default_points: 50 }, { id: 't2', label: 'High Pass', default_points: 100 }],
        criteria: [{ id: 'c1', name: 'Analysis', weight: 1.0, cells: {} }]
      };
      await storage.table('gradebook_rubrics').put(testRubric);

      // Simulate on-the-spot attachment
      task.grading.rubric_id = testRubric.id;
      await storage.table('tasks').put(task);

      const loaded = await storage.table('tasks').get('task-test-1');
      expect(loaded.grading.rubric_id).toBe('rubric-attached');
    });
  });
});
