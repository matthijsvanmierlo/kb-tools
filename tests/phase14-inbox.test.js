import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import jszipLib from 'jszip';
import { classifyText, expandFiles } from '../src/core/envelope-router.js';
import { importSubmissionTexts } from '../src/modules/assignments/import.js';
import { extractShareParams } from '../src/router.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { generateAccessCode } from '../src/core/access-codes.js';
import { buildStudentPayload } from '../src/modules/assignments/grading.js';
import { createSubmission } from '../src/modules/assignments/pipeline.js';
import { buildStudentVideoPayload, createSecureReceipt } from '../src/modules/video/secure.js';
import { KioskReportEngine } from '../src/modules/video/kiosk-report.js';
import { HandinInstructions } from '../src/components/handin-instructions.js';
import { storage } from '../src/core/storage.js';

const JSZip = jszipLib.default || jszipLib;

describe('Phase 14: Inbox & Envelope Router', () => {
  let teacherKeys;
  const assignment = {
    id: 'as-inbox-1',
    title: 'Cell Biology Quiz',
    questions: [
      { id: 'q1', type: 'single_choice', points: 5, options: [{ id: 'a', text: 'Mitochondria', is_correct: true }, { id: 'b', text: 'Nucleus', is_correct: false }] }
    ],
    settings: { feedback_mode: 'immediate', due_date: '2026-10-15' },
    publish: { version: 1, salt: 'salt-bio-1' }
  };

  const videoAssessment = {
    id: 'vid-inbox-1',
    title: 'Intro to Photosynthesis',
    class_id: 'course-1',
    provider: 'html5',
    video_source: 'https://example.org/photo.mp4',
    checkpoints: [
      { id: 'c1', type: 'single_choice', timestamp_sec: 10, prompt_markdown: 'What color is chlorophyll?', points: 2,
        options: [{ id: 'a', text: 'Green', is_correct: true }, { id: 'b', text: 'Red', is_correct: false }] }
    ]
  };

  beforeEach(async () => {
    await storage.init();
    await storage.table('assignment_submissions').clear();
    await storage.table('app_metadata').clear();
    teacherKeys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
  });

  describe('classifyText', () => {
    it('classifies assignment submissions (KBSUB envelope)', async () => {
      const code = generateAccessCode();
      const payload = await buildStudentPayload(assignment, { teacherKeys });
      const { text } = await createSubmission({
        payload,
        studentId: 's101',
        studentName: 'Alice',
        accessCode: code,
        answers: { q1: 'a' }
      });

      const res = classifyText(text);
      expect(res.kind).toBe('assignment');
      expect(res.assignment_id).toBe('as-inbox-1');
      expect(res.publish_version).toBe(1);
      expect(res.text).toBe(text);
    });

    it('classifies secure video receipts', async () => {
      const payload = await buildStudentVideoPayload(videoAssessment, { teacherKeys });
      const { text } = await createSecureReceipt({
        payload,
        studentName: 'Bob',
        studentId: 's102',
        accessCode: generateAccessCode(),
        responseLogs: [{ checkpointId: 'c1', studentAnswer: ['a'], earnedPoints: 2, latencyMs: 50 }]
      });

      const res = classifyText(text);
      expect(res.kind).toBe('video_receipt');
      expect(res.assessment_id).toBe('vid-inbox-1');
      expect(res.text).toBe(text);
    });

    it('classifies legacy video receipts', async () => {
      const { kbrString } = await KioskReportEngine.generateReceipt('Charlie', 'vid-legacy-1', 'Legacy Title', [], 10, 10);
      const res = classifyText(kbrString);
      expect(res.kind).toBe('legacy_receipt');
      expect(res.assessment_id).toBe('vid-legacy-1');
    });

    it('classifies shared lessons (kbshare)', () => {
      const share1 = JSON.stringify({ d: 'lz-compressed-deck-data' });
      const res1 = classifyText(share1);
      expect(res1.kind).toBe('kbshare');

      const share2 = JSON.stringify({ type: 'flashcards', payload: { title: 'Cards' } });
      const res2 = classifyText(share2);
      expect(res2.kind).toBe('kbshare');
    });

    it('classifies unknown and empty texts', () => {
      expect(classifyText('').kind).toBe('unknown');
      expect(classifyText(null).kind).toBe('unknown');
      expect(classifyText('Random plain text here').kind).toBe('unknown');
      expect(classifyText('{"foo": "bar"}').kind).toBe('unknown');
    });
  });

  describe('expandFiles', () => {
    it('recursively unpacks zip archives and ignores __MACOSX / hidden files', async () => {
      const code1 = 'KBSUB1.payload-one';
      const code2 = 'KBSUB1.payload-two';
      const code3 = 'KBSUB1.payload-three';

      // Inner zip containing code3
      const innerZip = new JSZip();
      innerZip.file('nested_submission.kbsub', code3);
      const innerZipBuf = await innerZip.generateAsync({ type: 'arraybuffer' });

      // Outer zip
      const outerZip = new JSZip();
      outerZip.file('sub1.kbsub', code1);
      outerZip.file('subfolder/receipt.kbr', '{"receipt":{"quizId":"q1"},"signature":"sig"}');
      outerZip.file('multi_codes.txt', `${code1}\n${code2}`);
      outerZip.file('__MACOSX/._sub1.kbsub', 'junk');
      outerZip.file('.DS_Store', 'junk');
      outerZip.file('.hidden/ignored.kbsub', 'junk');
      outerZip.file('inner.zip', innerZipBuf);
      outerZip.file('image.png', new Uint8Array([1, 2, 3])); // Non-allowed extension

      const outerZipBuf = await outerZip.generateAsync({ type: 'arraybuffer' });

      const files = [
        { name: 'bulk_upload.zip', data: outerZipBuf }
      ];

      const expanded = await expandFiles(files);
      expect(expanded.length).toBe(5); // sub1, receipt, multi #1, multi #2, inner
      const texts = expanded.map(e => e.text);
      expect(texts).toContain(code1);
      expect(texts).toContain(code2);
      expect(texts).toContain(code3);
      expect(texts).toContain('{"receipt":{"quizId":"q1"},"signature":"sig"}');
      expect(texts.includes('junk')).toBe(false);
    });

    it('expands direct file objects and splits multiple codes', async () => {
      const multi = 'KBSUB1.abc\nKBSUB1.def';
      const files = [
        { name: 'pasted.txt', text: multi },
        { name: 'single.kbsub', text: 'KBSUB1.single' }
      ];

      const res = await expandFiles(files);
      expect(res.length).toBe(3);
      expect(res[0].source).toBe('pasted.txt (#1)');
      expect(res[0].text).toBe('KBSUB1.abc');
      expect(res[1].source).toBe('pasted.txt (#2)');
      expect(res[1].text).toBe('KBSUB1.def');
      expect(res[2].source).toBe('single.kbsub');
      expect(res[2].text).toBe('KBSUB1.single');
    });
  });

  describe('importSubmissionTexts', () => {
    it('imports submissions and manages is_latest correctly', async () => {
      const codeAlice = generateAccessCode();
      const roster = [
        { student_id: 'S101', full_name: 'Alice Smith', access_code: codeAlice }
      ];
      const payload = await buildStudentPayload(assignment, {
        teacherKeys,
        rosterChecks: { S101: await SubmissionCrypto.accessCodeCheck(assignment.id, 'S101', codeAlice) }
      });

      // Alice's first submission (earlier)
      const sub1 = await createSubmission({
        payload,
        studentId: 's101',
        studentName: 'Alice Smith',
        accessCode: codeAlice,
        answers: { q1: 'b' } // incorrect
      });

      const res1 = await importSubmissionTexts({
        assignment,
        texts: [{ source: 'alice_try1.kbsub', text: sub1.text }],
        roster,
        keys: teacherKeys
      });

      expect(res1.added).toBe(1);
      expect(res1.duplicates).toBe(0);
      expect(res1.errors.length).toBe(0);

      const inDb1 = await storage.table('assignment_submissions').where('assignment_id').equals(assignment.id).toArray();
      expect(inDb1.length).toBe(1);
      expect(inDb1[0].is_latest).toBe(true);
      expect(inDb1[0].auto.earned).toBe(0);

      // Attempting to import the exact same text again should count as duplicate
      const resDupe = await importSubmissionTexts({
        assignment,
        texts: [sub1.text],
        roster,
        keys: teacherKeys
      });
      expect(resDupe.duplicates).toBe(1);
      expect(resDupe.added).toBe(0);

      // Wait 10ms to ensure a later submitted_at
      await new Promise(r => setTimeout(r, 15));

      // Alice's second submission (later, correct)
      const sub2 = await createSubmission({
        payload,
        studentId: 's101',
        studentName: 'Alice Smith',
        accessCode: codeAlice,
        answers: { q1: 'a' } // correct
      });

      const res2 = await importSubmissionTexts({
        assignment,
        texts: [sub2.text],
        roster,
        keys: teacherKeys
      });

      expect(res2.added).toBe(1);

      const inDb2 = await storage.table('assignment_submissions').where('assignment_id').equals(assignment.id).toArray();
      expect(inDb2.length).toBe(2);

      const first = inDb2.find(s => s.submitted_at === sub1.body.submitted_at);
      const second = inDb2.find(s => s.submitted_at === sub2.body.submitted_at);
      expect(first.is_latest).toBe(false);
      expect(second.is_latest).toBe(true);
      expect(second.auto.earned).toBe(5);
    });
  });

  describe('extractShareParams', () => {
    it('extracts sid and sname when present', () => {
      const res = extractShareParams({ sid: 's-42', sname: 'Grace Hopper', extra: 'ignored' });
      expect(res).toEqual({ sid: 's-42', sname: 'Grace Hopper' });
    });

    it('returns nulls when missing or empty', () => {
      expect(extractShareParams({})).toEqual({ sid: null, sname: null });
      expect(extractShareParams({ sid: '', sname: '' })).toEqual({ sid: null, sname: null });
      expect(extractShareParams(null)).toEqual({ sid: null, sname: null });
    });
  });

  describe('HandinInstructions', () => {
    it('generates markdown template with or without teacher email', () => {
      const t1 = HandinInstructions.getTemplate({
        title: 'Midterm Exam',
        dueDate: '2026-11-01',
        link: 'https://example.org/#/share?d=xyz',
        teacherEmail: 'teacher@school.edu'
      });
      expect(t1).toContain('Midterm Exam — due 2026-11-01');
      expect(t1).toContain('https://example.org/#/share?d=xyz');
      expect(t1).toContain('or email it to teacher@school.edu');
      expect(t1).toContain('Download submission file');

      const t2 = HandinInstructions.getTemplate({
        title: 'Pop Quiz',
        dueDate: 'today',
        link: 'https://example.org/quiz'
      });
      expect(t2).not.toContain('email it to');
    });
  });
});
