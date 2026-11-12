import { describe, it, expect } from 'vitest';
import { computeStudentSummary } from '../src/modules/gradebook/aggregates.js';
import { computeQuestionStandardScores } from '../src/modules/gradebook/bridge.js';

describe('Phase 52: Hybrid Gradebook & Per-Question Standards', () => {
  const student = { student_id: 'S1', full_name: 'Ada Lovelace' };
  const standards = [
    { id: 'std-1', code: 'NGSS.PS1', description: 'Matter & Interactions' },
    { id: 'std-2', code: 'NGSS.PS2', description: 'Forces & Motion' }
  ];
  const baseCourse = {
    id: 'c1',
    name: 'Physical Science',
    grading_scale: 'traditional',
    categories: [
      { id: 'cat-hw', name: 'Practice', weight_pct: 30 },
      { id: 'cat-test', name: 'Assessments', weight_pct: 70 }
    ],
    standards,
    sbg_config: {
      aggregation: 'mean',
      hybrid_standards_weight_pct: 50,
      levels: [
        { value: 4, label: 'Exemplary', min_pct: 90 },
        { value: 3, label: 'Proficient', min_pct: 75 },
        { value: 2, label: 'Developing', min_pct: 55 },
        { value: 1, label: 'Beginning', min_pct: 0 }
      ]
    },
    letter_scale: {
      bands: [
        { label: 'A', min: 90 },
        { label: 'B', min: 80 },
        { label: 'C', min: 70 },
        { label: 'D', min: 60 },
        { label: 'F', min: 0 }
      ]
    }
  };

  it('1. Computes standards map even in traditional mode when course has standards', () => {
    const assignments = [
      { id: 'a1', title: 'HW 1', category_id: 'cat-hw', max_score: 100, scoring: 'points', standard_ids: ['std-1'], due_date: '2026-10-01' }
    ];
    const gradesMap = new Map([
      ['S1+a1', { student_id: 'S1', assignment_id: 'a1', raw_score: 80, status: 'submitted', standard_scores: { 'std-1': 3 } }]
    ]);

    const summary = computeStudentSummary(student, baseCourse, assignments, gradesMap);
    expect(summary.mode).toBe('traditional');
    expect(summary.score).toBe(80);
    expect(summary.standards).toBeInstanceOf(Map);
    expect(summary.standards.get('std-1')?.mastery).toBe(3);
  });

  it('2. Hybrid mode blends weighted points percentage and standards mastery percentage', () => {
    const hybridCourse = { ...baseCourse, grading_scale: 'hybrid' };
    const assignments = [
      { id: 'a1', title: 'Practice', category_id: 'cat-hw', max_score: 100, scoring: 'points', due_date: '2026-10-01' },
      { id: 'a2', title: 'Lab', category_id: 'cat-test', max_score: 100, scoring: 'points', standard_ids: ['std-1'], due_date: '2026-10-02' }
    ];
    // Points weighted: 100*0.3 + 80*0.7 = 86%. Standards: level 4 (Exemplary -> 95% or 100% depending on masteryToGrade)
    const gradesMap = new Map([
      ['S1+a1', { student_id: 'S1', assignment_id: 'a1', raw_score: 100, status: 'submitted' }],
      ['S1+a2', { student_id: 'S1', assignment_id: 'a2', raw_score: 80, status: 'submitted', standard_scores: { 'std-1': 4 } }]
    ]);

    const summary = computeStudentSummary(student, hybridCourse, assignments, gradesMap);
    expect(summary.mode).toBe('hybrid');
    expect(summary.points_score).toBe(86);
    expect(summary.mastery).toBe(4);
    expect(summary.score).toBeGreaterThan(86);
  });

  it('3. computeQuestionStandardScores aggregates per-question points into standard proficiency levels', () => {
    const assignment = {
      id: 'quiz-1',
      questions: [
        { id: 'q1', points: 10, standard_ids: ['std-1'] },
        { id: 'q2', points: 10, standard_ids: ['std-1'] },
        { id: 'q3', points: 10, standard_ids: ['std-2'] }
      ]
    };
    const submission = {
      auto: {
        per_question: {
          q1: { earned: 10, possible: 10 },
          q2: { earned: 8, possible: 10 }, // std-1: 18/20 = 90% -> Level 4
          q3: { earned: 6, possible: 10 }  // std-2: 6/10 = 60% -> Level 2
        }
      },
      manual: {}
    };

    const scores = computeQuestionStandardScores(assignment, submission, baseCourse);
    expect(scores['std-1']).toBe(4);
    expect(scores['std-2']).toBe(2);
  });
});
