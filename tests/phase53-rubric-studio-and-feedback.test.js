import { describe, it, expect } from 'vitest';
import { RubricScorer } from '../src/modules/gradebook/rubric-builder.js';
import { RUBRIC_TEMPLATES, buildRubricFromTemplate } from '../src/modules/rubrics/index.js';

describe('Phase 53: Rubric Studio & Criterion-to-Standard Auto-Mapping', () => {
  it('1. Starter templates instantiate valid rubrics with unique IDs and cells', () => {
    expect(RUBRIC_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    const rubric = buildRubricFromTemplate('tpl-essay', { courseId: null, title: 'My Essay Rubric' });
    expect(rubric.title).toBe('My Essay Rubric');
    expect(rubric.course_id).toBeNull();
    expect(rubric.tiers).toHaveLength(4);
    expect(rubric.criteria).toHaveLength(4);
    for (const c of rubric.criteria) {
      for (const t of rubric.tiers) {
        expect(c.cells[t.id]).toBeDefined();
        expect(typeof c.cells[t.id].points).toBe('number');
      }
    }
  });

  it('2. RubricScorer.deriveStandardScores maps criterion evaluations to course SBG levels', () => {
    const sbgLevels = [
      { value: 4, label: 'Exemplary', min_pct: 90 },
      { value: 3, label: 'Proficient', min_pct: 75 },
      { value: 2, label: 'Developing', min_pct: 55 },
      { value: 1, label: 'Beginning', min_pct: 0 }
    ];

    const rubric = {
      id: 'r1',
      scoring_mode: 'points',
      tiers: [
        { id: 't4', label: 'Exemplary', default_points: 4 },
        { id: 't3', label: 'Proficient', default_points: 3 },
        { id: 't2', label: 'Developing', default_points: 2 },
        { id: 't1', label: 'Beginning', default_points: 1 }
      ],
      criteria: [
        { id: 'c1', name: 'Claim', weight: 1, standard_id: 'std-claim', cells: {} },
        { id: 'c2', name: 'Evidence', weight: 1, standard_id: 'std-evid', cells: {} }
      ]
    };

    const derived = RubricScorer.deriveStandardScores(rubric, { c1: 't4', c2: 't2' }, sbgLevels);
    expect(derived['std-claim']).toBe(4); // 4/4 = 100% -> 4
    expect(derived['std-evid']).toBe(1);  // 2/4 = 50% -> 1 (below 55%)
  });

  it('3. RubricScorer.deriveStandardScores uses direct proficiency value when scoring_mode is proficiency', () => {
    const sbgLevels = [
      { value: 4, label: 'Exemplary' },
      { value: 3, label: 'Proficient' },
      { value: 2, label: 'Developing' },
      { value: 1, label: 'Beginning' }
    ];

    const rubric = buildRubricFromTemplate('tpl-sbg-4pt');
    rubric.criteria[0].standard_id = 'std-1';
    const secondTier = rubric.tiers[1]; // Proficient (3)

    const derived = RubricScorer.deriveStandardScores(rubric, { [rubric.criteria[0].id]: secondTier.id }, sbgLevels);
    expect(derived['std-1']).toBe(3);
  });
});
