import 'fake-indexeddb/auto';
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRelayServer } from '../server/relay/index.js';
import { hashToken } from '../server/relay/auth.js';
import {
  RelayTransport,
  NullTransport,
  isTeacherRelayConfigured,
  getStudentRelayUrl,
  isCdnUploadConfigured,
  setTransportConfig
} from '../src/core/transport.js';
import { deriveCourseFeedId } from '../src/core/course-feed.js';
import { mergeCourseFeed, getStudentCourse } from '../src/modules/student/course-store.js';
import { resolveMediaSrc, uploadMediaToCdn, inlineDeckMedia } from '../src/utils/media.js';
import { reconcileDraftAnswers } from '../src/modules/assignments/take.js';
import { storage } from '../src/core/storage.js';

describe('Phase 36: Relay Sync UX, Deterministic Feeds, and CDN Media Offloading', () => {
  let relayInstance = null;
  let relayUrl = '';
  const teacherId = 'T-TEST';
  const teacherToken = 'tok_test_12345678901234567890123456789012';

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await storage.init();
    for (const t of ['student_courses', 'student_items', 'flashcards', 'timelines', 'video_assessments', 'gradebook_courses', 'course_units', 'course_items']) {
      await storage.table(t).clear().catch(() => {});
    }
  });

  afterEach(async () => {
    if (relayInstance) {
      await relayInstance.close();
      relayInstance = null;
    }
  });

  describe('1. Deterministic Course Feed Addressing', () => {
    it('derives identical 24-hex feed ID for uppercase and lowercase spaced codes', async () => {
      const id1 = await deriveCourseFeedId('k7m2qx');
      const id2 = await deriveCourseFeedId('  K7M2QX  ');
      const id3 = await deriveCourseFeedId('K7-M2-QX');

      expect(id1).toHaveLength(24);
      expect(/^[0-9a-f]{24}$/.test(id1)).toBe(true);
      expect(id1).toBe(id2);
      expect(id1).toBe(id3);
    });

    it('falls back gracefully when code is empty', async () => {
      const fallback = await deriveCourseFeedId('');
      expect(fallback).toBe('feed-unknown');
    });
  });

  describe('2. Strict Offline / No-Relay Gating', () => {
    it('isTeacherRelayConfigured returns false for NullTransport or partial credentials', () => {
      expect(isTeacherRelayConfigured(new NullTransport())).toBe(false);
      expect(isTeacherRelayConfigured(new RelayTransport({ baseUrl: 'http://localhost:3000' }))).toBe(false);
      expect(isTeacherRelayConfigured(new RelayTransport({ token: 'xyz' }))).toBe(false);
      expect(isTeacherRelayConfigured(new RelayTransport({ baseUrl: 'http://localhost:3000', token: 'xyz' }))).toBe(true);
    });

    it('getStudentRelayUrl returns null when no relay configured and extracts correctly from course', () => {
      expect(getStudentRelayUrl(null)).toBeNull();
      expect(getStudentRelayUrl({})).toBeNull();
      expect(getStudentRelayUrl({ relay_url: 'https://relay.myschool.edu/' })).toBe('https://relay.myschool.edu');
      expect(getStudentRelayUrl({ relay: { base_url: 'https://relay.myschool.edu' } })).toBe('https://relay.myschool.edu');
    });

    it('isCdnUploadConfigured returns false when transport has no CDN media feature', async () => {
      const transport = new RelayTransport({ baseUrl: 'http://127.0.0.1:9999', token: 'test' });
      const configured = await isCdnUploadConfigured(transport);
      expect(configured).toBe(false);
    });
  });

  describe('3. Course Feed Sync & Student Experience', () => {
    it('mergeCourseFeed preserves student card.fsrs state when updating flashcards', async () => {
      const courseId = 'course-abc';
      const deckId = 'deck-xyz';

      // Initial feed with card 1
      const initialFeed = {
        v: 1,
        course: { id: courseId, name: 'Physics 101', access_code: 'PHYS10' },
        units: [],
        items: [{
          id: 'item-1',
          kind: 'flashcards',
          source_id: deckId,
          title: 'Physics Deck',
          payload: {
            id: deckId,
            title: 'Physics Deck',
            cards: [
              { id: 'c1', front: 'Velocity', back: 'Speed with direction', fsrs: null },
              { id: 'c2', front: 'Mass', back: 'Amount of matter', fsrs: null }
            ]
          }
        }]
      };

      await mergeCourseFeed(initialFeed, { accessCode: 'PHYS10' });

      // Student studies and earns FSRS retention on card c1
      const fcTable = storage.table('flashcards');
      const studentDeck = await fcTable.get(deckId);
      studentDeck.cards[0].fsrs = { reps: 5, difficulty: 4.2, stability: 12.5, state: 2 };
      await fcTable.put(studentDeck);

      // Teacher fixes a typo in card c1 and adds card c3, then re-publishes
      const updatedFeed = {
        v: 1,
        course: { id: courseId, name: 'Physics 101', access_code: 'PHYS10', relay_url: 'https://relay.test.edu' },
        units: [],
        items: [{
          id: 'item-1',
          kind: 'flashcards',
          source_id: deckId,
          title: 'Physics Deck (Updated)',
          payload: {
            id: deckId,
            title: 'Physics Deck (Updated)',
            cards: [
              { id: 'c1', front: 'Velocity (Updated)', back: 'Speed with direction (vector)', fsrs: null },
              { id: 'c2', front: 'Mass', back: 'Amount of matter', fsrs: null },
              { id: 'c3', front: 'Force', back: 'Mass times acceleration', fsrs: null }
            ]
          }
        }],
        revision: 'rev-2'
      };

      await mergeCourseFeed(updatedFeed, { accessCode: 'PHYS10', etag: 'rev-2' });

      // Verify merged student deck: c1 has new front/back text BUT preserves student FSRS!
      const finalDeck = await fcTable.get(deckId);
      expect(finalDeck.title).toBe('Physics Deck (Updated)');
      expect(finalDeck.cards).toHaveLength(3);
      expect(finalDeck.cards[0].front).toBe('Velocity (Updated)');
      expect(finalDeck.cards[0].fsrs).toEqual({ reps: 5, difficulty: 4.2, stability: 12.5, state: 2 });
      expect(finalDeck.cards[2].front).toBe('Force');

      // Verify course record has etag and relay_url persisted
      const courseRecord = await getStudentCourse(courseId);
      expect(courseRecord.course.etag).toBe('rev-2');
      expect(courseRecord.course.relay_url).toBe('https://relay.test.edu');
    });

    it('mergeCourseFeed deletes stale student_items removed by teacher', async () => {
      const courseId = 'course-del';

      // Feed with 2 items
      await mergeCourseFeed({
        v: 1,
        course: { id: courseId, name: 'History' },
        items: [
          { id: 'item-1', title: 'Lesson 1' },
          { id: 'item-2', title: 'Lesson 2' }
        ]
      });

      let items = await storage.table('student_items').where('course_id').equals(courseId).toArray();
      expect(items).toHaveLength(2);

      // Teacher deletes Lesson 2
      await mergeCourseFeed({
        v: 1,
        course: { id: courseId, name: 'History' },
        items: [
          { id: 'item-1', title: 'Lesson 1 (Revised)' }
        ]
      });

      items = await storage.table('student_items').where('course_id').equals(courseId).toArray();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('item-1');
      expect(items[0].title).toBe('Lesson 1 (Revised)');
    });
  });

  describe('4. Cross-Device Draft Version Reconciliation', () => {
    it('reconcileDraftAnswers preserves student answers when assignment version increments', () => {
      const newPayload = {
        publish_version: 2,
        questions: [
          { id: 'q1', type: 'single_choice', options: [{ id: 'o1' }, { id: 'o2' }] },
          { id: 'q2', type: 'text' },
          { id: 'q3', type: 'ordering', items: [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }] }
        ]
      };

      const priorAnswers = {
        q1: 'o2',
        q2: 'My answer',
        q3: ['i2', 'i1'], // missing i3 from newer version
        qDeleted: 'old' // deleted question
      };

      const reconciled = reconcileDraftAnswers(newPayload, priorAnswers);
      const answers = reconciled.newAnswers || reconciled.answers;
      expect(answers.q1).toBe('o2');
      expect(answers.q2).toBe('My answer');
      expect(answers.q3).toEqual(['i2', 'i1', 'i3']); // merged missing item!
      expect(answers.qDeleted).toBeUndefined();
    });
  });

  describe('5. CDN Media Offloading Pipeline', () => {
    beforeEach(async () => {
      // Start real relay server with CDN enabled
      relayInstance = createRelayServer({
        dbPath: ':memory:',
        cdn: true
      });
      relayInstance.db.teachers.create({
        id: teacherId,
        name: 'Teacher Test',
        tokenHash: hashToken(teacherToken)
      });
      await new Promise(resolve => relayInstance.server.listen(0, '127.0.0.1', resolve));
      const port = relayInstance.server.address().port;
      relayUrl = `http://127.0.0.1:${port}`;
      await setTransportConfig({ baseUrl: relayUrl, token: teacherToken, teacherId });
    });

    it('advertises media feature on /health when CDN is enabled', async () => {
      const transport = new RelayTransport({ baseUrl: relayUrl, token: teacherToken });
      const h = await transport.health();
      expect(h.ok).toBe(true);
      expect(h.features).toContain('media');

      const isCdn = await isCdnUploadConfigured(transport);
      expect(isCdn).toBe(true);
    });

    it('rejects unauthenticated media presign with 401', async () => {
      const res = await fetch(`${relayUrl}/api/v1/media/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha256: 'a'.repeat(64), mime: 'image/webp' })
      });
      expect(res.status).toBe(401);
    });

    it('accepts authenticated presign and allows upload and static retrieval', async () => {
      const transport = new RelayTransport({ baseUrl: relayUrl, token: teacherToken });
      const testBytes = new Uint8Array([1, 2, 3, 4]);
      const hash = crypto.createHash('sha256').update(testBytes).digest('hex');
      const presigned = await transport.presignMediaUpload({
        sha256: hash,
        mime: 'image/webp',
        ext: 'webp',
        size: testBytes.byteLength
      });

      expect(presigned.upload_url).toBeTruthy();
      expect(presigned.public_url).toBeTruthy();

      // Perform upload
      const uploadRes = await fetch(presigned.upload_url, {
        method: presigned.method || 'PUT',
        headers: { 'Content-Type': 'image/webp' },
        body: testBytes
      });
      expect(uploadRes.status).toBe(200);

      // Fetch uploaded media via public URL
      const fetchRes = await fetch(presigned.public_url);
      expect(fetchRes.status).toBe(200);
      expect(fetchRes.headers.get('content-type')).toBe('image/webp');
      const fetchedBuffer = new Uint8Array(await fetchRes.arrayBuffer());
      expect(fetchedBuffer).toEqual(testBytes);
    });

    it('resolveMediaSrc handles https:// and encrypted kb-cdn+aes:// in memory without student disk storage', async () => {
      // 1. Direct https URL
      const httpsUrl = 'https://cdn.school.edu/assets/photo.webp';
      const resolvedHttps = await resolveMediaSrc(httpsUrl, 'image');
      expect(resolvedHttps).toBe(httpsUrl);

      // 2. Encrypted CDN asset
      const sampleBlob = new Blob(['sample-image-bytes'], { type: 'image/webp' });
      const cdnUri = await uploadMediaToCdn(sampleBlob, { mime: 'image/webp', ext: 'webp', encrypt: true });
      expect(cdnUri).toContain('kb-cdn+aes://');

      // Resolve it on student device
      const resolvedObjectUrl = await resolveMediaSrc(cdnUri, 'image');
      expect(resolvedObjectUrl.startsWith('blob:')).toBe(true);
      expect(storage.objectUrls.has(resolvedObjectUrl)).toBe(true);

      // Verify the decrypted content
      const blobRes = await fetch(resolvedObjectUrl);
      const text = await blobRes.text();
      expect(text).toBe('sample-image-bytes');

      // Revocation
      storage.revokeAllObjectURLs();
      expect(storage.objectUrls.size).toBe(0);
    });

    it('inlineDeckMedia offloads card images to CDN when cdn: true', async () => {
      // Save a local media blob in teacher storage
      const localUri = await storage.saveBinaryAsset('media-123', new Blob(['front-img'], { type: 'image/webp' }));

      const deck = {
        id: 'deck-1',
        title: 'Biology',
        cards: [
          {
            id: 'c1',
            front: { text: 'Cell', imageRef: localUri },
            back: { text: 'Basic unit of life' }
          }
        ]
      };

      const offloaded = await inlineDeckMedia(deck, { cdn: true });
      expect(offloaded.cards[0].front.imageRef).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(offloaded.cards[0].front.imageRef).not.toContain('data:image');
    });
  });
});
