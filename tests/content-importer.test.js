import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { CryptoShareEngine } from '../src/core/crypto-share.js';
import { ContentImporter, ContentImportError } from '../src/core/content-importer.js';

describe('ContentImporter Core Ingestion Engine', () => {
  beforeEach(async () => {
    await storage.table('flashcards').clear();
    await storage.table('assignments').clear();
    await storage.table('timelines').clear();
    await storage.table('video_assessments').clear();
  });

  it('inspects unencrypted .kbshare files correctly', async () => {
    const deck = {
      title: 'Spanish Vocabulary',
      cards: [
        { front: 'Hola', back: 'Hello' },
        { front: 'Adios', back: 'Goodbye' }
      ]
    };
    const share = await CryptoShareEngine.createSharePayload('flashcards', deck, '');
    const inspectRes = ContentImporter.inspect(share.rawFileContent, 'spanish.kbshare');

    expect(inspectRes.kind).toBe('kbshare');
    expect(inspectRes.isEncrypted).toBe(false);
  });

  it('inspects encrypted .kbshare files correctly', async () => {
    const deck = {
      title: 'Secret Biology Deck',
      cards: [{ front: 'Mitochondria', back: 'Powerhouse of cell' }]
    };
    const share = await CryptoShareEngine.createSharePayload('flashcards', deck, 'secret-pass-123');
    const inspectRes = ContentImporter.inspect(share.rawFileContent, 'biology.kbshare');

    expect(inspectRes.kind).toBe('kbshare');
    expect(inspectRes.isEncrypted).toBe(true);
  });

  it('unpacks unencrypted .kbshare deck and preserves contents', async () => {
    const deck = {
      title: 'French 101',
      cards: [
        { front: 'Bonjour', back: 'Good day' },
        { front: 'Merci', back: 'Thank you' }
      ]
    };
    const share = await CryptoShareEngine.createSharePayload('flashcards', deck, '');
    const unpacked = await ContentImporter.unpackKbShare(share.rawFileContent);

    expect(unpacked.type).toBe('flashcards');
    expect(unpacked.payload.title).toBe('French 101');
    expect(unpacked.payload.cards).toHaveLength(2);
    expect(unpacked.payload.cards[0].front).toBe('Bonjour');
  });

  it('unpacks encrypted .kbshare with correct passphrase', async () => {
    const deck = {
      title: 'Calculus Formulas',
      cards: [{ front: 'd/dx sin(x)', back: 'cos(x)' }]
    };
    const pass = 'math1234';
    const share = await CryptoShareEngine.createSharePayload('flashcards', deck, pass);

    // Fails without password
    await expect(ContentImporter.unpackKbShare(share.rawFileContent, ''))
      .rejects.toThrow(ContentImportError);

    // Fails with wrong password
    await expect(ContentImporter.unpackKbShare(share.rawFileContent, 'wrong-pass'))
      .rejects.toThrow(ContentImportError);

    // Succeeds with correct password
    const unpacked = await ContentImporter.unpackKbShare(share.rawFileContent, pass);
    expect(unpacked.type).toBe('flashcards');
    expect(unpacked.payload.title).toBe('Calculus Formulas');
    expect(unpacked.payload.cards).toHaveLength(1);
  });

  it('imports an unpacked flashcard deck into the flashcards table', async () => {
    const payload = {
      title: 'Geography Trivia',
      cards: [
        { front: 'Capital of France?', back: 'Paris' },
        { front: 'Capital of Japan?', back: 'Tokyo' }
      ]
    };

    const res = await ContentImporter.importRecordToLibrary('flashcards', payload, {
      classId: 'class-99',
      filename: 'geography.kbshare'
    });

    expect(res.success).toBe(true);
    expect(res.table).toBe('flashcards');
    expect(res.count).toBe(2);

    // Verify persisted in Dexie
    const inDb = await storage.table('flashcards').get(res.id);
    expect(inDb).toBeDefined();
    expect(inDb.title).toBe('Geography Trivia');
    expect(inDb.class_id).toBe('class-99');
    expect(inDb.cards).toHaveLength(2);
    expect(inDb.cards[0].front.text).toBe('Capital of France?');
    expect(inDb.cards[0].fsrs).toBeDefined();
  });

  it('imports an assignment payload into the assignments table', async () => {
    const payload = {
      title: 'Pop Quiz #1',
      questions: [
        { title: 'Question 1', prompt: 'What is 2+2?', type: 'short_answer', points: 5 }
      ]
    };

    const res = await ContentImporter.importRecordToLibrary('assignment', payload, {
      filename: 'pop_quiz.kbshare'
    });

    expect(res.success).toBe(true);
    expect(res.table).toBe('assignments');
    expect(res.count).toBe(1);

    const inDb = await storage.table('assignments').get(res.id);
    expect(inDb).toBeDefined();
    expect(inDb.title).toBe('Pop Quiz #1');
    expect(inDb.questions).toHaveLength(1);
  });

  it('merges new cards into an active flashcard deck', () => {
    const deck = {
      id: 'deck-1',
      title: 'Existing Deck',
      cards: [{ id: 'c1', front: { text: 'Q1' }, back: { text: 'A1' } }]
    };

    const count = ContentImporter.mergeCardsIntoDeck(deck, [
      { front: 'Q2', back: 'A2' },
      { front: 'Q3', back: 'A3' }
    ]);

    expect(count).toBe(2);
    expect(deck.cards).toHaveLength(3);
    expect(deck.cards[1].front.text).toBe('Q2');
    expect(deck.cards[2].front.text).toBe('Q3');
  });

  it('replaces single empty placeholder card when importing cards', () => {
    const deck = {
      id: 'deck-empty',
      title: 'Empty Deck',
      cards: [{ id: 'placeholder', front: { text: '' }, back: { text: '' } }]
    };

    const count = ContentImporter.mergeCardsIntoDeck(deck, [
      { front: 'Actual Q', back: 'Actual A' }
    ]);

    expect(count).toBe(1);
    expect(deck.cards).toHaveLength(1);
    expect(deck.cards[0].front.text).toBe('Actual Q');
  });
});
