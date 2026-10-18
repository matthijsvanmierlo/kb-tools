import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { generateUUID } from '../src/utils/uuid.js';
import { Sanitizer } from '../src/core/sanitizer.js';
import {
  FlashcardItemSchema,
  FlashcardSetSchema,
  TimelineEventSchema,
  parseCSVWithValidation,
  Exporter,
  HEADER_ALIASES
} from '../src/core/validator.js';
import { CryptoShareEngine } from '../src/core/crypto-share.js';
import { StorageManager } from '../src/core/storage.js';
import { SyncManager } from '../src/core/sync.js';
import { JSDOM } from 'jsdom';



describe('Phase 1: UUID Utility', () => {
  it('generates valid RFC-4122 v4 UUIDs', () => {
    const id1 = generateUUID();
    const id2 = generateUUID();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe('Phase 1: Sanitizer & STEM Rendering Pipeline', () => {
  it('strictly strips XSS injection tags and malicious attributes', () => {
    const dirty = '<p>Safe Text <img src="x" onerror="alert(1)" /></p><script>alert("hack")</script>';
    const clean = Sanitizer.sanitize(dirty);
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('<script>');
    expect(clean).toContain('Safe Text');
  });

  it('renders STEM markdown while preserving math underscores and asterisks', () => {
    const input = 'Here is chemical equation $$H_2 + O_2 \\to H_2O$$ and inline $E = mc^2$ with **bold** text.';
    const result = Sanitizer.renderSTEMMarkdown(input);

    expect(result).toContain('<strong>bold</strong>');
    // Verify math was tokenized and rendered without marked turning H_2 into italics
    expect(result).not.toContain('<em>2</em>');
    expect(result).toContain('H_2');
  });
});

describe('Phase 1: Schema Validation, CSV Normalization & Exporter', () => {
  it('validates a valid FlashcardSet schema', () => {
    const validSet = {
      version: 1,
      id: generateUUID(),
      title: 'Biology 101',
      cards: [
        {
          id: generateUUID(),
          type: 'text',
          front: { text: 'What is photosynthesis?', ttsLang: 'en-US' },
          back: { text: 'Process by which plants convert sunlight into chemical energy.', ttsLang: 'en-US' }
        }
      ]
    };
    const res = FlashcardSetSchema.safeParse(validSet);
    expect(res.success).toBe(true);
  });

  it('rejects invalid flashcard item missing front text', () => {
    const invalidCard = {
      id: generateUUID(),
      type: 'invalid_type',
      front: { ttsLang: 'en-US' },
      back: { text: 'Back' }
    };
    const res = FlashcardItemSchema.safeParse(invalidCard);
    expect(res.success).toBe(false);
  });

  it('normalizes CSV headers using HEADER_ALIASES and returns structured data', () => {
    const csvContent = `Question,Answer\nWhat is H2O?,Water\nWhat is NaCl?,Table Salt`;
    const result = parseCSVWithValidation(csvContent, FlashcardItemSchema);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data[0].front.text).toBe('What is H2O?');
    expect(result.data[0].back.text).toBe('Water');
  });

  it('aborts atomically and reports line-level errors on corrupt CSV', () => {
    // start_date is required in TimelineEventSchema; second row has empty title
    const corruptCSV = `title,start_date,color\nEvent 1,2026-01-01,#ff0000\n,2026-02-02,#00ff00`;
    const result = parseCSVWithValidation(corruptCSV, TimelineEventSchema);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].rowNumber).toBe(3); // Line 3 has empty title
  });

  it('exports datasets to CSV, JSON, and Markdown format', () => {
    const testData = [
      {
        id: generateUUID(),
        front: { text: 'Hello', ttsLang: 'en-US' },
        back: { text: 'World', ttsLang: 'en-US' }
      }
    ];

    const csv = Exporter.toCSV(testData);
    expect(csv).toContain('question');
    expect(csv).toContain('Hello');

    const json = Exporter.toJSON(testData, 1);
    expect(json).toContain('"version": 1');

    const md = Exporter.toMarkdown(testData, 'flashcards');
    expect(md).toContain('| Front (Question) | Back (Answer) |');
    expect(md).toContain('Hello');
  });
});

describe('Phase 1: Cryptographic Sharing (CryptoShareEngine)', () => {
  it('encrypts and decrypts payload using PBKDF2 + AES-GCM', async () => {
    const payload = {
      title: 'Secret Geometry Quiz',
      questions: ['Find area of circle r=5']
    };
    const passphrase = 'UltraSecurePassword123!';

    const share = await CryptoShareEngine.createSharePayload('flashcards', payload, passphrase);
    expect(share.url).toContain('enc=1');
    expect(share.url).toContain('&d=');

    // Extract d parameter from URL
    const dParam = new URL(share.url).hash.split('d=')[1];

    // Unpack with correct passphrase
    const decrypted = await CryptoShareEngine.unpackSharePayload(dParam, true, passphrase);
    expect(decrypted.payload.title).toBe(payload.title);
    expect(decrypted.type).toBe('flashcards');

    // Unpack with incorrect passphrase throws INVALID_PASSPHRASE
    await expect(
      CryptoShareEngine.unpackSharePayload(dParam, true, 'WrongPassword!')
    ).rejects.toThrow('INVALID_PASSPHRASE');
  });

  it('supports unencrypted sharing without passphrase', async () => {
    const payload = { title: 'Public Timeline', events: [] };
    const share = await CryptoShareEngine.createSharePayload('timeline', payload, '');
    expect(share.url).toContain('enc=0');

    const dParam = new URL(share.url).hash.split('d=')[1];
    const unpacked = await CryptoShareEngine.unpackSharePayload(dParam, false);
    expect(unpacked.payload.title).toBe(payload.title);
  });

  it('detects when URL length exceeds safe 2,048 character limit', async () => {
    // Generate diverse non-repeating data that will exceed 2048 chars even after compression
    const largeObject = {
      notes: Array.from({ length: 150 }, () => generateUUID()).join(' ')
    };
    const share = await CryptoShareEngine.createSharePayload('flashcards', largeObject, '');
    expect(share.exceedsUrlLimit).toBe(true);
    expect(share.length).toBeGreaterThan(2048);
    expect(share.rawFileContent).toBeDefined();
  });
});

describe('Phase 1: StorageManager & Snapshot Dump/Restore', () => {
  let storageManager;

  beforeEach(() => {
    storageManager = new StorageManager();
  });

  it('initializes and saves records in tables', async () => {
    await storageManager.init();
    const flashcardsTable = storageManager.table('flashcards');

    const testDeck = {
      id: generateUUID(),
      title: 'Chemistry Deck',
      updated_at: new Date().toISOString()
    };

    await flashcardsTable.put(testDeck);
    const retrieved = await flashcardsTable.get(testDeck.id);
    expect(retrieved).toBeDefined();
    expect(retrieved.title).toBe('Chemistry Deck');
  });

  it('dumps and restores master snapshots accurately', async () => {
    await storageManager.init();
    const flashcardsTable = storageManager.table('flashcards');

    const testDeck = { id: generateUUID(), title: 'Deck 1', updated_at: new Date().toISOString() };
    await flashcardsTable.put(testDeck);

    const snapshot = await storageManager.dumpMasterSnapshot();
    expect(snapshot.version).toBe(2);
    expect(snapshot.data.flashcards.length).toBeGreaterThan(0);

    // Clear and restore
    await flashcardsTable.clear();
    const emptyCheck = await flashcardsTable.toArray();
    expect(emptyCheck.length).toBe(0);

    await storageManager.restoreMasterSnapshot(snapshot);
    const restored = await flashcardsTable.toArray();
    expect(restored.length).toBeGreaterThan(0);
    expect(restored.find(d => d.id === testDeck.id)).toBeDefined();
  });
});

describe('Phase 1: SyncManager & Debounced Auto-Sync', () => {
  it('detects stale backup when last export exceeds 72 hours (259200000 ms)', async () => {
    const storageManager = new StorageManager();
    await storageManager.init();

    const fourDaysAgo = Date.now() - 4 * 86400000;
    await storageManager.setMetadata('last_manual_export_timestamp', fourDaysAgo);

    const syncManager = new SyncManager(storageManager);
    const renderSpy = vi.spyOn(syncManager, '_renderStaleBackupModal').mockImplementation(() => {});

    await syncManager.checkStaleBackup();
    expect(renderSpy).toHaveBeenCalled();
  });
});
