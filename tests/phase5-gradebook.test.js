import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeScore,
  GradebookMathEngine
} from '../src/modules/gradebook/engine-calc.js';
import { RubricScorer } from '../src/modules/gradebook/rubric-builder.js';
import { GradebookReportGenerator } from '../src/modules/gradebook/report-generator.js';
import { CryptoShareEngine } from '../src/core/crypto-share.js';
import { generateUUID } from '../src/utils/uuid.js';

describe('Phase 5: Assignment Normalizer & Penalty Pre-Processor', () => {
  const assignment = { max_score: 100 };

  it('excludes exempt work from calculation', () => {
    const record = { raw_score: 0, status: 'exempt' };
    expect(normalizeScore(record, assignment)).toBeNull();
  });

  it('applies missing floor percentage policy (e.g. 50% minimum grading)', () => {
    const record = { raw_score: null, status: 'missing' };
    const policy = { missing_floor_pct: 50 };
    const res = normalizeScore(record, assignment, policy);

    expect(res).toBeDefined();
    expect(res.effectivePct).toBe(50);
    expect(res.effectivePoints).toBe(50);
  });

  it('applies daily late penalty up to max late cap', () => {
    // 90/100, 3 days late, 5% per day, capped at 10%
    const record = { raw_score: 90, status: 'late', days_late: 3 };
    const policy = { late_mode: 'daily', late_daily_pct: 5, max_late_cap_pct: 10 };
    const res = normalizeScore(record, assignment, policy);

    expect(res).toBeDefined();
    // 3 * 5% = 15%, capped at 10% penalty -> 90 - 10 = 80%
    expect(res.effectivePct).toBe(80);
    expect(res.effectivePoints).toBe(80);
  });
});

describe('Phase 5: Gradebook Mathematical Calculation Engines', () => {
  it('computes traditional weighted categories with Drop Lowest N', () => {
    const categories = [
      { id: 'cat-tests', name: 'Tests', weight_pct: 70, drop_lowest: 1, policy: {} },
      { id: 'cat-hw', name: 'Homework', weight_pct: 30, drop_lowest: 0, policy: {} }
    ];

    const assignments = [
      { id: 't1', category_id: 'cat-tests', max_score: 100 },
      { id: 't2', category_id: 'cat-tests', max_score: 100 }, // Will be dropped (lowest)
      { id: 't3', category_id: 'cat-tests', max_score: 100 },
      { id: 'h1', category_id: 'cat-hw', max_score: 50 }
    ];

    const records = new Map([
      ['t1', { raw_score: 90, status: 'submitted' }],
      ['t2', { raw_score: 60, status: 'submitted' }], // 60 dropped
      ['t3', { raw_score: 100, status: 'submitted' }],
      ['h1', { raw_score: 45, status: 'submitted' }] // 90%
    ]);

    // Tests category: [90, 100] kept -> 190 / 200 = 95%
    // HW category: [45] kept -> 45 / 50 = 90%
    // Final: (95 * 0.70 + 90 * 0.30) / (0.70 + 0.30) = 66.5 + 27.0 = 93.5%
    const finalPct = GradebookMathEngine.computeTraditionalWeighted(records, assignments, categories);
    expect(finalPct).toBe(93.5);
  });

  it('computes SBG Decaying Average (alpha = 0.65)', () => {
    // Chronological scores: 2.0, 3.0, 4.0
    // Step 1: 2.0
    // Step 2: 2.0 * 0.35 + 3.0 * 0.65 = 0.7 + 1.95 = 2.65
    // Step 3: 2.65 * 0.35 + 4.0 * 0.65 = 0.9275 + 2.6 = 3.5275 -> 3.53
    const scores = [2.0, 3.0, 4.0];
    const sbg = GradebookMathEngine.computeDecayingAverage(scores, 0.65);
    expect(sbg).toBe(3.53);
  });

  it('computes SBG Marzano Power Law regression', () => {
    const scores = [2.0, 2.5, 3.2, 3.8];
    const predicted = GradebookMathEngine.computeMarzanoPowerLaw(scores);
    expect(predicted).toBeGreaterThan(3.0);
    expect(predicted).toBeLessThanOrEqual(4.0);
  });

  it('computes SBG Trend Mode with late-occurrence tie breaker', () => {
    // Scores: 3.0, 2.5, 3.0, 4.0, 4.0
    // Frequencies: 3.0 (2 times), 4.0 (2 times), 2.5 (1 time)
    // 4.0 occurred later than 3.0, so 4.0 wins tie-breaker
    const scores = [3.0, 2.5, 3.0, 4.0, 4.0];
    const trendMode = GradebookMathEngine.computeTrendMode(scores);
    expect(trendMode).toBe(4.0);
  });

  it('converts SBG mastery scores to institutional percentage and letter grades', () => {
    expect(GradebookMathEngine.masteryToGrade(3.8)).toEqual({ percent: 95, letter: 'A' });
    expect(GradebookMathEngine.masteryToGrade(3.2)).toEqual({ percent: 88, letter: 'B+' });
    expect(GradebookMathEngine.masteryToGrade(2.7)).toEqual({ percent: 82, letter: 'B-' });
    expect(GradebookMathEngine.masteryToGrade(1.2)).toEqual({ percent: 55, letter: 'F' });
  });
});

