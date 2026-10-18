import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractShareHash, classifyIncomingFile } from '../src/core/pwa.js';
import { loadServiceWorker } from './helpers/load-sw.js';

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

describe('Phase 23: PWA manifest (rev-3 §5)', () => {
  it('has real icon files, including maskable PNGs', () => {
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('data:')).toBe(false);
      expect(fs.existsSync(path.join(root, icon.src)), icon.src).toBe(true);
    }
    expect(manifest.icons.some(i => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    expect(manifest.icons.some(i => i.sizes === '192x192' && i.type === 'image/png')).toBe(true);
  });

  it('registers OS file handlers for lessons and student submissions', () => {
    const exts = manifest.file_handlers.flatMap(h => Object.values(h.accept).flat());
    expect(exts).toEqual(expect.arrayContaining(['.kbshare', '.kbsub', '.kbr']));
    for (const h of manifest.file_handlers) {
      expect(h.action.startsWith('./')).toBe(true);
      for (const icon of h.icons) expect(fs.existsSync(path.join(root, icon.src))).toBe(true);
    }
    expect(manifest.launch_handler.client_mode).toContain('focus-existing');
  });

  it('receives shares by POST so shared data never appears in a server request URL', () => {
    expect(manifest.share_target).toMatchObject({ action: './share-target', method: 'POST', enctype: 'multipart/form-data' });
    expect(manifest.share_target.params.files[0].accept).toEqual(expect.arrayContaining(['.kbshare', '.kbsub']));
  });
});

describe('Phase 23: Service worker', () => {
  it('parses as a classic worker and routes share-target POSTs to itself', () => {
    const { isShareTargetRequest, CACHE_NAME, listeners } = loadServiceWorker();
    expect(CACHE_NAME).toMatch(/^kennisboost-[0-9a-f]{12}$/);
    expect(Object.keys(listeners)).toEqual(expect.arrayContaining(['install', 'activate', 'fetch', 'message']));
    expect(isShareTargetRequest({ method: 'POST', url: 'http://localhost:8000/share-target' })).toBe(true);
    expect(isShareTargetRequest({ method: 'GET', url: 'http://localhost:8000/share-target' })).toBe(false);
    expect(isShareTargetRequest({ method: 'POST', url: 'http://localhost:8000/api/drops' })).toBe(false);
  });

  it('waits for the user before activating an update', () => {
    const src = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
    const install = src.slice(src.indexOf("addEventListener('install'"), src.indexOf("addEventListener('message'"));
    expect(install).not.toContain('self.skipWaiting()');
    expect(src).toContain("event.data === 'SKIP_WAITING'");
  });
});

describe('Phase 23: Launch & share intake', () => {
  it('routes hand-in files to the inbox and everything else to the lesson importer', () => {
    expect(classifyIncomingFile('Emma.kbsub')).toBe('inbox');
    expect(classifyIncomingFile('receipt.KBR')).toBe('inbox');
    expect(classifyIncomingFile('class.zip')).toBe('inbox');
    expect(classifyIncomingFile('lesson.kbshare')).toBe('share');
  });

  it('only follows share links that point at this installation', () => {
    const origin = 'https://kb.school.edu';
    expect(extractShareHash('Open this: https://kb.school.edu/#/share?v=2&enc=0&d=abc', origin)).toBe('#/share?v=2&enc=0&d=abc');
    expect(extractShareHash('#/share?enc=1&d=xyz', origin)).toBe('#/share?enc=1&d=xyz');
    expect(extractShareHash('https://evil.example/#/share?enc=0&d=abc', origin)).toBeNull();
    expect(extractShareHash('no link here', origin)).toBeNull();
  });
});
