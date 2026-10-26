// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  compressDrawDoc,
  decompressDrawDoc,
  rasterizeDrawDocToCanvas,
  rasterizeDrawDocToBlob,
  rasterizeDrawDocToDataUrl,
  prepareDrawingForSubmission,
  processUploadedCodeFile,
  detectCodeLanguage,
  DRAWING_MAX_INLINE_BYTES,
  CODE_MAX_INLINE_BYTES
} from '../src/modules/tasks/media.js';
import { createTaskSubmission, evaluateTaskSubmission } from '../src/modules/tasks/pipeline.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';

describe('Phase 41: Tasks Media, Drawing Compression & Stroke-Budget Tiering', () => {
  let teacherKeys;

  beforeEach(async () => {
    teacherKeys = await SubmissionCrypto.generateKeyPair();
  });

  describe('1. Vector Drawing LZ-String Compression', () => {
    it('compresses and decompresses DrawDoc losslessly', () => {
      const doc = {
        version: 2,
        width: 1000,
        height: 600,
        elements: [
          { id: 'el-1', type: 'stroke', color: '#ff0000', size: 4, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] },
          { id: 'el-2', type: 'rect', color: '#00ff00', size: 2, x: 100, y: 100, width: 200, height: 150, fill: true }
        ]
      };

      const compressed = compressDrawDoc(doc);
      expect(typeof compressed).toBe('string');
      expect(compressed.length).toBeGreaterThan(0);

      const decompressed = decompressDrawDoc(compressed);
      expect(decompressed).toEqual(doc);
    });

    it('returns null when compressing null or invalid doc', () => {
      expect(compressDrawDoc(null)).toBeNull();
      expect(decompressDrawDoc('')).toBeNull();
      expect(decompressDrawDoc(null)).toBeNull();
    });
  });

  describe('2. Stroke-Budget Tiering', () => {
    it('Tier 1: small drawing under 96KB stays inline with compressed field', async () => {
      const doc = {
        version: 2,
        width: 1000,
        height: 600,
        elements: [
          { id: 'el-1', type: 'stroke', color: '#000', size: 2, points: [{ x: 0, y: 0 }, { x: 50, y: 50 }] }
        ]
      };

      const result = await prepareDrawingForSubmission(doc, {
        endpoint: 'http://relay.example.com',
        drop_id: 'drop-123'
      });

      expect(result).toBeTruthy();
      expect(result.elements).toHaveLength(1);
      expect(typeof result.compressed).toBe('string');
      expect(result.png_ref).toBeUndefined();
      expect(result.png_data).toBeUndefined();
    });

    it('Tier 2: drawing exceeding budget rasterizes to PNG and uploads to CDN', async () => {
      // Create a massive drawing with many strokes
      const elements = [];
      for (let i = 0; i < 3000; i++) {
        elements.push({
          id: `stroke-${i}`,
          type: 'stroke',
          color: '#2563eb',
          size: 3,
          points: [
            { x: i % 1000, y: (i * 2) % 600 },
            { x: (i + 10) % 1000, y: (i * 3) % 600 },
            { x: (i + 20) % 1000, y: (i * 4) % 600 },
            { x: (i + 30) % 1000, y: (i * 5) % 600 }
          ]
        });
      }

      const hugeDoc = { version: 2, width: 1000, height: 600, elements };

      // Mock fetch for presign and upload
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (String(url).includes('/media/presign')) {
          return new Response(JSON.stringify({
            upload_url: 'http://cdn.example.com/upload/drawing.png',
            public_url: 'cdn.example.com/media/drawing.png',
            method: 'PUT'
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (String(url).includes('cdn.example.com/upload')) {
          return new Response('', { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const result = await prepareDrawingForSubmission(
        hugeDoc,
        { endpoint: 'http://relay.example.com', drop_id: 'drop-123', drop_secret: 'sec' },
        { maxInlineBytes: 100 } // Force low threshold for testing
      );

      expect(result).toBeTruthy();
      expect(result.elements).toBeUndefined();
      expect(result.png_ref).toContain('kb-cdn+aes://cdn.example.com/media/drawing.png');
      expect(result.png_ref).toContain('#key=');
      expect(result.png_ref).toContain('&iv=');

      fetchSpy.mockRestore();
    });

    it('Tier 3: drawing exceeding budget without CDN downscales and embeds data: URL', async () => {
      const doc = {
        version: 2,
        width: 1000,
        height: 600,
        elements: [{ id: 'el-1', type: 'rect', x: 0, y: 0, width: 100, height: 100 }]
      };

      const result = await prepareDrawingForSubmission(
        doc,
        {}, // No relay info
        { maxInlineBytes: 10 } // Force tier 3
      );

      expect(result).toBeTruthy();
      expect(result.elements).toBeUndefined();
      expect(result.png_ref).toBeUndefined();
      expect(result.png_data).toMatch(/^data:image\/png;base64,/);
    });
  });

  describe('3. Code-File Upload Size Budget Tiering', () => {
    it('detects language correctly from common extensions', () => {
      expect(detectCodeLanguage('script.py')).toBe('python');
      expect(detectCodeLanguage('app.js')).toBe('javascript');
      expect(detectCodeLanguage('index.html')).toBe('html');
      expect(detectCodeLanguage('styles.css')).toBe('css');
      expect(detectCodeLanguage('Main.java')).toBe('java');
      expect(detectCodeLanguage('algo.cpp')).toBe('cpp');
      expect(detectCodeLanguage('query.sql')).toBe('sql');
    });

    it('inlines code file text when file is <= 64KB', async () => {
      const content = 'def solve(): return 42\n';
      const file = new File([content], 'solution.py', { type: 'text/x-python' });

      const result = await processUploadedCodeFile(file);
      expect(result.type).toBe('code');
      expect(result.file.filename).toBe('solution.py');
      expect(result.file.language).toBe('python');
      expect(result.file.body).toBe(content);
      expect(result.file.origin).toBe('upload');
    });

    it('treats code file > 64KB as generic file attachment and uploads to CDN', async () => {
      // 70 KB string
      const bigCode = 'console.log("x");\n'.repeat(3800);
      const file = new File([bigCode], 'bundle.js', { type: 'text/javascript' });
      expect(file.size).toBeGreaterThan(CODE_MAX_INLINE_BYTES);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/media/presign')) {
          return new Response(JSON.stringify({
            upload_url: 'http://cdn.example.com/upload/bundle.js',
            public_url: 'cdn.example.com/media/bundle.js',
            method: 'PUT'
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('', { status: 200 });
      });

      const result = await processUploadedCodeFile(file, {
        endpoint: 'http://relay.example.com',
        drop_id: 'drop-bundle',
        drop_secret: 'sec'
      });

      expect(result.type).toBe('attachment');
      expect(result.attachment.name).toBe('bundle.js');
      expect(result.attachment.ref).toContain('kb-cdn+aes://');

      fetchSpy.mockRestore();
    });
  });

  describe('4. Envelope Size & Ref Integrity', () => {
    it('submission envelope carries CDN refs rather than raw multi-megabyte bytes', async () => {
      const taskPayload = {
        task_id: 'task-media-1',
        publish_version: 1,
        title: 'Project Submission',
        teacher_key: { publicJwk: teacherKeys.publicJwk, fingerprint: teacherKeys.fingerprint }
      };

      const cdnRef = 'kb-cdn+aes://cdn.example.com/media/file.pdf#key=aaa&iv=bbb&mime=application%2Fpdf&name=report.pdf';
      const content = {
        text: 'Here is my report and drawing.',
        code_files: [{ filename: 'main.py', body: 'print(1)' }],
        drawing: {
          version: 2,
          width: 1000,
          height: 600,
          png_ref: 'kb-cdn+aes://cdn.example.com/media/diagram.png#key=ccc&iv=ddd'
        },
        attachments: [
          { id: 'att-1', name: 'report.pdf', size: 1048576, mime: 'application/pdf', ref: cdnRef }
        ]
      };

      const { envelope, envelopeText } = await createTaskSubmission(
        taskPayload,
        { id: 'STU10', name: 'Alice' },
        content
      );

      // Envelope text should be very small (under 4KB), not megabytes!
      expect(envelopeText.length).toBeLessThan(4096);
      expect(envelope.header.task_id).toBe('task-media-1');

      // Teacher decodes and recovers exact refs
      const taskRecord = { id: 'task-media-1', settings: {} };
      const sub = await evaluateTaskSubmission({
        text: envelopeText,
        teacherPrivateKey: teacherKeys.privateJwk,
        task: taskRecord
      });

      expect(sub.student_id).toBe('STU10');
      expect(sub.content.attachments[0].ref).toBe(cdnRef);
      expect(sub.content.drawing.png_ref).toContain('kb-cdn+aes://');
    });

    it('.kbsub data:-embed round trip preserves offline rasterized drawing', async () => {
      const taskPayload = {
        task_id: 'task-offline-1',
        publish_version: 1,
        title: 'Offline Art Class',
        teacher_key: { publicJwk: teacherKeys.publicJwk, fingerprint: teacherKeys.fingerprint }
      };

      const offlineDrawing = {
        version: 2,
        width: 1000,
        height: 600,
        png_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      };

      const { envelopeText } = await createTaskSubmission(
        taskPayload,
        { id: 'STU99', name: 'Offline Bob' },
        { text: 'Offline response', drawing: offlineDrawing }
      );

      const taskRecord = { id: 'task-offline-1', settings: {} };
      const sub = await evaluateTaskSubmission({
        text: envelopeText,
        teacherPrivateKey: teacherKeys.privateJwk,
        task: taskRecord
      });

      expect(sub.content.drawing.png_data).toBe(offlineDrawing.png_data);
    });
  });
});