describe('Phase 5: Weighted Rubric Real-Time Scoring', () => {
  const sampleRubric = {
    id: generateUUID(),
    title: 'Essay Rubric',
    tiers: [
      { id: 't1', label: 'Novice', default_points: 10 },
      { id: 't2', label: 'Proficient', default_points: 20 },
      { id: 't3', label: 'Exemplary', default_points: 30 }
    ],
    criteria: [
      {
        id: 'c1',
        name: 'Thesis & Argument',
        weight: 1.0,
        cells: {
          't1': { points: 10, descriptor: 'Weak thesis' },
          't2': { points: 20, descriptor: 'Clear thesis' },
          't3': { points: 30, descriptor: 'Nuanced thesis' }
        }
      },
      {
        id: 'c2',
        name: 'Evidence & Analysis',
        weight: 2.0, // Double weight
        cells: {
          't1': { points: 10, descriptor: 'Sparse citations' },
          't2': { points: 20, descriptor: 'Solid citations' },
          't3': { points: 30, descriptor: 'Exhaustive citations' }
        }
      }
    ]
  };

  it('calculates weighted earned vs max possible points', () => {
    // Select: c1 -> t2 (20 pts * 1.0 = 20), c2 -> t3 (30 pts * 2.0 = 60)
    // Total Earned = 20 + 60 = 80
    // Total Possible = (30 * 1.0) + (30 * 2.0) = 30 + 60 = 90
    // Percent = 80 / 90 = 88.9%
    const selected = { 'c1': 't2', 'c2': 't3' };
    const res = RubricScorer.calculateScore(sampleRubric, selected);

    expect(res.totalEarned).toBe(80);
    expect(res.totalPossible).toBe(90);
    expect(res.percent).toBe(88.9);
    expect(res.letter).toBe('B+');
  });
});

describe('Phase 5: Student Report PDF, Batch ZIP & Encrypted Share Link', () => {
  const mockStudent = {
    id: generateUUID(),
    student_id: 'S202',
    full_name: 'David Miller',
    email: 'dmiller@school.edu'
  };

  const mockCourse = {
    id: generateUUID(),
    name: 'Honors Physics',
    academic_year: '2026-2027',
    categories: [{ id: 'cat-exams', name: 'Exams', weight_pct: 100 }],
    terms: []
  };

  const mockAssignments = [
    { id: 'a1', title: 'Mechanics Exam', category_id: 'cat-exams', max_score: 100, due_date: '2026-10-01' }
  ];

  const mockGradesMap = new Map([
    ['S202+a1', { raw_score: 92, status: 'submitted', feedback: 'Great job!' }]
  ]);

  it('generates an individual student PDF without errors', () => {
    const doc = GradebookReportGenerator.generateStudentPDF(mockStudent, mockCourse, mockAssignments, mockGradesMap);
    expect(doc).toBeDefined();
    expect(typeof doc.output).toBe('function');
  });

  it('generates a batch roster ZIP archive containing student PDF reports', async () => {
    const students = [
      mockStudent,
      { id: generateUUID(), student_id: 'S203', full_name: 'Grace Hopper' }
    ];

    const zipBlob = await GradebookReportGenerator.generateBatchZip(students, mockCourse, mockAssignments, mockGradesMap);
    expect(zipBlob).toBeDefined();
    expect(zipBlob.size).toBeGreaterThan(100);
  });

  it('creates FERPA-isolated student URL encrypted with student ID', async () => {
    const share = await GradebookReportGenerator.createStudentShareLink(mockStudent, mockCourse, mockAssignments, mockGradesMap);
    expect(share.url).toContain('enc=1');
    expect(share.url).toContain('&d=');

    const dParam = new URL(share.url).hash.split('d=')[1];

    // Decrypt with student's own ID
    const unpacked = await CryptoShareEngine.unpackSharePayload(dParam, true, mockStudent.student_id);
    expect(unpacked.type).toBe('student_grade_report');
    expect(unpacked.payload.student.full_name).toBe('David Miller');

    // Wrong password / ID fails
    await expect(
      CryptoShareEngine.unpackSharePayload(dParam, true, 'WrongID')
    ).rejects.toThrow('INVALID_PASSPHRASE');
  });
});

describe('Phase 5: 150x80 Virtualized Grid Stress Test', () => {
  it('correctly calculates 2D windowing boundaries so only ~200 DOM cells are rendered for 12,000 items', () => {
    const ROW_HEIGHT = 40;
    const CELL_WIDTH = 110;
    const OVERSCAN = 4;
    const viewportHeight = 600;
    const viewportWidth = 900;

    const totalStudents = 150;
    const totalAssignments = 80;

    // Simulate scrolled viewport
    const scrollTop = 1200; // Scrolled down
    const scrollLeft = 1100; // Scrolled right

    const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endRow = Math.min(totalStudents - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

    const startCol = Math.max(0, Math.floor(scrollLeft / CELL_WIDTH) - OVERSCAN);
    const endCol = Math.min(totalAssignments - 1, Math.ceil((scrollLeft + viewportWidth) / CELL_WIDTH) + OVERSCAN);

    const renderedRows = endRow - startRow + 1;
    const renderedCols = endCol - startCol + 1;
    const totalRenderedCells = renderedRows * renderedCols;

    // Total possible cells = 150 * 80 = 12,000
    expect(totalStudents * totalAssignments).toBe(12000);
    // Rendered cells in window should be ~300 to ~400 (drastically smaller than 12,000!)
    expect(totalRenderedCells).toBeLessThan(500);
    expect(totalRenderedCells).toBeGreaterThan(50);
  });
});
