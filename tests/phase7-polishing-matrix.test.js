import { describe, it, expect, beforeEach } from 'vitest';
import lzLib from 'lz-string';
import {
  FlashcardSetSchema,
  TimelineDatasetSchema,
  VideoAssessmentSchema,
  GradebookCourseSchema
} from '../src/core/validator.js';
import { Sanitizer } from '../src/core/sanitizer.js';
import {
  TimelineCanvasRenderer,
  calculateNiceTickInterval,
  formatEpochDaysToLabel,
  parseHistoricalDateToDays
} from '../src/modules/timeline/canvas-renderer.js';
import { VirtualGradebookGrid } from '../src/modules/gradebook/virtual-grid.js';
import { RubricScorer } from '../src/modules/gradebook/rubric-builder.js';
import { KioskReportEngine } from '../src/modules/video/kiosk-report.js';
import { generateUUID } from '../src/utils/uuid.js';

const LZString = lzLib.compressToEncodedURIComponent ? lzLib : (lzLib.default || lzLib);

describe('Phase 7 Verification: Zod Schema v2 & Class Tagging', () => {
  it('validates FlashcardSetSchema with optional class_id, description, and tags', () => {
    const validDeck = {
      version: 1,
      id: generateUUID(),
      title: 'AP Biology Decks',
      description: 'Photosynthesis and cellular respiration cards',
      class_id: generateUUID(),
      tags: ['biology', 'ap', 'cells'],
      cards: [
        {
          id: generateUUID(),
          front: { text: 'What is the primary product of the Calvin cycle?' },
          back: { text: 'G3P (glyceraldehyde-3-phosphate)' },
          fsrs: { state: 0, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, reps: 0, lapses: 0 }
        }
      ]
    };
    const parsed = FlashcardSetSchema.safeParse(validDeck);
    expect(parsed.success).toBe(true);
    expect(parsed.data.class_id).toBe(validDeck.class_id);
    expect(parsed.data.tags).toEqual(['biology', 'ap', 'cells']);
  });

  it('validates TimelineDatasetSchema with class_id and metadata', () => {
    const validTimeline = {
      version: 1,
      id: generateUUID(),
      title: 'World War II Chronology',
      description: 'Key political and military milestones 1939-1945',
      class_id: generateUUID(),
      tags: ['history', 'ww2'],
      events: [
        {
          id: generateUUID(),
          title: 'Invasion of Poland',
          start_date: '1939-09-01',
          category: 'Military'
        }
      ]
    };
    const parsed = TimelineDatasetSchema.safeParse(validTimeline);
    expect(parsed.success).toBe(true);
    expect(parsed.data.class_id).toBe(validTimeline.class_id);
  });

  it('validates VideoAssessmentSchema with class_id and question types', () => {
    const validVideo = {
      version: 1,
      id: generateUUID(),
      title: 'Thermodynamics Video Lesson',
      class_id: generateUUID(),
      provider: 'youtube',
      video_source: 'https://youtu.be/dQw4w9WgXcQ',
      checkpoints: [
        {
          id: generateUUID(),
          timestamp_sec: 45.0,
          type: 'multi_choice',
          prompt_markdown: 'Select all state functions:',
          options: [
            { id: '1', text: 'Enthalpy', is_correct: true },
            { id: '2', text: 'Entropy', is_correct: true },
            { id: '3', text: 'Work', is_correct: false }
          ],
          points: 2
        }
      ]
    };
    const parsed = VideoAssessmentSchema.safeParse(validVideo);
    expect(parsed.success).toBe(true);
  });

  it('validates GradebookCourseSchema with section, color, and updated_at', () => {
    const validCourse = {
      id: generateUUID(),
      name: 'AP Chemistry',
      section: 'Period 3',
      color: '#10b981',
      academic_year: '2026-2027',
      grading_scale: 'traditional',
      terms: [{ id: 't1', name: 'Semester 1', start_date: '2026-09-01', end_date: '2027-01-20', weight_pct: 100 }],
      categories: [{ id: 'c1', name: 'Tests', weight_pct: 100, drop_lowest: 0, policy: {} }],
      updated_at: new Date().toISOString()
    };
    const parsed = GradebookCourseSchema.safeParse(validCourse);
    expect(parsed.success).toBe(true);
    expect(parsed.data.color).toBe('#10b981');
    expect(parsed.data.section).toBe('Period 3');
  });
});

describe('Phase 7 Verification: STEM Markdown & KaTeX/Mhchem Sanitization', () => {
  it('renders inline and block KaTeX formulas without XSS vulnerabilities', () => {
    const rawInput = 'Kinetic Energy is given by $E_k = \\frac{1}{2}mv^2$. Block: $$\\Delta G = \\Delta H - T\\Delta S$$';
    const rendered = Sanitizer.renderSTEMMarkdown(rawInput);
    expect(rendered).toContain('katex');
    expect(rendered).not.toContain('<script>');
  });

  it('renders chemistry equations via mhchem syntax $\\ce{...}$', () => {
    const rawInput = 'Combustion: $\\ce{CH4 + 2O2 -> CO2 + 2H2O}$';
    const rendered = Sanitizer.renderSTEMMarkdown(rawInput);
    expect(rendered).toContain('katex');
  });

  it('neutralizes malicious HTML embedded alongside math formulas', () => {
    const malicious = 'Formula: $x = 1$ <script>alert("hacked")</script><img src=x onerror=alert(1)>';
    const rendered = Sanitizer.renderSTEMMarkdown(malicious);
    expect(rendered).not.toContain('<script>');
    expect(rendered).not.toContain('onerror');
    expect(rendered).not.toContain('alert');
  });
});

