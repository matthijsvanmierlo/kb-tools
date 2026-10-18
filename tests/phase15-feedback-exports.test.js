import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import {
  SUBMISSIONS_CSV_HEADERS,
  MAIL_MERGE_CSV_HEADERS,
  NOT_SUBMITTED_CSV_HEADERS,
  GRADEBOOK_MAIL_MERGE_HEADERS,
  GRADEBOOK_WIDE_BASE_HEADERS,
  GRADEBOOK_WIDE_TAIL_HEADERS,
  CANVAS_BASE_HEADERS,
  buildSubmissionsExportRows,
  buildMailMergeExportRows,
  buildNotSubmittedExportRows
} from '../src/core/export-presets.js';
import { buildFeedbackPayload, createFeedbackLink } from '../src/modules/assignments/feedback-link.js';
import { generateSubmissionPDF, generateFeedbackZip } from '../src/modules/assignments/feedback-pdf.js';
import { feedbackSummary } from '../src/modules/assignments/grading.js';
import { CryptoShareEngine } from '../src/core/crypto-share.js';
import { generateAccessCode, normalizeAccessCode } from '../src/core/access-codes.js';

describe('Phase 15: Feedback & Export Presets', () => {
  const assignment = {
    id: 'as-fb-1',
    title: 'Cellular Respiration',
    settings: {
      due_date: '2026-10-20',
      show_correct_answers: false
    },
    questions: [
      {
        id: 'q1',
        type: 'single_choice',
        prompt: 'Where does glycolysis occur?',
        points: 2,
        options: [
          { id: 'opt-a', text: 'Cytoplasm', is_correct: true },
          { id: 'opt-b', text: 'Mitochondria', is_correct: false }
        ],
        explanation: 'Glycolysis takes place in the cytosol/cytoplasm.'
      },
      {
        id: 'q2',
        type: 'long_text',
        prompt: 'Explain the role of ATP synthase.',
        points: 5,
        explanation: 'Generates ATP using proton gradient.'
      }
    ]
  };

  const student = {
    student_id: 'S101',
    full_name: 'Emma Watson',
    given_name: 'Emma',
    family_name: 'Watson',
    email: 'ewatson@school.edu',
    access_code: generateAccessCode()
  };

  const course = {
    id: 'c1',
    name: 'AP Biology',
    section: 'Period 3'
  };

  const submission = {
    id: 'sub-1',
    assignment_id: 'as-fb-1',
    student_id: 'S101',
    student_name: 'Emma Watson',
    submitted_at: '2026-10-18T14:30:00Z',
    days_late: 0,
    identity: 'verified',
    publish_version: 1,
    answers: {
      q1: 'opt-a',
      q2: 'It phosphorylates ADP to ATP.'
    },
    auto: {
      per_question: {
        q1: { earned: 2, possible: 2, is_correct: true },
        q2: { earned: 0, possible: 5, needs_manual: true }
      }
    },
    manual: {
      q2: { points: 4, feedback: 'Great explanation, mention protons next time.' }
    },
    feedback: 'Excellent work overall!'
  };

  describe('Header schemas match Appendix B specifications', () => {
    it('matches Appendix B.1 Submissions CSV headers', () => {
      expect(SUBMISSIONS_CSV_HEADERS).toEqual([
        'StudentID', 'FullName', 'FirstName', 'LastName', 'Email',
        'Assignment', 'Class', 'Status', 'SubmittedAt', 'DaysLate',
        'Identity', 'Score', 'MaxScore', 'Percent', 'PendingReview', 'Feedback'
      ]);
    });

    it('matches Appendix B.2 Mail-merge CSV headers', () => {
      expect(MAIL_MERGE_CSV_HEADERS).toEqual([
        'Email', 'FirstName', 'LastName', 'FullName', 'StudentID',
        'Class', 'Assignment', 'DueDate', 'Status', 'Score',
        'MaxScore', 'Percent', 'Feedback', 'Link', 'AssignmentLink'
      ]);
    });

    it('matches Appendix B.6 Not submitted CSV headers', () => {
      expect(NOT_SUBMITTED_CSV_HEADERS).toEqual([
        'Email', 'FirstName', 'LastName', 'FullName', 'StudentID',
        'Assignment', 'DueDate', 'Link'
      ]);
    });

    it('matches Gradebook export header definitions', () => {
      expect(GRADEBOOK_MAIL_MERGE_HEADERS).toEqual([
        'Email', 'FirstName', 'LastName', 'FullName', 'StudentID',
        'Class', 'Section', 'Grade', 'Letter', 'Mastery',
        'MissingCount', 'MissingList', 'LateCount', 'ReportLink'
      ]);
      expect(GRADEBOOK_WIDE_BASE_HEADERS).toEqual(['StudentID', 'FullName', 'Email']);
      expect(GRADEBOOK_WIDE_TAIL_HEADERS).toEqual(['Overall', 'Letter', 'Missing', 'Late']);
      expect(CANVAS_BASE_HEADERS).toEqual(['Student', 'ID', 'SIS User ID', 'SIS Login ID', 'Section']);
    });
  });

  describe('buildFeedbackPayload', () => {
    it('strips correct answers and explanations when show_correct_answers is false', () => {
      const payload = buildFeedbackPayload({ assignment, submission, student, course });
      expect(payload.version).toBe(1);
      expect(payload.kind).toBe('assignment_feedback');
      expect(payload.student.student_id).toBe('S101');
      expect(payload.student.full_name).toBe('Emma Watson');
      expect(payload.score.earned).toBe(6);
      expect(payload.score.possible).toBe(7);
      expect(payload.questions).toHaveLength(2);

      // Question 1
      expect(payload.questions[0].earned).toBe(2);
      expect(payload.questions[0].possible).toBe(2);
      expect(payload.questions[0].correct).toBe(true);
      expect(payload.questions[0].student_answer).toBe('Cytoplasm');
      expect(payload.questions[0].correct_answer).toBeNull();
      expect(payload.questions[0].explanation).toBeNull();

      // Question 2
      expect(payload.questions[1].earned).toBe(4);
      expect(payload.questions[1].feedback).toBe('Great explanation, mention protons next time.');
      expect(payload.questions[1].explanation).toBeNull();
    });

    it('reveals correct answers and explanations when show_correct_answers is true', () => {
      const revealAssignment = {
        ...assignment,
        settings: { ...assignment.settings, show_correct_answers: true }
      };
      const payload = buildFeedbackPayload({ assignment: revealAssignment, submission, student, course });
      expect(payload.questions[0].correct_answer).toBe('Cytoplasm');
      expect(payload.questions[0].explanation).toBe('Glycolysis takes place in the cytosol/cytoplasm.');
      expect(payload.questions[1].explanation).toBe('Generates ATP using proton gradient.');
    });
  });

  describe('createFeedbackLink & cryptographic round trip', () => {
    it('encrypts payload with student access code and decrypts successfully', async () => {
      const res = await createFeedbackLink({ assignment, submission, student, course });
      expect(res.url).toContain('#/share?');
      expect(res.url).toContain('enc=1');
      expect(typeof res.exceedsUrlLimit).toBe('boolean');
      expect(res.length).toBeGreaterThan(100);

      const dParam = new URL(res.url).hash.split('d=')[1];
      const unpacked = await CryptoShareEngine.unpackSharePayload(
        dParam,
        true,
        normalizeAccessCode(student.access_code)
      );

      expect(unpacked.type).toBe('assignment_feedback');
      expect(unpacked.payload.student.student_id).toBe('S101');
      expect(unpacked.payload.score.earned).toBe(6);
    });

    it('rejects decryption when an incorrect passphrase is used', async () => {
      const res = await createFeedbackLink({ assignment, submission, student, course });
      const dParam = new URL(res.url).hash.split('d=')[1];

      await expect(
        CryptoShareEngine.unpackSharePayload(dParam, true, 'WRONG-PASS')
      ).rejects.toThrow('INVALID_PASSPHRASE');
    });
  });

  describe('feedbackSummary', () => {
    it('generates multi-line summary of overall and per-question comments', () => {
      const summary = feedbackSummary(assignment, submission);
      expect(summary).toContain('Excellent work overall!');
      expect(summary).toContain('Q2: Great explanation, mention protons next time.');
      expect(summary).toContain('Assignment: 6/7 pts.');
    });
  });

  describe('Export Presets row mappers', () => {
    it('builds Submissions CSV rows with and without question columns', () => {
      const withoutQ = buildSubmissionsExportRows({
        assignment,
        submissions: [submission],
        roster: [student],
        course,
        includeQuestions: false
      });

      expect(withoutQ.headers).toEqual(SUBMISSIONS_CSV_HEADERS);
      expect(withoutQ.rows).toHaveLength(1);
      expect(withoutQ.rows[0].StudentID).toBe('S101');
      expect(withoutQ.rows[0].Score).toBe(6);
      expect(withoutQ.rows[0].MaxScore).toBe(7);
      expect(withoutQ.rows[0].Percent).toBe(85.7);
      expect(withoutQ.rows[0].PendingReview).toBe('No');

      const withQ = buildSubmissionsExportRows({
        assignment,
        submissions: [submission],
        roster: [student],
        course,
        includeQuestions: true
      });

      expect(withQ.headers).toContain('Q1Points');
      expect(withQ.headers).toContain('Q2Feedback');
      expect(withQ.rows[0].Q1Points).toBe(2);
      expect(withQ.rows[0].Q2Feedback).toBe('Great explanation, mention protons next time.');
    });

    it('builds Mail-Merge CSV rows with opt-in AccessCode', () => {
      const res = buildMailMergeExportRows({
        assignment,
        submissions: [submission],
        roster: [student, { student_id: 'S102', full_name: 'Liam Chen', email: 'lchen@school.edu' }],
        course,
        feedbackLinksMap: { S101: 'https://example.org/fb-s101' },
        assignmentLinksMap: {
          S101: 'https://example.org/as-s101',
          S102: 'https://example.org/as-s102'
        },
        includeAccessCodes: true
      });

      expect(res.headers).toContain('AccessCode');
      expect(res.rows).toHaveLength(2);

      // Student 1 (submitted)
      expect(res.rows[0].StudentID).toBe('S101');
      expect(res.rows[0].Status).toBe('Submitted');
      expect(res.rows[0].Score).toBe(6);
      expect(res.rows[0].Link).toBe('https://example.org/fb-s101');
      expect(res.rows[0].AccessCode).toBe(student.access_code);

      // Student 2 (not submitted)
      expect(res.rows[1].StudentID).toBe('S102');
      expect(res.rows[1].Status).toBe('NotSubmitted');
      expect(res.rows[1].Score).toBe('');
      expect(res.rows[1].Link).toBe('');
      expect(res.rows[1].AssignmentLink).toBe('https://example.org/as-s102');
    });

    it('builds Not Submitted CSV rows', () => {
      const unsubmittedStudent = { student_id: 'S102', full_name: 'Liam Chen', email: 'lchen@school.edu' };
      const res = buildNotSubmittedExportRows({
        assignment,
        roster: [unsubmittedStudent],
        assignmentLinksMap: { S102: 'https://example.org/take-s102' }
      });

      expect(res.headers).toEqual(NOT_SUBMITTED_CSV_HEADERS);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].StudentID).toBe('S102');
      expect(res.rows[0].Link).toBe('https://example.org/take-s102');
    });
  });

  describe('PDF & ZIP generation', () => {
    it('generates a PDF document with score and feedback', () => {
      const doc = generateSubmissionPDF({ assignment, submission, student, course });
      expect(doc).toBeDefined();
      const output = doc.output('arraybuffer');
      expect(output.byteLength).toBeGreaterThan(100);
    });

    it('generates a ZIP archive containing individual PDFs', async () => {
      const zipRes = await generateFeedbackZip({
        assignment,
        submissions: [submission],
        roster: [student],
        course
      });

      expect(zipRes.count).toBe(1);
      expect(zipRes.filename).toContain('_feedback_pdfs.zip');
      expect(zipRes.blob).toBeDefined();
    });
  });
});
