import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { CryptoShareEngine } from '../src/core/crypto-share.js';
import { ContentImporter, ContentImportError } from '../src/core/content-importer.js';
import { FlashcardEditor } from '../src/modules/flashcards/editor.js';

describe('Universal Content Import & .kbshare Integration', () => {
  beforeEach(async () => {
    await storage.table('flashcards').clear();
    await storage.table('assignments').clear();
    await storage.table('tasks').clear().catch(() => {});
    await storage.table('timelines').clear();
    await storage.table('video_assessments').clear();
    document.body.innerHTML = '';
  });

  describe('Content Inspection & Classification', () => {
    it('accurately identifies unencrypted .kbshare lesson files', async () => {
      const share = await CryptoShareEngine.createSharePayload('flashcards', {
        title: 'Photosynthesis Cards',
        cards: [{ front: 'Light reaction', back: 'Thylakoid membrane' }]
      });

      const res = ContentImporter.inspect(share.rawFileContent, 'lesson.kbshare');
      expect(res.kind).toBe('kbshare');
      expect(res.isEncrypted).toBe(false);
    });

    it('accurately identifies encrypted .kbshare lesson files', async () => {
      const share = await CryptoShareEngine.createSharePayload('flashcards', {
        title: 'Secret Exam Decks',
        cards: [{ front: 'Question 1', back: 'Answer 1' }]
      }, 'passphrase123');

      const res = ContentImporter.inspect(share.rawFileContent, 'exam.kbshare');
      expect(res.kind).toBe('kbshare');
      expect(res.isEncrypted).toBe(true);
    });

    it('identifies student submission KBSUB1 files', () => {
      const text = 'KBSUB1.eyJrbWciOiJzdWIiLCJ2IjoxfQ';
      const res = ContentImporter.inspect(text, 'student_work.kbsub');
      expect(res.kind).toBe('kbsub');
    });

    it('identifies CSV files with delimited text', () => {
      const text = 'Question,Answer\nWhat is H2O?,Water\nWhat is CO2?,Carbon Dioxide';
      const res = ContentImporter.inspect(text, 'chemistry.csv');
      expect(res.kind).toBe('csv');
    });
  });

  describe('Flashcard Deck Import & Storage Persistence', () => {
    it('unpacks and persists a .kbshare flashcard deck into Dexie database', async () => {
      const sourceDeck = {
        title: 'World Capitals',
        description: 'Capitals of 3 European countries',
        cards: [
          { front: 'Germany', back: 'Berlin' },
          { front: 'Italy', back: 'Rome' },
          { front: 'Spain', back: 'Madrid' }
        ]
      };

      const share = await CryptoShareEngine.createSharePayload('flashcards', sourceDeck, '');
      const unpacked = await ContentImporter.unpackKbShare(share.rawFileContent);

      const importResult = await ContentImporter.importRecordToLibrary('flashcards', unpacked.payload, {
        classId: 'class-euro',
        filename: 'capitals.kbshare'
      });

      expect(importResult.success).toBe(true);
      expect(importResult.type).toBe('flashcards');
      expect(importResult.count).toBe(3);
      expect(importResult.title).toBe('World Capitals');

      const savedDeck = await storage.table('flashcards').get(importResult.id);
      expect(savedDeck).toBeDefined();
      expect(savedDeck.title).toBe('World Capitals');
      expect(savedDeck.class_id).toBe('class-euro');
      expect(savedDeck.cards).toHaveLength(3);
      expect(savedDeck.cards[0].front.text).toBe('Germany');
      expect(savedDeck.cards[0].back.text).toBe('Berlin');
      expect(savedDeck.cards[0].fsrs).toBeDefined();
      expect(savedDeck.cards[0].fsrs.state).toBe(0);
    });

    it('successfully unpacks and imports AES-256 encrypted .kbshare deck', async () => {
      const sourceDeck = {
        title: 'Encrypted Organic Chemistry',
        cards: [{ front: 'Benzene ring', back: 'C6H6 planar aromatic' }]
      };
      const pass = 'chemistry-2026';

      const share = await CryptoShareEngine.createSharePayload('flashcards', sourceDeck, pass);

      // Verify wrong pass throws error
      await expect(ContentImporter.unpackKbShare(share.rawFileContent, 'bad-password'))
        .rejects.toThrow(ContentImportError);

      // Verify correct pass succeeds
      const unpacked = await ContentImporter.unpackKbShare(share.rawFileContent, pass);
      expect(unpacked.type).toBe('flashcards');

      const importResult = await ContentImporter.importRecordToLibrary('flashcards', unpacked.payload, {
        filename: 'org_chem.kbshare'
      });

      expect(importResult.success).toBe(true);
      const inDb = await storage.table('flashcards').get(importResult.id);
      expect(inDb).toBeDefined();
      expect(inDb.title).toBe('Encrypted Organic Chemistry');
      expect(inDb.cards[0].front.text).toBe('Benzene ring');
    });
  });

  describe('Editor Ingest & Card Merging', () => {
    it('appends cards from .kbshare into an active editor deck', () => {
      const activeDeck = {
        id: 'deck-existing',
        title: 'Dutch History',
        cards: [
          { id: 'c1', front: { text: '1568' }, back: { text: 'Eighty Years War begins' } }
        ]
      };

      const newCardsFromKbShare = [
        { front: '1648', back: 'Peace of Muenster' },
        { front: '1672', back: 'Disaster Year (Rampjaar)' }
      ];

      const count = ContentImporter.mergeCardsIntoDeck(activeDeck, newCardsFromKbShare);
      expect(count).toBe(2);
      expect(activeDeck.cards).toHaveLength(3);
      expect(activeDeck.cards[1].front.text).toBe('1648');
      expect(activeDeck.cards[2].front.text).toBe('1672');
    });

    it('replaces initial blank placeholder card when importing into brand new deck', () => {
      const freshDeck = {
        id: 'deck-new',
        title: 'Untitled Flashcard Deck',
        cards: [
          { id: 'c-blank', front: { text: '' }, back: { text: '' } }
        ]
      };

      const importedCards = [
        { front: 'Question A', back: 'Answer A' },
        { front: 'Question B', back: 'Answer B' }
      ];

      const count = ContentImporter.mergeCardsIntoDeck(freshDeck, importedCards);
      expect(count).toBe(2);
      expect(freshDeck.cards).toHaveLength(2);
      expect(freshDeck.cards[0].front.text).toBe('Question A');
    });
  });

  describe('Cross-Module Universal Ingest', () => {
    it('imports an Assignment / Tasks .kbshare file into assignments table', async () => {
      const assignmentPayload = {
        title: 'Physics Mechanics Quiz',
        questions: [
          { title: 'Force Calculation', prompt: 'Calculate F = m * a', points: 10, type: 'short_answer' },
          { title: 'Units of Work', prompt: 'What is the SI unit of work?', points: 5, type: 'multiple_choice' }
        ]
      };

      const share = await CryptoShareEngine.createSharePayload('assignment', assignmentPayload, '');
      const unpacked = await ContentImporter.unpackKbShare(share.rawFileContent);

      const res = await ContentImporter.importRecordToLibrary('assignment', unpacked.payload, {
        classId: 'class-physics'
      });

      expect(res.success).toBe(true);
      expect(res.table).toBe('assignments');
      expect(res.count).toBe(2);

      const inDb = await storage.table('assignments').get(res.id);
      expect(inDb).toBeDefined();
      expect(inDb.title).toBe('Physics Mechanics Quiz');
      expect(inDb.class_id).toBe('class-physics');
      expect(inDb.questions).toHaveLength(2);
    });

    it('imports a Timeline .kbshare file into timelines table', async () => {
      const timelinePayload = {
        title: 'Space Exploration Timeline',
        events: [
          { title: 'Sputnik 1', start_date: '1957-10-04', description: 'First artificial Earth satellite' },
          { title: 'Apollo 11', start_date: '1969-07-20', description: 'First humans land on the Moon' }
        ]
      };

      const share = await CryptoShareEngine.createSharePayload('timeline', timelinePayload, '');
      const unpacked = await ContentImporter.unpackKbShare(share.rawFileContent);

      const res = await ContentImporter.importRecordToLibrary('timeline', unpacked.payload);

      expect(res.success).toBe(true);
      expect(res.table).toBe('timelines');
      expect(res.count).toBe(2);

      const inDb = await storage.table('timelines').get(res.id);
      expect(inDb).toBeDefined();
      expect(inDb.title).toBe('Space Exploration Timeline');
      expect(inDb.events).toHaveLength(2);
    });

    it('imports a Video Assessment .kbshare file into video_assessments table', async () => {
      const videoPayload = {
        title: 'Plate Tectonics Interactive Video',
        video_url: 'https://www.youtube.com/watch?v=example',
        provider: 'youtube',
        checkpoints: [
          { timestamp_sec: 45, question: 'What is subduction?', points: 5 },
          { timestamp_sec: 120, question: 'Name the major tectonic plates.', points: 10 }
        ]
      };

      const share = await CryptoShareEngine.createSharePayload('video', videoPayload, '');
      const unpacked = await ContentImporter.unpackKbShare(share.rawFileContent);

      const res = await ContentImporter.importRecordToLibrary('video', unpacked.payload);

      expect(res.success).toBe(true);
      expect(res.table).toBe('video_assessments');
      expect(res.count).toBe(2);

      const inDb = await storage.table('video_assessments').get(res.id);
      expect(inDb).toBeDefined();
      expect(inDb.title).toBe('Plate Tectonics Interactive Video');
      expect(inDb.checkpoints).toHaveLength(2);
    });

    it('unpacks and persists a .kbshare task (assignment) into Dexie database', async () => {
      const taskPayload = {
        title: 'Creative Writing Assignment',
        description: 'Write a short story about a forgotten lighthouse.',
        submission_types: { text: { enabled: true }, drawing: { enabled: true } },
        grading: { scoring: 'points', max_points: 50 }
      };

      const share = await CryptoShareEngine.createSharePayload('task', taskPayload, '');
      const unpacked = await ContentImporter.unpackKbShare(share.rawFileContent);

      const res = await ContentImporter.importRecordToLibrary('task', unpacked.payload);

      expect(res.success).toBe(true);
      expect(res.table).toBe('tasks');

      const inDb = await storage.table('tasks').get(res.id);
      expect(inDb).toBeDefined();
      expect(inDb.title).toBe('Creative Writing Assignment');
      expect(inDb.submission_types.text.enabled).toBe(true);
      expect(inDb.grading.max_points).toBe(50);
    });
  });

  describe('Security & Sanitization', () => {
    it('escapes malicious HTML in imported title and card text', async () => {
      const maliciousDeck = {
        title: '<script>alert("hacked")</script>Innocent Title',
        cards: [
          { front: '<img src=x onerror=alert(1)>Front', back: '<b onmouseover=evil()>Back</b>' }
        ]
      };

      const share = await CryptoShareEngine.createSharePayload('flashcards', maliciousDeck, '');
      const unpacked = await ContentImporter.unpackKbShare(share.rawFileContent);
      const res = await ContentImporter.importRecordToLibrary('flashcards', unpacked.payload);

      const inDb = await storage.table('flashcards').get(res.id);
      expect(inDb.title).not.toContain('<script>');
      expect(inDb.title).toContain('&lt;script&gt;');
    });

    it('generates new cryptographically isolated IDs so local records are never clobbered', async () => {
      const fixedId = '00000000-0000-0000-0000-000000000000';
      const deckA = {
        id: fixedId,
        title: 'Original Deck',
        cards: [{ id: 'card-1', front: 'Q1', back: 'A1' }]
      };

      const resA = await ContentImporter.importRecordToLibrary('flashcards', deckA);
      const resB = await ContentImporter.importRecordToLibrary('flashcards', deckA);

      expect(resA.id).not.toBe(fixedId);
      expect(resB.id).not.toBe(fixedId);
      expect(resA.id).not.toBe(resB.id);

      const allDecks = await storage.table('flashcards').toArray();
      expect(allDecks).toHaveLength(2);
    });
  });
});
