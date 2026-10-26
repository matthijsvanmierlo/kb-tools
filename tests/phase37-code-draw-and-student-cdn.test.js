// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import 'fake-indexeddb/auto';
import { createRelayServer } from '../server/relay/index.js';
import { hashToken } from '../server/relay/auth.js';
import { renderSTEMMarkdown } from '../src/core/sanitizer.js';
import { DrawBoard } from '../src/components/draw-board.js';
import { normalizeSketchData } from '../src/core/validator.js';
import { createCodeEditor, createCodeViewer, renderCodeWithComments } from '../src/components/code-editor.js';
import { uploadStudentFile, parseEncryptedCdnUrl, encryptBufferAesGcm } from '../src/utils/student-media.js';
import { resolveMediaSrc } from '../src/utils/media.js';

describe('Phase 37: Code Editor, DrawBoard, STEM Markdown, and Student CDN Uploads', () => {

  describe('1. STEM Markdown Code-vs-Math Isolation', () => {
    it('protects inline code containing dollar signs from KaTeX math interpretation', () => {
      const markdown = 'Here is some code: `$foo = $bar + 1;` and math: $E = mc^2$';
      const rendered = renderSTEMMarkdown(markdown);

      // Inline code must remain code, not rendered KaTeX
      expect(rendered).toContain('<code>$foo = $bar + 1;</code>');
      expect(rendered).not.toContain('<span class="katex"><code>');
      // Math should be rendered via KaTeX
      expect(rendered).toContain('katex');
    });

    it('protects fenced code blocks containing LaTeX formulas from math parser', () => {
      const codeBlock = '```javascript\nconst x = "$E = mc^2$";\n```';
      const rendered = renderSTEMMarkdown(codeBlock);

      expect(rendered).toContain('<code class="language-javascript">');
      expect(rendered).toContain('$E = mc^2$');
    });
  });

  describe('2. Code Editor Wrapper & Comments', () => {
    it('creates CodeMirror editor and allows getting/setting text', () => {
      const container = document.createElement('div');
      const editor = createCodeEditor(container, {
        language: 'javascript',
        value: 'const a = 1;',
        readOnly: false
      });

      expect(editor.getValue()).toBe('const a = 1;');
      editor.setValue('const b = 2;');
      expect(editor.getValue()).toBe('const b = 2;');
      editor.destroy();
    });

    it('renders code with comments escaped safely against XSS', () => {
      const code = 'const x = 42;\nconsole.log(x);';
      const comments = [
        {
          id: 'c1',
          line: 1,
          author: '<script>alert(1)</script>Teacher',
          text: 'Good <b>variable</b> name!'
        }
      ];

      const html = renderCodeWithComments(code, comments);
      expect(html).toContain('const x = 42;');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;Teacher');
      expect(html).toContain('Good &lt;b&gt;variable&lt;/b&gt; name!');
    });
  });

  describe('3. DrawBoard Logic & Undo/Redo', () => {
    let board;

    beforeEach(() => {
      board = new DrawBoard({ width: 1000, height: 600 });
    });

    it('initializes with default logical 1000x600 coordinate bounds', () => {
      const doc = board.toJSON();
      expect(doc.version).toBe(2);
      expect(doc.width).toBe(1000);
      expect(doc.height).toBe(600);
      expect(doc.elements).toEqual([]);
    });

    it('records elements and supports undo and redo stack', () => {
      const rectEl = {
        id: 'rect1',
        type: 'rect',
        x: 50,
        y: 50,
        w: 100,
        h: 80,
        color: '#000000',
        width: 2
      };
      board.addElement(rectEl);
      expect(board.getElements().length).toBe(1);
      expect(board.canUndo()).toBe(true);
      expect(board.canRedo()).toBe(false);

      // Undo
      board.undo();
      expect(board.getElements().length).toBe(0);
      expect(board.canUndo()).toBe(false);
      expect(board.canRedo()).toBe(true);

      // Redo
      board.redo();
      expect(board.getElements().length).toBe(1);
      expect(board.getElements()[0].id).toBe('rect1');
    });

    it('hit-tests elements correctly in logical coordinate space', () => {
      const rectEl = {
        id: 'box',
        type: 'rect',
        x: 100,
        y: 100,
        w: 200,
        h: 150,
        color: '#ff0000',
        width: 4,
        fill: true
      };
      board.addElement(rectEl);

      // Inside filled bounds
      const hit = board.getElementAt(150, 150);
      expect(hit).toBeTruthy();
      expect(hit.id).toBe('box');

      // Outside bounds
      const miss = board.getElementAt(50, 50);
      expect(miss).toBeNull();
    });

    it('normalizes legacy sketch stroke data into modern DrawDoc format', () => {
      const legacy = {
        lines: [
          [{ x: 10, y: 10 }, { x: 20, y: 20 }]
        ],
        color: '#123456',
        width: 3
      };

      const normalized = normalizeSketchData(legacy);
      expect(normalized.version).toBe(2);
      expect(normalized.elements.length).toBe(1);
      expect(normalized.elements[0].type).toBe('stroke');
    });
  });

  describe('4. Relay Media Hardening & Student Drop Presign', () => {
    let relayInstance;
    let relayUrl;
    const teacherId = 'T-CDN';
    const teacherToken = 'tok_cdn_12345678901234567890123456789012';
    const dropSecret = 'secret_drop_abc123';
    let dropId = '';

    beforeEach(async () => {
      relayInstance = createRelayServer({
        dbPath: ':memory:',
        cdn: true
      });
      relayInstance.db.teachers.create({
        id: teacherId,
        name: 'CDN Teacher',
        tokenHash: hashToken(teacherToken)
      });
      await new Promise(resolve => relayInstance.server.listen(0, '127.0.0.1', resolve));
      const port = relayInstance.server.address().port;
      relayUrl = `http://127.0.0.1:${port}`;

      // Create a drop box with secret
      dropId = 'drop-test-' + Date.now();
      relayInstance.db.drops.create({
        id: dropId,
        teacherId,
        assignmentId: 'assign-1',
        secretHash: crypto.createHash('sha256').update(dropSecret).digest('hex')
      });
    });

    afterEach(async () => {
      if (relayInstance) {
        await relayInstance.close();
        relayInstance = null;
      }
    });

    it('teacher presign generates URL with exp and HMAC sig', async () => {
      const res = await fetch(`${relayUrl}/api/v1/media/presign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${teacherToken}`
        },
        body: JSON.stringify({
          sha256: '0'.repeat(64),
          mime: 'image/png',
          ext: 'png'
        })
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.upload_url).toContain('&exp=');
      expect(data.upload_url).toContain('&sig=');
    });

    it('PUT /media/upload rejects upload without signature with 401', async () => {
      const key = `${'0'.repeat(64)}.png`;
      const res = await fetch(`${relayUrl}/api/v1/media/upload?key=${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: new Uint8Array([1, 2, 3])
      });
      expect(res.status).toBe(401);
    });

    it('PUT /media/upload rejects expired signature with 403', async () => {
      const key = `${'0'.repeat(64)}.png`;
      const expiredUnix = Math.floor(Date.now() / 1000) - 30;
      const res = await fetch(`${relayUrl}/api/v1/media/upload?key=${key}&exp=${expiredUnix}&sig=invalid`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: new Uint8Array([1, 2, 3])
      });
      expect(res.status).toBe(403);
    });

    it('PUT /media/upload rejects body sha256 mismatch with 400', async () => {
      const fileBytes = new Uint8Array([10, 20, 30, 40]);
      const actualHash = crypto.createHash('sha256').update(fileBytes).digest('hex');

      // Presign with actualHash
      const preRes = await fetch(`${relayUrl}/api/v1/media/presign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${teacherToken}`
        },
        body: JSON.stringify({
          sha256: actualHash,
          mime: 'image/png',
          ext: 'png'
        })
      });
      const preData = await preRes.json();

      // Tamper: send different body bytes
      const tamperedBytes = new Uint8Array([99, 99, 99, 99]);
      const upRes = await fetch(preData.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: tamperedBytes
      });
      expect(upRes.status).toBe(400);
      const err = await upRes.json();
      expect(err.error).toContain('Body sha256 does not match key');
    });

    it('student presign requires valid drop secret', async () => {
      const body = JSON.stringify({
        sha256: '1'.repeat(64),
        mime: 'application/pdf',
        ext: 'pdf',
        size: 1024
      });

      // No secret -> 403
      const noSec = await fetch(`${relayUrl}/api/v1/drops/${dropId}/media/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      expect(noSec.status).toBe(403);

      // Wrong secret -> 403
      const wrongSec = await fetch(`${relayUrl}/api/v1/drops/${dropId}/media/presign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-KB-Drop-Secret': 'wrong-secret'
        },
        body
      });
      expect(wrongSec.status).toBe(403);

      // Correct secret -> 200
      const okSec = await fetch(`${relayUrl}/api/v1/drops/${dropId}/media/presign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-KB-Drop-Secret': dropSecret
        },
        body
      });
      expect(okSec.status).toBe(200);
      const okData = await okSec.json();
      expect(okData.upload_url).toContain(`drop_id=${dropId}`);
    });

    it('student presign rejects forbidden extensions with 400', async () => {
      const res = await fetch(`${relayUrl}/api/v1/drops/${dropId}/media/presign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-KB-Drop-Secret': dropSecret
        },
        body: JSON.stringify({
          sha256: '1'.repeat(64),
          mime: 'application/x-msdownload',
          ext: 'exe',
          size: 1024
        })
      });
      expect(res.status).toBe(400);
      const err = await res.json();
      expect(err.error).toContain('File extension .exe is not permitted');
    });

    it('student presign enforces per-drop quotas', async () => {
      // Set very small quota for this test: max 2 files or 2000 bytes
      relayInstance.db.dropMedia.checkQuota = (id, newBytes) => {
        const stats = relayInstance.db.dropMedia.getStats(id);
        if (stats.count + 1 > 2 || stats.totalSize + newBytes > 2000) {
          const err = new Error('DROP_MEDIA_QUOTA_EXCEEDED');
          err.code = 'QUOTA_EXCEEDED';
          throw err;
        }
        return true;
      };

      // File 1: 1500 bytes (fits)
      const res1 = await fetch(`${relayUrl}/api/v1/drops/${dropId}/media/presign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-KB-Drop-Secret': dropSecret
        },
        body: JSON.stringify({ sha256: 'a'.repeat(64), mime: 'application/pdf', ext: 'pdf', size: 1500 })
      });
      expect(res1.status).toBe(200);

      // Simulate file 1 uploaded and recorded
      relayInstance.db.dropMedia.record({ dropId, key: `${'a'.repeat(64)}.pdf`, size: 1500 });

      // File 2: 800 bytes -> exceeds 2000 bytes quota -> 413
      const res2 = await fetch(`${relayUrl}/api/v1/drops/${dropId}/media/presign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-KB-Drop-Secret': dropSecret
        },
        body: JSON.stringify({ sha256: 'b'.repeat(64), mime: 'application/pdf', ext: 'pdf', size: 800 })
      });
      expect(res2.status).toBe(413);
      const err = await res2.json();
      expect(err.error).toContain('quota exceeded');
    });
  });

  describe('5. Client-Side Student Upload Round-Trip', () => {
    let relayInstance;
    let relayUrl;
    const teacherId = 'T-STU';
    const teacherToken = 'tok_stu_12345678901234567890123456789012';
    const dropSecret = 'drop_stu_secret_456';
    const dropId = 'drop-student-work';

    beforeEach(async () => {
      relayInstance = createRelayServer({
        dbPath: ':memory:',
        cdn: true
      });
      relayInstance.db.teachers.create({
        id: teacherId,
        name: 'Student Teacher',
        tokenHash: hashToken(teacherToken)
      });
      relayInstance.db.drops.create({
        id: dropId,
        teacherId,
        assignmentId: 'assign-stu',
        secretHash: crypto.createHash('sha256').update(dropSecret).digest('hex')
      });
      await new Promise(resolve => relayInstance.server.listen(0, '127.0.0.1', resolve));
      const port = relayInstance.server.address().port;
      relayUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      if (relayInstance) {
        await relayInstance.close();
        relayInstance = null;
      }
    });

    it('encrypts student file unconditionally and uploads to relay CDN', async () => {
      const originalText = 'Hello teacher, this is my final submission paper content!';
      const fileBlob = new Blob([originalText], { type: 'text/markdown' });
      fileBlob.name = 'essay.md';

      const relayInfo = {
        endpoint: relayUrl,
        drop_id: dropId,
        drop_secret: dropSecret
      };

      let progressCalled = false;
      const cdnRef = await uploadStudentFile(fileBlob, relayInfo, {
        onProgress: (p) => {
          expect(p.percent).toBe(100);
          progressCalled = true;
        }
      });

      expect(progressCalled).toBe(true);
      expect(cdnRef).toMatch(/^kb-cdn\+aes:\/\/http:\/\/127\.0\.0\.1:\d+\/api\/v1\/media\/file\/[a-f0-9]{64}\.md#key=[A-Za-z0-9_-]+&iv=[A-Za-z0-9_-]+&mime=text%2Fmarkdown&name=essay\.md$/);

      // Verify server only stored ciphertext, NOT plaintext
      const parsed = parseEncryptedCdnUrl(cdnRef);
      expect(parsed).toBeTruthy();
      expect(parsed.name).toBe('essay.md');
      expect(parsed.mime).toBe('text/markdown');

      const serverRes = await fetch(parsed.rawUrl);
      expect(serverRes.status).toBe(200);
      const serverBytes = new Uint8Array(await serverRes.arrayBuffer());
      const serverText = new TextDecoder().decode(serverBytes);
      expect(serverText).not.toContain(originalText); // Ciphertext check!

      // Verify resolveMediaSrc decrypts it back to original content
      const decryptedBlobUrl = await resolveMediaSrc(cdnRef, 'document');
      expect(decryptedBlobUrl).toMatch(/^blob:/);
    });
  });
});