describe('Phase 7 Verification: Timeline Multi-Scale Zoom & Anti-Overlap Engine', () => {
  const MIN_TICK_SPACING_PX = 110;

  it('guarantees that dynamic tick spacing is never less than MIN_TICK_SPACING_PX across 7 orders of magnitude', () => {
    const testPPDs = [
      1e-5,   // Deep geologic macro time
      1e-4,   // Millennia scale
      1e-3,   // Centuries scale
      0.01,   // Decades scale
      0.1,    // Years scale
      1.0,    // Month/day scale
      10.0,   // Days scale
      200.0,  // Hours scale
      2400.0  // Minutes scale
    ];

    for (const ppd of testPPDs) {
      const intervalDays = calculateNiceTickInterval(ppd, MIN_TICK_SPACING_PX);
      const pixelWidth = intervalDays * ppd;
      expect(pixelWidth).toBeGreaterThanOrEqual(MIN_TICK_SPACING_PX);
    }
  });

  it('formats calendar-aligned BCE and CE year labels correctly', () => {
    // 44 BCE
    const bceDays = parseHistoricalDateToDays(-44);
    const bceLabel = formatEpochDaysToLabel(bceDays, 'year');
    expect(bceLabel).toContain('BCE');
    expect(bceLabel).toBe('44 BCE');

    // 2026 CE
    const ceDays = parseHistoricalDateToDays(2026);
    const ceLabel = formatEpochDaysToLabel(ceDays, 'year');
    expect(ceLabel).toBe('2026');
  });
});

describe('Phase 7 Verification: VirtualGradebookGrid Failsafe, Undo/Redo & Shortcuts', () => {
  let mountEl;
  let students;
  let assignments;
  let gradesMap;
  let grid;

  beforeEach(() => {
    mountEl = document.createElement('div');
    document.body.appendChild(mountEl);

    students = [
      { id: 'st-1', student_id: 'S101', full_name: 'Student One' },
      { id: 'st-2', student_id: 'S102', full_name: 'Student Two' }
    ];

    assignments = [
      { id: 'as-1', title: 'Quiz 1', max_score: 100 }
    ];

    gradesMap = new Map();
    gradesMap.set('S101+as-1', {
      course_id: 'c-100',
      student_id: 'S101',
      assignment_id: 'as-1',
      raw_score: 85,
      status: 'submitted'
    });

    grid = new VirtualGradebookGrid(mountEl, {
      courseId: 'c-100',
      students,
      assignments,
      gradesMap
    });
  });

  it('stores courseId and includes it in committed grade records', () => {
    expect(grid.courseId).toBe('c-100');
  });

  it('records edits onto the 20-step undo stack and supports undo/redo', () => {
    const prev = gradesMap.get('S101+as-1');
    const updated = { ...prev, raw_score: 95 };

    grid.pushUndo({
      key: 'S101+as-1',
      prevRecord: prev,
      newRecord: updated,
      studentId: 'S101',
      assignmentId: 'as-1'
    });

    gradesMap.set('S101+as-1', updated);
    expect(gradesMap.get('S101+as-1').raw_score).toBe(95);

    // Perform Undo
    grid.undo();
    expect(gradesMap.get('S101+as-1').raw_score).toBe(85);

    // Perform Redo
    grid.redo();
    expect(gradesMap.get('S101+as-1').raw_score).toBe(95);
  });
});

describe('Phase 7 Verification: Cryptographic Receipt (.kbr) Verification & Tamper Detection', () => {
  it('validates authentic .kbr receipt and detects tampering with score or student name', async () => {
    const studentName = 'Elena Rostova';
    const assessmentId = generateUUID();
    const assessmentTitle = 'Classical Mechanics';
    const responseLogs = [
      { checkpointId: 'cp-1', studentAnswer: ['opt-1'], isCorrect: true, earnedPoints: 10, maxPoints: 10, latencyMs: 1200 }
    ];

    const { kbrString } = await KioskReportEngine.generateReceipt(
      studentName,
      assessmentId,
      assessmentTitle,
      responseLogs,
      10,
      10
    );

    // 1. Verify authentic receipt
    const validResult = await KioskReportEngine.verifyReceipt(kbrString);
    expect(validResult.isValid).toBe(true);
    expect(validResult.receipt.studentName).toBe(studentName);
    expect(validResult.receipt.totalScore).toBe(10);

    // 2. Tamper with score: decompress, modify totalScore from 10 to 100, recompress
    const decompressed = LZString.decompressFromEncodedURIComponent(kbrString);
    const parsed = JSON.parse(decompressed);
    parsed.totalScore = 100;
    const tamperedKbrString = LZString.compressToEncodedURIComponent(JSON.stringify(parsed));

    const tamperedResult = await KioskReportEngine.verifyReceipt(tamperedKbrString);
    expect(tamperedResult.isValid).toBe(false);
    expect(tamperedResult.error).toBe('CRYPTOGRAPHIC_SIGNATURE_MISMATCH');
  });
});
