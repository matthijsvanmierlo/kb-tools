import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildClickableHtmlFile,
  extractEnvelopeFromHtml,
  downloadClickableHtmlFile
} from '../src/core/html-launcher.js';
import {
  consumeWindowLaunchPayload,
  classifyIncomingFile,
  openIncomingFiles
} from '../src/core/pwa.js';
import {
  ASSIGNMENT_CSV_TEMPLATE,
  TIMELINE_CSV_TEMPLATE,
  FLASHCARDS_CSV_TEMPLATE,
  ROSTER_CSV_TEMPLATE
} from '../src/core/csv-templates.js';
import {
  parseCSVWithValidation,
  AssignmentQuestionRowSchema,
  TimelineEventSchema,
  FlashcardItemSchema,
  Exporter,
  normalizeAssignmentQuestionRow
} from '../src/core/validator.js';
import { validateQuestion } from '../src/modules/assignments/question-types.js';
import { ContentImporter } from '../src/core/content-importer.js';

describe('Phase 35: File Launching, Philosophy Page & Assignment CSV Import/Export', () => {

  describe('1. Double-Click HTML File Launching & Cross-Origin Handshake', () => {
    it('embeds KB_LAUNCH_V1 envelope into window.name for cross-origin origin handoff', () => {
      const payload = {
        kind: 'kb-assignment',
        assignment_id: 'test-asg-1',
        title: 'Physics Test'
      };

      const html = buildClickableHtmlFile({
        title: 'Physics Test',
        payloadType: 'assignment',
        payload,
        shareUrl: 'http://localhost:3000/#/assessments/take?share=abc123payload',
        appBaseUrl: 'http://localhost:3000/'
      });

      expect(html).toContain('KB_LAUNCH_V1:');
      expect(html).toContain('window.name =');
      expect(html).toContain('sessionStorage.setItem');
      expect(html).toContain('Physics Test');
      expect(html).toContain('Opening in KennisBoost Tools');
    });

    it('extracts embedded envelope cleanly with extractEnvelopeFromHtml', () => {
      const payload = {
        kind: 'assignment_feedback',
        score: { earned: 18, possible: 20 },
        feedback: 'Great job on the derivation!'
      };

      const html = buildClickableHtmlFile({
        title: 'Quiz 2 Feedback',
        payloadType: 'feedback',
        payload
      });

      const extracted = extractEnvelopeFromHtml(html);
      expect(extracted).toBeTruthy();
      expect(extracted.kind).toBe('assignment_feedback');
      expect(extracted.feedback).toBe('Great job on the derivation!');
    });

    it('consumeWindowLaunchPayload parses and executes window.name payload', async () => {
      const mockRouter = {
        openShareFile: vi.fn().mockResolvedValue(true),
        navigate: vi.fn()
      };

      const envelope = {
        type: 'assignment',
        payload: { kind: 'kb-assignment', title: 'Test Quiz' }
      };

      // Set up window.name with KB_LAUNCH_V1 envelope
      window.name = `KB_LAUNCH_V1:${JSON.stringify(envelope)}`;

      const consumed = await consumeWindowLaunchPayload(mockRouter);
      expect(consumed).toBe(true);
      expect(mockRouter.openShareFile).toHaveBeenCalledWith(JSON.stringify(envelope.payload));
      // Verify window.name was cleared
      expect(window.name).toBe('');
    });

    it('consumeWindowLaunchPayload ignores non-launcher window names', async () => {
      const mockRouter = {
        openShareFile: vi.fn(),
        navigate: vi.fn()
      };

      window.name = 'my_normal_target_frame';
      const consumed = await consumeWindowLaunchPayload(mockRouter);
      expect(consumed).toBe(false);
      expect(mockRouter.openShareFile).not.toHaveBeenCalled();
      expect(window.name).toBe('my_normal_target_frame');
    });
  });

  describe('2. Incoming File Routing for .kbfeedback and raw JSON', () => {
    it('openIncomingFiles routes assignment_feedback JSON to student gradebook', async () => {
      const mockRouter = {
        navigate: vi.fn(),
        openShareFile: vi.fn()
      };

      const feedbackData = {
        kind: 'assignment_feedback',
        assignment: { title: 'AP Bio Exam' },
        score: { earned: 92, possible: 100 }
      };

      const file = new File(
        [JSON.stringify(feedbackData)],
        'feedback.kbfeedback',
        { type: 'application/json' }
      );

      await openIncomingFiles([file], mockRouter);
      expect(mockRouter.navigate).toHaveBeenCalledWith('#/student/gradebook');
      expect(mockRouter.openShareFile).not.toHaveBeenCalled();
    });

    it('openIncomingFiles routes raw kb-assignment JSON without throwing error', async () => {
      const mockRouter = {
        navigate: vi.fn(),
        openShareFile: vi.fn()
      };

      const asgData = {
        kind: 'kb-assignment',
        assignment_id: 'asg-789',
        title: 'Chemistry Midterm'
      };

      const file = new File(
        [JSON.stringify(asgData)],
        'chem.kbshare',
        { type: 'application/json' }
      );

      await openIncomingFiles([file], mockRouter);
      expect(mockRouter.openShareFile).toHaveBeenCalled();
    });
  });

  describe('3. Assignment CSV Template & 9 STEM Question Types', () => {
    it('ASSIGNMENT_CSV_TEMPLATE contains all 9 question types', () => {
      const expectedTypes = [
        'single_choice',
        'multi_choice',
        'true_false',
        'numeric',
        'short_text',
        'fill_blank',
        'ordering',
        'matching',
        'long_text'
      ];

      for (const t of expectedTypes) {
        expect(ASSIGNMENT_CSV_TEMPLATE).toContain(t);
      }
    });

    it('parses ASSIGNMENT_CSV_TEMPLATE with 100% valid questions', () => {
      const result = parseCSVWithValidation(ASSIGNMENT_CSV_TEMPLATE, AssignmentQuestionRowSchema);

      expect(result.success).toBe(true);
      expect(result.data.length).toBe(9);

      const [
        singleChoice,
        multiChoice,
        trueFalse,
        numeric,
        shortText,
        fillBlank,
        ordering,
        matching,
        longText
      ] = result.data;

      // Check single_choice
      expect(singleChoice.type).toBe('single_choice');
      expect(singleChoice.options.length).toBe(4);
      expect(singleChoice.options[1].is_correct).toBe(true); // B is correct
      expect(singleChoice.options[0].is_correct).toBe(false);
      expect(validateQuestion(singleChoice)).toEqual([]);

      // Check multi_choice
      expect(multiChoice.type).toBe('multi_choice');
      expect(multiChoice.options.length).toBe(4);
      expect(multiChoice.options[0].is_correct).toBe(true); // A is correct
      expect(multiChoice.options[1].is_correct).toBe(false);
      expect(multiChoice.options[2].is_correct).toBe(true); // C is correct
      expect(multiChoice.scoring).toBe('partial');
      expect(validateQuestion(multiChoice)).toEqual([]);

      // Check true_false
      expect(trueFalse.type).toBe('true_false');
      expect(trueFalse.correct).toBe(true);
      expect(validateQuestion(trueFalse)).toEqual([]);

      // Check numeric
      expect(numeric.type).toBe('numeric');
      expect(numeric.target).toBe(18.015);
      expect(numeric.tolerance).toBe(0.05);
      expect(numeric.unit).toBe('g/mol');
      expect(validateQuestion(numeric)).toEqual([]);

      // Check short_text
      expect(shortText.type).toBe('short_text');
      expect(shortText.accepted).toContain('chloroplast');
      expect(shortText.accepted).toContain('chloroplasts');
      expect(validateQuestion(shortText)).toEqual([]);

      // Check fill_blank
      expect(fillBlank.type).toBe('fill_blank');
      expect(fillBlank.blanks.length).toBe(2);
      expect(fillBlank.blanks[0].accepted).toContain('cytoplasm');
      expect(fillBlank.blanks[0].accepted).toContain('cytosol');
      expect(fillBlank.blanks[1].accepted).toContain('pyruvate');
      expect(fillBlank.blanks[1].accepted).toContain('ATP');
      expect(validateQuestion(fillBlank)).toEqual([]);

      // Check ordering
      expect(ordering.type).toBe('ordering');
      expect(ordering.items.length).toBe(4);
      expect(ordering.items[0].text).toBe('Prophase');
      expect(ordering.items[1].text).toBe('Metaphase');
      expect(ordering.items[2].text).toBe('Anaphase');
      expect(ordering.items[3].text).toBe('Telophase');
      expect(validateQuestion(ordering)).toEqual([]);

      // Check matching
      expect(matching.type).toBe('matching');
      expect(matching.pairs.length).toBe(4);
      expect(matching.pairs[0].left).toBe('H2O');
      expect(matching.pairs[0].right).toBe('Water');
      expect(matching.pairs[1].left).toBe('NaCl');
      expect(matching.pairs[1].right).toBe('Table Salt');
      expect(validateQuestion(matching)).toEqual([]);

      // Check long_text
      expect(longText.type).toBe('long_text');
      expect(longText.rubric_hint).toContain('exhaust gases');
      expect(validateQuestion(longText)).toEqual([]);
    });

    it('normalizes type aliases and positional column mapping', () => {
      const row = {
        type: 'mc',
        prompt: 'What is 2 + 2?',
        option_a: '3',
        option_b: '4',
        option_c: '5',
        correct_answer: 'B',
        points: 2
      };

      const normalized = normalizeAssignmentQuestionRow(row);
      expect(normalized.type).toBe('single_choice');
      expect(normalized.points).toBe(2);
      expect(normalized.options[1].is_correct).toBe(true);
      expect(validateQuestion(normalized)).toEqual([]);
    });

    it('rejects invalid rows with detailed validation error messages', () => {
      const invalidCSV = `Type,Prompt,Points,CorrectAnswer
single_choice,"",1,"A"
numeric,"Calculate the mass",1,"not_a_number"
ordering,"Order these steps",1,""`;

      const result = parseCSVWithValidation(invalidCSV, AssignmentQuestionRowSchema);
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('4. Exporter & CSV Round-Trip', () => {
    it('round-trips all 9 question types from questions to CSV and back', () => {
      // 1. Parse original template questions
      const parsedOriginal = parseCSVWithValidation(ASSIGNMENT_CSV_TEMPLATE, AssignmentQuestionRowSchema);
      expect(parsedOriginal.success).toBe(true);

      // 2. Export to CSV using Exporter.assignmentToCSV
      const exportedCsv = Exporter.assignmentToCSV(parsedOriginal.data);
      expect(exportedCsv).toContain('Type');
      expect(exportedCsv).toContain('Prompt');
      expect(exportedCsv).toContain('CorrectAnswer');
      expect(exportedCsv).toContain('single_choice');
      expect(exportedCsv).toContain('numeric');
      expect(exportedCsv).toContain('matching');

      // 3. Re-import the exported CSV
      const reimported = parseCSVWithValidation(exportedCsv, AssignmentQuestionRowSchema);
      expect(reimported.success).toBe(true);
      expect(reimported.data.length).toBe(9);

      // Validate all re-imported questions are valid
      for (const q of reimported.data) {
        const issues = validateQuestion(q);
        expect(issues).toEqual([]);
      }

      // Check specific preserved attributes
      const reNumeric = reimported.data.find(q => q.type === 'numeric');
      expect(reNumeric.target).toBe(18.015);
      expect(reNumeric.tolerance).toBe(0.05);
      expect(reNumeric.unit).toBe('g/mol');

      const reMatching = reimported.data.find(q => q.type === 'matching');
      expect(reMatching.pairs.length).toBe(4);
      expect(reMatching.pairs[0].left).toBe('H2O');
      expect(reMatching.pairs[0].right).toBe('Water');
    });
  });

  describe('5. ContentImporter & Question Merging', () => {
    it('merges new questions into assignment cleanly', () => {
      const existingAssignment = {
        id: 'asg-test-merge',
        title: 'Original Assignment',
        questions: [
          { id: 'q1', type: 'short_text', prompt: 'Question 1', points: 1 }
        ]
      };

      const questionsToAdd = [
        { type: 'true_false', prompt: 'Earth is round.', correct_answer: 'true', points: 1 },
        { type: 'numeric', prompt: 'Value of pi', correct_answer: 3.14, points: 2 }
      ];

      const merged = ContentImporter.mergeQuestionsIntoAssignment(existingAssignment, questionsToAdd);
      expect(merged.questions.length).toBe(3);
      expect(merged.questions[0].id).toBe('q1');
      expect(merged.questions[1].id).toBeTruthy();
      expect(merged.questions[1].type).toBe('true_false');
      expect(merged.questions[2].id).toBeTruthy();
      expect(merged.questions[2].type).toBe('numeric');
    });
  });

  describe('6. Universal Import Dialog Format Discrimination', () => {
    it('correctly discriminates Assignment CSV from Timeline and Flashcard CSVs', () => {
      // Assignment CSV should match AssignmentQuestionRowSchema
      const asgResult = parseCSVWithValidation(ASSIGNMENT_CSV_TEMPLATE, AssignmentQuestionRowSchema);
      expect(asgResult.success).toBe(true);

      // Flashcards CSV should NOT match AssignmentQuestionRowSchema (missing type)
      const flashcardAsAsg = parseCSVWithValidation(FLASHCARDS_CSV_TEMPLATE, AssignmentQuestionRowSchema);
      expect(flashcardAsAsg.success).toBe(false);

      // Flashcards CSV should match FlashcardItemSchema
      const flashcardResult = parseCSVWithValidation(FLASHCARDS_CSV_TEMPLATE, FlashcardItemSchema);
      expect(flashcardResult.success).toBe(true);

      // Timeline CSV should match TimelineEventSchema
      const timelineResult = parseCSVWithValidation(TIMELINE_CSV_TEMPLATE, TimelineEventSchema);
      expect(timelineResult.success).toBe(true);
    });
  });
});
