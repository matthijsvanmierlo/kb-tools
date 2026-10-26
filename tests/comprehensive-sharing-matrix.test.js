import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { CryptoShareEngine } from '../src/core/crypto-share.js';
import { ContentImporter, extractShareUrlParams, extractStudentCode } from '../src/core/content-importer.js';
import { buildClickableHtmlFile, extractEnvelopeFromHtml } from '../src/core/html-launcher.js';
import { QrAssembler } from '../src/core/qr-transfer.js';
import { scanQrFromSource } from '../src/components/qr-handoff.js';
import { buildCourseFeed } from '../src/core/course-feed.js';
import { mergeCourseFeed } from '../src/modules/student/course-store.js';
import { loadCalendarEvents } from '../src/modules/calendar/model.js';

describe('Comprehensive Content Sharing Matrix', () => {
  beforeEach(async () => {
    await storage.table('flashcards').clear();
    await storage.table('assignments').clear();
    await storage.table('tasks').clear().catch(() => {});
    await storage.table('timelines').clear();
    await storage.table('video_assessments').clear();
    await storage.table('gradebook_courses').clear();
    await storage.table('course_units').clear();
    await storage.table('course_items').clear();
    await storage.table('student_courses').clear();
    await storage.table('student_items').clear();
  });

  describe('1. Share URLs & Student Code Extraction', () => {
    it('extracts URL params from standard hash-based share links', () => {
      const url = 'https://school.edu/#/share?v=2&enc=0&d=eJzT0yMA';
      const parsed = extractShareUrlParams(url);
      expect(parsed.version).toBe(2);
      expect(parsed.isEncrypted).toBe(false);
      expect(parsed.ciphertext).toBe('eJzT0yMA');
      expect(parsed.d).toBe('eJzT0yMA');
      expect(parsed.ref).toBeNull();
    });

    it('extracts URL params from encrypted and short-link share URLs', () => {
      const encUrl = 'https://school.edu/#/share?v=2&enc=1&d=ABCDEF1234';
      const encParsed = extractShareUrlParams(encUrl);
      expect(encParsed.isEncrypted).toBe(true);
      expect(encParsed.ciphertext).toBe('ABCDEF1234');

      const refUrl = 'https://school.edu/#/share?ref=xyz789&key=secretkey';
      const refParsed = extractShareUrlParams(refUrl);
      expect(refParsed.ref).toBe('xyz789');
    });

    it('extracts student class join codes from URLs and plain strings', () => {
      expect(extractStudentCode('https://school.edu/#/student?code=BIO101')).toBe('BIO101');
      expect(extractStudentCode('#/student?code=CHEM202')).toBe('CHEM202');
      expect(extractStudentCode('?code=MATH303')).toBe('MATH303');
      expect(extractStudentCode('PHYS404')).toBe('PHYS404');
      expect(extractStudentCode('not a valid code!!')).toBeNull();
    });

    it('identifies share links via ContentImporter.inspect without falling into CSV parser', () => {
      const shareUrl = 'https://school.edu/#/share?v=2&enc=0&d=eJzT0yMA';
      const res = ContentImporter.inspect(shareUrl);
      expect(res.kind).toBe('kbshare');
      expect(res.isEncrypted).toBe(false);
      expect(res.shareParams).toBeDefined();
    });
  });

  describe('2. QR Code Scans & Assembler (Fixing Flashcard Delimiter Bug)', () => {
    it('unpacks single-frame QR code payloads directly in QrAssembler', async () => {
      const assembler = new QrAssembler({ allowSingleRaw: true });
      const testUrl = 'https://school.edu/#/share?v=2&enc=0&d=eJzT0yMA';
      const result = await assembler.add(testUrl);
      expect(result.status).toBe('complete');
      expect(result.text).toBe(testUrl);
    });

    it('correctly reassembles multi-frame KBQ1: animated QR stream', async () => {
      const { encodeQrFrames } = await import('../src/core/qr-transfer.js');
      const longText = 'This is a multi-frame animated QR stream payload that spans multiple frames.';
      const frames = await encodeQrFrames(longText, { frameChars: 25 });
      expect(frames.length).toBeGreaterThan(1);

      const assembler = new QrAssembler({ allowSingleRaw: true });
      let finalResult = null;
      for (const frame of frames) {
        finalResult = await assembler.add(frame);
      }
      expect(finalResult.status).toBe('complete');
      expect(finalResult.text).toBe(longText);
    });

    it('scans and inspects QR flashcard share link without throwing delimiter errors', async () => {
      const deck = {
        title: 'Biology Unit 1',
        cards: [
          { front: 'Mitochondria', back: 'Powerhouse of the cell' },
          { front: 'Ribosome', back: 'Protein synthesis' }
        ]
      };
      const share = await CryptoShareEngine.createSharePayload('flashcards', deck, '');
      const scannedQrText = share.url; // This was what the user scanned

      // When CSVImportDialog or UniversalImportDialog receives scannedQrText:
      const inspection = ContentImporter.inspect(scannedQrText);
      expect(inspection.kind).toBe('kbshare');

      // It unpacks cleanly:
      const unpacked = await ContentImporter.unpackKbShare(scannedQrText);
      expect(unpacked.type).toBe('flashcards');
      expect(unpacked.payload.cards).toHaveLength(2);

      // And imports cleanly:
      const saved = await ContentImporter.importRecordToLibrary('flashcards', unpacked.payload);
      expect(saved.success).toBe(true);
      expect(saved.count).toBe(2);

      const dbDeck = await storage.table('flashcards').get(saved.id);
      expect(dbDeck.title).toBe('Biology Unit 1');
      expect(dbDeck.cards[0].front.text).toBe('Mitochondria');
      expect(dbDeck.cards[0].back.text).toBe('Powerhouse of the cell');
    });
  });

  describe('3. Clickable HTML Launcher Envelopes', () => {
    it('generates HTML launcher and extracts embedded .kbshare envelope', async () => {
      const deck = { title: 'French Vocab', cards: [{ front: 'Bonjour', back: 'Hello' }] };
      const share = await CryptoShareEngine.createSharePayload('flashcards', deck, '');

      const html = buildClickableHtmlFile({
        title: 'French Vocab Deck',
        payloadType: 'lesson',
        payload: share.rawFileContent,
        shareUrl: share.url
      });

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('French Vocab Deck');
      expect(html).toContain('id="kb-payload"');

      const extracted = extractEnvelopeFromHtml(html);
      expect(extracted).toBeDefined();

      const inspection = ContentImporter.inspect(html, 'french.kbshare.html');
      expect(inspection.kind).toBe('kbshare');
    });

    it('extracts student feedback and grade report launchers', async () => {
      const feedbackPayload = {
        kind: 'assignment_feedback',
        student_id: 'S101',
        course_name: 'Algebra 1',
        total_earned: 95,
        total_possible: 100
      };

      const html = buildClickableHtmlFile({
        title: 'Feedback for Alice',
        payloadType: 'feedback',
        payload: feedbackPayload,
        shareUrl: 'https://school.edu/#/feedback'
      });

      const extracted = extractEnvelopeFromHtml(html);
      expect(extracted).toBeDefined();
      expect(extracted.student_id).toBe('S101');
      expect(extracted.kind).toBe('assignment_feedback');

      const inspection = ContentImporter.inspect(html, 'alice.kbfeedback.html');
      expect(inspection.kind).toBe('feedback');
    });
  });

  describe('4. Full Content Types Library Normalization & Ingestion', () => {
    it('normalizes flashcards with strings and preserves media references', async () => {
      const rawCards = [
        { front: 'Term 1', back: 'Def 1', imageRef: 'img-uuid-1', audioRef: 'aud-uuid-1' },
        { front: { text: 'Term 2', ttsLang: 'fr-FR' }, back: { text: 'Def 2', ttsLang: 'fr-FR' } }
      ];

      const res = await ContentImporter.importRecordToLibrary('flashcards', {
        title: 'Media Flashcards',
        cards: rawCards
      });

      expect(res.success).toBe(true);
      const saved = await storage.table('flashcards').get(res.id);
      expect(saved.cards).toHaveLength(2);
      expect(saved.cards[0].front).toEqual({ text: 'Term 1', ttsLang: 'en-US' });
      expect(saved.cards[0].back).toEqual({ text: 'Def 1', ttsLang: 'en-US' });
      expect(saved.cards[0].imageRef).toBe('img-uuid-1');
      expect(saved.cards[0].audioRef).toBe('aud-uuid-1');
      expect(saved.cards[1].front.ttsLang).toBe('fr-FR');
    });

    it('imports assignment questions into assignments table', async () => {
      const assignmentPayload = {
        title: 'World War II Quiz',
        questions: [
          { type: 'single_choice', prompt: 'In which year did WWII end?', options: [{ text: '1945', is_correct: true }] }
        ]
      };

      const res = await ContentImporter.importRecordToLibrary('assignment', assignmentPayload);
      expect(res.success).toBe(true);
      expect(res.count).toBe(1);

      const saved = await storage.table('assignments').get(res.id);
      expect(saved.title).toBe('World War II Quiz');
      expect(saved.questions[0].prompt).toBe('In which year did WWII end?');
    });

    it('imports task assignments into tasks table', async () => {
      const taskPayload = {
        title: 'Shakespeare Essay',
        description: 'Analyze Hamlet soliloquy.',
        submission_types: { text: { enabled: true } },
        grading: { scoring: 'points', max_points: 100 }
      };

      const res = await ContentImporter.importRecordToLibrary('task', taskPayload);
      expect(res.success).toBe(true);
      expect(res.table).toBe('tasks');

      const saved = await storage.table('tasks').get(res.id);
      expect(saved.title).toBe('Shakespeare Essay');
      expect(saved.grading.max_points).toBe(100);
    });
  });

  describe('5. Course Feed Packaging & Student Offline Persistence', () => {
    it('packages course feed with embedded lesson payloads and syncs into student tables', async () => {
      const courseId = 'course-sci-101';
      await storage.table('gradebook_courses').put({
        id: courseId,
        name: 'Earth Science',
        section: 'Period 3',
        access_code: 'EARTH3',
        color: '#10b981'
      });

      const deckId = 'deck-rocks-1';
      await storage.table('flashcards').put({
        id: deckId,
        title: 'Rock Types',
        cards: [{ front: 'Igneous', back: 'Formed from magma' }]
      });

      const taskId = 'task-geo-lab';
      await storage.table('tasks').put({
        id: taskId,
        title: 'Mineral Identification Lab',
        submission_types: { text: { enabled: true }, drawing: { enabled: true } },
        settings: { due_date: '2026-11-15' },
        grading: { scoring: 'points', max_points: 50 },
        publish: { version: 1, salt: 'salt1' }
      });

      await storage.table('course_items').bulkPut([
        {
          id: 'item-1',
          course_id: courseId,
          title: 'Rock Types Flashcards',
          kind: 'flashcards',
          source_id: deckId,
          order: 1
        },
        {
          id: 'item-2',
          course_id: courseId,
          title: 'Mineral Identification Lab',
          kind: 'task',
          source_id: taskId,
          order: 2
        }
      ]);

      // 1. Teacher builds course feed package
      const feed = await buildCourseFeed(courseId);
      expect(feed.raw_payload.items).toHaveLength(2);
      expect(feed.raw_payload.items[0].payload).toBeDefined();
      expect(feed.raw_payload.items[1].payload.kind).toBe('kb-task');
      expect(feed.raw_payload.items[1].payload.title).toBe('Mineral Identification Lab');

      // 2. Student imports course feed package
      const merged = await mergeCourseFeed(feed.raw_payload, { accessCode: 'EARTH3' });
      expect(merged.course.name).toBe('Earth Science');

      // Verify student_items received the payload
      const studentItems = await storage.table('student_items').where('course_id').equals(courseId).toArray();
      expect(studentItems).toHaveLength(2);

      const taskItem = studentItems.find(it => it.kind === 'task');
      expect(taskItem).toBeDefined();
      expect(taskItem.payload.kind).toBe('kb-task');
      expect(taskItem.payload.submission_types.drawing.enabled).toBe(true);

      // Verify local flashcards table received the deck for offline study
      const localDeck = await storage.table('flashcards').get(deckId);
      expect(localDeck).toBeDefined();
      expect(localDeck.title).toBe('Rock Types');
      const frontVal = typeof localDeck.cards[0].front === 'object' ? localDeck.cards[0].front.text : localDeck.cards[0].front;
      expect(frontVal).toBe('Igneous');
    });

    it('aggregates task due dates into calendar events', async () => {
      const courseId = 'course-art-101';
      await storage.table('gradebook_courses').put({
        id: courseId,
        name: 'Studio Art',
        color: '#8b5cf6'
      });

      await storage.table('tasks').put({
        id: 'task-sketch-1',
        title: 'Perspective Sketch',
        class_id: courseId,
        settings: { due_date: '2026-11-20', due_time: '17:00' },
        grading: { scoring: 'points', max_points: 40 }
      });

      const events = await loadCalendarEvents();
      const taskEvent = events.find(e => e.kind === 'task' && e.title === 'Perspective Sketch');

      expect(taskEvent).toBeDefined();
      expect(taskEvent.date).toBe('2026-11-20');
      expect(taskEvent.time).toBe('17:00');
      expect(taskEvent.points).toBe(40);
      expect(taskEvent.courseName).toBe('Studio Art');
    });
  });
});
